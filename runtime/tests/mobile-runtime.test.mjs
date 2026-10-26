import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { MASSAGE_PLAN } from '../tools/wasmjvm-massage-plan.mjs';

const source = await readFile(process.argv[2] || new URL('../web/mobile-runtime.js', import.meta.url), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function harness(navigator = {}, extra = {}) {
  const events = new Map();
  const context = vm.createContext({
    navigator: { userAgent: 'Chrome/151', platform: 'Linux', maxTouchPoints: 0, ...navigator },
    location: new URL('https://example.test/game/?gclog=1'),
    URL, URLSearchParams, Uint8Array, DataView, TextDecoder, crypto: webcrypto, setTimeout, clearTimeout,
    crossOriginIsolated: true, SharedArrayBuffer,
    HTMLCanvasElement: { prototype: { transferControlToOffscreen() {} } },
    document: { visibilityState: 'visible', addEventListener(name, fn) { events.set(name, fn); } },
    addEventListener(name, fn) { events.set(name, fn); },
    ...extra,
  });
  vm.runInContext(source, context);
  return { api: context.mcWebMobileRuntime, context, events };
}
const ios = { userAgent: 'iPhone AppleWebKit/605.1', platform: 'iPhone' };

// Exact ZeroWasmJITOnly selector captured from an iPad producer-FPS run; not inferred roots.
const capturedIPadSelector = '-XX:ZeroWasmJITOnly=net.minecraft,com.mojang.blaze3d,com.mojang.math,com.mojang.brigadier,dev.mcweb,org.lwjgl,org.joml,it.unimi.dsi.fastutil,com.google,io.netty,java.util,java.nio,sun.nio,jdk.internal,java.lang.String,java.lang.Math,java.lang.Float,java.lang.Double,java.lang.Integer,java.lang.Long,java.lang.Short,java.lang.Byte,java.lang.Boolean,java.lang.Character,java.lang.Object,java.lang.System,java.lang.Thread,java.lang.Enum,java.lang.Iterable,java.lang.Comparable,java.lang.ref,java.lang.runtime,com.mojang.renderpearl,java.lang.invoke.DirectMethodHandle.internalMemberName';
const originalArgs = ['-Xmx1536m', '-XX:+UseZeroWasmJIT', '-Dmcweb.serverThreads=8', '-Dmcweb.displayHz=120', '-cp', 'own.jar', 'Boot'];

test('desktop Chrome and phone profiles remain unchanged by the iPad policy', () => {
  assert.equal(harness().api.runtimeArguments(originalArgs), originalArgs);
  for (const navigator of [ios, {userAgent:'iPod AppleWebKit/605.1',platform:'iPod'},
    {userAgent:'iPhone AppleWebKit/605.1',platform:'MacIntel',maxTouchPoints:5}]) {
    const api=harness(navigator).api,args=Array.from(api.runtimeArguments(originalArgs));
    assert.equal(api.usesIOSRuntime(),true);
    for(const flag of ['-Xmx448m','-Xms96m','-XX:+UseSerialGC','-XX:ZeroWasmJITOnly=net.minecraft',
      '-Dmcweb.maxFps=20','-Dmcweb.simulationDistance=5','-Dmcweb.serverThreads=0','-Dmcweb.runtimeMode=WASMLM_THREADED'])assert.ok(args.includes(flag),flag);
    assert.ok(!args.includes('-Xmx1536m')&&!args.includes('-Dmcweb.serverThreads=8'));
    assert.ok(!args.some(flag=>/ZeroWasmJITFramePad|ZeroWasmJITNames|gpuOnlyShadowLimitMB|serverInlineTrampoline/.test(flag)));
    assert.ok(args.includes('-Dmcweb.displayHz=120'));assert.deepEqual(args.slice(-3),['-cp','own.jar','Boot']);
  }
});

test('both iPad identities restore the exact captured34root JIT and stack safety policy only once', () => {
  assert.equal(capturedIPadSelector.split('=')[1].split(',').length,34);
  for(const navigator of [{userAgent:'iPad AppleWebKit/605.1',platform:'iPad',maxTouchPoints:5},
    {userAgent:'Macintosh AppleWebKit/605.1',platform:'MacIntel',maxTouchPoints:5}]) {
    const api=harness(navigator).api;
    const args=Array.from(api.runtimeArguments([...originalArgs.slice(0,-3),
      '-XX:ZeroWasmJITOnly=untrusted.input','-XX:-ZeroWasmJITNames','-XX:ZeroWasmJITFramePad=4',
      '-XX:ZeroWasmInterpreterFramePad=999','-Dmcweb.gpuOnlyShadowLimitMB=999','-Dmcweb.serverInlineTrampoline=false',...originalArgs.slice(-3)]));
    const expected=[capturedIPadSelector,'-XX:+ZeroWasmJITNames','-XX:ZeroWasmJITFramePad=2048','-XX:ZeroWasmInterpreterFramePad=320',
      '-Dmcweb.maxFps=120','-Dmcweb.sectionPacks=2','-Dmcweb.serverThreads=2','-Dmcweb.gpuOnlyShadowLimitMB=4','-Dmcweb.serverInlineTrampoline=true'];
    for(const flag of expected)assert.equal(args.filter(arg=>arg===flag).length,1,flag);
    for(const prefix of ['-XX:ZeroWasmJITOnly=','-XX:ZeroWasmJITFramePad=','-XX:ZeroWasmInterpreterFramePad=',
      '-Dmcweb.serverThreads=','-Dmcweb.gpuOnlyShadowLimitMB=','-Dmcweb.serverInlineTrampoline='])assert.equal(args.filter(arg=>arg.startsWith(prefix)).length,1,prefix);
    assert.ok(!args.includes('-XX:-ZeroWasmJITNames'));assert.deepEqual(args.slice(-3),['-cp','own.jar','Boot']);
    assert.ok(args.includes('-Xmx448m')&&args.includes('-Xms96m'));
  }
});

test('iPad alone preserves the exact direct-import diagnostic bit once when JIT is enabled', () => {
  const allowed='-XX:ZeroWasmJITDisable=524288';
  const rejected=['-XX:ZeroWasmJITDisable=0','-XX:ZeroWasmJITDisable=524289','-XX:ZeroWasmJITDisable=0524288',
    '-XX:ZeroWasmJITDisable=524288x','-XX:ZeroWasmJITMaxUnits=1','-XX:ZeroWasmJITOnly=untrusted'];
  const incoming=[...originalArgs.slice(0,-3),allowed,allowed,...rejected,...originalArgs.slice(-3)];
  for(const navigator of [{userAgent:'iPad AppleWebKit/605.1',platform:'iPad',maxTouchPoints:5},
    {userAgent:'Macintosh AppleWebKit/605.1',platform:'MacIntel',maxTouchPoints:5}]) {
    const api=harness(navigator).api,args=Array.from(api.runtimeArguments(incoming));
    assert.equal(args.filter(arg=>arg===allowed).length,1);
    assert.ok(args.indexOf(allowed)<args.indexOf('-cp'));
    for(const arg of rejected)assert.ok(!args.includes(arg),arg);
    assert.ok(args.includes(capturedIPadSelector)&&args.includes('-Dmcweb.maxFps=120'));
    const baseline=Array.from(api.runtimeArguments(originalArgs));
    assert.ok(!baseline.includes(allowed),'No default policy change');
    const nojit=Array.from(api.runtimeArguments([allowed,...originalArgs.filter(arg=>arg!=='-XX:+UseZeroWasmJIT')]));
    assert.ok(!nojit.includes(allowed),'Diagnostic does not enable JIT');
  }
  for(const navigator of [ios,{userAgent:'iPod AppleWebKit/605.1',platform:'iPod'},
    {userAgent:'iPhone AppleWebKit/605.1',platform:'MacIntel',maxTouchPoints:5}]) {
    assert.ok(!Array.from(harness(navigator).api.runtimeArguments(incoming)).includes(allowed));
  }
});

test('iPad interpreted launch omits all JIT policy while preserving explicit applied memory bounds', () => {
  const api=harness({userAgent:'Macintosh AppleWebKit/605.1',platform:'MacIntel',maxTouchPoints:5}).api;
  const interpreted=Array.from(api.runtimeArguments(['-XX:ZeroWasmJITOnly=other','-XX:+ZeroWasmJITNames',
    '-XX:ZeroWasmJITFramePad=4','-XX:ZeroWasmInterpreterFramePad=999','-cp','own.jar','Boot'],3200));
  assert.ok(!interpreted.some(flag=>/ZeroWasm(?:JIT|InterpreterFramePad)|UnlockExperimentalVMOptions/.test(flag)));
  assert.ok(interpreted.includes('-Xmx1216m')&&interpreted.includes('-Xms96m'));
  assert.ok(interpreted.includes('-Dmcweb.serverThreads=2'));assert.ok(interpreted.includes('-Dmcweb.maxFps=120'));
  const compiled=Array.from(api.runtimeArguments(originalArgs,3200));
  assert.ok(compiled.includes('-Xmx1216m')&&compiled.includes(capturedIPadSelector));
});

const desktopSafari = {userAgent:'Macintosh AppleWebKit/605.1 Version/27 Safari/605.1',platform:'MacIntel',maxTouchPoints:0};

test('desktop Safari takes the verified bounded iPad render recipe without being an iOS device', () => {
  const api=harness(desktopSafari).api;
  assert.equal(api.usesIOSRuntime(),false);
  assert.equal(api.usesBoundedRuntime(),true);
  const ipad=harness({...desktopSafari,maxTouchPoints:5}).api;
  const conflicts=[...originalArgs.slice(0,-3),'-XX:ZeroWasmJITOnly=other','-XX:-ZeroWasmJITNames',
    '-XX:ZeroWasmJITFramePad=4','-XX:ZeroWasmInterpreterFramePad=999',...originalArgs.slice(-3)];
  assert.deepEqual(Array.from(api.runtimeArguments(conflicts)),Array.from(ipad.runtimeArguments(conflicts)));
  const args=Array.from(api.runtimeArguments(conflicts,3200));
  for(const flag of ['-Xmx448m','-Xms96m',capturedIPadSelector,'-XX:+ZeroWasmJITNames',
    '-XX:ZeroWasmJITFramePad=2048','-XX:ZeroWasmInterpreterFramePad=320','-Dmcweb.maxFps=120',
    '-Dmcweb.serverThreads=2','-Dmcweb.gpuOnlyShadowLimitMB=4','-Dmcweb.serverInlineTrampoline=true'])assert.equal(args.filter(a=>a===flag).length,1,flag);
  assert.ok(!args.includes('-Xmx1216m'),'Stored iPad budget is not used by desktop Safari');
  assert.deepEqual(args.slice(-3),['-cp','own.jar','Boot']);
});

test('desktop Safari compatibility no longer depends on the legacy render-JIT query and cannot enable JIT', () => {
  const baseline=Array.from(harness(desktopSafari).api.runtimeArguments(originalArgs));
  for(const search of ['?mcweb_webkit_render_jit=1','?mcweb_webkit_render_jit=0','?mcweb_webkit_render_jit=true'])
    assert.deepEqual(Array.from(harness(desktopSafari,{location:new URL('https://example.test/'+search)}).api.runtimeArguments(originalArgs)),baseline);
  const nojit=Array.from(harness(desktopSafari).api.runtimeArguments(originalArgs.filter(a=>a!=='-XX:+UseZeroWasmJIT')));
  assert.ok(!nojit.some(a=>/ZeroWasmJIT|ZeroWasmInterpreterFramePad|UnlockExperimentalVMOptions/.test(a)));
  assert.ok(nojit.includes('-Xmx448m')&&nojit.includes('-Dmcweb.serverThreads=2'));
});

test('Chrome and Helium desktop arguments remain untouched, and iOS still uses its own device identity', () => {
  for(const userAgent of ['Macintosh AppleWebKit/537.36 Chrome/155.0.0 Safari/537.36',
    'Macintosh AppleWebKit/537.36 Chrome/155.0.0 Helium/1 Safari/537.36','Linux Chromium/155.0 AppleWebKit/537.36',
    'Macintosh AppleWebKit/537.36 Edg/155.0']) {
    const api=harness({userAgent,platform:'MacIntel',maxTouchPoints:0}).api;
    assert.equal(api.usesIOSRuntime(),false);assert.equal(api.usesBoundedRuntime(),false);
    assert.equal(api.runtimeArguments(originalArgs),originalArgs);
  }
  for(const navigator of [ios,{userAgent:'iPad AppleWebKit/605.1',platform:'iPad',maxTouchPoints:5}]) {
    const api=harness(navigator).api;assert.equal(api.usesIOSRuntime(),true);assert.equal(api.usesBoundedRuntime(),true);
  }
});

const loader = [
  'var pthreadPoolSize = 32;', 'var _scriptName = globalThis.document?.currentScript?.src;',
  'new Worker("gpu-rpc-worker.js" + location.search)', 'FS.writeFile("/app/mcweb/" + j.name, bytes);',
  'var sharedModules = {};', 'var INITIAL_MEMORY = 536870912;', '"maximum": 65536,',
].join('\n');
test('mobile loader bounds memory/pool and carries stable worker parameters', () => {
  const { api } = harness(ios);
  const patched = api.mobileRuntimeSource(loader, 'https://example.test/game/javavm.js?release=own-build', '?mcweb_render_distance=6&gclog=1', MASSAGE_PLAN.mobile.clientJar);
  assert.ok(patched.includes('var pthreadPoolSize = 2;'));
  assert.ok(patched.includes('"maximum": 18432,'));
  // An applied bound sets the native maximum in pages, also below the defaults; the initial size is the loader's.
  const bounded = api.mobileRuntimeSource(loader, 'https://example.test/game/javavm.js', '', MASSAGE_PLAN.mobile.clientJar, 960);
  assert.ok(bounded.includes('"maximum": 15360,') && bounded.includes('var INITIAL_MEMORY = 536870912;'));
  assert.throws(() => api.mobileRuntimeSource(loader, 'https://example.test/game/javavm.js', '', MASSAGE_PLAN.mobile.clientJar, 448));
  assert.ok(patched.includes('__mcWebMobileModules'));
  assert.ok(patched.includes('{ canOwn: true }'));
  assert.ok(patched.includes('__mcWebMobileClientJar(bytes)'));
  assert.ok(patched.includes('release=own-build'));
  assert.ok(patched.includes('mcweb_render_distance=6'));
  assert.ok(patched.includes('mcweb_lazy_depth=1') && patched.includes('mcweb_lazy_pipeline=1'));
  const defaulted = api.mobileRuntimeSource(loader, 'https://example.test/game/javavm.js', '?mcweb_render_distance=32', MASSAGE_PLAN.mobile.clientJar);
  assert.ok(defaulted.includes('mcweb_render_distance=8'));
  for (const marker of loader.split('\n')) {
    assert.throws(() => api.mobileRuntimeSource(loader.replace(marker, ''), 'https://example.test/javavm.js', '', MASSAGE_PLAN.mobile.clientJar), /Unexpected pinned/);
    assert.throws(() => api.mobileRuntimeSource(loader + '\n' + marker, 'https://example.test/javavm.js', '', MASSAGE_PLAN.mobile.clientJar), /Unexpected pinned/);
  }
});

test('side libraries verify bytes before sequential compilation and reject corruption', async () => {
  const { api } = harness(ios);
  const payload = new Uint8Array([0, 97, 115, 109]);
  const records = ['one.so', 'two.so'].map(name => [name, { bytes: payload.length, sha256: hash(payload) }]);
  const order = [];
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const run = api.mobileRuntimeModules('https://example.test/game/javavm.js?release=own', records,
    async url => { order.push('fetch:' + url.pathname); return { ok: true, arrayBuffer: async () => payload.buffer }; },
    async bytes => { order.push('compile'); if (order.length === 2) await first; return { compiled: bytes.byteLength }; });
  while (order.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['fetch:/game/one.so', 'compile']);
  release();
  const result = await run;
  assert.deepEqual(order, ['fetch:/game/one.so', 'compile', 'fetch:/game/two.so', 'compile']);
  assert.equal(result['two.so'].compiled, 4);
  let compiled = false;
  await assert.rejects(api.mobileRuntimeModules('https://example.test/javavm.js', [['bad.so', { bytes: 4, sha256: '0'.repeat(64) }]],
    async () => ({ ok: true, arrayBuffer: async () => payload.buffer }), async () => { compiled = true; }), /release checksum/);
  assert.equal(compiled, false);
});

test('terrain edits use exact counted constants and client bytes fail closed', async () => {
  const { api } = harness(ios);
  const bytes = new Uint8Array(15), view = new DataView(bytes.buffer);
  [134217728, 33554432, 102760448].forEach((v, i) => view.setInt32(i * 5 + 1, v));
  const massager = { readConstantPool: () => ({ pool: [0, 5, 10].map(at => ({ tag: 3, at })) }) };
  const patched = api.mobileTerrainClass(bytes, massager, MASSAGE_PLAN.mobile.terrain), pv = new DataView(patched.buffer);
  assert.deepEqual([1, 6, 11].map(i => pv.getInt32(i)), [16777216, 4194304, 8388608]);
  assert.equal(view.getInt32(1), 134217728);
  assert.throws(() => api.mobileTerrainClass(bytes, { readConstantPool: () => ({ pool: [] }) }, MASSAGE_PLAN.mobile.terrain), /Unexpected pinned/);
  await assert.rejects(api.mobileClientJar(bytes, { readEntry: async () => bytes }, MASSAGE_PLAN.mobile), /release checksum/);
});

test('mobile JAR derivation takes entry, hashes, constants and manifest prefix from the plan', async () => {
  const { api } = harness(ios);
  const terrain = new Uint8Array(10), expectedTerrain = new Uint8Array(10);
  const view = new DataView(terrain.buffer), expectedView = new DataView(expectedTerrain.buffer);
  view.setInt32(1, 123); view.setInt32(6, 789);
  expectedView.setInt32(1, 456); expectedView.setInt32(6, 321);
  const manifest = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const plan = {
    terrain: { entry: 'own/Terrain.class', constants: [[123, 456], [789, 321]], expectEach: 1,
      sourceSha256: hash(terrain), derivedSha256: hash(expectedTerrain) },
    manifest: { entry: 'OWN-MANIFEST', sourceBytes: manifest.length, prefixBytes: 4,
      sourceSha256: hash(manifest), derivedSha256: hash(manifest.slice(0, 4)) },
  };
  let replacements;
  const massager = {
    readConstantPool: () => ({ pool: [{ tag: 3, at: 0 }, { tag: 3, at: 5 }] }),
    readEntry: async (_, name) => name === plan.terrain.entry ? terrain : name === plan.manifest.entry ? manifest : null,
    massageJar: (bytes, reject, entries) => { replacements = entries; return { bytes }; },
  };
  const jar = new Uint8Array([42]);
  assert.equal(await api.mobileClientJar(jar, massager, plan), jar);
  assert.deepEqual(Array.from(replacements.get(plan.terrain.entry)), Array.from(expectedTerrain));
  assert.deepEqual(Array.from(replacements.get(plan.manifest.entry)), [1, 2, 3, 4]);
  await assert.rejects(api.mobileClientJar(jar, massager, { ...plan, manifest: { ...plan.manifest, sourceBytes: 9 } }), /manifest failed its release checksum/);
  const duplicates = new Uint8Array(15), duplicateView = new DataView(duplicates.buffer);
  [123, 123, 789].forEach((value, i) => duplicateView.setInt32(i * 5 + 1, value));
  assert.throws(() => api.mobileTerrainClass(duplicates, {
    readConstantPool: () => ({ pool: [0, 5, 10].map(at => ({ tag: 3, at })) }),
  }, plan.terrain), /Unexpected duplicate/);
});

test('capability checks fail before runtime preparation for unavailable GPU/storage', async () => {
  const unsupported = harness({}, { crossOriginIsolated: false }).api;
  await assert.rejects(unsupported.requireRuntimeSupport(), /threaded game/);
  const noGpu = harness({ gpu: { requestAdapter: async () => null } }).api;
  await assert.rejects(noGpu.requireRuntimeSupport(), /WebGPU is unavailable/);
  const privateBrowsing = harness({ gpu: { requestAdapter: async () => ({}) }, storage: { getDirectory: async () => { throw Error('denied'); } } }).api;
  await assert.rejects(privateBrowsing.requireRuntimeSupport(), /Safari Private Browsing/);
});

test('wake lock releases late acquisition and reacquires after restored page', async () => {
  let resolve, releases = 0, requests = 0;
  const first = new Promise(done => { resolve = done; });
  const sentinel = () => ({ released: false, release: async () => { releases++; }, addEventListener() {} });
  const { api, events } = harness({ ...ios, wakeLock: { request: async () => { requests++; return requests === 1 ? first : sentinel(); } } });
  const wake = api.createScreenWakeLock();
  wake.start(); wake.stop(); resolve(sentinel());
  await new Promise(done => setImmediate(done));
  assert.equal(releases, 1); assert.equal(wake.state().held, false);
  wake.start(); await new Promise(done => setImmediate(done));
  assert.equal(wake.state().held, true);
  events.get('pagehide')({ persisted: true });
  assert.equal(wake.state().suspended, true);
  events.get('pageshow')(); await new Promise(done => setImmediate(done));
  assert.equal(wake.state().held, true);
  wake.stop(); assert.equal(wake.state().active, false);
});



test('transient capability failure can retry, concurrent checks coalesce, success stays cached', async () => {
  let requests = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { api } = harness({ gpu: { requestAdapter: async () => { requests++; if (requests === 1) await gate; return {}; } }, storage: { getDirectory: async () => { if (requests === 1) throw Error('temporary storage failure'); return {}; } } });
  const first = api.requireRuntimeSupport(), concurrent = api.requireRuntimeSupport();
  release();
  const outcomes = await Promise.allSettled([first, concurrent]);
  assert.ok(outcomes.every(x => x.status === 'rejected'));
  assert.equal(requests, 1);
  await api.requireRuntimeSupport();
  await api.requireRuntimeSupport();
  assert.equal(requests, 2);
});

test('missing browser capabilities are classified separately from a temporary adapter refusal', async () => {
  const blocked = harness({}, { crossOriginIsolated: false }).api;
  await assert.rejects(blocked.requireRuntimeSupport(), error => error.code === 'MCWEB_RUNTIME_UNSUPPORTED');
  const noGpu = harness().api;
  await assert.rejects(noGpu.requireRuntimeSupport(), error => error.code === 'MCWEB_RUNTIME_UNSUPPORTED');
  let requests = 0;
  const temporary = harness({ gpu: { requestAdapter: async () => ++requests === 1 ? null : {} }, storage: { getDirectory: async () => ({}) } }).api;
  await assert.rejects(temporary.requireRuntimeSupport(), error => error.code !== 'MCWEB_RUNTIME_UNSUPPORTED');
  await temporary.requireRuntimeSupport();
  assert.equal(requests, 2);
});

const ownLoader = suffix => '/*\n' + loader + '\n*/\nglobalThis.loaderEvaluations = (globalThis.loaderEvaluations || 0) + 1;\n' + suffix;
const preparation = text => ({ cacheKey: 'own-retry-release', loader: { bytes: Buffer.byteLength(text), sha256: hash(text) }, libraries: [], mobileJarPlan: { clientJar: 'own-client.jar' } });
const loaderResponse = text => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer });

