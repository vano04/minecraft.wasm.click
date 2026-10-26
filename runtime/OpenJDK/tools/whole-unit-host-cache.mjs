/*
 * Host-only install/cache/resource harness for the OSS whole-unit fixture.
 * This is deliberately a same-process registry: a hit reuses its exact
 * WebAssembly.Instance and never pretends to be OPFS or a browser cache.
 */

import crypto from "node:crypto";

import { canonical, hash, cacheKeyFor } from "./whole-unit-compiler.mjs";

export const HOST_CACHE_SCHEMA = "whole-unit-host-cache-v2";
export const RESOURCE_LIMITS = Object.freeze({
  maxClassFiles: 6,
  maxInputBytes: 1024 * 1024,
  maxSingleClassBytes: 256 * 1024,
  maxDependencyBytes: 1024 * 1024,
  maxModuleBytes: 128 * 1024,
  maxArtifactRecordBytes: 256 * 1024,
  maxRegistrySlots: 1,
  maxRegistryBytes: 512 * 1024,
  maxSampledRssDeltaBytes: 128 * 1024 * 1024,
  maxSampledHeapUsedDeltaBytes: 64 * 1024 * 1024
});

export function monotonicNs() {
  return process.hrtime.bigint();
}

export function sampledMemory() {
  const usage = process.memoryUsage();
  return { sampledRssBytes: usage.rss, sampledHeapUsedBytes: usage.heapUsed };
}

const IDENTITY_KEYS = new Set([
  "identityVersion", "compiler", "source", "config", "compilerFlags",
  "wasmFeatures", "gcMode", "runtimeMode", "toolchain", "abi", "group",
  "methods", "dispatchTargets", "loader", "patchStack", "exportManifest",
  "directCallGraph", "fieldLayout", "cardLayout", "dependencies",
  "forbiddenPayloadScan"
]);

function reject(message, code = "REJECT") {
  const error = new Error(`${code} ${message}`);
  error.code = code;
  throw error;
}

function knownObject(value, path, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(`identity ${path} must be an object`);
  for (const key of Object.keys(value)) if (!keys.has(key)) reject(`identity unknown field ${path}.${key}`);
}

function knownArray(value, path) {
  if (!Array.isArray(value)) reject(`identity ${path} must be an array`);
}

function stringField(value, path) {
  if (typeof value !== "string") reject(`identity ${path} must be a string`);
}

function integerField(value, path) {
  if (!Number.isSafeInteger(value)) reject(`identity ${path} must be an integer`);
}

function nullableIntegerField(value, path) {
  if (value !== null) integerField(value, path);
}

function stringArray(value, path) {
  knownArray(value, path);
  value.forEach((item, index) => stringField(item, `${path}[${index}]`));
}

function integerArray(value, path) {
  knownArray(value, path);
  value.forEach((item, index) => integerField(item, `${path}[${index}]`));
}

