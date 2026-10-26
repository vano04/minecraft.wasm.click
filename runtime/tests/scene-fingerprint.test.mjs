import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { compareScenes, fingerprintPng, sceneState } from "../tools/scene-fingerprint.mjs";

const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
// Original synthetic pixels, not game captures or assets.
const pixels = Buffer.from([7, 20, 45, 255, 90, 32, 14, 255, 63, 75, 89, 255, 31, 41, 59, 255]);
function png(bytes = pixels, { filter = 0, level = 6, channels = 4 } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  const rows = [];
  for (let y = 0; y < 2; y++) {
    const row = Buffer.alloc(1 + 2 * channels); row[0] = filter;
    for (let x = 0; x < 2 * channels; x++) {
      const index = y * 2 * channels + x, left = x >= channels ? bytes[index - channels] : 0;
      const up = y ? bytes[index - 2 * channels] : 0, corner = y && x >= channels ? bytes[index - 3 * channels] : 0;
      const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const predictor = [0, left, up, Math.floor((left + up) / 2), a <= b && a <= c ? left : b <= c ? up : corner][filter];
      row[x + 1] = (bytes[index] - predictor) & 255;
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows), { level })), chunk("IEND", Buffer.alloc(0))]);
}
const state = () => sceneState("terrain:total=100 clientChunks=40 visible=25 nearbyVisible=3 visWithMesh=20 visRenderable=19",
  "gameplay-state:x=1.25 y=80.5 z=-2 yaw=90 pitch=0 hp=20 entities=1 target=MISS screen=<none>",
  "world-state:level=minecraft:overworld player=present");
function run() {
  const snapshot = framesBefore => ({ file: "scene.png", ...state(), before: state(), image: fingerprintPng(png()), framesBefore, framesAfter: framesBefore + 1 });
  return { seed: "20260925", chrome: "test-browser-1", gpu: "test-gpu", query: "noblur=1", failures: [],
    steadyFps: 100, sceneEvidence: { schema: 1, measureSeconds: 180, observedStateChanges: [], start: snapshot(10), end: snapshot(1000) } };
}

test("PNG fingerprint is decoded RGBA, independent of compression and all five row filters", () => {
  const expected = fingerprintPng(png());
  for (const filter of [0, 1, 2, 3, 4]) for (const level of [0, 9]) assert.deepEqual(fingerprintPng(png(pixels, { filter, level })), expected);
  const rgb = Buffer.from([...pixels].filter((_, i) => i % 4 !== 3));
  assert.deepEqual(fingerprintPng(png(rgb, { channels: 3 })), expected);
});

test("invalid/truncated PNG fails closed", () => {
  assert.throws(() => fingerprintPng(Buffer.from("not PNG")));
  assert.throws(() => fingerprintPng(png().subarray(0, -1)));
  const corrupt = Buffer.from(png()); corrupt[45] ^= 1;
  assert.throws(() => fingerprintPng(corrupt), /CRC/);
  assert.throws(() => fingerprintPng(Buffer.concat([png(), Buffer.from([0])])), /trailing/);
});

test("identical complete checkpoints are matched, while FPS remains unaccepted", () => {
  const a = run(), b = run(); b.steadyFps = 1000;
  b.query = "noblur=1";
  const verdict = compareScenes(a, b);
  assert.equal(verdict.status, "matched-checkpoints");
  assert.equal(verdict.performanceVerdict, "inconclusive");
  assert.deepEqual(verdict.reasons, []);
  assert.equal("speedup" in verdict, false);
});

test("same counts and pose cannot accept different visible geometry", () => {
  const a = run(), b = run(), other = Buffer.from(pixels); other[0]++;
  b.sceneEvidence.start.image = fingerprintPng(png(other));
  const verdict = compareScenes(a, b);
  assert.equal(verdict.status, "inconclusive");
  assert.ok(verdict.reasons.includes("pair: start image differs"));
});