test('mobile preparation retries a pre-evaluation download failure and evaluates only once after success', async () => {
  const text = ownLoader(''), config = preparation(text);let fetches = 0;
  const { api, context } = harness(ios, { fetch: async url => { fetches++; assert.ok(url.includes('release=own-retry-release')); return fetches === 1 ? { ok: false, status: 503 } : loaderResponse(text); } });
  await assert.rejects(api.prepareMobileRuntime(config), /HTTP 503/);
  assert.equal(context.loaderEvaluations, undefined);
  await api.prepareMobileRuntime(config);
  await api.prepareMobileRuntime(config);
  assert.equal(fetches, 2);
  assert.equal(context.loaderEvaluations, 1);
});

test('mobile preparation never reevaluates a loader that already began side effects', async () => {
  const text = ownLoader("throw new Error('own initialization failure');"), config = preparation(text);let fetches = 0;
  const { api, context } = harness(ios, { fetch: async () => { fetches++; return loaderResponse(text); } });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(api.prepareMobileRuntime(config), error => error.code === 'MCWEB_RUNTIME_RELOAD_REQUIRED' && error.cause.message === 'own initialization failure');
  assert.equal(fetches, 1);
  assert.equal(context.loaderEvaluations, 1);
});

test('a bad loader checksum cannot initialize the runtime and does not poison a verified retry', async () => {
  const text = ownLoader(''), config = preparation(text);let fetches = 0;
  const { api, context } = harness(ios, { fetch: async () => loaderResponse(++fetches === 1 ? text.replace('loaderEvaluations', 'alteredEvaluations') : text) });
  await assert.rejects(api.prepareMobileRuntime(config), /release checksum/);
  assert.equal(context.loaderEvaluations, undefined);
  assert.equal(context.alteredEvaluations, undefined);
  await api.prepareMobileRuntime(config);
  assert.equal(fetches, 2);
  assert.equal(context.loaderEvaluations, 1);
});