export function validateIdentitySchema(identity) {
  if (typeof identity === "string") reject("raw JSON strings are not accepted");
  knownObject(identity, "root", IDENTITY_KEYS);
  for (const key of ["compiler", "source", "config", "toolchain", "abi", "loader", "fieldLayout", "cardLayout", "forbiddenPayloadScan"]) {
    if (identity[key] === undefined) reject(`identity missing field ${key}`);
  }
  knownObject(identity.compiler, "compiler", new Set(["version", "sourceSha256"]));
  stringField(identity.identityVersion, "identityVersion");
  stringField(identity.compiler.version, "compiler.version");
  stringField(identity.compiler.sourceSha256, "compiler.sourceSha256");
  knownObject(identity.source, "source", new Set(["fixtureSha256", "inputKind"]));
  stringField(identity.source.fixtureSha256, "source.fixtureSha256");
  stringField(identity.source.inputKind, "source.inputKind");
  knownObject(identity.config, "config", new Set(["selectedGroup", "verifier", "output", "memory", "loader", "patchStack", "exportManifest"]));
  stringArray(identity.config.selectedGroup, "config.selectedGroup");
  knownArray(identity.config.patchStack, "config.patchStack");
  knownArray(identity.config.exportManifest, "config.exportManifest");
  for (const key of ["verifier", "output", "memory"]) stringField(identity.config[key], `config.${key}`);
  knownObject(identity.config.loader, "config.loader", new Set(["kind", "version", "policySha256"]));
  for (const key of ["kind", "version", "policySha256"]) stringField(identity.config.loader[key], `config.loader.${key}`);
  for (const [index, item] of identity.config.patchStack.entries()) {
    knownObject(item, `config.patchStack[${index}]`, new Set(["name", "sha256"]));
    stringField(item.name, `config.patchStack[${index}].name`);
    stringField(item.sha256, `config.patchStack[${index}].sha256`);
  }
  knownObject(identity.toolchain, "toolchain", new Set(["node", "nodeVersion", "javac", "javacVersion", "java", "javaVersion", "wasmDis", "wasmDisVersion"]));
  for (const key of ["node", "javac", "java", "wasmDis"]) {
    knownObject(identity.toolchain[key], `toolchain.${key}`, new Set(["requested", "resolvedPath", "sha256", "bytes"]));
    for (const field of ["requested", "resolvedPath", "sha256"]) stringField(identity.toolchain[key][field], `toolchain.${key}.${field}`);
    integerField(identity.toolchain[key].bytes, `toolchain.${key}.bytes`);
  }
  for (const key of ["nodeVersion", "javacVersion", "javaVersion", "wasmDisVersion"]) stringField(identity.toolchain[key], `toolchain.${key}`);
  knownObject(identity.abi, "abi", new Set(["version", "result", "status", "handles", "state", "fallback", "memory", "imports", "unsupported", "verifier"]));
  knownObject(identity.abi.status, "abi.status", new Set(["RETURN", "DEOPT", "EXCEPTION"]));
  stringField(identity.abi.version, "abi.version");
  for (const key of ["result", "handles", "state", "fallback", "memory", "unsupported", "verifier"]) stringField(identity.abi[key], `abi.${key}`);
  for (const key of ["RETURN", "DEOPT", "EXCEPTION"]) integerField(identity.abi.status[key], `abi.status.${key}`);
  stringArray(identity.abi.imports, "abi.imports");
  knownObject(identity.loader, "loader", new Set(["kind", "version", "policySha256"]));
  for (const key of ["kind", "version", "policySha256"]) stringField(identity.loader[key], `loader.${key}`);
  knownObject(identity.fieldLayout, "fieldLayout", new Set(["mode", "fields"]));
  stringField(identity.fieldLayout.mode, "fieldLayout.mode");
  stringArray(identity.fieldLayout.fields, "fieldLayout.fields");
  knownObject(identity.cardLayout, "cardLayout", new Set(["mode", "clean", "dirty"]));
  stringField(identity.cardLayout.mode, "cardLayout.mode");
  nullableIntegerField(identity.cardLayout.clean, "cardLayout.clean");
  nullableIntegerField(identity.cardLayout.dirty, "cardLayout.dirty");
  knownObject(identity.forbiddenPayloadScan, "forbiddenPayloadScan", new Set(["status", "patterns"]));
  stringField(identity.forbiddenPayloadScan.status, "forbiddenPayloadScan.status");
  stringArray(identity.forbiddenPayloadScan.patterns, "forbiddenPayloadScan.patterns");
  stringArray(identity.compilerFlags, "compilerFlags");
  stringArray(identity.wasmFeatures, "wasmFeatures");
  for (const key of ["gcMode", "runtimeMode"]) stringField(identity[key], key);
  for (const [key, value] of [["compilerFlags", identity.compilerFlags], ["wasmFeatures", identity.wasmFeatures], ["group", identity.group], ["methods", identity.methods], ["dispatchTargets", identity.dispatchTargets], ["patchStack", identity.patchStack], ["exportManifest", identity.exportManifest], ["dependencies", identity.dependencies]]) knownArray(value, key);
  const validateExport = (item, path) => {
    knownObject(item, path, new Set(["name", "type"]));
    stringField(item.name, `${path}.name`);
    integerField(item.type, `${path}.type`);
  };
  for (const [index, item] of identity.patchStack.entries()) {
    knownObject(item, `patchStack[${index}]`, new Set(["name", "sha256"]));
    stringField(item.name, `patchStack[${index}].name`);
    stringField(item.sha256, `patchStack[${index}].sha256`);
  }
  for (const [index, item] of identity.exportManifest.entries()) validateExport(item, `exportManifest[${index}]`);
  for (const [index, item] of identity.config.exportManifest.entries()) validateExport(item, `config.exportManifest[${index}]`);
  for (const [index, item] of identity.group.entries()) {
    knownObject(item, `group[${index}]`, new Set(["key", "owner", "name", "descriptor", "classSha256", "bytecodeSha256"]));
    for (const key of ["key", "owner", "name", "descriptor", "classSha256", "bytecodeSha256"]) stringField(item[key], `group[${index}].${key}`);
  }
  for (const [index, item] of identity.dependencies.entries()) {
    knownObject(item, `dependencies[${index}]`, new Set(["name", "classSha256", "bytecodeSha256", "fileBytes", "methodCount", "file"]));
    for (const key of ["name", "classSha256", "bytecodeSha256", "file"]) stringField(item[key], `dependencies[${index}].${key}`);
    integerField(item.fileBytes, `dependencies[${index}].fileBytes`);
    integerField(item.methodCount, `dependencies[${index}].methodCount`);
  }
  for (const [index, item] of identity.methods.entries()) {
    knownObject(item, `methods[${index}]`, new Set(["key", "owner", "name", "descriptor", "classSha256", "codeSha256", "codeLength", "bciMap", "exceptionTable"]));
    for (const key of ["key", "owner", "name", "descriptor", "classSha256", "codeSha256"]) stringField(item[key], `methods[${index}].${key}`);
    integerField(item.codeLength, `methods[${index}].codeLength`);
    knownArray(item.bciMap, `methods[${index}].bciMap`);
    knownArray(item.exceptionTable, `methods[${index}].exceptionTable`);
    for (const [j, instruction] of item.bciMap.entries()) {
      const path = `methods[${index}].bciMap[${j}]`;
      knownObject(instruction, path, new Set(["bci", "opcode", "args"]));
      integerField(instruction.bci, `${path}.bci`);
      integerField(instruction.opcode, `${path}.opcode`);
      instruction.args === undefined ? reject(`identity ${path}.args is missing`) : integerArray(instruction.args, `${path}.args`);
    }
    for (const [j, exception] of item.exceptionTable.entries()) {
      const path = `methods[${index}].exceptionTable[${j}]`;
      knownObject(exception, path, new Set(["startPc", "endPc", "handlerPc", "catchType"]));
      for (const key of ["startPc", "endPc", "handlerPc", "catchType"]) integerField(exception[key], `${path}.${key}`);
    }
  }
  for (const [index, item] of identity.dispatchTargets.entries()) {
    const path = `dispatchTargets[${index}]`;
    knownObject(item, path, new Set(["callsite", "invokeBci", "opcode", "owner", "name", "descriptor", "expectedClass", "targetMethod", "targetBytecodeSha256", "tableIndex", "mode"]));
    for (const key of ["callsite", "owner", "name", "descriptor", "expectedClass", "targetMethod", "targetBytecodeSha256", "mode"]) stringField(item[key], `${path}.${key}`);
    integerField(item.invokeBci, `${path}.invokeBci`);
    stringField(item.opcode, `${path}.opcode`);
    nullableIntegerField(item.tableIndex, `${path}.tableIndex`);
  }
  knownObject(identity.directCallGraph, "directCallGraph", new Set(["schema", "bodies", "incoming"]));
  stringField(identity.directCallGraph.schema, "directCallGraph.schema");
  knownArray(identity.directCallGraph.bodies, "directCallGraph.bodies");
  knownObject(identity.directCallGraph.incoming, "directCallGraph.incoming", new Set(Object.keys(identity.directCallGraph.incoming)));
  for (const [index, body] of identity.directCallGraph.bodies.entries()) {
    knownObject(body, `directCallGraph.bodies[${index}]`, new Set(["id", "functionIndex", "calls"]));
    stringField(body.id, `directCallGraph.bodies[${index}].id`);
    integerField(body.functionIndex, `directCallGraph.bodies[${index}].functionIndex`);
    knownArray(body.calls, `directCallGraph.bodies[${index}].calls`);
    for (const [j, call] of body.calls.entries()) {
      const path = `directCallGraph.bodies[${index}].calls[${j}]`;
      knownObject(call, path, new Set(["kind", "target"]));
      if (call.kind !== "internal" && call.kind !== "runtime-import") reject(`identity ${path}.kind is unsupported`);
      stringField(call.target, `${path}.target`);
    }
  }
  for (const key of Object.keys(identity.directCallGraph.incoming)) stringArray(identity.directCallGraph.incoming[key], `directCallGraph.incoming.${key}`);
  const bodyIds = new Set(identity.directCallGraph.bodies.map((body) => body.id));
  const derivedIncoming = new Map();
  for (const body of identity.directCallGraph.bodies) {
    for (const call of body.calls) if (call.kind === "internal") {
      if (!bodyIds.has(call.target)) reject(`identity call graph unknown target ${call.target}`);
      const list = derivedIncoming.get(call.target) || [];
      list.push(body.id);
      derivedIncoming.set(call.target, list);
    }
  }
  const incomingKeys = Object.keys(identity.directCallGraph.incoming).sort();
  const derivedKeys = [...derivedIncoming.keys()].sort();
  if (JSON.stringify(incomingKeys) !== JSON.stringify(derivedKeys)) reject("identity call graph incoming keys are not derived");
  for (const key of derivedKeys) {
    const actual = [...identity.directCallGraph.incoming[key]].sort();
    const expected = [...derivedIncoming.get(key)].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) reject(`identity call graph incoming mismatch ${key}`);
  }
  return true;
}

