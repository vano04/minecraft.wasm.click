import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

// Load the complete worker environment, lifetime implementation, command
// decoder and production host. The fake GPU records commands and models only
// byte uploads/copies/readbacks; it is not a rendered-terrain acceptance test.
const source = await Promise.all([
  "OpenJDK/browser/worker-env.js", "web/webgpu-texture-lifetime.js",
  "web/render-command-stream.js", "web/shader-glue.js", "web/webgpu-host.js",
].map(async (path) => [path, await readFile(new URL("../" + path, import.meta.url), "utf8")]));
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const flags = ["mcweb_debug", "mcweb_texdiag", "mcweb_atlasdiag", "mcweb_uploaddiag"];

function fakeGpu() {
  let next = 1;
  const calls = [], listeners = new Map(), fences = [], scopeErrors = [], buffers = [], textures = [], mappings = [];
  const controls = {fail: null, deferMapping: false, poisonPadding: false};
  const trip = (name) => { if (controls.fail === name) throw new Error(name + " fixture failure"); };
  const record = (name, detail = {}) => calls.push([name, plain(detail)]);
  const object = (kind, descriptor) => ({id: next++, kind, descriptor});
  const texture = (descriptor) => {
    const size = descriptor.size;
    const [width, height, depth] = Array.isArray(size)
      ? [size[0], size[1], size[2] || 1] : [size.width, size.height, size.depthOrArrayLayers || 1];
    const t = {...object("texture", descriptor), width, height, depth,
      mipLevelCount: descriptor.mipLevelCount || 1, bytes: new Uint8Array(width * height * depth * 4), destroyCount: 0,
      createView(spec = {}) { const view = {...object("view", spec), texture: t}; record("createView", {id: view.id, texture: t.id, spec}); return view; },
      destroy() { t.destroyCount++; record("destroyTexture", {id: t.id}); }};
    textures.push(t);
    record("createTexture", {id: t.id, descriptor});
    return t;
  };
  const origin = (where) => ({x: where?.x || 0, y: where?.y || 0, z: where?.z || 0});
  const copyToTexture = (dst, bytes, layout, size) => {
    const t = dst.texture, o = origin(dst.origin);
    for (let z = 0; z < (size.depthOrArrayLayers || 1); z++) for (let y = 0; y < size.height; y++) {
      const from = (layout.offset || 0) + z * layout.bytesPerRow * (layout.rowsPerImage || size.height) + y * layout.bytesPerRow;
      const to = (((o.z + z) * t.height + o.y + y) * t.width + o.x) * 4;
      t.bytes.set(bytes.subarray(from, from + size.width * 4), to);
    }
  };
  const queue = {
    writeTexture(dst, data, layout, size) {
      trip("writeTexture");
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      record("writeTexture", {texture: dst.texture.id, origin: origin(dst.origin), mip: dst.mipLevel || 0,
        bytes: [...bytes], layout, size});
      copyToTexture(dst, bytes, layout, size);
    },
    writeBuffer(buffer, offset, data) {
      const bytes = new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
      record("writeBuffer", {buffer: buffer.id, offset, bytes: [...bytes]}); buffer.bytes.set(bytes, offset);
    },
    submit(commands) { trip("submit"); record("submit", {commands: commands.map((c) => c.id)}); for (const c of commands) for (const run of c.ops) run(); },
    onSubmittedWorkDone() { record("fence"); return new Promise((resolve) => fences.push(resolve)); },
  };
  const device = {
    queue, limits: {maxBindGroups: 4, maxBindingsPerBindGroup: 1000}, lost: new Promise(() => {}),
    addEventListener(name, callback) { listeners.set(name, callback); },
    createTexture: texture,
    createBuffer(descriptor) {
      trip("createBuffer");
      const b = {...object("buffer", descriptor), bytes: new Uint8Array(descriptor.size),
        destroyCount: 0, unmapCount: 0, mapped: false,
        mapAsync() {
          trip("mapAsync");
          if (controls.fail === "mapReject") return Promise.reject(new Error("mapReject fixture failure"));
          if (controls.deferMapping) return new Promise((resolve, reject) => mappings.push({resolve, reject}))
            .then(() => { b.mapped = true; });
          b.mapped = true; return Promise.resolve();
        },
        getMappedRange() {
          trip("getMappedRange");
          return b.bytes.buffer;
        },
        unmap() { b.unmapCount++; b.mapped = false; },
        destroy() { b.destroyCount++; b.destroyedWhileMapped = b.mapped; record("destroyBuffer", {id: b.id}); }};
      buffers.push(b);
      record("createBuffer", {id: b.id, descriptor}); return b;
    },
    createSampler(descriptor) { const s = object("sampler", descriptor); record("createSampler", {id: s.id, descriptor}); return s; },
    createShaderModule(descriptor) { const s = object("shader", descriptor); record("createShaderModule", {id: s.id, descriptor}); return s; },
    createBindGroupLayout(descriptor) { const l = object("bindGroupLayout", descriptor); record("createBindGroupLayout", {id: l.id, descriptor}); return l; },
    createPipelineLayout(descriptor) { const l = object("pipelineLayout", descriptor); record("createPipelineLayout", {id: l.id}); return l; },
    createRenderPipeline(descriptor) {
      const p = {...object("pipeline", descriptor), getBindGroupLayout(i) { return descriptor.layout.descriptor.bindGroupLayouts[i]; }};
      record("createRenderPipeline", {id: p.id, depthFormat: descriptor.depthStencil?.format || null}); return p;
    },
    createBindGroup(descriptor) {
      const b = object("bindGroup", descriptor);
      record("createBindGroup", {id: b.id, layout: descriptor.layout.id, layoutEntries: descriptor.layout.descriptor.entries,
        label: descriptor.label, entries: descriptor.entries.map((e) => ({
        binding: e.binding, resource: e.resource.id, texture: e.resource.texture?.id,
      }))});
      return b;
    },
    pushErrorScope(kind) { record("pushErrorScope", {kind}); },
    popErrorScope() { record("popErrorScope"); return Promise.resolve(scopeErrors.shift() || null); },
    createCommandEncoder(descriptor = {}) {
      trip("createCommandEncoder");
      const enc = {...object("encoder", descriptor), ops: []};
      record("createCommandEncoder", {id: enc.id, descriptor});
      enc.copyTextureToTexture = (src, dst, size) => {
        record("copyTextureToTexture", {src: src.texture.id, dst: dst.texture.id, sourceOrigin: origin(src.origin),
          destinationOrigin: origin(dst.origin), mip: src.mipLevel || 0, size});
        enc.ops.push(() => {
          const o = origin(src.origin), t = src.texture;
          const bytes = new Uint8Array(size.width * size.height * 4);
          for (let y = 0; y < size.height; y++) {
            const at = ((o.y + y) * t.width + o.x) * 4;
            bytes.set(t.bytes.subarray(at, at + size.width * 4), y * size.width * 4);
          }
          copyToTexture(dst, bytes, {bytesPerRow: size.width * 4}, size);
        });
      };
      enc.copyTextureToBuffer = (src, dst, size) => {
        trip("copyTextureToBuffer");
        record("copyTextureToBuffer", {texture: src.texture.id, buffer: dst.buffer.id, size, bytesPerRow: dst.bytesPerRow});
        enc.ops.push(() => {
          const t = src.texture, o = origin(src.origin);
          // Poison only row padding; the actual copied pixels remain intact.
          if (controls.poisonPadding) dst.buffer.bytes.fill(255);
          for (let y = 0; y < size.height; y++) {
            const at = ((o.y + y) * t.width + o.x) * 4;
            dst.buffer.bytes.set(t.bytes.subarray(at, at + size.width * 4), y * dst.bytesPerRow);
          }
        });
      };
      enc.copyBufferToBuffer = (src, sourceOffset, dst, destinationOffset, size) => {
        record("copyBufferToBuffer", {src: src.id, sourceOffset, dst: dst.id, destinationOffset, size});
        enc.ops.push(() => dst.bytes.set(src.bytes.subarray(sourceOffset, sourceOffset + size), destinationOffset));
      };
      enc.beginRenderPass = (descriptor) => {
        record("beginRenderPass", {encoder: enc.id, attachments: descriptor.colorAttachments.map((a) => a?.view.texture.id)});
        const pass = {};
        for (const method of ["setViewport", "setScissorRect", "setVertexBuffer", "setIndexBuffer", "draw", "drawIndexed", "end"])
          pass[method] = (...args) => record(method, {encoder: enc.id, args: args.map((a) => a?.id ?? a)});
        let pipeline;
        pass.setPipeline = (selected) => {
          pipeline = selected;
          record("setPipeline", {encoder: enc.id, args: [selected.id]});
        };
        pass.setBindGroup = (index, group) => {
          assert.equal(group.descriptor.layout, pipeline.descriptor.layout.descriptor.bindGroupLayouts[index],
            "a draw must bind the exact explicit layout of its selected pipeline variant");
          record("setBindGroup", {encoder: enc.id, args: [index, group.id]});
        };
        return pass;
      };
      enc.finish = () => { trip("finish"); record("finish", {encoder: enc.id}); return enc; };
      return enc;
    },
  };
  return {device, calls, scopeErrors, controls, buffers, textures,
    resolveMappings() { for (const m of mappings.splice(0)) m.resolve(); },
    rejectMappings() { for (const m of mappings.splice(0)) m.reject(new Error("deferred map fixture failure")); },
    emitValidation(message) { listeners.get("uncapturederror")({error: {message}}); },
    async complete() { for (const finish of fences.splice(0)) finish(); await settle(); },
  };
}

