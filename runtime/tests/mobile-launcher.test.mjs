import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';

const builder = await readFile(new URL('../tools/build-wasmjvm.mjs', import.meta.url), 'utf8');
const begin = builder.indexOf('function playPage('), end = builder.indexOf('\nfunction bundleServer(', begin);
const render = vm.runInNewContext('(' + builder.slice(begin, end) + ')');
const html = render({ version: '26.3', mobileRuntime: { cacheKey: 'own', loader: {}, libraries: [] } });
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const installCode = script.slice(script.indexOf("const installButton ="), script.indexOf('playButton.onclick ='));
const settle = () => new Promise(resolve => setImmediate(resolve));

function launcher({ fetchManifest, support = async () => {}, missing = async () => [], install = async () => {} }) {
  const nodes = { install: { disabled: false, textContent: 'Install' } }, play = { disabled: true }, status = { textContent: '' }, logs = [];
  const context = vm.createContext({ document: { getElementById: name => nodes[name] }, fetch: fetchManifest,
    mobile: { requireRuntimeSupport: support }, playButton: play, status, write: (...args) => logs.push(args),
    mcWebUpstream: { install: () => ({}), missingPayload: missing, installPayload: install } });
  vm.runInContext(installCode, context);
  return { install: nodes.install, play, status, logs, context };
}
const manifest = { jars: [{ name: 'own.jar' }] };
const response = () => ({ ok: true, json: async () => manifest });

test('custom resolution uses exact pixels regardless of device scale and keeps arbitrary aspect ratios', async () => {
  const context = vm.createContext({});
  vm.runInContext(await readFile(new URL('../web/launch-display.js', import.meta.url), 'utf8'), context);
  const display = context.mcWebLaunchDisplay;
  const custom = display.resolve({ basis: 'custom', width: 1536, height: 1024, scale: 0.5 }, false,
    { devicePixelRatio: 2, innerWidth: 1920, innerHeight: 1080 });
  assert.equal(custom.width, 1536); assert.equal(custom.height, 1024);
  assert.match(display.describe(custom), /1536x1024.*custom launch size/);
  for (const width of ['', 0, 63, 8193, 1280.5, Infinity])
    assert.throws(() => display.resolve({ basis: 'custom', width, height: 720 }, false), /whole-number dimensions/);
  assert.equal(display.resolve({ basis: 'legacy' }, true).width, 640);
});

test('temporary manifest refusal leaves Install usable; retry fetches again and enables verified Play', async () => {
  let fetches = 0, installed = false;
  const page = launcher({ fetchManifest: async () => ++fetches === 1 ? { ok: false, status: 503 } : response(),
    missing: async () => installed ? [] : manifest.jars, install: async () => { installed = true; } });
  await settle();
  assert.equal(page.install.disabled, false);
  assert.equal(page.play.disabled, true);
  assert.match(page.status.textContent, /503.*Install to retry/);
  await page.install.onclick();
  assert.equal(fetches, 2);
  assert.equal(page.play.disabled, false);
  assert.equal(page.install.textContent, 'Reinstall');
});

test('storage failure can retry without discarding a successful manifest', async () => {
  let checks = 0, fetches = 0;
  const page = launcher({ fetchManifest: async () => { fetches++; return response(); },
    missing: async () => { if (++checks === 1) throw Error('temporary storage failure'); return []; } });
  await settle();
  assert.equal(page.install.disabled, false);
  assert.match(page.status.textContent, /storage failure.*Install to retry/);
  await page.install.onclick();
  assert.equal(fetches, 1);
  assert.equal(page.play.disabled, false);
});

test('definitive unsupported browser remains blocked before manifest/download', async () => {
  let fetched = false;
  const page = launcher({ support: async () => { const failure = Error('unsupported own browser'); failure.code = 'MCWEB_RUNTIME_UNSUPPORTED'; throw failure; },
    fetchManifest: async () => { fetched = true; return response(); } });
  await settle();
  assert.equal(fetched, false);
  assert.equal(page.install.disabled, true);
  assert.equal(page.play.disabled, true);
});

test('partial install remains unplayable and Install can resume', async () => {
  let installed = false, attempts = 0;
  const page = launcher({ fetchManifest: async () => response(), missing: async () => installed ? [] : manifest.jars,
    install: async () => { if (++attempts === 1) throw Error('own download interrupted'); installed = true; } });
  await settle();
  await page.install.onclick();
  assert.equal(page.install.disabled, false);
  assert.equal(page.play.disabled, true);
  await page.install.onclick();
  assert.equal(page.play.disabled, false);
  assert.equal(attempts, 2);
});

