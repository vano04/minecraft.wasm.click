#!/usr/bin/env node
// Post-link patch for browser/javavm.js: hold the JVM thread start behind
// globalThis.__mcWebWorkerGate while the worker-side WebGPU host initialises.
//
// Why this is needed at all:
//   PROXY_TO_PTHREAD puts main() on a pooled Worker. The page's callMain()
//   posts a CMD_RUN (cmd:2) message to that worker, and the loader's async
//   handleMessage() invokes the thread entry point — which runs Java
//   synchronously from inside the event handler. Once Java is running the
//   worker's event loop is blocked in wasm, so an OffscreenCanvas transferred
//   with that message and the asynchronous requestAdapter/requestDevice dance
//   MUST complete before invokeEntryPoint runs. There is no second chance.
//
//   browser/pre.js captures the OffscreenCanvas from the CMD_RUN message and
//   installs globalThis.__mcWebWorkerGate = <async init promise>. This patch
//   adds one statement to the loader's cmd:2 branch, ahead of the entry
//   point call:
//
//       if (globalThis.__mcWebWorkerGate) await globalThis.__mcWebWorkerGate;
//
//   handleMessage() is already `async`, so the await is legal. Workers that
//   never receive a canvas install no gate and pay nothing. The patch asserts
//   the exact number of sites it edits, so a toolchain upgrade that moves the
//   anchor fails the build loudly instead of silently dropping the hook.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { MIN_DYNAMIC_LIBRARY_BYTES } from "./tools/dylink-metadata.mjs";

const targetName = process.env.MCWEB_JAVAVM_FILE || "javavm.js";
if (targetName !== "javavm.js" && targetName !== "javavm-debug.js") {
  console.error(`patch-javavm.mjs: refusing unexpected output ${targetName}`);
  process.exit(1);
}
const scriptDir = dirname(fileURLToPath(import.meta.url));
const targetDir = process.env.MCWEB_JAVAVM_DIR
  ? resolve(process.env.MCWEB_JAVAVM_DIR)
  : join(scriptDir, "browser");
const file = join(targetDir, targetName);
const source = readFileSync(file, "utf8");
const occurrences = (text, needle) => text.split(needle).length - 1;

// The cmd:2 (CMD_RUN) branch, verbatim from the Emscripten 6.0.6 loader.
const anchor = `      } else if (cmd == 2) {
        assert(msgData.pthread_ptr);
        assert(wasmMemory, "CMD_RUN received before CMD_LOAD");`;

const gate = `        // MCWEB PATCH: wait for the worker-side host (pre.js) to finish
        // opening the WebGPU device before this thread runs Java.
        if (globalThis.__mcWebWorkerGate) await globalThis.__mcWebWorkerGate;`;

// Emscripten's generated getDylinkMetadata() constructs a Uint32Array over the
// first 24 bytes before checking the wasm magic. A truncated JNA resource can
// therefore throw a platform RangeError instead of a useful load failure. The
// side-module loader is generic, so guard only the minimum byte boundary and
// leave magic/section parsing and valid Wasm loading unchanged. Never pad the
// input: the bytes are the artifact being validated.
const dylinkParserAnchor = `var getDylinkMetadata = binary => {
  var offset = 0;
  var end = 0;`;
const typedArrayAnchor = "new Uint32Array(new Uint8Array(binary.subarray(0, 24)).buffer)";
const dylinkGuard = `  // MCWEB PATCH: reject truncated dynamic libraries before typed-array parsing.
  if (!(binary instanceof WebAssembly.Module)) {
    var mcwebDynamicLibraryBytes = binary && typeof binary.byteLength === "number"
      ? binary.byteLength : 0;
    if (mcwebDynamicLibraryBytes < ${MIN_DYNAMIC_LIBRARY_BYTES}) {
      throw new Error("dynamic library is truncated: " + mcwebDynamicLibraryBytes
        + " bytes; WebAssembly side modules require at least ${MIN_DYNAMIC_LIBRARY_BYTES} bytes");
    }
  }`;