async function loadHost(search = "") {
  const gpu = fakeGpu(), timers = [], logs = [], entries = [];
  const context = vm.createContext({
    URL, URLSearchParams, Uint8Array, Uint16Array, Uint32Array, Float32Array, Int32Array, ArrayBuffer, DataView,
    performance: {now: () => 100}, location: {search, href: "https://fixture.invalid/" + search},
    console: Object.fromEntries(["log", "warn", "error", "table"].map((method) => [method, (...args) => logs.push([method, args.map(String).join(" ")])])),
    navigator: {gpu: {requestAdapter: async () => ({info: {}, features: new Set(), requestDevice: async () => gpu.device})}},
    __mcWebOffscreen: {width: 64, height: 4, getContext: () => ({configure() {}, getCurrentTexture: () => gpu.device.createTexture({size: [64, 4], format: "rgba8unorm"})})},
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    requestAnimationFrame: (fn) => { timers.push({fn, delay: 16}); return timers.length; }, cancelAnimationFrame() {},
    setTimeout: (fn, delay) => { timers.push({fn, delay}); return timers.length; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
    atob: (str) => Buffer.from(str, "base64").toString("binary"),
    // Naga is the boundary stubbed by this fake-GPU unit fixture. The full
    // production glue and host still construct/check layouts and normal
    // pipeline modules from these original synthetic stages.
    mcWebShaderTranslate: (glsl, stage) => {
      assert.match(glsl, /void\s+main\s*\(/);
      if (stage === "vertex") return {status: 0, text: `
        @vertex fn main(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
          let x = f32(vertex & 1u); return vec4<f32>(x, 0.0, 0.0, 1.0);
        }`};
      assert.match(glsl, /FixtureSampler/);
      return {status: 0, text: `
        @group(0) @binding(0) var FixtureSampler_s: sampler;
        @group(0) @binding(1) var FixtureSampler: texture_2d<f32>;
        @fragment fn main() -> @location(0) vec4<f32> {
          return textureSample(FixtureSampler, FixtureSampler_s, vec2<f32>(0.5));
        }`};
    },
    GPUTextureUsage: {COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16},
    GPUBufferUsage: {MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128},
    GPUShaderStage: {VERTEX: 1, FRAGMENT: 2}, GPUMapMode: {READ: 1},
  });
  for (const [name, text] of source) {
    vm.runInContext(text, context, {filename: name});
    if (name === "web/webgpu-texture-lifetime.js") {
      // Observe real parent entries without extracting/replacing host bodies.
      const create = context.mcWebTextureLifetime.createTextureLifetime;
      context.mcWebTextureLifetime.createTextureLifetime = (options) => {
        const api = create(options), initialize = api.initializeTexture;
        api.initializeTexture = (entry) => { entries.push(entry); return initialize(entry); };
        return api;
      };
    }
  }
  await settle();
  assert.equal(context.mcWebGpu.isReady(), true, logs.map((l) => l.join(" ")).join("\n"));
  return {...gpu, context, host: context.mcWebGpu, entries, timers, logs};
}

function pixels(seed) {
  return Uint8Array.from({length: 64 * 4 * 4}, (_, i) => i % 4 === 3 ? 255 : (i * 17 + seed) % 251);
}
function makeTexture(host, name = "fixture-atlas") { return host.createTexture(name, 15, "RGBA8_UNORM", 64, 4, 1, 1); }
function upload(host, handle, bytes, raw = false) {
  if (raw) host.writeTextureRaw(handle, bytes, 0, 0, 0, 0, 64, 4, 256, 4);
  else host.writeTexture64(handle, Buffer.from(bytes).toString("base64"), 0, 0, 0, 0, 64, 4, 256, 4);
}
function sampledDraw(host, handle, target, options = {}) {
  const view = host.createTextureView(handle, 0, 1, "2d");
  const sampler = host.createSamplerJson(JSON.stringify({addressU: "CLAMP", addressV: "CLAMP", min: "NEAREST", mag: "NEAREST"}));
  const pipeline = options.pipeline || host.createPipeline(JSON.stringify({label: "fixture-original", vertexShader: "fixture", fragmentShader: "fixture",
    vertexSource: "#version 330\nvoid main() { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); }",
    fragmentSource: "#version 330\nuniform sampler2D FixtureSampler;\nout vec4 fixtureColor;\nvoid main() { fixtureColor = texture(FixtureSampler, vec2(0.5)); }",
    vertexFormats: [{stride: 0, elements: []}], bindGroups: [{uniforms: [], samplers: ["FixtureSampler"]}], colorTargets: [{format: "RGBA8_UNORM"}], topology: "TRIANGLES"}));
  assert.ok(pipeline, "full production pipeline path must create a handle");
  const encoder = host.createCommandEncoder();
  const targetView = host.createTextureView(target, 0, 1, "2d");
  const depth = options.depth ? {view: host.createTextureView(options.depth, 0, 1, "2d"), clear: 1} : undefined;
  const pass = host.beginRenderPass(encoder, JSON.stringify({color: [{view: targetView}], depth, height: 4}));
  host.rpSetPipeline(pass, pipeline);
  host.rpBindTexture(pass, "FixtureSampler", view, sampler);
  host.rpDraw(pass, 0, 3, 1, 0);
  host.rpEnd(pass);
  host.submit(encoder);
  return {view, pipeline};
}

async function scenario(flag) {
  const fixture = await loadHost(flag ? "?" + flag : "");
  const {host, entries, context} = fixture;
  const first = makeTexture(host), second = makeTexture(host);
  const bytes = pixels(7), newer = pixels(93);
  upload(host, first, bytes);
  upload(host, first, bytes, true);
  upload(host, second, newer, true);
  const destination = makeTexture(host, "fixture-copy");
  const bufferSource = host.createBuffer("fixture-uniform-source", 8 | 16 | 128, 32);
  const bufferDestination = host.createBuffer("fixture-uniform-copy", 8 | 16 | 128, 32);
  const originalFloats = new Float32Array([1.25, -2.5, 3.75, 4.125]);
  const originalBytes = new Uint8Array(originalFloats.buffer);
  host.writeBuffer64(bufferSource, 0, Buffer.from(originalBytes).toString("base64"));
  host.writeBufferRaw(bufferSource, 16, originalBytes);
  const encoder = host.createCommandEncoder();
  host.copyTexture(encoder, first, destination, 3, 1, 7, 2, 5, 2, 0);
  host.copyBuffer(encoder, bufferSource, 4, bufferDestination, 8, 12);
  host.submit(encoder);
  sampledDraw(host, first, destination);
  assert.ok(!fixture.logs.some(([, line]) => /\[shader\] fixture-original|pipeline failed:/.test(line)),
    "synthetic normal pipeline must not fall back: " + fixture.logs.map((l) => l.join(" ")).join("\n"));
  assert.ok(!fixture.calls.some(([name, detail]) => name === "createShaderModule" && detail.descriptor.label === "mcweb-error-shader"));
  const sampledGroup = fixture.calls.find(([name, detail]) => name === "createBindGroup" && detail.label === "fixture-original:bind0");
  assert.ok(sampledGroup, "normal production bind group must be constructed");
  assert.equal(sampledGroup[1].entries.find((entry) => entry.binding === 1).texture, entries[0].texture.id,
    "normal production bind group must bind the original uploaded texture view");
  host.present(0);
  context.mcWebPump.frameReported(2);
  const snapshot = await host._textureProbe("fixture-atlas");
  const regions = await host._textureSamples("fixture-copy", [[7 / 64, 2 / 4]]);
  const shadow = plain(host.dumpUniforms()["fixture-uniform-copy"]);
  assert.deepEqual(shadow.floats, [0, 0, -2.5, 3.75, 4.125, 0, 0, 0], "CPU shadow survives writes/copy without history");
  await fixture.complete();
  return {...fixture, first, second, destination, bytes, newer, snapshot, regions, shadow};
}

test("default and each history flag issue identical original GPU commands", async () => {
  const normal = await scenario();
  for (const method of ["createBindGroup", "setBindGroup", "draw", "submit"])
    assert.ok(normal.calls.some(([name]) => name === method), "full production sampling path reached " + method);
  assert.deepEqual(normal.calls.filter(([name]) => name === "writeTexture").slice(0, 3).map(([, call]) => call.bytes),
    [[...normal.bytes], [...normal.bytes], [...normal.newer]], "both upload paths retain original bytes");
  assert.deepEqual(normal.calls.find(([name]) => name === "copyTextureToTexture")[1].sourceOrigin, {x: 3, y: 1, z: 0});
  assert.deepEqual(normal.calls.find(([name]) => name === "copyTextureToTexture")[1].destinationOrigin, {x: 7, y: 2, z: 0});
  const expectedPixel = [...normal.bytes.slice((64 + 3) * 4, (64 + 3) * 4 + 4)];
  assert.deepEqual(plain(normal.regions.samples[0].neighborhood[4].slice(2)), expectedPixel);
  assert.equal(normal.regions.nonzero, 10);
  assert.equal(normal.snapshot[0].readback.nonTransp, 256);
  for (const flag of flags) {
    const enabled = await scenario(flag);
    assert.deepEqual(enabled.calls, normal.calls, flag + " must not alter GPU commands");
    assert.deepEqual(plain(enabled.host._compositeDbg()), plain(normal.host._compositeDbg()));
    assert.deepEqual(enabled.shadow, normal.shadow);
    assert.deepEqual(enabled.entries.map((e) => [e._uploads, e._uploadBytes, e._copiesIn || 0, e._copiesOut || 0]),
      normal.entries.map((e) => [e._uploads, e._uploadBytes, e._copiesIn || 0, e._copiesOut || 0]));
    assert.equal(enabled.snapshot[0].historyCaptured, true);
    assert.equal(enabled.snapshot[0].uploadRegions.length, 2);
    assert.equal(enabled.host._texWriteLog["fixture-atlas"].writes, 3);
    assert.deepEqual(plain(enabled.host._texDiagLate().interestingInstances["fixture-atlas"].instances), [2, 1]);
  }
});

test("default captures no per-texture history or delayed historical dump", async () => {
  const fixture = await scenario();
  assert.equal(fixture.host._texWriteLog, undefined);
  assert.ok(fixture.entries.every((entry) => !Object.hasOwn(entry, "_uploadRegions")));
  assert.equal(fixture.timers.filter((timer) => timer.delay === 2500).length, 0);
  assert.equal(fixture.snapshot[0].historyCaptured, false);
  assert.equal(fixture.snapshot[0].uploadRegions, null);
  assert.equal(fixture.regions.uploadRegions, null);
  assert.equal(fixture.regions.uploads, null);
  const calls = fixture.calls.length;
  const disabledRows = await fixture.host._texDiag();
  assert.equal(Array.isArray(disabledRows), true);
  assert.equal(disabledRows.length, 1);
  for (const report of [disabledRows[0], fixture.host._texDiagLate(), fixture.host._texDiagSnapshot()]) {
    assert.equal(report.historyCaptured, false);
    assert.match(report.error, /history was not captured/);
  }
  assert.equal(fixture.calls.length, calls, "historical APIs must not perform a fake empty readback");
  assert.ok(!fixture.logs.some(([, line]) => /TEX-(DIAG|IDENTITY)/.test(line)));
  // History enablement is fixed at host initialization, even if DevTools
  // changes the query before a later present.
  fixture.context.location.search = "?mcweb_texdiag";
  fixture.context.mcWebPump.ticks = 41;
  assert.doesNotThrow(() => fixture.host.present(0));
  assert.equal(fixture.host._texDiagSnapshot().historyCaptured, false);
});

test("flagged capture records sampled identity and lifetime uploads", async () => {
  const fixture = await scenario("mcweb_texdiag");
  assert.equal(fixture.timers.filter((timer) => timer.delay === 2500).length, 1);
  const late = fixture.host._texDiagLate();
  assert.equal(late.historyCaptured, true);
  assert.deepEqual(plain(late.uploadByLabelTotals["fixture-atlas"]), [3, Buffer.from(fixture.bytes).toString("base64").length + 2 * fixture.bytes.length]);
  assert.ok(fixture.logs.some(([, line]) => /TEX-IDENTITY.*sampled.*"uploads":2/.test(line)));
  const rows = await fixture.host._texDiag();
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length, 1);
  const snapshot = fixture.host._texDiagSnapshot();
  assert.equal(snapshot.historyCaptured, true);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].uploads, 2);
  assert.equal(snapshot.rows[0].labelUploads, 3);
  assert.equal(snapshot.rows[0].nonTransp, 256);
  assert.equal(snapshot.recentCreated.length, 3);
});