test('desktop Safari prepares pinned bounded loader/modules while touch and wake behavior stays desktop', async () => {
  const text=ownLoader(''),config=preparation(text),requests=[];
  const bytes=new Uint8Array([0,97,115,109,1,0,0,0]);
  config.libraries=[['libjvm.so',{bytes:bytes.length,sha256:hash(bytes)}]];
  let wakes=0;
  const {api,context}=harness({...desktopSafari,wakeLock:{request:async()=>{wakes++;throw Error('unexpected desktop wake request');}}},
    {WebAssembly,fetch:async url=>{requests.push(url);return String(url).includes('libjvm.so')?{ok:true,arrayBuffer:async()=>bytes.buffer}:loaderResponse(text);}});
  await api.prepareMobileRuntime(config,()=>{},3200);
  await api.prepareMobileRuntime(config,()=>{},null);
  assert.equal(context.loaderEvaluations,1);
  assert.ok(context.__mcWebMobileModules['libjvm.so'] instanceof WebAssembly.Module);
  assert.equal(requests.length,2,'One verified loader and one verified external module');
  const transformed=api.mobileRuntimeSource(loader,'https://example.test/javavm.js?release=own','',config.mobileJarPlan.clientJar);
  assert.match(transformed,/pthreadPoolSize = 2;/);assert.match(transformed,/"maximum": 18432,/);
  assert.match(transformed,/mcweb_lazy_depth/);assert.match(transformed,/mcweb_lazy_pipeline/);assert.match(transformed,/mcweb_bindgroup_cache/);
  const wake=api.createScreenWakeLock();wake.start();await new Promise(r=>setImmediate(r));
  assert.equal(wake.state().active,false);assert.equal(wakes,0);assert.equal(api.usesIOSRuntime(),false);
});