const count = occurrences(source, anchor);
if (count !== 1) {
  console.error(`patch-javavm.mjs: expected 1 cmd:2 site in ${targetName}, found ${count}`);
  console.error("the Emscripten loader changed; re-anchor the gate injection");
  process.exit(1);
}
if (source.includes(gate)) {
  console.error("patch-javavm.mjs: gate already present; refusing to double-patch");
  process.exit(1);
}

const parserCount = occurrences(source, dylinkParserAnchor);
if (parserCount !== 1) {
  console.error(`patch-javavm.mjs: expected 1 getDylinkMetadata parser, found ${parserCount}`);
  console.error("the Emscripten loader changed; re-anchor the dynamic-library guard");
  process.exit(1);
}
if (source.includes(dylinkGuard)) {
  console.error("patch-javavm.mjs: dynamic-library guard already present; refusing to double-patch");
  process.exit(1);
}
const typedArrayCount = occurrences(source, typedArrayAnchor);
if (typedArrayCount !== 1) {
  console.error(`patch-javavm.mjs: expected 1 short-buffer parser site, found ${typedArrayCount}`);
  console.error("the Emscripten loader changed; review the minimum-length contract");
  process.exit(1);
}

let patched = source.replace(anchor, `${anchor}\n${gate}`);
patched = patched.replace(dylinkParserAnchor, `${dylinkParserAnchor}\n${dylinkGuard}`);
if (occurrences(patched, gate) !== 1 || occurrences(patched, dylinkGuard) !== 1
    || occurrences(patched, typedArrayAnchor) !== 1
    || patched.indexOf(dylinkGuard) > patched.indexOf(typedArrayAnchor)) {
  console.error("patch-javavm.mjs: generated loader guard-count/order verification failed");
  process.exit(1);
}
// libffi's JavaScript (ffi_call_js and friends) indexes the heap as
// HEAPU32[(ptr >> 2) + k >>> 0]: the shift is signed, so a pointer at or past
// 2 GB -- a JavaThread, a cif, an argument array, once the heap is that big --
// became a wrong index (0x80000000 read index 0xE0000000, not 0x20000000) and
// every argument a native call got was garbage: "unaligned access" and
// "memory access out of bounds" traps in whatever the native touched next.
// Emscripten's own library code is not written this way. Unsigned shifts in
// exactly these functions.
const LIBFFI_JS = ["unbox_small_structs", "ffi_call_js", "ffi_closure_alloc_js",
  "ffi_closure_free_js", "ffi_prep_closure_loc_js"];
const functionRange = (text, name) => {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = text.indexOf("{", start); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return [start, i + 1];
  }
  return null;
};
let unsigned = 0;
for (const name of LIBFFI_JS) {
  const range = functionRange(patched, name);
  if (!range) {
    console.error(`patch-javavm.mjs: libffi's ${name} not found; review the >2 GB pointer fix`);
    process.exit(1);
  }
  const body = patched.slice(range[0], range[1]).replace(/([^>])>> ([1-3])(?=[)\]])/g, (m, pre, n) => {
    unsigned++;
    return `${pre}>>> ${n}`;
  });
  if (/[^>]>> [1-3][)\]]/.test(body)) {
    console.error(`patch-javavm.mjs: a signed pointer shift is left in ${name}`);
    process.exit(1);
  }
  patched = patched.slice(0, range[0]) + body + patched.slice(range[1]);
}
if (unsigned === 0) {
  console.error("patch-javavm.mjs: no signed pointer shifts in libffi's JS; review the >2 GB pointer fix");
  process.exit(1);
}
writeFileSync(file, patched);
console.log(`patch-javavm.mjs: injected worker gate and dynamic-library guard into ${targetName}; `
  + `${unsigned} libffi pointer shifts made unsigned`);
