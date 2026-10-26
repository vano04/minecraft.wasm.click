// Host MC-Web's canonical WebGPU host (web/webgpu-host.js) on a dedicated
// Worker whose event loop stays live, and serve it to the JVM's pthread
// Worker over a synchronous request/response RPC.
//
// Why a separate Worker: an OffscreenCanvas can only be transferred once, and
// the thread that drives WebGPU frames on it must keep turning its event loop
// for the browser to commit frames. The JVM pthread parks in Atomics.wait
// (Thread.sleep, proxied calls) and can never do that. A parked worker never
// presents a frame. A worker that spins or yields does. So the host lives here,
// and the pthread Worker proxies every mcWebGpu call over a MessagePort,
// blocking in Atomics.wait for the answer (the same mechanism Emscripten uses
// for proxied main-thread calls).
//
// Why batches: Chromium invalidates an unpresented current swap-chain texture
// when the event loop turns, so acquire -> render -> submit must run in ONE
// task. The client therefore buffers the calls of a frame (from the first
// encoder/texture creation up to present) into a single message, executed
// synchronously here. A handle produced inside a batch is answered with a
// negative placeholder before the host has run the call, and the created
// object is then renamed onto that placeholder, so later calls (this frame or
// any later one) can pass it straight back as an ordinary handle.
//
// Wire format: the request and response travel in a SharedArrayBuffer so the
// blocking client never needs its (parked) event loop to see the answer.
//   i32[1]        response flag (1 = response ready; the client waits on it)
//   i32[3]        response JSON length
//   i32[5..7]     client state, send and done counts (for hang reports)
//   i32[8 + slot] slot free (1 = request and payloads copied out)
//   i32[10]       GPU frame credits (2 initially; returned on completion)
//   data          from byte 4096: two request slots, used in turn (pre.js
//                 sendOnce). A slot holds the request JSON at its base and
//                 binary payloads from base + 1 MiB; a response is written
//                 back at its base.
// The client posts {rpc, slot, base, len} on the MessagePort. An async request
// (present()) gets no response. GPU frame credits are separate from request
// slots: only a later present waits for GPU completion, while ordinary RPCs
// can reuse either copied-out slot. Binary arguments (typed arrays) and long
// strings are replaced by {__bin|__str: offset into data, len} markers in the
// request JSON and copied into the slot's payload area. (pre.js still writes
// i32[2] and i32[4], from the single-slot protocol; nothing reads them.)
// Frame-split instrumentation state (?mcweb_framesplit=1). Cheap enough to
// leave compiled in: two adds and a compare per batch when disabled.
let _frameSplit = false;
try {
  _frameSplit = new URLSearchParams(location.search).has("mcweb_framesplit");
} catch (ignored) { /* no location in some hosts */ }
let _splitJava = 0, _splitGpu = 0, _splitBatches = 0, _splitCalls = 0;
const _splitLeaders = new Map();
let _lastBatchEnd = 0, _splitReportedAt = 0;
(() => {
  "use strict";
  if (globalThis.__mcWebGpuRpcWorker) return;
  globalThis.__mcWebGpuRpcWorker = true;

  const log = (t) => {
    try { postMessage({ mcwebLog: String(t) }); } catch {}
    console.log(t);
  };
  globalThis.__mcWebOut = log;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let i32 = null;
  let data = null;
  let port = null;
  let inputMailbox = null;
  let hostReady = false;
  let readyMsg = null;
  const pendingRequests = [];
  let frameBackpressure = null;
  let discarded = false;
  let heartbeatInterval = null;

  // Five fixed, opt-in snapshots; no evaluation, Java RPC, timers or history.
  const resourceCensusEnabled = new URLSearchParams(location.search).get("mcweb_resource_census") === "1";
  const resourceCensusSeen = new Set();
  const censusScalars = value => Object.fromEntries(Object.entries(value || {}).slice(0, 32)
    .filter(([key, field]) => /^[A-Za-z][A-Za-z0-9]{0,47}$/.test(key)
      && (typeof field === "boolean" || typeof field === "number" && Number.isFinite(field))));
  const resourceCensusRequest = id => {
    if (!resourceCensusEnabled || !Number.isInteger(id) || id < 1 || id > 5 || resourceCensusSeen.has(id)) return;
    resourceCensusSeen.add(id);
    const reply = {id, atMs: performance.now(), scope: "Logical host ownership; excludes physical process/native driver memory"};
    try {
      if (!hostReady || !globalThis.mcWebGpu) reply.error = "host-not-ready";
      else {
        reply.resources = censusScalars(globalThis.mcWebGpu.resourceLifetime());
        reply.frames = censusScalars(frameBackpressure?.report());
        reply.rpc = {count: rpcCount};
        reply.yield = censusScalars(rpcYieldStats);
      }
    } catch { reply.error = "census-failed"; }
    try { postMessage({mcwebResourceCensus: reply}); } catch {}
  };
  self.addEventListener("message", (e) => {
    if (e.data && Object.hasOwn(e.data, "mcwebResourceCensusRequest")) { resourceCensusRequest(e.data.mcwebResourceCensusRequest); return; }
    const d = e.data;
    if (d?.mcwebDiscard?.version === 1) {
      if (discarded) return;
      discarded = true;
      clearInterval(heartbeatInterval);
      pendingRequests.length = 0;
      port?.close();
      rpcYieldChannel.port1.close(); rpcYieldChannel.port2.close();
      rpcYieldResume?.(); rpcYieldResume = null;
      try {
        const resources = globalThis.mcWebGpu?.discard() || {initialized: false};
        postMessage({mcwebDiscarded: {version: 1, resources}});
      } catch (error) {
        postMessage({mcwebDiscarded: {version: 1, error: String(error)}});
      } finally { self.close(); }
      return;
    }
    if (discarded) return;
    if (d && d.mcwebRpcPort) {
      port = d.mcwebRpcPort;
      i32 = new Int32Array(d.mcwebRpcSab, 0, 16);
      data = new Uint8Array(d.mcwebRpcSab, 4096);
      if (d.mcwebInputSab) inputMailbox = d.mcwebInputSab;
      // The host may have finished booting before the port arrived (the page
      // sends it with CMD_RUN #2, which is dispatched after the GPU Worker is
      // spawned). Deliver the buffered ready now.
      if (readyMsg) { try { port.postMessage(readyMsg); } catch {} readyMsg = null; }
      port.onmessage = (e) => {
        if (!hostReady) { pendingRequests.push(e.data); return; }
        handle(e.data);
      };
      return;
    }
    if (d && d.mcwebRpcInit) {
      globalThis.__mcWebOffscreen = d.mcwebRpcInit.canvas;
      globalThis.mcWebLocalRelayPort = d.mcwebRpcInit.localRelayPort || null;
      bootHost();
      return;
    }
    // A page-issued multiplayer join: the client polls mcWebNet for it
    // (BrowserMultiplayerCompat.pump) and joins through Mojang's ConnectScreen.
    if (d && d.mcwebJoin) {
      try {
        const net = globalThis.mcWebNet;
        log("[MC-JOIN] " + d.mcwebJoin.host + ":" + d.mcwebJoin.port
          + " via " + net.gatewayUrl());
        net.join(net.gatewayUrl(), d.mcwebJoin.host, d.mcwebJoin.port, d.mcwebJoin.name);
      } catch (failure) {
        log("[MC-JOIN] failed: " + (failure && failure.message || failure));
      }
      return;
    }
    // A DOM event the page captured on the real canvas element, replayed into
    // the host's own listeners (see browser/worker-env.js).
    if (d && d.mcwebDom) {
      globalThis.__mcWebDomReceived = (globalThis.__mcWebDomReceived || 0) + 1;
      if (globalThis.__mcWebDomEvent) globalThis.__mcWebDomEvent(d.mcwebDom.type, d.mcwebDom.init);
      if (d.mcwebDom.type !== "mousemove") {
        log("[MC-INPUT] " + d.mcwebDom.type + " @" + Math.round(d.mcwebDom.init.clientX)
          + "," + Math.round(d.mcwebDom.init.clientY)
          + " received=" + globalThis.__mcWebDomReceived
          + " " + (globalThis.__mcWebInputStats ? globalThis.__mcWebInputStats() : "no-host"));
      }
    }
  });

  // Opt-in probe for WebKit's streaming IPC backlog. Real task boundaries let
  // the browser flush IPC without reordering RPCs or dropping render work.
  globalThis.__mcWebRpcYield = new URLSearchParams(location.search).get("mcweb_rpc_yield") === "1";
  const rpcYieldStats = globalThis.__mcWebRpcYieldStats = {
    enabled: globalThis.__mcWebRpcYield, queued: 0, maximumQueued: 0,
    batches: 0, yields: 0, calls: 0, maximumSliceMs: 0, active: false,
  };
  if (globalThis.__mcWebRpcYield) log("[rpc-yield] enabled:128 commands /4ms, serialized task yields");
  let rpcYieldTail = Promise.resolve();
  let rpcYieldResume = null;
  const rpcYieldChannel = new MessageChannel();
  rpcYieldChannel.port1.onmessage = () => {
    const resume = rpcYieldResume; rpcYieldResume = null; resume?.();
  };
  const yieldRpcTask = () => new Promise(resolve => {
    rpcYieldResume = resolve; rpcYieldStats.yields++;
    rpcYieldChannel.port2.postMessage(0);
  });
  // A single pass stream can contain thousands of commands. Split only at
  // validated MCRP v1 opcode boundaries; its pass and bindings survive tasks.
  function splitRpcRenderCalls(batch) {
    const out = [];
    const operands = [0, 1, 3, 4, 4, 2, 4, 0, 4, 5, 3, 3, 1, 0];
    for (const call of batch) {
      if (call.o !== "gpu" || call.m !== "rpCommandStreamRaw") { out.push(call); continue; }
      const [pass, bytes, length, end] = call.a;
      if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1
          || !Number.isInteger(length) || length < 8 || length > bytes.byteLength || length % 4) {
        out.push(call); continue; // Preserve the host's original validation/error.
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, length);
      if (view.getInt32(0, true) !== 0x4d435250 || view.getInt32(4, true) !== 1) { out.push(call); continue; }
      const parts = [];
      let at = 8, start = 8, commands = 0, valid = true;
      while (at < length) {
        const opcode = view.getInt32(at, true);
        if (opcode < 1 || opcode >= operands.length || at + (1 + operands[opcode]) * 4 > length) {
          valid = false; break; // Let the original decoder run its error/pass cleanup.
        }
        at += (1 + operands[opcode]) * 4;
        if (++commands === 128 || at === length) {
          const part = new Uint8Array(8 + at - start);
          part.set(bytes.subarray(0, 8)); part.set(bytes.subarray(start, at), 8);
          parts.push({ ...call, a: [pass, part, part.length, at === length ? end : 0], rpcYieldUnits: commands, rpcYieldFinal: at === length });
          start = at; commands = 0;
        }
      }
      out.push(...(valid && parts.length ? parts : [call]));
    }
    return out;
  }
  function enqueueRpcBatch(batch, complete) {
    rpcYieldStats.queued++;
    rpcYieldStats.maximumQueued = Math.max(rpcYieldStats.maximumQueued, rpcYieldStats.queued);
    rpcYieldTail = rpcYieldTail.then(async () => {
      rpcYieldStats.active = true;
      let results = [], error = null;
      try {
        const calls = splitRpcRenderCalls(batch), cursor = { index: 0 };
        while (!discarded && cursor.index < calls.length) {
          const started = performance.now();
          results.push(...runBatch(calls, cursor));
          rpcYieldStats.maximumSliceMs = Math.max(rpcYieldStats.maximumSliceMs, performance.now() - started);
          if (cursor.index < calls.length) await yieldRpcTask();
        }
      } catch (failure) { error = String(failure?.message || failure); }
      rpcYieldStats.active = false; rpcYieldStats.queued--; rpcYieldStats.batches++;
      try { complete(results, error); }
      catch (failure) { log("[rpc-yield] completion failed: " + String(failure?.message || failure)); }
    });
  }

  let rpcCount = 0;
  // A request in one of the client's two slots (pre.js sendOnce): its byte
  // offset, length, and the flag to raise once it has been copied out.
  function handle(msg) {
    if (discarded) return;
    if (!msg || typeof msg.slot !== "number") {
      log("[rpc] ignored a message with no request slot: " + JSON.stringify(msg));
      return;
    }
    rpcCount++;
    const { slot, base, len: reqLen, frameCredit } = msg;
    let slotReleased = false;
    const consumed = () => {
      if (slotReleased) return;
      slotReleased = true;
      Atomics.store(i32, 8 + slot, 1);
      Atomics.notify(i32, 8 + slot);
    };
    let creditReleased = false;
    const releaseFrameCredit = () => {
      if (discarded || frameCredit !== true || creditReleased) return;
      creditReleased = true;
      Atomics.add(i32, 10, 1);
      Atomics.notify(i32, 10);
    };
    let results = [];
    let error = null;
    let req = null;
    let releaseAfterWork = null;
    const finishRpc = () => {
      if (discarded) return;
      consumed();
      if (releaseAfterWork) releaseAfterWork();
      else releaseFrameCredit();
      if (req && req.async) {
        if (error) log("[rpc] async batch failed: " + error);
        return;
      }
      const ended = globalThis.__mcWebAudioEnded;
      const ae = ended && ended.length ? ended.splice(0) : undefined;
      const resp = encoder.encode(JSON.stringify({ results, e: error, ae }));
      data.set(resp, base);
      i32[3] = resp.length;
      Atomics.store(i32, 1, 1);
      Atomics.notify(i32, 1);
      if (rpcCount <= 300 || rpcCount % 2000 === 0) log("[rpc] responded #" + rpcCount + " len=" + resp.length + " err=" + error + " clientState=" + Atomics.load(i32, 5).toString(16));
    };
    try {
      // TextDecoder refuses shared-memory views; copy first.
      req = JSON.parse(decoder.decode(data.subarray(base, base + reqLen).slice()));
      // Take every payload out of the shared buffer before running anything:
      // once the client sees "consumed" it may write its next request there.
      for (const call of req.batch || []) {
        if (!call.a) continue;
        call.a = call.a.map((a) => {
          if (a && typeof a === "object" && typeof a.__bin === "number") {
            return data.subarray(a.__bin, a.__bin + a.len).slice();
          }
          if (a && typeof a === "object" && typeof a.__str === "number") {
            return decoder.decode(data.subarray(a.__str, a.__str + a.len).slice());
          }
          return a;
        });
      }
      const presents = req.async && (req.batch || []).some(call => call.o === "gpu" && call.m === "present");
      if (Boolean(presents) !== (frameCredit === true)) throw new Error("RPC frame credit mismatch");
      if (presents) releaseAfterWork = frameBackpressure.retain(releaseFrameCredit);
      consumed();
      if (rpcCount <= 300 || rpcCount % 2000 === 0) {
        const b = (req.batch || [])[0];
        log("[rpc] #" + rpcCount + " t=" + Math.round(performance.now() / 1000) + "s " + (b ? b.o + "." + b.m : "?") + " n=" + (req.batch || []).length);
      }
      if (globalThis.__mcWebRpcYield) {
        enqueueRpcBatch(req.batch || [], (value, failure) => {
          results = value; error = failure; finishRpc();
        });
        return;
      }
      results = runBatch(req.batch || []);
    } catch (err) {
      error = String(err && err.message || err);
    }
    finishRpc();
  }

  const describeArg = (a) => {
    if (a && typeof a === "object" && typeof a.__bin === "number") return "bin[" + a.len + "]";
    if (a && typeof a === "object" && typeof a.__str === "number") return "str[" + a.len + "]";
    if (typeof a === "string") return JSON.stringify(a.length > 24 ? a.slice(0, 24) + "…" : a);
    return String(a);
  };

  // Counted per object and method; __mcWebCallCounts flattens it on demand.
  const callCounts = new Map();
  let traceFrame = false;
  let traceLines = [];

  // Calls whose return value is an object handle. A batched call answers Java
  // with a placeholder before the host has run, so the object is renamed onto
  // that placeholder (mcWebGpu.rekeyObject) and the two are the same number for
  // the object's whole life — no side table, and so no lifetime rules to get
  // wrong. Restricted to these names on purpose: rekeying whatever number
  // canvasWidth() returned would rename an unrelated object.
  const HANDLE_PRODUCERS = new Set([
    "createTexture", "createTextureView", "createSamplerJson", "createBuffer",
    "createCommandEncoder", "createPipeline", "beginRenderPass",
    "acquireCanvasTexture",
  ]);

  // A bounded tail of the most recent calls, kept by reference in a ring. The
  // host reads it only when WebGPU reports a validation error, and shapes it
  // again itself (webgpu-texture-lifetime copyBatch). Rebuilding 128 spread
  // objects on every batch -- which is what this did -- produced garbage on the
  // GPU worker's own hot path for a report that is read at most once.
  const RPC_TAIL = 128;
  const rpcTail = new Array(RPC_TAIL);
  let rpcTailAt = 0;
  let rpcTailCount = 0;
  const noteTailCall = (call) => {
    rpcTail[rpcTailAt] = call;
    rpcTailAt = rpcTailAt + 1 === RPC_TAIL ? 0 : rpcTailAt + 1;
    if (rpcTailCount < RPC_TAIL) rpcTailCount++;
  };
  // Oldest first, which is the order the tail was in when it was a slice.
  const rpcLastBatch = () => {
    if (!rpcTailCount) return null;
    const out = new Array(rpcTailCount);
    const start = (rpcTailAt - rpcTailCount + RPC_TAIL) % RPC_TAIL;
    for (let i = 0; i < rpcTailCount; i++) {
      out[i] = rpcTail[(start + i) % RPC_TAIL];
    }
    return out;
  };

  function runBatch(batch, cursor = null) {
    const sliceStart = performance.now();
    let sliceUnits = 0;
    const objects = {
      gpu: globalThis.mcWebGpu,
      pump: globalThis.mcWebPump,
      input: globalThis.mcWebInput,
      audio: globalThis.mcWebAudio,
      net: globalThis.mcWebNet,
      packHttp: globalThis.mcWebPackHttp,
      canvas: globalThis.mcWebCanvas,
    };
    // The tail ring is filled below, once per call and without allocating; the
    // host pulls it through a getter when a validation report needs it.
    if ((!cursor || cursor.index === 0) && globalThis.mcWebGpu && Array.isArray(batch) && batch.some((call) => call?.o === "gpu")) {
      globalThis.mcWebGpu._rpcBatchCount = (globalThis.mcWebGpu._rpcBatchCount || 0) + 1;
    }
    if (_frameSplit) {
      _splitBatches++; _splitCalls += batch.length;
      // Which call leads each batch: with 1.5 calls per batch, the leader is
      // whatever is forcing a synchronous round trip.
      const lead = batch.length ? (batch[0].o + "." + batch[0].m) : "(empty)";
      _splitLeaders.set(lead, (_splitLeaders.get(lead) || 0) + 1);
    }
    // ?mcweb_framesplit=1: how a frame divides between the two workers. The
    // gap since the previous batch is time the JVM spent computing; the batch
    // itself is time the GPU worker spent executing its calls. Together they
    // account for the whole frame, which is the only way to tell "Java is
    // slow" from "the bridge is slow".
    const splitStart = _frameSplit ? performance.now() : 0;
    if (_frameSplit && _lastBatchEnd) _splitJava += splitStart - _lastBatchEnd;
    const results = [];
    for (let i = cursor?.index || 0; i < batch.length; i++) {
      const call = batch[i];
      if (cursor && sliceUnits && sliceUnits + (call.rpcYieldUnits || 1) > 128) break;
      const obj = objects[call.o];
      if (!obj) throw new Error("unknown rpc object: " + call.o);
      const fn = obj[call.m];
      // Object -> method -> count. The flat form built "o.m" on every call,
      // which is one string per RPC call, several hundred a frame.
      let perObject = callCounts.get(call.o);
      if (perObject === undefined) callCounts.set(call.o, perObject = new Map());
      perObject.set(call.m, (perObject.get(call.m) || 0) + 1);
      noteTailCall(call);
      if (typeof fn !== "function") throw new Error("unknown rpc method: " + call.o + "." + call.m);
      let r;
      try {
        // handle() already replaced every payload marker with its bytes
        // (the slot may hold the client's next request by now).
        r = fn.apply(obj, call.a || []);
      } catch (callError) {
        // Which call in the batch, and what the whole batch was: a bad handle
        // is always a mistake about where the handle came from, so the batch
        // and the placeholders it binds are the only useful evidence.
        log("[rpc] batch failed at #" + i + " " + call.o + "." + call.m + ": "
            + batch.map((c, n) => n + ":" + c.o + "." + c.m
                + (typeof c.r === "number" ? "->" + c.r : "")
                + "(" + (c.a || []).map(describeArg).join(",") + ")").join(" "));
        throw new Error(call.o + "." + call.m + ": " + (callError && callError.message || callError));
      }
      // One frame's worth of render-target plumbing: which colour view each
      // pass writes, and which texture the frame finally blits to the canvas.
      // A pass whose target is not the blitted one is invisible however
      // correct its draws are.
      if (traceFrame) {
        if (call.m === "beginRenderPass") {
          let view = "?";
          try { view = JSON.stringify((JSON.parse(call.a[1]).color || []).map((c) => c.view)); } catch {}
          traceLines.push("pass->" + call.r + " color=" + view);
        } else if (call.m === "copyTexture") {
          traceLines.push("blit src=" + call.a[1] + " dst=" + call.a[2]);
        } else if (call.m === "createTexture") {
          traceLines.push("createTexture->" + call.r + " " + String(call.a[0]).slice(0, 40));
        } else if (call.m === "createTextureView") {
          traceLines.push("createTextureView->" + call.r + " of=" + call.a[0]);
        }
      }

      // Make the placeholder Java already holds into the host's own handle.
      if (typeof call.r === "number" && typeof r === "number"
          && HANDLE_PRODUCERS.has(call.m)
          && globalThis.mcWebGpu.rekeyObject(r, call.r)) {
        r = call.r;
      }
      if (call.rpcYieldUnits) {
        cursor.streamResult = (cursor.streamResult || 0) + (typeof r === "number" ? r : 0);
        if (call.rpcYieldFinal) { results.push(cursor.streamResult); cursor.streamResult = 0; }
      } else results.push(r === undefined ? null : r);
      if (cursor) {
        cursor.index = i + 1;
        rpcYieldStats.calls++;
        sliceUnits += call.rpcYieldUnits || 1;
        if (sliceUnits >= 128 || performance.now() - sliceStart >= 4) break;
      }
    }
    if (_frameSplit) {
      _lastBatchEnd = performance.now();
      _splitGpu += _lastBatchEnd - splitStart;
      if (_lastBatchEnd - _splitReportedAt > 10000) {
        _splitReportedAt = _lastBatchEnd;
        const total = _splitJava + _splitGpu;
        log("[frame-split] batches=" + _splitBatches
          + " java=" + _splitJava.toFixed(0) + "ms (" + (100 * _splitJava / total).toFixed(1) + "%)"
          + " gpuWorker=" + _splitGpu.toFixed(0) + "ms (" + (100 * _splitGpu / total).toFixed(1) + "%)"
          + " calls=" + _splitCalls
          + " callsPerBatch=" + (_splitCalls / _splitBatches).toFixed(1)
          + " roundTripsPerSecond=" + (_splitBatches / 10).toFixed(0));
        const top = [..._splitLeaders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
        log("[frame-split] batch leaders: "
          + top.map(([name, n]) => name + "=" + n).join(" "));
        _splitLeaders.clear();
        _splitJava = 0; _splitGpu = 0; _splitBatches = 0; _splitCalls = 0;
      }
    }
    return results;
  }

  // The shader translator (tools/naga-wasm, served as nagamin.wasm beside this
  // script) behind a synchronous globalThis.mcWebShaderTranslate(source,
  // stage) -> {status, text}; stage is "vertex"/"fragment" (or 0/1); status 0
  // means text is WGSL, otherwise text is naga's message. Never throws: when
  // a file is missing every pipeline draws with the host's error shader;
  // logged once here.
  function startShaderTranslator() {
    try {
      importScripts("shader-glue.js");
    } catch (failure) {
      log("[shader] shader-glue.js did not load: " + (failure && failure.message || failure));
    }
    const started = performance.now();
    return fetch("nagamin.wasm").then((response) => {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.arrayBuffer();
    }).then((bytes) => {
      const module = new WebAssembly.Module(bytes);
      let x = new WebAssembly.Instance(module, {}).exports;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      globalThis.mcWebShaderTranslate = (source, stage) => {
        try {
          const input = encoder.encode(String(source));
          const at = x.alloc(input.length);
          new Uint8Array(x.memory.buffer, at, input.length).set(input);
          const status = x.translate(at, input.length, stage === "vertex" || stage === 0 ? 0 : 1);
          x.dealloc(at, input.length);
          // Read after the call: translating may have grown (replaced) memory.
          const text = decoder.decode(new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len()));
          return { status, text };
        } catch (failure) {
          // A trap (naga panic) can leave the instance's heap mid-update; the
          // next pipeline gets a fresh instance of the compiled module.
          x = new WebAssembly.Instance(module, {}).exports;
          return { status: -1, text: "translator trapped: " + (failure && failure.message || failure) };
        }
      };
      log("[shader] translator ready (" + bytes.byteLength + " bytes, "
        + Math.round(performance.now() - started) + " ms)");
    }).catch((failure) => {
      log("[shader] translator unavailable (nagamin.wasm): " + (failure && failure.message || failure));
    });
  }

  async function bootHost() {
    // The host's vsync pump schedules via requestAnimationFrame, which does
    // not exist in a Worker; a timer at display rate is the worker-correct
    // equivalent (the visible canvas is still committed by the compositor).
    // The shim must exist before the host evaluates: the host reads
    // document.getElementById("minecraft-canvas") at script scope.
    importScripts("worker-env.js");
    importScripts("render-command-stream.js");
    importScripts("webgpu-texture-lifetime.js");
    // The shader glue and the GLSL->WGSL translator (docs/SHADERS-PLAN.md),
    // ready before the first RPC is served: every pipeline's shaders are the
    // game's own, translated in the tab.
    const shadersReady = startShaderTranslator();
    importScripts("webgpu-host.js");
    // Multiplayer transport. mcWebNet is a plain WebSocket client with no DOM
    // dependencies, and it resolves the gateway against location.href — which
    // on this Worker is the harness origin, where serve.mjs hosts the relay.
    importScripts("mc-wisp-socket.js", "mc-net.js");
    // Keep vanilla's downloader/cache/ZIP/reload; only its HTTP connection is
    // browser-backed. Resolve the ESM relative to this worker's runtime URL.
    const { createBrowserPackHttp } = await import("./pack-http.js");
    if (discarded) return;
    const { createPlayerTextureFetch } = await import('./player-textures.mjs');
    globalThis.mcWebPackHttp = createBrowserPackHttp({ fetchImpl: createPlayerTextureFetch() });

    const deadline = performance.now() + 30000;
    while (!globalThis.mcWebGpu.isReady()) {
      if (discarded) return;
      if (performance.now() > deadline) throw new Error("WebGPU device did not open within 30 s");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Bounded: a translator that never arrives costs the shaders, not the
    // game (the host then logs once and draws with its error shader).
    await Promise.race([shadersReady, new Promise((resolve) => setTimeout(resolve, 15000))]);
    // The same value pre.js sets on the JVM Worker, where the port reads it:
    // it keeps BrowserGpu.linearMemoryRuntime() false (this JVM has no WasmLM
    // upload path). Nothing on this Worker reads it. The server's threading
    // comes from -Dmcweb.runtimeMode (McWebRuntimeMode), which wins.
    globalThis.mcWebRuntimeMode = "WASMGC_COOPERATIVE";

    // The pump callback re-enters the JVM (the Java frame entry); it cannot
    // cross the RPC boundary as a function. Each vsync tick is posted to the
    // JVM worker, which runs its stored callback while its event loop is free.
    const realApplyResize = globalThis.mcWebCanvas.applyPendingResize;
    globalThis.mcWebCanvas.applyPendingResize = function () {
      if (!rpcYieldStats.active) return realApplyResize.call(this);
    };
    if (discarded) return;
    const realRegister = globalThis.mcWebPump.register.bind(globalThis.mcWebPump);
    realRegister(() => {
      if (rpcYieldStats.active || (frameBackpressure && !frameBackpressure.shouldPump())) return;
      try { port.postMessage({ mcwebEvent: "pump" }); } catch {}
    });

    // Surface the game's progress markers in the page log: the host's DOM
    // mirrors are stubs in this lane, so log the stages instead.
    const g = globalThis.mcWebGpu;
    const { createFrameBackpressure } = await import("./frame-backpressure.mjs");
    frameBackpressure = createFrameBackpressure({
      getFence: () => g.submittedWorkDone(),
      onError: error => log("[gpu-frame-fence] " + String(error?.message || error))
    });
    g.frameBackpressureReport = () => frameBackpressure.report();
    const realProgress = g.reportProgress.bind(g);
    const diagnosticQuery = new URLSearchParams(location.search);
    const progressDiagnostics = ["mcweb_log_all", "mcweb_debug", "frameDiag", "terrainDiag",
      "frametimeFull", "chunkDiag", "frameSplit", "mcweb_framesplit", "mcweb_pace", "paceStats", "entityEvents", "stdoutconsole"]
      .some(name => { const value = diagnosticQuery.get(name);
        return value !== null && !/^(0|false|off|no)$/i.test(value); });
    // These markers retain the host's bounded stage history without a page
    // message, console entry or DOM update on an ordinary gameplay run.
    const TELEMETRY_STAGE = /^(evt:|packet:|terrain:|gameplay-state:|threads:|chunk:|pumpslow:|server:tick|framesplit:|entitytick:|frametime:|chunkpipe:|inline-task#|png:decoded|pacing:)/;
    // Per-task and per-packet markers run at thousands per second. Mirroring
    // all of them to the console retains a ConsoleMessage per line in whatever
    // is driving the page, which killed a Playwright run with a 4 GB heap OOM
    // that looked exactly like the game hanging. They still reach the page log.
    const NOISY_STAGE = /^(inline-task#|packet:|server:tick=|gc:|threads:|frame-pacing:|png:decoded)/;
    g.reportProgress = (stage) => {
      const text = String(stage);
      if (!progressDiagnostics && TELEMETRY_STAGE.test(text)
          && !/(?:failed|failure|error|outofmemory)/i.test(text)) {
        return realProgress(stage, true);
      }
      if (NOISY_STAGE.test(text)) {
        try { postMessage({ mcwebLog: "[MC-STAGE] " + text }); } catch {}
      } else {
        log("[MC-STAGE] " + text);
      }
      return realProgress(stage);
    };
    const realSuccess = g.reportSuccess.bind(g);
    g.reportSuccess = (argb, backend, path) => { log("[MC-SUCCESS] " + backend + " " + path); return realSuccess(argb, backend, path); };
    const realFailure = g.reportJavaFailure.bind(g);
    g.reportJavaFailure = (stage, type, message) => { log("[MC-FAILURE] " + stage + ": " + type + ": " + message); return realFailure(stage, type, message); };
    const pump = globalThis.mcWebPump;
    const realFrameReported = pump.frameReported.bind(pump);
    let frameLogged = false;
    // ?mcweb_pace=1: frame pacing as the GPU Worker sees it. A frame's
    // frameReported rides its command batch, so its arrival time is when the
    // frame can be presented. Stutter a player feels is the spread of these
    // intervals (one 40 ms frame among 11 ms ones), which neither FPS nor the
    // over-50 ms `frametime:` count shows. One line a second.
    //
    // With animation frames on this Worker, each display refresh also counts
    // the frames that arrived since the previous one (`vsync:` fresh0 = the
    // display repeated a frame, which is the judder a player sees; fresh2 =
    // a frame was drawn and never shown). Even pacing is all fresh1.
    const pace = new URLSearchParams(location.search).has("mcweb_pace")
      ? { last: 0, since: 0, gaps: [], arrived: 0, vsync: [0, 0, 0], vsyncSince: 0 } : null;
    if (pace && typeof requestAnimationFrame === "function") {
      const tick = (now) => {
        pace.vsync[Math.min(2, pace.arrived)]++;
        pace.arrived = 0;
        if (!pace.vsyncSince) pace.vsyncSince = now;
        if (now - pace.vsyncSince >= 1000) {
          const [f0, f1, f2] = pace.vsync;
          log(`[MC-PACE] vsync: hz=${(1000 * (f0 + f1 + f2) / (now - pace.vsyncSince)).toFixed(1)}`
            + ` fresh0=${f0} fresh1=${f1} fresh2=${f2}`);
          pace.vsync = [0, 0, 0];
          pace.vsyncSince = now;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } else if (pace) {
      log("[MC-PACE] vsync: no requestAnimationFrame on the GPU Worker");
    }
    const reportPace = (now) => {
      const gaps = pace.gaps.sort((a, b) => a - b);
      const n = gaps.length;
      const at = (p) => gaps[Math.min(n - 1, Math.floor(n * p))].toFixed(1);
      const over = (ms) => gaps.filter((g) => g > ms).length;
      const median = gaps[n >> 1];
      log(`[MC-PACE] pace: n=${n} p50=${at(0.5)} p90=${at(0.9)} p99=${at(0.99)} max=${gaps[n - 1].toFixed(1)}`
        + ` over20=${over(20)} over33=${over(33)} over50=${over(50)} spikes=${over(2 * median)}`
        + ` sumOver2x=${gaps.filter((g) => g > 2 * median).reduce((s, g) => s + g, 0).toFixed(0)}`);
      pace.gaps = [];
      pace.since = now;
    };
    pump.frameReported = (count) => {
      if (pace) {
        const now = performance.now();
        pace.arrived++;
        if (pace.last) pace.gaps.push(now - pace.last);
        pace.last = now;
        if (!pace.since) pace.since = now;
        if (now - pace.since >= 1000 && pace.gaps.length) reportPace(now);
      }
      if (!frameLogged && count >= 1) { frameLogged = true; log("[MC-FRAME] first frame reported: " + count); }
      // A running total at a coarse cadence: one line per few seconds is enough
      // to measure a rate, and the client is blocked on this call.
      // Trace one steady-state frame, long after the menu has settled.
      if (progressDiagnostics && count === 600) { traceFrame = true; traceLines = []; }
      else if (traceFrame) {
        traceFrame = false;
        log("[MC-TARGETS] " + traceLines.join(" | "));
      }
      // The page needs the live count, not a log line every hundred frames:
      // at in-world frame rates that is one sample per minute, which cannot
      // measure anything.
      if (count % 5 === 0) {
        try { postMessage({ mcwebFrames: count }); } catch {}
      }
      if (progressDiagnostics && count % 100 === 0) {
        log("[MC-FRAMES] frames:" + count);
        if (count % 500 === 0 && globalThis.__mcWebCallSummary) {
          log("[MC-CALLS] input(" + globalThis.__mcWebInputStats() + ") "
            + globalThis.__mcWebCallSummary());
        }
      }
      return realFrameReported(count);
    };

    // Input: the host translates DOM events into mcWebInput.call(name, …), but
    // the callback it would hand back to Java cannot cross the RPC (JSON drops
    // functions), and the JVM Worker's event loop never turns anyway. So the
    // bridge queues here and Java drains the queue once per frame.
    const inputQueue = [];
    let inputSeen = 0;
    const inputEnc = new TextEncoder();
    // The input mailbox the JVM worker reads directly (pre.js
    // installMcWebRpcClient): int 0 = lock, int 1 = bytes used, text from 64.
    const toMailbox = (line) => {
      if (!inputMailbox) return false;
      const h = new Int32Array(inputMailbox, 0, 16);
      const bytes = new Uint8Array(inputMailbox, 64);
      const enc = inputEnc.encode(line + "\n");
      while (Atomics.compareExchange(h, 0, 0, 1) !== 0) { /* the reader holds it briefly */ }
      const n = h[1];
      if (n + enc.length <= bytes.length) {        // full: dropped, as the queue's bound does
        bytes.set(enc, n);
        h[1] = n + enc.length;
      }
      Atomics.store(h, 0, 0);
      return true;
    };
    // VSync for the JVM's frame loop (BrowserFramePump.paceFrame). This
    // Worker owns the canvas, so its animation frames are when frames are
    // shown; while Java has VSync on (pump.configure), each one is posted as
    // `vsync <epoch ms> <period ms>` through the input mailbox, which Java
    // reads every frame without a round trip. Both Workers' timeOrigin+now
    // are the same epoch clock as the JVM's nanoTime. The period is the
    // median of the last 31 intervals, so a skipped frame does not skew it.
    // A line is only added to a nearly empty mailbox: before the game drains
    // it, stamps must not crowd out real input.
    if (typeof requestAnimationFrame === "function") {
      const gaps = [];
      let lastStamp = 0;
      const vsyncTick = (now) => {
        if (lastStamp) {
          gaps.push(now - lastStamp);
          if (gaps.length > 31) gaps.shift();
        }
        lastStamp = now;
        if (globalThis.mcWebPump && globalThis.mcWebPump.vsync && gaps.length >= 7 && inputMailbox
            && new Int32Array(inputMailbox, 0, 16)[1] < 4096) {
          const period = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
          toMailbox("vsync " + (performance.timeOrigin + now).toFixed(3) + " " + period.toFixed(4) + " 0 0");
        }
        requestAnimationFrame(vsyncTick);
      };
      requestAnimationFrame(vsyncTick);
    }
    const realInputRegister = globalThis.mcWebInput.register.bind(globalThis.mcWebInput);
    realInputRegister((name, a, b, c, d) => {
      inputSeen++;
      if (toMailbox(name + " " + a + " " + b + " " + c + " " + d)) return;
      // Bounded: a tab left alone with the mouse moving must not grow this
      // without limit if the game ever stops draining.
      if (inputQueue.length >= 2048) inputQueue.shift();
      inputQueue.push(name + " " + a + " " + b + " " + c + " " + d);
    });
    // Java calls register() too, and a function does not survive the RPC — it
    // arrives as null and would silently replace the queue with nothing, which
    // is indistinguishable from "input is broken".
    globalThis.mcWebInput.register = (bridge) => {
      if (typeof bridge === "function") realInputRegister(bridge);
    };
    globalThis.__mcWebInputStats = () => "seen=" + inputSeen + " queued=" + inputQueue.length;
    globalThis.mcWebInput.drain = () => {
      if (!inputQueue.length) return "";
      const text = inputQueue.join("\n");
      inputQueue.length = 0;
      return text;
    };

    // Which host methods a steady-state frame actually calls. Names, not
    // counts, are the point: a transport that was never wired shows up as an
    // absence, and an absence is invisible in any per-object diagnostic.
    // Flattened on demand: a probe reads counts occasionally, the worker counts
    // on every call.
    const flatCallCounts = () => {
      const flat = new Map();
      for (const [object, methods] of callCounts) {
        for (const [method, n] of methods) flat.set(object + "." + method, n);
      }
      return flat;
    };
    // A live view, as before: probes read the flat "object.method" shape.
    Object.defineProperty(globalThis, "__mcWebCallCounts", {
      configurable: true,
      get: flatCallCounts,
    });
    globalThis.__mcWebCallSummary = () => {
      const rows = [...flatCallCounts().entries()].sort((a, b) => b[1] - a[1]);
      return rows.slice(0, 30).map(([m, n]) => m + "=" + n).join(" ");
    };
    // The host reads _rpcLastBatch only when WebGPU reports a validation
    // error; a getter means the tail is shaped then, not on every batch.
    Object.defineProperty(globalThis.mcWebGpu, "_rpcLastBatch", {
      configurable: true,
      get: rpcLastBatch,
    });

    hostReady = true;
    const ready = {
      mcwebReady: true,
      adapter: globalThis.mcWebGpu.adapterName(),
      width: globalThis.mcWebGpu.canvasWidth(),
      height: globalThis.mcWebGpu.canvasHeight(),
    };
    log("[gpu-host] worker host ready: " + ready.adapter + " (" + ready.width + "x" + ready.height + ")");
    if (port) { try { port.postMessage(ready); } catch {} } else { readyMsg = ready; }
    const queued = pendingRequests.splice(0);
    for (const msg of queued) handle(msg);
  }

  heartbeatInterval = setInterval(() => {
    try {
      let lastCall = "";
      if (i32) {
        const view = new Uint8Array(i32.buffer, 64, 128);
        let end = 0;
        while (end < 128 && view[end]) end++;
        lastCall = decoder.decode(view.subarray(0, end).slice());
      }
      log("[hb] t=" + Math.round(performance.now() / 1000) + "s rpc=" + rpcCount
          + " lastCall=" + lastCall
          + " state=" + (i32 ? Atomics.load(i32, 5).toString(16) : "-")
          + " clientSend=" + (i32 ? Atomics.load(i32, 6) : -1)
          + " clientDone=" + (i32 ? Atomics.load(i32, 7) : -1));
    } catch (e) {
      log("[hb] error: " + (e && e.message || e));
    }
  }, 30000);
})();
