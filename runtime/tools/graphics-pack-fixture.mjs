// Original diagnostic artwork only. Mount into an owned fresh test profile;
// Minecraft's ordinary pack screen selects and reloads these files itself.
import {deflateSync} from "node:zlib";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {mkdir, writeFile} from "node:fs/promises";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

export const GRAPHICS_PACK_NAME = "MCWeb_Graphics_Fixture";
export const GRAPHICS_PACK_MARKER = "MC-Web texture fixture active";
export const GRAPHICS_PACK_ROOT = "/tmp/mcgame/resourcepacks/" + GRAPHICS_PACK_NAME;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}
function png(width, height, colors) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const cell = ((x >> 2) ^ (y >> 2)) & 1;
    const frame = Math.floor(y / width);
    const color = colors[(cell + frame) % colors.length];
    rows.set([...color, 255], y * (width * 4 + 1) + 1 + x * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

export function createGraphicsPackFixture() {
  const json = (value) => Buffer.from(JSON.stringify(value) + "\n");
  const files = {
    "pack.mcmeta": json({pack: {description: "MC-Web original graphics regression fixture",
      pack_format: 97, min_format: [97, 0], max_format: [97, 1]}}),
    "pack.png": png(32, 32, [[255, 0, 255], [0, 255, 255]]),
    "assets/minecraft/lang/en_us.json": json({"menu.returnToGame": GRAPHICS_PACK_MARKER}),
  };
  const colors = {
    grass_block_top: [[245, 30, 220], [20, 235, 220]],
    grass_block_side: [[240, 170, 20], [25, 75, 240]],
    dirt: [[245, 140, 20], [120, 35, 210]],
    stone: [[235, 30, 40], [30, 220, 230]],
    oak_planks: [[30, 230, 70], [35, 45, 230]],
  };
  for (const [name, palette] of Object.entries(colors))
    files[`assets/minecraft/textures/block/${name}.png`] = png(32, 32, palette);
  files["assets/minecraft/textures/block/water_still.png"] = png(32, 64, [[240, 40, 160], [20, 220, 240]]);
  files["assets/minecraft/textures/block/water_still.png.mcmeta"] = json({animation: {
    width: 32, height: 32, frametime: 2, interpolate: true}});
  return {name: GRAPHICS_PACK_NAME, marker: GRAPHICS_PACK_MARKER, root: GRAPHICS_PACK_ROOT,
    files: Object.entries(files).map(([path, bytes]) => ({path, base64: bytes.toString("base64"),
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")}))};
}

/** Mount one existing archive as a real Minecraft resource pack without copying or modifying it. */
export function createArchiveGraphicsPackFixture(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new Error("graphics acceptance pack is not a ZIP archive");
  const name = basename(path);
  return {
    name,
    marker: null,
    root: "/tmp/mcgame/resourcepacks",
    source: {path: resolve(path), url: "/__mcweb-acceptance-pack.zip", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")},
    files: [{path: name, url: "/__mcweb-acceptance-pack.zip", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")}],
  };
}

// Compose this with the coordinator's existing javavm.js route transformation.
// The published launcher already uses preRun(module) + module.FS for title
// assets. No unsupported incoming Module property or renderer substitute is used.
export function appendGraphicsPackPreRun(script, fixture = createGraphicsPackFixture()) {
  if (typeof script !== "string" || !script.includes("var createJavaVM ="))
    throw new Error("expected the released classic createJavaVM factory");
  if (script.includes("MCWEB_ORIGINAL_GRAPHICS_PACK_PRERUN")) throw new Error("fixture wrapper already installed");
  return script + `\n;/* MCWEB_ORIGINAL_GRAPHICS_PACK_PRERUN */\n(() => {
    if (typeof document === 'undefined') return;
    const original = createJavaVM;
    const fixture = ${JSON.stringify(fixture)};
    createJavaVM = async function(options) {
      const fetched = new Map();
      for (const file of fixture.files) {
        if (!file.url) continue;
        const response = await fetch(file.url, {cache: 'no-store', credentials: 'omit'});
        if (!response.ok) throw new Error('private graphics acceptance pack fetch failed: ' + response.status);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== file.bytes) throw new Error('private graphics acceptance pack size changed');
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          value => value.toString(16).padStart(2, '0')).join('');
        if (digest !== file.sha256) throw new Error('private graphics acceptance pack hash changed');
        fetched.set(file.path, bytes);
      }
      const previous = options.preRun || [];
      const hooks = Array.isArray(previous) ? previous.slice() : [previous];
      hooks.push(function(module) {
        if (!module.FS || typeof module.FS.mkdirTree !== 'function' || typeof module.FS.writeFile !== 'function')
          throw new Error('released preRun filesystem exports are missing');
        for (const file of fixture.files) {
          const target = fixture.root + '/' + file.path;
          module.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
          let bytes = fetched.get(file.path);
          if (!bytes) {
            const text = atob(file.base64);
            bytes = new Uint8Array(text.length);
            for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
          }
          module.FS.writeFile(target, bytes);
        }
        globalThis.__mcWebGraphicsFixtureModule = module;
        globalThis.__mcWebGraphicsFixtureMounted = {name: fixture.name, root: fixture.root,
          files: fixture.files.map(({path, sha256}) => ({path, sha256}))};
      });
      return original({...options, preRun: hooks});
    };
  })();\n`;
}

export async function readGraphicsPackSelection(page) {
  return page.evaluate(() => {
    const module = globalThis.__mcWebGraphicsFixtureModule;
    if (!module?.FS) throw new Error("the original graphics fixture was not mounted before boot");
    const text = module.FS.readFile("/tmp/mcgame/options.txt", {encoding: "utf8"});
    const line = text.split(/\r?\n/).find((row) => row.startsWith("resourcePacks:"));
    if (!line) throw new Error("Minecraft has not persisted its native resource-pack selection");
    const selected = JSON.parse(line.slice("resourcePacks:".length));
    if (!Array.isArray(selected) || !selected.every((value) => typeof value === "string"))
      throw new Error("invalid native resourcePacks option");
    return {selected, mounted: globalThis.__mcWebGraphicsFixtureMounted};
  });
}

export async function graphicsPipelineRevision(page) {
  const targets = [page, ...page.workers().filter((worker) => /gpu-rpc-worker\.js(?:[?#]|$)/.test(worker.url()))];
  let revision = null;
  for (const target of targets) {
    const value = await target.evaluate(() => globalThis.mcWebGpu?._shaderSourceStats?.pipelines ?? null);
    if (Number.isInteger(value)) revision = Math.max(revision ?? 0, value);
  }
  if (revision === null) throw new Error("no live GPU host exposes the real pipeline revision");
  return revision;
}

// Cold snapshots only: call outside the frame-timing window. The released host
// predates this census and must be reported unsupported, not assigned zero use.
export async function captureGraphicsResourceCensus(page) {
  const targets = [page, ...page.workers().filter((worker) => /gpu-rpc-worker\.js(?:[?#]|$)/.test(worker.url()))];
  const hosts = [];
  for (const target of targets) {
    const value = await target.evaluate(() => typeof globalThis.mcWebGpu?.resourceLifetime === "function"
      ? globalThis.mcWebGpu.resourceLifetime() : null);
    if (value) hosts.push({url: target.url(), ...value});
  }
  return {supported: hosts.length > 0, hosts};
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--out"), out = at >= 0 ? process.argv[at + 1] : null;
  if (!out) throw new Error("usage: node tools/graphics-pack-fixture.mjs --out <private-fixture-directory>");
  const fixture = createGraphicsPackFixture();
  for (const file of fixture.files) {
    const target = join(out, fixture.name, file.path);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, Buffer.from(file.base64, "base64"));
  }
  await writeFile(join(out, "fixture-manifest.json"), JSON.stringify(fixture, null, 2) + "\n");
}