function operationCounters() {
  return {
    inputPreflight: 0,
    parseCompileEmit: 0,
    artifactVerify: 0,
    graphVerify: 0,
    artifactValidationBytes: 0,
    moduleConstruct: 0,
    instantiate: 0,
    register: 0,
    registeredBytes: 0,
    registeredSlots: 0,
    newCallableSlots: 0,
    firstCall: 0
  };
}

function increment(ops, key, amount = 1) { if (ops) ops[key] += amount; }

function counterDelta(before, after) {
  return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
}

function counterSnapshot(registry) { return { ...registry.operations }; }

function requireOwner(ownerIdentity) {
  if (ownerIdentity == null || typeof ownerIdentity !== "object" || Array.isArray(ownerIdentity)) {
    reject("runtime/import owner token is mandatory");
  }
}

export function validateRecordSchema(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) reject("cache artifact record must be an object");
  const allowed = new Set(["schema", "cacheKey", "identitySha256", "outputBytes", "outputSha256", "abiSha256", "exportManifestSha256", "directCallGraphSha256", "runtimeOwnerSha256", "recordSha256"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) reject(`cache artifact unknown field ${key}`);
  for (const key of ["schema", "cacheKey", "identitySha256", "outputSha256", "abiSha256", "exportManifestSha256", "directCallGraphSha256", "recordSha256"]) {
    if (typeof record[key] !== "string") reject(`cache artifact record field ${key}`);
  }
  integerField(record.outputBytes, "record.outputBytes");
  if (record.runtimeOwnerSha256 !== null && typeof record.runtimeOwnerSha256 !== "string") reject("cache artifact owner field");
}

