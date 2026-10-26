// Launch memory: the bound and caps (web/mobile-runtime.js), which profile
// runs may become launch memory, and the Worker's OPFS storage of Apply and
// Reset as the page reads it back (web/memory-profile.js,
// web/memory-profile-worker.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [runtimeSource, profileSource, workerSource] = await Promise.all([
  read('../web/mobile-runtime.js'), read('../web/memory-profile.js'), read('../web/memory-profile-worker.js')]);
const plain = (value) => JSON.parse(JSON.stringify(value));
const IPAD = 'iPad AppleWebKit/605.1';

function runtime(userAgent = IPAD) {
  const context = vm.createContext({ navigator: { userAgent, platform: 'iPad', maxTouchPoints: 5 },
    location: new URL('https://example.test/game/'), URL, URLSearchParams, TextDecoder, crypto: webcrypto,
    document: { visibilityState: 'visible', addEventListener() {} }, addEventListener() {} });
  vm.runInContext(runtimeSource, context);
  return context.mcWebMobileRuntime;
}

// The Web Locks of the origin each fake OPFS belongs to, so every Worker of
// one origin shares them and a test can hold the profile lock (an active run).
const originLocks = new WeakMap();
function locks() {
  const held = new Set();
  return {
    held,
    async request(name, options, task) {
      if (held.has(name)) return task(null);
      held.add(name);
      try { return await task({ name }); } finally { held.delete(name); }
    },
  };
}

/** One OPFS directory (the profile's) with synchronous access handles. */
function opfs() {
  const files = new Map();
  const missing = () => Object.assign(new Error('missing'), { name: 'NotFoundError' });
  const directory = {
    async getDirectoryHandle() { return directory; },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw missing();
        files.set(name, new Uint8Array());
      }
      return {
        async getFile() { const bytes = files.get(name); return { text: async () => new TextDecoder().decode(bytes) }; },
        async createSyncAccessHandle() {
          return {
            getSize: () => files.get(name).length,
            read(buffer, { at }) { buffer.set(files.get(name).subarray(at, at + buffer.length)); return buffer.length; },
            truncate(size) { files.set(name, files.get(name).slice(0, size)); },
            write(bytes, { at }) {
              const current = files.get(name);
              const next = new Uint8Array(Math.max(current.length, at + bytes.length));
              next.set(current); next.set(bytes, at);
              files.set(name, next);
              return bytes.length;
            },
            flush() {}, close() {},
          };
        },
      };
    },
  };
  const put = (name, value) => files.set(name, new TextEncoder().encode(JSON.stringify(value)));
  const storage = { getDirectory: async () => directory };
  originLocks.set(storage, locks());
  return { files, put, storage, locks: originLocks.get(storage) };
}

/** A profile Worker; send() waits for an op and returns its last reply, deliver() only posts. */
function worker(storage, userAgent = IPAD) {
  const posted = [];
  let listener;
  const context = vm.createContext({ self: { postMessage: (message) => posted.push(message), addEventListener: (_, fn) => { listener = fn; } },
    navigator: { storage, userAgent, locks: originLocks.get(storage) }, crypto: webcrypto, TextEncoder, TextDecoder, setTimeout });
  vm.runInContext(workerSource, context);
  const send = async (data) => { posted.length = 0; await listener({ data }); return plain(posted.at(-1)); };
  return Object.assign(send, { posted, deliver: (data) => listener({ data }) });
}

function profile(storage, userAgent = IPAD, stored = {}) {
  const localStorage = { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = String(value); } };
  const context = vm.createContext({ navigator: { storage, userAgent }, performance: {}, localStorage });
  vm.runInContext(profileSource, context);
  return context.mcWebMemoryProfile;
}

const policyFor = (api = runtime()) => ({ applies: true, limitsFor: api.memoryBudgetLimits, check: api.appliedMemoryLimits });

