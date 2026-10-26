#!/usr/bin/env node
// Focused, offline regression gate for the OpenJDK browser-native boundary.
// No browser, network, upload, or generated game/runtime build is involved.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import {
  MIN_DYNAMIC_LIBRARY_BYTES,
  parseDylinkMetadata,
  validateDynamicLibraryBytes,
} from "./dylink-metadata.mjs";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolsDir, "../..");
const jnaJar = process.env.JNA_JAR
  ? resolve(process.env.JNA_JAR)
  : join(root, "build/mojang-cache/libraries/net/java/dev/jna/jna/5.17.0/jna-5.17.0.jar");
const JNA_RESOURCE = "com/sun/jna/linux-x86-64/libjnidispatch.so";
const JNA_LENGTH = 134447;
const JNA_JAR_SHA256 = "b3a9408e7c51e08ef0e3bfcc08f443f6ec0f6191ba8cd7c18d53d2b22e5bdbc0";
const JNA_SHA256 = "ca07953d595210082339753d9e818a1fdb40509a17a41914d9a2cb0d2df6b6af";
const SUPPORT_ENTRIES = [
  "META-INF/MANIFEST.MF",
  "dev/mcweb/graal/BrowserNativePolicy.class",
  "dev/mcweb/wasm/Boot.class",
  "oshi/SystemInfo.class",
];
// The debug loader exists only after OpenJDK/link-debug.sh; check it when present.
const GENERATED_LOADERS = ["javavm.js", "javavm-debug.js"]
  .filter((name, i) => i === 0 || existsSync(join(dirname(fileURLToPath(import.meta.url)), "../browser", name)));

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const occurrences = (text, needle) => text.split(needle).length - 1;

function expectTruncated(length) {
  const input = new Uint8Array(length);
  assert.throws(
    () => validateDynamicLibraryBytes(input),
    error => error instanceof Error
      && !(error instanceof RangeError)
      && error.message.includes(`truncated: ${length} bytes`)
      && error.message.includes(`at least ${MIN_DYNAMIC_LIBRARY_BYTES} bytes`),
    `length ${length} must fail closed with a clear truncation error`
  );
}

for (const length of [0, 1, 2, 3, 5, 23]) expectTruncated(length);
assert.equal(validateDynamicLibraryBytes(new Uint8Array(24)).byteLength, 24);

// An intact native JNA payload is ELF, not Wasm. It must be rejected for the
// format reason, not accidentally reach the short-buffer RangeError path.
const elf = new Uint8Array(134447);
elf.set([0x7f, 0x45, 0x4c, 0x46]);
assert.throws(
  () => parseDylinkMetadata(elf, "JNA ELF"),
  error => error instanceof Error
    && !(error instanceof RangeError)
    && /not a WebAssembly module.*wasm magic/.test(error.message),
  "intact ELF must be rejected as non-Wasm"
);

function leb(value) {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

function sideModuleFixture() {
  const name = Array.from(new TextEncoder().encode("dylink.0"));
  // dylink.0 subsection 1: memory/table size and alignment, all zero.
  const subsection = [1, 4, 0, 0, 0, 0];
  const payload = [...leb(name.length), ...name, ...subsection];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x00, ...leb(payload.length), ...payload,
  ]);
}