test('actual launcher separates bounded VM identity and memory display from iOS profile storage and controls', async () => {
  const builder=await readFile(new URL('../tools/build-wasmjvm.mjs',import.meta.url),'utf8');
  const start=builder.indexOf('function playPage('),end=builder.indexOf('\nfunction bundleServer(',start);
  const html=vm.runInNewContext('('+builder.slice(start,end)+')')({version:'26.3',mobileRuntime:{cacheKey:'own',loader:{},libraries:[]}});
  const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const {prepareVmIdentity}=await import('../web/vm-identity.mjs');
  const bytes=new Uint8Array([0,97,115,109,1,0,0,0]),module=await WebAssembly.compile(bytes);
  const api=harness(desktopSafari).api,record={bytes:bytes.length,sha256:hash(bytes)};
  const match=script.match(/const vmIdentity = await prepareVmIdentity\(mobileRuntimeConfig.vm, ([\s\S]*?)\n    \}\);/);assert.ok(match);
  const options=vm.runInNewContext('('+match[1]+'\n})',{mobile:api,globalThis:{__mcWebMobileModules:{'libjvm.so':module}},mobileRuntimeConfig:{cacheKey:'own'}});
  let report;await prepareVmIdentity(record,{...options,fetchImpl:()=>{throw Error('Desktop MEMFS identity path must not fetch again');},report:v=>report=v}).then(identity=>identity.onRuntimeInitialized());
  assert.equal(report.accepted,true);assert.equal(report.mechanism,'ios-pinned-external-libjvm-module');
  const declarations=script.match(/const ios = mobile.usesIOSRuntime\(\);\nconst boundedRuntime = mobile.usesBoundedRuntime\(\);/)[0];
  const policy=script.match(/const memoryPolicy = \{[\s\S]*?\n  check: mobile.appliedMemoryLimits \};/)[0];
  const caps=script.match(/desktopCaps: (\{[\s\S]*?wasmMaxMiB:[^}]+\})/)[1];
  const checked=vm.runInNewContext(declarations+'\n'+policy+'\n({ios,boundedRuntime,policy:memoryPolicy,caps:('+caps+')})',{mobile:api,heapMiB:flag=>flag==='-Xmx'?448:96});
  assert.equal(checked.ios,false);assert.equal(checked.boundedRuntime,true);assert.equal(checked.policy.applies,false);
  assert.equal(checked.caps.wasmMaxMiB,1152);assert.equal(checked.caps.javaMaxMiB,448);
  assert.match(script,/container: document.getElementById\('launch-options'\), query, ios, write/);
});