test("legacy/count-only, failed capture and absent pose are inconclusive", () => {
  for (const mutate of [
    b => delete b.sceneEvidence,
    b => delete b.sceneEvidence.start.image,
    b => delete b.sceneEvidence.start.pose,
    b => { b.sceneEvidence.end.error = "screenshot failed"; },
    b => { b.failures.push("PAGEERROR failure"); },
    b => { b.error = "navigation failed"; },
  ]) { const b = run(); mutate(b); assert.equal(compareScenes(run(), b).status, "inconclusive"); }
});

test("world, camera, resolution, settings and measurement-window mismatches reject", () => {
  for (const mutate of [
    b => { b.seed = "different"; },
    b => { b.gpu = "other-gpu"; },
    b => { b.chrome = "other-browser"; },
    b => { b.query = "noblur=1&rd=4"; },
    b => { b.sceneEvidence.measureSeconds = 60; },
    b => { b.sceneEvidence.start.image.width++; },
    b => { b.sceneEvidence.start.pose.yaw++; },
    b => { b.sceneEvidence.end.world.dimension = "minecraft:the_nether"; },
    b => { b.sceneEvidence.observedStateChanges.push("counters"); },
    b => { b.sceneEvidence.end.framesBefore = 10; },
  ]) { const b = run(); mutate(b); assert.equal(compareScenes(run(), b).status, "inconclusive"); }
});

test("duplicate query keys reject instead of sorting away first-value launch semantics", () => {
  for (const query of ["mcweb_render_distance=8&mcweb_render_distance=2", "mcweb_render_distance=2&mcweb_render_distance=8", "noblur=1&noblur=1", "rd=8&%72d=2"]) {
    const a = run(), b = run(); a.query = b.query = query;
    const verdict = compareScenes(a, b);
    assert.equal(verdict.status, "inconclusive");
    assert.ok(verdict.reasons.includes("a: duplicate launch query keys"));
    assert.ok(verdict.reasons.includes("b: duplicate launch query keys"));
  }
  const a = run(), b = run();
  a.query = "mcweb_render_distance=8&mcweb_render_distance=2";
  b.query = "mcweb_render_distance=2&mcweb_render_distance=8";
  assert.notEqual(new URLSearchParams(a.query).get("mcweb_render_distance"), new URLSearchParams(b.query).get("mcweb_render_distance"));
  assert.equal(compareScenes(a, b).status, "inconclusive");
  a.query = "mcweb_render_distance=8&noblur=1"; b.query = "noblur=1&mcweb_render_distance=8";
  assert.equal(compareScenes(a, b).status, "matched-checkpoints", "unique key order remains irrelevant");
});

test("change during capture and equal cross-run counts drifting over measurement reject", () => {
  const a = run(), b = run();
  a.sceneEvidence.end.counters.visRenderable++; b.sceneEvidence.end.counters.visRenderable++;
  assert.equal(compareScenes(a, b).status, "inconclusive");
  const c = run(); c.sceneEvidence.start.before.pose.x++;
  assert.ok(compareScenes(run(), c).reasons.some(reason => reason.includes("state changed during start capture")));
});

test("CLI verifies saved PNG bytes against recorded image and never launches a browser", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcweb-scene-"));
  try {
    const a = join(dir, "a"), b = join(dir, "b"); mkdirSync(a); mkdirSync(b);
    for (const path of [a, b]) { writeFileSync(join(path, "result.json"), JSON.stringify(run())); writeFileSync(join(path, "scene.png"), png()); }
    const tool = new URL("../tools/compare-scenes.mjs", import.meta.url);
    const invoke = () => spawnSync(process.execPath, [tool.pathname, a, b], { encoding: "utf8" });
    assert.equal(invoke().status, 0);
    const other = Buffer.from(pixels); other[0]++;
    writeFileSync(join(b, "scene.png"), png(other));
    const rejected = invoke();
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stdout).status, "inconclusive");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
