#!/usr/bin/env node
// Generate a JNI <-> JavaScript bridge for MC-Web's @JS-annotated methods,
// plus JS -> Java downcalls for its @WasmExport-annotated methods.
//
// The MC-Web browser port reaches the browser through GraalVM Web Image's
// @JS annotation: a `native` method whose body is a JavaScript string. This
// runtime is HotSpot, which has no such mechanism, but it does have JNI — and
// Emscripten's EM_JS turns a JavaScript body into a callable wasm import. So
// each annotated method becomes a generated JNI entry point that calls a
// generated EM_JS function holding the original body, unchanged.
//
//   @JS.Coerce  -> generated automatically (plain JS over named arguments)
//   @JSRawCall  -> the body pokes at Web Image internals. Two of those
//                  internals now exist on this runtime: getExport(name)
//                  (see the @WasmExport half below) and toJavaString (a
//                  no-op: JS strings already are Java strings here). Raw
//                  bodies are therefore emitted verbatim, wrapped in a
//                  try/catch that warns — installs for transports this lane
//                  never starts must not kill the boot path. A short list of
//                  bodies that need Web Image linear-memory internals with no
//                  equivalent here stay throwing stubs.
//   @WasmExport -> JS -> Java. Under Web Image, JS calls
//                  getExport('name')(args). Here each export becomes an
//                  EMSCRIPTEN_KEEPALIVE C function that attaches the calling
//                  thread to the JVM and does the CallStatic*Method. When the
//                  bridge library is loaded (System.load, on the thread that
//                  will use it), a constructor registers every wrapper into
//                  globalThis.__mcWebExportFns through an EM_JS that captures
//                  the wasm table entry; the pre-js getExport shim resolves
//                  names through that table.
//
// Usage: node gen-jsbridge.mjs <src-root> <out.c> [<out-report.txt>]

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [, , SRC_ROOT, OUT_C, OUT_REPORT] = process.argv;
if (!SRC_ROOT || !OUT_C) {
  console.error("usage: gen-jsbridge.mjs <src-root> <out.c> [<out-report.txt>]");
  process.exit(1);
}

// ---------------------------------------------------------------- discovery

function javaFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...javaFiles(p));
    else if (e.name.endsWith(".java")) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ parsing

/** Concatenated Java string literals: "a" + "b" -> ab (escapes preserved).
 * Quoted strings are neutralised first so a ` + ` inside a literal (as in
 * JS bodies) is never mistaken for the concatenation operator. */
function joinLiterals(text) {
  const masked = text.replace(/"([^"\\]|\\.)*"/g, (lit) =>
    "\x00" + lit.slice(1, -1).replace(/\+/g, "\x01") + "\x00");
  const joined = masked.replace(/\x00\s*\+\s*\x00/g, "");
  return joined.replace(/\x00/g, '"').replace(/\x01/g, "+")
    .replace(/^"+/, "").replace(/"+$/, "").trim();
}

/** Java escapes -> the real characters, so the JS body is emitted verbatim. */
function unescapeJava(s) {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t")
    .replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
/** Split a parenthesised argument list at top-level commas, ignoring commas
 * inside quoted strings. */
function splitTop(s) {
  const out = [];
  let depth = 0, cur = "", inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === "\\") { cur += s[++i] ?? ""; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; cur += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "<" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === ">" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Read a balanced (...) starting at `open`. */
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") { depth--; if (!depth) return [text.slice(open + 1, i), i]; }
  }
  throw new Error("unbalanced at " + open);
}

function parsePackage(text) {
  return text.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? "";
}

