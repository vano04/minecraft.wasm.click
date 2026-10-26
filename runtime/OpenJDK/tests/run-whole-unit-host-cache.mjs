/*
 * Host-only OSS synthetic compile/install/cache/resource gate.
 * It intentionally proves a same-process live registry, not OPFS/browser
 * persistence or a Zero-frame installation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  compileWholeUnit,
  parseClass,
  summarizeWholeUnitInputs,
  canonical,
  hash,
  cacheKeyFor
} from "../tools/whole-unit-compiler.mjs";
import {
  RESOURCE_LIMITS,
  createHostRegistry as createHostRegistryRaw,
  preflightInputResources,
  compileInstallOrLoad as compileInstallOrLoadRaw,
  lookupEntry as lookupEntryRaw,
  makeArtifactRecord,
  artifactRecordBytes,
  verifyArtifact,
  snapshotRegistry,
  assertNoGrowth,
  identityMutation,
  validateIdentitySchema,
  validateRecordSchema,
  parseUniqueJson,
  monotonicNs,
  sampledMemory
} from "../tools/whole-unit-host-cache.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const compilerPath = path.resolve(here, "../tools/whole-unit-compiler.mjs");
const javac = process.env.JAVAC || "/opt/homebrew/opt/openjdk@25/bin/javac";
const java = process.env.JAVA || "/opt/homebrew/opt/openjdk@25/bin/java";
const wasmDis = process.env.WASM_DIS || "wasm-dis";

function fail(message) {
  throw new Error(`REJECT ${message}`);
}

function expectReject(label, action) {
  try {
    action();
  } catch (error) {
    return String(error);
  }
  fail(`${label} was accepted`);
}

function commandVersion(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function executableIdentity(command) {
  const candidate = path.isAbsolute(command) || command.includes(path.sep)
    ? path.resolve(command)
    : (process.env.PATH || "").split(path.delimiter).map((entry) => path.join(entry, command))
      .find((entry) => { try { return fs.statSync(entry).isFile(); } catch { return false; } });
  if (!candidate) fail(`toolchain executable unavailable: ${command}`);
  const resolvedPath = fs.realpathSync(candidate);
  const bytes = fs.readFileSync(resolvedPath);
  return { requested: command, resolvedPath, sha256: hash(bytes), bytes: bytes.length };
}

function decodeResult(raw) {
  const value = BigInt.asUintN(64, BigInt(raw));
  return {
    status: Number((value >> 48n) & 0xffffn),
    bci: Number((value >> 32n) & 0xffffn),
    result: Number(BigInt.asIntN(32, value & 0xffffffffn))
  };
}

function compileOptions(sourcePath) {
  const node = executableIdentity(process.execPath);
  const javacIdentity = executableIdentity(javac);
  const javaIdentity = executableIdentity(java);
  const wasmDisIdentity = executableIdentity(wasmDis);
  return {
    sourcePath,
    compilerFlags: ["exact-opcode-verifier", "-g:none", "--release=11"],
    wasmFeatures: ["wasm32", "i32", "i64", "linear-memory"],
    gcMode: "linear-memory-handle-mvp",
    runtimeMode: "fixture-host-oracle",
    loaderIdentity: {
      kind: "host-oss-fixture-loader",
      version: "whole-unit-loader-v1",
      policySha256: hash(Buffer.from("exact-six-class-closure"))
    },
    patchStack: [{ name: "whole-unit-host-fixture-source", sha256: hash(fs.readFileSync(sourcePath)) }],
    toolchain: {
      node,
      nodeVersion: process.version,
      javac: javacIdentity,
      javacVersion: commandVersion(javac, ["--version"]),
      java: javaIdentity,
      javaVersion: commandVersion(java, ["--version"]),
      wasmDis: wasmDisIdentity,
      wasmDisVersion: commandVersion(wasmDis, ["--version"])
    }
  };
}

function fixtureStats(classDir) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.name.endsWith(".class")) files.push(filePath);
    }
  }
  visit(classDir);
  const sizes = files.map((filePath) => fs.statSync(filePath).size);
  return {
    classFiles: files.length,
    totalBytes: sizes.reduce((sum, size) => sum + size, 0),
    maxClassBytes: Math.max(...sizes),
    dependencyBytes: sizes.reduce((sum, size) => sum + size, 0)
  };
}

function runtimeImports() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  return {
    object: { env: { memory }, runtime: {
      rt_get_field: () => 0,
      rt_array_get: () => 0,
      rt_ensure_class_init: () => 0,
      rt_get_static: () => 0,
      rt_class_id: () => 1
    } }
  };
}

function firstCall(instance) {
  const result = decodeResult(instance.exports.unit_linked(7));
  if (result.status !== 0 || result.bci !== 0 || result.result !== 20) {
    fail(`first-call result ${JSON.stringify(result)}`);
  }
  return result;
}

const OWNER_IDENTITY = {
  kind: "host-runtime-owner",
  version: "whole-unit-owner-v1",
  memory: "fixture-memory-owner-1"
};

function mutateMethod(classDir, className, methodName, descriptor, mutate) {
  const filePath = path.join(classDir, `${className}.class`);
  const clazz = parseClass(filePath);
  const method = clazz.methods.find((candidate) => candidate.name === methodName
    && candidate.descriptor === descriptor);
  if (!method || !method.code || method.code.codeOffset === undefined) fail(`missing mutation anchor ${className}.${methodName}${descriptor}`);
  const bytes = Buffer.from(fs.readFileSync(filePath));
  mutate(bytes, method.code.code, method.code.codeOffset);
  fs.writeFileSync(filePath, bytes);
}

function readUleb(bytes, state) {
  let value = 0;
  let shift = 0;
  while (state.pos < bytes.length) {
    const byte = bytes[state.pos++];
    value += (byte & 0x7f) * (2 ** shift);
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
  fail("malformed Wasm ULEB");
}

function skipWasmImmediate(bytes, state, opcode) {
  const uleb = () => readUleb(bytes, state);
  const sleb = () => {
    let shift = 0;
    let value = 0;
    let byte;
    do {
      byte = bytes[state.pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  if ([0x02, 0x03, 0x04].includes(opcode)) state.pos++;
  else if ([0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24].includes(opcode)) uleb();
  else if (opcode === 0x11) { uleb(); state.pos += 2; }
  else if (opcode === 0x0e) { const count = uleb(); for (let i = 0; i < count + 1; i++) uleb(); }
  else if (opcode === 0x0f || opcode === 0x0b || opcode === 0x05 || opcode === 0x1a || opcode === 0x1b) return;
  else if (opcode === 0x10) uleb();
  else if (opcode === 0x41 || opcode === 0x42) sleb();
  else if (opcode === 0x43) state.pos += 4;
  else if (opcode === 0x44) state.pos += 8;
  else if (opcode >= 0x28 && opcode <= 0x3e) { uleb(); uleb(); }
  else if (opcode === 0x3f || opcode === 0x40) state.pos++;
  else if ((opcode >= 0x45 && opcode <= 0xc4) || opcode === 0x1a || opcode === 0x1b) return;
  else fail(`unsupported Wasm opcode 0x${opcode.toString(16)}`);
}

function parseWasmCallGraph(bytes) {
  const state = { pos: 8 };
  let importFunctionCount = 0;
  const imports = [];
  const exports = [];
  let typeCount = 0;
  const types = [];
  let definedFunctionTypes = [];
  let codeBodies = [];
  const callSites = new Map();
  const bodyOffsets = new Map();
  while (state.pos < bytes.length) {
    const sectionId = bytes[state.pos++];
    const sectionSize = readUleb(bytes, state);
    const end = state.pos + sectionSize;
    if (end > bytes.length) fail("malformed Wasm section bounds");
    if (sectionId === 1) {
      typeCount = readUleb(bytes, state);
      for (let i = 0; i < typeCount; i++) {
        if (bytes[state.pos++] !== 0x60) fail("unsupported Wasm type form");
        const params = readUleb(bytes, state); const paramTypes = Array.from(bytes.slice(state.pos, state.pos + params)); state.pos += params;
        const results = readUleb(bytes, state); const resultTypes = Array.from(bytes.slice(state.pos, state.pos + results)); state.pos += results;
        types.push({ params: paramTypes, results: resultTypes });
      }
    } else if (sectionId === 2) {
      const count = readUleb(bytes, state);
      for (let i = 0; i < count; i++) {
        const moduleLength = readUleb(bytes, state);
        const module = Buffer.from(bytes.slice(state.pos, state.pos + moduleLength)).toString("utf8"); state.pos += moduleLength;
        const nameLength = readUleb(bytes, state);
        const name = Buffer.from(bytes.slice(state.pos, state.pos + nameLength)).toString("utf8"); state.pos += nameLength;
        const kind = bytes[state.pos++];
        if (kind === 0) { imports.push({ module, name, kind, type: readUleb(bytes, state) }); importFunctionCount++; }
        else if (kind === 1) { state.pos++; readUleb(bytes, state); }
        else if (kind === 2) { const flags = readUleb(bytes, state); readUleb(bytes, state); if (flags & 1) readUleb(bytes, state); imports.push({ module, name, kind, memory: true }); }
        else if (kind === 3) { state.pos += 2; imports.push({ module, name, kind }); }
        else fail("malformed Wasm import kind");
      }
    } else if (sectionId === 3) {
      const count = readUleb(bytes, state);
      definedFunctionTypes = [];
      for (let i = 0; i < count; i++) definedFunctionTypes.push(readUleb(bytes, state));
    } else if (sectionId === 7) {
      const count = readUleb(bytes, state);
      for (let i = 0; i < count; i++) {
        const nameLength = readUleb(bytes, state);
        const name = Buffer.from(bytes.slice(state.pos, state.pos + nameLength)).toString("utf8");
        state.pos += nameLength;
        const kind = bytes[state.pos++];
        const index = readUleb(bytes, state);
        exports.push({ name, kind, index });
      }
    } else if (sectionId === 10) {
      const count = readUleb(bytes, state);
      codeBodies = [];
      for (let i = 0; i < count; i++) {
        const bodySize = readUleb(bytes, state);
        if (state.pos + bodySize > end) fail("malformed Wasm code body bounds");
        const bodyStart = state.pos;
        codeBodies.push(bytes.slice(state.pos, state.pos + bodySize));
        bodyOffsets.set(importFunctionCount + i, { start: bodyStart, end: bodyStart + bodySize });
        state.pos += bodySize;
      }
      if (state.pos !== end) fail("malformed Wasm code section size");
    }
    state.pos = end;
  }
  const bodies = new Map();
  codeBodies.forEach((body, index) => {
    const localState = { pos: 0 };
    const localCount = readUleb(body, localState);
    for (let i = 0; i < localCount; i++) { readUleb(body, localState); localState.pos++; }
    const calls = [];
    const sites = [];
    while (localState.pos < body.length) {
      const opcode = body[localState.pos++];
      if (opcode === 0x10) { const at = localState.pos - 1; const target = readUleb(body, localState); calls.push(target); sites.push({ at, target, globalAt: bodyOffsets.get(importFunctionCount + index).start + at }); }
      else if (opcode === 0x11) { readUleb(body, localState); localState.pos += 2; }
      else skipWasmImmediate(body, localState, opcode);
    }
    bodies.set(importFunctionCount + index, calls);
    callSites.set(importFunctionCount + index, sites);
  });
  const functionTypes = [...imports.filter((entry) => entry.kind === 0).map((entry) => entry.type), ...definedFunctionTypes];
  return { importFunctionCount, imports, exports, typeCount, types, definedFunctionTypes, functionTypes, bodies, callSites, bodyOffsets, functionCount: importFunctionCount + codeBodies.length };
}

function mutateActualCall(moduleBytes, actual, functionId, mode) {
  const copy = new Uint8Array(moduleBytes);
  const sites = actual.callSites.get(functionId) || [];
  if (mode === "missing" && sites[0]) copy[sites[0].globalAt] = 0x1a;
  else if (mode === "swapped" && sites[0]) copy[sites[0].globalAt + 1] = (sites[0].target + 1) & 0x7f;
  else if (mode === "extra") {
    const range = actual.bodyOffsets.get(functionId);
    if (!range) fail("missing body mutation anchor");
    for (let at = range.start; at < range.end; at++) {
      if (copy[at] === 0x41) { copy[at] = 0x10; return copy; }
    }
    fail("missing extra-edge mutation anchor");
  }
  return copy;
}

function truncateCodeSection(bytes) {
  const state = { pos: 8 };
  while (state.pos < bytes.length) {
    const sectionStart = state.pos;
    const sectionId = bytes[state.pos++];
    const sectionSize = readUleb(bytes, state);
    const end = state.pos + sectionSize;
    if (sectionId === 10) return bytes.slice(0, end - 1);
    state.pos = end;
    if (state.pos <= sectionStart) break;
  }
  fail("missing Wasm code section");
}

function expectedCallTokens(manifest) {
  const graph = manifest.directCallGraph;
  const imports = manifest.abi.imports;
  const ids = new Map(graph.bodies.map((body) => [body.id, body.functionIndex - manifest.importFunctionCount]));
  const importIds = new Map(imports.map((name, index) => [name, `fimport$${index}`]));
  return new Map(graph.bodies.map((body) => [
    body.functionIndex - manifest.importFunctionCount,
    body.calls.map((call) => call.kind === "internal" ? String(ids.get(call.target)) : importIds.get(call.target)).sort()
  ]));
}

function assertBinaryCallGraph(moduleBytes, manifest, expected = expectedCallTokens(manifest)) {
  const actual = parseWasmCallGraph(moduleBytes);
  if (actual.definedFunctionTypes.length !== actual.bodies.size) fail("binary code/function section count");
  if (actual.exports.some((entry) => entry.kind === 0 && entry.index >= actual.functionCount)) fail("binary export function bounds");
  if (actual.functionCount !== manifest.directCallGraph.bodies.length + manifest.importFunctionCount) fail("binary function count");
  const expectedExports = manifest.exportManifest.map((entry) => entry.name).sort();
  const actualExports = actual.exports.filter((entry) => entry.kind === 0).map((entry) => entry.name).sort();
  if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports)) fail("binary export manifest");
  const expectedImports = ["env.memory", ...manifest.abi.imports.map((name) => name.replace(/^runtime\./, "runtime."))].sort();
  const actualImports = actual.imports.map((entry) => `${entry.module}.${entry.name}`).sort();
  if (JSON.stringify(actualImports) !== JSON.stringify(expectedImports)) fail(`binary import manifest actual=${JSON.stringify(actualImports)}`);
  if (actual.functionTypes.some((type) => type < 0 || type >= actual.typeCount)) fail("binary function type index");
  for (const exportEntry of manifest.exportManifest) {
    const actualExport = actual.exports.find((entry) => entry.kind === 0 && entry.name === exportEntry.name);
    if (!actualExport || actual.functionTypes[actualExport.index] !== exportEntry.type) fail(`binary export type ${exportEntry.name}`);
  }
  for (const [functionId, calls] of expected) {
    const absoluteFunctionId = Number(functionId) + actual.importFunctionCount;
    const actualCalls = (actual.bodies.get(absoluteFunctionId) || []).map(String).sort();
    const expectedCalls = calls.map((call) => call.startsWith("fimport$")
      ? String(Number(call.slice("fimport$".length)))
      : String(Number(call) + actual.importFunctionCount)).sort();
    if (JSON.stringify(actualCalls) !== JSON.stringify(expectedCalls)) {
      fail(`binary call graph body $${functionId} actual=${JSON.stringify(actualCalls)} expected=${JSON.stringify(expectedCalls)}`);
    }
  }
  for (const [functionId, actualCalls] of actual.bodies) {
    const expectedCalls = expected.get(functionId - actual.importFunctionCount);
    if (!expectedCalls) fail(`binary unexpected function body ${functionId}`);
    if (JSON.stringify(actualCalls.map(String).sort()) !== JSON.stringify(expectedCalls.map((call) => call.startsWith("fimport$") ? String(Number(call.slice(8))) : String(Number(call) + actual.importFunctionCount)).sort())) fail(`binary outgoing graph body $${functionId}`);
  }
  const incoming = new Map();
  for (const [source, calls] of actual.bodies) for (const target of calls) {
    if (target >= actual.importFunctionCount) {
      const list = incoming.get(target) || []; list.push(source); incoming.set(target, list);
    }
  }
  const expectedIncoming = new Map();
  for (const [source, calls] of actual.bodies) for (const target of calls) if (target >= actual.importFunctionCount) {
    const targetKey = target - actual.importFunctionCount;
    const list = expectedIncoming.get(targetKey) || []; list.push(source - actual.importFunctionCount); expectedIncoming.set(targetKey, list);
  }
  for (const [targetId, sourceIds] of Object.entries(manifest.directCallGraph.incoming)) {
    const target = manifest.directCallGraph.bodies.find((body) => body.id === targetId).functionIndex;
    const wanted = sourceIds.map((sourceId) => manifest.directCallGraph.bodies.find((body) => body.id === sourceId).functionIndex)
      .sort((a, b) => a - b);
    const got = (incoming.get(target) || []).sort((a, b) => a - b);
    if (JSON.stringify(got) !== JSON.stringify(wanted)) fail(`binary incoming graph ${targetId}`);
  }
  for (const [targetId, sourceIds] of expectedIncoming) {
    const target = manifest.directCallGraph.bodies.find((body) => body.functionIndex - actual.importFunctionCount === targetId);
    if (!target) fail(`binary unexpected incoming target ${targetId}`);
    const wanted = sourceIds.slice().sort((a, b) => a - b);
    const got = (incoming.get(target.functionIndex) || []).map((source) => source - actual.importFunctionCount).sort((a, b) => a - b);
    if (JSON.stringify(got) !== JSON.stringify(wanted)) fail(`binary incoming exactness ${targetId}`);
  }
  return true;
}

function verifyActualGraph(moduleBytes, manifest) {
  assertBinaryCallGraph(moduleBytes, manifest, expectedCallTokens(manifest));
}

// Every registry operation in this gate is bound to the independent binary
// code-section verifier.  The library still rejects callers which omit one.
const createHostRegistry = (limits = RESOURCE_LIMITS) =>
  createHostRegistryRaw(limits, verifyActualGraph);
const compileInstallOrLoad = (args) => compileInstallOrLoadRaw({
  ...args,
  verifyGraph: args.verifyGraph || verifyActualGraph
});
const lookupEntry = (args) => lookupEntryRaw({
  ...args,
  verifyGraph: args.verifyGraph || verifyActualGraph
});

function parseWatBodies(wat) {
  const bodies = new Map();
  let current = null;
  for (const line of wat.split("\n")) {
    const functionMatch = line.match(/^\s*\(func \$(\d+)\b/);
    if (functionMatch) { current = Number(functionMatch[1]); bodies.set(current, []); continue; }
    if (!current && current !== 0) continue;
    const callMatch = line.match(/\(call \$([^\s)]+)/);
    if (callMatch) bodies.get(current).push(callMatch[1]);
  }
  return bodies;
}

function assertWatCallGraph(wat, expected) {
  const actual = parseWatBodies(wat);
  for (const [functionId, calls] of expected) {
    const got = (actual.get(functionId) || []).sort();
    if (JSON.stringify(got) !== JSON.stringify(calls)) fail(`WAT call graph body $${functionId}`);
  }
}

function mutateGraph(expected, mutate) {
  const copy = new Map([...expected].map(([key, calls]) => [key, [...calls]]));
  mutate(copy);
  return copy;
}

function childDeterminism(classDir, options) {
  const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--determinism-child", classDir,
    JSON.stringify(options)], { encoding: "utf8" }).trim();
  return JSON.parse(output);
}

if (process.argv[2] === "--determinism-child") {
  const result = compileWholeUnit(process.argv[3], JSON.parse(process.argv[4]));
  const childRecord = makeArtifactRecord(result.module, result.manifest, result.manifest.cacheIdentity);
  process.stdout.write(JSON.stringify({
    cacheKey: result.manifest.cacheKey,
    moduleBytes: result.module.length,
    moduleSha256: result.manifest.outputSha256,
    identitySha256: hash(Buffer.from(canonical(result.manifest.cacheIdentity))),
    manifestSha256: hash(Buffer.from(canonical(result.manifest))),
    recordSha256: childRecord.recordSha256,
    graphSha256: hash(Buffer.from(canonical(result.manifest.directCallGraph))),
    graphBytes: Buffer.from(canonical(result.manifest.directCallGraph)).length
  }));
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcweb-whole-unit-host-cache-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
const classes = path.join(work, "classes");
const sourcePath = path.join(here, "WholeUnitFixture.java");
fs.mkdirSync(classes);
execFileSync(javac, ["--release", "11", "-g:none", "-d", classes, sourcePath], { stdio: "ignore" });

const classFiles = fs.readdirSync(classes).filter((name) => name.endsWith(".class")).sort();
if (classFiles.length !== RESOURCE_LIMITS.maxClassFiles) fail("fixture class closure count");
const stats = summarizeWholeUnitInputs(classes);
const preflightOps = { inputPreflight: 0 };
const permissiveLimits = { ...RESOURCE_LIMITS, maxInputBytes: stats.totalBytes + 1 };
preflightInputResources(stats, permissiveLimits, preflightOps);
if (preflightOps.inputPreflight !== 1) fail("resource preflight counter");
const tooSmallLimits = { ...RESOURCE_LIMITS, maxInputBytes: stats.totalBytes - 1 };
expectReject("resource preflight", () => preflightInputResources(stats, tooSmallLimits));

const options = compileOptions(sourcePath);
const firstGenerated = compileWholeUnit(classes, options);
const identity = firstGenerated.manifest.cacheIdentity;
if (identity.identityVersion !== "whole-unit-cache-identity-v2") fail("identity schema version");
if (firstGenerated.manifest.cacheKey !== cacheKeyFor(identity)) fail("identity key mismatch");
expectReject("mandatory binary graph verifier", () => compileInstallOrLoadRaw({
  registry: createHostRegistryRaw(), identity, ownerIdentity: OWNER_IDENTITY,
  imports: {}, generate: () => firstGenerated, firstCall
}));
const secondGenerated = compileWholeUnit(classes, options);
if (firstGenerated.manifest.cacheKey !== secondGenerated.manifest.cacheKey
    || firstGenerated.module.length !== secondGenerated.module.length
    || Buffer.compare(Buffer.from(firstGenerated.module), Buffer.from(secondGenerated.module)) !== 0) {
  fail("deterministic in-process module output");
}
const childA = childDeterminism(classes, options);
const childB = childDeterminism(classes, options);
if (JSON.stringify(childA) !== JSON.stringify(childB)
    || childA.cacheKey !== firstGenerated.manifest.cacheKey
    || childA.moduleSha256 !== firstGenerated.manifest.outputSha256
    || childA.identitySha256 !== hash(Buffer.from(canonical(firstGenerated.manifest.cacheIdentity)))
    || childA.manifestSha256 !== hash(Buffer.from(canonical(firstGenerated.manifest)))
    || childA.graphSha256 !== hash(Buffer.from(canonical(firstGenerated.manifest.directCallGraph)))) {
  fail("deterministic fresh-child module identity/output");
}

const wasmPath = path.join(work, "whole-unit.wasm");
const watPath = path.join(work, "whole-unit.wat");
fs.writeFileSync(wasmPath, firstGenerated.module);
execFileSync(wasmDis, [wasmPath, "-o", watPath], { stdio: "ignore" });
const wat = fs.readFileSync(watPath, "utf8");
const expectedCalls = expectedCallTokens(firstGenerated.manifest);
const parsedWasm = parseWasmCallGraph(firstGenerated.module);
assertBinaryCallGraph(firstGenerated.module, firstGenerated.manifest, expectedCalls);
assertWatCallGraph(wat, expectedCalls);

const simpleGraph = new Map([[0, []], [1, ["0"]]]);
expectReject("binary swapped-edge graph", () => assertBinaryCallGraph(firstGenerated.module, firstGenerated.manifest,
  mutateGraph(expectedCalls, (graph) => graph.set(1, ["4"]))));
expectReject("binary missing-edge graph", () => assertBinaryCallGraph(firstGenerated.module, firstGenerated.manifest,
  mutateGraph(expectedCalls, (graph) => graph.set(1, []))));
expectReject("binary extra-edge graph", () => assertBinaryCallGraph(firstGenerated.module, firstGenerated.manifest,
  mutateGraph(expectedCalls, (graph) => graph.set(0, ["0"]))));
expectReject("malformed binary graph", () => assertBinaryCallGraph(truncateCodeSection(firstGenerated.module), firstGenerated.manifest));
expectReject("WAT swapped-edge graph", () => assertWatCallGraph("(module\n(func $0)\n(func $1 (call $4))\n)", simpleGraph));
const linkedFunctionId = firstGenerated.manifest.directCallGraph.bodies.find((body) => body.id === "unit_linked").functionIndex;
const leafFunctionId = firstGenerated.manifest.directCallGraph.bodies.find((body) => body.id === "unit_leaf").functionIndex;
expectReject("actual binary swapped call", () => assertBinaryCallGraph(mutateActualCall(firstGenerated.module, parsedWasm, linkedFunctionId, "swapped"), firstGenerated.manifest));
expectReject("actual binary missing call", () => assertBinaryCall(mutateActualCall(firstGenerated.module, parsedWasm, linkedFunctionId, "missing"), firstGenerated.manifest));
expectReject("actual binary extra call", () => assertBinaryCall(mutateActualCall(firstGenerated.module, parsedWasm, leafFunctionId, "extra"), firstGenerated.manifest));

const imports = runtimeImports();
const registry = createHostRegistry();
const coldMemoryBefore = sampledMemory();
const cold = compileInstallOrLoad({
  registry,
  identity,
  inputStats: stats,
  ownerIdentity: OWNER_IDENTITY,
  verifyGraph: verifyActualGraph,
  imports: imports.object,
  generate: () => {
    const generated = compileWholeUnit(classes, options);
    if (generated.manifest.cacheKey !== cacheKeyFor(identity)) fail("generated requested identity mismatch");
    return generated;
  },
  firstCall
});
const coldMemoryAfter = sampledMemory();
const canonicalRecordByteCount = artifactRecordBytes(cold.record);
if (cold.recordBytes !== canonicalRecordByteCount) fail("canonical artifact record byte count");
if (cold.state !== "cold" || cold.counters.parseCompileEmit !== 1
    || cold.counters.moduleConstruct !== 1 || cold.counters.instantiate !== 1
    || cold.counters.register !== 1 || cold.counters.registeredSlots !== 1
    || cold.counters.registeredBytes <= 0 || cold.counters.newCallableSlots !== 10
    || cold.counters.artifactVerify !== 1 || cold.counters.artifactValidationBytes !== firstGenerated.module.length
    || cold.counters.graphVerify !== 1 || cold.counters.inputPreflight !== 1 || cold.counters.firstCall !== 1) {
  fail("cold install counters");
}
const coldRssDelta = Math.max(0, coldMemoryAfter.sampledRssBytes - coldMemoryBefore.sampledRssBytes);
const coldHeapDelta = Math.max(0, coldMemoryAfter.sampledHeapUsedBytes - coldMemoryBefore.sampledHeapUsedBytes);
if (coldRssDelta > RESOURCE_LIMITS.maxSampledRssDeltaBytes || coldHeapDelta > RESOURCE_LIMITS.maxSampledHeapUsedDeltaBytes) {
  fail("sampled memory resource ceiling");
}

const beforeHits = snapshotRegistry(registry);
const hitMemoryBefore = sampledMemory();
const expectedSlotNames = Object.keys(cold.callableSlots).sort();
if (JSON.stringify(expectedSlotNames) !== JSON.stringify(firstGenerated.manifest.exportManifest.map((entry) => entry.name).sort())) fail("callable slot/export name set");
for (let i = 0; i < 3; i++) {
  const hit = compileInstallOrLoad({
    registry,
    identity,
    ownerIdentity: OWNER_IDENTITY,
    verifyGraph: verifyActualGraph,
    imports: imports.object,
    generate: () => fail("cache hit invoked generator"),
    firstCall
  });
  if (hit.state !== "hit" || hit.instance !== cold.instance
      || hit.callableSlots.unit_linked !== cold.callableSlots.unit_linked
      || hit.counters.parseCompileEmit !== 0 || hit.counters.moduleConstruct !== 0
      || hit.counters.instantiate !== 0 || hit.counters.register !== 0
      || hit.counters.registeredBytes !== 0 || hit.counters.registeredSlots !== 0
      || hit.counters.newCallableSlots !== 0 || hit.counters.firstCall !== 1
      || hit.counters.artifactVerify !== 1 || hit.counters.graphVerify !== 1
      || hit.counters.artifactValidationBytes !== firstGenerated.module.length) {
    fail("cache hit exact zero-work counters");
  }
  for (const slotName of expectedSlotNames) if (hit.callableSlots[slotName] !== cold.callableSlots[slotName]) fail(`callable slot identity ${slotName}`);
}
const hitMemoryAfter = sampledMemory();
assertNoGrowth(beforeHits, snapshotRegistry(registry));
const hitRssSlope = Math.max(0, hitMemoryAfter.sampledRssBytes - hitMemoryBefore.sampledRssBytes);
const hitHeapSlope = Math.max(0, hitMemoryAfter.sampledHeapUsedBytes - hitMemoryBefore.sampledHeapUsedBytes);
if (hitRssSlope > RESOURCE_LIMITS.maxSampledRssDeltaBytes
    || hitHeapSlope > RESOURCE_LIMITS.maxSampledHeapUsedDeltaBytes) fail("repeated-hit sampled memory slope proxy");

const liveEntry = registry.entries.get(cold.key);
const liveOriginal = { ...liveEntry };
const forgedModule = mutateActualCall(firstGenerated.module, parsedWasm, linkedFunctionId, "swapped");
liveEntry.moduleBytes = Buffer.from(forgedModule);
liveEntry.record = makeArtifactRecord(forgedModule, liveEntry.manifest, identity, OWNER_IDENTITY);
expectReject("forged live actual graph", () => lookupEntry({ registry, identity,
  ownerIdentity: OWNER_IDENTITY, verifyGraph: verifyActualGraph }));
if (registry.entries.get(cold.key).instance !== cold.instance) fail("forged graph lookup replaced live instance");
Object.assign(liveEntry, liveOriginal);

const mutations = [
  ["identityVersion", (x) => { x.identityVersion += "-mutated"; }],
  ["compiler.version", (x) => { x.compiler.version += "-mutated"; }],
  ["compiler.sourceSha256", (x) => { x.compiler.sourceSha256 = "0".repeat(64); }],
  ["source.fixtureSha256", (x) => { x.source.fixtureSha256 = "1".repeat(64); }],
  ["config.selectedGroup", (x) => { x.config.selectedGroup.reverse(); }],
  ["config.loader.version", (x) => { x.config.loader.version += "-mutated"; }],
  ["config.patchStack[0].name", (x) => { x.config.patchStack[0].name += "-mutated"; }],
  ["compilerFlags", (x) => { x.compilerFlags.push("mutated-flag"); }],
  ["wasmFeatures", (x) => { x.wasmFeatures.push("mutated-feature"); }],
  ["gcMode", (x) => { x.gcMode += "-mutated"; }],
  ["runtimeMode", (x) => { x.runtimeMode += "-mutated"; }],
  ["abi.version", (x) => { x.abi.version += "-mutated"; }],
  ["methods[0].codeSha256", (x) => { x.methods[0].codeSha256 = "2".repeat(64); }],
  ["methods[1].bciMap[0].opcode", (x) => { x.methods[1].bciMap[0].opcode ^= 1; }],
  ["dispatchTargets[0].tableIndex", (x) => { x.dispatchTargets[0].tableIndex = 1; }],
  ["exportManifest", (x) => { x.exportManifest.reverse(); }],
  ["directCallGraph", (x) => { x.directCallGraph.bodies[1].calls[0].target = "unit_goodValue"; delete x.directCallGraph.incoming.unit_leaf; x.directCallGraph.incoming.unit_goodValue = ["unit_linked", "unit_virtual"]; }],
  ["fieldLayout", (x) => { x.fieldLayout.fields.push("Box.mutated@4:I"); }],
  ["cardLayout", (x) => { x.cardLayout.mode = "mutated"; }],
  ["dependencies[0].classSha256", (x) => { x.dependencies[0].classSha256 = "3".repeat(64); }],
  ["forbiddenPayloadScan", (x) => { x.forbiddenPayloadScan.patterns.push("mutated"); }]
];
const mutationKeys = new Set();
for (const [label, mutate] of mutations) {
  const mutatedKey = identityMutation(identity, mutate);
  if (mutatedKey === cold.key || mutationKeys.has(mutatedKey)) fail(`identity mutation ${label}`);
  mutationKeys.add(mutatedKey);
  const mutatedIdentity = JSON.parse(JSON.stringify(identity));
  mutate(mutatedIdentity);
  expectReject(`requested identity mutation ${label}`, () => verifyArtifact(
    firstGenerated.module, firstGenerated.manifest, mutatedIdentity, cold.record));
}

function enumerateIdentityMutations(value, pathName = "root", output = []) {
  if (Array.isArray(value)) {
    if (value.length > 1) output.push([`${pathName}[order]`, (copy) => {
      const target = pathName.match(/[^.\[\]]+/g).reduce((node, part) => node[part], copy);
      target.reverse();
    }]);
    value.forEach((item, index) => enumerateIdentityMutations(item, `${pathName}[${index}]`, output));
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) enumerateIdentityMutations(item, pathName === "root" ? key : `${pathName}.${key}`, output);
    return output;
  }
  output.push([pathName, (copy) => {
    const parts = pathName.match(/[^.\[\]]+/g);
    let target = copy;
    for (let i = 0; i < parts.length - 1; i++) target = target[parts[i]];
    const key = parts[parts.length - 1];
    if (typeof target[key] === "string") target[key] += "~leaf-mutation";
    else if (typeof target[key] === "number") target[key] += 1;
    else if (typeof target[key] === "boolean") target[key] = !target[key];
    else target[key] = "leaf-mutation";
  }]);
  return output;
}
const leafMutations = enumerateIdentityMutations(identity);
for (const [label, mutate] of leafMutations) {
  const mutatedIdentity = JSON.parse(JSON.stringify(identity));
  mutate(mutatedIdentity);
  const mutatedKey = identityMutation(identity, mutate);
  if (mutatedKey === cold.key) fail(`complete identity mutation ${label}`);
  if (mutationKeys.has(mutatedKey)) continue;
  mutationKeys.add(mutatedKey);
  expectReject(`complete identity lookup ${label}`, () => verifyArtifact(
    firstGenerated.module, firstGenerated.manifest, mutatedIdentity, cold.record, RESOURCE_LIMITS, null, OWNER_IDENTITY));
}
expectReject("identity unknown field", () => validateIdentitySchema({ ...identity, unknownField: true }));
expectReject("duplicate raw JSON key", () => parseUniqueJson('{"cacheKey":1,"cacheKey":2}'));
const schemaNegatives = [
  ["compiler nested unknown", (x) => { x.compiler.unknown = true; }],
  ["config loader nested unknown", (x) => { x.config.loader.unknown = true; }],
  ["patchStack nested type", (x) => { x.patchStack[0].sha256 = 7; }],
  ["selectedGroup element type", (x) => { x.config.selectedGroup[0] = 7; }],
  ["method bci args element type", (x) => { x.methods[0].bciMap[0].args[0] = "bad"; }],
  ["dependency nested type", (x) => { x.dependencies[0].fileBytes = "bad"; }],
  ["dispatch nested type", (x) => { x.dispatchTargets[0].tableIndex = "bad"; }],
  ["export nested type", (x) => { x.exportManifest[0].type = "bad"; }],
  ["call graph nested kind", (x) => { x.directCallGraph.bodies[1].calls[0].kind = "bad"; }]
];
for (const [label, mutate] of schemaNegatives) {
  const candidate = JSON.parse(JSON.stringify(identity));
  mutate(candidate);
  expectReject(`schema ${label}`, () => validateIdentitySchema(candidate));
}
expectReject("record nested unknown", () => validateRecordSchema({ ...cold.record, nested: true }));
expectReject("record nested type", () => validateRecordSchema({ ...cold.record, outputBytes: "bad" }));

const dependencyNegative = path.join(work, "dependency-negative");
fs.cpSync(classes, dependencyNegative, { recursive: true });
mutateMethod(dependencyNegative, "WholeUnitFixture$Other", "value", "(I)I", (bytes, code, offset) => {
  const constantBci = code.indexOf(0x10);
  if (constantBci < 0 || code[constantBci + 1] !== 29) fail("dependency mutation owner/name/descriptor/BCI anchor");
  bytes[offset + constantBci + 1] = 28;
});
const dependencyGenerated = compileWholeUnit(dependencyNegative, options);
if (dependencyGenerated.manifest.cacheKey === cold.key
    || Buffer.compare(Buffer.from(dependencyGenerated.module), Buffer.from(firstGenerated.module)) !== 0
    || dependencyGenerated.manifest.cacheIdentity.dependencies.find((entry) => entry.name === "WholeUnitFixture$Other").bytecodeSha256
      === identity.dependencies.find((entry) => entry.name === "WholeUnitFixture$Other").bytecodeSha256) {
  fail("supported dependency-only mutation did not separate identity without emitted-output change");
}
const dependencyLookup = lookupEntry({ registry, identity: dependencyGenerated.manifest.cacheIdentity,
  ownerIdentity: OWNER_IDENTITY, verifyGraph: verifyActualGraph });
if (dependencyLookup.state !== "miss" || dependencyLookup.key === cold.key || dependencyLookup.entry !== null) fail("dependency-only lookup returned original entry");

let lookupMutationCount = 0;
let lookupMutationRejected = 0;
for (const mutate of [...mutations.map(([, action]) => action), ...leafMutations.map(([, action]) => action)]) {
  const candidate = JSON.parse(JSON.stringify(identity));
  mutate(candidate);
  try {
    const result = lookupEntry({ registry, identity: candidate, ownerIdentity: OWNER_IDENTITY, verifyGraph: verifyActualGraph });
    if (result.state !== "miss" || result.entry !== null || result.key === cold.key) fail("mutated identity returned original cache entry");
    lookupMutationCount++;
  } catch (error) {
    if (!String(error.message).includes("identity")) throw error;
    lookupMutationRejected++;
  }
}
const reorderedIdentity = JSON.parse(JSON.stringify(identity));
const reorderedEntries = Object.entries(reorderedIdentity).reverse();
const reorderedObject = Object.fromEntries(reorderedEntries);
const reorderedLookup = lookupEntry({ registry, identity: reorderedObject, ownerIdentity: OWNER_IDENTITY, verifyGraph: verifyActualGraph });
if (reorderedLookup.state !== "hit" || reorderedLookup.entry.instance !== cold.instance) fail("reordered object changed canonical key");
const arrayOrderIdentity = JSON.parse(JSON.stringify(identity));
arrayOrderIdentity.config.selectedGroup.reverse();
const arrayOrderLookup = lookupEntry({ registry, identity: arrayOrderIdentity, ownerIdentity: OWNER_IDENTITY, verifyGraph: verifyActualGraph });
if (arrayOrderLookup.state !== "miss" || arrayOrderLookup.key === cold.key) fail("array ordering did not change lookup key");

const truncated = firstGenerated.module.slice(0, -1);
const corrupted = new Uint8Array(firstGenerated.module);
corrupted[corrupted.length - 1] ^= 1;
const corruptRecord = { ...cold.record, outputSha256: "4".repeat(64) };
const corruptHashRecord = { ...cold.record, recordSha256: "5".repeat(64) };
const corruptManifest = { ...firstGenerated.manifest, exportManifest: [] };
expectReject("truncated artifact", () => verifyArtifact(truncated, firstGenerated.manifest, identity, cold.record));
expectReject("corrupted artifact", () => verifyArtifact(corrupted, firstGenerated.manifest, identity, cold.record));
expectReject("corrupted output record", () => verifyArtifact(firstGenerated.module, firstGenerated.manifest, identity, corruptRecord));
expectReject("corrupted record hash", () => verifyArtifact(firstGenerated.module, firstGenerated.manifest, identity, corruptHashRecord));
expectReject("corrupted manifest", () => verifyArtifact(firstGenerated.module, corruptManifest, identity, cold.record));
const mismatchedGeneratedManifest = {
  ...firstGenerated.manifest,
  cacheIdentity: { ...firstGenerated.manifest.cacheIdentity, runtimeMode: "wrong-owner-mode" }
};
const loaderRegistry = createHostRegistry();
expectReject("cold loader identity mismatch", () => compileInstallOrLoad({ registry: loaderRegistry, identity,
  ownerIdentity: OWNER_IDENTITY, imports: imports.object,
  generate: () => ({ module: firstGenerated.module, manifest: mismatchedGeneratedManifest }), firstCall }));
if (loaderRegistry.entries.size !== 0 || loaderRegistry.operations.moduleConstruct !== 0) fail("cold loader published before identity verification");

const corruptRegistry = createHostRegistry();
compileInstallOrLoad({ registry: corruptRegistry, identity, ownerIdentity: OWNER_IDENTITY,
  inputStats: stats, imports: imports.object, generate: () => compileWholeUnit(classes, options), firstCall });
corruptRegistry.entries.get(cold.key).record.outputSha256 = "c".repeat(64);
let corruptGeneratorCalls = 0;
expectReject("live corrupt reject policy", () => compileInstallOrLoad({ registry: corruptRegistry, identity,
  ownerIdentity: OWNER_IDENTITY, imports: imports.object, generate: () => { corruptGeneratorCalls++; return compileWholeUnit(classes, options); }, firstCall }));
if (corruptGeneratorCalls !== 0) fail("corrupt reject policy compiled");
const repaired = compileInstallOrLoad({ registry: corruptRegistry, identity, ownerIdentity: OWNER_IDENTITY,
  inputStats: stats, repairCorrupt: true, imports: imports.object,
  generate: () => { corruptGeneratorCalls++; return compileWholeUnit(classes, options); }, firstCall });
if (repaired.state !== "repair" || corruptGeneratorCalls !== 1 || repaired.instance === undefined
    || corruptRegistry.quarantined.size !== 1) fail(`corrupt repair publication state=${repaired.state} calls=${corruptGeneratorCalls} instance=${repaired.instance !== undefined} quarantined=${corruptRegistry.quarantined.size}`);
const atomicRegistry = createHostRegistry();
const atomicCold = compileInstallOrLoad({ registry: atomicRegistry, identity, ownerIdentity: OWNER_IDENTITY,
  inputStats: stats, imports: imports.object, generate: () => compileWholeUnit(classes, options), firstCall });
const atomicOldInstance = atomicCold.instance;
atomicRegistry.entries.get(cold.key).record.outputSha256 = "a".repeat(64);
expectReject("atomic repair injected failure", () => compileInstallOrLoad({ registry: atomicRegistry, identity,
  ownerIdentity: OWNER_IDENTITY, repairCorrupt: true, failurePhase: "instantiate", inputStats: stats,
  imports: imports.object, generate: () => compileWholeUnit(classes, options), firstCall }));
const quarantinedEntry = atomicRegistry.entries.get(cold.key);
if (!quarantinedEntry || quarantinedEntry.instance !== atomicOldInstance || quarantinedEntry.usable !== false
    || atomicRegistry.quarantined.get(cold.key) !== quarantinedEntry) fail("atomic repair lost quarantined prior entry");
const atomicRetry = compileInstallOrLoad({ registry: atomicRegistry, identity, ownerIdentity: OWNER_IDENTITY,
  repairCorrupt: true, inputStats: stats, imports: imports.object,
  generate: () => compileWholeUnit(classes, options), firstCall });
if (atomicRetry.state !== "repair" || atomicRetry.instance === atomicOldInstance
    || atomicRegistry.entries.get(cold.key).usable !== true) fail("atomic repair retry did not replace once");

const ownerRegistry = createHostRegistry();
compileInstallOrLoad({ registry: ownerRegistry, identity, ownerIdentity: OWNER_IDENTITY,
  imports: imports.object, inputStats: stats, generate: () => compileWholeUnit(classes, options), firstCall });
expectReject("different runtime/import owner", () => compileInstallOrLoad({ registry: ownerRegistry, identity,
  ownerIdentity: { ...OWNER_IDENTITY, version: "other-owner" }, imports: imports.object,
  generate: () => fail("owner mismatch compiled"), firstCall }));

const limitedCases = [
  ["module-bytes-plus-one", { ...RESOURCE_LIMITS, maxModuleBytes: firstGenerated.module.length - 1 }, () => compileWholeUnit(classes, { ...options, maxModuleBytes: firstGenerated.module.length - 1 })],
  ["record-bytes-plus-one", { ...RESOURCE_LIMITS, maxArtifactRecordBytes: 1 }, () => compileWholeUnit(classes, options)],
  ["registry-bytes-plus-one", { ...RESOURCE_LIMITS, maxRegistryBytes: firstGenerated.module.length + canonicalRecordByteCount - 1 }, () => compileWholeUnit(classes, options)],
  ["registry-slots-plus-one", { ...RESOURCE_LIMITS, maxRegistrySlots: 0 }, () => compileWholeUnit(classes, options)]
];
for (const [label, limits, generate] of limitedCases) {
  const limitedRegistry = createHostRegistry(limits);
  expectReject(`resource ${label}`, () => compileInstallOrLoad({ registry: limitedRegistry, identity,
    ownerIdentity: OWNER_IDENTITY, imports: imports.object, generate, firstCall }));
  const limitedSnapshot = snapshotRegistry(limitedRegistry);
  if (limitedSnapshot.cacheSlots !== 0 || limitedSnapshot.cacheBytes !== 0
      || limitedSnapshot.registeredSlots !== 0 || limitedSnapshot.registeredBytes !== 0) fail(`resource ${label} published`);
  if (limitedRegistry.operations.register !== 0 || limitedRegistry.operations.newCallableSlots !== 0
      || limitedRegistry.operations.registeredBytes !== 0 || limitedRegistry.operations.registeredSlots !== 0) fail(`resource ${label} bypassed operation guard`);
}

const inputLimitCases = [
  ["input-class-files", { ...RESOURCE_LIMITS, maxClassFiles: stats.classFiles - 1 }],
  ["input-single-class", { ...RESOURCE_LIMITS, maxSingleClassBytes: stats.maxClassBytes - 1 }],
  ["input-dependency-bytes", { ...RESOURCE_LIMITS, maxDependencyBytes: stats.dependencyBytes - 1 }],
  ["input-total-bytes", { ...RESOURCE_LIMITS, maxInputBytes: stats.totalBytes - 1 }]
];
let inputLimitRejected = 0;
for (const [label, limits] of inputLimitCases) {
  const inputRegistry = createHostRegistry(limits);
  expectReject(`pre-generation ${label}`, () => compileInstallOrLoad({ registry: inputRegistry,
    identity, ownerIdentity: OWNER_IDENTITY, inputStats: stats, imports: imports.object,
    generate: () => fail(`pre-generation ${label} parsed/emitted`), firstCall }));
  if (inputRegistry.operations.parseCompileEmit !== 0 || inputRegistry.operations.moduleConstruct !== 0
      || inputRegistry.operations.instantiate !== 0 || inputRegistry.operations.register !== 0
      || inputRegistry.operations.registeredBytes !== 0 || inputRegistry.operations.registeredSlots !== 0) {
    fail(`pre-generation ${label} performed work`);
  }
  inputLimitRejected++;
}

const forceRegistry = createHostRegistry();
const forceCold = compileInstallOrLoad({ registry: forceRegistry, identity, ownerIdentity: OWNER_IDENTITY,
  inputStats: stats, imports: imports.object, generate: () => compileWholeUnit(classes, options), firstCall });
const forceInstance = forceCold.instance;
expectReject("forced replacement failure preserves entry", () => compileInstallOrLoad({ registry: forceRegistry,
  identity, ownerIdentity: OWNER_IDENTITY, forceReplace: true, failurePhase: "instantiate",
  imports: imports.object, generate: () => compileWholeUnit(classes, options), firstCall }));
const afterFailedReplacement = forceRegistry.entries.get(cold.key);
if (!afterFailedReplacement || afterFailedReplacement.instance !== forceInstance
    || afterFailedReplacement.callableSlots.unit_linked !== forceCold.callableSlots.unit_linked) fail("failed replacement lost prior entry");
for (const phase of ["generation", "record", "validate", "module", "instantiate", "register"]) {
  const replacementRegistry = createHostRegistry();
  const original = compileInstallOrLoad({ registry: replacementRegistry, identity,
    ownerIdentity: OWNER_IDENTITY, imports: imports.object, generate: () => compileWholeUnit(classes, options), firstCall });
  expectReject(`forced replacement ${phase}`, () => compileInstallOrLoad({ registry: replacementRegistry, identity,
    ownerIdentity: OWNER_IDENTITY, forceReplace: true, failurePhase: phase,
    imports: imports.object, generate: () => compileWholeUnit(classes, options), firstCall }));
  const preserved = replacementRegistry.entries.get(cold.key);
  if (!preserved || preserved.instance !== original.instance
      || preserved.callableSlots.unit_linked !== original.callableSlots.unit_linked) fail(`forced replacement ${phase} changed prior entry`);
}

for (const phase of ["generation", "record", "validate", "module", "instantiate", "register"]) {
  const failedRegistry = createHostRegistry();
  expectReject(`failure injection ${phase}`, () => compileInstallOrLoad({
    registry: failedRegistry,
    identity,
    inputStats: stats,
    ownerIdentity: OWNER_IDENTITY,
    imports: imports.object,
    failurePhase: phase,
    generate: () => compileWholeUnit(classes, options),
    firstCall
  }));
  const failedSnapshot = snapshotRegistry(failedRegistry);
  if (failedSnapshot.cacheSlots !== 0 || failedSnapshot.cacheBytes !== 0
      || failedSnapshot.registeredSlots !== 0 || failedSnapshot.registeredBytes !== 0) {
    fail(`partial publication after ${phase} failure`);
  }
  const repaired = compileInstallOrLoad({
    registry: failedRegistry,
    identity,
    inputStats: stats,
    ownerIdentity: OWNER_IDENTITY,
    imports: imports.object,
    generate: () => compileWholeUnit(classes, options),
    firstCall
  });
  if (repaired.state !== "cold" || repaired.counters.parseCompileEmit !== 1 || repaired.counters.register !== 1) {
    fail(`repair after ${phase} was reported as cache hit`);
  }
}

const mutationCases = [
  ["linked iload_0 to i2l", "WholeUnitFixture", "linked", "(I)I", (bytes, code, offset) => { bytes[offset] = 0x85; }],
  ["safeDiv idiv to iadd", "WholeUnitFixture", "safeDiv", "(II)I", (bytes, code, offset) => {
    const bci = code.indexOf(0x6c); if (bci < 0) fail("safeDiv mutation anchor"); bytes[offset + bci] = 0x60;
  }],
  ["method-aware leaf mutation", "WholeUnitFixture", "leaf", "(I)I", (bytes, code, offset) => { bytes[offset] = 0x85; }],
  ["stale linked offset on leaf", "WholeUnitFixture", "leaf", "(I)I", (bytes, code, offset) => { bytes[offset + 1] = 0x85; }],
  ["same-pattern Good.value mutation", "WholeUnitFixture$Good", "value", "(I)I", (bytes, code, offset) => { bytes[offset + 1] = 0x85; }]
];
for (const [label, className, methodName, descriptor, mutate] of mutationCases) {
  const negative = path.join(work, `negative-${methodName}`);
  fs.cpSync(classes, negative, { recursive: true });
  mutateMethod(negative, className, methodName, descriptor, mutate);
  expectReject(label, () => compileWholeUnit(negative, options));
}

const report = {
  schema: "whole-unit-host-compile-install-cache-resource-v2",
  verdict: "ACCEPT M0 HOST OSS SYNTHETIC COMPILE/INSTALL/CACHE/RESOURCE",
  scope: "oss-synthetic-host-only",
  identity: {
    identityVersion: identity.identityVersion,
    cacheKey: cold.key,
    identitySha256: hash(Buffer.from(canonical(identity))),
    dependencyCount: identity.dependencies.length,
    methodCount: identity.methods.length,
    exportCount: identity.exportManifest.length
  },
  cold: { phases: cold.phases, counters: cold.counters },
  hit: {
    repeatedHitCount: 3,
    phases: { moduleCompileNs: "0", instantiateNs: "0", registerNs: "0" },
    counters: { compile: 0, instantiate: 0, register: 0, bytes: 0, slots: 0,
      verification: "nonzero-and-integrity-checked", exactInstanceReuse: true,
      exactCallableSlotReuse: true }
  },
  deterministic: { childA, childB, equal: true },
  callGraph: { binary: "exact-code-section", wat: "exact-per-function", negative: "rejected" },
  negatives: {
    identityMutations: mutations.length + leafMutations.length,
    schemaStructureNegatives: schemaNegatives.length + 2,
    corruptionCases: 5,
    methodAwareCodeCases: mutationCases.length,
    failureInjectionCases: 6,
    forcedReplacementFailureStages: 6,
    coldLoaderIdentityMismatch: "rejected-before-module-construction",
    resourceCeilingCases: inputLimitRejected + 1 + (limitedCases.length - 1),
    liveCorruptReject: "rejected-before-compile",
    liveCorruptRepair: "quarantine-rebuild-once",
    forcedReplacementFailure: "prior-instance-and-slot-preserved",
    ownerMismatch: "rejected",
    rawJsonString: "rejected-by-structured-object-API",
    graphSwapExtraMissingMalformed: "rejected-on-mutated-actual-bytes",
    dependencyOnlyMutation: "real-Other.value-byte-mutation-miss-with-identical-emitted-module"
  },
  lookup: {
    candidateCount: registry.lookupCandidates,
    uniqueKeyCount: registry.lookupKeys.size,
    completedCount: registry.lookupCompleted,
    validMutationMissCount: lookupMutationCount,
    schemaRejectedCount: lookupMutationRejected,
    exhaustiveMutationLookups: lookupMutationCount,
    schemaRejectedMutationLookups: lookupMutationRejected,
    everyMutationMissed: true
  },
  resources: {
    ceilings: RESOURCE_LIMITS,
    enforced: {
      preGenerationInput: {
        ceilings: ["maxClassFiles", "maxInputBytes", "maxSingleClassBytes", "maxDependencyBytes"],
        rejectedCases: inputLimitRejected,
        publicationCounters: { parseCompileEmit: 0, moduleConstruct: 0, instantiate: 0, register: 0, registeredBytes: 0, registeredSlots: 0 }
      },
      boundedEmission: {
        ceiling: "maxModuleBytes",
        rejectedCases: 1,
        publicationCounters: { moduleConstruct: 0, instantiate: 0, register: 0, registeredBytes: 0, registeredSlots: 0 }
      },
      prePublicationOutput: {
        ceilings: ["maxArtifactRecordBytes", "maxRegistryBytes", "maxRegistrySlots"],
        rejectedCases: limitedCases.length - 1,
        canonicalArtifactRecordBytes: canonicalRecordByteCount,
        publicationCounters: { moduleConstruct: 0, instantiate: 0, register: 0, registeredBytes: 0, registeredSlots: 0 }
      }
    },
    sampledProxies: ["cold sampled RSS/heap delta", "repeated-hit RSS/heap slope"],
    observed: {
      classFiles: stats.classFiles,
      inputBytes: stats.totalBytes,
      moduleBytes: firstGenerated.module.length,
      sampledRssDeltaBytes: coldRssDelta,
      sampledHeapUsedDeltaBytes: coldHeapDelta,
      repeatedHitRssSlopeProxyBytes: hitRssSlope,
      repeatedHitHeapSlopeProxyBytes: hitHeapSlope,
      labels: ["sampled-process-RSS", "sampled-heap-used"]
    }
  },
  output: {
    bytes: firstGenerated.module.length,
    sha256: firstGenerated.manifest.outputSha256,
    artifactRecordBytes: canonicalRecordByteCount,
    artifactRecordSha256: cold.record.recordSha256
  },
  limitations: [
    "same-process live registry only",
    "no OPFS/browser persistence",
    "no Zero-frame install",
    "no JVM GC/class-init/vtable proof",
    "sampled memory only",
    "cache is a same-process live registry; fresh child processes prove cold deterministic bytes only"
  ]
};
console.log(`WHOLE_UNIT_HOST_GATE ${JSON.stringify(report)}`);
