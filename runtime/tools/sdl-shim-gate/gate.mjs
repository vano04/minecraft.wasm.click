#!/usr/bin/env node
// SDL shim gate: proves that every org.lwjgl.sdl function Minecraft 26.3 can
// reach on the WebGPU path resolves to a member of the port's Java shims.
//
// There is no native SDL in the page. The port replaces each SDL function
// class it needs (org/lwjgl/sdl/SDLVideo, SDLEvents, ...) with a whole-class
// shim, so a member the shim lacks is a NoSuchMethodError at the first call,
// and a function class it does not replace at all would run LWJGL's static
// initializer, which binds native function addresses and throws. Struct
// classes (SDL_Event, SDL_Rect, ...) stay LWJGL's: they only touch memory.
//
// Only references that bytecode actually uses count. The in-tab massager
// retargets a call by adding a new Methodref and leaves the old entry unused
// in the constant pool, so a constant-pool scan would report redirected calls
// (SdlDebug.init, getBackendsToTry) as live.
//
// Usage:
//   node tools/sdl-shim-gate/gate.mjs --port <compiled port classes dir or jar>
//       [--minecraft build/massaged/minecraft-26.3-massaged.jar]
//       [--sdl build/wasmjvm-libraries-26.3/lwjgl-sdl-3.4.3.jar] [--verbose]
// Exit status 0 = pass, 1 = a reachable reference does not resolve.
import { existsSync } from "node:fs";
import { classFiles, parseClass } from "./classes.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const minecraftJar = option("--minecraft", "build/massaged/minecraft-26.3-massaged.jar");
const sdlJar = option("--sdl", "build/wasmjvm-libraries-26.3/lwjgl-sdl-3.4.3.jar");
const portClasses = option("--port", null);
const verbose = args.includes("--verbose");
if (!portClasses) {
  console.error("usage: tools/sdl-shim-gate/gate.mjs --port <port classes dir|jar> [--minecraft <jar>] [--sdl <jar>]");
  process.exit(2);
}
for (const path of [minecraftJar, sdlJar, portClasses]) {
  if (!existsSync(path)) {
    console.error("missing input: " + path);
    process.exit(2);
  }
}

/**
 * Classes that reference SDL but are not on the WebGPU path, and why. The
 * gate does not take these on trust: it checks below that nothing outside
 * this set reaches them, except through the listed cut points.
 */
const OFF_PATH = [
  { match: (n) => n.startsWith("com/mojang/renderpearl/backend/opengl/"),
    why: "Mojang's OpenGL backend; the port's WebGPU backend replaces it" },
  { match: (n) => n.startsWith("com/mojang/renderpearl/backend/vulkan/"),
    why: "Mojang's Vulkan backend; the port's WebGPU backend replaces it" },
  { match: (n) => n === "net/minecraft/client/main/Main" || n.startsWith("net/minecraft/client/main/Main$"),
    why: "desktop entry point; the port boots through BrowserMinecraftMain" },
  { match: (n) => n.split("$")[0] === "com/mojang/blaze3d/platform/NativeLibrariesBootstrap",
    why: "native library loader, called only from the desktop Main" },
  { match: (n) => n.split("$")[0] === "com/mojang/blaze3d/platform/SdlDebug",
    why: "SDL log upcall; the massage plan redirects its only call (RenderSystem.initBackendSystem)" },
];
/** Methods that reach off-path classes and must themselves be unreachable. */
const CUT_POINTS = [
  { owner: "net/minecraft/client/PreferredGraphicsApi", name: "getBackendsToTry",
    why: "the massage plan redirects Minecraft.<init>'s call to the port's backend list" },
];
const offPath = (name) => OFF_PATH.find((o) => o.match(name));

const SDL_PACKAGE = "org/lwjgl/sdl/";
/** Function classes: SDL + a capitalised word (SDLVideo), or SDL itself. Structs have an underscore. */
const isFunctionClass = (name) =>
  name.startsWith(SDL_PACKAGE) && /^SDL([A-Z][A-Za-z0-9]*)?$/.test(name.slice(SDL_PACKAGE.length).split("$")[0]);