// A valid Wasm side module remains accepted by both the engine and the
// MC-Web parser mirror. The guard is a lower-bound check, not a blanket block.
const sideModule = sideModuleFixture();
assert.ok(sideModule.byteLength >= MIN_DYNAMIC_LIBRARY_BYTES);
assert.doesNotThrow(() => new WebAssembly.Module(sideModule));
const metadata = parseDylinkMetadata(sideModule, "valid side module");
assert.deepEqual(metadata.neededDynlibs, []);
assert.equal(metadata.memorySize, 0);

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function zipEntries(archive) {
  const minEocd = 22;
  const searchStart = Math.max(0, archive.length - 0xffff - minEocd);
  let eocd = -1;
  for (let offset = archive.length - minEocd; offset >= searchStart; offset--) {
    if (u32(archive, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  assert.notEqual(eocd, -1, "archive must contain a ZIP end record");

  const count = u16(archive, eocd + 10);
  const directorySize = u32(archive, eocd + 12);
  const directoryOffset = u32(archive, eocd + 16);
  const entries = new Map();
  let offset = directoryOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(u32(archive, offset), 0x02014b50, "valid central directory entry");
    const method = u16(archive, offset + 10);
    const compressedSize = u32(archive, offset + 20);
    const uncompressedSize = u32(archive, offset + 24);
    const nameLength = u16(archive, offset + 28);
    const extraLength = u16(archive, offset + 30);
    const commentLength = u16(archive, offset + 32);
    const localOffset = u32(archive, offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    assert.equal(offset - directoryOffset <= directorySize, true, "entry is inside directory");
    assert.equal(u32(archive, localOffset), 0x04034b50, "valid local entry header");
    const localNameLength = u16(archive, localOffset + 26);
    const localExtraLength = u16(archive, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    assert.equal(compressed.length, compressedSize, "compressed resource is not truncated");
    assert.equal(entries.has(name), false, `duplicate ZIP entry ${name}`);
    entries.set(name, { compressed, method, compressedSize, uncompressedSize });
  }
  assert.equal(offset, directoryOffset + directorySize, "central directory size is exact");
  return entries;
}

function compressedEntry(archive, wantedName) {
  const entry = zipEntries(archive).get(wantedName);
  if (!entry) throw new Error(`missing ZIP resource ${wantedName}`);
  return entry;
}

function extractCompressedResource(entry) {
  if (entry.method === 0) return Buffer.from(entry.compressed);
  if (entry.method === 8) return inflateRawSync(entry.compressed);
  throw new Error(`unsupported ZIP compression method ${entry.method}`);
}

assert.equal(statSync(jnaJar).isFile(), true, `missing JNA fixture: ${jnaJar}`);
const archive = readFileSync(jnaJar);
assert.equal(createHash("sha256").update(archive).digest("hex"), JNA_JAR_SHA256);
const entry = compressedEntry(archive, JNA_RESOURCE);
assert.equal(entry.method, 8, "JNA resource should exercise compressed extraction");
assert.equal(entry.compressedSize, 52040);
assert.equal(entry.uncompressedSize, JNA_LENGTH);
const extracted = extractCompressedResource(entry);
assert.equal(extracted.length, JNA_LENGTH);
assert.equal(createHash("sha256").update(extracted).digest("hex"), JNA_SHA256);

// A truncated compressed stream is a hard failure. Do not return a partially
// extracted file and do not pad it to make a downstream parser happy.
assert.throws(
  () => extractCompressedResource({ ...entry, compressed: entry.compressed.subarray(0, -1) }),
  error => error instanceof Error,
  "truncated JNA compressed resource must fail extraction"
);

// Inspect the actual OSS-only support artifact, not just its source files.
// Its content-addressed pointer and exact entry allowlist are part of the
// browser classpath boundary.
const supportPointerPath = join(root, "OpenJDK/native-policy/current.json");
assert.equal(statSync(supportPointerPath).isFile(), true,
  "missing native-policy artifact pointer; run OpenJDK/build-native-policy-support.sh");
const supportPointer = JSON.parse(readFileSync(supportPointerPath, "utf8"));
assert.equal(supportPointer.schema, 1);
assert.match(supportPointer.sha256, /^[0-9a-f]{64}$/);
assert.equal(supportPointer.name, `mcweb-native-policy-${supportPointer.sha256}.jar`);
const supportPath = join(root, "OpenJDK/native-policy/dist", supportPointer.name);
const supportArchive = readFileSync(supportPath);
assert.equal(supportArchive.length, supportPointer.bytes);
assert.equal(hash(supportArchive), supportPointer.sha256);
const supportEntries = zipEntries(supportArchive);
assert.deepEqual([...supportEntries.keys()], SUPPORT_ENTRIES, "support jar exact entry allowlist");
for (const name of supportEntries.keys()) {
  assert.doesNotMatch(name, /(^|\/)assets\//, "support jar must not contain assets");
  assert.doesNotMatch(name, /(^|\/)net\/minecraft\//,
    "support jar must not contain Minecraft classes");
}
const expectedManifest = readFileSync(join(root, "OpenJDK/native-policy/MANIFEST.MF"));
assert.deepEqual(
  extractCompressedResource(supportEntries.get("META-INF/MANIFEST.MF")), expectedManifest);
const policyClass = extractCompressedResource(
  supportEntries.get("dev/mcweb/graal/BrowserNativePolicy.class"));
const bootClass = extractCompressedResource(supportEntries.get("dev/mcweb/wasm/Boot.class"));
const oshiClass = extractCompressedResource(supportEntries.get("oshi/SystemInfo.class"));
for (const [name, bytes] of [
  ["BrowserNativePolicy", policyClass], ["Boot", bootClass], ["SystemInfo", oshiClass],
]) {
  assert.equal(bytes.subarray(0, 4).toString("hex"), "cafebabe", `${name} class magic`);
}
assert.equal(policyClass.includes(Buffer.from("jna.noclasspath")), true);
assert.equal(bootClass.includes(Buffer.from("dev/mcweb/graal/BrowserNativePolicy")), true);
assert.equal(oshiClass.includes(Buffer.from("OSHI native system inspection is unavailable")), true);

function generatedDylinkParser(source, loaderName) {
  const startMarker = "var getDylinkMetadata = binary => {";
  const endMarker = "\n  return customSection;\n};";
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${loaderName} getDylinkMetadata start`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${loaderName} getDylinkMetadata end`);
  const declaration = source.slice(start, end + endMarker.length);
  return new Function("UTF8ArrayToString", "err", "assert",
    `${declaration}\nreturn getDylinkMetadata;`)(
    (bytes, offset, length) => new TextDecoder().decode(bytes.subarray(offset, offset + length)),
    () => {},
    (condition, message) => { if (!condition) throw new Error(message || "assertion failed"); }
  );
}

// Both published loaders must contain exactly one worker gate and one dylink
// guard. Exercise the extracted production parser so the valid side-module
// smoke and short-buffer cases are not satisfied by the mirror alone.
const generatedHashes = {};
for (const loaderName of GENERATED_LOADERS) {
  const loaderPath = join(root, "OpenJDK/browser", loaderName);
  const loaderBytes = readFileSync(loaderPath);
  const loader = loaderBytes.toString("utf8");
  generatedHashes[loaderName] = hash(loaderBytes);
  const workerGate = "if (globalThis.__mcWebWorkerGate) await globalThis.__mcWebWorkerGate;";
  const guardMarker = "MCWEB PATCH: reject truncated dynamic libraries before typed-array parsing.";
  const guardCondition = `mcwebDynamicLibraryBytes < ${MIN_DYNAMIC_LIBRARY_BYTES}`;
  const typedArray = "new Uint32Array(new Uint8Array(binary.subarray(0, 24)).buffer)";
  assert.equal(occurrences(loader, workerGate), 1, `${loaderName} worker gate count`);
  assert.equal(occurrences(loader, guardMarker), 1, `${loaderName} dylink guard count`);
  assert.equal(occurrences(loader, guardCondition), 1, `${loaderName} length guard count`);
  assert.equal(occurrences(loader, typedArray), 1, `${loaderName} typed-array parser count`);
  assert.equal(loader.indexOf(guardMarker) < loader.indexOf(typedArray), true,
    `${loaderName} guard must precede typed-array parser`);
  assert.match(loader, /manifestResponse\.ok/, `${loaderName} manifest HTTP status gate`);
  assert.match(loader, /subtle\.digest\("SHA-256"/, `${loaderName} payload SHA-256 gate`);
  assert.match(loader, /partial\.move/, `${loaderName} staged OPFS publish`);

  const parser = generatedDylinkParser(loader, loaderName);
  for (const length of [0, 1, 2, 3, 5, 23]) {
    assert.throws(
      () => parser(new Uint8Array(length)),
      error => error instanceof Error && !(error instanceof RangeError)
        && error.message.includes(`truncated: ${length} bytes`),
      `${loaderName} must clearly reject ${length} bytes`
    );
  }
  assert.throws(
    () => parser(elf),
    error => error instanceof Error && !(error instanceof RangeError)
      && /wasm magic number/.test(error.message),
    `${loaderName} must reject intact ELF as non-Wasm`
  );
  const generatedMetadata = parser(sideModule);
  assert.equal(generatedMetadata.memorySize, 0);
  assert.deepEqual(generatedMetadata.neededDynlibs, []);
}

// Keep the generated-runtime patch tied to the same contract. This catches a
// future edit that updates the mirror test but silently drops the post-link
// guard that actually protects browser loads.
const patchSource = readFileSync(join(root, "OpenJDK/patch-javavm.mjs"), "utf8");
assert.match(patchSource, /getDylinkMetadata/);
assert.match(patchSource, /dynamic library is truncated/);
assert.match(patchSource, /MIN_DYNAMIC_LIBRARY_BYTES/);
assert.match(patchSource, /never pad/i);
const policySource = readFileSync(
  join(root, "src/graal/java/dev/mcweb/graal/BrowserNativePolicy.java"), "utf8"
);
for (const property of ["jna.nosys", "jna.boot.library.path", "jna.noclasspath", "jna.nounpack"]) {
  assert.match(policySource, new RegExp(`"${property.replaceAll(".", "\\.")}"`));
}
const oshiSource = readFileSync(join(root, "src/graal/java/oshi/SystemInfo.java"), "utf8");
assert.match(oshiSource, /OSHI native system inspection is unavailable/);
const preSource = readFileSync(join(root, "OpenJDK/browser/pre.js"), "utf8");
assert.match(preSource, /response\.ok/);
assert.match(preSource, /crypto\.subtle\.digest\('SHA-256'/);
assert.match(preSource, /partial\.move/);
assert.match(preSource, /createWritable\(\)\.close|writable\.close\(\)/);
// The bundle's classpath order puts the native policy first.
const builderSource = readFileSync(join(root, "tools/build-wasmjvm.mjs"), "utf8");
assert.match(builderSource, /if \(payloadManifest\.jars\[0\]\.role !== "native-policy"\) die/);

console.log(
  `native policy OK: short lengths 0,1,2,3,5,23; `
  + `ELF rejected; Wasm side module accepted; `
  + `JNA jar sha256=${JNA_JAR_SHA256.slice(0, 16)}…; `
  + `resource ${JNA_LENGTH} bytes sha256=${JNA_SHA256.slice(0, 16)}…; `
  + `support jar ${supportPointer.bytes} bytes sha256=${supportPointer.sha256}; `
  + `javavm.js sha256=${generatedHashes["javavm.js"]}; `
  + `javavm-debug.js sha256=${generatedHashes["javavm-debug.js"]}; `
  + "truncated stream rejected"
);
