/*
 * Focused gate for the local whole-unit OSS compiler fixture.
 *
 * The Java program is the oracle for this synthetic fixture.  The generated
 * module is the baseline path.  Packed status/BCI values are checked exactly;
 * non-return statuses are handled by a host oracle, not claimed as proof of
 * a real Zero interpreter exception/deoptimization path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  compileWholeUnit,
  cacheKeyFor,
  verifyCacheRecord,
  hash
} from "../tools/whole-unit-compiler.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const javac = process.env.JAVAC || "/opt/homebrew/opt/openjdk@25/bin/javac";
const java = process.env.JAVA || "/opt/homebrew/opt/openjdk@25/bin/java";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcweb-whole-unit-"));
const classes = path.join(work, "classes");
fs.mkdirSync(classes);

function cleanup() {
  fs.rmSync(work, { recursive: true, force: true });
}
process.on("exit", cleanup);

function sampleRss(samples) {
  samples.push(process.memoryUsage().rss);
}

function commandVersion(command, args) {
  const result = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.trim();
}

function resolveExecutableIdentity(label, command) {
  let candidate;
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    candidate = path.resolve(command);
  } else {
    const searchPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    candidate = searchPath.map((directory) => path.join(directory, command))
      .find((filePath) => {
        try {
          return fs.statSync(filePath).isFile();
        } catch {
          return false;
        }
      });
  }
  if (!candidate) throw new Error(`REJECT toolchain executable identity unavailable: ${label} (${command})`);
  let resolvedPath;
  let bytes;
  try {
    resolvedPath = fs.realpathSync(candidate);
    fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.X_OK);
    bytes = fs.readFileSync(resolvedPath);
  } catch (error) {
    throw new Error(`REJECT toolchain executable identity unavailable: ${label} (${command}): ${error.message}`);
  }
  return {
    requested: command,
    resolvedPath,
    sha256: hash(bytes),
    bytes: bytes.length
  };
}

function expectReject(label, action, pattern) {
  try {
    action();
  } catch (error) {
    if (!pattern.test(String(error))) throw new Error(`REJECT ${label}: wrong failure ${error}`);
    return;
  }
  throw new Error(`REJECT ${label}: unsupported input was accepted`);
}

function decodeResult(raw) {
  const value = BigInt.asUintN(64, BigInt(raw));
  return {
    status: Number((value >> 48n) & 0xffffn),
    bci: Number((value >> 32n) & 0xffffn),
    result: Number(BigInt.asIntN(32, value & 0xffffffffn))
  };
}

function assertEqual(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`REJECT ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const memorySamples = [];
sampleRss(memorySamples);
execFileSync(javac, ["--release", "11", "-g:none", "-d", classes,
  path.join(here, "WholeUnitFixture.java")], { stdio: "inherit" });
sampleRss(memorySamples);
const oracleLine = execFileSync(java, ["-cp", classes, "WholeUnitFixture"], { encoding: "utf8" })
  .trim().split("\n").find((line) => line.startsWith("whole-fixture "));
if (!oracleLine) throw new Error("REJECT Java oracle did not print whole-fixture vector");
const expected = oracleLine.slice("whole-fixture ".length).split(",").map(Number);
const wasmDis = process.env.WASM_DIS || "wasm-dis";
const nodeIdentity = resolveExecutableIdentity("node", process.execPath);
const javacIdentity = resolveExecutableIdentity("javac", javac);
const javaIdentity = resolveExecutableIdentity("java", java);
const wasmDisIdentity = resolveExecutableIdentity("wasm-dis", wasmDis);
const compilerOptions = {
  sourcePath: path.join(here, "WholeUnitFixture.java"),
  compilerFlags: ["exact-opcode-verifier", "-g:none", "--release=11"],
  wasmFeatures: ["wasm32", "i32", "i64", "linear-memory"],
  gcMode: "linear-memory-handle-mvp",
  runtimeMode: "fixture-host-oracle",
  toolchain: {
    node: nodeIdentity,
    nodeVersion: process.version,
    javac: javacIdentity,
    javacVersion: commandVersion(javac, ["--version"]),
    java: javaIdentity,
    javaVersion: commandVersion(java, ["--version"]),
    wasmDis: wasmDisIdentity,
    wasmDisVersion: commandVersion(wasmDis, ["--version"])
  }
};
// Negative proof: mutate only safeDiv's idiv opcode in a temporary copy.  A
// compiler that quietly emits the old shape would turn this into a false
// green, so the gate requires a loud rejection before any Wasm is produced.
const negativeClasses = path.join(work, "negative-classes");
fs.cpSync(classes, negativeClasses, { recursive: true });
const negativeRoot = path.join(negativeClasses, "WholeUnitFixture.class");
const negativeBytes = fs.readFileSync(negativeRoot);
const safeDivShape = Buffer.from([0x1a, 0x1b, 0x6c, 0xac]);
const safeDivAt = negativeBytes.indexOf(safeDivShape);
if (safeDivAt < 0) throw new Error("REJECT negative fixture could not locate safeDiv bytecode");
negativeBytes[safeDivAt + 2] = 0x6a; // iadd in place of idiv
fs.writeFileSync(negativeRoot, negativeBytes);
expectReject("idiv mutation", () => compileWholeUnit(negativeClasses, compilerOptions), /REJECT unsupported safeDiv opcode 0x6a/);

const linkedNegativeClasses = path.join(work, "linked-negative-classes");
fs.cpSync(classes, linkedNegativeClasses, { recursive: true });
const linkedNegativeRoot = path.join(linkedNegativeClasses, "WholeUnitFixture.class");
const linkedNegativeBytes = fs.readFileSync(linkedNegativeRoot);
const linkedShape = Buffer.from([0x1a, 0xb8]);
const linkedAt = linkedNegativeBytes.indexOf(linkedShape);
if (linkedAt < 0) throw new Error("REJECT negative fixture could not locate linked bytecode");
linkedNegativeBytes[linkedAt] = 0x85; // i2l in place of iload_0
fs.writeFileSync(linkedNegativeRoot, linkedNegativeBytes);
expectReject("linked iload_0 mutation", () => compileWholeUnit(linkedNegativeClasses, compilerOptions), /REJECT unsupported linked opcode 0x85/);

const missingNegativeClasses = path.join(work, "missing-negative-classes");
fs.cpSync(classes, missingNegativeClasses, { recursive: true });
fs.rmSync(path.join(missingNegativeClasses, "WholeUnitFixture$Other.class"));
expectReject("dependency closure", () => compileWholeUnit(missingNegativeClasses, compilerOptions), /REJECT (missing dependency closure|class input set)/);

const duplicateNegativeClasses = path.join(work, "duplicate-negative-classes");
fs.cpSync(classes, duplicateNegativeClasses, { recursive: true });
fs.copyFileSync(path.join(duplicateNegativeClasses, "WholeUnitFixture$Box.class"),
  path.join(duplicateNegativeClasses, "DuplicateBox.class"));
expectReject("duplicate declared class/path", () => compileWholeUnit(duplicateNegativeClasses, compilerOptions),
  /REJECT duplicate declared class WholeUnitFixture\$Box/);

const compileStart = performance.now();
const compiled = compileWholeUnit(classes, compilerOptions);
sampleRss(memorySamples);
const inProcessCompileMs = performance.now() - compileStart;
if (!WebAssembly.validate(compiled.module)) throw new Error("REJECT emitted Wasm failed validation");
const deterministic = compileWholeUnit(classes, compilerOptions);
if (deterministic.manifest.cacheKey !== compiled.manifest.cacheKey
    || deterministic.module.length !== compiled.module.length
    || Buffer.compare(Buffer.from(deterministic.module), Buffer.from(compiled.module)) !== 0) {
  throw new Error("REJECT non-deterministic cache key or output bytes");
}
if (!verifyCacheRecord(compiled.module, compiled.manifest.cacheRecord)) {
  throw new Error("REJECT valid output/cache record integrity");
}
const truncated = compiled.module.slice(0, -1);
const corrupted = new Uint8Array(compiled.module);
corrupted[corrupted.length - 1] ^= 0x01;
if (verifyCacheRecord(truncated, compiled.manifest.cacheRecord)
    || verifyCacheRecord(corrupted, compiled.manifest.cacheRecord)) {
  throw new Error("REJECT corrupted/truncated output passed cache-record integrity");
}
const mutatedIdentity = JSON.parse(JSON.stringify(compiled.manifest.cacheIdentity));
mutatedIdentity.compilerFlags = [...mutatedIdentity.compilerFlags, "mutated-test-flag"];
if (cacheKeyFor(mutatedIdentity) === compiled.manifest.cacheKey) {
  throw new Error("REJECT one-field cache identity mutation did not miss");
}

const wasmPath = path.join(work, "whole-unit.wasm");
fs.writeFileSync(wasmPath, compiled.module);
const wat = execFileSync(wasmDis, [wasmPath], { encoding: "utf8" });
const directCallCount = (wat.match(/\bcall\b/g) || []).length;
const functionIndices = compiled.manifest.functionIndices;
const disassemblyFunctionIndex = (index) => index - compiled.manifest.importFunctionCount;
const directCallCountFor = (index) =>
  (wat.match(new RegExp(`^\\s*\\(call \\$${disassemblyFunctionIndex(index)}\\s*$`, "gm")) || []).length;
const linkedLeafCalls = directCallCountFor(functionIndices.leaf);
const virtualGoodCalls = directCallCountFor(functionIndices.goodValue);
const benchLinkedCalls = directCallCountFor(functionIndices.linked);
if (directCallCount < 2 || linkedLeafCalls < 1 || virtualGoodCalls < 1
    || benchLinkedCalls < 1 || !compiled.manifest.expectedDirectCallEdges.includes("linked->leaf")) {
  throw new Error(`REJECT Wasm disassembly/counters do not prove direct calls (calls=${directCallCount})`);
}

const GOOD = 1;
const OTHER = 2;
const runtime = {
  memory: new WebAssembly.Memory({ initial: 1 }),
  fieldHandles: new Set([16]),
  arrayHandles: new Set([32]),
  classInitialized: new Set(),
  forceClassInitMiss: false,
  classInitHits: 0,
  classInitMisses: 0,
  virtualHits: 0,
  virtualMisses: 0,
  calls: [],
  imports: {
    rt_get_field(handle, fieldId) {
      runtime.calls.push(`get-field:${handle}:${fieldId}`);
      if (fieldId !== 0 || !runtime.fieldHandles.has(handle)) throw new Error("bad object handle/field");
      return new DataView(runtime.memory.buffer).getInt32(handle + fieldId * 4, true);
    },
    rt_array_get(handle, index) {
      runtime.calls.push(`array-get:${handle}:${index}`);
      if (!runtime.arrayHandles.has(handle)) throw new Error("bad array handle");
      const view = new DataView(runtime.memory.buffer);
      const length = view.getInt32(handle, true);
      if (index < 0 || index >= length) throw new Error("bad array index");
      return view.getInt32(handle + 4 + index * 4, true);
    },
    rt_ensure_class_init(classId) {
      runtime.calls.push(`class-init:${classId}`);
      if (classId !== 1) throw new Error("bad class id");
      if (runtime.forceClassInitMiss) {
        runtime.forceClassInitMiss = false;
        runtime.classInitMisses++;
        return 1;
      }
      runtime.classInitHits++;
      runtime.classInitialized.add(classId);
      return 0;
    },
    rt_get_static(classId, fieldId) {
      runtime.calls.push(`get-static:${classId}:${fieldId}`);
      if (classId !== 1 || fieldId !== 0 || !runtime.classInitialized.has(classId)) {
        throw new Error("static read without class init");
      }
      return 19;
    },
    rt_class_id(handle) {
      runtime.calls.push(`class-id:${handle}`);
      if (handle === 3) {
        runtime.virtualHits++;
        return GOOD;
      }
      if (handle === 4) {
        runtime.virtualMisses++;
        return OTHER;
      }
      throw new Error("bad virtual receiver handle");
    }
  }
};
const memoryView = new DataView(runtime.memory.buffer);
memoryView.setInt32(16, 5, true); // Box.value at handle 16
memoryView.setInt32(32, 3, true); // int[] length at handle 32
memoryView.setInt32(36, 2, true);
memoryView.setInt32(40, 4, true);
memoryView.setInt32(44, 8, true);
const instance = new WebAssembly.Instance(new WebAssembly.Module(compiled.module), {
  env: { memory: runtime.memory }, runtime: runtime.imports
});
const e = instance.exports;

function hostOracleFallback(name, args) {
  if (name.startsWith("classInit")) return 19 + args[0];
  if (name.startsWith("virtual")) return args[0] === 3 ? args[1] + 11 : 29 - args[1];
  if (name.startsWith("safeDiv")) return args[1] === 0 ? -1 : Math.trunc(args[0] / args[1]);
  throw new Error(`no host oracle fallback for ${name}`);
}

function call(name, exportName, args, expectedStatus = 0, expectedBci = 0) {
  const result = decodeResult(e[exportName](...args));
  if (result.status !== expectedStatus || result.bci !== expectedBci) {
    throw new Error(`REJECT ${name} packed status/bci ${result.status}/${result.bci} expected ${expectedStatus}/${expectedBci}`);
  }
  if (result.status === 0) return result.result;
  const kind = result.status === 1 ? "DEOPT" : result.status === 2 ? "EXCEPTION" : "UNKNOWN";
  console.log(`[whole-unit] HOST_ORACLE ${name} status=${kind} resume-bci=${result.bci}`);
  return hostOracleFallback(name, args);
}

const actual = [];
actual.push(call("leaf", "unit_leaf", [7], 0, 0));
actual.push(call("linked", "unit_linked", [7], 0, 0));
actual.push(call("objectArray", "unit_objectArray", [16, 32, 1], 0, 0));
actual.push(call("classInit-hit", "unit_classInit", [7], 0, 0));
actual.push(call("virtual-hit", "unit_virtual", [3, 7], 0, 0));
actual.push(call("virtual-miss", "unit_virtual", [4, 7], 1, 2));
actual.push(call("safeDiv-hit", "unit_safeDiv", [7, 3], 0, 0));
actual.push(call("safeDiv-exception", "unit_safeDiv", [7, 0], 2, 2));
runtime.forceClassInitMiss = true;
actual.push(call("classInit-miss", "unit_classInit", [8], 1, 0));
assertEqual("interpreter/oracle vector", actual, expected);

if (!runtime.calls.includes("get-field:16:0") || !runtime.calls.includes("array-get:32:1")) {
  throw new Error("REJECT object/array handle ABI did not execute");
}
if (!runtime.calls.includes("class-init:1") || !runtime.calls.includes("class-id:3")
    || !runtime.calls.includes("class-id:4")) {
  throw new Error("REJECT class-init/virtual guard ABI did not execute");
}
if (runtime.classInitHits !== 1 || runtime.classInitMisses !== 1
    || runtime.virtualHits !== 1 || runtime.virtualMisses !== 1) {
  throw new Error("REJECT class-init/virtual guard hit/miss counts");
}
if (!compiled.manifest.expectedDirectCallEdges.includes("linked->leaf")) {
  throw new Error("REJECT linked direct-call edge was not recorded");
}

function benchmark(exportName, count) {
  e[exportName](100_000);
  const start = process.hrtime.bigint();
  const checksum = e[exportName](count);
  const elapsed = process.hrtime.bigint() - start;
  return { checksum, nsPerCall: Number(elapsed) / count };
}
const count = 5_000_000;
// Warm up both Wasm bodies before recording the direct-Wasm comparison.
benchmark("benchDirect", 100_000);
benchmark("benchLinked", 100_000);
const trials = [];
let orderState = 0x6d2b79f5;
function nextOrderBit() {
  orderState ^= orderState << 13;
  orderState ^= orderState >>> 17;
  orderState ^= orderState << 5;
  return orderState & 1;
}
const trialCount = 31;
for (let i = 0; i < trialCount; i++) {
  const linkedFirst = nextOrderBit() === 1;
  const first = linkedFirst ? benchmark("benchLinked", count) : benchmark("benchDirect", count);
  const second = linkedFirst ? benchmark("benchDirect", count) : benchmark("benchLinked", count);
  const direct = linkedFirst ? second : first;
  const linked = linkedFirst ? first : second;
  if (direct.checksum !== linked.checksum) throw new Error("REJECT benchmark checksum mismatch");
  trials.push({ direct, linked, linkedFirst, ratio: linked.nsPerCall / direct.nsPerCall });
}
const sortedRatios = trials.map((trial) => trial.ratio).sort((a, b) => a - b);
const medianIndex = Math.floor(trialCount / 2);
const medianRatio = sortedRatios[medianIndex];
const p95Ratio = sortedRatios[Math.ceil(sortedRatios.length * 0.95) - 1];
if (!Number.isFinite(medianRatio) || !Number.isFinite(p95Ratio)
    || medianRatio > 2.0 || p95Ratio > 2.0) {
  throw new Error(`REJECT linked/direct Wasm target median=${medianRatio.toFixed(3)}x p95=${p95Ratio.toFixed(3)}x exceeds 2x`);
}

sampleRss(memorySamples);
const sortedDirectNs = trials.map((trial) => trial.direct.nsPerCall).sort((a, b) => a - b);
const sortedLinkedNs = trials.map((trial) => trial.linked.nsPerCall).sort((a, b) => a - b);
const metadata = {
  inProcessCompileMs: Number(inProcessCompileMs.toFixed(3)),
  sampledProcessRssBytes: memorySamples[memorySamples.length - 1],
  outputBytes: compiled.module.length,
  outputSha256: compiled.manifest.outputSha256,
  cacheKey: compiled.manifest.cacheKey,
  directWasmNsPerCallMedian: Number(sortedDirectNs[medianIndex].toFixed(3)),
  linkedWasmNsPerCallMedian: Number(sortedLinkedNs[medianIndex].toFixed(3)),
  linkedDirectRatioMedian: Number(medianRatio.toFixed(3)),
  linkedDirectRatioP95: Number(p95Ratio.toFixed(3)),
  benchmarkTrials: trialCount,
  benchmarkOrder: trials.map((trial) => trial.linkedFirst ? "linked,direct" : "direct,linked"),
  benchmarkBoundary: "one host call per entirely-Wasm 5000000-iteration loop",
  benchmarkChecksum: trials[0].direct.checksum.toString(),
  wasmDisassemblyCallCount: directCallCount,
  wasmDisassemblyDirectCalls: { linkedLeafCalls, virtualGoodCalls, benchLinkedCalls },
  deterministicCacheOutput: true
};
console.log("ACCEPT M0 OSS synthetic parser/link/status smoke");
console.log(`whole-unit vector ${actual.join(",")}`);
console.log(`whole-unit direct-call linked->leaf wasm-direct=1 module-bytes=${compiled.module.length}`);
console.log(`whole-unit runtime-abi ${compiled.manifest.abi.version} result=${compiled.manifest.abi.result}`);
console.log(`whole-unit compile ${JSON.stringify(metadata)}`);
console.log(`whole-unit direct-calls disassembly actual linked->leaf=${linkedLeafCalls} virtual->Good.value=${virtualGoodCalls} benchLinked->unit_linked=${benchLinkedCalls}`);
console.log("whole-unit call-mismatch=0");
console.log("whole-unit negatives idiv=REJECT iload-to-i2l=REJECT missing-dependency=REJECT duplicate-declared-class/path=REJECT");
console.log(`whole-unit guards class-init-hit=${runtime.classInitHits} class-init-miss=${runtime.classInitMisses} virtual-hit=${runtime.virtualHits} virtual-miss=${runtime.virtualMisses}`);
console.log(`whole-unit handles ${runtime.calls.filter((callName) => /field|array/.test(callName)).join(",")}`);
console.log(`whole-unit dependencies ${compiled.manifest.dependencyManifest.map((entry) => entry.name).join(",")}`);
console.log(`whole-unit provenance fixture=${compiled.manifest.provenance.sourceHashes.fixture} compiler=${compiled.manifest.provenance.sourceHashes.compiler} forbidden=${compiled.manifest.provenance.forbiddenPayloadScan.status}`);
console.log(`whole-unit toolchain ${JSON.stringify(compiled.manifest.provenance.toolchain)}`);
console.log(`whole-unit cache persistence=${compiled.manifest.cachePersistence} record-integrity=${verifyCacheRecord(compiled.module, compiled.manifest.cacheRecord)} identity-mutation-miss=true corrupted-output-reject=true`);
console.log("whole-unit memory=sampled-process-RSS handles=byte-offsets object/array=host-owned");
console.log("whole-unit fallback=host-oracle-only original-args zero-frame=not-connected");
console.log("M1 REJECT: Zero frame/GC/monitors/real class-init/dispatch/exceptions/cache/resource gates open");