export function makeArtifactRecord(moduleBytes, manifest, identity, ownerIdentity = null) {
  const moduleBuffer = Buffer.from(moduleBytes);
  const base = {
    schema: "whole-unit-host-artifact-v2",
    cacheKey: cacheKeyFor(identity),
    identitySha256: hash(Buffer.from(canonical(identity))),
    outputBytes: moduleBuffer.length,
    outputSha256: hash(moduleBuffer),
    abiSha256: hash(Buffer.from(canonical(manifest.abi))),
    exportManifestSha256: hash(Buffer.from(canonical(manifest.exportManifest || []))),
    directCallGraphSha256: hash(Buffer.from(canonical(manifest.directCallGraph || {})))
    ,runtimeOwnerSha256: ownerIdentity == null ? null : hash(Buffer.from(canonical(ownerIdentity)))
  };
  return {
    ...base,
    recordSha256: hash(Buffer.from(canonical(base)))
  };
}

export function artifactRecordBytes(record) {
  validateRecordSchema(record);
  return Buffer.byteLength(canonical(record));
}

export function verifyArtifact(moduleBytes, manifest, requestedIdentity, record, limits = RESOURCE_LIMITS, operations = null, ownerIdentity = null, verifyGraph = null) {
  validateIdentitySchema(requestedIdentity);
  increment(operations, "artifactVerify");
  const moduleBuffer = Buffer.from(moduleBytes);
  const requestedKey = cacheKeyFor(requestedIdentity);
  if (moduleBuffer.length > limits.maxModuleBytes) reject("resource ceiling: module bytes");
  validateRecordSchema(record);
  if (!record || record.schema !== "whole-unit-host-artifact-v2") {
    reject("cache artifact schema");
  }
  if (record.cacheKey !== requestedKey
      || record.identitySha256 !== hash(Buffer.from(canonical(requestedIdentity)))) {
    reject("cache artifact requested identity mismatch");
  }
  if (!manifest.cacheIdentity
      || cacheKeyFor(manifest.cacheIdentity) !== requestedKey
      || hash(Buffer.from(canonical(manifest.cacheIdentity))) !== record.identitySha256) {
    reject("cache artifact manifest identity mismatch");
  }
  if (record.outputBytes !== moduleBuffer.length || record.outputSha256 !== hash(moduleBuffer)) {
    reject("cache artifact output integrity");
  }
  const { recordSha256, ...base } = record;
  if (recordSha256 !== hash(Buffer.from(canonical(base)))) {
    reject("cache artifact record integrity");
  }
  if (record.abiSha256 !== hash(Buffer.from(canonical(manifest.abi)))
      || record.exportManifestSha256 !== hash(Buffer.from(canonical(manifest.exportManifest || [])))
      || record.directCallGraphSha256 !== hash(Buffer.from(canonical(manifest.directCallGraph || {})))) {
    reject("cache artifact manifest integrity");
  }
  increment(operations, "artifactValidationBytes", moduleBuffer.length);
  if (!WebAssembly.validate(moduleBuffer)) reject("cached Wasm validation");
  if (ownerIdentity != null && record.runtimeOwnerSha256 !== hash(Buffer.from(canonical(ownerIdentity)))) reject("cache runtime/import owner mismatch");
  if (verifyGraph) {
    verifyGraph(moduleBuffer, manifest);
    increment(operations, "graphVerify");
  }
  return true;
}