function parseFile(path) {
  const text = readFileSync(path, "utf8");
  const pkg = parsePackage(text);
  const cls = path.split("/").pop().replace(/\.java$/, "");
  const methods = [];
  const exports = [];

  // Both spellings: the port writes @JS(...) in most files and the
  // fully-qualified @org.graalvm.webimage.api.JS(...) in a few. Matching only
  // the short one silently skipped nine seams, and a skipped seam is a native
  // method with no implementation — an UnsatisfiedLinkError the first time the
  // game needs it, which is how singleplayer world creation died.
  const jsAnn = /@(?:org\.graalvm\.webimage\.api\.)?JS\s*\(/g;
  let m;
  while ((m = jsAnn.exec(text)) !== null) {
    // Skip @JS.Coerce / @JS.Export, which are marker annotations.
    if (/\bJS\s*\.\s*\w+\s*\($/.test(text.slice(m.index, jsAnn.lastIndex))) continue;

    let inner, end;
    try { [inner, end] = balanced(text, jsAnn.lastIndex - 1); } catch { continue; }

    const fields = splitTop(inner);
    let bodyRaw = null, argNames = [];
    for (const f of fields) {
      const kv = f.match(/^(\w+)\s*=\s*([\s\S]*)$/);
      if (!kv) { bodyRaw = f; continue; }             // @JS("body")
      if (kv[1] === "value") bodyRaw = kv[2];
      else if (kv[1] === "args") argNames = [...kv[2].matchAll(/"([^"]*)"/g)].map(x => x[1]);
    }
    if (bodyRaw === null) continue;
    const body = unescapeJava(joinLiterals(bodyRaw));

    // The declaration follows the annotation block; take everything up to ';'.
    const after = text.slice(end + 1);
    const declEnd = after.indexOf(";");
    if (declEnd < 0) continue;
    const decl = after.slice(0, declEnd).replace(/@\w[\w.]*(\s*\([^)]*\))?/g, " ");
    const sig = decl.match(/([\w.<>\[\]]+)\s+(\w+)\s*\(([\s\S]*)\)\s*$/);
    if (!sig || !/\bnative\b/.test(decl)) continue;

    const isStatic = /\bstatic\b/.test(decl);
    const params = splitTop(sig[3]).filter(Boolean).map(p => {
      const bits = p.trim().replace(/\bfinal\b/, "").trim().split(/\s+/);
      return { type: bits.slice(0, -1).join(" "), name: bits[bits.length - 1] };
    });

    // The annotation's declared arg names win: the body refers to those.
    const names = argNames.length ? argNames : params.map(p => p.name);

    const before = text.slice(0, m.index);
    const annBlock = before.slice(before.lastIndexOf("\n\n"));
    methods.push({
      pkg, cls, name: sig[2], ret: sig[1], params, names, body, isStatic,
      raw: /@(?:org\.graalvm\.webimage\.api\.)?JSRawCall/.test(annBlock),
      file: path,
    });
  }

  // @WasmExport(value = "name", ...): a static Java method JS invokes through
  // getExport('name'). Params/return must be JNI-simple; arrays are not.
  const wxAnn = /@WasmExport\s*\(/g;
  while ((m = wxAnn.exec(text)) !== null) {
    let inner, end;
    try { [inner, end] = balanced(text, wxAnn.lastIndex - 1); } catch { continue; }
    const value = inner.match(/value\s*=\s*"([^"]*)"/)?.[1];
    if (!value) continue;
    const after = text.slice(end + 1);
    const declEnd = after.indexOf("{");
    if (declEnd < 0) continue;
    const decl = after.slice(0, declEnd).replace(/@\w[\w.]*(\s*\([^)]*\))?/g, " ");
    const sig = decl.match(/([\w.<>\[\]]+)\s+(\w+)\s*\(([\s\S]*)\)\s*$/);
    if (!sig || !/\bstatic\b/.test(decl)) continue;
    const params = splitTop(sig[3]).filter(Boolean).map(p => {
      const bits = p.trim().replace(/\bfinal\b/, "").trim().split(/\s+/);
      return { type: bits.slice(0, -1).join(" "), name: bits[bits.length - 1] };
    });
    exports.push({ pkg, cls, exportName: value, method: sig[2], ret: sig[1], params, file: path });
  }
  return { methods, exports };
}

// ------------------------------------------------------------------ C types

const PRIM = {
  void: { jni: "void", em: "void", pass: n => n },
  boolean: { jni: "jboolean", em: "int", pass: n => `(int)${n}` },
  byte: { jni: "jbyte", em: "int", pass: n => `(int)${n}` },
  char: { jni: "jchar", em: "int", pass: n => `(int)${n}` },
  short: { jni: "jshort", em: "int", pass: n => `(int)${n}` },
  int: { jni: "jint", em: "int", pass: n => n },
  // A JS number, not a BigInt: every long here is a handle, offset or count,
  // all far inside 2^53, and the bodies do ordinary arithmetic on them.
  long: { jni: "jlong", em: "double", pass: n => `(double)${n}` },
  float: { jni: "jfloat", em: "float", pass: n => n },
  double: { jni: "jdouble", em: "double", pass: n => n },
};

