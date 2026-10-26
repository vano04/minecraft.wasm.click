// Strict checkpoint evidence, not a renderer/section identity or a speed gate.
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};

// Chrome canvas screenshots use non-interlaced 8-bit RGB/RGBA. Unsupported
// PNGs fail closed instead of comparing container/compression bytes.
export function fingerprintPng(png) {
  if (!Buffer.isBuffer(png) || !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw Error("not a PNG");
  let width, height, channels, ended = false, idatEnded = false;
  const parts = [];
  let offset = 8;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw Error("truncated PNG chunk");
    const size = png.readUInt32BE(offset);
    if (size > png.length - offset - 12) throw Error("truncated PNG data");
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    if (crc32(png.subarray(offset + 4, offset + 8 + size)) !== png.readUInt32BE(offset + 8 + size)) throw Error("PNG CRC mismatch");
    if (width === undefined && type !== "IHDR") throw Error("PNG missing first IHDR");
    if (type === "IHDR") {
      if (width !== undefined || size !== 13) throw Error("invalid PNG IHDR");
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!width || !height || width * height > 16_777_216 || data[8] !== 8 || !channels || data[10] || data[11] || data[12]) throw Error("unsupported PNG format/size");
    } else if (type === "IDAT") {
      if (idatEnded) throw Error("noncontiguous PNG IDAT");
      parts.push(data);
    } else if (type === "IEND") {
      if (size || !parts.length) throw Error("invalid PNG IEND");
      ended = true; offset += 12; break;
    } else {
      if (parts.length) idatEnded = true;
      if (type === "tRNS" || type === "acTL" || !(type.charCodeAt(0) & 32)) throw Error("unsupported PNG chunk " + type);
    }
    offset += 12 + size;
  }
  if (!ended || offset !== png.length) throw Error("incomplete PNG or trailing data");
  const stride = width * channels;
  const expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: expected });
  if (raw.length !== expected) throw Error("PNG scanline size mismatch");
  const rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw Error("unknown PNG filter");
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x]; const corner = x >= channels ? previous[x - channels] : 0;
      const p = left + up - corner;
      const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : a <= b && a <= c ? left : b <= c ? up : corner;
      row[x] = (row[x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4, from = x * channels;
      rgba[to] = row[from]; rgba[to + 1] = row[from + 1]; rgba[to + 2] = row[from + 2]; rgba[to + 3] = channels === 4 ? row[from + 3] : 255;
    }
    previous = row;
  }
  return { width, height, rgbaSha256: sha256(rgba) };
}

export const TERRAIN_FIELDS = ["total", "clientChunks", "visible", "nearbyVisible", "visWithMesh", "visRenderable"];
export function sceneState(terrain, gameplay, world) {
  const counters = Object.fromEntries(TERRAIN_FIELDS.map(key => [key, Number(terrain?.match(new RegExp("\\b" + key + "=(\\d+)"))?.[1] ?? NaN)]));
  const position = gameplay?.match(/gameplay-state:x=(-?[\d.]+) y=(-?[\d.]+) z=(-?[\d.]+).*? yaw=(-?[\d.]+) pitch=(-?[\d.]+).*? screen=(\S+)/);
  const pose = position ? Object.fromEntries(["x", "y", "z", "yaw", "pitch", "screen"].map((key, i) => [key, i === 5 ? position[i + 1] : Number(position[i + 1])])) : null;
  const state = world?.match(/world-state:level=(\S+) player=(\S+)/);
  return { counters, pose, world: state ? { dimension: state[1], player: state[2] } : null };
}

