import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const lifetimeSource = await readFile(
  new URL("../web/webgpu-texture-lifetime.js", import.meta.url),
  "utf8",
);

function loadApi() {
  const context = {console: {log() {}, warn() {}, error() {}}};
  context.globalThis = context;
  vm.runInNewContext(lifetimeSource, context, {filename: "webgpu-texture-lifetime.js"});
  return context.mcWebTextureLifetime;
}

function makeLifetime({recentCalls = [], rpcBatch = null} = {}) {
  const pending = [];
  const lifetime = loadApi().createTextureLifetime({
    deferDestroyTexture(texture, textureEntry) {
      pending.push({texture, textureEntry});
    },
    recentCalls: () => recentCalls,
    rpcBatch: () => rpcBatch,
  });
  return {lifetime, pending};
}

test("destroying a texture with no views queues it once", () => {
  const {lifetime, pending} = makeLifetime();
  const entry = lifetime.initializeTexture(parent());

  assert.equal(lifetime.requestDestroy(entry), true);
  assert.equal(pending.length, 1);
  assert.equal(lifetime.requestDestroy(entry), false);
  assert.equal(pending.length, 1);
  assert.equal(entry.texture.destroyCount, 0);
  flush(pending);
  assert.equal(entry.texture.destroyCount, 1);
});

function parent(hid = 1) {
  return {
    kind: "texture",
    _hid: hid,
    _label: `fixture-${hid}`,
    texture: {destroyCount: 0, destroy() { this.destroyCount++; }},
  };
}

function flush(pending) {
  for (const item of pending.splice(0)) {
    item.texture.destroy();
    item.textureEntry._gpuDestroyed = true;
  }
}

test("destroying a texture before its view defers the GPU parent", () => {
  const {lifetime, pending} = makeLifetime();
  const entry = lifetime.initializeTexture(parent());
  const view = {kind: "textureView", textureEntry: entry};
  lifetime.retainView(entry);

  assert.equal(lifetime.requestDestroy(entry), true);
  assert.equal(entry._destroyRequested, true);
  assert.equal(entry._viewRefs, 1);
  assert.equal(pending.length, 0);
  assert.equal(entry.texture.destroyCount, 0);

  lifetime.releaseView(view);
  assert.equal(pending.length, 1);
  assert.equal(entry.texture.destroyCount, 0);
  flush(pending);
  assert.equal(entry.texture.destroyCount, 1);
});

test("multiple views keep the parent alive until the final release", () => {
  const {lifetime, pending} = makeLifetime();
  const entry = lifetime.initializeTexture(parent());
  const first = {textureEntry: entry};
  const second = {textureEntry: entry};
  lifetime.retainView(entry);
  lifetime.retainView(entry);
  lifetime.requestDestroy(entry);

  lifetime.releaseView(first);
  assert.equal(entry._viewRefs, 1);
  assert.equal(pending.length, 0);
  lifetime.releaseView(second);
  assert.equal(entry._viewRefs, 0);
  assert.equal(pending.length, 1);
  lifetime.releaseView(second);
  assert.equal(pending.length, 1, "a final view release must be queued once");
});

test("a stale view is rejected deterministically and cannot be retained", () => {
  const {lifetime} = makeLifetime();
  const entry = lifetime.initializeTexture(parent(7));
  lifetime.requestDestroy(entry);
  assert.throws(
    () => lifetime.retainView(entry),
    /Cannot create texture view for destroyed texture handle 7/,
  );

  const objects = new Map([[11, {kind: "textureView", textureEntry: entry}]]);
  const get = (handle) => {
    const object = objects.get(handle);
    if (!object) throw new Error(`Unknown texture view handle ${handle}`);
    return object;
  };
  lifetime.releaseView(objects.get(11));
  objects.delete(11);
  assert.throws(() => get(11), /Unknown texture view handle 11/);
});