test('the bound is the profile less 32 MiB; a reserve stays outside the WebAssembly cap, also below the defaults', () => {
  const api = runtime();
  const caps = ({ wasmMaxMiB, javaMaxMiB, javaInitialMiB, belowDefaults }) => [wasmMaxMiB, javaMaxMiB, javaInitialMiB, belowDefaults];
  assert.deepEqual(caps(api.memoryLimits(null)), [1152, 448, 96, false]);
  const plan = (profileMiB) => {
    const result = api.memoryBudgetLimits(profileMiB);
    assert.ok(result.ok, result.reason);
    const limits = plain(result.limits);
    assert.equal(limits.boundMiB, profileMiB - 32);
    assert.equal(limits.reserveMiB, Math.max(256, Math.ceil(limits.boundMiB * 0.2)));
    assert.ok(limits.wasmMaxMiB + limits.reserveMiB <= limits.boundMiB);
    return [limits.boundMiB, limits.reserveMiB, ...caps(limits)];
  };
  assert.deepEqual(plan(2000), [1968, 394, 1536, 576, 96, false]);
  assert.deepEqual(plan(1472), [1440, 288, 1152, 448, 96, false]);
  // The physical iPhone's 1664 MiB reload point: -Xmx496m reserved 512 MiB, so the heap is 480.
  assert.deepEqual(plan(1664), [1632, 327, 1280, 480, 96, false]);
  // Lower than the defaults: the game gets less, never the larger defaults.
  assert.deepEqual(plan(1216), [1184, 256, 896, 320, 96, true]);
  assert.deepEqual(plan(800), [768, 256, 512, 192, 96, true]);
  // The loader's compiled 4 GiB maximum and the 1536 MiB desktop heap cap large profiles.
  assert.deepEqual(plan(6000), [5968, 1194, 4096, 1536, 96, false]);
  // Below the loader's fixed 512 MiB initial memory nothing can run inside the bound.
  for (const refused of [799, 543, 100, 0, -1, 1500.5, null]) assert.equal(api.memoryBudgetLimits(refused).ok, false, String(refused));
  for (const invalid of [1000, 448, 4160]) assert.throws(() => api.memoryLimits(invalid), String(invalid));
});

test('every Java heap the iPhone/iPad gets is a whole 32 MiB unit, so the JVM cannot round it up', () => {
  const api = runtime();
  const original = ['-Xmx1536m', '-Xms1536m', '-cp', 'own.jar', 'Boot'];
  const heap = (args) => Array.from(args).filter((arg) => /^-Xm[xs]/.test(arg));
  for (const wasmMaxMiB of [null, ...Array.from({ length: (4096 - 512) / 64 + 1 }, (_, i) => 512 + i * 64)]) {
    const limits = api.memoryLimits(wasmMaxMiB);
    assert.equal(limits.javaMaxMiB % 32, 0, String(wasmMaxMiB));
    assert.equal(limits.javaInitialMiB % 32, 0, String(wasmMaxMiB));
    assert.ok(limits.javaMaxMiB <= limits.wasmMaxMiB * 448 / 1152 && limits.javaMaxMiB <= 1536, String(wasmMaxMiB));
    // What Play passes the JVM is exactly these caps.
    assert.deepEqual(heap(api.runtimeArguments(original, wasmMaxMiB)), ['-Xmx' + limits.javaMaxMiB + 'm', '-Xms96m']);
  }
});

test('the iPhone/iPad heap arguments follow the WebAssembly cap; desktop ignores it', () => {
  const api = runtime();
  const original = ['-Xmx1536m', '-Xms1536m', '-cp', 'own.jar', 'Boot'];
  const heap = (args) => Array.from(args).filter((arg) => /^-Xm[xs]/.test(arg));
  assert.deepEqual(heap(api.runtimeArguments(original)), ['-Xmx448m', '-Xms96m']);
  assert.deepEqual(heap(api.runtimeArguments(original, 1536)), ['-Xmx576m', '-Xms96m']);
  assert.deepEqual(heap(api.runtimeArguments(original, 1280)), ['-Xmx480m', '-Xms96m']);
  assert.deepEqual(heap(api.runtimeArguments(original, 896)), ['-Xmx320m', '-Xms96m']);
  assert.throws(() => api.runtimeArguments(original, 1000));
  assert.equal(runtime('Chrome/151 Linux').runtimeArguments(original, 1536), original);
});