// JNI type signatures for the downcall wrappers.
const JNISIG = {
  void: "V", boolean: "Z", byte: "B", char: "C", short: "S", int: "I",
  long: "J", float: "F", double: "D",
};

function isString(t) { return t === "String" || t === "java.lang.String"; }

// byte[] parameters cross as a pointer+length pair and become a Uint8Array view
// in the EM_JS body: over wasmMemory.buffer, not HEAPU8, which a side module's
// EM_JS can see stale after growth; and the pointer unsigned (>>> 0), since
// past 2 GB of linear memory an int pointer is negative and subarray() would
// silently count it from the end. The RPC client already copies typed arrays straight into the
// SharedArrayBuffer, so an upload written this way never becomes a string:
// base64 cost an encode, a JNI string copy, a UTF8ToString, a re-encode into
// the SAB and a decode on the worker, for data that was bytes all along.
function isBytes(t) { return t === "byte[]"; }

function mangle(pkg, cls, name) {
  const esc = s => s.replace(/_/g, "_1");
  return `Java_${esc(pkg).replace(/\./g, "_")}_${esc(cls)}_${esc(name)}`;
}

// Raw bodies that need Web Image linear-memory internals (getExport('memory'),
// raw array bases) with no equivalent here. They are only reachable on the
// WasmGC-array / raw upload transports, which this runtime's queries disable;
// if one ever fires, the stub's throw names the gap.
const RAW_STAY_STUBS = new Set([
  "writeBufferWasmGc", "findByteArrayBase", "findIntArrayBase",
  "writeBufferRaw", "writeTextureRaw", "rpCommandStreamRaw",
  "rpCommandStreamWasmGc",
]);

// One EM_JS registrar per export builds the JS closure with the exact
// signature; the constructor at the end runs them where System.load runs.

// -------------------------------------------------------------- generation

const files = javaFiles(SRC_ROOT);
const parsed = files.flatMap(parseFile);

// Every native method in these sources is meant to be a browser seam. One that
// produced no bridge entry is not a warning, it is an UnsatisfiedLinkError
// waiting for whichever feature needs it — so name them all, loudly.
const bridgedNames = new Set(parsed.flatMap(p => p.methods).map(m => m.cls + "." + m.name));
const unbridged = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const cls = file.split("/").pop().replace(/\.java$/, "");
  for (const decl of text.matchAll(/\bnative\s+[\w.<>\[\]]+\s+(\w+)\s*\(/g)) {
    if (!bridgedNames.has(cls + "." + decl[1])) unbridged.push(cls + "." + decl[1]);
  }
}
const all = parsed.flatMap(p => p.methods);
const wasmExports = parsed.flatMap(p => p.exports);
const supported = [], rawported = [], stubs = [];

for (const m of all) {
  const unsupportedParam = m.params.find(p => !PRIM[p.type] && !isString(p.type) && !isBytes(p.type));
  const unsupportedRet = !PRIM[m.ret] && !isString(m.ret);
  if (m.raw && RAW_STAY_STUBS.has(m.name)) {
    m.reason = "@JSRawCall (Web Image linear-memory internals)";
    stubs.push(m);
  } else if (m.raw) {
    rawported.push(m);
  } else if (unsupportedParam || unsupportedRet) {
    m.reason = unsupportedParam ? `unsupported parameter type ${unsupportedParam.type}`
      : `unsupported return type ${m.ret}`;
    stubs.push(m);
  } else {
    supported.push(m);
  }
}

// Downcall wrappers: only exports whose signature is JNI-simple. Arrays
// (mcweb.gpu.commandWord) belong to the disabled WasmGC-array path.
const exportable = [], unexportable = [];
for (const x of wasmExports) {
  const badParam = x.params.find(p => !PRIM[p.type] && !isString(p.type));
  const badRet = !PRIM[x.ret] && !isString(x.ret);
  if (badParam || badRet) unexportable.push(x);
  else exportable.push(x);
}