for (const search of ["", "?mcweb_debug"]) test("live probes select newest creation after rekey/destroy " + (search || "default"), async () => {
  const {host} = await loadHost(search);
  const old = makeTexture(host, "same-label");
  upload(host, old, pixels(1));
  assert.equal(host.rekeyObject(old, -1000), true);
  const newest = makeTexture(host, "same-label");
  upload(host, newest, pixels(80), true);
  assert.equal(host.rekeyObject(newest, -2000), true);
  // Reinsert the older entry last with a numerically greater handle. Neither
  // insertion order nor handle magnitude may choose it over the newer one.
  assert.equal(host.rekeyObject(-1000, 9000), true);
  const probe = await host._textureProbe("same-label");
  assert.deepEqual(Array.from(probe, (p) => p.handle), [9000, -2000]);
  assert.ok(probe[1].creationId > probe[0].creationId);
  const sample = await host._textureSamples("same-label", [[0, 0]]);
  assert.equal(sample.handle, -2000);
  assert.deepEqual(plain(sample.samples[0].neighborhood[4].slice(2)), [...pixels(80).slice(0, 4)]);
  host.destroyTexture(-2000);
  assert.equal((await host._textureSamples("same-label", [])).handle, 9000);
  host.destroyTexture(9000);
  assert.deepEqual(plain(await host._textureProbe("same-label")), []);
  assert.equal((await host._textureSamples("same-label", [])).error, "texture not found");
});