export function createHostRegistry(limits = RESOURCE_LIMITS, verifyGraph = null) {
  return {
    schema: HOST_CACHE_SCHEMA,
    limits,
    entries: new Map(),
    registeredBytes: 0,
    registeredSlots: 0,
    cacheBytes: 0,
    cacheSlots: 0
    ,operations: operationCounters()
    ,ownerIdentity: null
    ,quarantined: new Map()
    ,lookupCandidates: 0
    ,lookupCompleted: 0
    ,lookupKeys: new Set()
    ,verifyGraph
  };
}

export function preflightInputResources(stats, limits = RESOURCE_LIMITS, operations = null) {
  increment(operations, "inputPreflight");
  if (stats.classFiles > limits.maxClassFiles) reject("resource ceiling: class files");
  if (stats.totalBytes > limits.maxInputBytes) reject("resource ceiling: input bytes");
  if (stats.maxClassBytes > limits.maxSingleClassBytes) reject("resource ceiling: single class bytes");
  if (stats.dependencyBytes > limits.maxDependencyBytes) reject("resource ceiling: dependency bytes");
  return true;
}

export function snapshotRegistry(registry) {
  return {
    cacheSlots: registry.cacheSlots,
    cacheBytes: registry.cacheBytes,
    registeredSlots: registry.registeredSlots,
    registeredBytes: registry.registeredBytes
  };
}