const upstreamSource = await readFile(new URL('../OpenJDK/browser/mojang-upstream.js', import.meta.url), 'utf8');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function cachedPayload(files, fetch) {
  const store = { async getFileHandle(name, options = {}) {
    if (!files.has(name) && !options.create) throw Error('missing own payload');
    return { async getFile() { const bytes = files.get(name); return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer }; },
      async createWritable() { let pending; return { async write(bytes) { pending = new Uint8Array(bytes); }, async close() { files.set(name, pending); } }; } };
  } };
  const context = vm.createContext({ navigator: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => store }) } },
    fetch, crypto: webcrypto, Uint8Array, DataView, URL, Response, TextDecoder, TextEncoder });
  vm.runInContext(upstreamSource, context);
  return context.mcWebUpstream;
}

test('fresh payload install resumes verified cache across a new realm and repairs corruption', async () => {
  const first = new Uint8Array([1, 2, 3]), second = new Uint8Array([4, 5, 6, 7]);
  const entries = [first, second].map((bytes, i) => ({ name: 'own-' + i + '.jar', bytes: bytes.length, sha256: digest(bytes) }));
  const plan = { jars: entries }, files = new Map(), calls = [];let failed = false;
  const fetch = async url => { calls.push(url); if (url.endsWith('own-1.jar') && !failed) { failed = true; return new Response('', { status: 503 }); } return new Response(url.endsWith('own-0.jar') ? first : second); };
  const initial = cachedPayload(files, fetch);
  assert.equal((await initial.missingPayload(plan)).length, 2);
  await assert.rejects(initial.installPayload(plan, { resolver: {} }), /HTTP 503/);
  assert.deepEqual(Array.from(await initial.missingPayload(plan), x => x.name), ['own-1.jar']);
  const restored = cachedPayload(files, fetch);
  await restored.installPayload(plan, { resolver: {} });
  assert.equal((await restored.missingPayload(plan)).length, 0);
  assert.equal(calls.filter(x => x.endsWith('own-0.jar')).length, 1, 'verified first file is not downloaded again');
  files.set(entries[0].sha256 + '-' + entries[0].name, new Uint8Array([9, 9, 9]));
  assert.deepEqual(Array.from(await restored.missingPayload(plan), x => x.name), ['own-0.jar']);
  await restored.installPayload(plan, { resolver: {} });
  assert.equal((await restored.missingPayload(plan)).length, 0);
  assert.equal(calls.filter(x => x.endsWith('own-0.jar')).length, 2);
});

test('launch failure retries only before runtime side effects; terminal failures use recovery', () => {
  const start = script.lastIndexOf('  } catch (error) {') + '  } catch (error) {'.length;
  const finish = script.lastIndexOf('\n  }\n};');
  assert.ok(start > 0 && finish > start);
  const body = script.slice(start, finish);
  for (const [vmStarted, code, retry] of [[false, undefined, true], [true, undefined, false], [false, 'MCWEB_RUNTIME_RELOAD_REQUIRED', false]]) {
    const state = { textContent: '' }, play = { disabled: true }, install = { disabled: true };let stopped = 0, terminal = 0;
    const context = vm.createContext({ document: { getElementById: () => null }, write() {}, mobileWake: { stop() { stopped++; } }, status: state, playButton: play, installButton: install,
      runtimeStopped() { terminal++; }, failure: Object.assign(Error('own launch failure'), { code }), vmStarted });
    vm.runInContext('((error, vmStarted) => {' + body + '})(failure, vmStarted)', context);
    assert.equal(stopped, retry ? 1 : 0);
    assert.equal(terminal, retry ? 0 : 1);
    assert.equal(play.disabled, !retry);
    assert.equal(install.disabled, !retry);
    if (retry) assert.match(state.textContent, /Play to retry/);
  }
});