async function retainedLifecycle(search) {
  const fixture = await loadHost(search);
  const {host} = fixture;
  const handle = makeTexture(host);
  const view = host.createTextureView(handle, 0, 1, "2d");
  const parent = fixture.entries[0];
  host.destroyTexture(handle);
  assert.equal(parent._viewRefs, 1);
  assert.equal(parent.texture.destroyCount, 0);
  const encoder = host.createCommandEncoder();
  const pass = host.beginRenderPass(encoder, JSON.stringify({color: [{view}], height: 4}));
  host.rpEnd(pass);
  host.submit(encoder);
  await fixture.complete();
  assert.equal(parent.texture.destroyCount, 0, "the retained view still owns its parent");
  fixture.emitValidation("fixture texture view validation failure");
  const validation = host.textureValidationReport();
  assert.equal(validation.parent.pending, true);
  assert.equal(validation.parent.label, "fixture-atlas");
  assert.ok(fixture.logs.some(([, line]) => /GPU-TEXTURE-VALIDATION/.test(line)));
  host.destroyObject(view);
  assert.equal(parent._viewRefs, 0);
  const closing = host.createCommandEncoder();
  host.submit(closing);
  assert.equal(parent.texture.destroyCount, 0, "destroy waits for actual submission fence");
  await fixture.complete();
  assert.equal(parent.texture.destroyCount, 1);
  assert.equal(parent._gpuDestroyed, true);
  assert.throws(() => host.createTextureView(handle, 0, 1, "2d"), /Unknown/);
  assert.ok(fixture.calls.some(([name, detail]) => name === "pushErrorScope" && detail.kind === "validation"));
  return fixture.calls;
}