const out = [];
out.push(`// GENERATED by mcweb/gen-jsbridge.mjs — do not edit.
//
// One EM_JS function per @JS method, holding the original JavaScript body, and
// one JNI entry point that marshals arguments across; plus one KEEPALIVE
// downcall wrapper per @WasmExport, registered into the JS getExport table
// when the library loads. See the generator for why this exists.
#include <emscripten.h>
#include <emscripten/console.h>
#include <jni.h>
#include <stdlib.h>
#include <string.h>

// Returned strings are allocated by stringToNewUTF8 on the JS side and freed
// here once copied into a Java String.
static jstring mcweb_take_string(JNIEnv *env, char *owned) {
  if (owned == 0) return 0;
  jstring s = (*env)->NewStringUTF(env, owned);
  free(owned);
  return s;
}

static void mcweb_throw(JNIEnv *env, const char *msg) {
  jclass c = (*env)->FindClass(env, "java/lang/UnsupportedOperationException");
  if (c != 0) (*env)->ThrowNew(env, c, msg);
}

// --------------------------------------------------------------- downcalls
//
// JS -> Java. The calling thread is a wasm pthread the JVM does not know, so
// attach it. Attach once per thread; the threads are long-lived.

static JNIEnv *mcweb_env(void) {
  static __thread JNIEnv *tls_env = 0;
  if (tls_env) return tls_env;
  JavaVM *vms[1];
  jsize n = 0;
  if (JNI_GetCreatedJavaVMs(vms, 1, &n) != JNI_OK || n < 1) return 0;
  if ((*vms[0])->GetEnv(vms[0], (void **)&tls_env, JNI_VERSION_1_8) == JNI_OK)
    return tls_env;
  tls_env = 0;
  (*vms[0])->AttachCurrentThread(vms[0], (void **)&tls_env, 0);
  return tls_env;
}

static void mcweb_check(JNIEnv *env, const char *where) {
  if (!env) return;
  if ((*env)->ExceptionCheck(env)) {
    (*env)->ExceptionDescribe(env);
    (*env)->ExceptionClear(env);
    emscripten_console_error(where);
  }
}

// One EM_JS registrar per export: capture the wrapper's wasm table entry as a
// JS closure that marshals its arguments. Runs from the constructor below, on
// the thread that System.load's the library.
EM_JS(void, mcweb_register_export, (const char *name, int ptr, int kind), {
  const fn = getWasmTableEntry(ptr);
  globalThis.__mcWebExportFns = globalThis.__mcWebExportFns || {};
  const n = UTF8ToString(name);
  // kind encodes the signature: one char per parameter (s=string pointer,
  // n=number) then ':' then the return (v=void, n=number).
  const sig = UTF8ToString ? null : null;
  void sig;
  const sigStr = (function () { return ""; })();
  void sigStr;
  globalThis.__mcWebExportFns[n] = { fn: fn, kind: kind };
});
`);

// The marshalling closures need each export's signature at JS level; emit a
// second registrar that builds the closure with the right arg handling.
out.push(`// Per-export closures, generated with their exact signatures.`);