test('completed and refused runs qualify; unfinished runs need confirmation, with or without a lifecycle note', () => {
  const { budgetBasis } = profile(opfs().storage);
  const record = (state, extra = {}) => ({ runId: 'own-run', state, stableMiB: 2000, pendingMiB: null, context: { userAgent: IPAD }, ...extra });
  const eligibility = (basis) => [basis.applicable, basis.needsAck ?? null, basis.profileMiB ?? null];
  assert.deepEqual(eligibility(budgetBasis(null, IPAD)), [false, null, null]);
  assert.deepEqual(eligibility(budgetBasis(record('completed'), IPAD)), [true, false, 2000]);
  assert.deepEqual(eligibility(budgetBasis(record('allocation-failed', { pendingMiB: 2032 }), IPAD)), [true, false, 2000]);
  for (const state of ['running', 'interrupted', 'page-left']) {
    // The profile amount is the last fully filled one, never the attempted one.
    assert.deepEqual(eligibility(budgetBasis(record(state, { pendingMiB: 2032 }), IPAD)), [true, true, 2000], state);
    // The page noted being hidden or unloaded during this run. Safari also does
    // that before reloading a tab itself, so it is a confirmation, never automatic.
    for (const how of ['unloaded', 'hidden']) {
      const exit = { runId: 'own-run', how };
      assert.deepEqual(eligibility(budgetBasis(record(state), IPAD, null, exit)), [true, true, 2000], how);
      // A Stop of the same run wins over the note.
      assert.deepEqual(eligibility(budgetBasis(record(state), IPAD, 'own-run', exit)), [false, null, null], how);
      // So do the other safeguards.
      assert.deepEqual(eligibility(budgetBasis(record(state, { stableMiB: 0 }), IPAD, null, exit)), [false, null, null], how);
      assert.deepEqual(eligibility(budgetBasis(record(state), 'iPad AppleWebKit/606.1', null, exit)), [false, null, null], how);
    }
  }
  for (const state of ['cancelled', 'checkpoint-failed']) {
    assert.deepEqual(eligibility(budgetBasis(record(state), IPAD)), [false, null, null], state);
    assert.deepEqual(eligibility(budgetBasis(record(state), IPAD, null, { runId: 'own-run', how: 'unloaded' })), [false, null, null], state);
  }
  assert.deepEqual(eligibility(budgetBasis(record('completed', { stableMiB: 0 }), IPAD)), [false, null, null]);
  assert.deepEqual(eligibility(budgetBasis(record('completed'), 'iPad AppleWebKit/606.1')), [false, null, null]);
});

test('the page reads back its own lifecycle note for a run, and a return to the front clears it', async () => {
  const stored = {};
  const note = (how) => { stored['mcweb-memory-profile-exit'] = JSON.stringify({ runId: 'own-run', how, at: 't' }); };
  const exit = async () => plain((await profile(opfs().storage, IPAD, stored).readProfile()).exit);
  note('hidden');
  assert.deepEqual(await exit(), { runId: 'own-run', how: 'hidden', at: 't' });
  note('unloaded');
  assert.deepEqual(await exit(), { runId: 'own-run', how: 'unloaded', at: 't' });
  note(null);
  assert.equal(await exit(), null);
});