test('actual terminal callbacks expose reload recovery and retain it after save failure', async () => {
  const stoppedCode = script.slice(script.indexOf('function gameStopped()'), script.indexOf('fullscreenButton.onclick ='));
  for (const hook of ['onAbort', 'onExit']) {
    let releases = 0, stopped = 0, returned = 0, reveals = 0, failSave = true;
    const play = { disabled: true }, install = { disabled: true }, status = {}, canvas = { classList: { remove(value) { assert.equal(value, 'on'); releases++; } } };
    const context = vm.createContext({ document: { body: { dataset: { launcherState: 'game' } }, getElementById: () => canvas }, gameReady: true, runtimeTerminal: false,
      gameControls: { setReady(ready) { assert.equal(ready, false); }, releaseAll() { releases++; } },
      discardGameRuntime: async () => {}, mobileWake: { stop() { stopped++; } }, status, playButton: play, installButton: install, fullscreenButton: {},
      ...(hook === 'onExit' ? {} : { mcWebRuntimeStopped() { reveals++; } }), async mcWebQuitToLauncher() { returned++; if (failSave) throw Error('disk full'); } });
    vm.runInContext(stoppedCode, context);
    const callback = script.match(new RegExp(hook + ': ([^\\n]+),'))[1];
    vm.runInContext('(' + callback + ')()', context);
    assert.equal(context.runtimeTerminal, true);
    assert.equal(context.gameReady, false);
    assert.equal(releases, 2); assert.equal(stopped, 1); assert.equal(reveals, hook === 'onExit' ? 0 : 1);
    assert.equal(context.document.body.dataset.launcherState, undefined, 'Recovery reveals the launcher even if its optional public hook was not loaded');
    assert.equal(play.disabled, false); assert.equal(install.disabled, true);
    assert.equal(play.textContent, 'Return to launcher');
    assert.match(status.textContent, /Return to the launcher/);
    await play.onclick();
    assert.match(status.textContent, /disk full.*Keep this page open/);
    assert.equal(play.disabled, false);
    failSave = false; await play.onclick();
    assert.equal(returned, 2); assert.equal(play.disabled, true);
  }
  assert.match(script, /if \(!runtimeTerminal && !gameReady\) \{\s*loadingStatus\(/,
    'Factory resolution cannot hide a synchronous exit behind running status');
});


const loadingCode = script.slice(script.indexOf('function loadingStatus('), script.indexOf('// A transferred canvas'));
const printCode = script.match(/print: t => \{([\s\S]*?)\n      \},\n      printErr:/)[1];
function loadingUi() {
  const loading = { hidden: true }, detail = { textContent: '' }, status = { textContent: '' }, calls = [];
  const context = vm.createContext({ document: { getElementById: id => ({ 'game-loading': loading, 'game-loading-status': detail })[id] },
    gameReady: false, runtimeTerminal: false, status, write() {}, gameControls: { setReady: ready => calls.push(ready), releaseAll() {} } });
  vm.runInContext(loadingCode, context);
  const print = vm.runInContext('(t) => {' + printCode + '}', context);
  return { context, loading, detail, status, calls, print };
}

test('boot status stays visible and noninteractive until a positive actual frame', () => {
  assert.match(html, /id="game-loading" role="status" aria-live="polite" hidden/);
  assert.match(html, /#game-loading \{[^}]*pointer-events:none/s);
  const page = loadingUi();
  page.context.loadingStatus('Starting Minecraft. This can take a few minutes.');
  assert.equal(page.loading.hidden, false);
  assert.equal(page.detail.textContent, page.status.textContent);
  for (const line of ['[MC-FRAMES] frames:0', '[MC-FRAME] first frame reported: 0', '[MC-FRAMES] frames:-1', '[MC-FRAMES] frames:unknown', '[MC-FRAMES] frames:100junk', '[MC-STAGE] Bootstrap.bootStrap']) page.print(line);
  assert.equal(page.context.gameReady, false);
  assert.equal(page.loading.hidden, false);
  assert.equal(page.calls.length, 0);
  page.print('[MC-FRAME] first frame reported: 1');
  assert.equal(page.context.gameReady, true);
  assert.equal(page.loading.hidden, true);
  assert.deepEqual(page.calls, [true]);
  assert.equal(page.status.textContent, 'running');
  page.context.loadingStatus('late factory completion');
  page.print('[MC-FRAMES] frames:100');
  assert.equal(page.status.textContent, 'running');
  assert.deepEqual(page.calls, [true]);
});

test('positive periodic frame is compatible, while terminal failure cannot regain readiness', () => {
  const page = loadingUi();
  page.context.loadingStatus('Loading Minecraft.');
  page.print('[MC-FRAMES] frames:100');
  assert.equal(page.context.gameReady, true);
  assert.equal(page.loading.hidden, true);
  page.context.runtimeTerminal = true;
  page.context.gameStopped();
  page.print('[MC-FRAME] first frame reported: 1');
  page.context.loadingStatus('late startup callback');
  assert.equal(page.context.gameReady, false);
  assert.equal(page.loading.hidden, true);
  assert.deepEqual(page.calls, [true, false]);
});