for (const x of exportable) {
  const cName = "mcweb_x_" + x.exportName.replace(/[^A-Za-z0-9]/g, "_");
  const paramsC = x.params.map((p, i) =>
    isString(p.type) ? `const char *a${i}` : `double a${i}`);
  const jniSig = "(" + x.params.map(p => isString(p.type) ? "Ljava/lang/String;" : JNISIG[p.type]).join("") + ")"
    + (isString(x.ret) ? "Ljava/lang/String;" : JNISIG[x.ret]);

  const callArgs = x.params.map((p, i) => {
    if (isString(p.type)) return `s${i}`;
    if (p.type === "int" || p.type === "boolean" || p.type === "byte" || p.type === "char" || p.type === "short")
      return `(jint)a${i}`;
    if (p.type === "long") return `(jlong)a${i}`;
    if (p.type === "float") return `(jfloat)a${i}`;
    return `(jdouble)a${i}`;
  });
  const strings = x.params.map((p, i) => isString(p.type)
    ? `  jstring s${i} = a${i} ? (*env)->NewStringUTF(env, a${i}) : 0;` : "").filter(Boolean).join("\n");

  let invoke;
  if (x.ret === "void") {
    invoke = `  (*env)->CallStaticVoidMethod(env, c, m${callArgs.length ? ", " + callArgs.join(", ") : ""});`;
  } else if (isString(x.ret)) {
    invoke = `  jstring r = (*env)->CallStaticObjectMethod(env, c, m${callArgs.length ? ", " + callArgs.join(", ") : ""});
  const char *utf = r ? (*env)->GetStringUTFChars(env, r, 0) : 0;
  char *owned = utf ? strdup(utf) : 0;
  if (r) (*env)->ReleaseStringUTFChars(env, r, utf);
  mcweb_check(env, "${cName}");
  return owned;`;
  } else if (x.ret === "long") {
    invoke = `  jlong r = (*env)->CallStaticLongMethod(env, c, m${callArgs.length ? ", " + callArgs.join(", ") : ""});
  mcweb_check(env, "${cName}");
  return (double)r;`;
  } else if (x.ret === "int" || x.ret === "boolean" || x.ret === "byte" || x.ret === "char" || x.ret === "short") {
    invoke = `  jint r = (*env)->CallStaticIntMethod(env, c, m${callArgs.length ? ", " + callArgs.join(", ") : ""});
  mcweb_check(env, "${cName}");
  return (double)r;`;
  } else {
    invoke = `  jdouble r = (*env)->CallStaticDoubleMethod(env, c, m${callArgs.length ? ", " + callArgs.join(", ") : ""});
  mcweb_check(env, "${cName}");
  return r;`;
  }

  const retC = isString(x.ret) ? "char*" : (x.ret === "void" ? "void" : "double");
  const clsPath = (x.pkg + "." + x.cls).replace(/\./g, "/");

  out.push(`EMSCRIPTEN_KEEPALIVE ${retC} ${cName}(${paramsC.join(", ") || "void"}) {
  JNIEnv *env = mcweb_env();
  if (!env) return${x.ret === "void" ? ";" : " 0;"}
  jclass c = (*env)->FindClass(env, "${clsPath}");
  if (!c) { (*env)->ExceptionClear(env); return${x.ret === "void" ? ";" : " 0;"} }
  jmethodID m = (*env)->GetStaticMethodID(env, c, "${x.method}", "${jniSig}");
  if (!m) { (*env)->ExceptionClear(env); return${x.ret === "void" ? ";" : " 0;"} }
${strings}
${invoke}
  mcweb_check(env, "${cName}");
${x.ret === "void" ? "" : isString(x.ret) ? "" : "  return 0;\n"}
}
`);

  // The JS closure: marshal strings onto the stack, call the table entry.
  const jsParams = x.params.map((p, i) => `a${i}`);
  const marshal = [];
  const callList = [];
  x.params.forEach((p, i) => {
    if (isString(p.type)) {
      marshal.push(`    const p${i} = a${i} == null ? 0 : stringToUTF8OnStack(String(a${i}));`);
      callList.push(`p${i}`);
    } else {
      callList.push(`Number(a${i})`);
    }
  });
  const retJs = x.ret === "void" ? `fn(${callList.join(", ")});` : `const r = fn(${callList.join(", ")});`;
  const freeStr = x.params.some(p => isString(p.type));
  out.push(`EM_JS(void, mcweb_reg_${cName}, (int ptr), {
  globalThis.__mcWebExportFns = globalThis.__mcWebExportFns || {};
  const fn = getWasmTableEntry(ptr);
  globalThis.__mcWebExportFns["${x.exportName}"] = (${jsParams.join(", ")}) => {
    const sp = stackSave();
${marshal.join("\n")}
    ${retJs}
${freeStr ? "    stackRestore(sp);" : "    void sp;"}
${x.ret === "void" ? "" : x.ret === "long" || x.ret === "int" || x.ret === "boolean" || x.ret === "byte" || x.ret === "char" || x.ret === "short" ? "    return Number(r);" : x.ret === "double" || x.ret === "float" ? "    return r;" : "    return r ? UTF8ToString(r) : null;"}
  };
});
`);
}

out.push(`// Registration runs where System.load runs: the JVM worker.
__attribute__((constructor)) static void mcweb_register_exports(void) {
`);
for (const x of exportable) {
  const cName = "mcweb_x_" + x.exportName.replace(/[^A-Za-z0-9]/g, "_");
  out.push(`  mcweb_reg_${cName}((int)${cName});`);
}
out.push(`}
`);