test("retained views, fences and validation issue the same GPU commands for all history flags", async () => {
  const normal = await retainedLifecycle("");
  for (const flag of flags) assert.deepEqual(await retainedLifecycle("?" + flag), normal, flag);
});


// Row-pitch and owned-resource regressions use the same full host fixture.
function readbackTexture(fixture, width, height, bytes = new Uint8Array(width * height * 4)) {
  const handle = fixture.host.createTexture("fixture-readback", 15, "RGBA8_UNORM", width, height, 1, 1);
  fixture.host.writeTextureRaw(handle, bytes, 0, 0, 0, 0, width, height, width * 4, height);
  return {handle, entry: fixture.entries.at(-1)};
}
function ownedBuffers(fixture, before) { return fixture.buffers.slice(before); }
function assertReleased(buffers, mapped) {
  assert.equal(buffers.length, 1, "one owned readback buffer");
  assert.equal(buffers[0].destroyCount, 1, "owned buffer destroyed exactly once");
  assert.equal(buffers[0].unmapCount, mapped ? 1 : 0, "only a successfully mapped buffer is unmapped");
  assert.equal(buffers[0].destroyedWhileMapped, false);
}

for (const width of [1, 65, 64]) test(`readback walks ${width}x3 rows and excludes poisoned padding`, async () => {
  const f = await loadHost();
  const bytes = new Uint8Array(width * 3 * 4);
  bytes.set([4, 4, 4, 255], 0); // RGB threshold is strictly greater than 4.
  bytes.set([5, 0, 0, 255], ((3 * width) - 1) * 4); // Last pixel of last row.
  const {entry} = readbackTexture(f, width, 3, bytes);
  f.controls.poisonPadding = true;
  const before = f.buffers.length;
  const result = await f.host._readbackTex(entry);
  assert.deepEqual(plain(result), {nonBlack: 1, nonTransp: 2, sampled: width * 3});
  const copy = f.calls.filter(([name]) => name === "copyTextureToBuffer").at(-1)[1];
  assert.equal(copy.bytesPerRow, Math.ceil(width * 4 / 256) * 256);
  assert.deepEqual(copy.size, {width, height: 3, depthOrArrayLayers: 1});
  assertReleased(ownedBuffers(f, before), true);
  assert.equal(entry.texture.destroyCount, 0, "borrowed source texture stays alive");
});