export function lookupEntry({ registry, identity, ownerIdentity, verifyGraph = null }) {
  requireOwner(ownerIdentity);
  const graphVerifier = verifyGraph || registry.verifyGraph;
  if (typeof graphVerifier !== "function") reject("binary graph verifier is mandatory");
  validateIdentitySchema(identity);
  registry.lookupCandidates = (registry.lookupCandidates || 0) + 1;
  const key = cacheKeyFor(identity);
  if (!registry.lookupKeys) registry.lookupKeys = new Set();
  registry.lookupKeys.add(key);
  const existing = registry.entries.get(key);
  if (registry.ownerIdentity != null && canonical(registry.ownerIdentity) !== canonical(ownerIdentity)) {
    reject("cache runtime/import owner mismatch", "CORRUPT");
  }
  if (!existing) {
    registry.lookupCompleted = (registry.lookupCompleted || 0) + 1;
    return { state: "miss", key, entry: null };
  }
  try {
    if (!existing.usable) reject("quarantined cache entry", "CORRUPT");
    verifyArtifact(existing.moduleBytes, existing.manifest, identity, existing.record,
      registry.limits, registry.operations, ownerIdentity, graphVerifier);
    registry.lookupCompleted = (registry.lookupCompleted || 0) + 1;
    return { state: "hit", key, entry: existing };
  } catch (error) {
    const corrupt = new Error(`CORRUPT cache entry: ${error.message}`);
    corrupt.code = "CORRUPT";
    registry.lookupCompleted = (registry.lookupCompleted || 0) + 1;
    throw corrupt;
  }
}

function assertResourceLimits(registry, artifactBytes, recordBytes, replacing = null) {
  if (artifactBytes > registry.limits.maxModuleBytes) reject("resource ceiling: module bytes");
  if (recordBytes > registry.limits.maxArtifactRecordBytes) reject("resource ceiling: artifact record bytes");
  const slotDelta = replacing ? 0 : 1;
  if (registry.registeredSlots + slotDelta > registry.limits.maxRegistrySlots) reject("resource ceiling: registry slots");
  if (registry.registeredBytes - (replacing ? replacing.moduleBytes.length : 0) + artifactBytes + recordBytes > registry.limits.maxRegistryBytes) {
    reject("resource ceiling: registry bytes");
  }
}

function callableSlots(instance) {
  return Object.fromEntries(Object.entries(instance.exports).filter(([, value]) => typeof value === "function"));
}

function publish(registry, key, entry, recordBytes, replacing = null) {
  if (replacing) {
    registry.cacheBytes -= replacing.recordBytes + replacing.moduleBytes.length;
    registry.registeredBytes -= replacing.moduleBytes.length;
    registry.cacheSlots--;
    registry.registeredSlots--;
    registry.entries.delete(key);
  }
  registry.entries.set(key, entry);
  registry.cacheBytes += entry.moduleBytes.length + recordBytes;
  registry.cacheSlots++;
  registry.registeredBytes += entry.moduleBytes.length;
  registry.registeredSlots++;
}