// The pre-js getExport/toJavaString shims resolve through the export table.
// They are JavaScript, so they go to a separate file the link scripts add as
// a second --pre-js (node and browser builds share them).
const shims = `// GENERATED by mcweb/gen-jsbridge.mjs — do not edit.
if (typeof ENVIRONMENT_IS_NODE === "undefined" || !ENVIRONMENT_IS_NODE) {
  if (!globalThis.toJavaString) globalThis.toJavaString = (s) => s;
  if (!globalThis.getExport) globalThis.getExport = (n) => {
    const f = globalThis.__mcWebExportFns && globalThis.__mcWebExportFns[n];
    if (!f) throw new Error("mcweb export not bridged: " + n);
    return f;
  };
}
`;
writeFileSync(OUT_C + ".shims.js", shims);

for (const m of supported) {
  const emName = `js_${m.pkg.replace(/\./g, "_")}_${m.cls}_${m.name}`;
  const emRet = isString(m.ret) ? "char*" : PRIM[m.ret].em;
  const emParams = m.params.flatMap((p, i) =>
    isString(p.type) ? [`const char* ${m.names[i]}_utf`]
      : isBytes(p.type) ? [`int ${m.names[i]}_ptr`, `int ${m.names[i]}_len`]
      : [`${PRIM[p.type].em} ${m.names[i]}`]);

  // String arguments arrive as UTF-8 pointers and are decoded in JS.
  const decode = m.params
    .map((p, i) => isString(p.type)
      ? `  const ${m.names[i]} = ${m.names[i]}_utf ? UTF8ToString(${m.names[i]}_utf) : null;`
      : isBytes(p.type)
      ? `  const ${m.names[i]} = new Uint8Array(wasmMemory.buffer, ${m.names[i]}_ptr >>> 0, ${m.names[i]}_len);`
      : null)
    .filter(Boolean).join("\n");

  // A throw in a JS body must never unwind into the JVM: under node the host
  // stubs are noops, and a browser host error (an unknown handle during a
  // transport probe, a missing object mid-boot) would otherwise abort the
  // whole boot. Warn and continue, like the rawported bodies do.
  const bodyJs = isString(m.ret)
    ? `${decode}\n  const __r = (() => { ${m.body} })();\n  return __r == null ? 0 : stringToNewUTF8(String(__r));`
    : `${decode}\n  ${m.body}`;
  const isVoid = m.ret === "void";
  const guarded = `try {\n${bodyJs}\n} catch (mcwebErr) { console.warn("[mcwebjs] ${m.cls}.${m.name} threw: " + (mcwebErr && mcwebErr.message || mcwebErr));${isVoid ? "" : " return 0;"}}`;

  out.push(`EM_JS(${emRet}, ${emName}, (${emParams.join(", ") || "void"}), {
${guarded}
});
`);

  const jniRet = isString(m.ret) ? "jstring" : PRIM[m.ret].jni;
  const jniParams = m.params.map((p, i) =>
    `${isString(p.type) ? "jstring" : isBytes(p.type) ? "jbyteArray" : PRIM[p.type].jni} ${m.names[i]}`);
  const recv = m.isStatic ? "jclass mcweb_cls" : "jobject mcweb_this";

  const acquire = m.params.map((p, i) => isString(p.type)
    ? `  const char *${m.names[i]}_utf = ${m.names[i]} ? (*env)->GetStringUTFChars(env, ${m.names[i]}, 0) : 0;`
    : isBytes(p.type)
    // The Critical variant: HotSpot hands out the array's own storage, where
    // GetByteArrayElements mallocs and copies all of it -- and these arrays
    // are LWJGL's "native" blocks (BrowserNativeMemory), megabytes each, of
    // which an upload uses a few KB: 6% of the render thread while chunks
    // loaded. The body may block in Atomics.wait while an RPC batch drains;
    // a collection another thread asks for meanwhile waits that long (the
    // GC locker), which is short. Nothing in the body calls back into Java.
    ? `  jsize ${m.names[i]}_len = ${m.names[i]} ? (*env)->GetArrayLength(env, ${m.names[i]}) : 0;\n`
      + `  jbyte *${m.names[i]}_elems = ${m.names[i]} ? (jbyte *)(*env)->GetPrimitiveArrayCritical(env, ${m.names[i]}, 0) : 0;`
    : null).filter(Boolean).join("\n");
  const release = m.params.map((p, i) => isString(p.type)
    ? `  if (${m.names[i]}) (*env)->ReleaseStringUTFChars(env, ${m.names[i]}, ${m.names[i]}_utf);`
    : isBytes(p.type)
    ? `  if (${m.names[i]}) (*env)->ReleasePrimitiveArrayCritical(env, ${m.names[i]}, ${m.names[i]}_elems, JNI_ABORT);`
    : null).filter(Boolean).join("\n");
  const callArgs = m.params.flatMap((p, i) =>
    isString(p.type) ? [`${m.names[i]}_utf`]
      : isBytes(p.type) ? [`(int)(intptr_t)${m.names[i]}_elems`, `(int)${m.names[i]}_len`]
      : [PRIM[p.type].pass(m.names[i])]);

  const call = `${emName}(${callArgs.join(", ")})`;
  let bodyC;
  if (m.ret === "void") {
    bodyC = `${acquire ? acquire + "\n" : ""}  ${call};\n${release}`;
  } else if (isString(m.ret)) {
    bodyC = `${acquire ? acquire + "\n" : ""}  char *r = ${call};\n${release ? release + "\n" : ""}  return mcweb_take_string(env, r);`;
  } else {
    bodyC = `${acquire ? acquire + "\n" : ""}  ${PRIM[m.ret].em} r = ${call};\n${release ? release + "\n" : ""}  return (${PRIM[m.ret].jni})r;`;
  }

  out.push(`JNIEXPORT ${jniRet} JNICALL
${mangle(m.pkg, m.cls, m.name)}(JNIEnv *env, ${recv}${jniParams.length ? ", " + jniParams.join(", ") : ""}) {
  (void)env;
${bodyC}
}
`);
}