test("RPC-style create/view/destroy ordering preserves the placeholder view", () => {
  const {lifetime, pending} = makeLifetime();
  const objects = new Map();
  let nextHostHandle = 1;
  const placeholders = new Map();
  const createTexture = (placeholder) => {
    const entry = lifetime.initializeTexture(parent(nextHostHandle));
    const hostHandle = nextHostHandle++;
    objects.set(hostHandle, entry);
    placeholders.set(placeholder, hostHandle);
    return placeholder;
  };
  const createView = (placeholder, texturePlaceholder) => {
    const textureHandle = placeholders.get(texturePlaceholder);
    const entry = objects.get(textureHandle);
    lifetime.retainView(entry);
    const viewEntry = {kind: "textureView", textureEntry: entry};
    const hostHandle = nextHostHandle++;
    objects.set(hostHandle, viewEntry);
    placeholders.set(placeholder, hostHandle);
    return placeholder;
  };

  // This is the order emitted by the JVM Worker inside one present-bounded
  // batch. In particular, destroying the parent precedes closing its view.
  createTexture(-1);
  createView(-2, -1);
  const textureHandle = placeholders.get(-1);
  const viewHandle = placeholders.get(-2);
  lifetime.requestDestroy(objects.get(textureHandle));
  objects.delete(textureHandle);
  assert.equal(pending.length, 0);
  lifetime.releaseView(objects.get(viewHandle));
  objects.delete(viewHandle);
  assert.equal(pending.length, 1);
});

test("first texture validation evidence is bounded and captures parent plus batch", () => {
  const calls = Array.from({length: 140}, (_, i) => `call-${i}`);
  const batch = Array.from({length: 140}, (_, i) => ({
    o: "gpu", m: i === 139 ? "submit" : "rpBindTexture", r: -i, a: ["x".repeat(500)]
  }));
  const {lifetime} = makeLifetime({recentCalls: calls, rpcBatch: batch});
  const entry = lifetime.initializeTexture(parent(42));
  const view = {kind: "textureView", textureEntry: entry};
  lifetime.retainView(entry);
  lifetime.requestDestroy(entry);
  const candidate = lifetime.snapshotValidation(99, view, batch);
  assert.equal(
    lifetime.captureValidation("Buffer used in submit while destroyed", candidate),
    null,
    "unrelated destroyed-buffer validation must not be classified as a texture view error",
  );
  assert.equal(
    lifetime.captureValidation("Buffer view does not exist", candidate),
    null,
    "a non-texture view error must not be classified as a texture view error",
  );
  const first = lifetime.captureValidation("Texture view does not exist", candidate);
  const second = lifetime.captureValidation(
    "Texture view does not exist",
    lifetime.snapshotValidation(100, view, []),
  );

  assert.equal(first, second, "validation evidence is first-error only");
  assert.equal(first.viewHandle, 99);
  assert.equal(first.parent.viewRefs, 1);
  assert.equal(first.parent.pending, true);
  assert.equal(first.parent.destroyed, false);
  assert.equal(first.recentCalls.length, 80);
  assert.equal(first.batch.length, 80);
  assert.ok(first.batch.every((call) => call.a[0].length <= 120));
});

test("validation uses the submit-time view, parent, and batch snapshot", () => {
  const calls = ["before-submit"];
  const firstBatch = [{o: "gpu", m: "submit", r: -1, a: ["first"]}];
  const {lifetime} = makeLifetime({recentCalls: calls});
  const firstParent = lifetime.initializeTexture(parent(51));
  const firstView = {textureEntry: firstParent};
  lifetime.retainView(firstParent);
  lifetime.requestDestroy(firstParent);
  const candidate = lifetime.snapshotValidation(71, firstView, firstBatch);

  calls.push("later-frame");
  firstParent._viewRefs = 0;
  firstParent._gpuDestroyed = true;
  const secondParent = lifetime.initializeTexture(parent(52));
  lifetime.noteViewUse(72);

  const report = lifetime.captureValidation("TextureView is invalid", candidate);
  assert.equal(report.viewHandle, 71);
  assert.equal(report.parent.handle, 51);
  assert.equal(report.parent.viewRefs, 1);
  assert.equal(report.parent.destroyed, false);
  assert.equal(report.recentCalls.length, 1);
  assert.equal(report.recentCalls[0], "before-submit");
  assert.equal(report.batch[0].a[0], "\"first\"");
  assert.equal(secondParent._gpuDestroyed, false);
});