export function compileInstallOrLoad({ registry, identity, generate, imports, firstCall, failurePhase = null, inputStats = null, ownerIdentity = null, repairCorrupt = false, forceReplace = false, verifyGraph = null }) {
  requireOwner(ownerIdentity);
  const graphVerifier = verifyGraph || registry.verifyGraph;
  if (typeof graphVerifier !== "function") reject("binary graph verifier is mandatory");
  validateIdentitySchema(identity);
  const requestedKey = cacheKeyFor(identity);
  const before = counterSnapshot(registry);
  if (inputStats) preflightInputResources(inputStats, registry.limits, registry.operations);
  let lookup;
  try {
    lookup = lookupEntry({ registry, identity, ownerIdentity, verifyGraph: graphVerifier });
  } catch (error) {
    if (!(repairCorrupt && error.code === "CORRUPT" && !String(error.message).includes("owner"))) throw error;
    lookup = { state: "corrupt", key: requestedKey, entry: registry.entries.get(requestedKey) };
  }
  const existing = lookup.entry;
  let replacing = null;
  let repairing = false;
  if (existing && forceReplace) replacing = existing;
  if (existing && !forceReplace && lookup.state === "hit") {
    const firstStart = monotonicNs();
    registry.operations.firstCall++;
    const firstResult = firstCall(existing.instance, existing.callableSlots);
    const firstCallNs = monotonicNs() - firstStart;
    return {
      state: "hit", key: requestedKey, instance: existing.instance, callableSlots: existing.callableSlots,
      result: firstResult,
      phases: { identityVerifyNs: "included-in-lookup", moduleCompileNs: "0", instantiateNs: "0", registerNs: "0", firstCallNs: firstCallNs.toString() },
      counters: counterDelta(before, registry.operations),
      cacheOwner: existing.ownerIdentity
    };
  }
  if (existing && !forceReplace && lookup.state === "corrupt") {
    if (!repairCorrupt) reject("corrupt cache entry", "CORRUPT");
    existing.usable = false;
    registry.quarantined.set(requestedKey, existing);
    repairing = true;
    replacing = existing;
  }

  const generationStart = monotonicNs();
  registry.operations.parseCompileEmit++;
  if (failurePhase === "generation") reject("injected generation failure", "INJECT");
  const generated = generate();
  const generationNs = monotonicNs() - generationStart;
  if (!generated || !generated.module || generated.module.length > registry.limits.maxModuleBytes) reject("resource ceiling: bounded emitter module bytes");
  const moduleBytes = Buffer.from(generated.module);
  const record = makeArtifactRecord(moduleBytes, generated.manifest, identity, ownerIdentity);
  const recordBytes = artifactRecordBytes(record);
  if (failurePhase === "record") reject("injected record failure", "INJECT");
  assertResourceLimits(registry, moduleBytes.length, recordBytes, replacing);
  verifyArtifact(moduleBytes, generated.manifest, identity, record, registry.limits, registry.operations, ownerIdentity, graphVerifier);
  if (failurePhase === "validate") reject("injected validation failure", "INJECT");
  const compileStart = monotonicNs();
  if (failurePhase === "module") reject("injected module construction failure", "INJECT");
  registry.operations.moduleConstruct++;
  const module = new WebAssembly.Module(moduleBytes);
  const moduleCompileNs = monotonicNs() - compileStart;
  const instantiateStart = monotonicNs();
  if (failurePhase === "instantiate") reject("injected instantiate failure", "INJECT");
  registry.operations.instantiate++;
  const instance = new WebAssembly.Instance(module, imports);
  const instantiateNs = monotonicNs() - instantiateStart;
  const registerStart = monotonicNs();
  if (failurePhase === "register") reject("injected register failure", "INJECT");
  registry.operations.register++;
  const slots = callableSlots(instance);
  const slotNames = Object.keys(slots);
  if (!slotNames.length) reject("artifact has no callable slots");
  registry.operations.newCallableSlots += slotNames.length;
  registry.operations.registeredBytes += moduleBytes.length;
  registry.operations.registeredSlots++;
  const entry = { moduleBytes, manifest: generated.manifest, record, module, instance, callableSlots: slots, ownerIdentity, recordBytes, usable: true };
  if (registry.ownerIdentity == null) registry.ownerIdentity = ownerIdentity;
  publish(registry, requestedKey, entry, recordBytes, replacing);
  const registerNs = monotonicNs() - registerStart;
  const firstStart = monotonicNs();
  registry.operations.firstCall++;
  const firstResult = firstCall(instance, slots);
  const firstCallNs = monotonicNs() - firstStart;
  return {
    state: repairing ? "repair" : "cold",
    key: requestedKey,
    instance,
    result: firstResult,
    generated,
    record,
    recordBytes,
    phases: {
      generationNs: generationNs.toString(),
      validationNs: "included-in-artifact-verify",
      moduleCompileNs: moduleCompileNs.toString(),
      instantiateNs: instantiateNs.toString(),
      registerNs: registerNs.toString(),
      firstCallNs: firstCallNs.toString()
    },
    counters: {
      ...counterDelta(before, registry.operations)
    },
    callableSlots: slots
  };
}

export function assertNoGrowth(before, after) {
  for (const key of ["cacheSlots", "cacheBytes", "registeredSlots", "registeredBytes"]) {
    if (before[key] !== after[key]) throw new Error(`REJECT registry growth on hit: ${key}`);
  }
}

export function identityMutation(identity, mutate) {
  const copy = JSON.parse(JSON.stringify(identity));
  mutate(copy);
  return cacheKeyFor(copy);
}

export function parseUniqueJson(text) {
  if (typeof text === "string") reject("raw JSON strings are not accepted");
  return text;
}

export { canonical, hash, cacheKeyFor };