for (const m of rawported) {
  // The original body, verbatim: getExport/toJavaString now exist on this
  // runtime. Installs for transports this lane never starts reference host
  // objects that may not exist; warn instead of killing the boot path.
  const emName = `js_${m.pkg.replace(/\./g, "_")}_${m.cls}_${m.name}`;
  const emRet = isString(m.ret) ? "char*" : PRIM[m.ret].em;
  const emParams = m.params.flatMap((p, i) =>
    isString(p.type) ? [`const char* ${m.names[i]}_utf`]
      : isBytes(p.type) ? [`int ${m.names[i]}_ptr`, `int ${m.names[i]}_len`]
      : [`${PRIM[p.type].em} ${m.names[i]}`]);
  const decode = m.params
    .map((p, i) => isString(p.type)
      ? `  const ${m.names[i]} = ${m.names[i]}_utf ? UTF8ToString(${m.names[i]}_utf) : null;`
      : isBytes(p.type)
      ? `  const ${m.names[i]} = new Uint8Array(wasmMemory.buffer, ${m.names[i]}_ptr >>> 0, ${m.names[i]}_len);`
      : null)
    .filter(Boolean).join("\n");
  const bodyJs = isString(m.ret)
    ? `${decode}\n  const __r = (() => { ${m.body} })();\n  return __r == null ? 0 : stringToNewUTF8(String(__r));`
    : `${decode}\n  try { ${m.body} } catch (e) { console.warn('[mcweb-bridge] ${m.cls}.${m.name}: ' + e); }`;

  out.push(`EM_JS(${emRet}, ${emName}, (${emParams.join(", ") || "void"}), {
${bodyJs}
});
`);

  const jniRet = isString(m.ret) ? "jstring" : PRIM[m.ret].jni;
  const jniParams = m.params.map((p, i) =>
    `${isString(p.type) ? "jstring" : isBytes(p.type) ? "jbyteArray" : PRIM[p.type].jni} ${m.names[i]}`);
  const recv = m.isStatic ? "jclass mcweb_cls" : "jobject mcweb_this";
  const acquire = m.params.map((p, i) => isString(p.type)
    ? `  const char *${m.names[i]}_utf = ${m.names[i]} ? (*env)->GetStringUTFChars(env, ${m.names[i]}, 0) : 0;`
    : isBytes(p.type)
    // The Critical variant: HotSpot hands out the array's own storage, where
    // GetByteArrayElements mallocs and copies all of it -- and these arrays
    // are LWJGL's "native" blocks (BrowserNativeMemory), megabytes each, of
    // which an upload uses a few KB: 6% of the render thread while chunks
    // loaded. The body may block in Atomics.wait while an RPC batch drains;
    // a collection another thread asks for meanwhile waits that long (the
    // GC locker), which is short. Nothing in the body calls back into Java.
    ? `  jsize ${m.names[i]}_len = ${m.names[i]} ? (*env)->GetArrayLength(env, ${m.names[i]}) : 0;\n`
      + `  jbyte *${m.names[i]}_elems = ${m.names[i]} ? (jbyte *)(*env)->GetPrimitiveArrayCritical(env, ${m.names[i]}, 0) : 0;`
    : null).filter(Boolean).join("\n");
  const release = m.params.map((p, i) => isString(p.type)
    ? `  if (${m.names[i]}) (*env)->ReleaseStringUTFChars(env, ${m.names[i]}, ${m.names[i]}_utf);`
    : isBytes(p.type)
    ? `  if (${m.names[i]}) (*env)->ReleasePrimitiveArrayCritical(env, ${m.names[i]}, ${m.names[i]}_elems, JNI_ABORT);`
    : null).filter(Boolean).join("\n");
  const callArgs = m.params.flatMap((p, i) =>
    isString(p.type) ? [`${m.names[i]}_utf`]
      : isBytes(p.type) ? [`(int)(intptr_t)${m.names[i]}_elems`, `(int)${m.names[i]}_len`]
      : [PRIM[p.type].pass(m.names[i])]);
  const call = `${emName}(${callArgs.join(", ")})`;
  let bodyC;
  if (m.ret === "void") {
    bodyC = `${acquire ? acquire + "\n" : ""}  ${call};\n${release}`;
  } else if (isString(m.ret)) {
    bodyC = `${acquire ? acquire + "\n" : ""}  char *r = ${call};\n${release ? release + "\n" : ""}  return mcweb_take_string(env, r);`;
  } else {
    bodyC = `${acquire ? acquire + "\n" : ""}  ${PRIM[m.ret].em} r = ${call};\n${release ? release + "\n" : ""}  return (${PRIM[m.ret].jni})r;`;
  }
  out.push(`JNIEXPORT ${jniRet} JNICALL
${mangle(m.pkg, m.cls, m.name)}(JNIEnv *env, ${recv}${jniParams.length ? ", " + jniParams.join(", ") : ""}) {
  (void)env;
${bodyC}
}
`);
}