test("readback retains the default 128 cap and explicit dimensions", async () => {
  const f = await loadHost(), {entry} = readbackTexture(f, 129, 130);
  assert.equal((await f.host._readbackTex(entry)).sampled, 128 * 128);
  assert.equal((await f.host._readbackTex(entry, 65, 3)).sampled, 65 * 3);
  const copies = f.calls.filter(([name]) => name === "copyTextureToBuffer").slice(-2);
  assert.deepEqual(copies.map(([, c]) => c.size), [
    {width: 128, height: 128, depthOrArrayLayers: 1}, {width: 65, height: 3, depthOrArrayLayers: 1},
  ]);
});

for (const failure of ["createCommandEncoder", "copyTextureToBuffer", "finish", "submit", "mapAsync", "mapReject", "getMappedRange"])
  test(`readback releases owned buffer after ${failure}`, async () => {
    const f = await loadHost(), {entry} = readbackTexture(f, 8, 8);
    const before = f.buffers.length;
    f.controls.fail = failure;
    const result = await f.host._readbackTex(entry);
    const mapped = failure === "getMappedRange";
    assert.equal(result.error, (mapped || failure === "mapReject" ? "map:" : "") + failure + " fixture failure");
    assertReleased(ownedBuffers(f, before), mapped);
    assert.equal(entry.texture.destroyCount, 0, "borrowed source texture stays alive on error");
  });