test('Apply and Reset persist apart from the run record and the page reads the newest entry', async () => {
  const store = opfs();
  const send = worker(store.storage);
  const policy = policyFor();
  const load = async (userAgent) => plain(await profile(store.storage, userAgent).loadSelectedBudget(policy));
  const limits = plain(policy.limitsFor(2000).limits);
  const select = (extra = {}) => send({ op: 'select-budget', basis: { startedAt: 't0', stableMiB: 2000 },
    acknowledgedBrowserEnded: false, limits, context: { userAgent: IPAD }, ...extra });
  const run = (state) => ({ schema: 1, seq: 1, runId: 'own-run', state, startedAt: 't0', stableMiB: 2000,
    pendingMiB: state === 'running' ? 2032 : null, stepMiB: 32, limitMiB: 8192, history: [], context: { userAgent: IPAD } });
  const refused = async (reply) => {
    assert.equal(reply.type, 'error');
    assert.deepEqual(await load(), { budget: null, note: null, present: false });
  };

  assert.deepEqual(await load(), { budget: null, note: null, present: false });
  store.put('checkpoint-a.json', run('cancelled'));
  await refused(await select());
  store.put('checkpoint-a.json', run('running'));
  await refused(await select());
  await refused(await select({ acknowledgedBrowserEnded: true, basis: { startedAt: 't0', stableMiB: 1000 } }));
  await refused(await select({ acknowledgedBrowserEnded: true, limits: plain(policy.limitsFor(1600).limits) }));
  // Caps that leave less than the reserve inside the bound are refused even when the profile amount matches.
  await refused(await select({ acknowledgedBrowserEnded: true, limits: { ...limits, wasmMaxMiB: 1600 } }));
  await refused(await select({ acknowledgedBrowserEnded: true, limits: { ...limits, reserveMiB: 0 } }));

  const applied = await select({ acknowledgedBrowserEnded: true });
  assert.equal(applied.type, 'budget-selected');
  assert.equal(applied.record.state, 'interrupted');
  assert.deepEqual([applied.selected.basis.state, applied.selected.basis.pendingMiB, applied.selected.basis.acknowledgedBrowserEnded],
    ['interrupted', 2032, true]);
  const loaded = await load();
  assert.deepEqual([loaded.budget.limits.profileMiB, loaded.budget.limits.boundMiB, loaded.budget.limits.reserveMiB,
    loaded.budget.limits.wasmMaxMiB], [2000, 1968, 394, 1536]);
  assert.deepEqual(loaded.budget.limits, limits);
  assert.equal(JSON.parse(new TextDecoder().decode(store.files.get('checkpoint-a.json'))).state, 'interrupted');

  // Another browser version or another sizing policy does not apply it.
  assert.equal((await load('iPad AppleWebKit/606.1')).budget, null);
  assert.equal(plain(profile(store.storage).checkSelectedBudget({ ...loaded.budget, limits: { ...limits, javaMaxMiB: 1024 } },
    policy, IPAD)).budget, null);

  assert.equal((await send({ op: 'clear-budget' })).type, 'budget-cleared');
  assert.deepEqual(await load(), { budget: null, note: null, present: false });
  // A Reset cut off half way leaves the entry before it, here the Apply.
  store.files.set('budget-a.json', new TextEncoder().encode('{"schema":1,"seq":2,'));
  assert.equal((await load()).budget.limits.boundMiB, 1968);
});

test('an entry applied under the earlier policy is re-derived, never larger; foreign ones are ignored', async () => {
  const api = runtime();
  const legacy = (extra = {}) => ({ schema: 1, kind: 'mcweb-launch-memory-budget', seq: 1, selectedAt: 't1', budgetMiB: 2000,
    limits: { budgetMiB: 2000, reserveMiB: 400, wasmMaxMiB: 1600, javaMaxMiB: 608, javaInitialMiB: 96,
      policy: 'reserve-max256-20pct.wasm-floor64-max4096.java-448of1152-floor16-max1536.v1' },
    context: { userAgent: IPAD }, basis: { state: 'completed', stableMiB: 2000 }, ...extra });
  const load = async (entry) => {
    const store = opfs();
    store.put('budget-a.json', entry);
    return plain(await profile(store.storage).loadSelectedBudget(policyFor(api)));
  };
  // The old entry launched 1600/608 MiB; the current policy gives the same profile 1536/576.
  const migrated = await load(legacy());
  assert.deepEqual([migrated.budget.legacy, migrated.budget.limits.boundMiB, migrated.budget.limits.reserveMiB,
    migrated.budget.limits.wasmMaxMiB, migrated.budget.limits.javaMaxMiB], [true, 1968, 394, 1536, 576]);
  assert.deepEqual(Array.from(api.runtimeArguments(['-cp', 'own.jar'], migrated.budget.limits.wasmMaxMiB))
    .filter((arg) => /^-Xm[xs]/.test(arg)), ['-Xmx576m', '-Xms96m']);
  for (const foreign of [{ budgetMiB: 1999 }, { limits: { ...legacy().limits, policy: 'unknown' } }]) {
    const ignored = await load(legacy(foreign));
    assert.deepEqual([ignored.budget, ignored.present], [null, true], JSON.stringify(foreign));
  }
});

const V2_POLICY = 'bound-profile-minus32.reserve-max256-20pct.wasm-floor64-min512-max4096.java-448of1152-floor16-max1536.v2';