for (const m of stubs) {
  const jniRet = isString(m.ret) ? "jstring" : (PRIM[m.ret] ?? { jni: "jobject" }).jni;
  const jniParams = m.params.map((p, i) => {
    const t = isString(p.type) ? "jstring" : (PRIM[p.type] ?? { jobject: "jobject" }).jni ?? "jobject";
    return `${t} ${m.names[i] ?? "a" + i}`;
  });
  const recv = m.isStatic ? "jclass mcweb_cls" : "jobject mcweb_this";
  const ret = m.ret === "void" ? "" : `\n  return (${jniRet})0;`;
  out.push(`// not bridged: ${m.reason}
JNIEXPORT ${jniRet} JNICALL
${mangle(m.pkg, m.cls, m.name)}(JNIEnv *env, ${recv}${jniParams.length ? ", " + jniParams.join(", ") : ""}) {
  mcweb_throw(env, "${m.cls}.${m.name}: ${m.reason}");${ret}
}
`);
}

writeFileSync(OUT_C, out.join("\n"));

const report = [
  `bridged  : ${supported.length}`,
  `rawported: ${rawported.length}`,
  `exports  : ${exportable.length} (skipped ${unexportable.length}: ${unexportable.map(x => x.exportName).join(", ") || "none"})`,
  `stubbed  : ${stubs.length}`,
  `unbridged: ${unbridged.length}${unbridged.length ? " <-- these will throw UnsatisfiedLinkError" : ""}`,
  ``,
  ...unbridged.map(name => `  UNBRIDGED ${name}`),
  ...stubs.map(m => `  STUB ${m.pkg}.${m.cls}.${m.name} — ${m.reason}`),
].join("\n");
if (OUT_REPORT) writeFileSync(OUT_REPORT, report + "\n");
console.log(report.split("\n").slice(0, 5).join("\n"));
if (unbridged.length) {
  console.error(`gen-jsbridge: ${unbridged.length} native method(s) have no bridge: `
    + unbridged.join(", "));
}