test("readback allocation failure resolves without an owned buffer", async () => {
  const f = await loadHost(), {entry} = readbackTexture(f, 8, 8);
  const before = f.buffers.length;
  f.controls.fail = "createBuffer";
  assert.equal((await f.host._readbackTex(entry)).error, "createBuffer fixture failure");
  assert.equal(f.buffers.length, before);
  assert.equal(entry.texture.destroyCount, 0);
});

test("8x8 self-check counts all 64 magenta pixels and releases temporary resources", async () => {
  const f = await loadHost("?mcweb_texdiag"), before = f.buffers.length, texturesBefore = f.textures.length;
  f.controls.deferMapping = true;
  const pending = f.host._texDiag();
  const texture = f.textures[texturesBefore];
  assert.equal(texture.width, 8);
  assert.equal(texture.height, 8);
  assert.equal(texture.destroyCount, 0, "self-check source remains alive while mapping is pending");
  assert.equal(f.buffers[before].destroyCount, 0);
  f.resolveMappings();
  assert.deepEqual(plain(await pending), []);
  assert.deepEqual(plain(f.host._texDiagSnapshot().readbackSelf), {nonBlack: 64, nonTransp: 64, sampled: 64});
  assertReleased(ownedBuffers(f, before), true);
  assert.equal(texture.destroyCount, 1);
});

