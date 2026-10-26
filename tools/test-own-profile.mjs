import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { playerStorageTestingPage } from '../server/game-storage-launcher.mjs';
const source = await readFile(new URL('../public/auth/own-profile.js', import.meta.url), 'utf8');
const profile = { id: '0123456789abcdef0123456789abcdef', name: 'VerifiedPlayer' };
const property = { name: 'textures', value: 'signed-public-value', signature: 'signed-public-proof' };
const valid = { ...profile, properties: [property] };
let reply, calls = 0;
const writes = [];
const context = { TextEncoder, TextDecoder, Uint8Array, AbortSignal, console: { warn() {} },
  fetch: async (url, options) => {
    calls++; assert.equal(url, '/mcweb/auth/minecraft/profile');
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store'); assert.equal(options.headers, undefined);
    return reply;
  } };
vm.createContext(context); vm.runInContext(source, context);
const api = context.mcWebOwnProfile;
const module = { FS: { mkdirTree(path) { assert.equal(path, '/app/mcweb'); },
  writeFile(path, bytes) { writes.push({ path, value: JSON.parse(new TextDecoder().decode(bytes)) }); } } };
await api.prepare(); api.attach(module); assert.equal(calls, 0); assert.equal(writes.length, 0);
reply = Response.json(valid); await api.prepare(profile); api.attach(module);
assert.deepEqual(writes, [{ path: '/app/mcweb/own-profile.json', value: valid }]);
api.attach(module); assert.equal(writes.length, 1, 'Preload bytes are consumed once and never persist in browser storage');
for (const value of [{ ...valid, id: 'f'.repeat(32) }, { ...valid, name: 'Other' },
  { ...valid, properties: [{ name: 'textures', value: 'unsigned' }] }, { ...valid, properties: [property, property] }]) {
  reply = Response.json(value); await api.prepare(profile); api.attach(module); assert.equal(writes.length, 1);
}
reply = new Response('x'.repeat(96 * 1024 + 1)); await api.prepare(profile); api.attach(module); assert.equal(writes.length, 1);
const html = '<script>  const runtimeArgs = mobile.runtimeArguments(args, memoryWasmMaxMiB);\n    await createJavaVM({\n      preRun: [(module) => {}] });</script>';
const prepared = playerStorageTestingPage(html);
assert.ok(prepared.indexOf('mcWebOwnProfile.prepare(') < prepared.indexOf('await createJavaVM('));
assert.match(prepared, /mcWebOwnProfile\.attach\(module\)/);
assert.match(prepared, /src="\/auth\/own-profile\.js/);
console.log('PASS own signed profile: bounded authenticated preload, matching identity, one ephemeral mount, failures preserve default appearance and prepare precedes Java');

// Optional integration against the selected generated Emscripten MEMFS and
// the actual asynchronous payload preRun, without starting Java or downloading
// any game bytes. All filesystem implementations are read from the loader.
if (process.argv[2] && process.argv[3]) {
  const { join } = await import('node:path');
  const { webcrypto, createHash } = await import('node:crypto');
  const loader = await readFile(join(process.argv[2], 'javavm.js'), 'utf8');
  const pre = await readFile(process.argv[3], 'utf8');
  const definitions = ['PATH', 'PATH_FS', 'MEMFS', 'ERRNO_CODES', 'FS_modeStringToFlags', 'FS_fileDataToTypedArray', 'FS'].map(name => {
    const start = loader.indexOf('var ' + name + ' = ');
    const end = loader.indexOf('\n};', start);
    assert.ok(start >= 0 && end > start, 'Selected loader must expose real ' + name);
    return loader.slice(start, end + 3);
  }).join('\n');
  const start = pre.indexOf('    Module.preRun.push(() => {');
  const end = pre.indexOf('\n    });\n  }', start);
  assert.ok(start >= 0 && end > start, 'Actual payload preRun must remain recognizable');
  const payloadHook = pre.slice(start, end + '\n    });'.length);
  const jar = new Uint8Array([80, 75, 3, 4, 17]);
  const manifest = { schema: 1, jars: [{ name: 'own-policy.jar', role: 'native-policy', bytes: jar.length,
    sha256: createHash('sha256').update(jar).digest('hex') }] };
  async function run(order, hook = payloadHook, corrupt = false) {
    const fsContext = vm.createContext({ assert, Uint8Array, Uint32Array, ArrayBuffer, Date, Module: {}, runtimeInitialized: false,
      // No Wasm heap is touched by these external file bytes. MEMFS still
      // checks buffer identity through its generated memory-view hook.
      growMemViews() {}, HEAP8: new Int8Array(1) });
    vm.runInContext(definitions + '\nFS.nameTable=new Array(4096); FS.mount(MEMFS, {}, "/"); FS.mkdir("/app");', fsContext);
    const FS = fsContext.FS;
    // Guard against a permissive test double masking the original EEXIST.
    FS.mkdir('/app/check'); assert.throws(() => FS.mkdir('/app/check'), error => error.errno === 20);
    reply = Response.json(valid); await api.prepare(profile);
    let done, failed = null;
    const finished = new Promise(resolve => { done = resolve; });
    const page = vm.createContext({ discarded: false, discardRequested: false, Module: { FS, preRun: [], mcWebPayload: './payload/manifest.json' },
      URL, Uint8Array, Uint32Array, crypto: webcrypto, navigator: {}, out() {},
      addRunDependency() {}, removeRunDependency() { done(); }, abort(message) { failed = message; },
      fetch: async url => url.endsWith('manifest.json') ? Response.json(manifest) : new Response(corrupt ? new Uint8Array([1, 2, 3, 4, 5]) : jar) });
    vm.runInContext(hook, page);
    if (order === 'profile-first') api.attach({ FS });
    page.Module.preRun[0](); await finished;
    if (order === 'payload-first') api.attach({ FS });
    return { FS, failed };
  }
  for (const order of ['profile-first', 'payload-first']) {
    const { FS, failed } = await run(order);
    assert.equal(failed, null, order + ' must mount both inputs without abort');
    assert.deepEqual(Array.from(FS.readFile('/app/mcweb/own-policy.jar')), Array.from(jar));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(FS.readFile('/app/mcweb/own-profile.json'))), valid);
  }
  const broken = payloadHook.replace("FS.mkdirTree('/app/mcweb')", "FS.mkdir('/app/mcweb')");
  assert.notEqual(broken, payloadHook, 'Fixed actual hook must use mkdirTree');
  assert.match((await run('profile-first', broken)).failed, /payload validation failed/, 'Original non-idempotent mkdir reproduces the startup abort');
  const corrupt = await run('profile-first', payloadHook, true);
  assert.match(corrupt.failed, /payload validation failed/, 'Directory fix must retain SHA-256 fail-closed validation');
  assert.throws(() => corrupt.FS.readFile('/app/mcweb/own-policy.jar'));
  console.log('PASS actual Emscripten MEMFS + asynchronous payload preRun: both profile/payload orders preserve exact bytes; original mkdir reproduces EEXIST abort; wrong SHA-256 stays blocked');
}