test('an entry applied with a 16 MiB Java heap keeps its bound and WebAssembly cap and launches a 32 MiB-aligned heap', async () => {
  const api = runtime();
  const load = async (entry) => {
    const store = opfs();
    store.put('budget-a.json', entry);
    const rawBefore = new Map([...store.files].map(([name, bytes]) => [name, bytes.slice()]));
    const loaded = plain(await profile(store.storage).loadSelectedBudget(policyFor(api)));
    assert.deepEqual(store.files, rawBefore, 'Reading/migrating v2 must not rewrite raw saved budget bytes');
    return loaded;
  };
  // The physical iPhone's entry as Apply stored it: a confirmed browser-reload profile of 1664 MiB, -Xmx496m.
  const phone = (limits = {}, extra = {}) => ({ schema: 1, kind: 'mcweb-launch-memory-budget', seq: 1,
    selectedAt: '2026-10-22T10:42:01.116Z', context: { userAgent: IPAD },
    limits: { profileMiB: 1664, headroomMiB: 32, boundMiB: 1632, reserveMiB: 327, wasmMaxMiB: 1280, javaMaxMiB: 496,
      javaInitialMiB: 96, belowDefaults: false, policy: V2_POLICY, ...limits },
    basis: { state: 'interrupted', acknowledgedBrowserEnded: true, startedAt: '2026-10-22T10:41:42.833Z', endedAt: null,
      stepMiB: 64, limitMiB: 8192, stableMiB: 1664, pendingMiB: 1728, failure: null }, ...extra });
  const migrated = await load(phone());
  assert.equal(migrated.present, true);
  const { limits } = migrated.budget;
  assert.deepEqual([migrated.budget.legacy, limits.profileMiB, limits.boundMiB, limits.reserveMiB, limits.wasmMaxMiB,
    limits.javaMaxMiB, limits.javaInitialMiB, limits.migratedFrom], [true, 1664, 1632, 327, 1280, 480, 96, V2_POLICY]);

  // An entry v2 never wrote is not migrated, also when it is smaller, and neither is one from another browser.
  for (const [changed, extra] of [[{ javaMaxMiB: 480 }], [{ wasmMaxMiB: 1344 }], [{ reserveMiB: 256 }], [{ boundMiB: 1664 }],
    [{}, { basis: { ...phone().basis, stableMiB: 1700 } }], [{}, { context: { userAgent: 'iPad AppleWebKit/606.1' } }]]) {
    const ignored = await load(phone(changed, extra));
    assert.deepEqual([ignored.budget, ignored.present], [null, true], JSON.stringify([changed, extra]));
  }

  // Every profile's v2 entry migrates to caps no larger than it launched, with the same bound and WebAssembly cap.
  for (let profileMiB = 800; profileMiB <= 6000; profileMiB += 37) {
    const current = plain(api.memoryBudgetLimits(profileMiB).limits);
    const v2Java = Math.min(1536, Math.floor(current.wasmMaxMiB * 448 / 1152 / 16) * 16);
    const old = { ...current, javaMaxMiB: v2Java, policy: V2_POLICY };
    const entry = phone(old, { basis: { ...phone().basis, stableMiB: profileMiB } });
    const loaded = (await load(entry)).budget.limits;
    assert.deepEqual([loaded.boundMiB, loaded.reserveMiB, loaded.wasmMaxMiB], [old.boundMiB, old.reserveMiB, old.wasmMaxMiB]);
    assert.ok(loaded.javaMaxMiB <= old.javaMaxMiB && loaded.javaMaxMiB % 32 === 0, String(profileMiB));
  }
});

// What a browser reload during a fill leaves: the checkpoint of the last fully
// filled step (2000 MiB, with 2032 MiB being tried), the next checkpoint write
// cut off in the other slot, and the page's lifecycle note naming the run.
function reloadedDuringFill(extra = {}) {
  const store = opfs();
  store.put('checkpoint-a.json', { schema: 1, seq: 4, runId: 'own-run', state: 'running', startedAt: 't0', stableMiB: 2000,
    pendingMiB: 2032, stepMiB: 32, limitMiB: 8192, history: [], context: { userAgent: IPAD }, ...extra });
  store.files.set('checkpoint-b.json', new TextEncoder().encode('{"schema":1,"seq":5,"runId":"own-run","state":"running","stableMiB":2032'));
  const local = { 'mcweb-memory-profile-exit': JSON.stringify({ runId: 'own-run', how: 'unloaded', at: 't' }) };
  return { store, local };
}