test("deferred destruction releases after the submitted-work fence exactly once", async () => {
  let resolveFence;
  const fence = new Promise((resolve) => { resolveFence = resolve; });
  const queue = loadApi().createDeferredDestroyQueue({
    getQueue: () => ({onSubmittedWorkDone: () => fence}),
  });
  const entry = parent(61);
  entry._gpuDestroyed = false;

  queue.deferDestroyTexture(entry.texture, entry);
  assert.equal(queue.pendingCount(), 1);
  assert.equal(queue.flush(), true);
  assert.equal(entry.texture.destroyCount, 0);
  resolveFence();
  await fence;
  await Promise.resolve();
  assert.equal(entry.texture.destroyCount, 1);
  assert.equal(entry._gpuDestroyed, true);
  assert.equal(queue.flush(), false);
  assert.equal(entry.texture.destroyCount, 1);
});

test("device-loss fence rejection releases deferred destruction after rejection", async () => {
  let rejectFence;
  const fence = new Promise((resolve, reject) => { rejectFence = reject; });
  const queue = loadApi().createDeferredDestroyQueue({
    getQueue: () => ({onSubmittedWorkDone: () => fence}),
  });
  const entry = parent(62);
  entry._gpuDestroyed = false;

  queue.deferDestroyTexture(entry.texture, entry);
  queue.flush();
  assert.equal(entry.texture.destroyCount, 0);
  rejectFence(new Error("device lost"));
  await fence.catch(() => {});
  await Promise.resolve();
  assert.equal(entry.texture.destroyCount, 1);
  assert.equal(entry._gpuDestroyed, true);
});

test("an unrelated submit cannot release resources still recorded in another encoder", async () => {
  let fences = 0;
  const queue = loadApi().createDeferredDestroyQueue({
    getQueue: () => ({onSubmittedWorkDone() { fences++; return Promise.resolve(); }}),
  });
  const entry = parent(71);
  const encoder = {encoder: {}, serial: 3};
  entry.texture._mcEnc = encoder;
  entry.texture._mcSer = encoder.serial;
  queue.deferDestroyTexture(entry.texture, entry);
  assert.equal(queue.flush(), false);
  assert.equal(queue.pendingCount(), 1);
  assert.equal(queue.fencedCount(), 0);
  assert.equal(fences, 0);
  assert.equal(entry.texture.destroyCount, 0);
  encoder.serial++;
  assert.equal(queue.flush(), true);
  assert.equal(queue.pendingCount(), 0);
  assert.equal(queue.fencedCount(), 1);
  assert.equal(fences, 1);
  await Promise.resolve();
  assert.equal(queue.fencedCount(), 0);
  assert.equal(entry.texture.destroyCount, 1);
});

test("a newer submitted encoder does not hide an older recorded resource use", async () => {
  const queue = loadApi().createDeferredDestroyQueue({
    getQueue: () => ({onSubmittedWorkDone: () => Promise.resolve()}),
  });
  const entry = parent(72);
  const older = {encoder: {}, serial: 1}, newer = {encoder: {}, serial: 2};
  entry.texture._mcPending = new Map([[older, older.serial]]);
  entry.texture._mcEnc = newer;
  entry.texture._mcSer = newer.serial;
  queue.deferDestroyTexture(entry.texture, entry);
  newer.serial++;
  newer.encoder = null;
  assert.equal(queue.flush(), false);
  assert.equal(entry.texture.destroyCount, 0);
  older.serial++;
  older.encoder = null;
  assert.equal(queue.flush(), true);
  await Promise.resolve();
  assert.equal(entry.texture.destroyCount, 1);
});
