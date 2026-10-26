#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { playerStorageTestingPage } from "../server/game-storage-launcher.mjs";

const source = await readFile(new URL("../public/auth/game-storage.js", import.meta.url), "utf8");
const bytes = value => Uint8Array.from(Buffer.from(value));
const actualMobileSource = process.argv[2] ? await readFile(process.argv[2], "utf8") : null;

// Transactions stage writes until completion, so abort/quota tests exercise
// the storage contract (including atomic imports) rather than a Map shortcut.
function database() {
  const files = new Map();
  let fullReads = 0;
  let created = false, abortNext = false, failPut = 0, afterPut = null;
  const db = {
    createObjectStore() { created = true; }, close() {},
    transaction(_name, mode) {
      const pending = new Map(files);
      let aborted = false, puts = 0;
      const transaction = { abort() { aborted = true; }, objectStore: () => ({
        getAll: () => { fullReads++; return request(() => [...pending.values()].map(value => structuredClone(value))); },
        get: key => request(() => structuredClone(pending.get(key))),
        openCursor() {
          const rows = [...pending.values()];
          const request = {};
          const advance = () => queueMicrotask(() => {
            const value = rows.shift();
            request.result = value ? { value: structuredClone(value), continue: advance } : null;
            request.onsuccess?.();
          });
          advance(); return request;
        },
        put: row => {
          if (++puts === failPut) { failPut = 0; throw new Error("DataCloneError: synthetic serialization failure"); }
          pending.set(row.path, structuredClone(row));
          return request(() => { const action = afterPut; afterPut = null; action?.(); return row.path; });
        },
        add(row) { if (pending.has(row.path)) throw new Error("ConstraintError"); pending.set(row.path, structuredClone(row)); },
        delete: key => { pending.delete(key); return request(() => undefined); },
      }) };
      setImmediate(() => {
        if ((abortNext && mode === "readwrite") || aborted) {
          abortNext = false;
          transaction.error = new Error("QuotaExceededError: synthetic full device");
          transaction.onabort?.();
        } else {
          files.clear(); for (const [key, value] of pending) files.set(key, value);
          transaction.oncomplete?.();
        }
      });
      return transaction;
    },
  };
  function request(get) {
    const request = {};
    queueMicrotask(() => { request.result = get(); request.onsuccess?.(); });
    return request;
  }
  return { files, fullReads: () => fullReads, failNext: () => { abortNext = true; },
    failPut: number => { failPut = number; }, afterPut: action => { afterPut = action; }, indexedDB: { open() {
    const request = { result: db };
    queueMicrotask(() => { if (!created) request.onupgradeneeded?.(); request.onsuccess?.(); });
    return request;
  } } };
}
function locks() {
  let busy = false;
  return { release: () => { busy = false; }, request: async (_name, _options, callback) => {
    if (busy) return callback(null);
    busy = true;
    try { return await callback({ name: "test-writer" }); } finally { busy = false; }
  } };
}
function filesystem() {
  const files = new Map();
  const dirs = new Set(["/", "/tmp"]);
  const FS = {
    cwd: () => "/tmp/mcgame", getPath: node => node.path,
    mkdirTree(path) { const parts = path.split("/"); for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/") || "/"); },
    isDir: mode => mode === 1, isFile: mode => mode === 2,
    stat(path) { if (typeof path !== "string") path = path.path; if (dirs.has(path)) return { mode: 1 }; if (files.has(path)) return { mode: 2 }; throw new Error("ENOENT"); },
    readdir(path) { const prefix = path + "/"; return [".", "..", ...new Set([...files.keys(), ...dirs].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length).split("/")[0]).filter(Boolean))]; },
    writeFile(path, data) { files.set(path, new Uint8Array()); const stream = { node: { path } }; FS.write(stream, data, 0, data.length, 0); FS.close(stream); },
    readFile(path) { if (!files.has(path)) throw new Error("ENOENT"); return files.get(path).slice(); },
    write(stream, data, offset, length, position = 0) {
      const before = files.get(stream.node.path) || new Uint8Array();
      const after = new Uint8Array(Math.max(before.length, position + length));
      after.set(before); after.set(data.subarray(offset, offset + length), position);
      files.set(stream.node.path, after); return length;
    },
    close() {}, truncate(path, size) { if (typeof path !== "string") path = path.path; files.set(path, (files.get(path) || new Uint8Array()).slice(0, size)); },
    unlink(path) { if (!files.delete(path)) throw new Error("ENOENT"); },
    rmdir(path) { dirs.delete(path); },
    rename(from, to) {
      for (const key of [...files.keys()]) if (key === from || key.startsWith(from + "/")) {
        files.set(to + key.slice(from.length), files.get(key)); files.delete(key);
      }
      for (const key of [...dirs]) if (key === from || key.startsWith(from + "/")) {
        dirs.add(to + key.slice(from.length)); dirs.delete(key);
      }
    },
  };
  return FS;
}
const fake = database(), lock = locks();
function load() {
  const sandbox = { indexedDB: fake.indexedDB, navigator: { locks: lock }, Uint8Array, TextDecoder, URLSearchParams,
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout,
    console: { log() {}, error() {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "game-storage.js" });
  return sandbox.mcWebGameStorage;
}
const first = load();
await first.ready();
assert.deepEqual(Array.from(await first.frameArguments()), ["-Dmcweb.pageOwnedStorage=true", "-Dmcweb.vsync=true"], "new players start with display pacing");
fake.files.set("options.txt", { path: "options.txt", data: bytes("enableVsync:true\nmaxFps:120\n") });
assert.deepEqual(Array.from(await load().frameArguments()), ["-Dmcweb.pageOwnedStorage=true", "-Dmcweb.vsync=true", "-Dmcweb.maxFps=120"], "a fresh launcher preserves saved video options");
fake.files.set("options.txt", { path: "options.txt", data: bytes("enableVsync:false\nmaxFps:260\n") });
assert.deepEqual(Array.from(await first.frameArguments()), ["-Dmcweb.pageOwnedStorage=true", "-Dmcweb.vsync=false", "-Dmcweb.maxFps=260"]);
assert.deepEqual(Array.from(await first.frameArguments("?mcweb_vsync=1&mcweb_max_fps=60")), ["-Dmcweb.pageOwnedStorage=true", "-Dmcweb.maxFps=60"], "explicit pacing queries remain authoritative without enabling duplicate storage scans");
fake.files.set("options.txt", { path: "options.txt", data: bytes("enableVsync:true\nmaxFps:120\n") });
for (const invalid of ["", "bad", "9", "261", "60.5", "Infinity"]) {
  assert.deepEqual(Array.from(await first.frameArguments("?mcweb_max_fps=" + invalid)), ["-Dmcweb.pageOwnedStorage=true", "-Dmcweb.vsync=true"], "invalid explicit query emits no saved-FPS fallback");
}
if (actualMobileSource) {
  for (const navigator of [{ userAgent: "iPhone", platform: "iPhone", maxTouchPoints: 5 }, { userAgent: "Macintosh AppleWebKit/605.1", platform: "MacIntel", maxTouchPoints: 5 }]) {
    const runtime = vm.createContext({ navigator });
    vm.runInContext(actualMobileSource, runtime);
    const fallbackFps = navigator.platform === "MacIntel" ? 120 : 20;
    for (const [saved, query, expected] of [[120, "", 120], [20, "", 20], [120, "?mcweb_max_fps=60", 60], [null, "", fallbackFps], [120, "?mcweb_max_fps=bad", fallbackFps]]) {
      if (saved === null) fake.files.delete("options.txt");
      else fake.files.set("options.txt", { path: "options.txt", data: bytes("enableVsync:true\nmaxFps:" + saved + "\n") });
      const explicit = /^\?mcweb_max_fps=\d+$/.test(query) ? ["-Dmcweb.maxFps=" + query.split("=")[1]] : [];
      const args = [...explicit, '-cp', 'own.jar', 'dev.mcweb.wasm.Boot', '--version', '26.3'];
      const html = `<script>globalThis.launch = async () => {
  const args = ${JSON.stringify(args)};
  const runtimeArgs = mobile.runtimeArguments(args, memoryWasmMaxMiB);
    await createJavaVM({arguments:runtimeArgs,
      preRun: [(module) => {}],
    });
};</script>`;
      const transformed = playerStorageTestingPage(html);
      let launched;
      const page = { mobile: runtime.mcWebMobileRuntime, memoryWasmMaxMiB: null, location: { search: query },
        __mcWebVerified: { session: { profile: {} } }, mcWebOwnProfile: { prepare: async () => {} },
        mcWebGameStorage: { frameArguments: first.frameArguments, prepare: async () => {} }, createJavaVM: async options => { launched = Array.from(options.arguments); } };
      vm.runInNewContext(transformed.match(/<script>([\s\S]*?)<\/script>/)[1], page);
      await page.launch();
      const cp = launched.indexOf('-cp'), boot = launched.indexOf('dev.mcweb.wasm.Boot');
      const fpsFlags = launched.filter(arg => arg.startsWith('-Dmcweb.maxFps='));
      assert.equal(Number(fpsFlags.at(-1).split('=')[1]), expected, "actual iPhone/iPad runtime + storage + adapter must retain chosen FPS");
      assert.ok(launched.includes('-Xmx448m') && launched.includes('-Xms96m'), 'phone memory defaults unchanged');
      assert.ok(cp > 0 && boot > cp);
      assert.ok(launched.every((arg, index) => !arg.startsWith('-D') || index < cp), 'all JVM properties precede classpath and Boot');
      for (const badArgs of [args.filter(arg => arg !== '-cp'), [...args, '-cp']]) {
        const broken = playerStorageTestingPage(html.replace(JSON.stringify(args), JSON.stringify(badArgs)));
        vm.runInNewContext(broken.match(/<script>([\s\S]*?)<\/script>/)[1], page);
        await assert.rejects(page.launch(), /Unexpected JVM classpath marker/);
      }
    }
  }
  console.log('PASS actual mobile runtime argv: saved120/20, explicit60, invalid query, iPad120/phone20 fallback, classpath guards and JVM-property placement');
}
fake.files.delete("options.txt");
await first.importFiles([{ path: "saves/Existing/level.dat", bytes: bytes("level") },
  { path: "saves/Existing/region/r.0.0.mca", bytes: bytes("chunks") }]);
assert.equal((await first.list()).length, 2);
assert.equal(fake.fullReads(), 0, "opening Settings must not load every binary file with getAll");
await assert.rejects(first.importFiles([{ path: "saves/Existing/level.dat", bytes: bytes("overwrite") },
  { path: "saves/New/level.dat", bytes: bytes("new") }]), /already exists/);
assert.equal(fake.files.has("saves/New/level.dat"), false);
await assert.rejects(first.importFiles([{ path: "saves/Existing/other-file", bytes: bytes("bad merge") }]), /already exists/);
await assert.rejects(first.importFiles([{ path: "resourcepacks/conflict", bytes: bytes("file") },
  { path: "resourcepacks/conflict/pack.mcmeta", bytes: bytes("child") }]), /also be a folder/);
await assert.rejects(first.importFiles([{ path: "resourcepacks/X/a", bytes: bytes("file") },
  { path: "resourcepacks/X/a-thing", bytes: bytes("intervening") },
  { path: "resourcepacks/X/a/b", bytes: bytes("child") }]), /also be a folder/);
await assert.rejects(first.importFiles([{ path: "saves/../escape", bytes: bytes("bad") }]), /Invalid/);

await first.prepare();
const FS = filesystem(); first.attach({ FS });
assert.doesNotThrow(() => FS.close({ node: null, flags: 2 }), "non-file descriptors must pass through without journal errors");
assert.equal(Buffer.from(FS.readFile("/tmp/mcgame/saves/Existing/region/r.0.0.mca")).toString(), "chunks");
const second = load(); await second.ready();
await assert.rejects(second.prepare(), /another tab/);
await assert.rejects(second.importFiles([{ path: "saves/Other/level.dat", bytes: bytes("other") }]), /another tab/);
await assert.rejects(second.exportTree("saves/Existing"), /another tab/);
await assert.rejects(first.exportTree("saves/Existing"), /Close the game/);
await assert.rejects(first.importFiles([{ path: "saves/Other/level.dat", bytes: bytes("other") }]), /Close the game/);

// Minecraft writes region files through an open descriptor, then atomically
// renames a new level.dat. Neither requires closing the entire JVM to persist.
FS.write({ node: { path: "/tmp/mcgame/saves/Existing/region/r.0.0.mca" } }, bytes("CHUNKS"), 0, 6, 0);
FS.writeFile("/tmp/mcgame/saves/Existing/level.dat_new", bytes("new-level"));
FS.rename("/tmp/mcgame/saves/Existing/level.dat_new", "/tmp/mcgame/saves/Existing/level.dat");
FS.writeFile("/tmp/mcgame/options.txt", bytes("music:0.5"));
FS.writeFile("/tmp/mcgame/saves/Existing/session.lock", bytes("ignored"));
await first.flush();
assert.equal(Buffer.from(await first.read("saves/Existing/level.dat")).toString(), "new-level");
assert.equal(Buffer.from(await first.read("saves/Existing/region/r.0.0.mca")).toString(), "CHUNKS");
assert.equal(fake.files.has("saves/Existing/level.dat_new"), false);
assert.equal(fake.files.has("saves/Existing/session.lock"), false);
FS.truncate({ path: "/tmp/mcgame/options.txt" }, 5);
await first.flush(); assert.equal(Buffer.from(await first.read("options.txt")).toString(), "music");

// Quota failures must reject flush, retain the dirty data and permit a retry.
FS.writeFile("/tmp/mcgame/saves/Existing/level.dat", bytes("retryable"));
fake.failNext(); await assert.rejects(first.flush(), /QuotaExceededError/);
assert.ok(first.status().pending > 0); assert.match(first.status().lastError, /QuotaExceededError/);
await first.flush(); assert.equal(first.status().pending, 0); assert.equal(first.status().lastError, null);

// A later request can throw synchronously after an earlier request succeeded.
// The save must abort as a whole and retain both dirty files for a retry.
const region = "/tmp/mcgame/saves/Existing/region/";
FS.writeFile(region + "r.1.0.mca", bytes("second-before")); await first.flush();
FS.writeFile(region + "r.0.0.mca", bytes("first-after"));
FS.writeFile(region + "r.1.0.mca", bytes("second-after"));
fake.failPut(2); await assert.rejects(first.flush(), /DataCloneError/);
assert.equal(Buffer.from(fake.files.get("saves/Existing/region/r.0.0.mca").data).toString(), "CHUNKS");
assert.equal(Buffer.from(fake.files.get("saves/Existing/region/r.1.0.mca").data).toString(), "second-before");
assert.equal(first.status().pending, 2);
await first.flush();
assert.equal(Buffer.from(fake.files.get("saves/Existing/region/r.1.0.mca").data).toString(), "second-after");

// Writes between request success tasks belong to the next generation. They
// must not mutate this save's snapshot or disappear when it commits.
FS.writeFile(region + "r.0.0.mca", bytes("snapshot-first"));
FS.writeFile(region + "r.1.0.mca", bytes("snapshot-second"));
fake.afterPut(() => FS.writeFile(region + "r.1.0.mca", bytes("newer-second")));
await first.flush();
assert.equal(Buffer.from(fake.files.get("saves/Existing/region/r.1.0.mca").data).toString(), "snapshot-second");
assert.equal(first.status().pending, 1, "newer generation must remain dirty after the snapshot commits");
await first.flush();
assert.equal(Buffer.from(fake.files.get("saves/Existing/region/r.1.0.mca").data).toString(), "newer-second");
assert.equal(first.status().pending, 0);
await first.importFiles([{ path: "resourcepacks/Test.zip", bytes: bytes("pack") }]);
assert.equal(Buffer.from(FS.readFile("/tmp/mcgame/resourcepacks/Test.zip")).toString(), "pack");
assert.equal(first.status().pending, 0, "durable live pack reveal must not copy the pack into the journal again");
const writeFile = FS.writeFile;
FS.writeFile = (path, data) => {
  if (path.startsWith("/tmp/mcweb-player-import-") && path.endsWith("texture.png")) throw new Error("Synthetic allocation failure");
  return writeFile(path, data);
};
await assert.rejects(first.importFiles([{ path: "resourcepacks/Broken/pack.mcmeta", bytes: bytes("meta") },
  { path: "resourcepacks/Broken/texture.png", bytes: bytes("texture") }]), /allocation failure/);
FS.writeFile = writeFile;
assert.equal(fake.files.has("resourcepacks/Broken/pack.mcmeta"), false);
assert.throws(() => FS.readFile("/tmp/mcgame/resourcepacks/Broken/pack.mcmeta"), /ENOENT/);
assert.equal(FS.readdir("/tmp").some(name => name.startsWith("mcweb-player-import-")), false);
fake.failNext();
await assert.rejects(first.importFiles([{ path: "resourcepacks/Quota.zip", bytes: bytes("quota") }]), /QuotaExceededError/);
assert.equal(fake.files.has("resourcepacks/Quota.zip"), false);
assert.equal(FS.readdir("/tmp").some(name => name.startsWith("mcweb-player-import-")), false);
const rename = FS.rename;
FS.rename = (from, to) => { if (to.endsWith("/Deferred.zip")) throw new Error("Synthetic rename failure"); return rename(from, to); };
await assert.rejects(first.importFiles([{ path: "resourcepacks/Deferred.zip", bytes: bytes("durable") }]), /saved in browser storage; reload/);
FS.rename = rename;
assert.equal(Buffer.from(fake.files.get("resourcepacks/Deferred.zip").data).toString(), "durable");
assert.equal(FS.readdir("/tmp").some(name => name.startsWith("mcweb-player-import-")), false);
await first.flush();
FS.unlink("/tmp/mcgame/saves/Existing/region/r.0.0.mca"); await first.flush();
assert.equal(fake.files.has("saves/Existing/region/r.0.0.mca"), false);

// A fresh module and MEMFS model a full document reload, including deletion.
lock.release();
const reloaded = load(); await reloaded.prepare();
const restored = filesystem(); reloaded.attach({ FS: restored });
assert.equal(Buffer.from(restored.readFile("/tmp/mcgame/saves/Existing/level.dat")).toString(), "retryable");
assert.throws(() => restored.readFile("/tmp/mcgame/saves/Existing/region/r.0.0.mca"), /ENOENT/);
lock.release();
const manager = load(); await manager.removeTree("saves/Existing");
assert.equal((await manager.list()).some(row => row.path.startsWith("saves/Existing/")), false);
assert.ok((await manager.list()).some(row => row.path.startsWith("resourcepacks/")));
const readsBeforeExport = fake.fullReads();
const exported = await manager.exportTree("resourcepacks/Test.zip");
assert.equal(exported.length, 1); assert.equal(Buffer.from(exported[0].bytes).toString(), "pack");
assert.equal(fake.fullReads(), readsBeforeExport, "export must not load unrelated worlds with getAll");
exported[0].bytes.fill(0);
assert.equal(Buffer.from(await manager.read("resourcepacks/Test.zip")).toString(), "pack", "export bytes are independent of the stored record");
await assert.rejects(manager.exportTree("resourcepacks/Test.zip", { maxBytes: 2 }), /size limit/);
await manager.importFiles([{ path: "resourcepacks/Folder/pack.mcmeta", bytes: bytes("meta") },
  { path: "resourcepacks/Folder/assets/test.txt", bytes: bytes("texture") }]);
await assert.rejects(manager.exportTree("resourcepacks/Folder", { maxFiles: 1 }), /too many files/);

// Both the deployed budget name and the canonical Wasm-cap name must keep
// saved pacing, storage restore and title asset mounting ahead of Java main.
for (const budgetName of ["memoryBudgetMiB", "memoryWasmMaxMiB"]) {
  const html = `<html><script>globalThis.launch = async () => {
  const ${budgetName} = 1536;
  const args = ['-cp', '/app/game.jar', 'dev.mcweb.wasm.Boot', '--version', '26.3'];
  const runtimeArgs = mobile.runtimeArguments(args, ${budgetName});
    await createJavaVM({
      arguments: runtimeArgs,
      preRun: [(module) => {
        module.mountTitleAssets();
      }],
    });
};</script></html>`;
  const hooked = playerStorageTestingPage(html);
  assert.match(hooked, /game-storage\.js/);
  const events = [], module = { mountTitleAssets: () => events.push('title-assets') };
  let launchedArguments;
  const page = {
    location: { search: '?mcweb_max_fps=120' },
    mobile: { runtimeArguments(args, cap) {
      events.push('runtime:' + cap);
      return ['-Xmx448m', ...args];
    } },
    __mcWebVerified: { session: { profile: { id: '1'.repeat(32), name: 'VerifiedPlayer' } } },
    mcWebOwnProfile: {
      async prepare(profile) { assert.equal(profile.name, 'VerifiedPlayer'); events.push('profile-prepare'); },
      attach(actual) { assert.equal(actual, module); events.push('profile-attach'); },
    },
    mcWebGameStorage: {
      async frameArguments(search) { events.push('frame:' + search); return ['-Dmcweb.vsync=true']; },
      async prepare() { events.push('prepare'); },
      attach(actual) { assert.equal(actual, module); events.push('attach'); },
    },
    async createJavaVM(options) {
      events.push('createJavaVM'); launchedArguments = options.arguments;
      for (const callback of options.preRun) callback(module);
      events.push('java-main');
    },
  };
  vm.runInNewContext(hooked.match(/<script>([\s\S]*?)<\/script>/)[1], page);
  await page.launch();
  assert.deepEqual(events, ['runtime:1536', 'frame:?mcweb_max_fps=120', 'prepare', 'profile-prepare', 'createJavaVM', 'attach', 'profile-attach', 'title-assets', 'java-main']);
  assert.deepEqual(Array.from(launchedArguments), ['-Xmx448m', '-Dmcweb.vsync=true', '-cp', '/app/game.jar', 'dev.mcweb.wasm.Boot', '--version', '26.3'], 'Saved VM properties precede the Java main class and game arguments');
  assert.throws(() => playerStorageTestingPage(html + html), /Unexpected/, 'Duplicate launch hooks must fail');
  const alternate = budgetName === 'memoryBudgetMiB' ? 'memoryWasmMaxMiB' : 'memoryBudgetMiB';
  assert.throws(() => playerStorageTestingPage(html.replace('    await createJavaVM({', '  const runtimeArgs = mobile.runtimeArguments(args, ' + alternate + ');\n    await createJavaVM({')), /Unexpected/, 'Mixed duplicate budget hooks must fail');
}
assert.throws(() => playerStorageTestingPage("unexpected runtime"), /Unexpected/);
// Quit must retain the document on a failed save and navigate only after a
// successful commit, even if the runtime reports the handoff more than once.
{
  const uiSource = await readFile(new URL("../public/auth/launcher-ui.js", import.meta.url), "utf8");
  const navigation = [];
  let complete, rejectSave = false, flushes = 0;
  const context = {
    document: { getElementById: () => null, addEventListener() {}, exitPointerLock() {} },
    addEventListener() {}, location: { replace: path => navigation.push(path) },
    mcWebGameStorage: { flush() {
      flushes++;
      return rejectSave ? Promise.reject(new Error("QuotaExceededError")) : new Promise(resolve => { complete = resolve; });
    } },
  };
  context.globalThis = context;
  vm.runInNewContext(uiSource, context);
  const quit = context.mcWebQuitToLauncher();
  assert.equal(context.mcWebQuitToLauncher(), quit);
  assert.equal(flushes, 1);
  assert.deepEqual(navigation, []);
  complete(); await quit;
  assert.deepEqual(navigation, ['/']);
  navigation.length = 0;
  vm.runInNewContext(uiSource, context);
  rejectSave = true;
  await assert.rejects(context.mcWebQuitToLauncher(), /QuotaExceededError/);
  assert.deepEqual(navigation, []);
  rejectSave = false;
  const retriedQuit = context.mcWebQuitToLauncher();
  complete(); await retriedQuit;
  assert.deepEqual(navigation, ['/']);
}
// Terminal recovery reveals the launcher without offering a page-level stop
// action for a healthy running world (Minecraft owns its Save & Quit).
{
  const uiSource = await readFile(new URL('../public/auth/launcher-ui.js', import.meta.url), 'utf8');
  let releasePointer = 0, releaseFullscreen = 0;
  const context = { document: { body: { dataset: { launcherState: 'game' } },
    getElementById: () => null, addEventListener() {}, fullscreenElement: {},
    exitPointerLock() { releasePointer++; }, async exitFullscreen() { releaseFullscreen++; } },
    addEventListener() {} };
  vm.runInNewContext(uiSource, context);
  assert.equal(context.document.body.dataset.launcherState, 'game', 'Healthy runtime remains visible');
  context.mcWebRuntimeStopped();
  assert.equal(context.document.body.dataset.launcherState, undefined);
  assert.equal(releasePointer, 1); assert.equal(releaseFullscreen, 1);
}
console.log("test-game-storage: pass (reload, open-region writes, atomic rename/import, deletion, quota retry, serialization rollback, concurrent generations, tab isolation, durable quit)");