/** What the reopened page reads, and its Apply as the panel sends it (memory-profile.js mount). */
async function reopen({ store, local }, policy) {
  const page = profile(store.storage, IPAD, local);
  const read = await page.readProfile();
  const basis = plain(page.budgetBasis(read.record, IPAD, read.stoppedRunId, read.exit));
  const plan = basis.applicable ? plain(policy.limitsFor(basis.profileMiB)) : null;
  // An ineligible run is still sent with its own amount's limits, so the Worker's own checks decide.
  const apply = (acknowledgedBrowserEnded) => worker(store.storage)({ op: 'select-budget',
    basis: { startedAt: read.record.startedAt, stableMiB: read.record.stableMiB }, acknowledgedBrowserEnded,
    limits: plan?.limits ?? plain(policy.limitsFor(read.record.stableMiB).limits), exitedRunId: read.exit?.runId ?? null,
    stoppedRunId: read.stoppedRunId, context: { userAgent: IPAD } });
  return { read: plain(read), basis, plan, apply };
}

test('a run the browser reloaded after a lifecycle note applies its last durable fill only when confirmed', async () => {
  const policy = policyFor();
  const reloaded = reloadedDuringFill();
  const noBudget = async () => assert.equal((await profile(reloaded.store.storage).loadSelectedBudget(policy)).budget, null);
  const page = await reopen(reloaded, policy);
  // The reopened page has the last fully filled and the attempted amounts, and the run's note.
  assert.deepEqual([page.read.record.state, page.read.record.stableMiB, page.read.record.pendingMiB, page.read.exit.runId],
    ['running', 2000, 2032, 'own-run']);
  assert.deepEqual([page.basis.applicable, page.basis.needsAck, page.basis.profileMiB], [true, true, 2000]);

  // Without the confirmation (the player reloaded or switched away) nothing is applied.
  assert.equal((await page.apply(false)).type, 'error');
  await noBudget();
  // Nor while a profile runs in another tab of the site (it holds the profile lock).
  reloaded.store.locks.held.add('mcweb-memory-profile');
  assert.equal((await page.apply(true)).type, 'error');
  await noBudget();
  reloaded.store.locks.held.delete('mcweb-memory-profile');

  // Confirmed: the run is stored as page-left, and the bound comes from 2000 MiB, never 2032.
  const applied = await page.apply(true);
  assert.equal(applied.type, 'budget-selected');
  assert.deepEqual([applied.record.state, applied.record.history.at(-1).state, applied.record.history.at(-1).pendingMiB],
    ['page-left', 'page-left', 2032]);
  assert.deepEqual([applied.selected.basis.state, applied.selected.basis.stableMiB, applied.selected.basis.pendingMiB,
    applied.selected.basis.acknowledgedBrowserEnded], ['page-left', 2000, 2032, true]);

  // After the reload, Play reads that entry and launches with its caps.
  const launch = plain(await profile(reloaded.store.storage).loadSelectedBudget(policy));
  assert.deepEqual(launch.budget.limits, page.plan.limits);
  assert.deepEqual([launch.budget.limits.boundMiB, launch.budget.limits.reserveMiB, launch.budget.limits.wasmMaxMiB],
    [1968, 394, 1536]);
  assert.deepEqual(Array.from(runtime().runtimeArguments(['-Xmx1536m', '-Xms1536m', '-cp', 'own.jar'], launch.budget.limits.wasmMaxMiB))
    .filter((arg) => /^-Xm[xs]/.test(arg)), ['-Xmx576m', '-Xms96m']);
  // Reopened again, the stored page-left run still needs the confirmation.
  const after = await reopen(reloaded, policy);
  assert.deepEqual([after.read.record.state, after.basis.applicable, after.basis.needsAck], ['page-left', true, true]);
  assert.equal((await after.apply(false)).type, 'error');

  // Dismiss stores the ending as page-left with the note and as interrupted without it; neither applies anything.
  for (const [exitedRunId, state] of [['own-run', 'page-left'], ['other-run', 'interrupted']]) {
    const { store } = reloadedDuringFill();
    assert.equal((await worker(store.storage)({ op: 'settle', exitedRunId })).record.state, state, exitedRunId);
    assert.equal((await profile(store.storage).loadSelectedBudget(policy)).budget, null);
  }
});