const equal = isDeepStrictEqual;
const queryKey = query => [...new URLSearchParams(query || "").entries()].sort(([a, b], [c, d]) => a.localeCompare(c) || b.localeCompare(d));
export function compareScenes(a, b) {
  const reasons = [];
  const reject = reason => reasons.push(reason);
  for (const [name, run] of [["a", a], ["b", b]]) {
    if (!run || run.sceneEvidence?.schema !== 1) { reject(name + ": missing scene evidence schema 1"); continue; }
    if (!run.chrome || !run.gpu || /^(none|unknown)$/.test(run.gpu)) reject(name + ": missing browser/GPU identity");
    if (!run.seed || run.server) reject(name + ": a local fixed-seed world is required");
    const queryKeys = [...new URLSearchParams(run.query || "").keys()];
    if (new Set(queryKeys).size !== queryKeys.length) reject(name + ": duplicate launch query keys");
    if (run.error || run.crashReports?.length) reject(name + ": run failed or reported a crash");
    if (!Array.isArray(run.failures) || run.failures.length) reject(name + ": missing or nonempty failure evidence");
    if (!Number.isFinite(run.sceneEvidence.measureSeconds) || !(run.sceneEvidence.measureSeconds > 0) || !Array.isArray(run.sceneEvidence.observedStateChanges)) reject(name + ": missing timed-window state evidence");
    else if (run.sceneEvidence.observedStateChanges.length) reject(name + ": reported scene state changed during measurement");
    for (const label of ["start", "end"]) {
      const scene = run.sceneEvidence[label];
      if (!scene || scene.error) { reject(name + ": missing/failed " + label + " capture"); continue; }
      if (!scene.image?.rgbaSha256?.match(/^[a-f0-9]{64}$/) || ![scene.image.width, scene.image.height].every(n => Number.isInteger(n) && n > 0)) reject(name + ": missing " + label + " decoded image");
      if (!scene.pose || !["x", "y", "z", "yaw", "pitch"].every(key => Number.isFinite(scene.pose[key])) || scene.pose.screen !== "<none>") reject(name + ": missing/non-game " + label + " pose");
      if (!scene.world || typeof scene.world.dimension !== "string" || !scene.world.dimension || scene.world.dimension === "none" || scene.world.player !== "present") reject(name + ": missing " + label + " world");
      if (!TERRAIN_FIELDS.every(key => Number.isInteger(scene.counters?.[key]) && scene.counters[key] >= 0) || !(scene.counters?.visRenderable > 0)) reject(name + ": missing/non-rendering " + label + " counters");
      if (!Number.isFinite(scene.framesBefore) || !(scene.framesAfter >= scene.framesBefore)) reject(name + ": missing " + label + " frame evidence");
      if (!equal(scene.before, { pose: scene.pose, world: scene.world, counters: scene.counters })) reject(name + ": state changed during " + label + " capture");
    }
    if (run.sceneEvidence.start && run.sceneEvidence.end) {
      for (const key of ["pose", "world", "counters"]) if (!equal(run.sceneEvidence.start[key], run.sceneEvidence.end[key])) reject(name + ": " + key + " changed across measurement");
      if (!(run.sceneEvidence.end.framesBefore > run.sceneEvidence.start.framesAfter)) reject(name + ": no rendered-frame advancement between captures");
    }
  }
  if (a && b) {
    for (const key of ["seed", "gpu", "chrome"]) if (!equal(a[key], b[key])) reject("pair: " + key + " differs");
    if (!equal(queryKey(a.query), queryKey(b.query))) reject("pair: launch query differs (review settings before comparing)");
    if (a.sceneEvidence?.measureSeconds !== b.sceneEvidence?.measureSeconds) reject("pair: measurement duration differs");
    for (const label of ["start", "end"]) {
      const x = a.sceneEvidence?.[label], y = b.sceneEvidence?.[label];
      if (x && y) for (const key of ["image", "pose", "world", "counters"]) if (!equal(x[key], y[key])) reject("pair: " + label + " " + key + " differs");
    }
  }
  return {
    schema: 1, status: reasons.length ? "inconclusive" : "matched-checkpoints", reasons,
    tolerance: { pixels: 0, pose: 0, counters: 0 }, performanceVerdict: "inconclusive",
    limits: ["Exact full-canvas pixels and reported state match only the two captured checkpoints.",
      "Counters do not identify section/mesh geometry; hidden geometry and the timed interval are unverified.",
      "Console pose/world/counters are change reports, not synchronized renderer snapshots; settings absent from reports remain unverified.",
      "No FPS delta or speed winner is accepted; render-gate and repeated alternating scene-validated trials remain required."]
  };
}