const load = (path) => classFiles(path).map((f) => parseClass(f.bytes()));
const port = load(portClasses);
const shims = new Map();
for (const c of port) {
  if (isFunctionClass(c.name) && !c.name.includes("$")) {
    shims.set(c.name, new Set(c.members.map((m) => `${m.kind}:${m.name}${m.desc}`)));
  }
}
// LWJGL's struct classes are used as they are; its function classes are
// either replaced by a shim or must never load, which the checks below catch
// at the reference.
const sdlLibrary = load(sdlJar).filter((c) => !isFunctionClass(c.name));
const minecraft = load(minecraftJar);

const failures = [];
const resolved = new Map(); // "Owner.member" -> Set of referrers
const offPathRefs = new Map(); // off-path class -> count of SDL refs skipped
const callers = new Map(); // "owner.name" -> referrers (for cut points)

const check = (ref, referrer) => {
  const key = `${ref.owner.slice(SDL_PACKAGE.length)}.${ref.name}${ref.kind === "field" ? ":" : ""}${ref.desc}`;
  if (shims.has(ref.owner)) {
    if (!shims.get(ref.owner).has(`${ref.kind}:${ref.name}${ref.desc}`)) {
      failures.push(`MISSING ${key} (used by ${referrer}): the shim does not declare it`);
      return;
    }
    const from = referrer.split(/[. ]/)[0];
    if (shims.has(from)) return; // a shim's own helpers are javac's business
    if (!resolved.has(key)) resolved.set(key, new Set());
    resolved.get(key).add(from);
  } else if (isFunctionClass(ref.owner)) {
    failures.push(`UNSHIMMED ${key} (used by ${referrer}): ${ref.owner} would load LWJGL's native-binding class`);
  }
};

for (const c of [...minecraft, ...sdlLibrary, ...port]) {
  const off = offPath(c.name);
  for (const m of c.methods) {
    const where = `${c.name}.${m.name}`;
    for (const ref of m.refs) {
      const target = `${ref.owner}.${ref.name}`;
      if (!callers.has(target)) callers.set(target, new Set());
      callers.get(target).add(where);
    }
    if (off) {
      const n = m.refs.filter((r) => r.owner.startsWith(SDL_PACKAGE)).length;
      if (n) offPathRefs.set(c.name, (offPathRefs.get(c.name) || 0) + n);
      continue;
    }
    for (const ref of m.refs) check(ref, where);
    for (const name of m.classes) {
      if (isFunctionClass(name) && !shims.has(name)) {
        failures.push(`UNSHIMMED class ${name} (used by ${where})`);
      }
    }
    // Off-path classes must not be reachable from on-path code except
    // through a cut point.
    const cut = CUT_POINTS.some((p) => p.owner === c.name && p.name === m.name);
    if (!cut) {
      const reached = new Set([...m.refs.map((r) => r.owner), ...m.classes].filter((n) => offPath(n)));
      for (const n of reached) failures.push(`REACHABLE off-path ${n} from ${where} (${offPath(n).why})`);
    }
  }
  if (!off) {
    for (const ref of c.handles) check(ref, `${c.name} (method handle)`);
  }
}
for (const cut of CUT_POINTS) {
  const from = [...(callers.get(`${cut.owner}.${cut.name}`) || [])].filter((w) => !w.startsWith(cut.owner + "."));
  if (from.length) failures.push(`CUT POINT ${cut.owner}.${cut.name} is still called from ${from.join(", ")} (${cut.why})`);
}

console.log(`SDL shim gate: ${minecraftJar}, ${sdlJar}, port ${portClasses}`);
console.log(`  shims: ${[...shims.keys()].map((n) => n.slice(SDL_PACKAGE.length)).sort().join(" ")}`);
console.log(`  on-path SDL members used: ${resolved.size}, all declared by a shim unless listed below`);
if (verbose) {
  for (const [key, from] of [...resolved].sort()) console.log(`    ${key} <- ${[...from].sort().join(" ")}`);
}
const skipped = new Map();
for (const [name, n] of offPathRefs) {
  const why = offPath(name).why;
  skipped.set(why, (skipped.get(why) || 0) + n);
}
for (const [why, n] of skipped) console.log(`  off path (${n} SDL references not required): ${why}`);
for (const cut of CUT_POINTS) console.log(`  cut point ${cut.owner}.${cut.name}: no callers (${cut.why})`);
if (failures.length) {
  for (const f of [...new Set(failures)].sort()) console.log("  FAIL " + f);
  console.log(`FAIL (${new Set(failures).size})`);
  process.exit(1);
}
console.log("PASS");