test('Stop, a failed checkpoint and another browser win over the lifecycle note and the confirmation', async () => {
  const policy = policyFor();
  const refused = async (reloaded) => {
    const page = await reopen(reloaded, policy);
    assert.equal(page.basis.applicable, false);
    assert.equal((await page.apply(true)).type, 'error');
    assert.equal((await profile(reloaded.store.storage).loadSelectedBudget(policy)).budget, null);
    return plain(await profile(reloaded.store.storage).readProfile()).record.state;
  };
  // Stop noted only by the page: the tab ended before the durable record was written.
  const noted = reloadedDuringFill();
  noted.local['mcweb-memory-profile-stop'] = JSON.stringify({ runId: 'own-run', at: 't' });
  assert.equal(await refused(noted), 'cancelled');
  // Stop stored durably only.
  const durable = reloadedDuringFill();
  assert.equal((await worker(durable.store.storage)({ op: 'record-stop', runId: 'own-run' })).type, 'stop-recorded');
  assert.equal(await refused(durable), 'cancelled');
  assert.equal(await refused(reloadedDuringFill({ state: 'cancelled', pendingMiB: null })), 'cancelled');
  assert.equal(await refused(reloadedDuringFill({ state: 'checkpoint-failed', pendingMiB: null, failure: 'short checkpoint write' })),
    'checkpoint-failed');
  assert.equal(await refused(reloadedDuringFill({ context: { userAgent: 'iPad AppleWebKit/606.1' } })), 'running');
});

test('after a browser update an old run cannot be applied again', async () => {
  const store = opfs();
  const policy = policyFor();
  const limits = plain(policy.limitsFor(2000).limits);
  store.put('checkpoint-a.json', { schema: 1, seq: 1, runId: 'own-run', state: 'completed', startedAt: 't0', stableMiB: 2000,
    pendingMiB: null, stepMiB: 32, limitMiB: 2000, history: [], context: { userAgent: IPAD } });
  const apply = (userAgent) => worker(store.storage, userAgent)({ op: 'select-budget', basis: { startedAt: 't0', stableMiB: 2000 },
    acknowledgedBrowserEnded: false, limits, context: { userAgent } });
  assert.equal((await apply(IPAD)).type, 'budget-selected');

  const updated = 'iPad AppleWebKit/606.1';
  assert.equal(plain(await profile(store.storage, updated).loadSelectedBudget(policy)).budget, null);
  assert.equal(profile(store.storage, updated).budgetBasis(
    JSON.parse(new TextDecoder().decode(store.files.get('checkpoint-a.json'))), updated).applicable, false);
  const before = new Map([...store.files].map(([name, bytes]) => [name, bytes.slice()]));
  assert.equal((await apply(updated)).type, 'error');
  assert.deepEqual([...store.files.keys()].sort(), [...before.keys()].sort());
  for (const [name, bytes] of before) assert.deepEqual(store.files.get(name), bytes, name);
});

test('a stopped run never becomes a budget, even when its Worker had to be ended', async () => {
  const policy = policyFor();
  const limits = plain(policy.limitsFor(2000).limits);
  // What a Worker terminated mid-step leaves: the run still says running.
  const terminated = (store) => store.put('checkpoint-a.json', { schema: 1, seq: 1, runId: 'own-run', state: 'running',
    startedAt: 't0', stableMiB: 2000, pendingMiB: 2032, stepMiB: 32, limitMiB: 8192, history: [], context: { userAgent: IPAD } });
  const apply = (store) => worker(store.storage)({ op: 'select-budget', basis: { startedAt: 't0', stableMiB: 2000 },
    acknowledgedBrowserEnded: true, limits, context: { userAgent: IPAD } });
  const stored = async (store) => plain(await profile(store.storage).readProfile());
  const noBudget = async (store) => assert.deepEqual(plain(await profile(store.storage).loadSelectedBudget(policy)),
    { budget: null, note: null, present: false });

  // Stop recorded, then the Worker ended: after a reload the page refuses it,
  // and so does the Worker, even with the interruption acknowledged; that
  // Apply stores the run as cancelled.
  const store = opfs();
  terminated(store);
  assert.equal((await worker(store.storage)({ op: 'record-stop', runId: 'own-run' })).type, 'stop-recorded');
  const reloaded = await stored(store);
  assert.equal(reloaded.stoppedRunId, 'own-run');
  assert.equal(profile(store.storage).budgetBasis(reloaded.record, IPAD, reloaded.stoppedRunId).applicable, false);
  assert.equal((await apply(store)).type, 'error');
  await noBudget(store);
  const normalized = (await stored(store)).record;
  assert.deepEqual([normalized.state, normalized.pendingMiB, normalized.history.at(-1).state], ['cancelled', null, 'cancelled']);
  assert.equal((await apply(store)).type, 'error');
  await noBudget(store);

  // Dismiss after the reload stores it as cancelled too.
  const dismissed = opfs();
  terminated(dismissed);
  await worker(dismissed.storage)({ op: 'record-stop', runId: 'own-run' });
  assert.equal((await worker(dismissed.storage)({ op: 'settle' })).record.state, 'cancelled');
  assert.equal((await apply(dismissed)).type, 'error');

  // A Stop recorded for another run leaves this one an acknowledged interruption.
  const other = opfs();
  terminated(other);
  await worker(other.storage)({ op: 'record-stop', runId: 'other-run' });
  assert.equal((await worker(other.storage)({ op: 'settle' })).record.state, 'interrupted');
  assert.equal((await apply(other)).type, 'budget-selected');
});

