"use strict";

(() => {
  // Bump this marker with every host change so the console proves the live
  // version (the dev server is no-store, but tabs can sit on a cached copy).
  const MCWEB_BUILD = "2026-10-22-progress-quiet1"; // bump on every host change so the console proves the live version
  // The generated loader is exact-patched by graalWebImage to accept an
  // explicit Wasm URL. Bump this pair tag with every canonical image so an old
  // Service Worker can never mix a cached JS loader with a freshly served Wasm.
  const MCWEB_CACHE_TAG = "cb11";
  globalThis.mcWebHostBuild = MCWEB_BUILD;
  console.log("[mcweb-host] build " + MCWEB_BUILD);
  // Opt-in scalar census only: no extra Promise reactions on normal runs.
  const resourceCensusEnabled = new URLSearchParams(location.search).get("mcweb_resource_census") === "1";
  const errorScopeCensus = {pending: 0, maximumPending: 0, started: 0, settled: 0, rejected: 0};
  const popTrackedErrorScope = () => {
    if (!resourceCensusEnabled) return device.popErrorScope();
    const stats = errorScopeCensus;
    stats.started++; stats.pending++;
    stats.maximumPending = Math.max(stats.maximumPending, stats.pending);
    const settled = rejected => { stats.pending--; stats.settled++; if (rejected) stats.rejected++; };
    try {
      return device.popErrorScope().then(value => { settled(false); return value; }, error => { settled(true); throw error; });
    } catch (error) { settled(true); throw error; }
  };
  const canvas = document.getElementById("minecraft-canvas");
  const failure = document.getElementById("failure");

  // --- Boot-progress surface -------------------------------------------------
  // The lightweight launcher owns the visible boot experience. Keeping this
  // small interface here lets the long synchronous Web Image boot report its
  // real stages while the enchanting-glyph signal replaces the old spinner.
  const launcherOverlay = globalThis.mcWebLauncher;
  // On-page diagnostic verdict — visible in a screenshot, no console needed.
  const probeVerdict = document.createElement("div");
  probeVerdict.id = "mcweb-probe-verdict";
  probeVerdict.style.cssText = "position:fixed;top:4px;left:4px;z-index:2147483647;background:rgba(180,0,0,0.92);color:#fff;font:12px/1.4 monospace;padding:6px 10px;max-width:520px;white-space:pre-wrap;pointer-events:none;border:1px solid #f44;border-radius:4px;";
  probeVerdict.textContent = "PROBE: waiting…";
  // Keep the diagnostic available without covering the real title UI during
  // normal runs. Add ?mcweb_debug when screenshot-visible probe evidence is
  // needed again.
  if (new URLSearchParams(location.search).has("mcweb_debug")) {
    document.body.appendChild(probeVerdict);
  }
  let mcbHidden = false;
  globalThis.mcWebBootOverlay = {
    status: (s) => { if (!mcbHidden) launcherOverlay?.status?.(s); },
    stage: (s) => { if (!mcbHidden) launcherOverlay?.stage?.(s); },
    note: (s) => { if (!mcbHidden) launcherOverlay?.note?.(s); },
    hide: () => {
      mcbHidden = true;
      launcherOverlay?.revealGame?.();
    },
    get hidden() { return mcbHidden; }
  };
  // DIAG: probe buffers declared BEFORE the console.log wrapper below. The wrapper
  // captures Java-side panorama/atlas/error lines into _javaErrBuf; declaring it here
  // (not ~1100 lines down) guarantees no temporal-dead-zone ReferenceError if any log
  // line emitted during early script evaluation matches the wrapper's filter.
  const _animRing = [];   // animate_sprite atlas-assembly: target + matrices + sprite per draw
  const _guiAtlasRing = []; // animate_sprite draws specifically targeting the GUI atlas
  const _animTargetCounts = new Map();
  const _javaErrBuf = []; // buffered [MC]/Exception/panorama/atlas log lines
  let _probe2Dumped = false;
  // DIAG: scatter probe (PROBE3). The previous animRing filled its 40 slots on the
  // PARTICLES atlas (40 sprites) and never observed the GUI atlas assembly, so it
  // could not localise the scattered shovel/globe/eye sprites. These two rings are
  // immune to that: _asmBad records any animate_sprite assembly draw whose render
  // target is NOT an atlas (a mis-targeted assembly writes sprites onto the screen
  // AND leaves the atlas empty -- one cause, both symptoms); _scatterDraws records
  // any draw onto the screen-sized main target that samples a per-sprite SOURCE
  // texture (widget/* etc.) rather than the atlas or a standalone title image.
  // ---- draw census (diagnostic, opt-in) --------------------------------
  // location exists in the GPU Worker too (WorkerLocation), and pre.js passes
  // the page's query string through when it starts the worker.
  const _uploadDiag = (() => {
    try { return new URLSearchParams(location.search).get("mcweb_uploaddiag"); }
    catch { return null; }
  })();
  // Texture histories retain entries for this worker's lifetime. Enable them
  // only for short diagnostic sessions; normal rendering keeps no history.
  const _textureHistoryCaptured = ["mcweb_debug", "mcweb_texdiag", "mcweb_atlasdiag", "mcweb_uploaddiag"]
    .some((flag) => new URLSearchParams(location.search).has(flag));
  const _missingTextureHistory = () => ({
    historyCaptured: false,
    error: "texture history was not captured; reload with mcweb_debug, mcweb_texdiag, mcweb_atlasdiag or mcweb_uploaddiag"
  });
  const _lodClamp = (() => {
    try {
      const v = new URLSearchParams(location.search).get("mcweb_lodclamp");
      return v == null ? null : Number(v);
    } catch { return null; }
  })();
  const _drawCensus = (() => {
    try { return new URLSearchParams(location.search).has("mcweb_drawcensus"); }
    catch { return false; }
  })();
  try {
    console.log("[draw-census] enabled=" + _drawCensus
      + " search=" + (typeof location === "undefined" ? "no-location" : location.search));
  } catch {}
  const _drawCensusCounts = new Map();
  let _drawCensusAt = 0;
  const _framePassTrace = [];
  let _terrainVertsDumped = false;
  let _terrainDepthDumped = false;
  let _terrainUniformDumped = false;
  let _uniformSnapshotDumped = false;
  let _visibleSnapshotDumped = false;
  let _writeProbeDumped = false;
  const _depthStateLogged = new Set();
  const _blendLogged = new Set();
  function _noteDrawCensus(state, vertexCount, instanceCount) {
    if (state._traceEntry) {
      state._traceEntry.draws++;
      // Which pipelines ran in this pass, in pass order. If the sky pass runs
      // after the terrain pass and writes opaquely, terrain is painted over -
      // which looks exactly like "terrain never drew".
      const short = String((state.pipeline && state.pipeline.spec
        && state.pipeline.spec.label) || "?").replace("minecraft:pipeline/", "");
      state._traceEntry.pipes ||= new Set();
      if (state._traceEntry.pipes.size < 6) state._traceEntry.pipes.add(short);
      // A scissor that excludes the screen clips the draw away just as
      // effectively as never issuing it. Record the rect in force at the
      // first draw of the pass.
      if (state._traceEntry.scissor === undefined) {
        state._traceEntry.scissor = state._scissor ? state._scissor.join(",") : "none";
        state._traceEntry.area = state.area ? state.area.join(",") : "none";
      }
    }
    const label = state.pipeline && state.pipeline.spec
      ? (state.pipeline.spec.label || "?") : "no-pipeline";
    // tid, not just the label: two distinct render targets can share the name
    // "Main / Color", and the composite can only blit one of them.
    const key = (state._suppressed ? "SUPPRESSED " : "") + label
      + " -> " + (state._targetLabel || "?") + " " + (state._targetWH || "")
      + " tid=" + (state._targetTid ?? "?");
    const entry = _drawCensusCounts.get(key) || { draws: 0, verts: 0 };
    entry.draws++;
    entry.verts += (vertexCount || 0) * Math.max(1, instanceCount || 1);
    _drawCensusCounts.set(key, entry);
    const now = Date.now();
    if (now - _drawCensusAt < 10000) return;
    _drawCensusAt = now;
    const rows = [..._drawCensusCounts.entries()]
      .sort((a, b) => b[1].draws - a[1].draws).slice(0, 14);
    for (const [name, value] of rows) {
      console.log("[draw-census] " + value.draws + "x " + value.verts + "v " + name);
    }
    console.log("[draw-census] distinct=" + _drawCensusCounts.size
      + " presents=" + _presentCount
      + " sinceLastPresent=" + (_lastPresentAt ? (now - _lastPresentAt) + "ms" : "never"));
    _drawCensusCounts.clear();
  }

  const _scatterDraws = [];
  const _asmBad = [];
  let _probe3Dumped = false;
  const _SCATTER_OK = /atlas\/|mojangstudios|title\/minecraft\.png|title\/edition\.png|menu_background|panorama_overlay/;
  function _noteScatter(state) {
    if (_scatterDraws.length >= 16 || !state._targetLabel) return;
    const wh = state._targetWH || "";
    const w = parseInt(wh, 10) || 0;
    if (w <= 1500) return; // atlas / cube targets are <=1024; only the main target is wider
    if (/\/atlas\//.test(state._targetLabel)) return; // assembly draws onto an atlas are NOT screen scatter (they were the 8 false positives that jammed the cap)
    const sampled = [];
    for (const [nm, r] of state.resources) if (r && r.kind === "texture" && r._texEntry) sampled.push(r._texEntry._label || "?");
    if (!sampled.length) return;
    const anomaly = sampled.filter((l) => !_SCATTER_OK.test(l));
    if (!anomaly.length) return;
    const fam = state.pipeline && state.pipeline.spec ? shaderName(state.pipeline.spec.vertexShader) : "?";
    const u = state.resources.get("Projection"); let pm = null;
    if (u && u.kind === "uniform") { const b = objects.get(u.bufferHandle); if (b && b._shadow) { const f = new Float32Array(b._shadow.buffer, (b._shadow.byteOffset || 0) + u.offset, 16); pm = [f[0], f[5]]; } }
    _scatterDraws.push({ fam, tgt: state._targetLabel, tgtWH: wh, pm, anom: anomaly.map((l) => l.split("/").pop()) });
  }
  // Wrap console.log so the Java boot trace ([MC-INIT] / inline-task / [MC])
  // drives the overlay as well as DevTools.
  const originalConsoleLog = console.log.bind(console);
  console.log = (...values) => {
    originalConsoleLog(...values);
    try {
      const t = values.map((v) => (typeof v === "string" ? v : (v && v.message) ? v.message : JSON.stringify(v))).join(" ");
    if (/panorama|atlas|Exception|Failed|cube|reload/i.test(t) && !/^\[(TEX-|GUI-DRAW|PANO-|ANIM-|PROBE|mcweb)/.test(t) && !/^SLF4J/.test(t) && _javaErrBuf.length < 30) _javaErrBuf.push(t.slice(0, 220));
      if (mcbHidden) return;
      const m = t.match(/^\[MC-INIT\]\s*(.*)$/);
      if (m) { globalThis.mcWebBootOverlay.stage(m[1] || t); return; }
      const it = t.match(/inline-task#(\d+):(\S+)/);
      if (it) { globalThis.mcWebBootOverlay.status("Reloading assets… task #" + it[1]); globalThis.mcWebBootOverlay.note(it[2]); return; }
      if (/^\[MC\]/.test(t) && !/^SLF4J/.test(t)) globalThis.mcWebBootOverlay.note(t.slice(0, 96));
    } catch {}
  };
  const objects = new Map();
  let nextHandle = 1;
  let adapter;
  let device;
  let context;
  let discarded = false, discardedResources = null;
  let heartbeatInterval = null, countersInterval = null;
  // Probe only the GPU Worker's final displayed surface. Game/virtual
  // textures and their byte formats remain RGBA8.
  const preferredCanvasFormatEnabled = typeof WorkerGlobalScope !== "undefined"
    && new URLSearchParams(location.search).get("mcweb_preferred_canvas_format") === "1";
  const canvasFormat = preferredCanvasFormatEnabled
    ? (navigator.gpu?.getPreferredCanvasFormat?.() || "rgba8unorm") : "rgba8unorm";
  const diagnostics = {lastCall: "host setup", calls: {}, stages: [], stageMs: [], reloadProbe: []};

  // Canvas sizing. The backing store must track the CSS box, otherwise the
  // browser simply scales a stale framebuffer to the new element size -- that
  // is the "resizing stretches the image" symptom. Resizing it is only half the
  // fix: Minecraft also has to hear about it, or GUI scale, projection and
  // render targets all stay at the boot size. The dispatch goes through the
  // same single input bridge the keyboard and mouse use.
  globalThis.mcWebCanvas = {
    pending: true,

    targetSize() {
      const ratio = Math.min(devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const cssWidth = rect.width || innerWidth;
      const cssHeight = rect.height || innerHeight;
      return [
        Math.max(1, Math.round(cssWidth * ratio)),
        Math.max(1, Math.round(cssHeight * ratio))
      ];
    },

    resizeBackingStore() {
      const [width, height] = this.targetSize();
      if (canvas.width === width && canvas.height === height) return false;
      canvas.width = width;
      canvas.height = height;
      if (context && device) {
        context.configure({
          device,
          format: canvasFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
          alphaMode: "opaque"
        });
      }
      return true;
    },

    applyPendingResize() {
      if (!this.pending) return;
      const changed = this.resizeBackingStore();
      const bridge = globalThis.mcWebInput && globalThis.mcWebInput.bridge;
      if (!bridge) {
        // Stay armed: before the bridge exists, Window still reads the size
        // through glfwGetFramebufferSize, but a later resize must not be lost.
        return;
      }
      this.pending = false;
      if (changed) globalThis.mcWebInput.call("resize", canvas.width, canvas.height);
    }
  };

  addEventListener("resize", () => { globalThis.mcWebCanvas.pending = true; });
  if (globalThis.visualViewport) {
    globalThis.visualViewport.addEventListener("resize", () => {
      globalThis.mcWebCanvas.pending = true;
    });
  }

  /** Durable `evt:` gameplay-packet counters. The 4000-entry stage ring is
   *  evicted by the worldgen packet flood, so windowed counts read from the
   *  ring undercount to zero. Counters never evict. */
  const _evtCounts = new Map();

  /**
   * Markers emitted per packet, per frame or per tick. Everything else — boot
   * stages, screen changes, one-shot diagnostics — keeps the console line and
   * the on-page status text, which is what makes a stalled boot visible.
   */
  const _CHATTY_STAGE =
    /^(evt:|packet:|terrain:|gameplay-state:|threads:|chunk:|pumpslow:|levelload:|server:tick)/;
  const _logAllStages = new URLSearchParams(location.search).has("mcweb_log_all");

  const recordStage = (stage) => {
    const stages = diagnostics.stages;
    stages.push(stage);
    // Console delivery timestamps are useless for a blocking boot: every line
    // emitted while the main thread is busy is delivered in one burst when it
    // frees up, so a two-minute constructor looks instantaneous in DevTools.
    // Stamping here is the only way to attribute that time to a stage.
    diagnostics.stageMs.push(Math.round(performance.now()));
    if (stages.length > 4000) {
      stages.splice(0, stages.length - 4000);
      diagnostics.stageMs.splice(0, diagnostics.stageMs.length - 4000);
    }
    if (typeof stage === "string" && stage.startsWith("evt:")) {
      const row = _evtCounts.get(stage) || { n: 0, firstMs: 0, lastMs: 0, ts: [] };
      row.n++;
      const now = performance.now();
      if (!row.firstMs) row.firstMs = now;
      row.lastMs = now;
      // Keep the last 32 individual timestamps: per-hit latency correlation
      // needs each crossing's time, not just first/last.
      row.ts.push(Math.round(now * 100) / 100);
      if (row.ts.length > 32) row.ts.shift();
      _evtCounts.set(stage, row);
    }
  };

  // A ring, not a push-and-shift array: shift() moved the whole 60 entries on
  // every one of the ~12,000 calls a second this takes, and the ring is read
  // only when something fails.
  const RECENT_CALLS = 60;
  const _recentCallRing = new Array(RECENT_CALLS);
  let _recentCallAt = 0;
  let _recentCallCount = 0;
  // Oldest first, which is the order the shift() kept.
  const _recentCalls = () => {
    const out = new Array(_recentCallCount);
    const start = (_recentCallAt - _recentCallCount + RECENT_CALLS) % RECENT_CALLS;
    for (let i = 0; i < _recentCallCount; i++) out[i] = _recentCallRing[(start + i) % RECENT_CALLS];
    return out;
  };
  let _renderCommandReplayDepth = 0;

  /** Call name plus only the args that locate a failure, kept short. */
  const _summarise = (name, detail) => {
    if (!detail) return name;
    if (name === "createBuffer") {
      return `createBuffer(${detail.label},sz=${detail.size},use=${detail.usage})`;
    }
    if (name === "writeBuffer") {
      const transport = detail.packedChars == null
        ? `b64=${detail.base64Length}`
        : `bytes=${detail.byteLength},chars=${detail.packedChars}`;
      return `writeBuffer(h=${detail.handle},@${detail.destinationOffset},${transport})`;
    }
    if (name === "writeBufferRaw") {
      return `writeBufferRaw(h=${detail.handle},@${detail.destinationOffset},bytes=${detail.byteLength})`;
    }
    if (name === "writeTextureRaw") {
      return `writeTextureRaw(h=${detail.handle},bytes=${detail.byteLength})`;
    }
    if (name === "reportProgress") return `reportProgress(${detail.stage ?? ""})`;
    return name;
  };

  // The dataset mirror is display-only (nothing reads it programmatically —
  // the failure ring and per-call counters live in _recentCalls/diagnostics
  // and stay exact). Coalescing it to "only when the call name changes" was
  // not enough: the render path alternates two call names per pass, so the
  // name changed on every call. It is time-throttled instead, which keeps the
  // on-page "what is the GPU doing" mirror useful during a stall.
  let _lastMarkCallDom = null;
  let _lastMarkCallDomMs = 0;
  let _markCallDomPending = false;
  const _perfNow = typeof performance !== "undefined"
    ? () => performance.now() : () => Date.now();
  const markCall = (name, detail = null) => {
    // One outer rpCommandStream call represents the Java/JS boundary. Its
    // internal operations must not perform thousands of diagnostic DOM writes
    // or masquerade as additional bridge crossings.
    if (_renderCommandReplayDepth !== 0) return;
    // The bare call name brackets a failure to a region but cannot say where
    // inside a loop it happened: a 128 MiB uber-buffer is seeded by ~170
    // identical writeBuffer chunks, and "died during writeBuffer" is true
    // whether it died on the first chunk (the big allocation) or the 90th (a
    // transient spike). Keeping the size/offset args distinguishes those.
    _recentCallRing[_recentCallAt] = _summarise(name, detail);
    _recentCallAt = _recentCallAt + 1 === RECENT_CALLS ? 0 : _recentCallAt + 1;
    if (_recentCallCount < RECENT_CALLS) _recentCallCount++;
    diagnostics.lastCall = name;
    diagnostics.lastDetail = detail;
    diagnostics.calls[name] = (diagnostics.calls[name] || 0) + 1;
    // The DOM mirror exists so a human or a probe can read the last call
    // without a page evaluate; nothing consumes it at frame rate. Writing it
    // on every change of `name` did: a real server frame alternates
    // beginRenderPass with rpCommandStream ~84 times, so this wrote three
    // dataset properties — one of them a JSON.stringify of a render-pass
    // descriptor — about 12,700 times a second. Mirror on a timer instead and
    // the ring above stays exact. The clock is read only while a mirror write
    // is actually owed, which is not on every call.
    if (name !== _lastMarkCallDom) {
      _lastMarkCallDom = name;
      _markCallDomPending = true;
    }
    if (_markCallDomPending) {
      const now = _perfNow();
      if (now - _lastMarkCallDomMs >= 250) {
        _lastMarkCallDomMs = now;
        _markCallDomPending = false;
        document.body.dataset.lastGpuCall = name;
        document.body.dataset.lastGpuCallCount = String(diagnostics.calls[name]);
        if (detail) document.body.dataset.lastGpuDetail = JSON.stringify(detail);
      }
    }
  };

  // Expose the durable evt counters for probes that need windowed counts the
  // evicting ring cannot provide.
  globalThis.mcWebEvtCounts = () => Object.fromEntries(_evtCounts);

  const resolveBindingName = (value, kind) => {
    // Older staged images still pass their pre-interning Java String object.
    // Returning it untouched avoids the recursive Proxy string conversion that
    // caused the WasmLM stack overflow. Numeric IDs must resolve exactly.
    if (typeof value !== "number") return value;
    const name = globalThis.mcWebGpu?._bindingNames?.[value];
    if (typeof name !== "string") throw new Error(`unknown ${kind} binding name ${value}`);
    return name;
  };

  const setText = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };

  const fail = (error) => {
    const message = error?.stack || String(error);
    failure.hidden = false;
    failure.textContent = message;
    setText("jar-status", "failed");
    setText("gpu-status", error?.message || String(error));
    console.error(error);
  };

  // Frames flowing means the client is healthy; from then on, console noise
  // (notably headless-SwiftShader's "Instance dropped in popErrorScope") must
  // not re-show the failure overlay and hide the rendered canvas.
  let framesFlowing = false;
  const originalConsoleError = console.error.bind(console);
  console.error = (...values) => {
    originalConsoleError(...values);
    if (framesFlowing) return;
    // Benign startup warnings (e.g. SLF4J NOP) must not mask a healthy run.
    const text = values.map((value) => String(value?.message ?? value)).join(" ");
    if (text.startsWith("SLF4J")) return;
    const firstError = values.find((value) => value instanceof Error);
    const message = values.map((value) => value?.stack || String(value)).join("\n");
    failure.hidden = false;
    failure.textContent = firstError?.stack || message;
    setText("jar-status", "runtime error");
  };

  const put = (object) => {
    const handle = nextHandle++;
    if (object && typeof object === "object") object._handle = handle;
    objects.set(handle, object);
    return handle;
  };

  // Java byte arrays cross the Web Image interop boundary as base64 text;
  // BufferSource conversion rejects the raw interop proxy.
  const base64ToBytes = (base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  };

  // WasmGC has no exported linear memory. Pack two payload bytes into each
  // UTF-16 code unit so Web Image's unavoidable Java-String conversion walks
  // 3/8 as many characters as Base64, then reconstruct the exact byte view.
  const packedTextToBytes = (text, byteLength) => {
    if (typeof text !== "string" || !Number.isInteger(byteLength) || byteLength < 0
        || text.length !== Math.ceil(byteLength / 2)) {
      throw new Error(`invalid packed upload length chars=${text?.length} bytes=${byteLength}`);
    }
    const bytes = new Uint8Array(byteLength);
    for (let i = 0; i < text.length; i++) {
      const pair = text.charCodeAt(i);
      const at = i * 2;
      bytes[at] = pair & 0xff;
      if (at + 1 < byteLength) bytes[at + 1] = pair >>> 8;
    }
    return bytes;
  };

  const get = (handle, kind) => {
    const object = objects.get(handle);
    if (!object) throw new Error(`Unknown ${kind} handle ${handle}`);
    return object;
  };

  const minecraftTextureUsage = (usage) => {
    let result = 0;
    if (usage & 1) result |= GPUTextureUsage.COPY_DST;
    if (usage & 2) result |= GPUTextureUsage.COPY_SRC;
    if (usage & 4) result |= GPUTextureUsage.TEXTURE_BINDING;
    if (usage & 8) result |= GPUTextureUsage.RENDER_ATTACHMENT;
    return result;
  };

  const minecraftBufferUsage = (usage) => {
    let result = 0;
    if (usage & 8) result |= GPUBufferUsage.COPY_DST;
    if (usage & 16) result |= GPUBufferUsage.COPY_SRC;
    if (usage & 32) result |= GPUBufferUsage.VERTEX;
    if (usage & 64) result |= GPUBufferUsage.INDEX;
    if (usage & 128) result |= GPUBufferUsage.UNIFORM;
    if (usage & 512) result |= GPUBufferUsage.INDIRECT;
    // Mojang permits MAP_WRITE|UNIFORM. WebGPU does not, so Java maps a
    // CPU shadow and flushes it into a COPY_DST buffer instead.
    if (usage & 2) result |= GPUBufferUsage.COPY_DST;
    if (usage & 1) result |= GPUBufferUsage.COPY_SRC;
    if (usage & 256) {
      // Mojang's USAGE_UNIFORM_TEXEL_BUFFER is a Vulkan concept with no WebGPU
      // equivalent; the nearest is a read-only storage buffer. Throwing here
      // aborted the whole render frame, and the throw only became reachable
      // once the PNG fix let atlas stitching complete. Approximating is
      // strictly better: if a shader really needs texel-buffer semantics its
      // pipeline fails to build and is skipped (a degraded feature), instead
      // of taking the entire frame -- and the client -- down with it.
      result |= GPUBufferUsage.STORAGE;
    }
    if (!result) throw new Error(`Unsupported Minecraft buffer usage ${usage}`);
    return result;
  };

  const minecraftFormat = (format) => {
    const formats = {
      RGBA8_UNORM: "rgba8unorm",
      RGBA8_SNORM: "rgba8snorm",
      RGBA8_UINT: "rgba8uint",
      RGBA8_SINT: "rgba8sint",
      BGRA8_UNORM: "bgra8unorm",
      R8_UNORM: "r8unorm",
      R8_SNORM: "r8snorm",
      R8_UINT: "r8uint",
      R8_SINT: "r8sint",
      RG8_UNORM: "rg8unorm",
      RG8_SNORM: "rg8snorm",
      RG8_UINT: "rg8uint",
      RG8_SINT: "rg8sint",
      RGBA16_UNORM: "rgba16unorm",
      RGBA16_SNORM: "rgba16snorm",
      RGBA16_UINT: "rgba16uint",
      RGBA16_SINT: "rgba16sint",
      RGBA16_FLOAT: "rgba16float",
      RGBA32_FLOAT: "rgba32float",
      RG16_FLOAT: "rg16float",
      RG32_FLOAT: "rg32float",
      R16_FLOAT: "r16float",
      R32_FLOAT: "r32float",
      RG11B10_FLOAT: "rg11b10ufloat",
      RGB10A2_UNORM: "rgb10a2unorm",
      RGB10A2_UINT: "rgb10a2uint",
      D32_FLOAT: "depth32float",
      D32_FLOAT_S8_UINT: "depth32float-stencil8",
      D24_UNORM_S8_UINT: "depth24plus-stencil8",
      D16_UNORM: "depth16unorm"
    };
    const mapped = formats[format];
    if (!mapped) throw new Error(`Minecraft texture format ${format} is not ported yet`);
    return mapped;
  };

  // ---------------------------------------------------------------------------
  // Pipelines: Mojang RenderPipeline spec -> GPURenderPipeline. The shaders are
  // the game's own GLSL, handed over in the spec at run time (read from the
  // player's jar), bound to this host's layout by shader-glue.js and translated
  // to WGSL in the GPU worker (docs/SHADERS-PLAN.md). This file carries no
  // shader code from the game: the tables below map Mojang's pipeline state
  // enums onto WebGPU's, and a pipeline whose shaders fail to translate draws
  // with MC-Web's own magenta error shader instead.
  // ---------------------------------------------------------------------------

  // Mojang vertex element format -> WebGPU vertex format. shader-glue.js
  // (vertexFormat) narrows the 3-component ones where the 4-wide format would
  // read past the element.
  const VERTEX_GPU_FORMATS = {
    R32_FLOAT: {gpu: "float32"},
    RG32_FLOAT: {gpu: "float32x2"},
    RGB32_FLOAT: {gpu: "float32x4"},
    RGBA32_FLOAT: {gpu: "float32x4"},
    R16_FLOAT: {gpu: "float16x2"},
    RG16_FLOAT: {gpu: "float16x2"},
    RGB16_FLOAT: {gpu: "float16x4"},
    RGBA16_FLOAT: {gpu: "float16x4"},
    R8_UNORM: {gpu: "unorm8x2"},
    RG8_UNORM: {gpu: "unorm8x2"},
    RGB8_UNORM: {gpu: "unorm8x4"},
    RGBA8_UNORM: {gpu: "unorm8x4"},
    R8_SNORM: {gpu: "snorm8x2"},
    RG8_SNORM: {gpu: "snorm8x2"},
    RGB8_SNORM: {gpu: "snorm8x4"},
    RGBA8_SNORM: {gpu: "snorm8x4"},
    R8_UINT: {gpu: "uint8x2"},
    RG8_UINT: {gpu: "uint8x2"},
    RGBA8_UINT: {gpu: "uint8x4"},
    R16_UINT: {gpu: "uint16x2"},
    RG16_UINT: {gpu: "uint16x2"},
    RGBA16_UINT: {gpu: "uint16x4"},
    R32_UINT: {gpu: "uint32"},
    RG32_UINT: {gpu: "uint32x2"},
    RGBA32_UINT: {gpu: "uint32x4"},
    R8_SINT: {gpu: "sint8x2"},
    RG8_SINT: {gpu: "sint8x2"},
    RGBA8_SINT: {gpu: "sint8x4"},
    R16_SINT: {gpu: "sint16x2"},
    RG16_SINT: {gpu: "sint16x2"},
    RGBA16_SINT: {gpu: "sint16x4"},
    R32_SINT: {gpu: "sint32"},
    RG32_SINT: {gpu: "sint32x2"},
    RGBA32_SINT: {gpu: "sint32x4"}
  };

  const TOPOLOGY = {
    TRIANGLES: "triangle-list",
    QUADS: "triangle-list",
    TRIANGLE_FAN: "triangle-list",
    TRIANGLE_STRIP: "triangle-strip",
    // Mojang draws LINES as triangles (two per segment, through its quad
    // index pattern): the game's own lines vertex shaders widen each segment
    // by the vertex index.
    LINES: "triangle-list",
    DEBUG_LINES: "line-list",
    DEBUG_LINE_STRIP: "line-strip",
    POINTS: "point-list"
  };

  const BLEND_FACTOR = {
    ZERO: "zero",
    ONE: "one",
    SRC_COLOR: "src",
    ONE_MINUS_SRC_COLOR: "one-minus-src",
    DST_COLOR: "dst",
    ONE_MINUS_DST_COLOR: "one-minus-dst",
    SRC_ALPHA: "src-alpha",
    ONE_MINUS_SRC_ALPHA: "one-minus-src-alpha",
    DST_ALPHA: "dst-alpha",
    ONE_MINUS_DST_ALPHA: "one-minus-dst-alpha",
    CONSTANT_COLOR: "constant",
    ONE_MINUS_CONSTANT_COLOR: "one-minus-constant",
    CONSTANT_ALPHA: "constant-alpha",
    ONE_MINUS_CONSTANT_ALPHA: "one-minus-constant-alpha",
    SRC_ALPHA_SATURATE: "src-alpha-saturated"
  };

  const BLEND_OP = {
    ADD: "add",
    SUBTRACT: "subtract",
    REVERSE_SUBTRACT: "reverse-subtract",
    MIN: "min",
    MAX: "max"
  };

  const _forceDepthAlways = (typeof location !== "undefined")
    && new URLSearchParams(location.search).get("mcweb_diag") === "depthalways";

  const COMPARE_OP = {
    ALWAYS_PASS: "always",
    LESS_THAN: "less",
    LESS_THAN_OR_EQUAL: "less-equal",
    EQUAL: "equal",
    NOT_EQUAL: "not-equal",
    GREATER_THAN_OR_EQUAL: "greater-equal",
    GREATER_THAN: "greater",
    NEVER_PASS: "never"
  };

  // The vertex shader's short name ("core/terrain" -> "terrain"), for
  // diagnostics and the sprite blits' culling.
  const shaderName = (id) => String(id || "").replace(/^minecraft:/, "").replace(/^core\//, "");

  // Some WebGPU backends (this ANGLE/SwiftShader path) cap maxBindGroups at 4,
  // but Mojang's entity/item/terrain/text pipelines use 5-6 groups. Merge every
  // group >= K-1 into group K-1 (K = maxBindGroups) with collision-free binding
  // renumbering, and apply the SAME remap to the shader bindings (the glue's,
  // checked against this in translatePipeline), the pipeline layout, and the
  // host bind calls so they stay consistent. Groups < K-1 are untouched.
  const GROUP_CAP = Math.max(1, Math.min(8, device?.limits?.maxBindGroups || 4));
  const computeBindGroupRemap = (groups) => {
    const K = Math.min(GROUP_CAP, groups.length || 1);
    const map = groups.map((g, gi) => {
      const ng = gi < K - 1 ? gi : K - 1;
      return { ng, baseU: 0, baseS: 0, nuniforms: g.uniforms.length, nsamplers: g.samplers.length };
    });
    if (K === groups.length) return { map, K, merged: false };
    // Pack each MERGED group globally: every original group that folds into the
    // same merged group shares one binding space, so we must lay out ALL of
    // their uniforms first (contiguous baseU), then ALL of their sampler pairs
    // (contiguous baseS AFTER the uniforms). The previous per-group running
    // count reset baseS relative to only the same original group's uniforms, so
    // when two original groups folded together (e.g. the blur post-chain's
    // SamplerInfo/BlurConfig group and its InSampler group) the sampler landed
    // on binding 0 — colliding with the other group's uniform at binding 0
    // ("binding index (0) was specified by a previous entry") and invalidating
    // the whole pipeline (and thus the title-screen render). Deriving every
    // binding from this single map keeps the shader declarations, the
    // bind-group layout, and ensureBindGroups perfectly consistent and
    // collision-free.
    const uCursor = new Array(K).fill(0);
    for (let gi = 0; gi < groups.length; gi++) {
      map[gi].baseU = uCursor[map[gi].ng];
      uCursor[map[gi].ng] += groups[gi].uniforms.length;
    }
    const sCursor = uCursor.slice(); // samplers start after all merged-group uniforms
    for (let gi = 0; gi < groups.length; gi++) {
      map[gi].baseS = sCursor[map[gi].ng];
      sCursor[map[gi].ng] += groups[gi].samplers.length * 2;
    }
    return { map, K, merged: true };
  };

  // ---------------------------------------------------------------------------
  // Shaders (docs/SHADERS-PLAN.md). The pipeline spec carries the game's own
  // preprocessed GLSL (spec.vertexSource / fragmentSource, read from the
  // player's jar); shader-glue.js binds it to this host's layout and the GPU
  // worker's translator (naga, mcWebShaderTranslate) turns it into WGSL.
  //
  // Render targets hold GL's memory layout (row 0 = bottom): the glue negates
  // clip Y after the game's vertex stage, so pipelines wind clockwise, scissor
  // rectangles and region clears take GL's bottom-left origin as they are,
  // and the composite flips the image once on its way to the canvas.
  //
  // A pipeline whose shaders cannot be glued, translated, compiled or
  // validated logs one "[shader] <label> <stage>: <message>" line and draws
  // with errorStages() instead: MC-Web's own magenta shader over the same
  // bind-group slots, so the game's binds stay valid and the frame survives.
  // ---------------------------------------------------------------------------
  const _shaderOut = (line) => {
    try { (globalThis.__mcWebOut || console.log)(line); } catch { console.log(line); }
  };
  // stage + textHash(WGSL) -> {module, error: Promise<string|null>}. Many
  // entity and item pipelines share stages.
  const _shaderModules = new Map();
  const _shaderLogged = new Set();
  const _translateStats = {pipelines: 0, translated: 0, failed: 0};
  let _translatorMissingLogged = false;
  // One line per pipeline, the first failure only (never shader text).
  const shaderFailure = (label, stage, message) => {
    if (_shaderLogged.has(label)) return;
    _shaderLogged.add(label);
    _shaderOut(`[shader] ${label} ${stage}: ${String(message || "").split("\n")[0]}`);
  };
  const shaderSummary = () => {
    _shaderOut(`[shader] translate: ${_translateStats.translated} translated, ${_translateStats.failed} failed`);
  };
  const translatedModule = (G, text, stage) => {
    const key = stage + ":" + G.textHash(text);
    let entry = _shaderModules.get(key);
    if (!entry) {
      // Errors come back through getCompilationInfo; the scope only keeps the
      // invalid module from also raising an uncaptured validation error.
      const scoped = typeof device.pushErrorScope === "function";
      if (scoped) device.pushErrorScope("validation");
      const module = device.createShaderModule({label: `mcweb-translated ${key}`, code: text});
      if (scoped) popTrackedErrorScope().catch(() => {});
      const error = typeof module.getCompilationInfo === "function"
        ? module.getCompilationInfo().then((info) => {
            const e = (info?.messages || []).find((m) => m.type === "error");
            return e ? `${String(e.message).split("\n")[0]} @${e.lineNum}:${e.linePos}` : null;
          }, () => null)
        : Promise.resolve(null);
      entry = {module, error};
      _shaderModules.set(key, entry);
    }
    return entry;
  };
  // The translated stages and layout of one pipeline, or null (logged) when
  // it must draw with the error shader. Synchronous: the translator is
  // loaded at worker start (gpu-rpc-worker.js).
  const translatePipeline = (spec) => {
    const label = spec.label || spec.vertexShader || "?";
    if (!spec.vertexSource || !spec.fragmentSource) {
      shaderFailure(label, "source", "the spec carries no GLSL");
      return null;
    }
    const G = globalThis.mcWebShaderGlue;
    const translate = globalThis.mcWebShaderTranslate;
    if (!G || typeof G.prepareTranslated !== "function" || typeof translate !== "function") {
      if (!_translatorMissingLogged) {
        _translatorMissingLogged = true;
        _shaderOut("[shader] the translator is not loaded"
          + ` (shader-glue.js ${G ? "ok" : "missing"}, nagamin.wasm ${typeof translate === "function" ? "ok" : "missing"});`
          + " every pipeline draws with the error shader");
      }
      shaderFailure(label, "translator", "not loaded");
      return null;
    }
    const prep = G.prepareTranslated(spec, translate,
      {cap: GROUP_CAP, vertexTable: VERTEX_GPU_FORMATS});
    if (!prep.ok) {
      shaderFailure(label, prep.stage, prep.message);
      return null;
    }
    // The glue numbers bindings itself; ensureBindGroups binds by the host's
    // remap. They are the same algorithm; refuse rather than mis-bind if not.
    const groups = spec.bindGroups || [];
    const {map: remap, K} = computeBindGroupRemap(groups);
    const mergedU = new Array(K).fill(0);
    groups.forEach((g, gi) => { mergedU[remap[gi].ng] += g.uniforms.length; });
    let mismatch = prep.layout.K !== K ? `group count ${prep.layout.K} != ${K}` : null;
    groups.forEach((g, gi) => {
      g.uniforms.forEach((u, ui) => {
        const at = prep.layout.uniforms.get(u.name);
        if (!mismatch && (!at || at.g !== remap[gi].ng || at.b !== remap[gi].baseU + ui)) mismatch = `uniform ${u.name}`;
      });
      const base = Math.max(remap[gi].baseS, mergedU[remap[gi].ng]);
      g.samplers.forEach((s, si) => {
        const at = prep.layout.samplers.get(s);
        if (!mismatch && (!at || at.g !== remap[gi].ng || at.b !== base + si * 2)) mismatch = `sampler ${s}`;
      });
    });
    if (mismatch) {
      shaderFailure(label, "layout", `glue binding differs from the host remap: ${mismatch}`);
      return null;
    }
    const vs = translatedModule(G, prep.vs, "vertex");
    const fs = translatedModule(G, prep.fs, "fragment");
    return {
      vs: vs.module,
      fs: fs.module,
      vsEntry: "main",
      fsEntry: "main",
      // The fragment writes depth: no variant without depth state (buildVariants).
      fragDepth: wgslWritesFragDepth(prep.fs),
      compileErrors: [
        vs.error.then((m) => (m ? {stage: "vertex", message: m} : null)),
        fs.error.then((m) => (m ? {stage: "fragment", message: m} : null))
      ],
      pipelineErrors: [],
      entries: prep.entries,
      samplerKinds: prep.samplerKinds,
      buffers: prep.buffers
    };
  };

  // The error shader, written for MC-Web: vertex index modulo 3 picks a
  // corner of one oversized triangle that covers the whole target, drawn
  // once per pass (errorShaderDraw), so a pipeline that failed paints its
  // target magenta and cannot go unnoticed. It reads no vertex buffer and
  // no binding. One output per colour target, typed by the
  // target's format (integer targets take integer magenta); a depth-only
  // pipeline gets a fragment stage with no output.
  const _errorModules = new Map();
  const errorModule = (targetFormats) => {
    const outputs = targetFormats.map((format, i) => {
      if (!format) return null;
      const scalar = /sint$/.test(format) ? "i32" : /uint$/.test(format) ? "u32" : "f32";
      const full = scalar === "f32" ? "1.0" : scalar === "i32" ? "127" : "255";
      const none = scalar === "f32" ? "0.0" : "0";
      return {decl: `@location(${i}) c${i}: vec4<${scalar}>`,
        value: `o.c${i} = vec4<${scalar}>(${full}, ${none}, ${full}, ${full});`};
    }).filter(Boolean);
    const key = outputs.map((o) => o.decl).join("|");
    let module = _errorModules.get(key);
    if (!module) {
      const fragment = outputs.length ? `
struct McWebErrorTargets { ${outputs.map((o) => o.decl).join(", ")} };
@fragment fn mcweb_error_fs() -> McWebErrorTargets {
  var o: McWebErrorTargets;
  ${outputs.map((o) => o.value).join("\n  ")}
  return o;
}` : "\n@fragment fn mcweb_error_fs() {}";
      module = device.createShaderModule({label: "mcweb-error-shader", code: `
@vertex fn mcweb_error_vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4<f32> {
  var cover = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(cover[v % 3u], 0.0, 1.0);
}${fragment}
`});
      _errorModules.set(key, module);
    }
    return module;
  };
  // What a pipeline draws with when its own shaders failed: the error shader
  // over the slots the spec names, at the host's bindings, so every bind the
  // game issues for it still validates. Slot types follow the sampler
  // declarations in the GLSL the spec carries (cube and integer textures need
  // matching slots); float slots are unfilterable with a nearest sampler,
  // since the error shader samples nothing and such a slot takes any float,
  // depth or 32-bit float texture the game binds.
  const errorStages = (spec) => {
    const groups = spec.bindGroups || [];
    const {map: remap, K} = computeBindGroupRemap(groups);
    const mergedU = new Array(K).fill(0);
    groups.forEach((g, gi) => { mergedU[remap[gi].ng] += g.uniforms.length; });
    const source = `${spec.vertexSource || ""}\n${spec.fragmentSource || ""}`;
    const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const entries = Array.from({length: K}, () => []);
    const samplerKinds = new Map();
    groups.forEach((g, gi) => {
      const r = remap[gi];
      g.uniforms.forEach((u, ui) => entries[r.ng].push({binding: r.baseU + ui, visibility: both,
        buffer: {type: u.type === "TEXEL_BUFFER" ? "read-only-storage" : "uniform"}}));
      const base = Math.max(r.baseS, mergedU[r.ng]);
      g.samplers.forEach((name, si) => {
        const escaped = String(name).replace(/[^\w]/g, "\\$&");
        const decl = new RegExp(`\\b([iu]?)sampler(2D|Cube)\\s+${escaped}\\b`).exec(source);
        const sampleType = decl && decl[1] === "i" ? "sint" : decl && decl[1] === "u" ? "uint" : "unfilterable-float";
        const viewDimension = decl && decl[2] === "Cube" ? "cube" : "2d";
        const nonFiltering = sampleType === "unfilterable-float";
        entries[r.ng].push({binding: base + si * 2, visibility: both,
          sampler: {type: nonFiltering ? "non-filtering" : "filtering"}});
        entries[r.ng].push({binding: base + si * 2 + 1, visibility: both, texture: {sampleType, viewDimension}});
        samplerKinds.set(name, {nonFiltering, sampleType, viewDimension});
      });
    });
    return {error: true, vs: null, fs: null, vsEntry: "mcweb_error_vs", fsEntry: "mcweb_error_fs",
      compileErrors: [], pipelineErrors: [], entries, samplerKinds, buffers: []};
  };

  // A pipeline drawing with the error shader paints its target once per
  // pass, whatever the game draws with it: repeating the cover triangle for
  // every draw costs only fill rate (thousands of full-target triangles a
  // frame when the translator is missing), and an indexed draw would hand
  // the shader index values instead of the corners 0..2.
  const errorShaderDraw = (state) => {
    const drawn = (state._errorDrawn ||= new Set());
    if (drawn.has(state.pipeline.pipeline)) return;
    drawn.add(state.pipeline.pipeline);
    state.pass.draw(3);
  };

  // The colour targets a pipeline is built with: the spec's own, which may be
  // none (26.3's depth copies and its transparency water mask write depth
  // only) or several (its transparency accumulation writes two). A spec with
  // neither targets nor depth state - the Java side's structural fallback -
  // still needs one attachment, and gets one rgba8unorm target.
  const pipelineColorTargets = (spec) => (spec.colorTargets && spec.colorTargets.length) || spec.depthStencil
    ? (spec.colorTargets || [])
    : [{format: "RGBA8_UNORM"}];

  // Whether a translated fragment stage writes depth (GLSL gl_FragDepth,
  // which naga emits as a frag_depth output).
  const wgslWritesFragDepth = (wgsl) => {
    return /@builtin\(\s*frag_depth\s*\)/.test(String(wgsl || ""));
  };

  // The depth-attachment states createPipeline pre-builds for one pipeline,
  // base first, as buildPipeline's depthFormat argument (undefined: the main
  // target's default; null: a pass with no depth attachment). A spec that
  // declares depth state is based on the main target and also gets a
  // no-depth variant; one that declares none, the other way round. WebGPU
  // rejects a pipeline without depth state when it has no colour target, or
  // when its fragment stage writes frag_depth (26.3's oit_composite,
  // oit_depth_bounds_cull and blit_depth_during_depth_bounds), and that
  // rejection would swap the whole pipeline for the error shader; such a
  // pipeline gets no no-depth variant.
  const deferDepthVariants = new URLSearchParams(location.search).get("mcweb_lazy_depth") === "1";
  const deferPipelines = new URLSearchParams(location.search).get("mcweb_lazy_pipeline") === "1";
  const pipelineDepthVariants = (spec, depthOnly, writesFragDepth) => {
    if (spec.depthStencil) return depthOnly || writesFragDepth ? [undefined] : [undefined, null];
    return writesFragDepth ? ["depth32float"] : [null, "depth32float"];
  };

  // Keep each native pipeline's exact explicit layouts, including depth/error/
  // sample-type variants, with the dynamic-uniform metadata ensureBindGroups
  // binds them by. Weak ownership retains both only while the pipeline is
  // live; bind-group/resource cache lifetime is unchanged.
  const pipelineBindGroupLayouts = new WeakMap();
  const isUniformLayoutEntry = (entry) => !!entry.buffer && (entry.buffer.type || "uniform") === "uniform";

  // stages: what the pipeline draws with - translatePipeline's result, or
  // errorStages(spec). Shader modules and entry points, the bind-group layout
  // entries and the vertex buffers that go with them; this function adds the
  // pipeline state (targets, blend, depth, topology, culling).
  const buildPipeline = (spec, depthFormat, stages) => {
    // depthFormat === undefined ⇒ caller (the precompile gate) didn't specify a
    // pass depth, so use the historical default. An EXPLICIT null means "the
    // pass has no depth attachment" and must NOT synthesize depth state.
    if (depthFormat === undefined) depthFormat = "depth32float";
    // Strictly "does the pass we are building for have a depth attachment".
    // This previously also OR'd in !!spec.depthStencil, which made it true for
    // the NO-depth variant (depthFormat === null) of any depth-declaring
    // pipeline and synthesized `format: null` -- the exact failure the guard on
    // the spec branch below exists to prevent. A pipeline bound in a pass with
    // no depth attachment must carry no depth state, whatever its spec says.
    const depthRequested = depthFormat != null;
    // Open a validation scope for the whole build so the FIRST failing GPU
    // object (bind-group layout / pipeline layout / pipeline) is logged with
    // its real message, instead of only the downstream "invalid due to a
    // previous error" cascade.
    const _scopeOpen = typeof device.pushErrorScope === "function";
    if (_scopeOpen) device.pushErrorScope("validation");
    const _popScope = () => {
      if (_scopeOpen) popTrackedErrorScope().then((err) => {
        if (err && !(buildPipeline._loggedBuild || (buildPipeline._loggedBuild = new Set())).has(spec.label)) {
          buildPipeline._loggedBuild.add(spec.label);
          console.error(`[build validation error] ${spec.label}: ${err.message}`);
        }
      }).catch(() => {});
    };
    const vertexShader = shaderName(spec.vertexShader);
    const groups = spec.bindGroups || [];
    const { map: groupRemap, K: groupCount, merged: groupsMerged } = computeBindGroupRemap(groups);
    // Mojang numbers a group's UNIFORMS and SAMPLERS in *separate* binding
    // spaces (both from 0) — valid for GL/Vulkan descriptor sets but illegal in
    // WebGPU, where bindings must be unique within a bind group. The blur chain
    // exposes this directly (group 1 = SamplerInfo@0, BlurConfig@1, InSampler@0
    // → duplicate binding 0). So we lay each original group's samplers AFTER its
    // uniforms. When groups are merged, samplers must also clear every folded
    // group's uniforms in the same merged group, hence max(baseS, merged-group
    // uniform count). baseS already equals the merged-group uniform count when
    // groups fold (computeBindGroupRemap), and equals 0 otherwise, so this is a
    // safe no-op for non-overlapping / merged cases and fixes the overlap.
    const mergedUniformCount = new Array(groupCount).fill(0);
    groups.forEach((g, gi) => { mergedUniformCount[groupRemap[gi].ng] += g.uniforms.length; });
    const samplerBase = (gi) => Math.max(groupRemap[gi].baseS, mergedUniformCount[groupRemap[gi].ng]);
    if (/blur/.test(spec.label) && (typeof location !== "undefined") && new URLSearchParams(location.search).has("mcweb_debug") && !(buildPipeline._dbgBlur)) {
      buildPipeline._dbgBlur = true;
      const samplerMap = new Map();
      groups.forEach((g, gi) => g.samplers.forEach((s, si) =>
        samplerMap.set(s, { g: groupRemap[gi].ng, b: samplerBase(gi) + si * 2 })));
      console.log("[BLIT-REMAP-DBG]", spec.label,
        "groups=", JSON.stringify(groups.map((g, gi) => ({ gi, ng: groupRemap[gi].ng, baseU: groupRemap[gi].baseU, baseS: groupRemap[gi].baseS, nu: g.uniforms.length, ns: g.samplers.length, uniforms: g.uniforms.map((u) => u.name), samplers: g.samplers }))),
        "K=", groupCount, "merged=", groupsMerged,
        "samplerMap=", JSON.stringify([...samplerMap.entries()]));
    }

    // One layout per *merged* group, at the remapped bindings (translatePipeline
    // checked the glue against this remap; errorStages builds on it), visible
    // to both stages.
    //
    // Uniform-buffer entries take dynamic offsets when the whole pipeline
    // layout fits the device's maxDynamicUniformBuffersPerPipelineLayout:
    // ensureBindGroups then binds each (buffer, range size) at offset 0 and
    // passes each draw's ring-slot offset to setBindGroup, so one bind group
    // serves every slot instead of one per slot. A layout over the limit keeps
    // every entry static. Texel buffers (read-only storage) are never dynamic.
    // dynamic.slot[ng][binding] is the entry's position in `offsets` (-1: not
    // dynamic); each group's positions run in increasing binding order, which
    // is the order WebGPU reads a group's dynamic offsets in.
    let dynamicTotal = 0;
    for (let ng = 0; ng < groupCount; ng++) {
      for (const entry of stages.entries[ng] || []) if (isUniformLayoutEntry(entry)) dynamicTotal++;
    }
    const dynamic = dynamicTotal > 0
      && dynamicTotal <= (device.limits?.maxDynamicUniformBuffersPerPipelineLayout | 0)
      ? {slot: [], start: new Uint8Array(groupCount), count: new Uint8Array(groupCount),
          offsets: new Uint32Array(dynamicTotal)}
      : null;
    const bindGroupLayouts = [];
    for (let ng = 0, next = 0; ng < groupCount; ng++) {
      let entries = stages.entries[ng] || [];
      if (dynamic) {
        let maxBinding = -1;
        for (const entry of entries) maxBinding = Math.max(maxBinding, entry.binding);
        const slot = new Int16Array(maxBinding + 1).fill(-1);
        for (const entry of entries) if (isUniformLayoutEntry(entry)) slot[entry.binding] = -2;
        dynamic.start[ng] = next;
        for (let binding = 0; binding < slot.length; binding++) if (slot[binding] === -2) slot[binding] = next++;
        dynamic.count[ng] = next - dynamic.start[ng];
        dynamic.slot.push(slot);
        // Copies: stages.entries is shared with the depth and sample-type
        // variants built from the same stages.
        entries = entries.map((entry) => isUniformLayoutEntry(entry)
          ? {...entry, buffer: {...entry.buffer, hasDynamicOffset: true}} : entry);
      }
      bindGroupLayouts.push(device.createBindGroupLayout({label: `${spec.label}:group${ng}`, entries}));
    }

    // DIAG: terrain renders saturated white (255,255,255), not FogColor, so the
    // ChunkVisibility blend is fine and one of the three factors that tint
    // the texel (atlas sample, vertex Color, lightmap lookup via UV2)
    // is ~255x too large. A unorm8 colour decoded as raw uint8 does exactly
    // that, so record the declared vs mapped attribute formats.
    if (/terrain|entity_solid/.test(spec.label || "")) {
      (globalThis.mcWebGpu._vertexLayouts ||= {})[spec.label] =
        (spec.vertexFormats || []).filter(Boolean).map((vf) => ({
          stride: vf.stride,
          elements: (vf.elements || []).map((e) => ({
            name: e.name,
            declared: e.format,
            mapped: (VERTEX_GPU_FORMATS[e.format] || {}).gpu ?? "UNMAPPED",
            offset: e.offset
          }))
        }));
    }
    const colorTargets = pipelineColorTargets(spec);
    const errorModuleFor = stages.error
      ? errorModule(colorTargets.map((t) => (t ? minecraftFormat(t.format) : null)))
      : null;
    const vertex = {module: errorModuleFor || stages.vs, entryPoint: stages.vsEntry};
    // One layout per bound vertex format, attributes at the shader's input
    // locations (shader-glue.js vertexBuffers). The fullscreen passes and the
    // sprite-atlas assembly build their vertices from the vertex index, have
    // no vertex format and declare no buffer.
    if (stages.buffers.length) vertex.buffers = stages.buffers;

    // A null entry is a hole: that attachment of the pass is not written.
    const targets = [];
    for (const target of colorTargets) {
      if (!target) {
        targets.push(null);
        continue;
      }
      const entry = {format: minecraftFormat(target.format)};
      if (target.writeMask !== undefined && target.writeMask !== 15) {
        entry.writeMask = target.writeMask;
      }
      if (target.blend) {
        entry.blend = {
          color: {
            srcFactor: BLEND_FACTOR[target.blend.colorSrc],
            dstFactor: BLEND_FACTOR[target.blend.colorDst],
            operation: BLEND_OP[target.blend.colorOp]
          },
          alpha: {
            srcFactor: BLEND_FACTOR[target.blend.alphaSrc],
            dstFactor: BLEND_FACTOR[target.blend.alphaDst],
            operation: BLEND_OP[target.blend.alphaOp]
          }
        };
      }
      if (_drawCensus && !_blendLogged.has(spec.label)) {
        _blendLogged.add(spec.label);
        // A colour write mask of 0, or a blend that resolves to "keep the
        // destination", makes a draw invisible while every other state looks
        // correct - the same symptom as never drawing at all.
        console.log("[draw-census] target " + spec.label
          + " writeMask=" + (target.writeMask === undefined ? 15 : target.writeMask)
          + " blend=" + (entry.blend
            ? entry.blend.color.srcFactor + "/" + entry.blend.color.dstFactor
              + " a:" + entry.blend.alpha.srcFactor + "/" + entry.blend.alpha.dstFactor
            : "none")
          + " fmt=" + entry.format);
      }
      targets.push(entry);
    }

    const descriptor = {
      label: spec.label,
      layout: device.createPipelineLayout({
        label: `${spec.label}:layout`,
        bindGroupLayouts
      }),
      vertex,
      fragment: {
        module: errorModuleFor || stages.fs,
        entryPoint: stages.fsEntry,
        targets
      },
      primitive: {
        // The error shader draws whole-target triangles from any draw.
        topology: stages.error ? "triangle-list" : (TOPOLOGY[spec.topology] || "triangle-list"),
        // Sprite blits are two-dimensional copies, so culling has no useful
        // effect there.
        // ?mcweb_nocull=1 disables backface culling everywhere: a diagnostic
        // that separates "reversed winding" from every other cause of
        // missing faces in one run.
        cullMode: (_forceNoCull || stages.error || vertexShader === "animate_sprite")
          ? "none"
          : (spec.cull ? "back" : "none"),
        // The game's matrices are GL's, and the glue negates clip Y so render
        // targets hold GL's memory layout; that mirrors the winding, so GL's
        // counter-clockwise front faces arrive clockwise.
        frontFace: "cw"
      }
    };
    if (stages.error && depthRequested) {
      // The error shader must not hide the frame behind it in depth.
      descriptor.depthStencil = {format: depthFormat, depthWriteEnabled: false,
        depthCompare: "always", depthBias: 0, depthBiasSlopeScale: 0};
    } else if (spec.depthStencil && depthFormat != null) {
      descriptor.depthStencil = {
        // Derived from the render pass's depth attachment (see rpSetPipeline
        // variant handling); the precompile default assumes the main target.
        //
        // The depthFormat != null guard matters: createPipeline also builds a
        // NO-depth variant (depthFormat === null) of every pipeline, including
        // those whose spec DOES declare depth state. Without the guard that
        // variant emitted `format: null` and WebGPU rejected the pipeline with
        // "Failed to read the 'format' property from 'GPUDepthStencilState'",
        // losing the no-depth variant for solid_terrain and cutout_terrain.
        // A spec-declared depth state simply cannot apply to a pass that has
        // no depth attachment, so the variant must be depth-less instead.
        format: depthFormat,
        depthWriteEnabled: spec.depthStencil.writeDepth,
        // ?mcweb_diag=depthalways -> terrain ignores the depth test. Splits
        // "the depth state rejects every terrain fragment" from "the geometry
        // or its uniforms are wrong": if blocks appear under this flag, depth
        // is the fault; if the frame is unchanged, depth is exonerated.
        depthCompare: (_forceDepthAlways && /terrain/.test(spec.label))
          ? "always"
          : (COMPARE_OP[spec.depthStencil.depthTest] || "less-equal"),
        depthBias: Math.round(spec.depthStencil.biasConstant || 0),
        depthBiasSlopeScale: spec.depthStencil.biasScale || 0
      };
      if (_drawCensus && !_depthStateLogged.has(spec.label)) {
        _depthStateLogged.add(spec.label);
        console.log("[draw-census] depthstate " + spec.label
          + " compare=" + descriptor.depthStencil.depthCompare
          + " write=" + descriptor.depthStencil.depthWriteEnabled
          + " declared=" + spec.depthStencil.depthTest);
      }
    } else if (depthRequested) {
      // The spec declared no depth state, but the pass we are being built for
      // HAS a depth attachment (panorama/sky AND the fullscreen blits are all
      // drawn into the depth-bearing main pass at some point). WebGPU requires
      // the pipeline's attachment state to match the pass regardless of shader,
      // so synthesize a depth state that never disturbs the buffer. Guarded by
      // depthRequested so the NO-depth variant (depthFormat === null) stays
      // depth-less — otherwise a pipeline built for a no-depth pass would itself
      // fail validation. createPipeline pre-builds both variants into byDepth.
      if (_drawCensus && !_depthStateLogged.has(spec.label)) {
        _depthStateLogged.add(spec.label);
        console.log("[draw-census] depthstate " + spec.label
          + " compare=always write=false declared=SYNTHESIZED");
      }
      descriptor.depthStencil = {
        format: depthFormat,
        depthWriteEnabled: false,
        depthCompare: "always",
        // depthBias MUST be 0 for line-list topologies (rendertype_lines); since
        // this is a synthesized never-write/always-pass state, zero bias is also
        // the correct no-op for every other topology.
        depthBias: 0,
        depthBiasSlopeScale: 0
      };
    }
    // WebGPU forbids non-zero depth bias on line topologies ("depthBias must be
    // 0 when using PrimitiveTopology::LineList"). Mojang's lines render type
    // sets a bias, which would fail pipeline creation (and the precompile gate);
    // clamp it for any line topology regardless of whether the depth state came
    // from the spec or was synthesized above.
    if (descriptor.depthStencil && /^line/.test(descriptor.primitive.topology)) {
      descriptor.depthStencil.depthBias = 0;
      descriptor.depthStencil.depthBiasSlopeScale = 0;
    }
    if (/lines/.test(spec.label) && _DBG) {
      console.log("[lines-dbg] label=", spec.label, "spec.topology=", JSON.stringify(spec.topology),
        "mapped=", TOPOLOGY[spec.topology], "hadDepthStencil=", !!spec.depthStencil,
        "depthBias=", descriptor.depthStencil && descriptor.depthStencil.depthBias);
    }

    if (typeof device.pushErrorScope === "function") device.pushErrorScope("validation");
    const pipeline = device.createRenderPipeline(descriptor);
    pipelineBindGroupLayouts.set(pipeline, {layouts: bindGroupLayouts, dynamic});
    if (typeof device.popErrorScope === "function") {
      const createScope = popTrackedErrorScope();
      // A translated pipeline the device rejects is swapped for the error
      // shader (createPipeline watches these).
      stages.pipelineErrors.push(createScope.then((err) => (err ? {stage: "pipeline", message: err.message} : null), () => null));
      createScope.then((err) => {
        if (err && !(buildPipeline._loggedCreate || (buildPipeline._loggedCreate = new Set())).has(spec.label)) {
          buildPipeline._loggedCreate.add(spec.label);
          console.error(`[pipeline create error] ${spec.label} (${stages.error ? "error shader" : vertexShader}): ${err.message}`,
            "\nvertexFormats=" + JSON.stringify((spec.vertexFormats || []).map((vf) => vf.elements?.map((e) => e.name + ":" + e.format))));
        }
      }).catch(() => {});
    }
    _popScope();
    return {pipeline, spec, depthFormat, groupRemap, groupCount,
      samplerBases: groups.map((g, gi) => samplerBase(gi)),
      stages, samplerKinds: stages.samplerKinds};
  };

  // ---------------------------------------------------------------------------
  // Non-indexed topology lowering (QUADS / TRIANGLE_FAN): synthesize index
  // buffers on demand, then drawIndexed.
  // ---------------------------------------------------------------------------

  const loweringIndexBuffers = new Map();
  const loweredIndices = (topology, vertexCount) => {
    const key = `${topology}:${vertexCount}`;
    let entry = loweringIndexBuffers.get(key);
    if (entry) return entry;
    let indices;
    if (topology === "QUADS") {
      const quads = Math.floor(vertexCount / 4);
      indices = new Uint32Array(quads * 6);
      for (let i = 0; i < quads; i++) {
        const base = i * 4;
        const out = i * 6;
        indices[out] = base;
        indices[out + 1] = base + 1;
        indices[out + 2] = base + 2;
        indices[out + 3] = base;
        indices[out + 4] = base + 2;
        indices[out + 5] = base + 3;
      }
    } else if (topology === "TRIANGLE_FAN") {
      const triangles = Math.max(0, vertexCount - 2);
      indices = new Uint32Array(triangles * 3);
      for (let i = 0; i < triangles; i++) {
        indices[i * 3] = 0;
        indices[i * 3 + 1] = i + 1;
        indices[i * 3 + 2] = i + 2;
      }
    } else {
      return null;
    }
    const buffer = device.createBuffer({
      label: `lowered ${topology} ${vertexCount}`,
      size: Math.max(4, indices.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(buffer, 0, indices);
    entry = {buffer, count: indices.length};
    loweringIndexBuffers.set(key, entry);
    return entry;
  };

  // ---------------------------------------------------------------------------
  // Host-side present composite: Mojang's 26.2 presenter renders the scene to
  // an offscreen main target but never blits it to the swap-chain canvas (its
  // blitFromTexture/copyTexture path is not exercised here), so the canvas
  // would stay empty. We track the last scene color target and, when a render
  // pass is opened against the canvas, draw that texture into it with a
  // dedicated fullscreen-triangle blit pipeline.
  let compositeSource = null;
  let _compositeLogAt = 0;
  let _lastPresentAt = 0;
  let _presentEnterAt = 0;
  let _presentExitAt = 0;
  let _presentCount = 0;
  let _rpDbgN = 0; // bounded rpSetPipeline debug trace counter (module scope)
  // DIAG: textures actually sampled (bound into a bind group) this frame, and
  // the last auto/forced texture-readback snapshot (see mcWebGpu._texDiag).
  let _sampledThisFrame = _textureHistoryCaptured ? new Set() : null;
  let _lastFrameSampled = _textureHistoryCaptured ? new Set() : null; // DIAG: most recent frame
  const _sampledEntries = _textureHistoryCaptured ? new Set() : null; // DIAG: ever sampled
  let _texDiagSnapshot = null;
  let _texDiagDone = false;
  let _texDiagLateDone = false; // DIAG: late lifetime-upload dump fired once
  let _animDbgDone = false; // DIAG: one-shot animate_sprite UBO dump
  let _texDrawDbgN = 0; // DIAG: count of textured GUI draw dumps emitted (cap 8)
  // DIAG: ring buffer of the ACTUAL decoded vertex/index bytes for the first few
  // textured GUI draws. The older _maybeTexDrawDiag reads VBO offset 0 (not the
  // batched draw's baseVertex) and never stored the index-buffer handle, so it
  // could not show why atlas-sampled GUI quads scatter while the standalone logo
  // (same family) renders correctly. This captures, per draw, the decoded
  // Position/UV0/Color at baseVertex+index, the index values, the draw params,
  // and the DynamicTransforms block (incl. TextureMat), then dumps once.
  const _guiDrawRing = [];
  // Item models are rendered into a dedicated offscreen atlas with the
  // block/item/entity pipelines, so the early GUI-only ring above never sees
  // the draws that populate missing inventory icons. Keep a separate bounded
  // trace with the exact slot transform and scissor used for each atlas draw.
  const _itemAtlasDrawRing = [];
  // DIAG: title-frame text draws are normally reached after the early GUI ring
  // has filled with the Mojang splash/logo. Keep them in a separate bounded
  // ring so font debugging can prove whether glyph quads and a glyph texture
  // actually reach the host.
  const _fontDrawRing = [];
  const _fontPassStats = new Map();
  let _guiRingDumped = false;
  // DIAG: panorama cube-fill + draw probe (consolidated single-line dump at frame 2).
  const _panoProbe = { created: [], uploads: [], pipeBegin: [], pipeOk: [], pipeSkip: [], pipeFail: [], set: 0 };
  let _panoDumped = false;
  // DIAG: global upload history by label [count, bytes], and a creation registry
  // (every texture instance), so we can spot a label that WAS uploaded but whose
  // sampled instance wasn't (stale/duplicate handle).
  const _uploadByLabel = _textureHistoryCaptured ? new Map() : null;
  const _recentCreated = _textureHistoryCaptured ? [] : null;
  // Verbose per-frame/pipeline diagnostics; off by default (set ?mcweb_debug).
  const _DBG = (typeof location !== "undefined") && new URLSearchParams(location.search).has("mcweb_debug");
  let compositePipeline = null;
  let compositePipelineH = 0;
  let compositeSampler = null;
  // Region clears cannot use attachment loadOp=clear: WebGPU applies that to
  // the entire subresource, regardless of render area or scissor. Minecraft's
  // GUI item cache clears one atlas tile before drawing each item, so turning
  // those into full clears erased every previously rendered inventory icon.
  // Cache tiny draw-based clear pipelines by attachment formats + values.
  const regionClearPipelines = new Map();
  // Clear attachments always address one mip of one layer. Reuse their native
  // views across passes, keyed by the actual texture (virtual canvas entries
  // can change while their native texture stays the same). Weak keys do not
  // retain replaced textures; each texture has at most mips * layers views.
  let clearAttachmentViews = new WeakMap();
  const clearAttachmentView = (texture, mip, layer) => {
    let views = clearAttachmentViews.get(texture);
    if (!views) clearAttachmentViews.set(texture, views = new Map());
    const key = `${mip}:${layer}`;
    let view = views.get(key);
    if (!view) {
      if (!Number.isInteger(mip) || mip < 0 || mip >= texture.mipLevelCount
          || !Number.isInteger(layer) || layer < 0 || layer >= texture.depthOrArrayLayers) {
        throw new RangeError("Clear attachment mip/layer is outside its texture");
      }
      view = texture.createView({dimension: "2d", baseMipLevel: mip, mipLevelCount: 1,
        baseArrayLayer: layer, arrayLayerCount: 1});
      views.set(key, view);
    }
    return view;
  };
  // Dummy resources used to fill bind-group slots whose real resource isn't
  // bound yet, so a group is ALWAYS complete and setBindGroup never gets
  // skipped (skipping it leaves the group unbound → "No bind group at group
  // index N" validation → Mojang's Java throws → the frame pump dies).
  let dummyUniform = null, dummyStorage = null, dummySampler = null;
  let dummyTexView = null, dummyDepthView = null;
  // Fence-based deferred GPU-resource destruction. Mojang deletes a uniform/
  // vertex buffer (e.g. SpriteAnimationInfo) while a command buffer that
  // references it is still in flight; native GL retains the buffer until the GPU
  // is done, but WebGPU rejects the submit ("used in submit while destroyed") and
  // the frame aborts, killing the pump. So on destroy we only drop the live
  // registry entry and park the GPU object in a pending list; after each submit
  // we snapshot that list and hold it until queue.onSubmittedWorkDone() resolves
  // (= every submit issued up to that point has completed on the GPU), which is
  // the exact moment no in-flight command buffer can reference it. A frame-count
  // grace is too fragile because a buffer destroyed AFTER a submit is still in
  // flight for that submit.
  const _deferredDestroy = globalThis.mcWebTextureLifetime.createDeferredDestroyQueue({
    getQueue: () => device?.queue ?? null,
    fallbackBatches: 4,
    onTextureDestroyed: (entry) => {
      clearAttachmentViews.delete(entry.texture);
      const index = texInventory.indexOf(entry);
      if (index >= 0) texInventory.splice(index, 1);
      if (compositeSource === entry) compositeSource = null;
    },
  });
  const deferDestroyBuffer = _deferredDestroy.deferDestroyBuffer;
  const deferDestroyTexture = _deferredDestroy.deferDestroyTexture;
  const flushGraveyard = _deferredDestroy.flush;
  const _textureLifetime = globalThis.mcWebTextureLifetime.createTextureLifetime({
    deferDestroyTexture,
    recentCalls: () => _recentCalls(),
    rpcBatch: () => globalThis.mcWebGpu?._rpcLastBatch ?? null,
  });
  let diagChecker = null;
  // Per-target draw accounting to identify the real scene target by data.
  let texSeq = 0;
  const texInventory = [];
  let frameDraws = new Map();   // tid -> draw calls this frame
  let lastFrameDraws = new Map();
  let drawSeq = 0;              // monotonic per-pass draw-order stamp
  let frameDrawSeq = new Map(); // tid -> last drawSeq that drew into it this frame
  let lastFrameDrawSeq = new Map();
  // Absolute last-drawn target this frame (incl. the canvas, _tid -1) so we can
  // tell "Mojang drew the final image to the canvas" (splash ⇒ don't composite)
  // from "Mojang's final image is offscreen" (title ⇒ composite it).
  let frameLastTid = 0;
  let _virtualCanvas = null;   // see acquireCanvasTexture
  // Only where frames cross tasks: the OpenJDK lane's host lives in a GPU
  // Worker fed over RPC. The Web Image lane calls this host synchronously
  // inside one animation-frame task, where the real canvas texture stays
  // valid; ?mcweb_virtualcanvas forces it on there too.
  const _useVirtualCanvas = (typeof WorkerGlobalScope !== "undefined")
    || (() => { try { return new URLSearchParams(location.search).has("mcweb_virtualcanvas"); } catch { return false; } })();
  let frameLastIsCanvas = false;
  let lastFrameIsCanvas = false;
  const ensureDiagChecker = () => {
    if (diagChecker) return diagChecker;
    const S = 16;
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4, on = (x + y) & 1;
      data[i] = on ? 255 : 40; data[i+1] = on ? 150 : 40; data[i+2] = on ? 0 : 200; data[i+3] = 255;
    }
    const t = device.createTexture({size: [S, S], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture: t}, data, {bytesPerRow: S * 4}, {width: S, height: S});
    diagChecker = t;
    return t;
  };
  const ensureComposite = (h) => {
    if (!compositeSampler) {
      compositeSampler = device.createSampler({magFilter: "linear", minFilter: "linear"});
    }
    if (compositePipeline && compositePipelineH === h) return compositePipeline;
    const mod = device.createShaderModule({label: "mcweb-composite", code: `
struct VsOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  var p = array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  // The source is in GL's memory layout (row 0 at the bottom), so this is
  // where the image is flipped, once, for the canvas.
  var u = array<vec2<f32>,3>(vec2<f32>(0.0,0.0), vec2<f32>(2.0,0.0), vec2<f32>(0.0,2.0));
  var o: VsOut; o.position = vec4<f32>(p[i], 0.0, 1.0); o.uv = u[i]; return o;
}
@group(0) @binding(0) var S_s: sampler;
@group(0) @binding(1) var S: texture_2d<f32>;
@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> { return textureSample(S, S_s, in.uv); }
`});
    const layout = device.createPipelineLayout({bindGroupLayouts: [device.createBindGroupLayout({
      entries: [
        {binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "filtering"}},
        {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float", viewDimension: "2d"}}
      ]
    })]});
    compositePipeline = device.createRenderPipeline({
      label: "mcweb-composite", layout, vertex: {module: mod, entryPoint: "vs_main"},
      fragment: {module: mod, entryPoint: "fs_main", targets: [{format: canvasFormat}]},
      primitive: {topology: "triangle-list"}
    });
    compositePipelineH = h;
    return compositePipeline;
  };

  // Render pass state
  // ---------------------------------------------------------------------------

  const passState = (passHandle) => get(passHandle, "render pass");
  // DIAG: one-shot dump of the first textured GUI draw (vertex bytes + matrices + target).
  // Called from both rpDraw and rpDrawIndexed because Mojang's BufferBuilder emits
  // indexed geometry for quads (logo, buttons, widgets all go through rpDrawIndexed).
  const _maybeTexDrawDiag = (state, drawKind) => {
    if (_texDrawDbgN >= 8 || !state.pipeline || !state.pipeline.spec) return;
    const vsId = state.pipeline.spec.vertexShader || "";
    const fam = shaderName(vsId);
    if (!/^(position_tex|gui_textured|text|position_tex_color|gui_text)$/.test(fam)) return;
    _texDrawDbgN++;
    const vf = state.pipeline.spec.vertexFormats && state.pipeline.spec.vertexFormats[0];
    const vb = state.vertexBuffers[0];
    let vbytes = "no vb0";
    if (vb && vb._handle) {
      const be = objects.get(vb._handle);
      if (be && be._shadow) {
        const base = vb.offset;
        const n = Math.min(64, be._shadow.length - base);
        const f32 = new Float32Array(be._shadow.buffer, base, Math.floor(n / 4));
        vbytes = JSON.stringify({off: vb.offset, sz: vb.size, f: Array.from(f32)});
      } else { vbytes = "vb0#" + vb._handle + " noshadow"; }
    }
    let ibytes = "no ib";
    if (state.indexBuffer && state.indexBuffer._handle) {
      const be = objects.get(state.indexBuffer._handle);
      if (be && be._shadow) {
        const u = state.indexBuffer.format === "uint16" ? new Uint16Array(be._shadow.buffer, 0, Math.min(12, be._shadow.length >> 1)) : new Uint32Array(be._shadow.buffer, 0, Math.min(12, be._shadow.length >> 2));
        ibytes = JSON.stringify({fmt: state.indexBuffer.format, idx: Array.from(u)});
      }
    }
    const grabMat = (uname) => {
      const u = state.resources.get(uname);
      if (!(u && u.kind === "uniform")) return "not-bound";
      const be = objects.get(u.bufferHandle);
      if (!(be && be._shadow)) return "noshadow";
      return Array.from(new Float32Array(be._shadow.buffer, u.offset, 16));
    };
    const sampled = [];
    for (const [nm, r] of state.resources) if (r && r.kind === "texture" && r._texEntry) sampled.push(nm + "=" + (r._texEntry._label || "?"));
    const layout = vf ? vf.elements.map((e) => e.name + "@" + e.offset + ":" + e.format) : "no-vf";
    console.log("[TEX-DRAW-DIAG #" + _texDrawDbgN + "] " + drawKind + " fam=" + fam + " tgt=" + state._targetLabel + " " + state._targetWH + " h=" + state.height
      + " | sampled=" + JSON.stringify(sampled)
      + " | Proj=" + JSON.stringify(grabMat("Projection"))
      + " | MV=" + JSON.stringify(grabMat("DynamicTransforms"))
      + " | layout=" + JSON.stringify(layout)
      + " | vb0=" + vbytes + " | ib=" + ibytes);
  };
  const _decodeGuiDraw = (state, kind, p) => {
  try {
    if (!state.pipeline || !state.pipeline.spec) return;
    const fam = shaderName(state.pipeline.spec.vertexShader);
    const isFontDraw = fam === "text" || /(?:^|[/_])text(?:$|[/_])/.test(state.pipeline.spec.label || "");
    const isItemAtlasDraw = /^UI items atlas(?:\s|$)/.test(state._targetLabel || "");
    const drawRing = isItemAtlasDraw ? _itemAtlasDrawRing : (isFontDraw ? _fontDrawRing : _guiDrawRing);
    const ringLimit = isItemAtlasDraw ? 160 : (isFontDraw ? 40 : 12);
    if (drawRing.length >= ringLimit) return;
    if (!isItemAtlasDraw && !/position_tex_color|position_tex|^text$|^gui$|gui_text/.test(fam)) return;
    const vf = state.pipeline.spec.vertexFormats && state.pipeline.spec.vertexFormats[0];
    const vb = state.vertexBuffers[0];
    if (!vb || !vb._handle) return;
    const be = objects.get(vb._handle);
    if (!be || !be._shadow) return;
    const stride = vf ? vf.stride : 32;
    const elOff = (n, d) => vf ? ((vf.elements.find((e) => e.name === n) || {}).offset ?? d) : d;
    const posOff = elOff("Position", 0), uvOff = elOff("UV0", 12), colOff = elOff("Color", 20);
    const dv = new DataView(be._shadow.buffer, be._shadow.byteOffset || 0);
    const readVert = (v) => {
      const base = vb.offset + v * stride;
      if (base < 0 || base + colOff + 4 > be._shadow.length) return null;
      return {
        pos: [dv.getFloat32(base + posOff, true), dv.getFloat32(base + posOff + 4, true), dv.getFloat32(base + posOff + 8, true)],
        uv: [dv.getFloat32(base + uvOff, true), dv.getFloat32(base + uvOff + 4, true)],
        col: [dv.getUint8(base + colOff), dv.getUint8(base + colOff + 1), dv.getUint8(base + colOff + 2), dv.getUint8(base + colOff + 3)]
      };
    };
    let idxs = null;
    const ib = state.indexBuffer;
    if (ib && ib._handle) {
      const ibe = objects.get(ib._handle);
      if (ibe && ibe._shadow) {
        const idv = new DataView(ibe._shadow.buffer, ibe._shadow.byteOffset || 0);
        const w = ib.format === "uint16" ? 2 : 4;
        idxs = [];
        for (let k = 0; k < Math.min(p.indexCount || 0, 6); k++) {
          const bo = (p.firstIndex + k) * w;
          idxs.push(w === 2 ? idv.getUint16(bo, true) : idv.getUint32(bo, true));
        }
      }
    }
    const verts = [];
    const n = idxs ? idxs.length : Math.min(p.vertexCount || 0, 6);
    for (let k = 0; k < n; k++) {
      const v = (p.baseVertex || 0) + (idxs ? idxs[k] : (p.firstVertex || 0) + k);
      verts.push(readVert(v));
    }
    const grab = (u) => {
      const r = state.resources.get(u);
      if (!(r && r.kind === "uniform")) return null;
      const b = objects.get(r.bufferHandle);
      if (!(b && b._shadow)) return null;
      const byteOffset = (b._shadow.byteOffset || 0) + r.offset;
      const available = Math.max(0, b._shadow.byteLength - r.offset);
      return Array.from(new Float32Array(b._shadow.buffer, byteOffset, Math.min(32, available >> 2)));
    };
    const sampled = []; for (const [nm, r] of state.resources) if (r && r.kind === "texture" && r._texEntry) sampled.push((r._texEntry._label || "?").split("/").pop());
    drawRing.push({ kind, pipe: state.pipeline.spec.label, fam, tgt: state._targetLabel, topo: state.pipeline.spec.topology, sampled, scissor: state._scissor || null, vbOff: vb.offset, vbSize: vb.size, stride, baseVertex: p.baseVertex || 0, firstIndex: p.firstIndex || 0, indexCount: p.indexCount || 0, firstVertex: p.firstVertex, idxs, verts, DT: grab("DynamicTransforms"), P: grab("Projection") });
  } catch (_e) { /* never let a decode error skip a real draw */ }
  };
  const _noteFontDraw = (state, kind, params = null) => {
    if (!state.pipeline || !state.pipeline.spec) return;
    const label = state.pipeline.spec.label || "";
    const fam = shaderName(state.pipeline.spec.vertexShader);
    if (fam !== "text" && !/(?:^|[/_])text(?:$|[/_])/.test(label)) return;
    const sampled = [];
    for (const [name, resource] of state.resources) {
      if (resource && resource.kind === "texture" && resource._texEntry) {
        sampled.push(name + "=" + (resource._texEntry._label || "?"));
      }
    }
    const key = kind + "|" + label + "|" + sampled.join(",");
    const old = _fontPassStats.get(key);
    _fontPassStats.set(key, {
      kind,
      pipe: label,
      fam,
      tgt: state._targetLabel,
      sampled,
      params,
      vertexSlots: state.vertexBuffers.map((slot, index) => slot ? {
        index,
        handle: slot._handle,
        offset: slot.offset,
        size: slot.size,
        shadow: Boolean(objects.get(slot._handle)?._shadow)
      } : null).filter(Boolean),
      index: state.indexBuffer ? {
        handle: state.indexBuffer._handle,
        format: state.indexBuffer.format,
        shadow: Boolean(objects.get(state.indexBuffer._handle)?._shadow)
      } : null,
      count: (old?.count || 0) + 1
    });
  };

  const ensureDummies = () => {
    if (dummyUniform) return;
    // Must be >= every uniform block the layout may reference (Mojang's Globals
    // is large); a too-small dummy makes createBindGroup throw, which aborts
    // ensureBindGroups before setBindGroup and leaves the group unbound.
    const ubSize = Math.min(device.limits?.maxUniformBufferBindingSize || 65536, 65536);
    dummyUniform = device.createBuffer({label: "mcweb-dummy-uniform", size: ubSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    dummyStorage = device.createBuffer({label: "mcweb-dummy-storage", size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    dummySampler = device.createSampler({magFilter: "linear", minFilter: "linear"});
    const t = device.createTexture({label: "mcweb-dummy-tex", size: [1, 1, 1],
      format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    dummyTexView = t.createView();
    const depth = device.createTexture({label: "mcweb-dummy-depth", size: [1, 1, 1],
      format: "depth32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT});
    dummyDepthView = depth.createView();
  };
  // Created on first use: a nearest sampler for non-filtering slots, and
  // dummy views for cube and integer texture slots.
  let _slotDummies = null;
  const slotDummies = () => {
    if (_slotDummies) return _slotDummies;
    const tex = (format, layers) => device.createTexture({label: `mcweb-dummy-${format}-${layers}`,
      size: [1, 1, layers], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    _slotDummies = {
      nearest: device.createSampler({label: "mcweb-nearest", magFilter: "nearest", minFilter: "nearest"}),
      cube: tex("rgba8unorm", 6).createView({dimension: "cube"}),
      sint: tex("rgba8sint", 1).createView(),
      uint: tex("rgba8uint", 1).createView()
    };
    return _slotDummies;
  };
  // A stand-in view for a texture slot of this kind (samplerKinds entry).
  const slotDummyView = (kind) => {
    if (kind.viewDimension === "cube") return slotDummies().cube;
    if (kind.sampleType === "sint") return slotDummies().sint;
    if (kind.sampleType === "uint") return slotDummies().uint;
    return kind.nonFiltering || kind.sampleType === "depth" ? dummyDepthView : dummyTexView;
  };
  const dummyFor = (entry) => {
    if (entry.buffer) return {resource: {buffer: dummyUniform}};
    if (entry.sampler) return {resource: dummySampler};
    // sampled texture OR storage texture (storageTexture) → a texture view
    return {resource: dummyTexView};
  };

  // Bind groups are cached for the lifetime of the device, not the render pass.
  // The signature below names every resource a group binds by *handle*, and
  // handles come from a monotonic counter that never reuses a number, so an
  // entry can only ever describe the resources it was built from. A per-pass
  // Map looked equivalent but was not: this port issues ~84 render passes per
  // frame on a real server, so every pass started with an empty cache and
  // re-created every group it bound — measured at 9.0% of frame time on
  // hoplite.gg, 3.4% of it inside createBindGroup itself.
  //
  // Keyed by pipeline as well as by signature: two pipelines can want the same
  // resources under incompatible layouts, and getBindGroupLayout(ng) is a
  // property of the pipeline. (The per-pass `boundGroups` early-out stays as
  // it is — setPipeline already clears it.)
  const _bindGroupCache = new Map();
  const _bindGroupDependencies = new Map();
  let _bindGroupDependents = new WeakMap();
  const _retiredBindGroupResources = new WeakSet();
  const _bindGroupStats = {hit: 0, miss: 0, clears: 0, evictions: 0};
  const forgetBindGroup = (signature) => {
    if (!_bindGroupCache.delete(signature)) return false;
    const dependencies = _bindGroupDependencies.get(signature) || [];
    _bindGroupDependencies.delete(signature);
    for (const resource of dependencies) {
      const keys = _bindGroupDependents.get(resource);
      keys?.delete(signature);
      if (!keys?.size) _bindGroupDependents.delete(resource);
    }
    _bindGroupStats.evictions++;
    return true;
  };
  const evictResourceBindGroups = (resource) => {
    if (!resource) return;
    _retiredBindGroupResources.add(resource);
    const keys = _bindGroupDependents.get(resource);
    if (keys) for (const signature of keys) forgetBindGroup(signature);
  };
  const evictPipelineBindGroups = (entry) => {
    evictResourceBindGroups(entry.pipeline);
    for (const pipeline of entry.byDepth?.values() || []) evictResourceBindGroups(pipeline);
    for (const variant of entry.variants?.values() || []) evictResourceBindGroups(variant?.pipeline);
    for (const variant of entry.stages?.unfilterable?.values() || []) evictResourceBindGroups(variant?.pipeline);
  };
  const rememberBindGroup = (signature, dependencies) => {
    const resources = [...new Set(dependencies.filter(Boolean))];
    // An open pass can still hold a resource whose public handle was closed.
    // Let that pass finish, but never renew device-cache ownership of it.
    if (resources.some(resource => _retiredBindGroupResources.has(resource))) return false;
    _bindGroupDependencies.set(signature, resources);
    for (const resource of resources) {
      let keys = _bindGroupDependents.get(resource);
      if (!keys) _bindGroupDependents.set(resource, keys = new Set());
      keys.add(signature);
    }
    return true;
  };
  const _pipelineIds = new WeakMap();
  let _pipelineIdSeq = 0;
  const pipelineId = (pipeline) => {
    let id = _pipelineIds.get(pipeline);
    if (id === undefined) {
      id = ++_pipelineIdSeq;
      _pipelineIds.set(pipeline, id);
    }
    return id;
  };
  // Invalidate only signatures that own a closing native resource. Reverse
  // dependencies are built on cache misses, not ordinary draw/cache hits.
  // Keep a capacity cap as well —
  // but well above the live working set, which is larger than it looks: under
  // a static layout a UBO ring cycles 256 slot offsets and each offset is its
  // own signature, so a handful of pipelines reach several thousand entries.
  // (A dynamic-offset layout keys on buffer and range size, not offset.) At
  // 8192 the cache cleared 8 times in a 24 s window and re-created what it
  // had just evicted.
  const BIND_GROUP_CACHE_LIMIT = 32768;
  // Bisect control, matching mcweb_mesh_pace / mcweb_uncapped: `pass` restores
  // the old per-render-pass cache lifetime for an A/B against this one.
  const _bindGroupCacheScope =
    new URLSearchParams(location.search).get("mcweb_bindgroup_cache") === "pass"
      ? "pass" : "device";

  // Formats a filtering slot cannot take: depth, and 32-bit float without
  // the optional float32-filterable feature.
  const unfilterableFormat = (format) => /^(depth|stencil)/.test(format || "")
    || (/32float$/.test(format || "") && !device.features?.has?.("float32-filterable"));
  // A texture the shaders filter gets a filtering slot (shader-glue.js
  // layoutEntries); a texture they only load from is unfilterable already.
  // Whether a filtered slot will hold a depth or 32-bit float texture only
  // shows when the game binds one (26.3's depth copy samples the depth
  // attachment with texture()). Such a draw switches to a variant of the
  // pipeline in which those slots are unfilterable with a nearest sampler:
  // the same shader modules, built once per set of slots and depth format.
  const adaptSampleTypes = (state, boundTex, samplerBases) => {
    const kinds = state.pipeline.samplerKinds;
    let names = null;
    for (const [name, texture] of boundTex) {
      const kind = kinds.get(name);
      if (texture && kind && kind.sampleType === "float" && unfilterableFormat(texture.format)) {
        (names ||= []).push(name);
      }
    }
    if (!names) return;
    const {spec, stages, groupRemap, depthFormat} = state.pipeline;
    const variants = (stages.unfilterable ||= new Map());
    const key = `${depthFormat}|${names.join(",")}`;
    let variant = variants.get(key);
    if (variant === undefined) {
      variant = null;
      const samplerKinds = new Map(kinds);
      const entries = stages.entries.map((group) => group.map((e) => ({...e})));
      (spec.bindGroups || []).forEach((group, gi) => group.samplers.forEach((name, si) => {
        if (!names.includes(name)) return;
        const at = groupRemap[gi].ng;
        const base = samplerBases[gi] + si * 2;
        for (const e of entries[at]) {
          if (e.binding === base) e.sampler = {type: "non-filtering"};
          if (e.binding === base + 1) e.texture = {...e.texture, sampleType: "unfilterable-float"};
        }
        samplerKinds.set(name, {...kinds.get(name), nonFiltering: true, sampleType: "unfilterable-float"});
      }));
      try {
        const built = buildPipeline(spec, depthFormat, {...stages, entries, samplerKinds, pipelineErrors: []});
        variant = {pipeline: built.pipeline, samplerKinds};
        recordStage(`unfilterable-variant-ok:${spec.label}:${names.join(",")}`);
      } catch (error) {
        recordStage(`unfilterable-variant-failed:${spec.label}:${error.message}`);
      }
      variants.set(key, variant);
    }
    if (!variant) return;
    state.pipeline = {...state.pipeline, pipeline: variant.pipeline, samplerKinds: variant.samplerKinds};
    state.pass.setPipeline(variant.pipeline);
    state.boundGroups = [];
  };

  // createBindGroup snapshots its WebIDL descriptors. Reuse the dictionaries
  // within a pass instead of allocating them again on every cache hit.
  const setObjectBinding = (scratch, index, binding, resource) => {
    const entry = scratch.entries[index] ||= {binding, resource: null};
    entry.binding = binding;
    entry.resource = resource;
    if (scratch.buffers[index]) scratch.buffers[index].buffer = null;
  };
  const setBufferBinding = (scratch, index, binding, buffer, offset, size) => {
    const entry = scratch.entries[index] ||= {binding, resource: null};
    const resource = scratch.buffers[index] ||= {buffer: null, offset: undefined, size: undefined};
    resource.buffer = buffer;
    resource.offset = offset;
    resource.size = size;
    entry.binding = binding;
    entry.resource = resource;
  };

  // What remains of this function's cost is building the per-draw signature
  // string, ~5% of frame time at ~525 draws/frame. An early-out keyed on "did
  // any binding actually change since the last draw" was tried and measured no
  // difference (4.67% -> 4.99%): Minecraft sets a uniform offset from its UBO
  // ring on essentially every draw, so the early-out never fires. The cost is
  // Minecraft's rebinding rate, not bookkeeping here. Under a dynamic-offset
  // layout (buildPipeline) the ring offset is no longer part of the bind
  // group: the group is reused and only setBindGroup's offsets change, so a
  // group whose signature matches is still rebound when an offset differs
  // from the one this pass last set.
  const ensureBindGroups = (state) => {
    ensureDummies();
    const spec = state.pipeline.spec;
    const groups = spec.bindGroups || [];
    const groupRemap = state.pipeline.groupRemap || groups.map((g, i) => ({ng: i, baseU: 0, baseS: 0}));
    const groupCount = state.pipeline.groupCount || groups.length;
    // Per-original-group sampler binding base (samplers laid after the group's
    // uniforms; see buildPipeline). Fallback recomputes the same offset if the
    // pipeline predates the field.
    const samplerBases = state.pipeline.samplerBases || groups.map((g, gi) => {
      let nu = 0; groups.forEach((gg, ggi) => { if (groupRemap[ggi].ng === groupRemap[gi].ng) nu += gg.uniforms.length; });
      return Math.max(groupRemap[gi].baseS, nu);
    });
    // Drive binding from the SPEC + remap (the authoritative set of bindings —
    // the same data that built the pipeline layout and the WGSL). We do NOT rely
    // on getBindGroupLayout(n).entries, which is empty/unavailable on some
    // Chromium builds and previously caused every group to be skipped → "No bind
    // group at group index 0" validation → Mojang's Java throws → pump dies.
    // For each merged group we emit EVERY binding the layout expects; a slot
    // whose real resource isn't bound yet gets a type-matched dummy so the group
    // is always complete and ALWAYS bound.
    // Texture binds Mojang issued this draw that did NOT match any spec sampler
    // name — used as a positional fallback (bind order → sampler-slot order) so
    // textured draws sample the real atlas even when the bind name differs from
    // the spec's sampler name (which would otherwise yield the black dummy).
    const matchedTex = new Set();
    for (const g of groups) for (const s of g.samplers) {
      const b = state.resources.get(s);
      if (b && b.kind === "texture") matchedTex.add(b);
    }
    const unmatchedTex = state.drawTexBinds.filter((t) => !matchedTex.has(t));
    let unmatchedCursor = 0;
    // Each sampler's texture, resolved before any slot is filled so the slot
    // kinds can follow what is bound (adaptSampleTypes).
    const boundTex = new Map();
    for (const group of groups) for (const samplerName of group.samplers) {
      let bound = state.resources.get(samplerName);
      if (!(bound && bound.kind === "texture") && unmatchedCursor < unmatchedTex.length) {
        // Name miss → fall back to the next bind-order texture that no spec
        // sampler claimed by name.
        bound = unmatchedTex[unmatchedCursor++];
        if (!buildPipeline._loggedTexFallback) {
          buildPipeline._loggedTexFallback = new Set();
        }
        const fk = `${spec.label}|${samplerName}`;
        if (!buildPipeline._loggedTexFallback.has(fk)) {
          buildPipeline._loggedTexFallback.add(fk);
          console.warn(`[tex-fallback] ${spec.label}: sampler "${samplerName}" not in resources by name; used positional bind (drawTexBinds). Bind names this draw may differ from spec sampler names.`);
        }
      }
      boundTex.set(samplerName, bound && bound.kind === "texture" ? bound : null);
    }
    adaptSampleTypes(state, boundTex, samplerBases);
    const layout = state.pipeline.pipeline;
    const {layouts, dynamic} = pipelineBindGroupLayouts.get(layout);
    // What each sampler slot takes (shader-glue.js layoutEntries, errorStages,
    // or adaptSampleTypes): every pipeline carries it.
    const samplerKinds = state.pipeline.samplerKinds;
    for (let ng = 0; ng < groupCount; ng++) {
      const scratch = ((state.bindGroupScratch ||= [])[ng] ||= {entries: [], buffers: []});
      const entries = scratch.entries;
      let entryIndex = 0;
      const signatureParts = [];
      let hasAny = false;
      groups.forEach((group, gi) => {
        const r = groupRemap[gi];
        if (r.ng !== ng) return;
        group.uniforms.forEach((uniformDesc, ui) => {
          hasAny = true;
          const binding = r.baseU + ui;
          const bound = state.resources.get(uniformDesc.name);
          const at = dynamic ? dynamic.slot[ng][binding] ?? -1 : -1;
          if (bound && bound.kind === "uniform") {
            _markUse(state, bound.buffer);
            // WebGPU enforces the std140 rule that a uniform struct's bound
            // range be >= its shader-declared size (padded to a multiple of
            // the struct's base alignment: 16 with a mat4). Mojang's
            // Std140SizeCalculator returns AND allocates at the UN-rounded
            // size (SpriteAnimationInfo slice = 140 vs the 144 the shader
            // needs; Globals buffer = 56 vs 64). So:
            //   * a slice too small for the shader  -> "bound with size 140
            //     ... too small ... requires 144" (atlas blits dropped);
            //   * rounding the range to 16 overruns the un-rounded BUFFER
            //     (Globals 56->64 > 56) -> createBindGroup fails -> the whole
            //     submit cascades as "Invalid BindGroup ... invalid due to a
            //     previous error" and the screen goes black.
            // The one boundary that is ALWAYS safe is the per-slot packing
            // stride: Mojang lays UBO slots out at
            // roundToward(size, minUniformOffsetAlignment=256), so every slot
            // (and, for the last, the run to the buffer end) has >=256 B of
            // room, which always covers the WGSL-aligned struct (<=144) and
            // never reads past real data (std140 member offsets are < the
            // un-rounded size). Round the bound range up to 256, capped at the
            // buffer so we can never exceed it.
            const ubound = Math.min((bound.size + 255) & ~255, bound.bufferSize - bound.offset);
            if (at >= 0) {
              // The same range at offset 0; the draw's offset goes to
              // setBindGroup, and offset + range stays within the buffer.
              dynamic.offsets[at] = bound.offset;
              setBufferBinding(scratch, entryIndex++, binding, bound.buffer, 0, ubound);
              signatureParts.push(`${binding}:U:${bound.bufferHandle}:${ubound}`);
            } else {
              setBufferBinding(scratch, entryIndex++, binding, bound.buffer, bound.offset, ubound);
              signatureParts.push(`${binding}:u:${bound.bufferHandle}:${bound.offset}:${ubound}`);
            }
          } else {
            if (at >= 0) dynamic.offsets[at] = 0;
            const dummy = uniformDesc.type === "TEXEL_BUFFER" ? dummyStorage : dummyUniform;
            setBufferBinding(scratch, entryIndex++, binding, dummy, undefined, undefined);
            signatureParts.push(`${binding}:${uniformDesc.type === "TEXEL_BUFFER" ? "sD" : "uD"}`);
          }
        });
        group.samplers.forEach((samplerName, si) => {
          hasAny = true;
          const base = samplerBases[gi] + si * 2;
          const bound = boundTex.get(samplerName);
          // An unfilterable slot takes only a non-filtering sampler; and a
          // missing texture needs a dummy of the slot's kind.
          const kind = samplerKinds.get(samplerName) || {nonFiltering: false, sampleType: "float", viewDimension: "2d"};
          const real = !!bound;
          const nearest = kind.nonFiltering ? slotDummies().nearest : null;
          setObjectBinding(scratch, entryIndex++, base, nearest || (real ? bound.sampler : dummySampler));
          setObjectBinding(scratch, entryIndex++, base + 1, real ? bound.view : slotDummyView(kind));
          signatureParts.push(nearest ? `${base}:sN` : real ? `${base}:s:${bound.samplerHandle}` : `${base}:sD`,
            real ? `${base + 1}:t:${bound.viewHandle}` : `${base + 1}:tD`);
          if (real) _markUse(state, bound._texEntry?.texture);
          if (_textureHistoryCaptured && real && bound._texEntry) { _sampledThisFrame.add(bound._texEntry); _sampledEntries.add(bound._texEntry); } // DIAG
        });
      });
      entries.length = entryIndex;
      scratch.buffers.length = entryIndex;
      if (!hasAny) continue; // genuinely empty group (e.g. a globals-only remap target with nothing) → no layout entry → nothing to bind
      const signature = `${pipelineId(layout)}|${ng}|${signatureParts.join(",")}`;
      const dynamicStart = dynamic ? dynamic.start[ng] : 0;
      const dynamicCount = dynamic ? dynamic.count[ng] : 0;
      let offsetsChanged = false;
      if (dynamicCount) {
        // What this pass last handed setBindGroup, at the same positions:
        // every pipeline's total is within the device limit.
        const last = (state.boundOffsets ||=
          new Uint32Array(device.limits.maxDynamicUniformBuffersPerPipelineLayout));
        for (let i = dynamicStart, end = dynamicStart + dynamicCount; i < end; i++) {
          if (last[i] !== dynamic.offsets[i]) {
            last[i] = dynamic.offsets[i];
            offsetsChanged = true;
          }
        }
      }
      if (!offsetsChanged && state.boundGroups[ng] === signature) continue;
      const cache = _bindGroupCacheScope === "pass"
        ? (state.bindGroupCache ||= new Map()) : _bindGroupCache;
      let bindGroup = cache.get(signature);
      if (!bindGroup) {
        _bindGroupStats.miss++;
        bindGroup = device.createBindGroup({
          label: `${spec.label}:bind${ng}`,
          layout: layouts[ng],
          entries
        });
        if (cache.size >= BIND_GROUP_CACHE_LIMIT) {
          cache.clear();
          if (cache === _bindGroupCache) {
            _bindGroupDependencies.clear();
            _bindGroupDependents = new WeakMap();
          }
          _bindGroupStats.clears++;
        }
        if (cache === _bindGroupCache) {
          const dependencies = [layout, ...entries.map(entry => entry.resource.buffer || entry.resource)];
          groups.forEach((group, gi) => {
            if (groupRemap[gi].ng !== ng) return;
            for (const name of group.samplers) dependencies.push(boundTex.get(name)?._texEntry?.texture);
          });
          if (rememberBindGroup(signature, dependencies)) cache.set(signature, bindGroup);
        } else {
          cache.set(signature, bindGroup);
        }
      } else {
        _bindGroupStats.hit++;
      }
      if (dynamicCount) state.pass.setBindGroup(ng, bindGroup, dynamic.offsets, dynamicStart, dynamicCount);
      else state.pass.setBindGroup(ng, bindGroup);
      state.boundGroups[ng] = signature;
    }
  };

  // Largest buffer that gets a diagnostic CPU mirror; see createBuffer.
  const SHADOW_LIMIT = 8 * 1024 * 1024;

  // DIAG: terrain draws. Sections are drawn out of the shared 128 MiB
  // "UberBuffer" allocations, so a draw whose slot-0 vertex buffer is that
  // large is chunk geometry. Terrain currently compiles renderable meshes
  // (visRenderable > 0) and issues indexed draws with no WebGPU validation
  // error, yet nothing appears — so the question is whether the draw
  // parameters and buffer bindings addressing that shared buffer are sane.
  // Queryable via globalThis.mcWebGpu._terrainDraws.
  // A census keyed by pipeline label: how many draws each pipeline issued, how
  // many were dropped because no pipeline was bound, and the largest slot-0
  // vertex buffer it drew from. Chunk geometry lives in the 128 MiB
  // "UberBuffer" allocations, so a terrain pipeline should show a maxVb in that
  // range; a terrain label that never appears at all means its draws are being
  // dropped upstream, which is silent in both the Java and JS layers.
  // Bytes reaching each buffer, by label. Terrain geometry lands in the
  // "UberBuffer *" allocations; if those show zero bytes in, the sections are
  // meshed and drawn but the GPU buffer is still empty, which is silent (no
  // validation error, correct-looking draw parameters, nothing on screen).
  // Uniform-buffer content probes (?mcweb_gpu_probe=1).
  //
  // Small uniform buffers are created UNIFORM|COPY_DST with no COPY_SRC, so a
  // copyBufferToBuffer readback of them is invalid and silently yields zeros —
  // which reads exactly like "the uniform is zero". Recording what is written
  // is the only way to see the value the shader sees, and the atlas and
  // AutoStorageIndexBuffer investigations both needed it.
  //
  // It must not be on by default. Every UBO slot is <= 256 B, so the "watched"
  // branch fired on essentially every uniform upload and cost a slice plus two
  // typed-array materializations plus a rounding map — on the hot path of a
  // frame that already uploads ~500 KB.
  const _gpuProbe = new URLSearchParams(location.search).has("mcweb_gpu_probe");
  const noteUniformProbe = (entry, handle, destinationOffset, bytes, byteLength) => {
    if (!entry) return;
    if (/Auto Storage/i.test(entry._label || "")) {
      const record = (globalThis.mcWebGpu._autoIndexWrites ||= {
        writeBuffer: 0, bytes: 0, copies: 0, handles: {}
      });
      record.writeBuffer++;
      record.bytes += byteLength;
      // Keyed by handle, not label: AutoStorageIndexBuffer grows by creating a
      // NEW buffer, so "the label was written" can be true while the instance
      // the draw binds was never touched.
      const key = String(handle);
      record.handles[key] = (record.handles[key] || 0) + 1;
    }
    if (entry.size <= 256) {
      const copy = bytes.slice(0, Math.min(64, bytes.length));
      const record = {
        offset: destinationOffset,
        floats: Array.from(new Float32Array(copy.buffer, 0, copy.byteLength >> 2))
          .map((x) => Math.round(x * 10000) / 10000),
        ints: Array.from(new Int32Array(copy.buffer, 0, copy.byteLength >> 2))
      };
      const key = (entry._label || "?") + "#" + handle;
      (globalThis.mcWebGpu._smallBufferWrites ||= {})[key] = record;
      // Keep the first few writes as well as the last. "Never written
      // correctly" and "written correctly then clobbered" need opposite
      // fixes, and only the last write was being retained.
      const history = (globalThis.mcWebGpu._smallBufferWriteHistory ||= {});
      const list = (history[key] ||= []);
      if (list.length < 6) list.push(record);
      record.seq = (history[key + "#count"] = (history[key + "#count"] || 0) + 1);
    }
  };

  const _noteBytes = (entry, kind, bytes) => {
    if (!entry || !(bytes > 0)) return;
    const io = (globalThis.mcWebGpu._bufferIo ||= {});
    const row = (io[entry._label ?? "<unlabelled>"] ||= {write: 0, copy: 0, size: entry.size});
    row[kind] += bytes;
  };

  // Bounded evidence for the real vanilla cloud path. The cloud vertex shader
  // has no vertex buffer: each indexed draw expands three CloudFaces bytes
  // per quad and combines CloudInfo with the regular Projection / transform
  // UBOs. A draw count alone therefore cannot distinguish real cloud geometry
  // from an empty or mis-bound storage buffer. Capture one small, serialisable
  // sample while continuing to count every attempted/executed draw.
  const _uniformFloatSample = (state, name, count) => {
    const bound = state.resources.get(name);
    if (bound?.kind !== "uniform") return null;
    const entry = objects.get(bound.bufferHandle);
    const shadow = entry?._shadow;
    if (!shadow) return null;
    const byteLength = Math.min(bound.size, count * 4,
      Math.max(0, shadow.byteLength - bound.offset));
    if (byteLength < 4) return null;
    const view = new DataView(shadow.buffer,
      (shadow.byteOffset || 0) + bound.offset, byteLength);
    return Array.from({length: Math.floor(byteLength / 4)},
      (_, index) => view.getFloat32(index * 4, true));
  };

  const _cloudFacesSample = (state, indexCount) => {
    const bound = state.resources.get("CloudFaces");
    if (bound?.kind !== "uniform") return null;
    const entry = objects.get(bound.bufferHandle);
    const shadow = entry?._shadow;
    if (!shadow) {
      return {
        label: entry?._label ?? null,
        bufferSize: entry?.size ?? null,
        boundOffset: bound.offset,
        boundSize: bound.size,
        shadowed: false
      };
    }
    const boundBytes = Math.min(bound.size,
      Math.max(0, shadow.byteLength - bound.offset));
    // Six indices address four vertices for each quad; R8_SINT consumes exactly
    // three signed bytes. Report those logical texels, not the host's padded
    // u32 storage words, so the sample proves the shader-visible data.
    const requiredValues = Math.ceil(Math.max(0, indexCount) / 6) * 3;
    const scannedValues = Math.min(requiredValues, boundBytes);
    const view = new Uint8Array(shadow.buffer,
      (shadow.byteOffset || 0) + bound.offset, scannedValues);
    const firstValues = [];
    let nonzeroValues = 0;
    for (let index = 0; index < scannedValues; index++) {
      const byte = view[index];
      const value = byte < 128 ? byte : byte - 256;
      if (value !== 0) nonzeroValues++;
      if (index < 24) firstValues.push(value);
    }
    return {
      label: entry?._label ?? null,
      bufferSize: entry?.size ?? null,
      boundOffset: bound.offset,
      boundSize: bound.size,
      shadowed: true,
      format: "R8_SINT",
      requiredValues,
      scannedValues,
      nonzeroValues,
      firstValues
    };
  };

  const _isCloudPipelineLabel = (label) =>
    /(?:pipeline\/(?:flat_)?clouds|rendertype_clouds)/i.test(label);

  const _noteCloudDraw = (state, params, executed) => {
    const label = state.pipeline?.spec?.label ?? "";
    if (!_isCloudPipelineLabel(label)) return;
    const report = (globalThis.mcWebGpu._cloudDraws ||= {
      attemptedDraws: 0,
      executedDraws: 0,
      suppressedDraws: 0,
      totalIndices: 0,
      maxIndexCount: 0,
      firstTick: null,
      lastTick: null,
      sample: null
    });
    report.attemptedDraws++;
    if (executed) {
      report.executedDraws++;
      report.totalIndices += params.indexCount;
      report.maxIndexCount = Math.max(report.maxIndexCount, params.indexCount);
    } else {
      report.suppressedDraws++;
    }
    const tick = globalThis.mcWebPump?.ticks ?? 0;
    if (report.firstTick === null) report.firstTick = tick;
    report.lastTick = tick;
    if (executed && !report.sample) {
      report.sample = {
        pipeline: label,
        target: state._targetLabel,
        targetWH: state._targetWH,
        depthFormat: state.depthFormat,
        topology: state.pipeline?.spec?.topology ?? null,
        cull: state.pipeline?.spec?.cull ?? null,
        indexCount: params.indexCount,
        instanceCount: params.instanceCount,
        cloudFaces: _cloudFacesSample(state, params.indexCount),
        cloudInfo: _uniformFloatSample(state, "CloudInfo", 11),
        dynamicTransforms: _uniformFloatSample(state, "DynamicTransforms", 16),
        projection: _uniformFloatSample(state, "Projection", 16),
        fog: _uniformFloatSample(state, "Fog", 10)
      };
    }
  };

  const _noteDraw = (state, kind, params) => {
    const census = (globalThis.mcWebGpu._drawCensus ||= {});
    const label = state.pipeline?.spec?.label ?? "<no-pipeline>";
    const row = (census[label] ||= {draws: 0, maxVb: 0, kinds: {}, sample: null,
                                    firstTick: null, lastTick: null});
    row.draws++;
    // Frame numbers bracket the activity. A pipeline whose draws stop early
    // while the Java side still reports visible, renderable sections means the
    // geometry is being dropped between LevelRenderer and the render pass.
    const tick = globalThis.mcWebPump?.ticks ?? 0;
    if (row.firstTick === null) row.firstTick = tick;
    row.lastTick = tick;
    row.kinds[kind] = (row.kinds[kind] || 0) + 1;
    const slot0 = state.vertexBuffers[0];
    const vb = slot0 ? objects.get(slot0._handle) : null;
    if (vb && vb.size > row.maxVb) {
      row.maxVb = vb.size;
      row.vbLabel = vb._label;
    }
    // Which textures this pipeline samples, and whether they ever received
    // pixel data. Terrain that draws thousands of valid triangles but shows
    // nothing is equally consistent with an atlas that uploaded blank.
    if (!row.textures && state.resources && state.resources.size) {
      row.textures = [];
      for (const [name, rec] of state.resources) {
        if (rec?.kind !== "texture") continue;
        const te = rec._texEntry;
        row.textures.push({
          bound: name,
          handle: rec.viewHandle,
          texHandle: te?._hid ?? null,
          label: te?._label ?? null,
          wh: te ? `${te.width}x${te.height}` : null,
          uploads: te?._uploads ?? 0
        });
      }
    }
    if (!row.sample && vb && vb.size > SHADOW_LIMIT) {
      const ib = state.indexBuffer ? objects.get(state.indexBuffer._handle) : null;
      row.sample = {
        ...params,
        vbOffset: slot0.offset, vbSize: slot0.size, vbTotal: vb.size,
        ibLabel: ib?._label ?? null, ibTotal: ib?.size ?? null,
        ibFormat: state.indexBuffer?.format ?? null
      };
    }
  };

  const applyIndexBuffer = (state, buffer, format) => {
    if (state.boundIndexBuffer !== buffer || state.boundIndexFormat !== format) {
      state.pass.setIndexBuffer(buffer, format);
      state.boundIndexBuffer = buffer;
      state.boundIndexFormat = format;
    }
  };

  const applyVertexAndIndex = (state) => {
    const formats = state.pipeline.spec.vertexFormats;
    for (let slot = 0; slot < (formats?.length || 0); slot++) {
      const bound = state.vertexBuffers[slot];
      if (bound) {
        const previous = state.boundVertexBuffers[slot];
        if (!previous || previous.buffer !== bound.buffer
            || previous.offset !== bound.offset || previous.size !== bound.size) {
          state.pass.setVertexBuffer(slot, bound.buffer, bound.offset, bound.size);
          // rpSetVertexBuffer replaces binding records rather than mutating them.
          state.boundVertexBuffers[slot] = bound;
        }
        _markUse(state, bound.buffer);
      }
    }
    if (state.indexBuffer) {
      applyIndexBuffer(state, state.indexBuffer.buffer, state.indexBuffer.format);
      _markUse(state, state.indexBuffer.buffer);
    }
  };

  const needsLowering = (state) => {
    const topology = state.pipeline.spec.topology;
    return topology === "QUADS" || topology === "TRIANGLE_FAN";
  };

  // ---------------------------------------------------------------------------
  // On-screen frame graph (?mcweb_framegraph=1)
  // ---------------------------------------------------------------------------
  // A visual frame-time strip for live playtesting: one column per client
  // frame (height = frame ms, 16.7 ms line drawn), one row of squares for
  // server pump advances (green = tick landed, dark = pump ran without a
  // tick), and a numeric readout. Stalls read as spikes; a 2 Hz server reads
  // as a sparse green row. Opt-in so normal runs carry zero cost.
  const _frameGraph = (() => {
    const enabled = new URLSearchParams(location.search).has("mcweb_framegraph");
    if (!enabled) return {
      push() {}, pushServer() {}, reset() {},
      report() { return { error: "frame graph off; load with ?mcweb_framegraph=1" }; },
      enabled: false
    };
    const N = 240;
    // Main bars use frame-start cadence: that is what the player experiences,
    // and it exposes pauses which occur between Java callbacks (GC, browser
    // scheduling, GPU back-pressure). With VSync this is rAF-to-rAF; uncapped
    // mode uses yielding task starts. Cyan ticks retain callback execution
    // duration so a tall bar can still be attributed at a glance.
    const frames = new Float32Array(N); // rendered-frame start cadence ms
    const callbackFrames = new Float32Array(N); // Java callback duration ms
    const serverDeltas = new Uint8Array(N); // ticks advanced in this frame window
    // Server-side pump timing from the Worker (pump-stats messages): per
    // pump-call duration and the gap between pump starts. Big durations =
    // slow server ticks; big gaps with small durations = a starved Worker
    // event loop. Both read as the user-visible gameplay delay.
    const SN = 240;
    const serverDur = new Float32Array(SN);
    const serverGap = new Float32Array(SN);
    let serverHead = 0;
    let lastServerDur = 0;
    let worstServerGap = 0;
    let head = 0;
    let pendingTicks = 0;
    let lastTickCount = -1;
    let canvasEl = null;
    let labelEl = null;
    let lastDraw = 0;
    let lastFrameMs = 0;
    let lastRafGapMs = 0;
    let visibleOver33 = 0;
    let visibleOver100 = 0;
    const MAX_MS = 250; // vertical scale cap
    // The visible strip is deliberately short, but QA needs a long enough raw
    // history to catch intermittent stutters without enabling ?mcweb_perf=1.
    // That profiler wraps every host method and materially lowers FPS, whereas
    // these two opt-in typed-array writes do not change the Minecraft/host seam.
    // Retain a complete 30-second acceptance window even at Minecraft's
    // 260/unlimited setting (7,800 frames), with room for scheduling jitter.
    const HN = 12000;
    const frameHistory = new Float32Array(HN);
    const rafGapHistory = new Float32Array(HN);
    let historyHead = 0;
    let historyCount = 0;
    // When each hitch happened, not just how many there were. A stutter with a
    // regular period is a periodic *task*, and its period names the culprit —
    // a 2.0 s spacing led straight to the storage sync. Counts alone cannot
    // distinguish that from scattered jitter.
    const HITCH_MS = 33;
    const hitchTimes = [];

    /**
     * Spacing between consecutive hitches. A tight median with a small spread
     * means something periodic is running on the frame thread; `periodicity` is
     * the fraction of gaps within 25% of the median, so a caller can tell "one
     * task every 2 s" from "jitter that averages 2 s".
     */
    const hitchSpacing = () => {
      const gaps = [];
      for (let i = 1; i < hitchTimes.length; i++) gaps.push(hitchTimes[i].t - hitchTimes[i - 1].t);
      if (!gaps.length) {
        return {count: hitchTimes.length, gaps: [], medianGapMs: 0, periodicity: 0,
          events: hitchTimes.slice(0, 40)};
      }
      const sorted = [...gaps].sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      const near = gaps.filter((g) => Math.abs(g - median) <= median * 0.25).length;
      return {
        count: hitchTimes.length,
        medianGapMs: median,
        periodicity: Math.round(near / gaps.length * 100) / 100,
        gaps: gaps.slice(0, 40),
        events: hitchTimes.slice(0, 40)
      };
    };

    const historyValues = (source, positiveOnly = false) => {
      const out = [];
      const start = (historyHead - historyCount + HN) % HN;
      for (let i = 0; i < historyCount; i++) {
        const value = source[(start + i) % HN];
        if (!positiveOnly || value > 0) out.push(value);
      }
      return out;
    };

    const summary = (values) => {
      if (!values.length) return { mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
      const sorted = [...values].sort((a, b) => a - b);
      const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      const round = (value) => Math.round(value * 100) / 100;
      return {
        mean: round(values.reduce((a, b) => a + b, 0) / values.length),
        p50: round(at(0.50)),
        p95: round(at(0.95)),
        p99: round(at(0.99)),
        max: round(sorted[sorted.length - 1])
      };
    };

    const ensureDom = () => {
      if (canvasEl) return;
      canvasEl = document.createElement("canvas");
      canvasEl.width = N * 2;
      canvasEl.height = 132;
      canvasEl.style.cssText = "position:fixed;left:8px;top:8px;z-index:9999;"
        + "background:rgba(0,0,0,0.55);border:1px solid #555;pointer-events:none;";
      document.body.appendChild(canvasEl);
      labelEl = document.createElement("div");
      labelEl.style.cssText = "position:fixed;left:8px;top:144px;z-index:9999;"
        + "color:#9f9;font:11px monospace;pointer-events:none;white-space:pre;";
      document.body.appendChild(labelEl);
    };

    const draw = (nowMs) => {
      if (nowMs - lastDraw < 100) return; // 10 Hz redraw keeps cost negligible
      lastDraw = nowMs;
      ensureDom();
      const ctx = canvasEl.getContext("2d");
      const W = canvasEl.width, H = canvasEl.height;
      const graphH = 88, serverY = 94, durY = 106, gapY = 120;
      ctx.clearRect(0, 0, W, H);
      // 16.7 ms reference line (60 FPS).
      const yOf = (ms) => graphH - Math.min(ms, MAX_MS) / MAX_MS * graphH;
      ctx.strokeStyle = "#3a6";
      ctx.beginPath();
      const ref = yOf(16.7);
      ctx.moveTo(0, ref); ctx.lineTo(W, ref); ctx.stroke();
      // Frame bars.
      for (let i = 0; i < N; i++) {
        const idx = (head + i) % N;
        const ms = frames[idx];
        if (ms <= 0) continue;
        const x = i * 2;
        ctx.fillStyle = ms > 100 ? "#e44" : ms > 33 ? "#ea3" : "#5c8";
        ctx.fillRect(x, yOf(ms), 2, graphH - yOf(ms));
        const callbackMs = callbackFrames[idx];
        if (callbackMs > 0) {
          ctx.fillStyle = "#5cf";
          ctx.fillRect(x, yOf(callbackMs), 2, 1);
        }
        // Server tick advance in this frame window: green square below.
        ctx.fillStyle = serverDeltas[idx] > 0 ? "#3f6" : "#222";
        ctx.fillRect(x, serverY, 2, 8);
      }
      // Server pump durations (bars rising from durY) and gaps between pump
      // starts (bars rising from gapY): the attribution for delayed gameplay.
      for (let i = 0; i < SN; i++) {
        const idx = (serverHead + i) % SN;
        const x = i * 2;
        const d = serverDur[idx];
        if (d > 0) {
          ctx.fillStyle = d > 100 ? "#e44" : d > 33 ? "#ea3" : "#69d";
          const h = Math.max(1, 10 * Math.min(d, MAX_MS) / MAX_MS);
          ctx.fillRect(x, durY + 10 - h, 2, h);
        }
        const g = serverGap[idx];
        if (g > 0) {
          ctx.fillStyle = g > 100 ? "#e44" : g > 60 ? "#ea3" : "#244";
          const h = Math.max(1, 8 * Math.min(g, MAX_MS) / MAX_MS);
          ctx.fillRect(x, gapY + 8 - h, 2, h);
        }
      }
    };

    const refreshLabel = () => {
      const server = globalThis.mcWebServer;
      const info = server?.info?.() ?? {};
      const fpsNow = lastRafGapMs > 0
        ? Math.min(999, Math.round(1000 / lastRafGapMs)) : 0;
      labelEl.textContent =
        `frame ${globalThis.mcWebPump?.pacing?.().scheduler ?? "?"}`
        + ` ${Math.round(lastRafGapMs * 10) / 10}ms (~${fpsNow}fps)`
        + ` callback ${Math.round(lastFrameMs * 10) / 10}ms`
        + `  recent >33=${visibleOver33} >100=${visibleOver100}`
        + `  serverTick=${info.tickCount ?? "?"} inQ=${info.inboundQueued ?? "?"}`
        + `  serverPump ${lastServerDur}ms gap ${worstServerGap}ms`
        + `  state=${info.state ?? "?"}`;
    };

    return {
      enabled: true,
      push(frameMs, rafGapMs = 0) {
        // Captured before lastFrameMs is reassigned below: the gap being
        // recorded ended with THIS callback, so the callback that ran before it
        // is the one that could have overrun into it.
        const previousCallbackMs = lastFrameMs;
        const cadenceMs = rafGapMs > 0 ? rafGapMs : frameMs;
        if (frames[head] > 33) visibleOver33--;
        if (frames[head] > 100) visibleOver100--;
        frames[head] = cadenceMs;
        callbackFrames[head] = frameMs;
        if (cadenceMs > 33) visibleOver33++;
        if (cadenceMs > 100) visibleOver100++;
        lastFrameMs = frameMs;
        if (rafGapMs > 0) lastRafGapMs = rafGapMs;
        frameHistory[historyHead] = frameMs;
        rafGapHistory[historyHead] = rafGapMs;
        if (rafGapMs > HITCH_MS && hitchTimes.length < 4096) {
          // Record the callback cost alongside the gap. The two together say
          // where the hitch lives without any profiling: a gap that matches its
          // callback is Java work inside the frame, while a gap much larger
          // than its callback is time spent *between* callbacks — GC, browser
          // scheduling, or GPU back-pressure — and those have different fixes.
          // `frameMs` is the callback that ran at the END of this gap; the one
          // that preceded it is the more likely culprit, so keep both.
          hitchTimes.push({
            t: Math.round(performance.now()),
            gapMs: Math.round(rafGapMs * 10) / 10,
            callbackMs: Math.round(frameMs * 10) / 10,
            prevCallbackMs: Math.round(previousCallbackMs * 10) / 10
          });
        }
        historyHead = (historyHead + 1) % HN;
        historyCount = Math.min(HN, historyCount + 1);
        // Sample the server pump counter once per client frame: the delta is
        // how many server ticks advanced inside this frame window.
        const server = globalThis.mcWebServer;
        const count = server?.info?.()?.tickCount;
        if (typeof count === "number") {
          if (lastTickCount >= 0) pendingTicks += Math.max(0, count - lastTickCount);
          lastTickCount = count;
        }
        serverDeltas[head] = pendingTicks;
        pendingTicks = 0;
        head = (head + 1) % N;
        const now = performance.now();
        draw(now);
        refreshLabel();
      },
      pushServer(samples) {
        // Each sample is [durationMs, gapMs] for one pump call; the gap is
        // the time since the previous pump start on the Worker event loop.
        for (const pair of samples) {
          serverDur[serverHead] = Number(pair[0]) || 0;
          serverGap[serverHead] = Number(pair[1]) || 0;
          if (serverDur[serverHead] > 0) lastServerDur = serverDur[serverHead];
          if (serverGap[serverHead] > worstServerGap) worstServerGap = serverGap[serverHead];
          serverHead = (serverHead + 1) % SN;
        }
        worstServerGap *= 0.9; // decay so stale spikes fade from the label
      },
      reset() {
        historyHead = 0;
        historyCount = 0;
        frames.fill(0);
        callbackFrames.fill(0);
        serverDeltas.fill(0);
        head = 0;
        pendingTicks = 0;
        visibleOver33 = 0;
        visibleOver100 = 0;
        serverDur.fill(0);
        serverGap.fill(0);
        serverHead = 0;
        lastServerDur = 0;
        worstServerGap = 0;
        hitchTimes.length = 0;
      },
      report() {
        const callbackMs = historyValues(frameHistory);
        const rafGapMs = historyValues(rafGapHistory, true);
        const gaps = summary(rafGapMs);
        const nonzeroServerDur = [...serverDur].filter((x) => x > 0);
        const nonzeroServerGap = [...serverGap].filter((x) => x > 0);
        return {
          enabled: true,
          pacing: globalThis.mcWebPump?.pacing?.() ?? null,
          samples: callbackMs.length,
          fps: gaps.mean > 0 ? Math.round(100000 / gaps.mean) / 100 : 0,
          callbackMs: summary(callbackMs),
          rafGapMs: {
            ...gaps,
            over33: rafGapMs.filter((x) => x > 33).length,
            over50: rafGapMs.filter((x) => x > 50).length,
            over100: rafGapMs.filter((x) => x > 100).length,
            over250: rafGapMs.filter((x) => x > 250).length
          },
          serverPumpDurationMs: summary(nonzeroServerDur),
          serverPumpGapMs: summary(nonzeroServerGap),
          hitches: hitchSpacing()
        };
      },
    };
  })();

  // ---------------------------------------------------------------------------
  // Frame pump and host API
  // ---------------------------------------------------------------------------

  globalThis.mcWebPump = {
    callback: null,
    running: false,
    ticks: 0,        // JS-side: how many times the frame callback was entered
    lastMs: 0,       // duration (ms) of the most recent callback
    slow: 0,         // count of callbacks that took > 1500ms (a hang signature)
    vsync: !new URLSearchParams(location.search).has("mcweb_uncapped"),
    targetFps: Math.max(1, Math.min(260,
      Number(new URLSearchParams(location.search).get("mcweb_max_fps")) || 260)),
    _nextDueMs: 0,
    _postTaskUnavailable: false,
    _skippedPeriods: 0,
    _firstFrameFallbacks: 0,
    configure(vsync, frameLimit) {
      const params = new URLSearchParams(location.search);
      const forcedUncapped = params.has("mcweb_uncapped");
      const forcedLimit = Number(params.get("mcweb_max_fps"));
      const nextVsync = forcedUncapped ? false : Boolean(vsync);
      const nextLimit = Math.max(1, Math.min(260,
        Number.isFinite(forcedLimit) && forcedLimit > 0 ? forcedLimit : Number(frameLimit) || 260));
      if (this.vsync === nextVsync && this.targetFps === nextLimit) return;
      this.vsync = nextVsync;
      this.targetFps = nextLimit;
      this._nextDueMs = 0;
      this._skippedPeriods = 0;
    },
    _schedulerName() {
      if (this.vsync) return "requestAnimationFrame";
      return !this._postTaskUnavailable
          && typeof globalThis.scheduler?.postTask === "function"
        ? "scheduler.postTask"
        : "timer";
    },
    pacing() {
      return {
        scheduler: this._schedulerName(),
        vsync: this.vsync,
        targetFps: this.targetFps,
        skippedPeriods: this._skippedPeriods,
        firstFrameFallbacks: this._firstFrameFallbacks
      };
    },
    _schedule(loop) {
      if (this.vsync) {
        requestAnimationFrame(loop);
        return;
      }

      // Minecraft's desktop limiter treats 260 as "unlimited". Carrying that
      // literally into a MessageChannel pump let a cheap sky frame repost as
      // fast as the browser could drain tasks (999+ FPS), starving input and
      // doing render work the display could never present. In the browser 260
      // is a real safety ceiling. A delayed, user-visible scheduler.postTask
      // yields to input and schedules exactly one frame without the nesting
      // clamp imposed on recursive setTimeout callbacks.
      const now = performance.now();
      const interval = 1000 / this.targetFps;
      if (!(this._nextDueMs > 0)) {
        this._nextDueMs = now;
      }
      const due = this._nextDueMs;
      // postTask's delay is a whole-millisecond Web IDL integer. Rounding
      // down a fractional remainder can turn the wait into an immediate task.
      const delay = Math.max(0, Math.ceil(due - now));
      const fire = () => {
        const fired = performance.now();
        let nextDue = due + interval;
        // A hidden tab, GC pause, or long Java frame must not leave hundreds
        // of expired callbacks to catch up. Advance to the first future slot
        // and run Minecraft once; later frames resume from that deadline.
        if (fired >= nextDue) {
          const skipped = Math.floor((fired - nextDue) / interval) + 1;
          this._skippedPeriods += skipped;
          nextDue += skipped * interval;
        }
        // Even a small late arrival must not compress the following gap to
        // the remainder of an old slot. Measure the ceiling from this actual
        // start; whole-millisecond delays can make cheap frames slightly slower.
        this._nextDueMs = Math.max(nextDue, fired + interval);
        loop(fired);
      };

      if (!this._postTaskUnavailable
          && typeof globalThis.scheduler?.postTask === "function") {
        try {
          globalThis.scheduler.postTask(fire, {priority: "user-visible", delay});
          return;
        } catch (error) {
          this._postTaskUnavailable = true;
          console.warn("scheduler.postTask unavailable; using timer pacing:", error);
        }
      }
      setTimeout(fire, delay);
    },
    register(callback) {
      this.callback = callback;
      this._lastRafTimestamp = null;
      if (this.running) return;
      this.running = true;
      const loop = (frameTimestamp) => {
        const cb = this.callback;
        if (cb) {
          // Apply a pending window resize here rather than in the DOM event, so
          // Minecraft rebuilds its render targets between frames instead of
          // underneath one that is already recording commands.
          globalThis.mcWebCanvas.applyPendingResize();
          this.ticks++;
          if (_DBG && (this.ticks <= 3 || this.ticks % 60 === 0)) console.log("[pump] enter #" + this.ticks);
          const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
          const previousRaf = this._lastRafTimestamp;
          this._lastRafTimestamp = typeof frameTimestamp === "number" ? frameTimestamp : t0;
          if (_perf.on) {
            _perf.rafGaps.push(previousRaf == null ? 0 : this._lastRafTimestamp - previousRaf);
          }
          try {
            if (typeof cb.run === "function") cb.run();
            else cb();
          } catch (error) {
            // Same reasoning as the input bridge: "Exception" on its own names
            // nothing, and this catch is the last place the object exists.
            (globalThis.mcWebPumpErrors ||= []).push({
              tick: this.ticks,
              text: String(error),
              ctor: error?.constructor?.name ?? null,
              message: error?.message ?? null,
              props: (() => { try { return Object.getOwnPropertyNames(error).slice(0, 20); } catch { return null; } })(),
              stack: String(error?.stack || "").split("\n").slice(0, 14)
            });
            console.error("frame pump error:", error);
          }
          const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
          this.lastMs = Math.round(ms);
          _frameGraph.push(ms,
            previousRaf == null ? 0 : this._lastRafTimestamp - previousRaf);
          if (_perf.on) {
            _perf.frames.push(ms);
            _perf.hostFrames.push(_perf.hostMsThisFrame);
            _perf.callFrames.push(_perf.callsThisFrame);
            _perf.uploadBytesFrames.push(_perf.bytesThisFrame);
            if (ms >= 17 && _uploadAttribution) {
              // Attribution for stutter frames: which buffers ate the frame,
              // with call counts so many-small vs few-big bursts can be told
              // apart (over-drain vs inherent upload cost).
              _perf.slowFrameUploads.push({
                frame: _perf.frames.length - 1,
                ms,
                bytes: _perf.bytesThisFrame,
                byLabel: Object.fromEntries(_perf.bytesByLabelThisFrame),
                callsByLabel: Object.fromEntries(_perf.callsByLabelThisFrame),
              });
            }
            _perf.hostMsThisFrame = 0;
            _perf.callsThisFrame = 0;
            _perf.bytesThisFrame = 0;
            _perf.bytesByLabelThisFrame.clear();
            _perf.callsByLabelThisFrame.clear();
          }
          if (ms > 1500) { this.slow++; console.warn("[pump] slow tick #" + this.ticks + " = " + this.lastMs + "ms (runTick hang?)"); }
        }
        this._schedule(loop);
      };
      // Chromium can lose the very first rAF request when Web Image finishes a
      // long synchronous boot inside the launch-button task. A visibility
      // transition makes rAF wake again, which is why changing tabs appeared to
      // "start" Minecraft. Race that first scheduled callback with one bounded
      // visible-tab timer. The once gate guarantees exactly one pump chain; all
      // later frames continue through the selected Minecraft pacing mode.
      let firstPending = true;
      const first = (timestamp) => {
        if (!firstPending) return;
        firstPending = false;
        loop(timestamp);
      };
      const rescueFirst = () => {
        if (!firstPending) return;
        if (document.visibilityState === "hidden") {
          const onVisible = () => {
            if (document.visibilityState !== "visible") return;
            removeEventListener("visibilitychange", onVisible);
            rescueFirst();
          };
          addEventListener("visibilitychange", onVisible);
          return;
        }
        this._firstFrameFallbacks++;
        first(performance.now());
      };
      this._schedule(first);
      setTimeout(rescueFirst, 100);
    },
    frameReported(count) {
      document.body.dataset.frames = String(count);
      // Reveal the canvas once frames start flowing so screenshots show the
      // actual game render, not the diagnostic overlay. Any positive count
      // qualifies (the first report may be 0 or 1 depending on ordering).
      if (count >= 1) {
        framesFlowing = true;
        const main = document.querySelector("main");
        if (main) main.style.display = "none";
        failure.hidden = true;
        // Game is rendering: drop the boot overlay (a couple of frames in, so
        // the title screen's first paint isn't raced by the hide).
        if (count >= 2 && globalThis.mcWebBootOverlay && !globalThis.mcWebBootOverlay.hidden) {
          globalThis.mcWebBootOverlay.hide();
          // Self-report the texture-identity diag a moment after the title
          // screen starts sampling, so the console carries the evidence
          // without a manual _texDiagLate() call.
          if (_textureHistoryCaptured) {
            setTimeout(() => { try { globalThis.mcWebGpu._texDiagLate && globalThis.mcWebGpu._texDiagLate(); } catch {} }, 2500);
          }
        }
      }
    }
  };

  // ---------------------------------------------------------------------------
  // DOM input -> SDL events. Minecraft 26.3 reads input as SDL3 events, so the
  // listeners below speak SDL's numbering and BrowserInputBridge queues each
  // message as one SDL event. Every message is a name and four numbers:
  //   key         scancode, keycode (0 = Java picks the unshifted key),
  //               down (1/0), SDL_KMOD bits | 0x10000 for a repeat
  //   charInput   one code point (an SDL text event while a field has focus)
  //   cursorPos   x, y, movementX, movementY (SDL's xrel/yrel)
  //   mouseButton SDL button (DOM button + 1), down (1/0), SDL_KMOD bits
  //   scroll      x (positive right), y (positive away from the user)
  // ---------------------------------------------------------------------------

  // SDL_Keymod bits, as LWJGL 3.4.3's SDLKeycode declares them.
  const KMOD = {
    LSHIFT: 0x0001, RSHIFT: 0x0002, LCTRL: 0x0040, RCTRL: 0x0080,
    LALT: 0x0100, RALT: 0x0200, LGUI: 0x0400, RGUI: 0x0800,
    NUM: 0x1000, CAPS: 0x2000, SCROLL: 0x8000
  };
  const KEY_REPEAT = 0x10000;

  // DOM KeyboardEvent.code -> SDL scancode, which is the USB HID usage id. The
  // code names the physical key, as a scancode does, whatever the layout.
  const SCANCODE_MAP = {
    Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45,
    Equal: 46, BracketLeft: 47, BracketRight: 48, Backslash: 49,
    Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55,
    Slash: 56, CapsLock: 57, PrintScreen: 70, ScrollLock: 71, Pause: 72,
    Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
    ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83,
    NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87,
    NumpadEnter: 88, Numpad0: 98, NumpadDecimal: 99, IntlBackslash: 100,
    ContextMenu: 101, NumpadEqual: 103, NumpadComma: 133,
    ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
    ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
    // Older Firefox names for the Meta keys.
    OSLeft: 227, OSRight: 231
  };
  for (let i = 0; i < 26; i++) SCANCODE_MAP["Key" + String.fromCharCode(65 + i)] = 4 + i;
  for (let i = 1; i <= 9; i++) SCANCODE_MAP["Digit" + i] = 29 + i;
  SCANCODE_MAP.Digit0 = 39;
  for (let i = 1; i <= 9; i++) SCANCODE_MAP["Numpad" + i] = 88 + i;
  for (let i = 1; i <= 12; i++) SCANCODE_MAP["F" + i] = 57 + i;
  for (let i = 13; i <= 24; i++) SCANCODE_MAP["F" + i] = 91 + i;

  // Keys held down, by DOM code, so modifiers can be told left from right and
  // so everything can be released when the page loses focus.
  const heldKeys = new Map();

  // A modifier the DOM reports without its keydown (held before the page had
  // focus) counts as the left one.
  const sideMods = (on, leftCode, rightCode, left, right) => {
    if (!on) return 0;
    const bits = (heldKeys.has(leftCode) ? left : 0) | (heldKeys.has(rightCode) ? right : 0);
    return bits || left;
  };
  const sdlMods = (event) => {
    let mods = sideMods(event.shiftKey, "ShiftLeft", "ShiftRight", KMOD.LSHIFT, KMOD.RSHIFT)
      | sideMods(event.ctrlKey, "ControlLeft", "ControlRight", KMOD.LCTRL, KMOD.RCTRL)
      | sideMods(event.altKey, "AltLeft", "AltRight", KMOD.LALT, KMOD.RALT)
      | sideMods(event.metaKey, "MetaLeft", "MetaRight", KMOD.LGUI, KMOD.RGUI);
    if (event.getModifierState?.("CapsLock")) mods |= KMOD.CAPS;
    if (event.getModifierState?.("NumLock")) mods |= KMOD.NUM;
    if (event.getModifierState?.("ScrollLock")) mods |= KMOD.SCROLL;
    return mods;
  };

  // An SDL keycode is the unshifted character a key types on this layout.
  // Shift and Alt/Option change event.key, and keypad keys have keycodes of
  // their own, so those report 0 and Java uses what it knows for the scancode.
  const sdlKeycode = (event) => {
    if (event.shiftKey || event.altKey || event.code.startsWith("Numpad")) return 0;
    const chars = [...(event.key || "")];
    return chars.length === 1 ? chars[0].toLowerCase().codePointAt(0) : 0;
  };

  // Keys that would scroll/interact with the page while the game has focus.
  const PREVENT_DEFAULT_CODES = new Set([
    "Space", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Backspace", "Enter", "Slash", "F3", "F5"
  ]);

  globalThis.mcWebInput = {
    bridge: null,
    lockPointerOnNextClick: false,
    syntheticX: 0,
    syntheticY: 0,
    // Chromium was already correct with the original canvas listener. Keep
    // WebKit's document-targeted Pointer Lock workaround scoped to Safari so
    // it cannot change Chromium's input routing or feel.
    documentPointerMoves: navigator.vendor === "Apple Computer, Inc.",
    diagnostics: {
      calls: Object.create(null),
      lastCall: null
    },
    register(bridge) {
      this.bridge = bridge;
      recordStage("input-bridge-registered");
    },
    call(name, ...args) {
      const bridge = this.bridge;
      if (!bridge) return;
      try {
        this.diagnostics.calls[name] = (this.diagnostics.calls[name] || 0) + 1;
        this.diagnostics.lastCall = {
          name,
          args: args.slice(),
          frame: Number(document.body?.dataset?.frames || 0)
        };
        if (typeof bridge === "function") {
          bridge(name, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);
        } else if (typeof bridge[name] === "function") {
          // Compatibility with any host-object interop that does expose Java
          // instance methods directly.
          bridge[name](...args);
        }
      } catch (error) {
        // A Web Image exception stringifies to a bare "Exception", which names
        // nothing. Keep the readable parts so a lost click can be attributed.
        (this.diagnostics.errors ||= []).push({
          name,
          args: args.slice(),
          text: String(error),
          ctor: error?.constructor?.name ?? null,
          message: error?.message ?? null,
          props: (() => { try { return Object.getOwnPropertyNames(error).slice(0, 20); } catch { return null; } })(),
          stack: String(error?.stack || "").split("\n").slice(0, 12)
        });
        console.error("input bridge error:", name, error);
      }
    }
  };

  const canvasToPixel = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
    const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
    return [(clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY];
  };

  // Escape while the pointer is locked belongs to the browser: it exits the lock
  // and does not dispatch the keydown to the page. Minecraft therefore never saw
  // the press -- the cursor came free but no menu opened, and only a *second*
  // Escape (delivered normally now that the page has keys again) reached the
  // game. Desktop Minecraft does both on one press, so the lost key is
  // synthesized on pointerlockchange below. This timestamp covers the browsers
  // that do deliver it, so the key is never counted twice. It starts at
  // -Infinity rather than 0 because performance.now() itself starts near zero,
  // and a 0 sentinel would read as "just delivered" for the first half-second.
  let escapeSeenWhileLocked = -Infinity;

  const releaseBrowserPointerLock = () => {
    const input = globalThis.mcWebInput;
    const wanted = input.lockPointerOnNextClick || document.pointerLockElement === canvas;
    // The Worker adapter forwards this transition to the page immediately;
    // waiting for Java's pause processing can otherwise re-arm the next click.
    input.lockPointerOnNextClick = false;
    if (document.pointerLockElement === canvas) {
      try { document.exitPointerLock?.()?.catch?.(() => {}); } catch {}
    }
    return wanted;
  };
  const pauseAfterBrowserPointerRelease = () => {
    const input = globalThis.mcWebInput;
    if (!input.bridge || performance.now() - escapeSeenWhileLocked < 500) return;
    const escape = SCANCODE_MAP.Escape;
    input.call("key", escape, 0, 1, 0);
    input.call("key", escape, 0, 0, 0);
  };

  addEventListener("keydown", (event) => {
    if (event.code === "Escape" && (document.pointerLockElement === canvas
        || globalThis.mcWebInput.lockPointerOnNextClick)) {
      escapeSeenWhileLocked = performance.now();
      releaseBrowserPointerLock();
    }
    if (!globalThis.mcWebInput.bridge) return;
    if (PREVENT_DEFAULT_CODES.has(event.code)) event.preventDefault();
    const scancode = SCANCODE_MAP[event.code];
    if (!scancode) return;
    heldKeys.set(event.code, scancode);
    globalThis.mcWebInput.call("key", scancode, sdlKeycode(event), 1,
      sdlMods(event) | (event.repeat ? KEY_REPEAT : 0));
    // Text for text fields: a key that types one character. Java turns it
    // into an SDL text event only while Minecraft has text input started.
    const chars = [...(event.key || "")];
    if (chars.length === 1 && !event.ctrlKey && !event.metaKey) {
      globalThis.mcWebInput.call("charInput", chars[0].codePointAt(0));
    }
  });

  addEventListener("keyup", (event) => {
    if (!globalThis.mcWebInput.bridge) return;
    const scancode = SCANCODE_MAP[event.code];
    if (!scancode) return;
    heldKeys.delete(event.code);
    globalThis.mcWebInput.call("key", scancode, sdlKeycode(event), 0, sdlMods(event));
  });

  // A key released while another window had focus never sends its keyup, and
  // the game would keep walking. SDL releases every key when its window loses
  // keyboard focus; do the same.
  addEventListener("blur", () => {
    const wanted = releaseBrowserPointerLock();
    if (wanted) pauseAfterBrowserPointerRelease();
    if (!globalThis.mcWebInput.bridge) return;
    for (const scancode of heldKeys.values()) {
      globalThis.mcWebInput.call("key", scancode, 0, 0, 0);
    }
    heldKeys.clear();
  });

  const handleMouseMove = (event) => {
    if (!globalThis.mcWebInput.bridge) return;
    // The movement travels as SDL's xrel/yrel, which is all Minecraft reads
    // while it has the mouse grabbed; x/y only matter while it does not.
    const movementX = Number(event.movementX || event.webkitMovementX || 0);
    const movementY = Number(event.movementY || event.webkitMovementY || 0);
    if (document.pointerLockElement === canvas) {
      // Pointer is locked: the DOM has no position, so keep a synthetic one
      // that follows the movement. It stays unclamped, as it was when the
      // camera was driven from position differences; clamping then capped a
      // turn at one canvas width.
      const input = globalThis.mcWebInput;
      // WebKit may retarget locked movement to Document when no mouse button
      // is held, while dragging retains the canvas as its capture target. A
      // listener attached only to the canvas therefore made free-look appear
      // much slower than button-held movement in Safari. Chromium stays on
      // the original canvas listener below. Older WebKit builds exposed only
      // the prefixed relative deltas, read above.
      input.syntheticX += movementX;
      input.syntheticY += movementY;
      globalThis.mcWebInput.call("cursorPos", input.syntheticX, input.syntheticY, movementX, movementY);
      return;
    }
    // Safari's document listener also observes every ordinary page mousemove.
    // Only canvas-targeted movement belongs to Minecraft while the cursor is
    // free.
    if (event.target !== canvas) return;
    const [x, y] = canvasToPixel(event.clientX, event.clientY);
    if (globalThis.mcWebInput.lockPointerOnNextClick) {
      // Embedded browsers may deny pointer lock. Keep the captured-coordinate
      // fallback aligned with the last real mouse position so a click does not
      // inject a camera delta before Minecraft receives the button event.
      globalThis.mcWebInput.syntheticX = x;
      globalThis.mcWebInput.syntheticY = y;
    }
    globalThis.mcWebInput.call("cursorPos", x, y, movementX, movementY);
  };
  const pointerMoveTarget = globalThis.mcWebInput.documentPointerMoves
    ? document : canvas;
  pointerMoveTarget.addEventListener("mousemove", handleMouseMove,
    globalThis.mcWebInput.documentPointerMoves ? {capture: true} : undefined);

  canvas.addEventListener("mousedown", (event) => {
    if (!globalThis.mcWebInput.bridge) return;
    event.preventDefault();
    canvas.focus?.();
    // SDL reports the cursor position with a mouse-button event, and
    // Minecraft hit-tests from the last motion. A synthetic/automated click is
    // not required to emit mousemove first, so
    // refresh it from this event as well or Minecraft can hit-test using the
    // stale startup position (0, 0).
    const input = globalThis.mcWebInput;
    const cursorIsCaptured =
      document.pointerLockElement === canvas || input.lockPointerOnNextClick;
    const [x, y] = cursorIsCaptured
      ? [input.syntheticX, input.syntheticY]
      : canvasToPixel(event.clientX, event.clientY);
    globalThis.mcWebInput.call("cursorPos", x, y);
    if (document.pointerLockElement !== canvas && input.lockPointerOnNextClick
        && canvas.requestPointerLock) {
      input.syntheticX = x;
      input.syntheticY = y;
      const request = canvas.requestPointerLock();
      if (request && typeof request.catch === "function") {
        // A denied lock is not cosmetic: the fallback path feeds Minecraft the
        // real canvas-bounded cursor, so the camera stops turning at the window
        // edge. Record the reason instead of swallowing it -- that failure and a
        // clamped virtual cursor produce the same "can only turn so far" report,
        // and only this tells them apart.
        request.catch((error) => {
          input.diagnostics.pointerLockError = {
            text: String(error),
            name: error?.name ?? null,
            at: Date.now()
          };
          console.warn("pointer lock denied:", error);
        });
      }
    }
    // DOM buttons count from 0 (left, middle, right, back, forward) in the
    // same order SDL counts from 1.
    globalThis.mcWebInput.call("mouseButton", event.button + 1, 1, sdlMods(event));
  });

  addEventListener("mouseup", (event) => {
    if (!globalThis.mcWebInput.bridge) return;
    globalThis.mcWebInput.call("mouseButton", event.button + 1, 0, sdlMods(event));
  });

  canvas.addEventListener("wheel", (event) => {
    if (!globalThis.mcWebInput.bridge) return;
    event.preventDefault();
    // SDL wheel amounts are in notches; pixel-mode wheels typically produce
    // multiples of ~100 per notch. SDL's x is positive to the right, as the
    // DOM's is; its y is positive away from the user, the DOM's opposite.
    const scale = event.deltaMode === 1 ? 1 : 1 / 100;
    globalThis.mcWebInput.call("scroll", event.deltaX * scale, -event.deltaY * scale);
  }, {passive: false});

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  // A browser release (Escape swallowed by native pointer lock, or focus
  // loss) must disarm both the page and this host before Java handles pause.
  // Java's normal menu release already disarms first, so it adds no Escape.
  document.addEventListener("pointerlockchange", (event) => {
    const input = globalThis.mcWebInput;
    if (document.pointerLockElement === canvas) {
      // An in-flight browser request can finish after Escape released it.
      if (!input.lockPointerOnNextClick) releaseBrowserPointerLock();
      else escapeSeenWhileLocked = -Infinity; // A genuine new grab starts a new Escape gesture.
      return;
    }
    const wanted = input.lockPointerOnNextClick;
    input.lockPointerOnNextClick = false;
    if (wanted && !event.escapeDispatched) pauseAfterBrowserPointerRelease();
  });

  // Safari versions where requestPointerLock() returns void report denial only
  // through this event rather than a rejected Promise. Keep the failure visible
  // in the same diagnostics used by the Promise path above.
  document.addEventListener("pointerlockerror", (event) => {
    globalThis.mcWebInput.diagnostics.pointerLockError = {
      text: "pointerlockerror",
      name: event?.type ?? "pointerlockerror",
      at: Date.now(),
    };
    console.warn("pointer lock denied: pointerlockerror");
  });

  // ---------------------------------------------------------------------------
  // Text input for a touch screen's native keyboard (web/game-controls.js).
  //
  // Java reports what the game wants typed (dev.mcweb.graal.BrowserTextInput)
  // as one progress marker per change, read off reportProgress below:
  //   evt:text-input <active> <owner> <caret x y w h | -1 -1 0 0> <n> then n
  //                  times <x y w h owns>
  // Text input started (SDL_StartTextInput) and what owns it (0 nothing known,
  // 1 a widget, 2 a screen that edits without one: the sign editor), the caret
  // (SDL_SetTextInputArea) and the editable text fields of the current screen,
  // the owner marked ("focused" below), all in canvas pixels.
  // The page is told in the same shape, as { mcwebTextInput } from the GPU
  // Worker or an "mcweb-text-input" event where the host runs on the page; it
  // needs the field rectangles before a tap ends, because iOS opens the
  // keyboard only for a focus inside that tap.
  //
  // What the page's keyboard types comes back as { mcwebText } messages:
  //   { kind: "commit", text }                       -> charInput per code point
  //   { kind: "preedit", text, cursor, selection }   -> one SDL_EVENT_TEXT_EDITING
  // Keys (Backspace, Enter, arrows, shortcuts) arrive as ordinary keydown/keyup.
  // ---------------------------------------------------------------------------
  const TEXT_INPUT_PREFIX = "evt:text-input ";
  // A paste larger than this is cut: each code point is one mailbox line.
  const MAX_TEXT_CODE_POINTS = 1024;
  const OWNER_KINDS = [null, "widget", "screen"];
  const textInput = {active: false, owner: null, area: null, fields: [], seq: 0, reports: 0, messages: 0};
  globalThis.mcWebInput.textInput = textInput;
  const textInputState = () => ({
    active: textInput.active, owner: textInput.owner, area: textInput.area, fields: textInput.fields,
    seq: textInput.seq,
  });
  const announceTextInput = () => {
    const state = textInputState();
    if (globalThis.__mcWebWorkerEnv) {
      globalThis.postMessage({mcwebTextInput: state});
    } else if (typeof CustomEvent === "function") {
      globalThis.dispatchEvent(new CustomEvent("mcweb-text-input", {detail: state}));
    }
  };
  globalThis.mcWebInput.textInputState = textInputState;
  globalThis.mcWebInput.reportTextInput = (line) => {
    const n = String(line).slice(TEXT_INPUT_PREFIX.length).trim().split(" ").map(Number);
    if (n.length < 7 || n.some((value) => !Number.isFinite(value))) return;
    const count = Math.max(0, Math.min(n[6], Math.floor((n.length - 7) / 5)));
    const fields = [];
    for (let i = 0; i < count; i++) {
      const at = 7 + i * 5;
      fields.push({x: n[at], y: n[at + 1], w: n[at + 2], h: n[at + 3], focused: n[at + 4] === 1});
    }
    textInput.active = n[0] === 1;
    textInput.owner = textInput.active ? OWNER_KINDS[n[1]] ?? null : null;
    textInput.area = n[2] >= 0 && n[3] >= 0 ? {x: n[2], y: n[3], w: n[4], h: n[5]} : null;
    textInput.fields = fields;
    textInput.seq++;
    textInput.reports++;
    announceTextInput();
  };
  globalThis.mcWebInput.applyTextMessage = (message) => {
    const input = globalThis.mcWebInput;
    if (!input.bridge || !message || typeof message.text !== "string") return;
    textInput.messages++;
    const points = [];
    for (const ch of message.text) {
      if (points.length >= MAX_TEXT_CODE_POINTS) break;
      points.push(ch.codePointAt(0));
    }
    if (message.kind === "commit") {
      for (const point of points) input.call("charInput", point);
    } else if (message.kind === "preedit") {
      const bound = (value, fallback) => Number.isInteger(value) && value >= 0
        ? Math.min(value, points.length) : fallback;
      const cursor = bound(message.cursor, points.length);
      input.call("textPreeditBegin");
      for (const point of points) input.call("textPreeditChar", point);
      input.call("textPreeditEnd", cursor, Math.min(bound(message.selection, 0), points.length - cursor));
    }
  };
  // worker-env.js diverts only DOM input event types; "message" is the
  // Worker's own, so the page's text and state queries arrive here.
  if (globalThis.__mcWebWorkerEnv) {
    addEventListener("message", (event) => {
      const data = event.data;
      if (!data) return;
      if (data.mcwebText) globalThis.mcWebInput.applyTextMessage(data.mcwebText);
      else if (data.mcwebTextInputQuery) announceTextInput();
    });
  }

  // ---------------------------------------------------------------------
  // Opt-in profiler (?mcweb_perf=1). Answers the first question any perf work
  // has to answer here: of a frame's milliseconds, how many are spent inside
  // the host (WebGPU calls) versus inside Java, and which bridge calls carry
  // the cost -- by total time, not by the call count that intuition reaches
  // for first.
  const _perf = {
    on: false,
    frames: [],          // per-frame total ms, from the pump loop
    rafGaps: [],         // time between rAF callbacks, including time outside Java
    hostMsThisFrame: 0,  // ms inside bridge calls, reset each frame
    hostFrames: [],      // per-frame host ms, index-aligned with frames
    calls: new Map(),    // name -> {n, ms} accumulated over the whole run
    callsThisFrame: 0,
    callFrames: [],      // per-frame bridge-call count
    bytesThisFrame: 0,   // bytes handed to queue.writeBuffer this frame
    bytesByLabelThisFrame: new Map(), // buffer label -> bytes this frame
    callsByLabelThisFrame: new Map(), // buffer label -> upload calls this frame
    uploadBytesFrames: [], // index-aligned with frames: upload bytes/frame
    slowFrameUploads: [],  // per-stutter-frame upload bytes by buffer label
    gpuQueueMs: [],      // asynchronous submit -> onSubmittedWorkDone timings
    gpuSubmits: 0
  };

  // Per-frame upload accounting: total bytes always on; per-buffer-label
  // attribution is opt-in (?mcweb_upattr) because it allocates per upload and
  // was isolated while chasing a perf-flag boot stall. Slow-frame attribution
  // reads the label map.
  const _uploadAttribution = new URLSearchParams(location.search).has("mcweb_upattr");
  const _noteUploadBytes = (label, bytes) => {
    _perf.bytesThisFrame += bytes;
    if (!_uploadAttribution) return;
    const map = _perf.bytesByLabelThisFrame;
    map.set(label, (map.get(label) || 0) + bytes);
    const calls = _perf.callsByLabelThisFrame;
    calls.set(label, (calls.get(label) || 0) + 1);
  };
  const _forceCopySrc = new URLSearchParams(location.search).has("mcweb_copysrc");
  // ?mcweb_hazard=1 (diagnostic): queue.writeBuffer runs before every
  // command buffer submitted after it, so a write that lands in a range an
  // already-recorded, not-yet-submitted draw reads is seen by that draw --
  // GL's order is the opposite. Counts such writes by buffer label, and the
  // writes that touched a pending buffer outside every drawn range, once
  // every 5 s on the console ("[gpu-hazard]").
  const _hz = new URLSearchParams(location.search).has("mcweb_hazard")
    ? {pending: new Map(), hit: 0, clear: 0, by: {}, at: 0} : null;
  const _hzUse = (encoder, buffer, offset, size) => {
    if (!_hz || !encoder || !buffer) return;
    let m = _hz.pending.get(encoder);
    if (!m) _hz.pending.set(encoder, m = new Map());
    let r = m.get(buffer);
    if (!r) m.set(buffer, r = []);
    const o = offset | 0, n = size == null ? buffer.size - o : size;
    if (r.length < 65536) r.push(o, n);
  };
  const _hzWrite = (buffer, label, offset, length) => {
    if (!_hz) return;
    let touched = false;
    for (const m of _hz.pending.values()) {
      const r = m.get(buffer);
      if (!r) continue;
      touched = true;
      for (let i = 0; i < r.length; i += 2) {
        if (offset < r[i] + r[i + 1] && offset + length > r[i]) {
          _hz.hit++;
          const k = String(label || "?").slice(0, 60);
          _hz.by[k] = (_hz.by[k] || 0) + 1;
          return;
        }
      }
    }
    if (touched) _hz.clear++;
    const now = performance.now();
    if (now - _hz.at > 5000) {
      _hz.at = now;
      console.log("[gpu-hazard] overlapping=" + _hz.hit + " pendingButClear=" + _hz.clear
        + " orderFlushes=" + _ord.flushes + " inPass=" + _ord.inPass
        + " by=" + JSON.stringify(_hz.by));
    }
  };
  // Queue uploads execute before command buffers submitted after them.
  // Flush recorded uses first so an upload cannot overtake an atlas clear,
  // copy or draw. The same serial tags keep deferred destruction from
  // freeing a resource while its encoder is still waiting for submission.
  const _ordered = !new URLSearchParams(location.search).has("mcweb_unordered");
  const _ord = {flushes: 0, inPass: 0};
  const _markResourceUse = (encoder, resource) => {
    if (!encoder || !resource) return;
    const previous = resource._mcEnc;
    const pending = resource._mcPending;
    if (pending) {
      for (const [owner, serial] of pending) {
        if (!owner.encoder || owner.serial !== serial) pending.delete(owner);
      }
    }
    if (previous && previous !== encoder && previous.encoder && resource._mcSer === previous.serial) {
      (resource._mcPending ||= new Map()).set(previous, resource._mcSer);
    }
    resource._mcEnc = encoder;
    resource._mcSer = encoder.serial;
  };
  const _markUse = (state, resource) => _markResourceUse(state._encoderEntry, resource);
  const submitBeforeWrite = (encoder, serial) => {
    if (!encoder?.encoder || encoder.serial !== serial) return;
    if (encoder.openPasses > 0) { _ord.inPass++; return; }
    if (_hz) _hz.pending.delete(encoder.encoder);
    device.queue.submit([encoder.encoder.finish()]);
    encoder.encoder = device.createCommandEncoder({label: "Minecraft CommandEncoder"});
    encoder.serial++;
    _ord.flushes++;
  };
  const _orderWrite = (resource) => {
    if (!_ordered) return;
    if (resource._mcPending) {
      for (const [encoder, serial] of resource._mcPending) {
        submitBeforeWrite(encoder, serial);
        if (encoder.serial !== serial || !encoder.encoder) resource._mcPending.delete(encoder);
      }
    }
    submitBeforeWrite(resource._mcEnc, resource._mcSer);
  };

  // A render attachment is one mip of one layer. A whole-texture clear must
  // visit those subresources separately; a default view spans the mip chain
  // and cannot be used as a render attachment.
  const clearSubresources = (encoderEntry, colorEntry, color, depthEntry, depth) => {
    const entry = colorEntry || depthEntry;
    _markResourceUse(encoderEntry, colorEntry?.texture);
    _markResourceUse(encoderEntry, depthEntry?.texture);
    for (let mip = 0; mip < entry.texture.mipLevelCount; mip++) {
      for (let layer = 0; layer < (entry.depth || 1); layer++) {
        const pass = encoderEntry.encoder.beginRenderPass({
          label: "Minecraft texture clear",
          colorAttachments: colorEntry ? [{
            view: clearAttachmentView(colorEntry.texture, mip, layer),
            clearValue: color, loadOp: "clear", storeOp: "store"
          }] : [],
          ...(depthEntry ? {depthStencilAttachment: {
            view: clearAttachmentView(depthEntry.texture, mip, layer),
            depthClearValue: depth, depthLoadOp: "clear", depthStoreOp: "store",
            stencilReadOnly: true
          }} : {})
        });
        pass.end();
      }
    }
  };
  const _forceNoCull = new URLSearchParams(location.search).has("mcweb_nocull");
  let _depthSnapshot = null;
  let _uniformSnapshot = null;
  let _visibleUniformSnapshot = null;

  const _suppressPipelines = (() => {
    const raw = new URLSearchParams(location.search).get("mcweb_suppress");
    return raw ? new RegExp(raw, "i") : null;
  })();
  let _diagnosticSuppression = null;
  const _isPipelineSuppressed = (label) =>
    Boolean((_suppressPipelines && _suppressPipelines.test(label))
      || (_diagnosticSuppression && _diagnosticSuppression.test(label)));

  const _percentile = (sorted, p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

  function installPerfProfiler() {
    const target = globalThis.mcWebGpu;
    for (const name of Object.keys(target)) {
      const original = target[name];
      if (typeof original !== "function") continue;
      target[name] = function (...args) {
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          const ms = performance.now() - start;
          let entry = _perf.calls.get(name);
          if (!entry) _perf.calls.set(name, entry = {n: 0, ms: 0});
          entry.n++;
          entry.ms += ms;
          _perf.hostMsThisFrame += ms;
          _perf.callsThisFrame++;
        }
      };
    }
    _perf.on = true;
  }

  // WebGPU reports a destroyed-parent/view mismatch asynchronously, usually at
  // submit time, after the Java call that created the bad binding is gone. Keep
  // one bounded, queryable record with the call tail and (on the RPC lane) the
  // exact batch that carried it. The helper deduplicates the visible report.
  // The evidence for that record, frozen at a submit but formatted only if
  // the submit reports an error. Formatting it on every submit -- JSON of the last RPC
  // batch's arguments, which with render-command streams are tens of KB of
  // bytes each -- was 39% of the OpenJDK lane's GPU Worker.
  const deferTextureValidation = () => {
    const viewHandle = _textureLifetime.lastViewHandle();
    const viewEntry = Number.isInteger(viewHandle)
      ? (objects.get(viewHandle) ?? _textureLifetime.lastViewEntry()) : null;
    const batch = globalThis.mcWebGpu?._rpcLastBatch ?? null;
    return () => _textureLifetime.snapshotValidation(viewHandle, viewEntry, batch);
  };
  let _lastSubmitTextureCandidate = null;
  const noteTextureValidation = (message, candidate = _lastSubmitTextureCandidate) => {
    const snapshot = _textureLifetime.captureValidation(
      message, typeof candidate === "function" ? candidate() : candidate);
    if (!snapshot) return null;
    const gpu = globalThis.mcWebGpu;
    if (gpu && !gpu._textureValidation) gpu._textureValidation = snapshot;
    if (gpu && !gpu._textureValidationLogged) {
      gpu._textureValidationLogged = true;
      console.error("[GPU-TEXTURE-VALIDATION]", JSON.stringify(snapshot));
    }
    return snapshot;
  };

  globalThis.mcWebGpu = {
    // Terminal only; the page has already committed its intercepted files.
    discard() {
      if (discarded) return discardedResources;
      discarded = true;
      globalThis.mcWebPump.running = false;
      globalThis.mcWebPump.callback = null;
      clearInterval(heartbeatInterval); clearInterval(countersInterval);
      discardedResources = {deviceDestroyed: false, canvasUnconfigured: false, objectsReleased: objects.size, errors: []};
      try { context?.unconfigure(); discardedResources.canvasUnconfigured = Boolean(context); }
      catch (error) { discardedResources.errors.push(String(error)); }
      try { device?.destroy(); discardedResources.deviceDestroyed = Boolean(device); }
      catch (error) { discardedResources.errors.push(String(error)); }
      context = device = adapter = null;
      objects.clear(); texInventory.length = 0;
      clearAttachmentViews = new WeakMap();
      _bindGroupCache.clear(); _bindGroupDependencies.clear(); _bindGroupDependents = new WeakMap();
      _shaderModules.clear(); _errorModules.clear(); regionClearPipelines.clear(); loweringIndexBuffers.clear();
      _virtualCanvas = compositeSource = compositePipeline = compositeSampler = null;
      return discardedResources;
    },
    diagnostics,
    _itemAtlasDraws: () => _itemAtlasDrawRing.slice(),
    _compositeDbg: () => ({
      srcTid: compositeSource?._tid, srcLabel: compositeSource?._label ?? null,
      srcWH: compositeSource ? (compositeSource.width + "x" + compositeSource.height) : null,
      srcSeq: compositeSource ? (lastFrameDrawSeq.get(compositeSource._tid) || 0) : 0,
      lastTid: lastFrameIsCanvas ? -1 : lastFrameDrawSeq.size ? [...lastFrameDrawSeq.entries()].sort((a, b) => b[1] - a[1])[0][0] : 0,
      lastIsCanvas: lastFrameIsCanvas,
      draws: Object.fromEntries(lastFrameDraws),
      seq: Object.fromEntries(lastFrameDrawSeq),
      inv: texInventory.slice(-40).map((t) => [t._tid, t.width + "x" + t.height, t.format, t.isCanvas ? "C" : ""])
    }),
    // DIAG: read back the top-left 32x32 of a texture entry and count non-black /
    // non-transparent pixels. Returns a promise. Proves whether an uploaded atlas
    // actually holds pixel data (vs. an empty/black texture = upload gap).
    // ?mcweb_atlasdiag (diagnostic): once the title is up, read back mip 0 of
    // every atlas texture, honouring the 256-byte row pitch, and count texels.
    // An atlas the GPU never filled reads opaque=0; a filled one is thousands.
    _atlasDiag: async () => {
      // ?mcweb_atlasdiag=<regex over labels>; bare flag = every atlas.
      const _atlasDiagRe = new RegExp(new URLSearchParams(location.search).get("mcweb_atlasdiag") || "atlas/");
      const rows = [];
      for (const [handle, entry] of objects) {
        if (entry?.kind !== "texture" || !_atlasDiagRe.test(entry._label || "")) continue;
        const w = entry.width || entry.texture?.width, h = entry.height || entry.texture?.height;
        if (!w || !h) continue;
        const bpr = Math.ceil(w * 4 / 256) * 256;
        const buf = device.createBuffer({size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer({texture: entry.texture, mipLevel: 0}, {buffer: buf, bytesPerRow: bpr, rowsPerImage: h},
          {width: w, height: h, depthOrArrayLayers: 1});
        device.queue.submit([enc.finish()]);
        try {
          await buf.mapAsync(GPUMapMode.READ);
          const u8 = new Uint8Array(buf.getMappedRange());
          let opaque = 0, colored = 0;
          for (let y = 0; y < h; y++) {
            for (let x = 0, i = y * bpr; x < w; x++, i += 4) {
              if (u8[i + 3]) opaque++;
              if (u8[i] > 4 || u8[i + 1] > 4 || u8[i + 2] > 4) colored++;
            }
          }
          rows.push({handle, label: entry._label, hid: entry._hid, wh: w + "x" + h,
            mips: entry.texture.mipLevelCount, uploads: entry._uploads || 0, opaque, colored});
          buf.unmap();
        } catch (e) {
          rows.push({handle, label: entry._label, error: String(e?.message || e)});
        }
        buf.destroy();
      }
      console.log("[ATLAS-DIAG] " + JSON.stringify(rows));
      return rows;
    },
    _readbackTex: (entry, rw, rh) => new Promise((resolve) => {
      let buf = null, mapped = false;
      const release = () => {
        const owned = buf;
        buf = null;
        if (!owned) return;
        try { if (mapped) owned.unmap(); } finally { owned.destroy(); }
      };
      try {
        // Read the WHOLE texture (capped) — a corner-only read gave false
        // negatives for atlases whose art isn't in the top-left 32x32.
        const w = Math.min(rw || 128, entry.width || 1), h = Math.min(rh || 128, entry.height || 1);
        const bpp = 4;
        const bpr = Math.ceil(w * bpp / 256) * 256; // WebGPU: bytesPerRow % 256 == 0
        buf = device.createBuffer({size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer({texture: entry.texture}, {buffer: buf, bytesPerRow: bpr, rowsPerImage: h}, {width: w, height: h, depthOrArrayLayers: 1});
        device.queue.submit([enc.finish()]);
        buf.mapAsync(GPUMapMode.READ).then(() => {
          mapped = true;
          const u8 = new Uint8Array(buf.getMappedRange());
          let nonBlack = 0, nonTransp = 0;
          for (let y = 0; y < h; y++) {
            for (let x = 0, i = y * bpr; x < w; x++, i += bpp) {
              if (u8[i + 3] > 0) nonTransp++;
              if (u8[i] > 4 || u8[i + 1] > 4 || u8[i + 2] > 4) nonBlack++;
            }
          }
          return {nonBlack, nonTransp, sampled: w * h};
        }).finally(release).then(resolve).catch((e) => resolve({error: "map:" + (e && e.message)}));
      } catch (e) {
        try { release(); } catch {} // Preserve the original synchronous failure.
        resolve({error: String(e && e.message || e)});
      }
    }),
    // DIAG: snapshot every texture sampled on the last frame: label, size, format,
    // per-instance upload count, the TOTAL uploads across ALL instances sharing
    // that label (labelUploads — catches a stale-handle: sampled instance=0 but
    // another instance of the same atlas was uploaded), and a whole-texture
    // readback. Also runs a magenta self-check (readbackSelf) to prove the
    // readback path itself returns non-zero pixels.
    _texDiag: () => {
      if (!_textureHistoryCaptured) return Promise.resolve([_missingTextureHistory()]);
      const entries = [...(_lastFrameSampled.size ? _lastFrameSampled : _sampledThisFrame)].slice(0, 16);
      const rows = entries.map((e) => ({
        historyCaptured: true,
        label: (e._label || "?").slice(0, 30),
        wh: `${e.width}x${e.height}x${e.depth || 1}`,
        fmt: e.format,
        uploads: e._uploads || 0,
        labelUploads: (_uploadByLabel.get(e._label) || [0, 0])[0],
        upKB: Math.round((e._uploadBytes || 0) / 1024 * 0.75) // base64→bytes approx
      }));
      // Self-check: a texture we fill with opaque magenta MUST read back non-
      // transparent. If readbackSelf.nonTransp==0 the readback path is broken and
      // every nonTransp value above is untrustworthy.
      const selfCheck = (() => {
        let t;
        try {
          t = device.createTexture({size: [8, 8, 1], format: "rgba8unorm", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC});
          const d = new Uint8Array(8 * 8 * 4); for (let i = 0; i < d.length; i += 4) { d[i] = 255; d[i + 2] = 255; d[i + 3] = 255; }
          device.queue.writeTexture({texture: t}, d, {bytesPerRow: 8 * 4}, {width: 8, height: 8});
          return globalThis.mcWebGpu._readbackTex({texture: t, width: 8, height: 8}).finally(() => t.destroy());
        } catch (e) {
          t?.destroy();
          return Promise.resolve({error: "self:" + (e && e.message)});
        }
      })();
      const p = Promise.all([selfCheck, ...entries.map((e) => globalThis.mcWebGpu._readbackTex(e))]).then(([self, ...rbs]) => {
        const out = rows.map((r, i) => Object.assign({}, r, rbs[i]));
        _texDiagSnapshot = {historyCaptured: true, readbackSelf: self, rows: out, uploadByLabel: Object.fromEntries(_uploadByLabel), recentCreated: _recentCreated.slice(-24)};
        console.log("[TEX-DIAG] readbackSelf (MUST be nonTransp>0 else readback is broken):", JSON.stringify(self));
        console.log("[TEX-DIAG] uploadByLabel [uploads,bytes] (atlas gui.png uploads=0 here ⇒ atlas truly never uploaded):", JSON.stringify(Object.fromEntries(_uploadByLabel)));
        console.log("[TEX-DIAG] recentCreated (label|wh|uploads) — look for gui.png with uploads>0 that is NOT the sampled instance ⇒ stale handle):", JSON.stringify(_recentCreated.slice(-24).map((r) => ({label: (r.label || "?").slice(0, 26), wh: r.wh, uploads: r._e ? (r._e._uploads || 0) : 0}))));
        try { console.table(out); } catch {}
        console.log("[TEX-DIAG] sampled rows (uploads=inst uploads; labelUploads=total for that label; nonBlack/nonTransp from whole-tex readback):", JSON.stringify(out));
        return out;
      });
      return p;
    },
    _texDiagSnapshot: () => _textureHistoryCaptured ? _texDiagSnapshot : _missingTextureHistory(),
    _fontProbe: () => ({draws: _fontDrawRing, stats: [..._fontPassStats.values()]}),
    _atlasProbe: () => ({
      targets: Object.fromEntries(_animTargetCounts),
      gui: _guiAtlasRing,
      assemblyOffTarget: _asmBad,
      screenSpriteDraws: _scatterDraws
    }),
    _textureProbe: (needle) => {
      const query = String(needle || "").toLowerCase();
      // Read live objects even when history capture was disabled. RPC rekeys
      // change handles, while _hid retains the texture's creation identity.
      const entries = [...objects.entries()]
        .filter(([, entry]) => entry?.kind === "texture" && !entry._destroyRequested && !entry._gpuDestroyed
          && String(entry._label || "").toLowerCase().includes(query))
        .sort(([, a], [, b]) => (a._hid ?? -1) - (b._hid ?? -1));
      return Promise.all(entries.map(async ([handle, entry]) => ({
        label: entry._label,
        handle,
        creationId: entry._hid ?? null,
        historyCaptured: _textureHistoryCaptured,
        size: `${entry.width}x${entry.height}x${entry.depth || 1}`,
        format: entry.format,
        uploads: entry._uploads || 0,
        uploadBytes: entry._uploadBytes || 0,
        uploadRegions: _textureHistoryCaptured ? (entry._uploadRegions || []) : null,
        readback: await globalThis.mcWebGpu._readbackTex(entry)
      })));
    },
    _textureSamples: (needle, coords, mipLevel = 0, layer = 0) => new Promise((resolve) => {
      try {
        const query = String(needle || "").toLowerCase();
        const match = [...objects.entries()]
          .filter(([, entry]) => entry?.kind === "texture" && !entry._destroyRequested && !entry._gpuDestroyed
            && String(entry._label || "").toLowerCase().includes(query))
          .sort(([, a], [, b]) => (b._hid ?? -1) - (a._hid ?? -1))[0];
        const [handle, entry] = match || [];
        if (!entry) {
          resolve({error: "texture not found", historyCaptured: _textureHistoryCaptured});
          return;
        }
        const w = Math.max(1, entry.width >> mipLevel), h = Math.max(1, entry.height >> mipLevel);
        const bpr = Math.ceil(w * 4 / 256) * 256;
        const buffer = device.createBuffer({
          size: bpr * h,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          {texture: entry.texture, mipLevel, origin: {x: 0, y: 0, z: layer}},
          {buffer, bytesPerRow: bpr, rowsPerImage: h},
          {width: w, height: h, depthOrArrayLayers: 1}
        );
        device.queue.submit([encoder.finish()]);
        buffer.mapAsync(GPUMapMode.READ).then(() => {
          const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
          buffer.unmap();
          buffer.destroy();
          const result = (Array.isArray(coords) ? coords : []).map(([u, v]) => {
            const cx = Math.max(0, Math.min(w - 1, Math.floor(u * w)));
            const cy = Math.max(0, Math.min(h - 1, Math.floor(v * h)));
            const neighborhood = [];
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const x = Math.max(0, Math.min(w - 1, cx + dx));
              const y = Math.max(0, Math.min(h - 1, cy + dy));
              const offset = y * bpr + x * 4;
              neighborhood.push([x, y, ...bytes.slice(offset, offset + 4)]);
            }
            return {uv: [u, v], pixel: [cx, cy], neighborhood};
          });
          let minX = w, minY = h, maxX = -1, maxY = -1, nonzero = 0;
          const first = [];
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const offset = y * bpr + x * 4;
            if (bytes[offset] || bytes[offset + 1] || bytes[offset + 2] || bytes[offset + 3]) {
              nonzero++;
              minX = Math.min(minX, x); minY = Math.min(minY, y);
              maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
              if (first.length < 40) first.push([x, y, ...bytes.slice(offset, offset + 4)]);
            }
          }
          resolve({
            label: entry._label,
            handle,
            creationId: entry._hid ?? null,
            historyCaptured: _textureHistoryCaptured,
            size: [w, h],
            uploads: _textureHistoryCaptured ? (entry._uploadRegions || []) : null,
            uploadRegions: _textureHistoryCaptured ? (entry._uploadRegions || []) : null,
            nonzero,
            bounds: nonzero ? [minX, minY, maxX, maxY] : null,
            first,
            samples: result
          });
        }).catch((error) => resolve({error: "map:" + error.message, historyCaptured: _textureHistoryCaptured}));
      } catch (error) {
        resolve({error: String(error?.message || error), historyCaptured: _textureHistoryCaptured});
      }
    }),
    // DIAG: late lifetime dump. instancesPerLabel lists EVERY created texture
    // instance for labels that contain atlas/gui/font/menu/title (with each
    // instance's upload count), so we can see a sampled-but-empty instance next
    // to an uploaded one (stale handle) OR confirm the atlas label never got any
    // upload at all (upload-path gap). uploadByLabel is the global total.
    _texDiagLate: () => {
      if (!_textureHistoryCaptured) return _missingTextureHistory();
      const byLabel = {};
      for (const r of _recentCreated) {
        const k = r.label || "?";
        (byLabel[k] = byLabel[k] || []).push(r._e ? (r._e._uploads || 0) : -1);
      }
      const interesting = {};
      for (const k of Object.keys(byLabel)) {
        if (/atlas|gui|font|menu|title|widget|missing/i.test(k)) interesting[k] = {instances: byLabel[k], totalUploads: (_uploadByLabel.get(k) || [0])[0]};
      }
      const out = {historyCaptured: true, tick: globalThis.mcWebPump?.ticks || 0, interestingInstances: interesting, uploadByLabelTotals: Object.fromEntries([..._uploadByLabel.entries()].filter(([k]) => /atlas|gui|font|menu|title|widget/i.test(k)))};
      _texDiagSnapshot = out;
      // DIAG: per-handle identity check. sampled[] = textures actually bound for
      // sampling (with their upload count); uploadedNotSampled[] = textures that
      // got a writeTexture64 but were NEVER sampled. If a sampled atlas/widget
      // shows uploads=0 while an uploadedNotSampled entry shares its label => the
      // bind group samples a DIFFERENT instance than the upload (stale handle).
      const sampled = [..._sampledEntries].filter((e) => /atlas|gui|widget|title|font/.test(e._label || "")).slice(0, 40)
        .map((e) => ({label: (e._label || "?").slice(0, 24), hid: e._hid, uploads: e._uploads || 0, wh: `${e.width}x${e.height}`}));
      const sampledSet = new Set([..._sampledEntries]);
      const uploadedNotSampled = _recentCreated.filter((r) => r._e && (r._e._uploads || 0) > 0 && !sampledSet.has(r._e) && /atlas|gui|widget|title|font/.test(r.label || ""))
        .slice(0, 40).map((r) => ({label: (r.label || "?").slice(0, 24), hid: r._e._hid, uploads: r._e._uploads || 0}));
      console.log("[TEX-IDENTITY] sampled (hid:uploads) — uploads=0 on a sampled atlas/widget means the sampled instance never got data:", JSON.stringify(sampled));
      console.log("[TEX-IDENTITY] uploaded-but-NEVER-sampled (hid:uploads) — if a label here matches a sampled uploads=0 label => stale handle:", JSON.stringify(uploadedNotSampled));
      console.log("[TEX-DIAG-LATE] (frame>200) instancesPerLabel{[uploads per instance]} + totals. If a label shows instances like [0,>0] the sampled [0] one is a STALE handle; if a label is absent from totals it NEVER uploaded:", JSON.stringify(out));
      return out;
    },
    isReady: () => Boolean(device),
    textureValidationReport: () =>
      globalThis.mcWebGpu?._textureValidation ?? _textureLifetime.validationReport(),
    // On-demand logical ownership census, not driver/physical VRAM or tab memory.
    resourceLifetime: () => {
      let liveBufferCount = 0, liveBufferBytes = 0, liveShadowBytes = 0;
      let liveTextureCount = 0, textureViews = 0;
      for (const entry of objects.values()) {
        if (entry.kind === "buffer") {
          liveBufferCount++;
          liveBufferBytes += entry.size;
          liveShadowBytes += entry._shadow?.byteLength ?? 0;
        } else if (entry.kind === "texture" && !entry.isCanvas) liveTextureCount++;
        else if (entry.kind === "textureView") textureViews++;
      }
      return {
        scope: "live Java-owned host handles; excludes deferred destruction, host dummies, native driver overhead",
        pendingDestroy: _deferredDestroy.pendingCount(),
        fencedDestroy: _deferredDestroy.fencedCount(),
        fallbackBatches: _deferredDestroy.graveyardCount(),
        canvasWidth: canvas.width, canvasHeight: canvas.height,
        liveHandles: objects.size, liveBufferCount, liveBufferBytes, liveShadowBytes,
        liveTextureCount, textureViews,
        cachedBindGroups: _bindGroupCache.size,
        cachedBindGroupDependencies: _bindGroupDependencies.size,
        bindGroupEvictions: _bindGroupStats.evictions,
        ...(resourceCensusEnabled ? {pendingErrorScopes: errorScopeCensus.pending,
          maximumPendingErrorScopes: errorScopeCensus.maximumPending, errorScopesStarted: errorScopeCensus.started,
          errorScopesSettled: errorScopeCensus.settled, errorScopesRejected: errorScopeCensus.rejected} : {})
      };
    },
    // Progress history, independent of console.log: a chatty run can overflow
    // the CDP console pipe and drop exactly the failure line you need.
    stages: (count = 400) => diagnostics.stages.slice(-count),
    /** The same ring with page-relative milliseconds, newest last. */
    stageTimeline: (count = 400) => diagnostics.stages.slice(-count)
      .map((stage, index) => [diagnostics.stageMs.slice(-count)[index], stage]),
    reloadProbe: (count = 8000) => ({
      events: diagnostics.reloadProbe.slice(-count),
      threads: globalThis.mcWebThreadRuntime?.info?.() ?? null,
    }),
    canvasWidth: () => canvas.width,
    canvasHeight: () => canvas.height,
    adapterName: () =>
      adapter?.info?.description || adapter?.info?.device || "Browser WebGPU adapter",

    createTexture(label, usage, format, width, height, depth, mips) {
      markCall("createTexture", {label, usage, format, width, height, depth, mips});
      const gpuFormat = minecraftFormat(format);
      const _handle = put({
        kind: "texture",
        texture: device.createTexture({
          label,
          size: {width, height, depthOrArrayLayers: depth},
          mipLevelCount: mips,
          sampleCount: 1,
          dimension: "2d",
          format: gpuFormat,
          // Force the copy bits: Mojang's presenter blits the main target to
          // the canvas with copyTextureToTexture, but the main target is
          // created without COPY_SRC. Extra usage bits are harmless.
          usage: minecraftTextureUsage(usage) | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
        }),
        format: gpuFormat,
        width,
        height,
        depth,
        mips,
        _label: label,
        _hid: nextHandle - 1, // DIAG: stable creation identity; RPC may rekey its handle
        _uploads: 0,   // DIAG: how many writeTexture64 uploads landed on this texture
        _uploadBytes: 0,
        ...(_textureHistoryCaptured ? {_uploadRegions: []} : {})
      });
      const _entry = objects.get(_handle);
      _textureLifetime.initializeTexture(_entry);
      if (_textureHistoryCaptured) _recentCreated.push({label, wh: `${width}x${height}x${depth}`, fmt: gpuFormat, _e: _entry}); // DIAG registry
      if (_DBG && /panorama/i.test(label)) _panoProbe.created.push({ label, w: width, h: height, depth, fmt: gpuFormat, usage, hid: _entry._hid });
      return _handle;
    },

    createTextureView(textureHandle, baseMip, mipLevels, dimension) {
      markCall("createTextureView", {textureHandle, baseMip, mipLevels, dimension});
      const entry = get(textureHandle, "texture");
      const viewEntry = {
        kind: "textureView",
        view: entry.texture.createView({
          dimension,
          baseArrayLayer: 0,
          arrayLayerCount: dimension === "cube" ? 6 : dimension === "2d" ? 1 : entry.depth,
          baseMipLevel: baseMip,
          mipLevelCount: mipLevels
        }),
        textureEntry: entry,
        // Needed to tell "the atlas was stitched" from "only mip 0 was
        // stitched": TextureAtlas.upload makes one view per mip and blits into
        // each, and a distant block face samples a high mip. An unfilled mip
        // reads as uniform garbage while mip 0 still looks perfect up close.
        baseMip
      };
      _textureLifetime.retainView(entry);
      return put(viewEntry);
    },

    createSamplerJson(specJson) {
      const spec = JSON.parse(specJson);
      markCall("createSampler", spec);
      const address = (mode) => (mode === "REPEAT" ? "repeat" : "clamp-to-edge");
      const linear = (filter) => filter === "LINEAR";
      const handle = put({
        kind: "sampler",
        sampler: device.createSampler({
          addressModeU: address(spec.addressU),
          addressModeV: address(spec.addressV),
          minFilter: linear(spec.min) ? "linear" : "nearest",
          magFilter: linear(spec.mag) ? "linear" : "nearest",
          mipmapFilter: linear(spec.min) ? "linear" : "nearest",
          lodMaxClamp: spec.maxLod == null ? 32 : spec.maxLod,
          // ?mcweb_lodclamp=N (diagnostic): sample no mip level above N, to
          // tell a mip chain that was never written from bad geometry.
          ...(_lodClamp != null ? { lodMaxClamp: _lodClamp } : {})
        })
      });
      if (_DBG) (globalThis.mcWebGpu._samplerSpecs ||= []).push({handle, ...spec});
      return handle;
    },

    destroyTexture(handle) {
      const entry = get(handle, "texture");
      // The canvas texture Mojang closes each frame is the persistent virtual
      // canvas (see acquireCanvasTexture); only its handle goes away.
      if (!(entry.isCanvas && _useVirtualCanvas)) {
        evictResourceBindGroups(entry.texture);
        _textureLifetime.requestDestroy(entry);
      }
      objects.delete(handle);
    },

    destroyObject(handle) {
      const object = objects.get(handle);
      if (object) {
        evictResourceBindGroups(object.texture || object.view || object.buffer || object.sampler);
        if (object.kind === "pipeline") evictPipelineBindGroups(object);
      }
      if (object?.kind === "texture") _textureLifetime.requestDestroy(object);
      if (object?.kind === "textureView") _textureLifetime.releaseView(object);
      if (object?.kind === "buffer" && object.buffer) deferDestroyBuffer(object.buffer);
      objects.delete(handle);
    },

    createCommandEncoder() {
      markCall("createCommandEncoder");
      return put({kind: "encoder", serial: 0, openPasses: 0,
        encoder: device.createCommandEncoder({label: "Minecraft CommandEncoder"})});
    },

    createBuffer(label, usage, size) {
      markCall("createBuffer", {label, usage, size});
      if (_DBG && (usage & 256)) {
        (globalThis.mcWebGpu._texelBuffers ||= []).push({label, usage, size});
      }
      // WGSL rounds a uniform struct's size up to its alignment (16 with a
      // vec3 or vec4 member), and ensureBindGroups binds at most to the
      // buffer's end, so a block that fills its buffer at std140's un-rounded
      // size would bind short of what the translated shader declares. A texel
      // buffer is a WGSL array<u32>, whose bound range must be a multiple of 4.
      if (usage & 128) size = Math.ceil(size / 16) * 16;
      else if (usage & 256) size = Math.ceil(size / 4) * 4;
      return put({
        kind: "buffer",
        size, // retained so uniform binds can cap their inflated range to the buffer
        _label: label, // DIAG: for UBO inspection
        // DIAG: CPU mirror of buffer contents, for the UBO/vertex/index
        // decoders below. Skipped above SHADOW_LIMIT: terrain's three
        // "UberBuffer solid/cutout/translucent" are 128 MiB each, so mirroring
        // them costs ~384 MiB of JS heap for diagnostics that only ever inspect
        // small uniform and GUI buffers. Every reader is null-guarded, and the
        // two writers (writeBuffer, copyBuffer) test for it before mirroring.
        _shadow: size <= SHADOW_LIMIT ? new Uint8Array(size) : null,
        buffer: device.createBuffer({
          label,
          size,
          // ?mcweb_copysrc=1 makes every buffer readable. Uniform buffers are
          // normally UNIFORM|COPY_DST, so copyBufferToBuffer on them is a
          // validation error that leaves the destination zero-filled -- which
          // is indistinguishable from the uniform genuinely being zero, and
          // already produced one false "ProjMat is all zeros" reading.
          usage: minecraftBufferUsage(usage) | (_forceCopySrc ? GPUBufferUsage.COPY_SRC : 0)
        })
      });
    },

    destroyBuffer(handle) {
      const entry = get(handle, "buffer");
      evictResourceBindGroups(entry.buffer);
      if (entry?.buffer) deferDestroyBuffer(entry.buffer);
      objects.delete(handle);
    },

    writeBuffer64(handle, destinationOffset, base64) {
      const _bytes0 = base64ToBytes(base64);
      if (_gpuProbe) {
        noteUniformProbe(get(handle, "buffer"), handle, destinationOffset,
          _bytes0, base64 ? base64.length : 0);
      }
      markCall("writeBuffer", {handle, destinationOffset, base64Length: base64?.length});
      const _be = get(handle, "buffer");
      const _bytes = _bytes0;
      // DIAG: keep CPU shadow for UBO inspection
      if (_be._shadow && destinationOffset + _bytes.length <= _be._shadow.length) {
        _be._shadow.set(_bytes, destinationOffset);
      }
      _noteBytes(_be, "write", _bytes.length);
      _noteUploadBytes(_be._label || "?", _bytes.length);
      _orderWrite(_be.buffer);
      _hzWrite(_be.buffer, _be._label, destinationOffset, _bytes.byteLength);
      device.queue.writeBuffer(_be.buffer, destinationOffset, _bytes);
    },

    // Bytes straight from the caller, no encoding at all. The OpenJDK lane
    // hands its uploads over as a typed array, which the RPC copies once into
    // its SharedArrayBuffer; base64 cost an encode, three string copies and a
    // decode for data that was always bytes. Same body as the linear-memory
    // path, which already takes bytes.
    writeBufferBytes(handle, destinationOffset, bytes) {
      return this.writeBufferRaw(handle, destinationOffset, bytes);
    },

    // Texture counterpart of writeBufferBytes: no base64, no strings.
    writeTextureBytes(handle, bytes, mipLevel, depthOrLayer, x, y, width, height, bytesPerRow, rowsPerImage) {
      return this.writeTextureRaw(handle, bytes, mipLevel, depthOrLayer, x, y, width, height, bytesPerRow, rowsPerImage);
    },

    writeBufferText(handle, destinationOffset, text, byteLength) {
      const bytes = packedTextToBytes(text, byteLength);
      if (_gpuProbe) {
        noteUniformProbe(get(handle, "buffer"), handle, destinationOffset, bytes, byteLength);
      }
      markCall("writeBuffer", {
        handle, destinationOffset, byteLength, packedChars: text.length
      });
      const buffer = get(handle, "buffer");
      if (buffer._shadow && destinationOffset + byteLength <= buffer._shadow.length) {
        buffer._shadow.set(bytes, destinationOffset);
      }
      _noteBytes(buffer, "write", byteLength);
      _noteUploadBytes(buffer._label || "?", byteLength);
      _orderWrite(buffer.buffer);
      _hzWrite(buffer.buffer, buffer._label, destinationOffset, bytes.byteLength);
      device.queue.writeBuffer(buffer.buffer, destinationOffset, bytes);
    },

    /**
     * Typed-array upload path. WasmLM passes a view into its shared Java heap;
     * WasmGC's raw reader bridge passes the exact decoded scratch view without
     * materializing a Java String.
     */
    writeBufferRaw(handle, destinationOffset, bytes) {
      const byteLength = bytes?.byteLength ?? 0;
      const entry = get(handle, "buffer");
      // Two uniform-buffer probes used to run on every upload: a regex over
      // the label, and — for any buffer <= 256 B, which is every UBO slot —
      // a slice plus two typed-array materializations with a rounding map.
      // They answer questions from the atlas/uniform investigations, so they
      // are kept, behind the flag that asks for them.
      if (_gpuProbe) noteUniformProbe(entry, handle, destinationOffset, bytes, byteLength);
      markCall("writeBufferRaw", {handle, destinationOffset, byteLength});
      if (entry._shadow && destinationOffset + byteLength <= entry._shadow.length) {
        entry._shadow.set(bytes, destinationOffset);
      }
      _noteBytes(entry, "write", byteLength);
      _noteUploadBytes(entry._label || "?", byteLength);
      _orderWrite(entry.buffer);
      _hzWrite(entry.buffer, entry._label, destinationOffset, bytes.byteLength);
      device.queue.writeBuffer(entry.buffer, destinationOffset, bytes);
    },

    writeTexture64(handle, base64, mipLevel, depthOrLayer, x, y, width, height, bytesPerRow, rowsPerImage) {
      markCall("writeTexture", {handle, mipLevel, depthOrLayer, x, y, width, height, bytesPerRow, rowsPerImage, base64Length: base64?.length});
      const _te = get(handle, "texture");
      _te._uploads = (_te._uploads || 0) + 1;            // DIAG
      // Survives destroyTexture: records that a label was written at all, and
      // on which handle. If an atlas shows writes here but the handle terrain
      // samples has none, the upload landed on a since-replaced instance --
      // the "stale handle" case the probe below was written to catch.
      if (_textureHistoryCaptured) {
        const wl = (globalThis.mcWebGpu._texWriteLog ||= {});
        const key = (_te._label || "?");
        const rec = (wl[key] ||= {writes: 0, handles: []});
        rec.writes++;
        if (!rec.handles.includes(handle)) rec.handles.push(handle);
      }
      _te._uploadBytes = (_te._uploadBytes || 0) + (base64 ? base64.length : 0); // DIAG (base64 len ∝ bytes)
      if (_textureHistoryCaptured && _te._uploadRegions.length < 100) {
        _te._uploadRegions.push({mipLevel, depthOrLayer, x, y, width, height, bytesPerRow, rowsPerImage});
      }
      if (_textureHistoryCaptured) { const _k = _te._label || "?"; const _u = _uploadByLabel.get(_k) || [0, 0]; _u[0]++; _u[1] += base64 ? base64.length : 0; _uploadByLabel.set(_k, _u); } // DIAG
      if (_DBG && /panorama/i.test(_te._label)) _panoProbe.uploads.push({ hid: _te._hid, label: _te._label, layer: depthOrLayer, w: width, h: height, mip: mipLevel, b64len: base64 ? base64.length : 0 });
      _orderWrite(_te.texture);
      device.queue.writeTexture(
        {texture: _te.texture, mipLevel, origin: {x, y, z: depthOrLayer}},
        base64ToBytes(base64),
        {bytesPerRow, rowsPerImage},
        {width, height, depthOrArrayLayers: 1}
      );
    },

    /** WasmLM texture upload: consume the shared linear-memory view directly. */
    writeTextureRaw(handle, bytes, mipLevel, depthOrLayer, x, y, width, height, bytesPerRow, rowsPerImage) {
      const byteLength = bytes?.byteLength ?? 0;
      markCall("writeTextureRaw", {handle, mipLevel, depthOrLayer, x, y, width, height, bytesPerRow, rowsPerImage, byteLength});
      const _te = get(handle, "texture");
      _te._uploads = (_te._uploads || 0) + 1;
      if (_textureHistoryCaptured) {
        const wl = (globalThis.mcWebGpu._texWriteLog ||= {});
        const key = (_te._label || "?");
        const rec = (wl[key] ||= {writes: 0, handles: []});
        rec.writes++;
        if (!rec.handles.includes(handle)) rec.handles.push(handle);
      }
      _te._uploadBytes = (_te._uploadBytes || 0) + byteLength;
      if (_textureHistoryCaptured && _te._uploadRegions.length < 100) {
        _te._uploadRegions.push({mipLevel, depthOrLayer, x, y, width, height, bytesPerRow, rowsPerImage});
      }
      if (_textureHistoryCaptured) { const _k = _te._label || "?"; const _u = _uploadByLabel.get(_k) || [0, 0]; _u[0]++; _u[1] += byteLength; _uploadByLabel.set(_k, _u); }
      if (_DBG && /panorama/i.test(_te._label)) _panoProbe.uploads.push({hid: _te._hid, label: _te._label, layer: depthOrLayer, w: width, h: height, mip: mipLevel, byteLength});
      // ?mcweb_uploaddiag=<label substring> (diagnostic): what actually arrives
      // for matching textures - opaque texels in the bytes handed to
      // queue.writeTexture, which runs at once, ahead of any recorded command.
      if (_uploadDiag && (_te._label || "").includes(_uploadDiag)) {
        let opaque = 0;
        for (let i = 3; i < bytes.length; i += 4) if (bytes[i] !== 0) opaque++;
        console.log(`[UPLOAD-DIAG] write ${_te._label} hid=${_te._hid} mip=${mipLevel} ${x},${y} ${width}x${height} bpr=${bytesPerRow} bytes=${byteLength} opaque=${opaque}`);
      }
      _orderWrite(_te.texture);
      device.queue.writeTexture(
        {texture: _te.texture, mipLevel, origin: {x, y, z: depthOrLayer}},
        bytes,
        {bytesPerRow, rowsPerImage},
        {width, height, depthOrArrayLayers: 1}
      );
    },

    clearColorTexture(encoderHandle, textureHandle, r, g, b, a) {
      const encoderEntry = get(encoderHandle, "command encoder");
      const entry = get(textureHandle, "texture");
      if (_uploadDiag) {
        const _ce = get(textureHandle, "texture");
        if ((_ce._label || "").includes(_uploadDiag)) {
          console.log(`[UPLOAD-DIAG] clear(recorded) ${_ce._label} hid=${_ce._hid} uploadsSoFar=${_ce._uploads || 0}`);
        }
      }
      clearSubresources(encoderEntry, entry, {r, g, b, a}, null, 0);
    },

    clearColorAndDepth(encoderHandle, colorHandle, r, g, b, a, depthHandle, depth) {
      const encoderEntry = get(encoderHandle, "command encoder");
      clearSubresources(encoderEntry, get(colorHandle, "texture"), {r, g, b, a},
        get(depthHandle, "texture"), depth);
    },

    clearColorAndDepthRegion(
      encoderHandle,
      colorHandle,
      r,
      g,
      b,
      a,
      depthHandle,
      depth,
      x,
      y,
      width,
      height,
      mipLevel = 0
    ) {
      const encoderEntry = get(encoderHandle, "command encoder");
      const encoder = encoderEntry.encoder;
      const colorEntry = get(colorHandle, "texture");
      const depthEntry = get(depthHandle, "texture");
      _markResourceUse(encoderEntry, colorEntry.texture);
      _markResourceUse(encoderEntry, depthEntry.texture);
      const mipWidth = Math.max(1, colorEntry.width >> mipLevel);
      const mipHeight = Math.max(1, colorEntry.height >> mipLevel);
      const left = Math.max(0, x), bottom = Math.max(0, y);
      const clearWidth = Math.max(0, Math.min(x + width, mipWidth) - left);
      const clearHeight = Math.max(0, Math.min(y + height, mipHeight) - bottom);
      if (!clearWidth || !clearHeight) return;
      const colorFormat = colorEntry.format || "rgba8unorm";
      const depthFormat = depthEntry.format || "depth32float";
      const values = [r, g, b, a, depth].map((value) => Number(value).toFixed(8));
      const key = `${colorFormat}|${depthFormat}|${values.join("|")}`;
      let pipeline = regionClearPipelines.get(key);
      if (!pipeline) {
        const module = device.createShaderModule({
          label: "Minecraft regional color/depth clear",
          code: `
struct ClearOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}

@fragment
fn fs_main() -> ClearOutput {
  var output: ClearOutput;
  output.color = vec4<f32>(${values.slice(0, 4).join(", ")});
  output.depth = ${values[4]};
  return output;
}`
        });
        pipeline = device.createRenderPipeline({
          label: "Minecraft regional color/depth clear",
          layout: "auto",
          vertex: {module, entryPoint: "vs_main"},
          fragment: {
            module,
            entryPoint: "fs_main",
            targets: [{format: colorFormat}]
          },
          primitive: {topology: "triangle-list"},
          depthStencil: {
            format: depthFormat,
            depthWriteEnabled: true,
            depthCompare: "always"
          }
        });
        regionClearPipelines.set(key, pipeline);
      }

      const pass = encoder.beginRenderPass({
        label: "Minecraft clearColorAndDepthRegion",
        colorAttachments: [{
          view: clearAttachmentView(colorEntry.texture, mipLevel, 0),
          loadOp: "load",
          storeOp: "store"
        }],
        depthStencilAttachment: {
          view: clearAttachmentView(depthEntry.texture, mipLevel, 0),
          depthLoadOp: "load",
          depthStoreOp: "store"
        }
      });
      // Minecraft gives OpenGL's bottom-left origin, and render targets hold
      // GL's memory layout (row 0 = bottom), so the rectangle needs no flip.
      pass.setScissorRect(
        left,
        bottom,
        clearWidth,
        clearHeight
      );
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
    },

    clearDepth(encoderHandle, textureHandle, depth) {
      if (_drawCensus) (globalThis.mcWebGpu._depthClears ||= {})["clearDepth:" + depth] =
        ((globalThis.mcWebGpu._depthClears || {})["clearDepth:" + depth] || 0) + 1;
      const encoderEntry = get(encoderHandle, "command encoder");
      clearSubresources(encoderEntry, null, null, get(textureHandle, "texture"), depth);
    },

    copyTexture(encoderHandle, sourceHandle, destinationHandle,
                sourceX, sourceY, destinationX, destinationY,
                width, height, mipLevel) {
      const encoderEntry = get(encoderHandle, "command encoder");
      const encoder = encoderEntry.encoder;
      const source = get(sourceHandle, "source texture");
      const destination = get(destinationHandle, "destination texture");
      destination._copiesIn = (destination._copiesIn || 0) + 1;
      source._copiesOut = (source._copiesOut || 0) + 1;
      // Clamp to what actually remains in each texture from its own origin. The
      // offsets used to be dropped entirely, which silently turned every
      // sub-rectangle blit into a copy of the top-left corner; the mip level was
      // dropped with them, so mip blits overwrote mip 0.
      const mip = Math.max(0, mipLevel | 0);
      const sx = Math.max(0, sourceX | 0);
      const sy = Math.max(0, sourceY | 0);
      const dx = Math.max(0, destinationX | 0);
      const dy = Math.max(0, destinationY | 0);
      const mipExtent = (size) => Math.max(1, (size ?? 0) >> mip);
      const w = Math.max(0, Math.min(
        width,
        mipExtent(source.width) - sx,
        mipExtent(destination.width) - dx
      ));
      const h = Math.max(0, Math.min(
        height,
        mipExtent(source.height) - sy,
        mipExtent(destination.height) - dy
      ));
      if (!w || !h) return;
      _markResourceUse(encoderEntry, source.texture);
      _markResourceUse(encoderEntry, destination.texture);
      encoder.copyTextureToTexture(
        {texture: source.texture, mipLevel: mip, origin: {x: sx, y: sy, z: 0}},
        {texture: destination.texture, mipLevel: mip, origin: {x: dx, y: dy, z: 0}},
        {width: w, height: h, depthOrArrayLayers: 1}
      );
    },

    copyBuffer(encoderHandle, sourceHandle, sourceOffset, destinationHandle, destinationOffset, size) {
      const encoderEntry = get(encoderHandle, "command encoder");
      const encoder = encoderEntry.encoder;
      const source = get(sourceHandle, "source buffer");
      const destination = get(destinationHandle, "destination buffer");
      if (/Auto Storage/i.test(destination?._label || "")) {
        const r = (globalThis.mcWebGpu._autoIndexWrites ||= {writeBuffer: 0, bytes: 0, copies: 0});
        r.copies++;
      }
      // Keep the diagnostic CPU mirror coherent with the GPU copy. Persistent
      // GUI/text vertex buffers are filled from transient staging buffers, so
      // inspecting only queue.writeBuffer calls otherwise reports misleading
      // all-zero destination vertices.
      if (source._shadow && destination._shadow
          && sourceOffset >= 0 && destinationOffset >= 0
          && sourceOffset + size <= source._shadow.length
          && destinationOffset + size <= destination._shadow.length) {
        destination._shadow.set(
          source._shadow.subarray(sourceOffset, sourceOffset + size),
          destinationOffset
        );
      }
      _noteBytes(destination, "copy", size);
      _hzUse(encoder, source.buffer, sourceOffset, size);
      // A recorded copy reads its source and writes its destination later
      // than any queue.writeBuffer issued before the submit: order both.
      if (_ordered) {
        source.buffer._mcEnc = destination.buffer._mcEnc = encoderEntry;
        source.buffer._mcSer = destination.buffer._mcSer = encoderEntry.serial;
      }
      encoder.copyBufferToBuffer(
        source.buffer,
        sourceOffset,
        destination.buffer,
        destinationOffset,
        size
      );
    },

    submit(encoderHandle) {
      markCall("submit", {encoderHandle});
      const entry = get(encoderHandle, "command encoder");
      // Error scopes resolve asynchronously. Freeze the candidate view, its
      // parent state, the call tail, and the RPC batch at this submit boundary
      // so a later frame cannot overwrite the evidence before the scope pops.
      const validationCandidate = deferTextureValidation();
      _lastSubmitTextureCandidate = validationCandidate;
      const gpuSubmitStarted = _perf.on ? performance.now() : 0;
      // Validation errors poison the device; capture them per submit so the
      // first offending command is reported before the device is lost.
      if (typeof device.pushErrorScope === "function") {
        device.pushErrorScope("validation");
        device.pushErrorScope("out-of-memory");
      }
      if (_hz) _hz.pending.delete(entry.encoder);
      entry.serial = (entry.serial | 0) + 1;
      device.queue.submit([entry.encoder.finish()]);
      entry.encoder = null;
      if (_perf.on && typeof device.queue.onSubmittedWorkDone === "function") {
        _perf.gpuSubmits++;
        device.queue.onSubmittedWorkDone().then(() => {
          _perf.gpuQueueMs.push(performance.now() - gpuSubmitStarted);
        }).catch(() => {});
      }
      // Attach everything queued since the prior submit to this submission's
      // completion fence before releasing the underlying GPU objects.
      flushGraveyard();
      if (typeof device.popErrorScope === "function") {
        const onScopeError = (label) => (error) => {
          if (error) {
            const msg = `[WebGPU ${label}] ${error.message}`;
            noteTextureValidation(msg, validationCandidate);
            console.error(msg);
            if (!globalThis.mcWebGpu._firstGpuError) {
              globalThis.mcWebGpu._firstGpuError = msg;
            }
            // DIAG: keep the first N validation messages UN-deduplicated so the
            // ROOT error (e.g. a createBindGroup "too small"/overrun) is visible
            // and not hidden behind later "invalid due to a previous error"
            // cascades. Queryable via globalThis.mcWebGpu._valErrors.
            const ve = (globalThis.mcWebGpu._valErrors ||= []);
            if (ve.length < 16) ve.push(msg.slice(0, 400));
          }
        };
        // "Instance dropped" rejections are benign (headless SwiftShader
        // quirk, or device torn down at process exit); swallow them quietly.
        const swallowDropped = () => {};
        popTrackedErrorScope().then(onScopeError("oom"), swallowDropped);
        popTrackedErrorScope().then(onScopeError("validation"), swallowDropped);
      }
      objects.delete(encoderHandle);
    },

    createPipeline(specJson, materialize = false) {
      const spec = JSON.parse(specJson);
      if (deferPipelines && !materialize) {
        return put({kind: "pipeline", spec, deferredSpec: specJson});
      }
      // How many pipelines arrive with their GLSL (docs/SHADERS-PLAN.md, stage S4);
      // counts only, never the text.
      const sourceStats = (globalThis.mcWebGpu._shaderSourceStats ||= { pipelines: 0, withText: 0 });
      sourceStats.pipelines++;
      if (spec.vertexSource && spec.fragmentSource) sourceStats.withText++;
      if (sourceStats.pipelines % 25 === 0) {
        console.log(`[shader] pipelines ${sourceStats.pipelines}, with GLSL ${sourceStats.withText}`);
      }
      if (_DBG || _drawCensus) (globalThis.mcWebGpu._pipelineSpecs ||= {})[spec.label] = {
        vertexShader: spec.vertexShader,
        fragmentShader: spec.fragmentShader,
        defines: spec.defines,
        uniforms: (spec.bindGroups || []).flatMap((g) => g.uniforms || []),
        samplers: (spec.bindGroups || []).flatMap((g) => g.samplers || []),
        vertexElements: (spec.vertexFormats?.[0]?.elements || []).map((e) => e.name),
      };
      if ((_DBG || _drawCensus) && /entity|item_|transparency/.test(spec.label || "")) {
        (globalThis.mcWebGpu._rawPipelineSpecs ||= {})[spec.label] = spec;
      }
      // DIAG: what depth state each pipeline declares, and what it resolves to.
      // COMPARE_OP silently falls back to "less-equal" for any name it does not
      // know, which under Mojang's reverse-Z projection (near maps to 1, far to
      // 0) rejects every fragment against a 0.0 depth clear -- invisible
      // geometry with correct draw calls and no validation error.
      if (_drawCensus) (globalThis.mcWebGpu._pipelineDepth ||= {})[spec.label] = spec.depthStencil
        ? {
            declared: spec.depthStencil.depthTest,
            resolved: COMPARE_OP[spec.depthStencil.depthTest] || "less-equal(FALLBACK)",
            write: spec.depthStencil.writeDepth
          }
        : null;
      if (_DBG && /panorama/i.test(spec.label)) _panoProbe.pipeBegin.push({ label: spec.label, vs: spec.vertexShader, topo: spec.topology });
      markCall("createPipeline", {label: spec.label});
      // Both depth-attachment variants of one pipeline, drawn with `stages`
      // (translated, or the error shader).
      const buildVariants = (stages) => {
        // For pipelines whose spec declares no depth state, the natural base is
        // the NO-depth pipeline; the depth variant is the alt below. (Passing
        // the default would synthesize depth into the base and leave the
        // no-depth pass unmatched.) Pipelines with depthStencil keep the default.
        // pipelineDepthVariants drops the no-depth variant where WebGPU
        // would reject it.
        const [baseDepthArg, ...altDepths] = pipelineDepthVariants(spec,
          !pipelineColorTargets(spec).length, !!stages.fragDepth);
        const built = buildPipeline(spec, baseDepthArg, stages);
        // Pre-build the *other* depth attachment state up front so rpSetPipeline
        // can pick an exact match by direct lookup (the lazy variant path raced
        // the cached base handle and left the no-depth pipeline bound in a
        // depth pass). Map key null = no depth attachment.
        const byDepth = new Map();
        byDepth.set(built.depthFormat, built.pipeline);
        for (const altDepth of (deferDepthVariants ? [] : altDepths)) {
          if (byDepth.has(altDepth)) continue;
          try {
            const alt = buildPipeline(spec, altDepth, stages);
            byDepth.set(alt.depthFormat, alt.pipeline);
          } catch (altError) {
            recordStage(`pipeline-alt-failed:${spec.label}:${altError.message}`);
          }
        }
        return {built, byDepth};
      };
      // The error shader's variants; it logs (once per label) when even those
      // fail validation, and stays: there is nothing further to fall back to.
      const errorVariants = () => {
        const stages = errorStages(spec);
        const variants = buildVariants(stages);
        Promise.all(stages.pipelineErrors).then((errors) => {
          const first = errors.find(Boolean);
          if (first) _shaderOut(`[shader] ${spec.label} error-pipeline: ${String(first.message || "").split("\n")[0]}`);
        }).catch(() => {});
        return variants;
      };
      try {
        // The game's own GLSL, translated; on any failure, the error shader.
        let stages = null;
        try {
          stages = translatePipeline(spec);
        } catch (txError) {
          shaderFailure(spec.label, "host", txError && txError.message || txError);
        }
        let variants = null;
        if (stages) {
          try {
            variants = buildVariants(stages);
          } catch (txError) {
            shaderFailure(spec.label, "pipeline", txError && txError.message || txError);
            stages = null;
          }
        }
        _translateStats.pipelines++;
        if (stages) _translateStats.translated++; else _translateStats.failed++;
        if (_translateStats.pipelines % 25 === 0) shaderSummary();
        if (!stages) variants = errorVariants();
        const {built, byDepth} = variants;
        recordStage(`pipeline-ok:${spec.label}`);
        if (_DBG && /panorama/i.test(spec.label)) _panoProbe.pipeOk.push(spec.label);
        const entry = {kind: "pipeline", ...built, byDepth};
        const handle = put(entry);
        if (stages) {
          // Compilation and pipeline validation report asynchronously. On the
          // first error, swap this handle's pipelines for the error shader's
          // in place (Java keeps the handle).
          Promise.all([...stages.compileErrors, ...stages.pipelineErrors]).then((errors) => {
            const first = errors.find(Boolean);
            if (!first || entry.stages !== stages) return;
            shaderFailure(spec.label, first.stage, first.message);
            _translateStats.translated--;
            _translateStats.failed++;
            shaderSummary();
            let fallback = null;
            try {
              fallback = errorVariants();
            } catch (errorShaderError) {
              recordStage(`pipeline-failed:${spec.label}:${errorShaderError.message}`);
              _shaderOut(`[shader] ${spec.label} error-pipeline: ${errorShaderError.message}`);
              return;
            }
            evictPipelineBindGroups(entry);
            entry.variants = undefined;
            Object.assign(entry, fallback.built, {byDepth: fallback.byDepth});
          }).catch(() => {});
        }
        return handle;
      } catch (error) {
        recordStage(`pipeline-failed:${spec.label}:${error.message}`);
        if (_DBG && /panorama/i.test(spec.label)) _panoProbe.pipeFail.push(spec.label + ":" + error.message);
        console.warn("pipeline failed:", spec.label, error);
        return 0;
      }
    },

    beginRenderPass(encoderHandle, descriptorJson) {
      const descriptor = JSON.parse(descriptorJson);
      markCall("beginRenderPass", descriptor);
      const encoderEntry = get(encoderHandle, "command encoder");
      const encoder = encoderEntry.encoder;
      const colorAttachments = descriptor.color.map((attachment) => {
        if (!attachment) return null;
        const viewEntry = get(attachment.view, "texture view");
        _textureLifetime.noteViewUse(attachment.view, viewEntry);
        _markResourceUse(encoderEntry, viewEntry.textureEntry.texture);
        const gpuAttachment = {
          view: viewEntry.view,
          storeOp: "store"
        };
        if (attachment.clear) {
          gpuAttachment.loadOp = "clear";
          gpuAttachment.clearValue = {
            r: attachment.clear[0],
            g: attachment.clear[1],
            b: attachment.clear[2],
            a: attachment.clear[3]
          };
        } else {
          gpuAttachment.loadOp = "load";
        }
        return gpuAttachment;
      });
      // Render-target census. 26.2 fills an atlas by *drawing* sprites into it,
      // so neither _uploads (writeTexture) nor _copiesIn (copyTexture) counts
      // that path -- an atlas can read 0/0 and still be fully populated, or
      // 0/0 and never touched, and those look identical without this. Keyed by
      // the colour attachment's texture label.
      if (_drawCensus || _textureHistoryCaptured) {
        const census = (globalThis.mcWebGpu._renderTargets ||= {});
        for (const attachment of descriptor.color) {
          if (!attachment) continue;
          const viewEntry = get(attachment.view, "texture view");
          const label = String(viewEntry.textureEntry?._label ?? "?")
            + " mip" + (viewEntry.baseMip ?? 0);
          const record = (census[label] ||= {passes: 0, draws: 0, cleared: 0});
          record.passes++;
          if (attachment.clear) record.cleared++;
        }
      }
      const passDescriptor = {label: "Minecraft render pass", colorAttachments};
      let depthFormat = null;
      if (descriptor.depth) {
        const viewEntry = get(descriptor.depth.view, "texture view");
        _textureLifetime.noteViewUse(descriptor.depth.view, viewEntry);
        _markResourceUse(encoderEntry, viewEntry.textureEntry.texture);
        depthFormat = viewEntry.textureEntry.format || "depth32float";
        const hasStencil = depthFormat.includes("stencil");
        passDescriptor.depthStencilAttachment = {
          view: viewEntry.view,
          depthStoreOp: "store",
          // Stencil ops only for stencil-bearing formats.
          ...(hasStencil ? {stencilStoreOp: "store"} : {})
        };
        if (descriptor.depth.clear != null) {
          passDescriptor.depthStencilAttachment.depthLoadOp = "clear";
          passDescriptor.depthStencilAttachment.depthClearValue = descriptor.depth.clear;
          if (_drawCensus) (globalThis.mcWebGpu._depthClears ||= {})[String(descriptor.depth.clear)] =
            ((globalThis.mcWebGpu._depthClears || {})[String(descriptor.depth.clear)] || 0) + 1;
          if (hasStencil) {
            passDescriptor.depthStencilAttachment.stencilLoadOp = "clear";
            passDescriptor.depthStencilAttachment.stencilClearValue = 0;
          }
        } else {
          passDescriptor.depthStencilAttachment.depthLoadOp = "load";
          if (hasStencil) passDescriptor.depthStencilAttachment.stencilLoadOp = "load";
        }
      }
      const pass = encoder.beginRenderPass(passDescriptor);
      encoderEntry.openPasses = (encoderEntry.openPasses | 0) + 1;
      const firstColor = descriptor.color.find((a) => a) || null;
      const firstColorView = firstColor ? get(firstColor.view, "texture view") : null;
      const firstColorEntry = firstColorView?.textureEntry ?? null;
      const sizeView = firstColorView || (descriptor.depth ? get(descriptor.depth.view, "texture view") : null);
      const width = sizeView ? Math.max(1, sizeView.textureEntry.width >> sizeView.baseMip) : canvas.width;
      const height = sizeView ? Math.max(1, sizeView.textureEntry.height >> sizeView.baseMip) : canvas.height;
      // The scene main target is whichever non-canvas target the frame draws to
      // most (the GUI/title render), NOT the largest by area. Count draws per
      // target this frame and choose at present() time.
      let passState_tid = 0;
      if (firstColorEntry && !firstColorEntry.isCanvas) {
        if (firstColorEntry._tid == null) { firstColorEntry._tid = ++texSeq; texInventory.push(firstColorEntry); }
        passState_tid = firstColorEntry._tid;
      } else {
        passState_tid = firstColorEntry && firstColorEntry.isCanvas ? -1 : 0;
      }
      return put({
        kind: "renderPass",
        pass,
        // Retained so the depth attachment can be snapshotted the instant the
        // world pass ends. Reading it at end of frame is useless: GUI passes
        // clear depth (clearDepth:0 fires 6495 times a run), so a late read
        // always shows the cleared value and hides whether terrain ever wrote.
        _encoder: encoder,
        _encoderEntry: encoderEntry,
        _depthEntry: descriptor.depth ? get(descriptor.depth.view, "texture view").textureEntry : null,
        _sawTerrain: false,
        width,
        height,
        depthFormat,
        area: descriptor.area || null,
        _tid: passState_tid,
        _drawn: 0,
        pipeline: null,
        resources: new Map(),
        drawTexBinds: [], // positional texture binds this draw (name-independent fallback)
        vertexBuffers: [],
        indexBuffer: null,
        boundVertexBuffers: [],
        boundIndexBuffer: null,
        boundIndexFormat: null,
        boundGroups: [],
        bindGroupScratch: null,
        // Dynamic uniform offsets last set per pipeline-wide position, created
        // by the first dynamic-offset bind in this pass (ensureBindGroups).
        boundOffsets: null,
        // DIAG: render target identity for atlas-assembly debugging
        _targetLabel: firstColorEntry
          ? firstColorEntry._label + " mip" + (get(firstColor.view, "texture view").baseMip ?? 0)
          : null,
        _targetWH: firstColorEntry ? (firstColorEntry.width + "x" + firstColorEntry.height) : null,
        _targetTid: firstColorEntry ? firstColorEntry._tid : null,
        // Ordered pass trace for ?mcweb_drawcensus. Terrain drawing into the
        // right target and still not appearing points at frame order: a later
        // pass that clears the same attachment would erase it.
        _traceEntry: _drawCensus
          ? (() => {
              const entry = {
                target: firstColorEntry ? String(firstColorEntry._label) : "?",
                clear: !!(firstColor && firstColor.clear), draws: 0,
                // Depth state matters as much as colour here: sky draws with
                // no depth test, terrain is depth-tested, so a depth buffer
                // that is never cleared rejects every terrain fragment while
                // the sky still shows.
                depth: descriptor.depth
                  ? (descriptor.depth.clear != null ? "clear" + descriptor.depth.clear : "load")
                  : "none",
              };
              _framePassTrace.push(entry);
              return entry;
            })()
          : null,
        _scissor: null
      });
    },

    rpEnd(passHandle) {
      if (_renderCommandReplayDepth === 0) markCall("rpEnd", {passHandle});
      const state = passState(passHandle);
      state.pass.end();
      if (state._encoderEntry) state._encoderEntry.openPasses--;
      if (state._drawn && globalThis.mcWebGpu._renderTargets) {
        const record = globalThis.mcWebGpu._renderTargets[state._targetLabel ?? "?"];
        if (record) record.draws += state._drawn;
      }
      // Capture a pass that actually drew a lot of terrain, not merely the
      // first pass that bound a terrain pipeline: terrain does not start
      // drawing until ~tick 2425, so an early pass yields an all-zero depth
      // buffer that proves nothing. Record the draw count so an all-zero
      // result can be told apart from an empty pass.
      if (state._sawTerrain) {
        // Census first: how many draws a terrain pass really carries, whether
        // it has a depth attachment at all, and at which ticks. The previous
        // threshold of 50 draws never triggered -- terrain draws ~36 times per
        // frame split across passes -- so the "no depth captured" result said
        // nothing about the renderer.
        const c = (globalThis.mcWebGpu._terrainPassCensus ||= {
          passes: 0, totalDraws: 0, maxDraws: 0, withDepth: 0, firstTick: null, lastTick: null
        });
        c.passes++;
        c.totalDraws += state._drawn;
        c.maxDraws = Math.max(c.maxDraws, state._drawn);
        if (state._depthEntry) c.withDepth++;
        const tick = globalThis.mcWebPump?.ticks || 0;
        if (c.firstTick == null) c.firstTick = tick;
        c.lastTick = tick;
      }
      if (_drawCensus && state._sawTerrain && state._depthEntry && !_depthSnapshot
          && state._drawn >= 5) {
        const tex = state._depthEntry;
        const bytesPerRow = Math.ceil(tex.width * 4 / 256) * 256;
        try {
          _depthSnapshot = {
            buffer: device.createBuffer({
              size: bytesPerRow * tex.height,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
            }),
            bytesPerRow, width: tex.width, height: tex.height, label: tex._label,
            drawn: state._drawn, tick: globalThis.mcWebPump?.ticks || 0
          };
          state._encoder.copyTextureToBuffer(
            {texture: tex.texture, aspect: "depth-only"},
            {buffer: _depthSnapshot.buffer, bytesPerRow, rowsPerImage: tex.height},
            {width: tex.width, height: tex.height, depthOrArrayLayers: 1}
          );
        } catch (error) {
          _depthSnapshot = {error: String(error).slice(0, 200)};
        }
      }
      // Uniform snapshot, taken the same way the depth snapshot is: with the
      // pass's own encoder, immediately after pass.end(), so the bytes are the
      // ones this submission used. Reading a uniform buffer at present() time
      // measures a recycled ring buffer and reports zeros for every pipeline,
      // including ones that visibly render.
      if (_drawCensus && state._sawTerrain && !_uniformSnapshot
          && globalThis.mcWebGpu._terrainDrawSample?.projection) {
        const range = globalThis.mcWebGpu._terrainDrawSample.projection;
        const entry = objects.get(range.bufferHandle);
        if (entry && entry.buffer) {
          try {
            _uniformSnapshot = {
              buffer: device.createBuffer({
                size: 64,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
              }),
              drawn: state._drawn
            };
            state._encoder.copyBufferToBuffer(entry.buffer, range.offset,
              _uniformSnapshot.buffer, 0, 64);
          } catch (error) {
            _uniformSnapshot = {error: String(error).slice(0, 160)};
          }
        }
      }
      if (_drawCensus && state._sawVisible && !_visibleUniformSnapshot
          && globalThis.mcWebGpu._visibleProjRange) {
        const range = globalThis.mcWebGpu._visibleProjRange;
        const entry = objects.get(range.bufferHandle);
        if (entry && entry.buffer) {
          try {
            _visibleUniformSnapshot = {
              buffer: device.createBuffer({
                size: 64,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
              }),
              drawn: state._drawn
            };
            state._encoder.copyBufferToBuffer(entry.buffer, range.offset,
              _visibleUniformSnapshot.buffer, 0, 64);
          } catch (error) {
            _visibleUniformSnapshot = {error: String(error).slice(0, 160)};
          }
        }
      }
      // Track canvas passes (_tid === -1) separately: Mojang draws the splash
      // straight to the canvas, so when the canvas is the last-drawn target we
      // must NOT composite (it would overwrite Mojang's correct output).
      if (state._tid === -1 && state._drawn) {
        frameLastTid = -1;
        frameLastIsCanvas = true;
      }
      if (state._tid > 0 && state._drawn) {
        frameDraws.set(state._tid, (frameDraws.get(state._tid) || 0) + state._drawn);
        // Stamp draw order for non-canvas targets.
        state._seq = ++drawSeq;
        frameDrawSeq.set(state._tid, state._seq);
        frameLastTid = state._tid;
        // A non-canvas target drawn after any canvas pass means Mojang is NOT
        // presenting to the canvas directly (title screen renders offscreen).
        frameLastIsCanvas = false;
      }
      objects.delete(passHandle);
    },

    rpSetPipeline(passHandle, pipelineHandle) {
      if (_renderCommandReplayDepth === 0) {
        markCall("rpSetPipeline", {passHandle, pipelineHandle});
      }
      const state = passState(passHandle);
      if (!pipelineHandle) {
        state.pipeline = null;
        return;
      }
      let entry = get(pipelineHandle, "pipeline");
      if (entry.deferredSpec) {
        const handle = globalThis.mcWebGpu.createPipeline(entry.deferredSpec, true);
        if (!handle) throw new Error("Deferred pipeline failed: " + entry.spec.label);
        entry = get(handle, "pipeline");
        objects.set(pipelineHandle, entry);
        objects.delete(handle);
      }
      const passDepth = state.depthFormat || null;
      // Pick the pre-built pipeline whose depth attachment matches this pass
      // (createPipeline built both states into entry.byDepth). Direct lookup,
      // no lazy caching race. Fall back to a just-in-time build for any depth
      // format not pre-built (e.g. depth24plus-stencil8), then to the base.
      let chosen = entry.byDepth?.get(passDepth);
      let chosenDepth = passDepth;
      if (!chosen && (passDepth || deferDepthVariants)) {
        let lazy = entry.variants?.get(passDepth);
        if (!lazy) {
          try {
            const built = buildPipeline(entry.spec, passDepth, entry.stages);
            if (built) {
              lazy = {pipeline: built.pipeline, depthFormat: passDepth};
              (entry.variants ??= new Map()).set(passDepth, lazy);
              recordStage(`depth-variant-ok:${entry.spec.label}:${passDepth}`);
            }
          } catch (error) {
            recordStage(`depth-variant-failed:${entry.spec.label}:${error.message}`);
          }
        }
        if (lazy) { chosen = lazy.pipeline; chosenDepth = lazy.depthFormat; }
      }
      if (!chosen) { chosen = entry.pipeline; chosenDepth = entry.depthFormat; }
      if (_DBG && entry.spec && /panorama/i.test(entry.spec.label)) _panoProbe.set++;
      if (_DBG && entry.spec && /blit|interpolate|panorama|sky|stars/.test(entry.spec.label) && (_rpDbgN = (_rpDbgN || 0) + 1) <= 6) {
        console.log("[rpSetPipeline-dbg]", entry.spec.label, "passDepth=", String(passDepth),
          "byDepthKeys=", JSON.stringify([...(entry.byDepth?.keys() || [])].map((k) => String(k))),
          "variantsKeys=", JSON.stringify([...(entry.variants?.keys() || [])].map((k) => String(k))),
          "chosenDepth=", String(chosenDepth),
          "entryDepth=", String(entry.depthFormat));
      }
      if (/terrain/.test(entry.spec?.label || "")) state._sawTerrain = true;
      // Control: a pipeline whose output is visible on screen, sampled the
      // same way, so "terrain's projection is zero" can be told apart from
      // "every projection reads zero".
      if (_drawCensus && /\/(sky|celestial)$/.test(entry.spec?.label || "")) {
        state._sawVisible = true;
        const r = state.resources.get("Projection");
        if (r && !globalThis.mcWebGpu._visibleProjRange) {
          globalThis.mcWebGpu._visibleProjRange =
            {bufferHandle: r.bufferHandle, offset: r.offset, size: r.size};
        }
      }
      state.pipeline = {...entry, pipeline: chosen, depthFormat: chosenDepth};
      // ?mcweb_suppress=<regex> drops draws from matching pipelines. This is an
      // isolation tool only; the normal path renders CloudFaces through the
      // formatted-texel compatibility adapter above.
      state._suppressed = _isPipelineSuppressed(entry.spec?.label || "");
      state.pass.setPipeline(chosen);
      state.boundGroups = [];
    },

    // Renames a freshly created object's handle.
    //
    // For the OpenJDK lane, whose RPC has to answer Java before the host has
    // run the call: the client hands Java a placeholder, the host creates the
    // object under its own handle, and this moves it onto the placeholder so
    // the two are the same number from then on. Every lookup goes through the
    // one `objects` map, so nothing else needs to know. Returns false if the
    // handle names no object, which keeps a non-handle return value (a width, a
    // boolean) from renaming something at random.
    rekeyObject(from, to) {
      if (from === to) return true;
      const object = objects.get(from);
      if (object === undefined) return false;
      objects.delete(from);
      if (object && typeof object === "object") object._handle = to;
      objects.set(to, object);
      return true;
    },

    // Publishes one interned binding name. Images used to write _bindingNames
    // directly from their @JS body, which only works when the host object is
    // the host: over the OpenJDK lane's RPC proxy the write lands on a local
    // stand-in and every later rpSetUniform fails to resolve its name. Going
    // through a method means the call is forwarded like any other.
    registerBindingName(id, name) {
      (this._bindingNames ||= [])[id] = name;
    },

    // New images pass an interned integer id here.  Keep accepting a string as
    // well: staged WasmLM images are expensive to rebuild and older artifacts
    // call this same host entry point with the pre-interning String ABI.  Do not
    // index _bindingNames with that value -- a WasmLM Java String is a Proxy,
    // and coercing it to a property key re-enters the wasm string bridge until
    // the Java stack overflows.
    rpBindTexture(passHandle, nameId, viewHandle, samplerHandle) {
      const name = resolveBindingName(nameId, "texture");
      if (_renderCommandReplayDepth === 0) markCall("rpBindTexture", {passHandle, name});
      const state = passState(passHandle);
      const _viewEntry = get(viewHandle, "texture view");
      _textureLifetime.noteViewUse(viewHandle, _viewEntry);
      const texRec = {
        kind: "texture",
        view: _viewEntry.view,
        viewHandle,
        sampler: get(samplerHandle, "sampler").sampler,
        samplerHandle,
        format: _viewEntry.textureEntry?.format, // which slot kind it needs (adaptSampleTypes)
        _name: name,                  // DIAG: name Mojang bound under
        _texEntry: _viewEntry.textureEntry // DIAG: underlying texture entry (uploads/size)
      };
      state.resources.set(name, texRec);
      // Positional record too: Mojang's bindTexture name need not equal the
      // pipeline spec's sampler name (the lookup key in ensureBindGroups). When
      // the name lookup misses we fall back to bind order (Nth bind → Nth
      // sampler slot), which is name-independent and correct for the
      // single-sampler textured families (text/position_tex*/panorama).
      state.drawTexBinds.push(texRec);
    },

    rpSetUniform(passHandle, nameId, bufferHandle, offset, size) {
      const name = resolveBindingName(nameId, "uniform");
      if (_renderCommandReplayDepth === 0) markCall("rpSetUniform", {passHandle, name});
      const state = passState(passHandle);
      const _bentry = get(bufferHandle, "buffer");
      // DIAG: the vanilla terrain fragment stage blends each texel from the
      // fog colour toward its real colour by ChunkVisibility (the chunk's
      // fade-in), so ChunkVisibility == 0 paints the whole chunk in FogColor no matter
      // what the atlas sample returned -- a uniform pale-blue wash over all
      // terrain, while entity and GUI shaders (no ChunkVisibility) stay
      // correct. Capture the bytes actually bound (a 4x4 matrix, then the
      // visibility float, a 2-int texture size and a 3-int chunk position, at
      // the byte offsets read below).
      if (name === "ChunkSection" && _bentry._shadow) {
        const ring = (globalThis.mcWebGpu._chunkSectionRing ||= []);
        if (ring.length < 40) {
          const base = (_bentry._shadow.byteOffset || 0) + offset;
          if (base + 92 <= _bentry._shadow.buffer.byteLength) {
            const f = new Float32Array(_bentry._shadow.buffer, base, 23);
            const i = new Int32Array(_bentry._shadow.buffer, base, 23);
            ring.push({
              chunkVisibility: f[16],
              textureSize: [i[18], i[19]],
              chunkPosition: [i[20], i[21], i[22]],
              // Full matrix, not just the diagonal: terrain provably does not
              // rasterise (a pass with 18 draws writes zero depth), so
              // gl_Position must be recomputed by hand from the measured
              // inputs to find which factor collapses or clips it.
              modelView: Array.from({length: 16}, (_, k) => f[k])
            });
          }
        }
      }
      state.resources.set(name, {
        kind: "uniform",
        buffer: _bentry.buffer,
        bufferHandle,
        bufferSize: _bentry.size, // full buffer size, for safe uniform-range inflate
        offset,
        size
      });
    },

    rpSetVertexBuffer(passHandle, slot, bufferHandle, offset, size) {
      const state = passState(passHandle);
      // Handle 0 is Java's null slice: the slot is unbound.
      if (bufferHandle === 0) {
        delete state.vertexBuffers[slot];
        return;
      }
      state.vertexBuffers[slot] = {buffer: get(bufferHandle, "buffer").buffer, offset, size, _handle: bufferHandle};
    },

    rpSetIndexBuffer(passHandle, bufferHandle, format) {
      const state = passState(passHandle);
      state.indexBuffer = {buffer: get(bufferHandle, "buffer").buffer, format, _handle: bufferHandle};
    },

    rpScissor(passHandle, x, y, width, height) {
      const state = passState(passHandle);
      // Minecraft gives OpenGL's bottom-left origin, and render targets hold
      // GL's memory layout (row 0 = bottom): the rectangle applies as is.
      const xx = Math.max(0, Math.min(state.width, x));
      const yy = Math.max(0, Math.min(state.height, y));
      const ww = Math.max(0, Math.min(state.width, x + width) - xx);
      const hh = Math.max(0, Math.min(state.height, y + height) - yy);
      state._scissor = [xx, yy, ww, hh];
      state.pass.setScissorRect(xx, yy, ww, hh);
    },

    rpDisableScissor(passHandle) {
      const state = passState(passHandle);
      if (state.area) {
        state._scissor = state.area.slice();
        state.pass.setScissorRect(state.area[0], state.area[1], state.area[2], state.area[3]);
      } else {
        state._scissor = [0, 0, state.width, state.height];
        state.pass.setScissorRect(0, 0, state.width, state.height);
      }
    },

    rpCommandStreamRaw(passHandle, bytes, byteLength, end) {
      return replayRenderPassCommands(this, passHandle, bytes, byteLength, end, "raw");
    },

    rpCommandStream64(passHandle, base64, byteLength, end) {
      return replayRenderPassCommands(this, passHandle, base64, byteLength, end, "base64");
    },

    rpCommandStreamText(passHandle, text, wordCount, end) {
      return replayRenderPassCommands(
        this, passHandle, text, wordCount * 4, end, "packed-text"
      );
    },

    rpCommandStreamWasmGc(passHandle, words, wordCount, end, readWord) {
      return replayRenderPassCommands(
        this, passHandle, words, wordCount * 4, end, "wasmgc-reader", readWord
      );
    },

    drawBatchEnabled() {
      return new URLSearchParams(globalThis.location?.search || "").has("mcweb_gpu_immediate") ? 0 : 1;
    },

    rpDrawIndexedBatch(passHandle, base64, drawCount) {
      const bytes = base64ToBytes(base64);
      if (bytes.length < drawCount * 20) throw new Error("indexed draw batch is truncated");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < drawCount; i++) {
        const base = i * 20;
        this.rpDrawIndexed(passHandle, view.getInt32(base, true), view.getInt32(base + 4, true),
          view.getInt32(base + 8, true), view.getInt32(base + 12, true), view.getInt32(base + 16, true));
      }
    },

    rpDrawBatch(passHandle, base64, drawCount) {
      const bytes = base64ToBytes(base64);
      if (bytes.length < drawCount * 16) throw new Error("draw batch is truncated");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < drawCount; i++) {
        const base = i * 16;
        this.rpDraw(passHandle, view.getInt32(base, true), view.getInt32(base + 4, true),
          view.getInt32(base + 8, true), view.getInt32(base + 12, true));
      }
    },

    rpDraw(passHandle, firstVertex, vertexCount, instanceCount, baseInstance) {
      if (_renderCommandReplayDepth === 0) markCall("rpDraw", {passHandle, vertexCount});
      const state = passState(passHandle);
      state._drawn++;
      // ?mcweb_drawcensus=1: which pipelines actually issue draws, and into
      // which target. Chunk counters say terrain is renderable; this says
      // whether anything is drawn for it. Inert unless the flag is present.
      if (_drawCensus) _noteDrawCensus(state, vertexCount, instanceCount);
      if (!state.pipeline || state._suppressed) return;
      _noteFontDraw(state, "draw", {firstVertex, vertexCount, instanceCount});
      ensureBindGroups(state);
      state.drawTexBinds.length = 0; // binds consumed AFTER ensureBindGroups reads them
      if (state.pipeline.stages?.error) { errorShaderDraw(state); return; }
      // DIAG: one-shot animate_sprite UBO + target dump
      if (!_animDbgDone && state.pipeline.spec && /animate_sprite/.test(state.pipeline.spec.label)) {
        _animDbgDone = true;
        const uni = state.resources.get("SpriteAnimationInfo");
        let uboDump = "no SpriteAnimationInfo bound";
        if (uni && uni.kind === "uniform") {
          const be = objects.get(uni.bufferHandle);
          if (be && be._shadow) {
            const f = new Float32Array(be._shadow.buffer, uni.offset, 32);
            const i32 = new Int32Array(be._shadow.buffer, uni.offset, 35);
            uboDump = JSON.stringify({
              bufLabel: be._label, bufSize: be.size, uniOffset: uni.offset, uniSize: uni.size,
              projection: Array.from(f.slice(0, 16)),
              spriteMatrix: Array.from(f.slice(16, 32)),
              padding: [f[32], f[33]], mipLevel: i32[34]
            });
          } else { uboDump = "buffer handle " + uni.bufferHandle + " has no shadow"; }
        }
        const spr = state.resources.get("Sprite");
        const sprInfo = spr && spr.kind === "texture" && spr._texEntry
          ? {label: spr._texEntry._label, uploads: spr._texEntry._uploads, wh: spr._texEntry.width + "x" + spr._texEntry.height}
          : "not bound or no entry";
        console.log("[ANIM-SPRITE-DIAG] target=" + state._targetLabel + " " + state._targetWH
          + " | UBO: " + uboDump
          + " | Sprite tex: " + JSON.stringify(sprInfo)
          + " | vertexCount=" + vertexCount + " firstVertex=" + firstVertex);
      }
      if (state.pipeline && state.pipeline.spec && /animate_sprite/.test(state.pipeline.spec.label) && _animRing.length < 40) {
        const _au = state.resources.get("SpriteAnimationInfo");
        let _asm = null, _apm = null;
        if (_au && _au.kind === "uniform") { const _abe = objects.get(_au.bufferHandle); if (_abe && _abe._shadow) { const _af = new Float32Array(_abe._shadow.buffer, (_abe._shadow.byteOffset || 0) + _au.offset, 32); _apm = [_af[0], _af[5]]; _asm = [_af[16], _af[21], _af[28], _af[29]]; } }
        const _asp = state.resources.get("Sprite"); const _ase = _asp && _asp.kind === "texture" && _asp._texEntry;
        _animRing.push({ tgt: state._targetLabel, tgtWH: state._targetWH, pm: _apm, sm: _asm, spr: _ase ? (_ase._label || "?").split("/").pop() : null, swh: _ase ? (_ase.width + "x" + _ase.height) : null, sup: _ase ? _ase._uploads : null });
        if (_asmBad.length < 12 && state._targetLabel && !/\/atlas\//.test(state._targetLabel)) _asmBad.push({ tgt: state._targetLabel, tgtWH: state._targetWH, pm: _apm, spr: _ase ? (_ase._label || "?").split("/").pop() : null });
      }
      if (state.pipeline && state.pipeline.spec && /animate_sprite/.test(state.pipeline.spec.label)) {
        const target = state._targetLabel || "?";
        _animTargetCounts.set(target, (_animTargetCounts.get(target) || 0) + 1);
        if (/atlas\/gui\.png/.test(target) && _guiAtlasRing.length < 40) {
          const uniform = state.resources.get("SpriteAnimationInfo");
          let projection = null;
          let spriteMatrix = null;
          if (uniform && uniform.kind === "uniform") {
            const buffer = objects.get(uniform.bufferHandle);
            if (buffer && buffer._shadow) {
              const values = new Float32Array(
                buffer._shadow.buffer,
                (buffer._shadow.byteOffset || 0) + uniform.offset,
                32
              );
              projection = [values[0], values[5]];
              spriteMatrix = [values[16], values[21], values[28], values[29]];
            }
          }
          const sprite = state.resources.get("Sprite");
          const texture = sprite && sprite.kind === "texture" && sprite._texEntry;
          _guiAtlasRing.push({
            target,
            projection,
            spriteMatrix,
            sprite: texture ? texture._label : null,
            size: texture ? `${texture.width}x${texture.height}` : null,
            uploads: texture ? texture._uploads || 0 : 0
          });
        }
      }
      _maybeTexDrawDiag(state, "rpDraw");
      _decodeGuiDraw(state, "draw", {vertexCount, firstVertex, baseVertex: 0, indexCount: 0});
      _noteScatter(state);
      applyVertexAndIndex(state);
      if (needsLowering(state)) {
        const lowered = loweredIndices(state.pipeline.spec.topology, firstVertex + vertexCount);
        if (lowered) {
          applyIndexBuffer(state, lowered.buffer, "uint32");
          state.pass.drawIndexed(lowered.count, Math.max(1, instanceCount), 0, 0, 0);
          return;
        }
      }
      state.pass.draw(vertexCount, Math.max(1, instanceCount), firstVertex, 0);
    },

    rpDrawIndexed(passHandle, indexCount, instanceCount, firstIndex, baseVertex, firstInstance) {
      if (_renderCommandReplayDepth === 0) {
        markCall("rpDrawIndexed", {passHandle, indexCount});
      }
      const state = passState(passHandle);
      state._drawn++;
      // Indexed draws are how world geometry actually reaches the GPU; the
      // non-indexed path above is mostly atlas blits. Census both or the
      // in-world picture looks empty for the wrong reason.
      if (_drawCensus) _noteDrawCensus(state, indexCount, instanceCount);
      // Control sample: the same uniform ranges for a pipeline that is visibly
      // rendering. "Terrain's Projection reads as zero" only means something
      // if a working draw's Projection does not.
      if (_drawCensus && !globalThis.mcWebGpu._visibleDrawSample
          && /celestial|clouds|entity_/.test(state.pipeline?.spec?.label || "")
          && state.resources.get("Projection")) {
        const r = state.resources.get("Projection");
        globalThis.mcWebGpu._visibleDrawSample = {
          label: state.pipeline.spec.label,
          projection: {bufferHandle: r.bufferHandle, offset: r.offset, size: r.size},
        };
      }
      // One-shot: remember which vertex buffer a terrain draw read, so its
      // actual bytes can be decoded later (see readTerrainVertices).
      if (!globalThis.mcWebGpu._terrainDrawSample
          && /solid_terrain/.test(state.pipeline?.spec?.label || "")
          && state.vertexBuffers[0]) {
        const vb = state.vertexBuffers[0];
        const uniformRange = (name) => {
          const r = state.resources.get(name);
          return r ? {bufferHandle: r.bufferHandle, offset: r.offset, size: r.size} : null;
        };
        globalThis.mcWebGpu._terrainDrawSample = {
          bufferHandle: vb._handle,
          offset: vb.offset,
          stride: state.pipeline.spec.vertexFormats?.[0]?.stride ?? 28,
          indexCount, baseVertex, firstIndex,
          // The transform inputs, captured at the draw that used them (the
          // vertex Position, the section's ChunkPosition, the camera block
          // position and offset from Globals, and the model-view/projection
          // matrices that place the result on screen).
          // Vertex data and every texture measured correct, so if terrain is
          // absent rather than black, one of these is placing it off-screen.
          vbOffset: vb.offset,
          vbSize: vb.size,
          vbBufferSize: objects.get(vb._handle)?.size ?? null,
          // The comparison that matters: a bound range of vbSize bytes at
          // stride 28 holds vbSize/28 vertices, and the draw indexes up to
          // baseVertex + (max index in the run). If that exceeds the range the
          // browser rejects the draw outright.
          vertexCapacity: Math.floor((vb.size ?? 0) / 28),
          indexBufferHandle: state.indexBuffer?._handle ?? null,
          indexFormat: state.indexBuffer?.format ?? null,
          globals: uniformRange("Globals"),
          projection: uniformRange("Projection"),
          chunkSection: uniformRange("ChunkSection")
        };
      }
      if (state._suppressed) {
        _noteCloudDraw(state,
          {indexCount, instanceCount, firstIndex, baseVertex, firstInstance}, false);
        return;
      }
      if (!state.pipeline) {
        // Silently dropped: no pipeline bound. Counted so a whole family of
        // missing geometry cannot hide behind a clean validation log.
        const census = (globalThis.mcWebGpu._drawCensus ||= {});
        const row = (census["<dropped-no-pipeline>"] ||= {draws: 0, maxVb: 0, kinds: {}, sample: null});
        row.draws++;
        return;
      }
      _noteFontDraw(state, "indexed", {indexCount, instanceCount, firstIndex, baseVertex, firstInstance});
      ensureBindGroups(state);
      state.drawTexBinds.length = 0;
      if (state.pipeline.stages?.error) { errorShaderDraw(state); return; }
      _maybeTexDrawDiag(state, "rpDrawIndexed");
      _decodeGuiDraw(state, "idx", {indexCount, firstIndex, baseVertex, firstVertex: 0});
      _noteScatter(state);
      applyVertexAndIndex(state);
      _noteDraw(state, "indexed", {indexCount, firstIndex, baseVertex});
      _noteCloudDraw(state,
        {indexCount, instanceCount, firstIndex, baseVertex, firstInstance}, true);
      if (_hz) {
        // What this draw reads: Minecraft's quads are 4 vertices per 6
        // indices from baseVertex, and indexCount indices from firstIndex.
        const vb = state.vertexBuffers[0];
        const stride = state.pipeline.spec.vertexFormats?.[0]?.stride || 0;
        if (vb && stride) _hzUse(state._encoder, vb.buffer, (vb.offset | 0) + baseVertex * stride,
          Math.ceil(indexCount / 6) * 4 * stride);
        if (state.indexBuffer) {
          const isz = state.indexBuffer.format === "uint32" ? 4 : 2;
          _hzUse(state._encoder, state.indexBuffer.buffer, firstIndex * isz, indexCount * isz);
        }
      }
      state.pass.drawIndexed(indexCount, Math.max(1, instanceCount), firstIndex, baseVertex, firstInstance);
    },

    rpDrawIndirect(passHandle, bufferHandle, offset, drawCount) {
      const state = passState(passHandle);
      state._drawn++;
      if (!state.pipeline) return;
      _noteFontDraw(state, "indirect", {bufferHandle, offset, drawCount});
      ensureBindGroups(state);
      state.drawTexBinds.length = 0;
      if (state.pipeline.stages?.error) { errorShaderDraw(state); return; }
      applyVertexAndIndex(state);
      const buffer = get(bufferHandle, "buffer").buffer;
      _markUse(state, buffer);
      for (let i = 0; i < drawCount; i++) {
        state.pass.drawIndirect(buffer, offset + i * 16);
      }
    },

    rpDrawIndexedIndirect(passHandle, bufferHandle, offset, drawCount) {
      const state = passState(passHandle);
      state._drawn++;
      if (!state.pipeline) return;
      _noteFontDraw(state, "indexedIndirect", {bufferHandle, offset, drawCount});
      ensureBindGroups(state);
      state.drawTexBinds.length = 0;
      if (state.pipeline.stages?.error) { errorShaderDraw(state); return; }
      applyVertexAndIndex(state);
      const buffer = get(bufferHandle, "buffer").buffer;
      _markUse(state, buffer);
      for (let i = 0; i < drawCount; i++) {
        state.pass.drawIndexedIndirect(buffer, offset + i * 20);
      }
    },

    rpPushDebugGroup(passHandle, label) {
      const state = passState(passHandle);
      if (typeof state.pass.pushDebugGroup === "function") state.pass.pushDebugGroup(label);
    },

    rpPushDebugGroupId(passHandle, labelId) {
      const label = resolveBindingName(labelId, "debug group");
      const state = passState(passHandle);
      if (typeof state.pass.pushDebugGroup === "function") state.pass.pushDebugGroup(label);
    },

    rpPopDebugGroup(passHandle) {
      const state = passState(passHandle);
      if (typeof state.pass.popDebugGroup === "function") state.pass.popDebugGroup();
    },

    configureCanvas(width, height) {
      canvas.width = width;
      canvas.height = height;
      context.configure({
        device,
        format: canvasFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
        alphaMode: "opaque"
      });
    },

    // Mojang gets a persistent offscreen texture as "the canvas", never the
    // swap-chain texture itself. getCurrentTexture() is only valid until the
    // task that called it ends, and a frame's commands reach this host over
    // several RPC round trips (any call that needs an answer ends a batch), so
    // the real canvas texture was routinely dead by the time Mojang's encoder
    // was submitted: "Destroyed texture used in a submit" on every frame,
    // which threw away the whole command buffer - atlas stitching and
    // animation included, hence empty GUI sprites and black terrain. present()
    // composites this texture onto the real canvas inside its own task.
    acquireCanvasTexture() {
      if (!_useVirtualCanvas) {
        return put({kind: "texture", isCanvas: true, texture: context.getCurrentTexture(), format: "rgba8unorm", width: canvas.width, height: canvas.height, depth: 1});
      }
      if (!_virtualCanvas || _virtualCanvas.width !== canvas.width || _virtualCanvas.height !== canvas.height) {
        if (_virtualCanvas) {
          evictResourceBindGroups(_virtualCanvas.texture);
          deferDestroyTexture(_virtualCanvas.texture, null);
        }
        _virtualCanvas = {
          width: canvas.width,
          height: canvas.height,
          texture: device.createTexture({
            label: "mcweb-virtual-canvas",
            size: {width: canvas.width, height: canvas.height, depthOrArrayLayers: 1},
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
              | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
          }),
        };
      }
      return put({kind: "texture", isCanvas: true, texture: _virtualCanvas.texture, format: "rgba8unorm",
        width: canvas.width, height: canvas.height, depth: 1, _label: "mcweb-virtual-canvas"});
    },

    present(handle) {
      markCall("present", {handle});
      _lastPresentAt = Date.now();
      _presentCount++;
      if (_drawCensus && _lastPresentAt - _presentEnterAt > 10000) {
        _presentEnterAt = _lastPresentAt;
        console.log("[draw-census] present enter #" + _presentCount);
      }
      // End of frame: the per-target draw maps are complete. Snapshot + reset.
      lastFrameDraws = frameDraws;
      frameDraws = new Map();
      lastFrameDrawSeq = frameDrawSeq;
      frameDrawSeq = new Map();
      lastFrameIsCanvas = frameLastIsCanvas;
      frameLastTid = 0; frameLastIsCanvas = false;
      // DIAG: preserve this frame's sampled set for _texDiag, then clear for next.
      if (_textureHistoryCaptured) {
        _lastFrameSampled = _sampledThisFrame;
        _sampledThisFrame = new Set();
      }
      const _qs = new URLSearchParams(location.search);
      // DIAG: with ?mcweb_texdiag, snapshot+readback the sampled textures ONCE the
      // title screen is up (frame>40). Console.table the result; no blind testing.
      if (_qs.has("mcweb_atlasdiag") && !globalThis.__mcwebAtlasDiagDone && (globalThis.mcWebPump?.ticks || 0) > 60) {
        globalThis.__mcwebAtlasDiagDone = true;
        globalThis.mcWebGpu._atlasDiag();
      }
      if (_textureHistoryCaptured && _qs.has("mcweb_texdiag") && !_texDiagDone && (globalThis.mcWebPump?.ticks || 0) > 40 && _lastFrameSampled.size) {
        _texDiagDone = true;
        globalThis.mcWebGpu._texDiag();
      }
      // DIAG: LATE lifetime dump (frame>200): per-label total uploads + how many
      // texture INSTANCES exist per label and each one's upload count. Answers
      // "did the atlas EVER upload (just late)?" and "is the sampled atlas a
      // different instance than the uploaded one (stale handle)?".
      // Gate on a few ticks, not 200: with the per-frame blur validation spam
      // each tick takes ~6s, so 200 ticks never arrives in a probe window.
      // _sampledEntries is cumulative, so a few frames already hold the title
      // screen's textures.
      if (_qs.has("mcweb_texdiag") && !_texDiagLateDone && (globalThis.mcWebPump?.ticks || 0) >= 3) {
        _texDiagLateDone = true;
        globalThis.mcWebGpu._texDiagLate();
      }
      if (!_guiRingDumped && _guiDrawRing.length && (globalThis.mcWebPump?.ticks || 0) >= 2) {
        _guiRingDumped = true;
        console.log("[GUI-DRAW-RING] " + JSON.stringify(_guiDrawRing));
      }
      if (_DBG && !_panoDumped && (globalThis.mcWebPump?.ticks || 0) >= 2) {
        _panoDumped = true;
        console.log("[PANO-PROBE] " + JSON.stringify(_panoProbe));
      }
      if (!_probe2Dumped && (globalThis.mcWebPump?.ticks || 0) >= 2) {
        _probe2Dumped = true;
        console.log("[PROBE2] animRing=" + JSON.stringify(_animRing) + " | javaErr=" + JSON.stringify(_javaErrBuf));
      }
      if (!_probe3Dumped && (globalThis.mcWebPump?.ticks || 0) >= 2) {
        _probe3Dumped = true;
        console.log("[PROBE3] asmBad=" + JSON.stringify(_asmBad) + " | scatter=" + JSON.stringify(_scatterDraws) + " | comp=" + JSON.stringify(compositeSource ? {label: compositeSource._label, wh: compositeSource.width + "x" + compositeSource.height, tid: compositeSource._tid} : null));
        // Write a human-readable verdict to the on-page div so a screenshot suffices.
        const _vLines = [];
        const _compLbl = compositeSource ? (compositeSource._label || "?") + " " + compositeSource.width + "x" + compositeSource.height : "null";
        _vLines.push("comp=" + _compLbl);
        if (_asmBad.length) {
          _vLines.push("VERDICT: atlas-assembly MIS-TARGETED (" + _asmBad.length + " draws onto non-atlas)");
          _vLines.push("  first tgt=" + (_asmBad[0].tgt || "?") + " src=" + (_asmBad[0].src || "?"));
        } else if (_scatterDraws.length) {
          _vLines.push("VERDICT: screen draws sample raw sprites (" + _scatterDraws.length + " draws)");
          _vLines.push("  first src=" + (_scatterDraws[0].src || "?") + " tgt=" + (_scatterDraws[0].tgt || "?"));
        } else {
          _vLines.push("VERDICT: asmBad=0 scatter=0 → scatter NOT from assembly or screen-draw path");
          _vLines.push("  (check composite source above; if comp=atlas → composite picks wrong texture)");
        }
        const _vd = document.getElementById("mcweb-probe-verdict");
        if (_vd) _vd.textContent = _vLines.join("\n");
      }
      const _diag = _qs.get("mcweb_diag");
      // Composite-source policy. Mojang draws the loading SPLASH straight to the
      // canvas, but renders the TITLE screen (panorama + GUI) into an offscreen
      // main target that its presenter does NOT copy to the canvas in our
      // backend — so with no composite the title goes black (the user's
      // "splash → black" report). The correct source is the target drawn LAST
      // in the frame (the GUI/title composition; the panorama atlas is drawn
      // early and samples as flat black, which is what the old max-draws pick
      // grabbed). The composite is a no-op for the splash (there the last draw
      // is the canvas itself, which we never composite), so it is safe to
      // enable by default. Overrides: ?mcweb_nocomposite (off), or
      // ?mcweb_composite=lastdraw|maxdraws|<tid>.
      const _cval = _qs.get("mcweb_composite");
      const _noComposite = _qs.has("mcweb_nocomposite");
      const _mode = !_cval ? "lastdraw" : (_cval === "maxdraws" ? "maxdraws" : (_cval === "lastdraw" ? "lastdraw" : "tid"));
      const _forceTid = _mode === "tid" ? Number(_cval) : 0;
      if (!_diag && !_noComposite && !lastFrameIsCanvas) {
        if (_forceTid) {
          const e = texInventory.find((t) => t._tid === _forceTid);
          if (e) compositeSource = e;
        } else if (_mode === "maxdraws") {
          let bestTid = 0, bestDraws = 0;
          for (const [tid, n] of lastFrameDraws) { if (n > bestDraws) { bestDraws = n; bestTid = tid; } }
          if (bestTid) {
            const e = texInventory.find((t) => t._tid === bestTid);
            if (e) compositeSource = e;
          }
        } else {
          // Composite-source selection. Mojang's frame draws the panorama + GUI
          // composition into the main target (created at exactly canvas pixel
          // size), then TextureAtlas.tick() → uploadAnimationFrames() opens a
          // render pass on the atlas (both dims power-of-two) which gets the
          // highest drawSeq.  The old naive max-seq pick grabbed the atlas and
          // stretched its packed sprites across the canvas (the scattered icon
          // grid in the broken screenshot).  Fix: prefer the target whose
          // dimensions EXACTLY match the canvas (the main target is created at
          // canvas.width × canvas.height by Mojang's presenter), then fall back
          // to aspect-ratio match excluding atlases, then plain lastdraw.
          const isPOT = (n) => n > 0 && (n & (n - 1)) === 0;
          const isAtlas = (e) => {
            if (!e || !e.width || !e.height) return true;
            // Both dims power-of-two = texture atlas (gui/widgets/blocks).
            if (isPOT(e.width) && isPOT(e.height)) return true;
            // Very wide or very tall non-screen-aspect textures (sprite sheets).
            const a = e.width / e.height;
            if (a > 3 || a < 0.33) return true;
            return false;
          };
          const canvasAspect = canvas.width / canvas.height;
          const aspectMatch = (e) => {
            if (!e || !e.width || !e.height) return false;
            const a = e.width / e.height;
            return Math.abs(a - canvasAspect) / canvasAspect < 0.15;
          };
          // Pass 1: Minecraft names the scene presenter target `Main / Color`.
          // Prefer that semantic identity before considering dimensions or draw
          // order. Portal/transparency/post processing creates FBO 0 and FBO 1
          // at the exact same canvas size; choosing the last of those is browser
          // scheduling dependent and can present a cleared black auxiliary FBO.
          let bestTid = 0, bestSeq = 0;
          for (const [tid, sq] of lastFrameDrawSeq) {
            const e = texInventory.find((t) => t._tid === tid);
            if (e && String(e._label || "").toLowerCase() === "main / color"
                && sq > bestSeq) {
              bestSeq = sq; bestTid = tid;
            }
          }
          // Pass 2: exact canvas-dimension match. This remains the generic
          // fallback for early/diagnostic images that do not name a Main target.
          if (!bestTid) {
            for (const [tid, sq] of lastFrameDrawSeq) {
              const e = texInventory.find((t) => t._tid === tid);
              if (e && e.width === canvas.width && e.height === canvas.height && sq > bestSeq) {
                bestSeq = sq; bestTid = tid;
              }
            }
          }
          // Pass 3: aspect match + not atlas.
          if (!bestTid) {
            for (const [tid, sq] of lastFrameDrawSeq) {
              const e = texInventory.find((t) => t._tid === tid);
              if (e && !isAtlas(e) && aspectMatch(e) && sq > bestSeq) { bestSeq = sq; bestTid = tid; }
            }
          }
          // Pass 4: last-drawn non-atlas (any aspect).
          if (!bestTid) {
            for (const [tid, sq] of lastFrameDrawSeq) {
              const e = texInventory.find((t) => t._tid === tid);
              if (e && !isAtlas(e) && sq > bestSeq) { bestSeq = sq; bestTid = tid; }
            }
          }
          // Pass 5: plain lastdraw (fallback).
          if (!bestTid) {
            for (const [tid, sq] of lastFrameDrawSeq) { if (sq > bestSeq) { bestSeq = sq; bestTid = tid; } }
          }
          if (bestTid) {
            const e = texInventory.find((t) => t._tid === bestTid);
            if (e) compositeSource = e;
          }
        }
      }
      // Composite the scene main target to the swap-chain canvas: Mojang's 26.2
      // presenter acquires + presents the canvas texture but never draws or
      // copies into it, so without this the canvas stays empty. The canvas
      // texture is still the current one here (valid until context.present()).
      // Under ?mcweb_drawcensus the census already says which pipelines drew
      // into which target; pair it with what the composite actually put on the
      // canvas, or "terrain drew but nothing appeared" stays ambiguous.
      if (_drawCensus) {
        const now = Date.now();
        if (now - _compositeLogAt > 10000) {
          _compositeLogAt = now;
          console.log("[draw-census] composite <- "
            + (compositeSource ? (compositeSource._label || "?") + " "
                + compositeSource.width + "x" + compositeSource.height
                + " tid=" + compositeSource._tid : "null")
            + " noComposite=" + _noComposite + " lastFrameIsCanvas=" + lastFrameIsCanvas);
        }
      }
      // A frame that ended on "the canvas" (the splash) drew into the virtual
      // canvas; that is what goes on screen.
      if (lastFrameIsCanvas && _virtualCanvas) {
        compositeSource = {texture: _virtualCanvas.texture, width: _virtualCanvas.width,
          height: _virtualCanvas.height, _label: "mcweb-virtual-canvas", _tid: -1};
      }
      if (!_noComposite && compositeSource && compositeSource.texture) {
        try {
          const canvasTexture = context.getCurrentTexture();
          const enc = device.createCommandEncoder({label: "mcweb-composite-encoder"});
          // ?mcweb_diag=magenta → clear the canvas to magenta and draw nothing.
          // If magenta appears on screen, this pass reaches the presented
          // drawable (so a black screen means the SOURCE is empty/wrong); if
          // the screen stays black, this pass isn't being presented at all.
          const diag = _diag;
          const clear = diag === "magenta" ? {r: 1, g: 0, b: 1, a: 1} : {r: 0, g: 0, b: 0, a: 1};
          const pass = enc.beginRenderPass({colorAttachments: [{
            view: canvasTexture.createView(),
            loadOp: "clear", storeOp: "store", clearValue: clear
          }]});
          if (diag !== "magenta") {
            const pipeline = ensureComposite(canvas.height);
            // ?mcweb_diag=checker → sample a known-good in-page texture instead
            // of the tracked scene target. Checker on screen ⇒ sampling works
            // and the tracked source is the problem; black ⇒ sampling is broken.
            const srcTex = diag === "checker" ? ensureDiagChecker() : compositeSource.texture;
            const bg = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
              {binding: 0, resource: compositeSampler},
              {binding: 1, resource: srcTex.createView()}
            ]});
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bg);
            pass.draw(3);
          }
          pass.end();
          device.queue.submit([enc.finish()]);
          flushGraveyard();
          markCall("composite", {source: compositeSource.width + "x" + compositeSource.height, area: compositeSource._area, diag: diag || "blit"});
        } catch (error) {
          markCall("composite-failed", {error: String(error).slice(0, 120)});
          if (_drawCensus) console.log("[draw-census] composite FAILED " + String(error).slice(0, 160));
        }
      }
      if (_drawCensus && Date.now() - _presentExitAt > 10000) {
        _presentExitAt = Date.now();
        console.log("[draw-census] present exit #" + _presentCount);
        // Only the passes that touched the composited target matter here.
        const main = _framePassTrace
          .filter((entry) => /main \/ color/i.test(entry.target))
          .map((entry) => (entry.clear ? "CLEAR" : "load") + "/d=" + entry.depth
            + "/sc=" + (entry.scissor ?? "-") + "/ar=" + (entry.area ?? "-")
            + ":" + entry.draws + "[" + [...(entry.pipes || [])].join(",") + "]");
        console.log("[draw-census] frame passes on Main/Color: " + main.slice(0, 8).join(" -> "));
        // The question is what runs *after* terrain in the same target.
        const terrainAt = main.findLastIndex((entry) => /terrain/.test(entry));
        // Which depth clear values the frame used at all. Vanilla clears the
        // world depth before terrain; if only GUI's clear-to-0 ever appears,
        // terrain is depth-testing against a buffer that says "nearest".
        // One-shot: read back what a terrain draw actually fed the GPU. If the
        // positions are degenerate or absurd, the geometry never had a chance
        // of landing on screen and nothing downstream matters.
        // Did terrain rasterise at all? The pass clears depth to 0 and terrain
        // writes depth, so a non-zero texel is geometry that passed the depth
        // test and wrote. All-zero means nothing rasterised, whatever the
        // colour buffer shows - which separates "geometry never landed" from
        // "geometry landed and was not shaded/blended into view".
        if (!_terrainDepthDumped && _depthSnapshot) {
          _terrainDepthDumped = true;
          Promise.resolve(globalThis.mcWebGpu.readTerrainPassDepth()).then((result) => {
            console.log("[draw-census] terrain pass depth " + JSON.stringify(result));
          }).catch((error) => {
            console.log("[draw-census] terrain depth failed " + String(error).slice(0, 120));
          });
        }
        if (!_uniformSnapshotDumped && _uniformSnapshot && !_uniformSnapshot.error) {
          _uniformSnapshotDumped = true;
          const snapshot = _uniformSnapshot;
          snapshot.buffer.mapAsync(GPUMapMode.READ).then(() => {
            const floats = new Float32Array(snapshot.buffer.getMappedRange().slice(0));
            snapshot.buffer.unmap();
            console.log("[draw-census] PROJECTION at terrain pass (drawn="
              + snapshot.drawn + ") "
              + JSON.stringify(Array.from(floats).map((v) => Number(v.toFixed(4)))));
          }).catch((error) => {
            console.log("[draw-census] projection snapshot failed "
              + String(error).slice(0, 120));
          });
        }
        if (!_visibleSnapshotDumped && _visibleUniformSnapshot
            && !_visibleUniformSnapshot.error) {
          _visibleSnapshotDumped = true;
          const snapshot = _visibleUniformSnapshot;
          snapshot.buffer.mapAsync(GPUMapMode.READ).then(() => {
            const floats = new Float32Array(snapshot.buffer.getMappedRange().slice(0));
            snapshot.buffer.unmap();
            console.log("[draw-census] PROJECTION at sky pass (drawn="
              + snapshot.drawn + ") "
              + JSON.stringify(Array.from(floats).map((v) => Number(v.toFixed(4)))));
          }).catch(() => {});
        }
        // With ?mcweb_gpu_probe the host records the floats of every UBO-sized
        // write keyed by label#handle. Pair that with the handle the terrain
        // draw actually bound: if a good matrix is written to one instance and
        // the draw binds another, the draw sees a freshly-zeroed buffer.
        if (!_writeProbeDumped && globalThis.mcWebGpu._smallBufferWrites
            && globalThis.mcWebGpu._terrainDrawSample?.projection) {
          _writeProbeDumped = true;
          const bound = globalThis.mcWebGpu._terrainDrawSample.projection;
          console.log("[draw-census] terrain binds Projection handle="
            + bound.bufferHandle + " offset=" + bound.offset + " size=" + bound.size);
          const history = globalThis.mcWebGpu._smallBufferWriteHistory || {};
          for (const [key, list] of Object.entries(history)) {
            if (!Array.isArray(list) || !/level/i.test(key)) continue;
            list.forEach((r, i) => {
              console.log("[draw-census] history " + key + " #" + i
                + " seq=" + r.seq + " f=" + JSON.stringify(r.floats.slice(0, 6)));
            });
          }
          for (const [key, value] of Object.entries(globalThis.mcWebGpu._smallBufferWrites)) {
            if (!/Proj|Dynamic|Transform|Globals/i.test(key)) continue;
            console.log("[draw-census] write " + key + " @" + value.offset
              + " f=" + JSON.stringify(value.floats.slice(0, 16)));
            // Ints too: garbage floats that are a byte-shifted or int-encoded
            // view of a sane matrix show up clearly in the raw words.
            console.log("[draw-census] write " + key + " i="
              + JSON.stringify(value.ints.slice(0, 16)));
          }
        }
        if (!_terrainUniformDumped && globalThis.mcWebGpu._terrainDrawSample) {
          _terrainUniformDumped = true;
          for (const which of ["projection", "globals", "chunkSection"]) {
            Promise.resolve(globalThis.mcWebGpu.readTerrainUniform(which)).then((r) => {
              console.log("[draw-census] uniform " + which + " "
                + (r.error ? r.error : JSON.stringify(r.floats)));
            }).catch(() => {});
          }
          Promise.resolve(globalThis.mcWebGpu.readTerrainUniform("projection", "visible"))
            .then((r) => {
              console.log("[draw-census] uniform CONTROL projection ("
                + (globalThis.mcWebGpu._visibleDrawSample?.label || "?") + ") "
                + (r.error ? r.error : JSON.stringify(r.floats)));
            }).catch(() => {});
        }
        if (!_terrainVertsDumped && globalThis.mcWebGpu._terrainDrawSample) {
          _terrainVertsDumped = true;
          Promise.resolve(globalThis.mcWebGpu.readTerrainVertices()).then((result) => {
            if (!result || result.error) {
              console.log("[draw-census] terrain verts: " + (result && result.error));
              return;
            }
            console.log("[draw-census] terrain rec "
              + JSON.stringify(result.rec).slice(0, 900));
            for (const vertex of result.vertices.slice(0, 4)) {
              console.log("[draw-census] vert pos=" + JSON.stringify(vertex.position)
                + " col=" + JSON.stringify(vertex.color)
                + " uv0=" + JSON.stringify(vertex.uv0));
            }
          }).catch((error) => {
            console.log("[draw-census] terrain verts failed " + String(error).slice(0, 120));
          });
        }
        // Copies are invisible to a draw census: copyTextureToTexture into the
        // composited target after the terrain pass would erase terrain without
        // appearing as a pass or a draw anywhere above.
        if (compositeSource) {
          console.log("[draw-census] target tid=" + compositeSource._tid
            + " copiesIn=" + (compositeSource._copiesIn || 0)
            + " copiesOut=" + (compositeSource._copiesOut || 0)
            + " uploads=" + (compositeSource._uploads || 0));
        }
        console.log("[draw-census] depthClears="
          + JSON.stringify(globalThis.mcWebGpu._depthClears || {}));
        if (terrainAt >= 0) {
          console.log("[draw-census] terrainPass=" + main[terrainAt]);
        }
        console.log("[draw-census] passes=" + main.length + " lastTerrainPass=" + terrainAt
          + " after=" + (terrainAt < 0 ? "n/a" : main.slice(terrainAt + 1).join(" -> ").slice(0, 400)));
        // Per-target draws for the frame being presented right now. The
        // aggregate census covers ten seconds; if terrain only draws in frames
        // that are never presented, these two disagree and that is the answer.
        const perTarget = [];
        for (const [tid, n] of lastFrameDraws) {
          const e = texInventory.find((t) => t._tid === tid);
          perTarget.push((e ? (e._label || "?") + " " + e.width + "x" + e.height : "tid" + tid)
            + "=" + n);
        }
        console.log("[draw-census] presented frame draws: " + (perTarget.join(", ") || "none"));
      }
      if (_drawCensus) _framePassTrace.length = 0;
      objects.delete(handle);
    },

    reportSuccess(argb, backend, path) {
      const hex = (argb >>> 0).toString(16).padStart(8, "0").toUpperCase();
      setText("jar-status", "executed from the Minecraft client jar");
      setText("jar-method", path);
      setText("jar-result", `0x${hex}`);
      setText("gpu-status", `${backend} canvas presented`);
      document.documentElement.style.setProperty(
        "--jar-color",
        `rgb(${(argb >>> 16) & 255} ${(argb >>> 8) & 255} ${argb & 255})`
      );
      document.body.dataset.ready = "true";
    },

    reportReloadProbe(event, source = "main") {
      const text = String(event);
      const entries = diagnostics.reloadProbe;
      entries.push({
        at: Math.round(performance.now()),
        source: String(source),
        event: text,
      });
      if (entries.length > 8000) entries.splice(0, entries.length - 8000);
      // The reload probe is most useful precisely when the main thread is stuck
      // inside the synchronous Create World barrier. Keep the last few events in
      // the out-of-thread watchdog ring as well; the page-side array above cannot
      // be read while that renderer is frozen. Do not route through reportProgress:
      // this path can be hot during the reload and must remain shared-memory-only.
      globalThis.mcWebThreadRuntime?.diag?.("reload " + text);
      // Keep a compact copy in CDP for the healthy portion of a run. The full
      // reload stream is intentionally not logged here (it is thousands of task
      // events and would overflow the console pipe); these transition records are
      // the ones that identify a barrier that never completes.
      if (/event=(begin|snapshot|all-done|listener-(complete|create-failed)|barrier-(wait|submit-main|main-ran|main-failed|ready-for-apply)|task-failed)/.test(text)) {
        console.log("[MC-RELOAD]", text);
      }
    },

    reportProgress(stage, quiet = false) {
      /*
       * Telemetry markers take the cheap path: the ring only.
       *
       * This method used to do the same seven things for every marker — a
       * console line, a beacon write, an object allocation, a markCall, and TWO
       * DOM writes — and gameplay emits ~230 markers a second, dominated by
       * per-packet `evt:` ones. Measured at 35.76 us each, that is ~500 ms of
       * every minute spent describing the frame rather than drawing it, and it
       * gets far worse with DevTools open, which is exactly when someone is
       * looking. The <dd> elements those DOM writes feed sit behind the canvas
       * and nobody reads them mid-game.
       *
       * The ring is what the tests and probes actually read, so it is kept
       * exact. `?mcweb_log_all=1` restores the full treatment for debugging.
       */
      // BrowserTextInput's state for the page's keyboard: state, not telemetry,
      // so it skips the stage ring and the console.
      if (typeof stage === "string" && stage.startsWith(TEXT_INPUT_PREFIX)) {
        globalThis.mcWebInput.reportTextInput(stage);
        return;
      }
      if (quiet || (!_logAllStages && typeof stage === "string" && _CHATTY_STAGE.test(stage))) {
        globalThis.__mcWebLastStage = stage;
        recordStage(stage);
        return;
      }
      console.log("[MC-INIT]", stage);
      /*
       * Mirror into shared linear memory, where a Worker can still read it after this
       * thread stops returning. Everything else in this method — the console line, the
       * stage ring, `__mcWebLastStage` — lives on the main thread and disappears with
       * it, which is why a world-load hang has never had a last known position.
       */
      globalThis.mcWebThreadRuntime?.beacon?.(0, stage);
      // Web Image strips *Java* stack traces (getStackTrace() is always empty),
      // but every @JS bridge call crosses into JavaScript, so the JS/wasm stack
      // at the boundary is still available -- and under WasmGC it carries wasm
      // frames. BrowserNativeMemory already reports each large allocation
      // through here, so capturing a stack at that moment attributes the block
      // to whatever asked for it, with no image rebuild.
      if (typeof stage === "string" && stage.startsWith("native:large-alloc")) {
        const sink = (globalThis.mcWebGpu._allocStacks ||= []);
        if (sink.length < 12) {
          sink.push({stage, stack: String(new Error("alloc").stack || "").split("\n").slice(1, 40)});
        }
      }
      // Read by tests/world-create.spec.ts, tools/menu-clickthrough.mjs,
      // tools/t0-probe.mjs and tools/browser-check.mjs. It was never assigned,
      // so every screen wait in those tools silently saw "" and fell through to
      // its timeout.
      globalThis.__mcWebLastStage = stage;
      recordStage(stage);
      markCall("reportProgress", {stage});
      setText("jar-status", "running the Minecraft client jar");
      setText("jar-method", stage);
    },

    /**
     * High-frequency probe channel: shared memory only, no console and no stage ring.
     *
     * Callers are spin loops that run while this thread is *not* returning to the
     * browser, so everything `reportProgress` also does — the console line, the stage
     * ring, the DOM text — is both unreachable and, at this rate, ruinous. The beacon
     * write is two atomics and a bounded byte copy, which is affordable inside a wait.
     */
    reportDiag(text) {
      globalThis.mcWebThreadRuntime?.diag?.(text);
      if (String(text ?? "").startsWith("worldgen:step-failure n=")) {
        globalThis.mcWebThreadRuntime?.stickyDiag?.(text);
      }
    },

    // DIAG: float contents of the small uniform buffers that drive fog and the
    // global render settings. A frame that is uniformly fog-coloured -- no
    // sky/ground split -- while terrain issues thousands of valid draws points
    // at the fog term saturating, not at missing geometry.
    dumpUniforms() {
      const out = {};
      for (const [handle, entry] of objects) {
        if (entry?.kind !== "buffer" || !entry._shadow) continue;
        const label = entry._label || String(handle);
        // All small buffers, not just fog: the terrain transform (projection,
        // model-view, per-section offset) lives in one of these, and a section
        // offset that never reaches the shader would draw every chunk at the
        // world origin -- hundreds of blocks from the player, so off-screen,
        // with entirely valid draw calls.
        if (entry.size > 4096) continue;
        const n = Math.min(entry._shadow.byteLength >> 2, 24);
        out[label] = {
          size: entry.size,
          floats: Array.from(new Float32Array(entry._shadow.buffer, entry._shadow.byteOffset || 0, n))
        };
      }
      return out;
    },

    // DIAG: every texture with its upload count. An atlas at 0 uploads never
    // received pixels; a non-zero count means the bytes arrived and any
    // blankness is downstream (blit, sampler, or the sprite UV lookup).
    /**
     * Every texture object matching `pattern`, with its handle and no top-N
     * slicing. dumpTextures() dedups and truncates, which hides the case where
     * several objects share a label (four are labelled blocks.png) and the one
     * being uploaded into is not the one a draw binds.
     */
    /**
     * Async readback of a small texture, for the two multipliers that can
     * saturate terrain to white. Returns a promise of RGBA rows. Only sane for
     * tiny textures -- the lightmap is 16x16.
     */
    async readSmallTexture(pattern) {
      const re = new RegExp(pattern, "i");
      let found = null;
      for (const [, entry] of objects) {
        if (entry?.kind === "texture" && re.test(String(entry._label ?? ""))) { found = entry; break; }
      }
      if (!found) return {error: "no texture matches " + pattern};
      const w = found.width, h = found.height;
      const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
      const readback = device.createBuffer({
        size: bytesPerRow * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        {texture: found.texture},
        {buffer: readback, bytesPerRow, rowsPerImage: h},
        {width: w, height: h, depthOrArrayLayers: 1}
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(readback.getMappedRange().slice(0));
      readback.unmap();
      readback.destroy();
      // Sample a coarse grid across the whole texture, so this works for a
      // 2048x2048 atlas as well as a 16x16 lightmap.
      const stepX = Math.max(1, Math.floor(w / 16));
      const stepY = Math.max(1, Math.floor(h / 16));
      const rows = [];
      const histogram = new Map();
      for (let y = 0; y < h; y += stepY) {
        const row = [];
        for (let x = 0; x < w; x += stepX) {
          const o = y * bytesPerRow + x * 4;
          row.push([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        }
        rows.push(row);
      }
      for (let y = 0; y < h; y += 4) {
        for (let x = 0; x < w; x += 4) {
          const o = y * bytesPerRow + x * 4;
          const key = `${bytes[o]},${bytes[o + 1]},${bytes[o + 2]},${bytes[o + 3]}`;
          histogram.set(key, (histogram.get(key) ?? 0) + 1);
        }
      }
      return {
        label: found._label,
        wh: `${w}x${h}`,
        rows,
        top: [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      };
    },

    /**
     * Decode the vertices a terrain draw actually consumed. The section uber
     * buffers are far above the CPU-shadow limit, so this reads the real GPU
     * buffer back rather than a mirror -- the mirror does not exist for them,
     * and the port's own readback path returns zeros for GPU-written buffers.
     */
    /** Read back any recorded uniform range as floats and ints. */
    async readUniformRange(which) {
      const rec = globalThis.mcWebGpu._terrainDrawSample?.[which];
      if (!rec) return {error: "no range for " + which};
      const entry = objects.get(rec.bufferHandle);
      if (!entry) return {error: "buffer gone"};
      const size = Math.ceil(Math.min(rec.size || 256, entry.size - rec.offset) / 4) * 4;
      if (size <= 0) return {error: "empty range", rec};
      const readback = device.createBuffer({
        size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(entry.buffer, rec.offset, readback, 0, size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const raw = readback.getMappedRange().slice(0);
      readback.unmap();
      readback.destroy();
      return {
        rec,
        floats: Array.from(new Float32Array(raw)).map((x) => Math.round(x * 10000) / 10000),
        ints: Array.from(new Int32Array(raw))
      };
    },

    /**
     * The shared sequential quad-index buffer a terrain draw used. All-zero
     * indices make every triangle degenerate: no fragments, from draw calls
     * that validate cleanly and carry correct vertices and uniforms.
     */
    /**
     * Depth histogram. Colour-independent answer to "did terrain rasterise?":
     * the pass clears depth to 0 and terrain writes depth, so any texel that is
     * not 0 is geometry that passed the depth test and wrote. All-zero means
     * nothing ever rasterised, whatever the colour buffer shows.
     */
    /** The depth snapshot taken the instant a terrain pass ended. */
    async readTerrainPassDepth() {
      if (!_depthSnapshot) return {error: "no terrain pass depth captured"};
      if (_depthSnapshot.error) return _depthSnapshot;
      await _depthSnapshot.buffer.mapAsync(GPUMapMode.READ);
      const raw = _depthSnapshot.buffer.getMappedRange().slice(0);
      _depthSnapshot.buffer.unmap();
      const floats = new Float32Array(raw);
      const perRow = _depthSnapshot.bytesPerRow / 4;
      let zero = 0, nonZero = 0, min = Infinity, max = -Infinity;
      for (let y = 0; y < _depthSnapshot.height; y += 2) {
        for (let x = 0; x < _depthSnapshot.width; x += 2) {
          const d = floats[y * perRow + x];
          if (d === 0) zero++; else { nonZero++; if (d < min) min = d; if (d > max) max = d; }
        }
      }
      return {label: _depthSnapshot.label, drawn: _depthSnapshot.drawn,
              tick: _depthSnapshot.tick, zero, nonZero,
              min: nonZero ? min : null, max: nonZero ? max : null};
    },

    async readDepthHistogram() {
      let found = null;
      for (const [, entry] of objects) {
        if (entry?.kind === "texture" && /depth/i.test(String(entry._label ?? ""))) {
          if (!found || entry.width > found.width) found = entry;
        }
      }
      if (!found) return {error: "no depth texture"};
      const w = found.width, h = found.height;
      const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
      const readback = device.createBuffer({
        size: bytesPerRow * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        {texture: found.texture, aspect: "depth-only"},
        {buffer: readback, bytesPerRow, rowsPerImage: h},
        {width: w, height: h, depthOrArrayLayers: 1}
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const raw = readback.getMappedRange().slice(0);
      readback.unmap();
      readback.destroy();
      const floats = new Float32Array(raw);
      let zero = 0, nonZero = 0, min = Infinity, max = -Infinity;
      const perRow = bytesPerRow / 4;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const d = floats[y * perRow + x];
          if (d === 0) zero++; else { nonZero++; if (d < min) min = d; if (d > max) max = d; }
        }
      }
      return {
        label: found._label, wh: `${w}x${h}`, format: found.format,
        zero, nonZero,
        min: nonZero ? min : null, max: nonZero ? max : null
      };
    },

    async readTerrainIndices() {
      const rec = globalThis.mcWebGpu._terrainDrawSample;
      if (!rec?.indexBufferHandle) return {error: "no index buffer captured", rec};
      const entry = objects.get(rec.indexBufferHandle);
      if (!entry) return {error: "index buffer gone"};
      const wide = rec.indexFormat !== "uint16";
      const stride = wide ? 4 : 2;
      const first = rec.firstIndex * stride;
      const size = Math.min(48 * stride, entry.size - first);
      if (size <= 0) return {error: "range past end", rec};
      const readback = device.createBuffer({
        size: Math.ceil(size / 4) * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(entry.buffer, first, readback, 0, Math.ceil(size / 4) * 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const raw = readback.getMappedRange().slice(0);
      readback.unmap();
      readback.destroy();
      const values = Array.from(wide ? new Uint32Array(raw) : new Uint16Array(raw));
      return {
        label: entry._label,
        bufferSize: entry.size,
        format: rec.indexFormat,
        indexCount: rec.indexCount,
        firstIndex: rec.firstIndex,
        baseVertex: rec.baseVertex,
        first48: values.slice(0, 48)
      };
    },

    /**
     * The transform the GPU actually saw, read back from the uniform buffer
     * rather than from a host-side shadow copy. A shadow can be stale or
     * mis-offset; this cannot.
     */
    async readTerrainUniform(name, from) {
      const rec = from === "visible"
        ? globalThis.mcWebGpu._visibleDrawSample
        : globalThis.mcWebGpu._terrainDrawSample;
      const range = rec && rec[name];
      if (!range) return {error: "no " + name + " range captured"};
      const entry = objects.get(range.bufferHandle);
      if (!entry) return {error: name + " buffer gone"};
      const size = Math.min(64, range.size || 64);
      const readback = device.createBuffer({
        size: Math.ceil(size / 4) * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(entry.buffer, range.offset, readback, 0,
          Math.ceil(size / 4) * 4);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const floats = new Float32Array(readback.getMappedRange().slice(0));
        readback.unmap();
        readback.destroy();
        return {name, floats: Array.from(floats).map((v) => Number(v.toFixed(4)))};
      } catch (error) {
        try { readback.destroy(); } catch (ignored) { /* best effort */ }
        return {error: String(error).slice(0, 160)};
      }
    },

    async readTerrainVertices() {
      const rec = globalThis.mcWebGpu._terrainDrawSample;
      if (!rec) return {error: "no terrain draw captured"};
      const entry = objects.get(rec.bufferHandle);
      if (!entry) return {error: "vertex buffer gone"};
      const count = 8;
      // Decode the vertices the draw actually used. An indexed draw starts at
      // baseVertex, so reading from the binding offset alone decodes whatever
      // happens to sit at the start of a 16 MB shared buffer - which looks
      // like garbage and says nothing about the geometry that was drawn.
      const start = (rec.offset || 0) + (rec.baseVertex || 0) * rec.stride;
      const size = Math.min(rec.stride * count, entry.size - start);
      if (size <= 0) return {error: "offset past end", rec, start};
      const readback = device.createBuffer({
        size: Math.ceil(size / 4) * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(entry.buffer, start, readback, 0, Math.ceil(size / 4) * 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const raw = readback.getMappedRange().slice(0);
      readback.unmap();
      readback.destroy();
      const view = new DataView(raw);
      const bytes = new Uint8Array(raw);
      const out = [];
      for (let v = 0; v * rec.stride + 28 <= raw.byteLength; v++) {
        const base = v * rec.stride;
        out.push({
          position: [view.getFloat32(base, true), view.getFloat32(base + 4, true), view.getFloat32(base + 8, true)],
          color: [bytes[base + 12], bytes[base + 13], bytes[base + 14], bytes[base + 15]],
          uv0: [view.getFloat32(base + 16, true), view.getFloat32(base + 20, true)],
          uv2: [view.getInt16(base + 24, true), view.getInt16(base + 26, true)]
        });
      }
      return {rec, start, vertices: out};
    },

    dumpTexturesMatching(pattern) {
      const re = new RegExp(pattern, "i");
      const out = [];
      for (const [handle, entry] of objects) {
        if (entry?.kind !== "texture") continue;
        const label = String(entry._label ?? "?");
        if (!re.test(label)) continue;
        out.push({
          handle,
          label: label.slice(0, 46),
          wh: `${entry.width}x${entry.height}`,
          mipLevels: entry.texture?.mipLevelCount ?? null,
          uploads: entry._uploads || 0,
          copiesIn: entry._copiesIn || 0,
          copiesOut: entry._copiesOut || 0
        });
      }
      return out;
    },

    dumpTextures() {
      const out = [];
      for (const [, entry] of objects) {
        if (entry?.kind !== "texture") continue;
        out.push({
          label: (entry._label || "?").slice(0, 46),
          wh: `${entry.width}x${entry.height}`,
          uploads: entry._uploads || 0,
          // An atlas is stitched by blitting each sprite in, so writeTexture64
          // uploads can legitimately be 0 while the texture is still fully
          // populated. copiesIn is what distinguishes "assembled by blit" from
          // "never filled at all".
          copiesIn: entry._copiesIn || 0
        });
      }
      return out.filter((t) => /atlas|lightmap|font|gui/i.test(t.label))
                .sort((a, b) => (b.copiesIn + b.uploads) - (a.copiesIn + a.uploads))
                .slice(0, 25);
    },

    /** Raw frame/stutter census used by the on-screen graph, without the
     *  method-wrapping overhead of the full performance profiler. */
    /** Bind-group cache effectiveness: hit/miss since boot, and live size. */
    bindGroupStats() {
      return {..._bindGroupStats, size: _bindGroupCache.size};
    },

    // Called directly by the RPC worker after a complete present batch.
    submittedWorkDone() {
      return device.queue.onSubmittedWorkDone();
    },

    frameGraphReport() {
      return _frameGraph.report();
    },

    /** Start a clean raw measurement window after boot/join has settled. */
    frameGraphReset() {
      _frameGraph.reset();
      return true;
    },

    /**
     * Real cloud-path evidence used by the localhost visual gate. Suppression
     * is opt-in and diagnostic-only: normal Minecraft rendering never calls
     * this method. Toggling the existing pipeline filter in the same live world
     * gives the pixel test a causal clouds-on / clouds-off comparison without
     * changing the camera, weather, world, or Minecraft's cloud settings.
     */
    setDiagnosticPipelineSuppression(pattern) {
      const raw = String(pattern ?? "").trim();
      if (raw.length > 128) throw new Error("diagnostic pipeline pattern is too long");
      _diagnosticSuppression = raw ? new RegExp(raw, "i") : null;
      return _diagnosticSuppression ? String(_diagnosticSuppression) : null;
    },

    cloudDrawReset() {
      delete globalThis.mcWebGpu._cloudDraws;
      return true;
    },

    cloudDrawReport() {
      return {
        draws: globalThis.mcWebGpu._cloudDraws ?? null,
        validationErrors: (globalThis.mcWebGpu._valErrors ?? []).slice(-10),
        firstGpuError: globalThis.mcWebGpu._firstGpuError ?? null
      };
    },

    /**
     * Frame-time and bridge-cost census. `sinceFrame` drops the boot and
     * world-load frames, which are enormous and would otherwise dominate every
     * average; pass the tick at which the world became steady.
     */
    perfReport(sinceFrame = 0) {
      if (!_perf.on) return {error: "profiler off; load with ?mcweb_perf=1"};
      const frames = _perf.frames.slice(sinceFrame);
      const hostFrames = _perf.hostFrames.slice(sinceFrame);
      const callFrames = _perf.callFrames.slice(sinceFrame);
      const rafGaps = _perf.rafGaps.slice(sinceFrame);
      if (!frames.length) return {error: "no frames recorded"};
      const sorted = [...frames].sort((a, b) => a - b);
      const sortedGaps = [...rafGaps].sort((a, b) => a - b);
      const gpuQueueMs = _perf.gpuQueueMs.slice();
      const sortedGpu = [...gpuQueueMs].sort((a, b) => a - b);
      const sum = (xs) => xs.reduce((a, b) => a + b, 0);
      const totalMs = sum(frames);
      const hostMs = sum(hostFrames);
      const round = (x) => Math.round(x * 100) / 100;
      return {
        frames: frames.length,
        fps: round(1000 / (totalMs / frames.length)),
        frameMs: {
          mean: round(totalMs / frames.length),
          p50: round(_percentile(sorted, 0.5)),
          p95: round(_percentile(sorted, 0.95)),
          p99: round(_percentile(sorted, 0.99)),
          max: round(sorted[sorted.length - 1])
        },
        rafGapMs: {
          mean: round(sum(rafGaps) / Math.max(1, rafGaps.length)),
          p50: round(_percentile(sortedGaps, 0.5)),
          p95: round(_percentile(sortedGaps, 0.95)),
          p99: round(_percentile(sortedGaps, 0.99)),
          max: round(sortedGaps.length ? sortedGaps[sortedGaps.length - 1] : 0),
          over50: rafGaps.filter((x) => x > 50).length,
          over100: rafGaps.filter((x) => x > 100).length,
          over250: rafGaps.filter((x) => x > 250).length
        },
        gpuQueue: {
          timing: "coarse queue.submit -> onSubmittedWorkDone (asynchronous)",
          submits: _perf.gpuSubmits,
          samples: gpuQueueMs.length,
          mean: round(sum(gpuQueueMs) / Math.max(1, gpuQueueMs.length)),
          p50: round(_percentile(sortedGpu, 0.5)),
          p95: round(_percentile(sortedGpu, 0.95)),
          max: round(sortedGpu.length ? sortedGpu[sortedGpu.length - 1] : 0),
          timestampQuerySupported: Boolean(globalThis.mcWebGpu?._gpuTiming?.timestampQuery)
        },
        // The split that decides where optimisation effort belongs.
        hostMsPerFrame: round(hostMs / frames.length),
        javaMsPerFrame: round((totalMs - hostMs) / frames.length),
        hostSharePct: round((hostMs / totalMs) * 100),
        bridgeCallsPerFrame: Math.round(sum(callFrames) / frames.length),
        // Whole-run totals, ranked by cost rather than by count -- the two
        // orders disagree, and the cheap-but-numerous calls are the trap.
        topCallsByMs: [..._perf.calls.entries()]
          .sort((a, b) => b[1].ms - a[1].ms)
          .slice(0, 18)
          .map(([name, e]) => ({
            name,
            ms: Math.round(e.ms),
            n: e.n,
            usPerCall: round((e.ms / e.n) * 1000)
          }))
      };
    },

    /**
     * Raw per-frame total/host millisecond arrays for the probe harnesses that
     * need the distribution rather than perfReport's summary (long-frame
     * host-vs-Java split). Read-only; returns copies.
     */
    perfFrames(sinceFrame = 0) {
      if (!_perf.on) return {error: "profiler off; load with ?mcweb_perf=1"};
      return {
        frames: _perf.frames.slice(sinceFrame),
        hostFrames: _perf.hostFrames.slice(sinceFrame),
        uploadBytes: _perf.uploadBytesFrames.slice(sinceFrame),
        slowFrames: _perf.slowFrameUploads,
      };
    },

    reportJavaFailure(stage, type, message) {
      const activeStage = globalThis.__mcWebLastStage || stage;
      const failureNumber = (globalThis.mcWebGpu._javaFailureCount || 0) + 1;
      globalThis.mcWebGpu._javaFailureCount = failureNumber;
      // Same trick at the failure boundary. This is the catch site rather than
      // the throw site, but the wasm frames below it still name the call path
      // the frame pump was in when the heap gave out.
      globalThis.mcWebGpu._failStack =
        String(new Error("fail").stack || "").split("\n").slice(1, 40);
      // The bridge calls immediately preceding the failure. Web Image gives no
      // Java stack, but every GPU operation crosses this boundary, so the tail
      // of this list brackets whatever the frame pump was doing when it threw.
      // First failure only: the frame pump now survives a bad frame, so later
      // failures would otherwise overwrite the one that started the cascade.
      globalThis.mcWebGpu._recentAtFail ||= _recentCalls();
      globalThis.mcWebGpu._recentAtLastFail = _recentCalls();
      // `stage` is the caller's own label ("integrated-server", "frame-pump",
      // …) and names the subsystem that caught the throw; `activeStage` is only
      // the last progress marker anyone recorded. Keep both: with no Java stack
      // traces under Web Image, the caller label is the single most direct clue
      // about where a failure came from, and it used to be dropped here.
      recordStage(`FAIL source=${stage} ${activeStage} ${type}`);
      console.error("[MC-FAIL]", `source=${stage}`, activeStage, type, message);
      if (failureNumber === 1) {
        console.error("[MC-FAIL-RECENT]", globalThis.mcWebGpu._recentAtFail.join(" | "));
      }
      markCall("reportJavaFailure", {source: stage, stage: activeStage, type, message});
      const detail = `${type}${message ? `: ${message}` : ""}`;
      setText("jar-status", "runtime error");
      setText("jar-method", activeStage);
      failure.hidden = false;
      failure.textContent = `${activeStage}\n${detail}`;
      globalThis.mcWebGpu.lastJavaFailure = {source: stage, stage: activeStage, type, message};
    }
  };

  // Capture the unwrapped render operations before ?mcweb_perf replaces every
  // public bridge function with a timing wrapper. Stream replay is one bridge
  // call; counting its internal JS dispatches as additional crossings would
  // both perturb the benchmark and lie about the boundary reduction.
  const _renderPassReplay = Object.freeze({
    end: globalThis.mcWebGpu.rpEnd,
    setPipeline: globalThis.mcWebGpu.rpSetPipeline,
    bindTexture: globalThis.mcWebGpu.rpBindTexture,
    setUniform: globalThis.mcWebGpu.rpSetUniform,
    setVertexBuffer: globalThis.mcWebGpu.rpSetVertexBuffer,
    setIndexBuffer: globalThis.mcWebGpu.rpSetIndexBuffer,
    scissor: globalThis.mcWebGpu.rpScissor,
    disableScissor: globalThis.mcWebGpu.rpDisableScissor,
    draw: globalThis.mcWebGpu.rpDraw,
    drawIndexed: globalThis.mcWebGpu.rpDrawIndexed,
    drawIndirect: globalThis.mcWebGpu.rpDrawIndirect,
    drawIndexedIndirect: globalThis.mcWebGpu.rpDrawIndexedIndirect,
    pushDebugGroup: globalThis.mcWebGpu.rpPushDebugGroup,
    popDebugGroup: globalThis.mcWebGpu.rpPopDebugGroup
  });

  const _renderCommandHandlers = Object.freeze({
    setPipeline(host, pass, pipeline) {
      _renderPassReplay.setPipeline.call(host, pass, pipeline);
    },
    bindTexture(host, pass, nameId, view, sampler) {
      const name = resolveBindingName(nameId, "render texture");
      _renderPassReplay.bindTexture.call(host, pass, name, view, sampler);
    },
    setUniform(host, pass, nameId, buffer, offset, size) {
      const name = resolveBindingName(nameId, "render uniform");
      _renderPassReplay.setUniform.call(host, pass, name, buffer, offset, size);
    },
    setVertexBuffer(host, pass, slot, buffer, offset, size) {
      _renderPassReplay.setVertexBuffer.call(host, pass, slot, buffer, offset, size);
    },
    setIndexBuffer(host, pass, buffer, formatCode) {
      const format = formatCode === 0 ? "uint16" : formatCode === 1 ? "uint32" : null;
      if (!format) throw new Error(`unknown render index format ${formatCode}`);
      _renderPassReplay.setIndexBuffer.call(host, pass, buffer, format);
    },
    scissor(host, pass, x, y, width, height) {
      _renderPassReplay.scissor.call(host, pass, x, y, width, height);
    },
    disableScissor(host, pass) {
      _renderPassReplay.disableScissor.call(host, pass);
    },
    draw(host, pass, firstVertex, vertexCount, instanceCount, firstInstance) {
      _renderPassReplay.draw.call(
        host, pass, firstVertex, vertexCount, instanceCount, firstInstance
      );
    },
    drawIndexed(host, pass, indexCount, instanceCount, firstIndex, baseVertex, firstInstance) {
      _renderPassReplay.drawIndexed.call(
        host, pass, indexCount, instanceCount, firstIndex, baseVertex, firstInstance
      );
    },
    drawIndirect(host, pass, buffer, offset, drawCount) {
      _renderPassReplay.drawIndirect.call(host, pass, buffer, offset, drawCount);
    },
    drawIndexedIndirect(host, pass, buffer, offset, drawCount) {
      _renderPassReplay.drawIndexedIndirect.call(host, pass, buffer, offset, drawCount);
    },
    pushDebugGroup(host, pass, labelId) {
      const label = host._bindingNames?.[labelId];
      if (typeof label !== "string") throw new Error(`unknown render debug label ${labelId}`);
      _renderPassReplay.pushDebugGroup.call(host, pass, label);
    },
    popDebugGroup(host, pass) {
      _renderPassReplay.popDebugGroup.call(host, pass);
    }
  });

  function replayRenderPassCommands(
    host, passHandle, payload, byteLength, end, transport, rawWordReader
  ) {
    let replaying = false;
    try {
      if (!Number.isInteger(byteLength) || byteLength < 0 || (byteLength & 3) !== 0) {
        throw new RangeError(`invalid render command byte length ${byteLength}`);
      }
      const protocol = globalThis.mcWebRenderCommands;
      if (!protocol) throw new Error("render command stream decoder is unavailable");
      const stats = (diagnostics.renderCommands ||= {
        streams: 0, bytes: 0, maxBytes: 0, empty: 0,
        le64: 0, le256: 0, le1024: 0, over1024: 0
      });
      stats.streams++;
      stats.bytes += byteLength;
      stats.maxBytes = Math.max(stats.maxBytes, byteLength);
      if (byteLength === 0) stats.empty++;
      else if (byteLength <= 64) stats.le64++;
      else if (byteLength <= 256) stats.le256++;
      else if (byteLength <= 1024) stats.le1024++;
      else stats.over1024++;
      markCall("rpCommandStream", {passHandle, byteLength, end: Boolean(end)});
      _renderCommandReplayDepth++;
      replaying = true;
      let count;
      if (transport === "wasmgc-reader") {
        if (typeof protocol.replayReader !== "function") {
          throw new Error("raw WasmGC render command decoder is unavailable");
        }
        count = protocol.replayReader(
          payload, byteLength >>> 2, rawWordReader,
          _renderCommandHandlers, host, passHandle
        );
      } else if (transport === "packed-text") {
        if (typeof protocol.replayText !== "function") {
          throw new Error("packed render command decoder is unavailable");
        }
        count = protocol.replayText(
          payload, byteLength >>> 2, _renderCommandHandlers, host, passHandle
        );
      } else {
        const bytes = transport === "base64" ? base64ToBytes(payload) : payload;
        if (transport === "base64" && bytes.byteLength !== byteLength) {
          throw new Error(
            `render command base64 length mismatch: ${bytes.byteLength} != ${byteLength}`
          );
        }
        count = protocol.replay(
          bytes, byteLength, _renderCommandHandlers, host, passHandle
        );
      }
      if (end) _renderPassReplay.end.call(host, passHandle);
      return count;
    } catch (error) {
      // A failed segment is not recoverable, even when it was flushed for a
      // timestamp rather than pass end. Never strand an open pass encoder.
      if (objects.has(passHandle)) {
        try {
          _renderPassReplay.end.call(host, passHandle);
        } catch (_cleanupError) {
          objects.delete(passHandle);
        }
      }
      throw error;
    } finally {
      if (replaying) _renderCommandReplayDepth--;
    }
  }

  addEventListener("error", (event) => fail(event.error || event.message));
  addEventListener("unhandledrejection", (event) => fail(event.reason));

  /**
   * Waits for one painted frame, or for `budgetMs`, whichever comes first.
   *
   * Nothing on the boot path may block on an animation frame. Animation frames
   * are a rendering courtesy the browser can withhold — a hidden tab, an
   * occluded window, a backgrounded process — and every second of that wait is
   * a second the game is not starting for a player who is sitting there
   * watching it.
   */
  function paintOrGiveUp(budgetMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, budgetMs);
    });
  }

  (async () => {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable in this browser");
    // Everything from here to the first [MC-INIT] line used to report nothing,
    // so a slow adapter or a cold Wasm compile was indistinguishable from a
    // hang. Each step names itself before it can block.
    globalThis.mcWebBootOverlay.stage("asking the browser for a WebGPU adapter…");
    adapter = await navigator.gpu.requestAdapter({powerPreference: "high-performance"});
    if (discarded) return;
    if (!adapter) throw new Error("No WebGPU adapter was returned");
    globalThis.mcWebBootOverlay.stage("opening the GPU device…");
    // 26.3's order-independent transparency blends into RGBA32_FLOAT targets,
    // which WebGPU allows only with float32-blendable; float32-filterable
    // lets those targets sit in filtering slots. Both are optional and asked
    // for only when offered. Without blending the transparency pipelines
    // that need it draw with the error shader, so the game must keep its
    // improved transparency off on such a device.
    const optionalFeatures = ["float32-blendable", "float32-filterable"].filter((f) => adapter.features?.has?.(f));
    device = await adapter.requestDevice({requiredFeatures: optionalFeatures});
    if (discarded) { device.destroy(); device = adapter = null; return; }
    _shaderOut(`[shader] device features: ${optionalFeatures.join(", ") || "no float32-blendable or float32-filterable"}`);
    globalThis.mcWebGpu._gpuTiming = {
      timestampQuery: Boolean(adapter.features?.has?.("timestamp-query")),
      method: adapter.features?.has?.("timestamp-query")
        ? "timestamp-query capability detected; per-pass query wiring remains opt-in"
        : "coarse queue completion"
    };
    device.lost.then((info) => { if (!discarded) fail(new Error(`WebGPU device lost: ${info.message}`)); });
    // Draw-time validation errors were never captured: the existing error
    // scopes only wrap pipeline and buffer creation. A draw whose bound vertex
    // range does not cover baseVertex+indexCount is rejected by the browser and
    // produces no fragments -- silently, with a clean log and a correct-looking
    // draw call. Terrain issues valid draws and renders nothing, so this is the
    // gap that has to be closed before blaming anything else.
    device.addEventListener?.("uncapturederror", (event) => {
      const sink = (globalThis.mcWebGpu._gpuErrors ||= {count: 0, byMessage: {}});
      sink.count++;
      const message = String(event.error?.message ?? event.error).slice(0, 220);
      noteTextureValidation(message, _lastSubmitTextureCandidate);
      sink.byMessage[message] = (sink.byMessage[message] || 0) + 1;
      if (sink.count <= 5) console.error("[GPU-ERROR]", message);
    });
    globalThis.mcWebGpu = globalThis.mcWebGpu || {};
    globalThis.mcWebGpu._limits = {
      maxBindGroups: device.limits?.maxBindGroups,
      maxBindingsPerBindGroup: device.limits?.maxBindingsPerBindGroup
    };
    context = canvas.getContext("webgpu");

    globalThis.mcWebCanvas.resizeBackingStore();
    setText("gpu-status", `adapter ready: ${globalThis.mcWebGpu.adapterName()}`);

    // Main-thread heartbeat, independent of requestAnimationFrame. setInterval
    // only fires when the main thread is idle between tasks; if a synchronous
    // Java call (the constructor's trailing boot, or runTick) blocks the thread,
    // the beats stop. So "beats keep climbing but no [pump] enter / no further
    // [MC-INIT]" ⇒ boot LOGIC is stalled (thread free); "beats stop" ⇒ the
    // thread is BLOCKED in a synchronous call. globalThis.mcWebGpu._beats is
    // readable from the probe at any time.
    globalThis.mcWebGpu._beats = 0;
    heartbeatInterval = setInterval(() => { globalThis.mcWebGpu._beats = (globalThis.mcWebGpu._beats || 0) + 1; }, 2000);

    // ?mcweb_perf=1 -- frame-time distribution plus a per-bridge-call cost and
    // count census. Two performance.now() calls per bridge crossing is far too
    // expensive to leave on (a busy frame makes tens of thousands of them), so
    // this stays opt-in and the unflagged path keeps the original functions.
    if (new URLSearchParams(location.search).has("mcweb_perf")) {
      installPerfProfiler();
    }

    const launchParams = new URLSearchParams(location.search);
    if (launchParams.has("mcweb_debug")) {
      // Keep the allocator counters next to the frame/GC markers while diagnosing
      // WasmLM pressure. The call is opt-in: it re-enters the image and must not be
      // part of the normal render loop.
      countersInterval = setInterval(() => {
        try {
          const counters = globalThis.mcWebThreadRuntime?.imageCounters?.();
          if (counters) console.log("[THREAD-COUNTERS] " + JSON.stringify(counters));
        } catch (error) {
          console.warn("[THREAD-COUNTERS] failed", error);
        }
      }, 5000);
    }
    // The pre-runtime auth boundary exposes only the profile name/UUID. This
    // bounded promise normally finished while WebGPU initialised; awaiting it
    // here guarantees Minecraft's GameConfig sees the authenticated identity,
    // with a 200 ms offline fallback in explicit prototyping mode.
    await globalThis.mcWebNet?.identityReady?.();

    const requestedImage = launchParams.get("image");
    const defaultImage = globalThis.mcWebConfig?.runtime?.image || "minecraft-client";
    let imageName = requestedImage && /^[a-z0-9.-]+$/i.test(requestedImage)
      ? requestedImage
      : defaultImage; // canonical WasmGC image; ?image= remains diagnostic-only
    globalThis.mcWebImageName = imageName;
    globalThis.mcWebRuntimeMode = imageName.endsWith("-threaded")
      ? "WASMLM_THREADED"
      : imageName.includes("-lm")
        ? "WASMLM_INLINE"
        : "WASMGC_COOPERATIVE";
    console.log(`[mcweb-host] runtime mode ${globalThis.mcWebRuntimeMode}`);
    if (imageName.endsWith("-threaded")) {
      const requestedAgents = Number(launchParams.get("mcweb_threads") || 6);
      const agentCount = Math.max(0, Math.min(8, Number.isFinite(requestedAgents) ? requestedAgents | 0 : 6));
      if (!globalThis.mcWebWasmLMThreads) {
        throw new Error("WasmLM thread host was not loaded");
      }
      await globalThis.mcWebWasmLMThreads.prepare(imageName, agentCount);
      console.log(`[mcweb-host] threaded WasmLM image ${imageName}, ${agentCount} agents`);
    }
    const script = document.createElement("script");
    if (imageName === defaultImage) {
      // graalWebImage patches Config.wasm_path to consume this explicit URL.
      // Version both requests with one tag: the page must never instantiate a
      // new Wasm binary against an older cached generated loader (or vice versa).
      globalThis.mcWebGraalWasmPath = new URL(
        `graal/${imageName}.js.wasm?v=${MCWEB_CACHE_TAG}`,
        location.href,
      ).href;
      script.src = `graal/${imageName}.js?v=${MCWEB_CACHE_TAG}`;
    } else {
      // Historical diagnostic images were built before the explicit-path
      // loader patch and retain Web Image's original sibling derivation.
      delete globalThis.mcWebGraalWasmPath;
      script.src = `graal/${imageName}.js`;
    }
    script.onload = () => setText("jar-status", "WebAssembly runtime loaded; starting JAR…");
    script.onerror = () => fail(new Error("Could not load the GraalVM Web Image runtime"));
    globalThis.mcWebBootOverlay.status("Starting Minecraft…");
    globalThis.mcWebBootOverlay.stage(
      "loading and compiling the Minecraft WebAssembly image…");
    // Give the page a chance to paint that message before the loader is
    // attached, because compiling and running the image occupies this thread in
    // long stretches. Never *wait* on it: Chrome stops delivering animation
    // frames to an occluded window while still reporting visibilityState
    // "visible", so a bare rAF await here parked the entire boot until the
    // window was raised again. That is what "waited 75s, switched tabs, it
    // loaded" looks like from the outside.
    await paintOrGiveUp(250);
    document.body.append(script);
  })().catch(fail);
})();