test("self-check readback rejection releases its source only after settlement", async () => {
  const f = await loadHost("?mcweb_texdiag"), before = f.buffers.length, texturesBefore = f.textures.length;
  f.controls.deferMapping = true;
  const pending = f.host._texDiag(), texture = f.textures[texturesBefore];
  assert.equal(texture.destroyCount, 0);
  f.rejectMappings();
  await pending;
  assert.equal(f.host._texDiagSnapshot().readbackSelf.error, "map:deferred map fixture failure");
  assertReleased(ownedBuffers(f, before), false);
  assert.equal(texture.destroyCount, 1);
});

test("self-check setup failure preserves self prefix and destroys its owned texture", async () => {
  const f = await loadHost("?mcweb_texdiag"), before = f.buffers.length, texturesBefore = f.textures.length;
  f.controls.fail = "writeTexture";
  await f.host._texDiag();
  assert.equal(f.host._texDiagSnapshot().readbackSelf.error, "self:writeTexture fixture failure");
  assert.equal(f.buffers.length, before);
  assert.equal(f.textures[texturesBefore].destroyCount, 1);
});

test("default disabled historical API allocates no readback resources", async () => {
  const f = await loadHost(), before = [f.buffers.length, f.textures.length, f.calls.length];
  const rows = await f.host._texDiag();
  assert.equal(rows[0].historyCaptured, false);
  assert.deepEqual([f.buffers.length, f.textures.length, f.calls.length], before);
});

test("bind groups retain the exact layout of base, depth and unfilterable pipeline variants", async () => {
  const f = await loadHost("?mcweb_bindgroup_cache=pass");
  const source = makeTexture(f.host, "layout-source"), target = makeTexture(f.host, "layout-target");
  const depth = f.host.createTexture("layout-depth", 15, "D32_FLOAT", 64, 4, 1, 1);
  const {pipeline} = sampledDraw(f.host, source, target);
  sampledDraw(f.host, source, target, {pipeline, depth});
  sampledDraw(f.host, depth, target, {pipeline});
  await settle();
  const selected = f.calls.filter(([name]) => name === "setPipeline").map(([, call]) => call.args[0]);
  const groups = f.calls.filter(([name]) => name === "createBindGroup").map(([, call]) => call);
  assert.equal(new Set(selected).size, 3, "the base, alternate depth and adapted sample-type pipelines must all be used");
  assert.equal(new Set(groups.map((group) => group.layout)).size, 3, "each native pipeline owns its exact explicit layout object");
  assert.equal(groups.length, 3);
  const pipelines = new Map(f.calls.filter(([name]) => name === "createRenderPipeline").map(([, call]) => [call.id, call]));
  const uniqueSelected = [...new Set(selected)];
  assert.deepEqual(uniqueSelected.map((id) => pipelines.get(id).depthFormat), [null, "depth32float", null]);
  assert.deepEqual(groups.map((group) => group.layoutEntries.find((entry) => entry.binding === 1).texture.sampleType),
    ["float", "float", "unfilterable-float"], "the third draw must select the adapted sample-type layout");
  assert.deepEqual(groups.map((group) => group.layoutEntries.find((entry) => entry.binding === 0).sampler.type),
    ["filtering", "filtering", "non-filtering"]);
  const sourceTexture = f.textures.find((texture) => texture.descriptor.label === "layout-source");
  const depthTexture = f.textures.find((texture) => texture.descriptor.label === "layout-depth");
  assert.deepEqual(groups.map((group) => group.entries.find((entry) => entry.binding === 1).texture),
    [sourceTexture.id, sourceTexture.id, depthTexture.id], "adaptation must bind the real depth view, not a dummy");
});