test('a Stop the page only noted synchronously still blocks Apply after the durable record was lost', async () => {
  const policy = policyFor();
  const limits = plain(policy.limitsFor(2000).limits);
  // The tab ended (or the OPFS record failed) after Stop: only the localStorage note exists.
  const store = opfs();
  store.put('checkpoint-a.json', { schema: 1, seq: 1, runId: 'own-run', state: 'running', startedAt: 't0', stableMiB: 2000,
    pendingMiB: 2032, stepMiB: 32, limitMiB: 8192, history: [], context: { userAgent: IPAD } });
  const local = { 'mcweb-memory-profile-stop': JSON.stringify({ runId: 'own-run', at: 't' }) };
  const reloaded = plain(await profile(store.storage, IPAD, local).readProfile());
  assert.equal(reloaded.stoppedRunId, 'own-run');
  assert.equal(profile(store.storage).budgetBasis(reloaded.record, IPAD, reloaded.stoppedRunId).applicable, false);
  // Apply with the page's note is refused even with the interruption acknowledged, and stores the run as cancelled.
  const apply = () => worker(store.storage)({ op: 'select-budget', basis: { startedAt: 't0', stableMiB: 2000 },
    acknowledgedBrowserEnded: true, limits, stoppedRunId: reloaded.stoppedRunId, context: { userAgent: IPAD } });
  assert.equal((await apply()).type, 'error');
  assert.equal((await profile(store.storage).loadSelectedBudget(policy)).budget, null);
  assert.equal(plain(await profile(store.storage).readProfile()).record.state, 'cancelled');

  // The timed-out Stop's settle passes the note too.
  const settled = opfs();
  settled.put('checkpoint-a.json', { schema: 1, seq: 1, runId: 'own-run', state: 'running', startedAt: 't0', stableMiB: 2000,
    pendingMiB: 2032, stepMiB: 32, limitMiB: 8192, history: [], context: { userAgent: IPAD } });
  assert.equal((await worker(settled.storage)({ op: 'settle', stoppedRunId: 'own-run' })).record.state, 'cancelled');

  // A note for an older run does not stop this one.
  const older = { 'mcweb-memory-profile-stop': JSON.stringify({ runId: 'older-run', at: 't' }) };
  const other = plain(await profile(store.storage, IPAD, older).readProfile());
  assert.equal(profile(store.storage).budgetBasis({ ...other.record, state: 'running' }, IPAD, other.stoppedRunId).applicable, true);
});

test('Stop reaches a run while it fills a step and leaves a stopped record', async () => {
  const store = opfs();
  const run = worker(store.storage);
  const finished = run({ op: 'start', runId: 'own-run', stepMiB: 16, limitMiB: 8192, pauseMs: 0, context: { userAgent: IPAD } });
  // Started, and the first step is checkpointed.
  while (run.posted.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await worker(store.storage)({ op: 'record-stop', runId: 'own-run' })).type, 'stop-recorded');
  run.deliver({ op: 'stop' });
  const done = await finished;
  assert.equal(done.type, 'done');
  assert.equal(done.record.state, 'cancelled');
  assert.equal(done.record.pendingMiB, null);
  assert.ok(done.record.stableMiB < 8192 && done.record.stableMiB % 16 === 0);
  const reloaded = plain(await profile(store.storage).readProfile());
  assert.deepEqual([reloaded.record.state, reloaded.record.runId, reloaded.stoppedRunId], ['cancelled', 'own-run', 'own-run']);
  assert.equal(profile(store.storage).budgetBasis(reloaded.record, IPAD, reloaded.stoppedRunId).applicable, false);
});
