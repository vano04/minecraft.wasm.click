#!/usr/bin/env node
// Source-integrity gate for the C3b Stage-1 structural-only implementation.
import crypto from "node:crypto";
import fs from "node:fs";

const paths = {
  globals: "OpenJDK/work/jdk25/src/hotspot/cpu/zero/globals_zero.hpp",
  interpreter: "OpenJDK/work/jdk25/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp",
  baseline: "OpenJDK/work/jdk25/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp",
  fixture: "OpenJDK/tests/ZeroReferenceStoreGroupRelocationFixture.java",
  probe: "OpenJDK/tests/ZeroReferenceStoreGroupRelocationProbe.java"
};
const collisionFlags = [
  "UseZeroWasmLinkedReferenceStoreGroupRelocation",
  "UseZeroWasmLinkedGroup", "UseZeroWasmLinkedIntArray",
  "UseZeroWasmLinkedIntArrayStore", "UseZeroWasmLinkedBenchmark",
  "UseZeroWasmLinkedRefArrayLoad", "UseZeroWasmLinkedRefArrayStore",
  "UseZeroWasmLinkedReferenceStoreGroup",
  "UseZeroWasmReferenceStoreGroupPerf",
  "UseZeroWasmBaseline", "UseZeroWasmJIT"
];
const load = () => Object.fromEntries(Object.entries(paths).map(
    ([name, path]) => [name, fs.readFileSync(path, "utf8")]));
const once = (text, token, label) => {
  const count = text.split(token).length - 1;
  if (count !== 1) throw new Error(label + " count=" + count);
};
const requireToken = (text, token, label) => {
  if (!text.includes(token)) throw new Error(label + " missing");
};
const sliceFunction = (text, signature, nextSignature) => {
  const start = text.indexOf(signature);
  if (start < 0) throw new Error("missing function " + signature);
  const end = nextSignature ? text.indexOf(nextSignature, start + signature.length) : -1;
  return text.slice(start, end < 0 ? text.length : end);
};

const validate = (source) => {
  once(source.globals,
      "product(bool, UseZeroWasmLinkedReferenceStoreGroupRelocation, false",
      "false-by-default flag");
  once(source.globals,
      "ZeroWasmLinkedReferenceStoreGroupRelocationMemoryLimitForTest",
      "memory-limit flag");
  once(source.globals,
      "ZeroWasmLinkedReferenceStoreGroupRelocationCacheMutationForTest",
      "cache-mutation flag");
  requireToken(source.interpreter,
      "const bool zero_reference_store_group_relocation_collision =",
      "entry collision");
  requireToken(source.interpreter,
      "&& !zero_reference_store_group_relocation_collision && (skip) < 0",
      "OSR collision");
  requireToken(source.interpreter,
      "RELOCATION_STAGE1_REJECT reason=flag-collision",
      "collision marker");
  const interpreterCollision = sliceFunction(source.interpreter,
      "const bool zero_reference_store_group_relocation_collision =",
      "// Zero's browser runtime is single-threaded.");
  const baselineCollision = sliceFunction(source.baseline,
      "const bool reference_store_group_relocation_collision =",
      "if (ref_array_collision || ref_array_store_collision");
  for (const flag of collisionFlags) {
    requireToken(interpreterCollision, flag, "entry collision flag " + flag);
    requireToken(baselineCollision, flag, "adapter collision flag " + flag);
  }

  requireToken(source.baseline,
      "__mcwebZeroReferenceStoreGroupRelocationCache", "cache namespace");
  requireToken(source.baseline,
      "build_reference_store_group_relocation_module", "module builder");
  requireToken(source.baseline,
      "groupedReferenceStoreAcrossRelocation", "single export");
  requireToken(source.baseline, "linked_type(types, 9)", "dispatcher ABI");
  requireToken(source.baseline,
      "functions.uleb(0); // dispatcher\n  functions.uleb(1); // phase0\n  functions.uleb(2); // phase1\n  functions.uleb(1); // leaf\n  functions.uleb(1); // relay\n  functions.uleb(2); // commit",
      "six function type order");
  requireToken(source.baseline,
      "addFunction(exported, \"jiiiiiiiii\")", "table ABI");
  requireToken(source.baseline,
      "ZeroReferenceStoreGroupRelocationFixture#", "cache class contract");
  requireToken(source.baseline,
      "ZeroReferenceStoreGroupRelocationProbe#forceYoungRelocation()V@bci8",
      "cache probe contract");
  requireToken(source.baseline,
      "orchestrator-bci8:oops=0,2,3;token=4:int;depth=0|",
      "cache root-map contract");
  requireToken(source.baseline,
      "dispatcher9->i64;phase0:i32->i32;phase1:3i32->void",
      "cache phase ABI contract");
  requireToken(source.baseline,
      "compiler,digest,bytes,memory,metadata,slot,card-layout,phase-abi,phase-edges,root-map,poison",
      "planned mutation vocabulary");
  requireToken(source.baseline,
      "C3b Stage-1 must not install or arm a relocation module",
      "unarmed invariant");
  for (const forbiddenState of [
    "reference_store_group_relocation_continuation_armed",
    "reference_store_group_relocation_continuation_token",
    "reference_store_group_relocation_pending",
    "reference_store_group_relocation_saved_oop"
  ]) {
    if (source.baseline.includes(forbiddenState)
        || source.interpreter.includes(forbiddenState)) {
      throw new Error("forbidden continuation state " + forbiddenState);
    }
  }
  if (source.baseline.includes(
      "zbb_reference_store_group_relocation_install_stage1(")) {
    throw new Error("Stage-1 installer invocation");
  }

  // The Stage-1 adapter branch is whitelisted verbatim. Anything added inside
  // it -- an installer or builder call, a module/slot assignment, a weakened
  // guarantee, an armed continuation -- changes this text and is rejected.
  const branchStart = source.baseline.indexOf(
      "  if (UseZeroWasmLinkedReferenceStoreGroupRelocation) {");
  if (branchStart < 0) throw new Error("unarmed branch missing");
  const branchEnd = source.baseline.indexOf("\n  }\n", branchStart);
  if (branchEnd < 0) throw new Error("unarmed branch unterminated");
  const branch = source.baseline.slice(branchStart, branchEnd + 5);
  const expectedBranch = [
    "  if (UseZeroWasmLinkedReferenceStoreGroupRelocation) {",
    "    (void)&build_reference_store_group_relocation_module;",
    "    (void)&zbb_reference_store_group_relocation_install_stage1;",
    "    (void)kReferenceStoreGroupRelocationClassContract;",
    "    (void)kReferenceStoreGroupRelocationProbeContract;",
    "    (void)kReferenceStoreGroupRelocationRootMaps;",
    "    (void)kReferenceStoreGroupRelocationPhaseAbi;",
    "    (void)kReferenceStoreGroupRelocationPhaseEdges;",
    "    guarantee(_linked_reference_store_group_relocation_module_id == -1",
    "              && _linked_reference_store_group_relocation_slot == -1,",
    "              \"C3b Stage-1 must not install or arm a relocation module\");",
    "    return NotRun;",
    "  }",
    ""
  ].join("\n");
  if (branch !== expectedBranch) {
    throw new Error("unarmed branch is not the exact whitelisted text");
  }
  if (source.baseline.indexOf(
      "  if (UseZeroWasmLinkedReferenceStoreGroupRelocation) {",
      branchStart + 1) >= 0) {
    throw new Error("duplicate relocation adapter branch");
  }

  // Exact symbol closure. Two occurrences each: the definition and the single
  // discard inside the whitelisted branch. A wrapper, an indirect call through
  // a function pointer, or any assignment to the module/slot state adds one.
  for (const [symbol, count] of [
    ["build_reference_store_group_relocation_module", 2],
    ["zbb_reference_store_group_relocation_install_stage1", 2],
    ["_linked_reference_store_group_relocation_module_id", 2],
    ["_linked_reference_store_group_relocation_slot", 2]
  ]) {
    const seen = source.baseline.split(symbol).length - 1;
    if (seen !== count) {
      throw new Error("symbol closure " + symbol + " count=" + seen
          + " expected=" + count);
    }
  }
  for (const state of [
    "_linked_reference_store_group_relocation_module_id",
    "_linked_reference_store_group_relocation_slot"
  ]) {
    const declaration = "static THREAD_LOCAL int " + state + " = -1;";
    once(source.baseline, declaration, "state declaration " + state);
    const rest = source.baseline.split(declaration).join("");
    // "= -1" in the declaration is the only assignment; "== -1" in the
    // guarantee is a comparison and must not be mistaken for one.
    if (new RegExp(state + "\\s*=(?!=)").test(rest)) {
      throw new Error("relocation state assignment outside its declaration: "
          + state);
    }
  }

  // Stage-1 cache metadata closure: one namespace, one immutable owned slot,
  // and every contract carried on the frozen record.
  once(source.baseline, "__mcwebZeroReferenceStoreGroupRelocationCache ||=",
      "cache namespace initialiser");
  const installer = sliceFunction(source.baseline,
      "EM_JS(int, zbb_reference_store_group_relocation_install_stage1,",
      "EM_JS(int, zbb_reference_store_group_cache_mutation,");
  for (const token of [
    "cached.compiler === \"zero-baseline-abi-v1\"", "cached.digest === digest",
    "cached.bytes === length", "sameBytes(cached.binary, binary)",
    "cached.memory === importedMemory", "cached.memoryPages === memoryPages",
    "cached.metadata === metadata", "cached.classContract === classContract",
    "cached.probeContract === probeContract", "cached.rootMaps === rootMaps",
    "cached.phaseAbi === phaseAbi", "cached.phaseEdges === phaseEdges",
    "cached.mutationVocabulary === mutationVocabulary",
    "cached.slot === cached.ownedSlot", "cached.instance && exportMatches",
    "Object.freeze(", "writable: false",
    "Object.keys(instance.exports).length !== 1",
    "getWasmTableEntry(ownedSlot) !== exported"
  ]) requireToken(installer, token, "cache metadata " + token);
  const record = /value: Object\.freeze\(\{([\s\S]*?)\}\)/.exec(installer);
  if (!record) throw new Error("cache record shape");
  const recordKeys = record[1]
      .split(",").map((entry) => entry.trim().split(":")[0].trim())
      .filter(Boolean).sort().join(",");
  if (recordKeys !== "binary,bytes,classContract,compiler,digest,export,id,"
      + "instance,memory,memoryPages,metadata,mutationVocabulary,ownedSlot,"
      + "phaseAbi,phaseEdges,probeContract,rootMaps,slot") {
    throw new Error("cache record key closure=" + recordKeys);
  }

  const dispatcher = sliceFunction(source.baseline,
      "static void emit_reference_store_group_relocation_dispatcher(",
      "static void emit_reference_store_group_relocation_leaf(");
  for (const guard of [
    "original != kept", "token == 0", "null array",
    "header end > effective bytes", "unsigned index >= length",
    "widened element end", "assignability predicate",
    "widened card address overflow", "widened card end"
  ]) requireToken(dispatcher, guard, "dispatcher guard " + guard);
  if (dispatcher.includes("body.u8(0x36)") || dispatcher.includes("body.u8(0x3a)")) {
    throw new Error("dispatcher owns a memory store");
  }
  const phase0 = sliceFunction(source.baseline,
      "static void emit_reference_store_group_relocation_phase0(",
      "static void emit_reference_store_group_relocation_phase1(");
  requireToken(phase0, "ReferenceStoreGroupRelocationRelay", "phase0 relay edge");
  if (/0x(?:28|36|3a)/.test(phase0)) throw new Error("phase0 memory opcode");
  const phase1 = sliceFunction(source.baseline,
      "static void emit_reference_store_group_relocation_phase1(",
      "static void emit_reference_store_group_relocation_commit(");
  requireToken(phase1, "ReferenceStoreGroupRelocationRelay", "phase1 relay edge");
  requireToken(phase1, "ReferenceStoreGroupRelocationCommit", "phase1 commit edge");
  if (!/ReferenceStoreGroupRelocationCommit\);\s*body\.u8\(0x0b\);\s*\}/s.test(phase1)) {
    throw new Error("phase1 post-commit tail");
  }
  const commit = sliceFunction(source.baseline,
      "static void emit_reference_store_group_relocation_commit(",
      "// Benchmark-only bodies");
  requireToken(commit, "emit_reference_store_group_commit(body, layout)",
      "exact commit reuse");

  // Exact emitter bodies. leaf, relay, phase0, phase1 and commit are frozen
  // verbatim; the dispatcher is frozen by digest because guard mutation must
  // be rejected as strictly as an added instruction.
  const emitters = {
    leaf: [
      "static void emit_reference_store_group_relocation_leaf(WasmBuf& body) {",
      "  empty_locals(body);",
      "  body.u8(0x20); body.uleb(0); body.u8(0x0b);",
      "}"
    ].join("\n"),
    relay: [
      "static void emit_reference_store_group_relocation_relay(WasmBuf& body) {",
      "  empty_locals(body);",
      "  body.u8(0x20); body.uleb(0);",
      "  body.u8(0x10); body.uleb(ReferenceStoreGroupRelocationLeaf);",
      "  body.u8(0x0b);",
      "}"
    ].join("\n"),
    phase0: [
      "static void emit_reference_store_group_relocation_phase0(WasmBuf& body) {",
      "  empty_locals(body);",
      "  body.u8(0x20); body.uleb(0);",
      "  body.u8(0x10); body.uleb(ReferenceStoreGroupRelocationRelay);",
      "  body.u8(0x0b);",
      "}"
    ].join("\n"),
    phase1: [
      "static void emit_reference_store_group_relocation_phase1(WasmBuf& body) {",
      "  empty_locals(body);",
      "  body.u8(0x20); body.uleb(0);",
      "  body.u8(0x20); body.uleb(1);",
      "  body.u8(0x10); body.uleb(ReferenceStoreGroupRelocationRelay);",
      "  body.u8(0x20); body.uleb(2);",
      "  body.u8(0x10); body.uleb(ReferenceStoreGroupRelocationCommit);",
      "  body.u8(0x0b);",
      "}"
    ].join("\n"),
    commit: [
      "static void emit_reference_store_group_relocation_commit(",
      "    WasmBuf& body, const LinkedRefArrayStoreLayout& layout) {",
      "  emit_reference_store_group_commit(body, layout);",
      "}"
    ].join("\n")
  };
  for (const [name, text] of Object.entries(emitters)) {
    once(source.baseline, text, "exact emitter body " + name);
  }
  const dispatcherDigest = crypto.createHash("sha256")
      .update(dispatcher.trimEnd()).digest("hex");
  if (dispatcherDigest !== "19bc78f21fece38eb464be4b341b29c46f8ab8833dfa14208d015ccf0050b726") {
    throw new Error("dispatcher emitter digest=" + dispatcherDigest
        + " bytes=" + dispatcher.trimEnd().length);
  }

  // No non-commit emitter may write memory. Every Wasm store family, the bulk
  // and atomic prefixes, memory.grow and call_indirect count as a write.
  const writeOpcodes = [0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e,
                        0x3f, 0x40, 0x11, 0xfc, 0xfe];
  const writeEmitters = { dispatcher, phase0, phase1,
                          leaf: emitters.leaf, relay: emitters.relay };
  for (const [name, text] of Object.entries(writeEmitters)) {
    for (const opcode of writeOpcodes) {
      const literal = "0x" + opcode.toString(16).padStart(2, "0");
      if (new RegExp("body\\\\.u8\\\\(" + literal + "\\\\)").test(text)) {
        throw new Error(name + " emits write opcode " + literal);
      }
    }
    if (/body\.raw\(|memcpy|memset/.test(text)) {
      throw new Error(name + " emits a bulk write");
    }
  }

  // Module topology: three types, six functions, one export, no table or
  // element section, and exactly six code bodies.
  const builder = sliceFunction(source.baseline,
      "static int build_reference_store_group_relocation_module(",
      "enum ReferenceStoreGroupPerfFunction");
  for (const token of ["types.uleb(3);", "functions.uleb(6);",
                       "exports.uleb(1);", "code.uleb(6);",
                       "WasmBuf bodies[6];"]) {
    once(builder, token, "module topology " + token);
  }
  for (const forbidden of ["module.section(4,", "module.section(9,",
                           "module.section(0,", "module.section(6,"]) {
    if (builder.includes(forbidden)) {
      throw new Error("module declares forbidden section " + forbidden);
    }
  }
  const emitExports = builder.split("emit_linked_export(").length - 1;
  if (emitExports !== 1) throw new Error("module exports=" + emitExports);

  // Stage-1 probe body must be exactly empty: no allocation, no helper call.
  const probeBody = /public static void forceYoungRelocation\(\) \{([\s\S]*?)\n    \}/
      .exec(source.probe);
  if (!probeBody) throw new Error("probe seam missing");
  const probeStatements = probeBody[1].split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"));
  if (probeStatements.length !== 0) {
    throw new Error("Stage-1 probe body is not empty: "
        + probeStatements.join(" "));
  }

  const noMidMethodHook = [
    "maybe_run_reference_store_group_relocation_continuation",
    "run_reference_store_group_relocation_continuation",
    "resume_reference_store_group_relocation",
    "forceYoungRelocation();\n    if ("
  ];
  for (const token of noMidMethodHook) {
    if (source.baseline.includes(token) || source.interpreter.includes(token)) {
      throw new Error("forbidden continuation state/hook " + token);
    }
  }
  requireToken(source.fixture,
      "Object kept = phase0(value);\n        int token = 1;\n        ZeroReferenceStoreGroupRelocationProbe.forceYoungRelocation();\n        return phase1(values, index, value, kept, token);",
      "exact public orchestration");
  requireToken(source.fixture,
      "if (original != kept || token == 0)", "phase1 identity/token guard");
  requireToken(source.fixture,
      "return commit(values, index, relay(kept));", "phase1 commit topology");
  if (source.probe.includes("System.gc") || source.probe.includes("Runtime.getRuntime")) {
    throw new Error("Stage-1 probe executes GC");
  }
};

const selfTest = () => {
  const source = load();
  validate(source);
  const mutations = [
    ["flag-default", "globals", "Relocation, false", "Relocation, true"],
    ["phase-abi", "baseline", "linked_type(types, 9)", "linked_type(types, 8)"],
    ["cache-namespace", "baseline", "__mcwebZeroReferenceStoreGroupRelocationCache", "__wrongCache"],
    ["probe-contract", "baseline", "Probe#forceYoungRelocation()V@bci8", "Probe#forceYoungRelocation()V@bci9"],
    ["installer-invocation", "baseline", "(void)&zbb_reference_store_group_relocation_install_stage1;",
      "zbb_reference_store_group_relocation_install_stage1(nullptr, 0, nullptr, 0, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr);"],
    ["armed-state", "baseline", "static THREAD_LOCAL int _linked_reference_store_group_relocation_slot = -1;",
      "static THREAD_LOCAL int _linked_reference_store_group_relocation_slot = -1;\nstatic THREAD_LOCAL bool _linked_reference_store_group_relocation_continuation_armed = true;"],
    ["token-state", "baseline", "static THREAD_LOCAL int _linked_reference_store_group_relocation_slot = -1;",
      "static THREAD_LOCAL int _linked_reference_store_group_relocation_slot = -1;\nstatic THREAD_LOCAL jint _linked_reference_store_group_relocation_continuation_token = 1;"],
    ["mid-method-hook", "baseline", "// C3b Stage 1 is deliberately structural only.",
      "static void maybe_run_reference_store_group_relocation_continuation();\n// C3b Stage 1 is deliberately structural only."],
    ["dispatcher-store", "baseline", "body.u8(0x20); body.uleb(0); body.u8(0x45); // phase == 0",
      "body.u8(0x36); body.uleb(2); body.uleb(0);\n  body.u8(0x20); body.uleb(0); body.u8(0x45); // phase == 0"],
    ["phase0-store", "baseline", "static void emit_reference_store_group_relocation_phase0(WasmBuf& body) {\n  empty_locals(body);",
      "static void emit_reference_store_group_relocation_phase0(WasmBuf& body) {\n  empty_locals(body);\n  body.u8(0x3a);"],
    ["phase1-edge", "baseline",
      "body.u8(0x10); body.uleb(ReferenceStoreGroupRelocationCommit);\n  body.u8(0x0b);",
      "body.u8(0x10); body.uleb(ReferenceStoreGroupRelocationLeaf);\n  body.u8(0x0b);"],
    ["root-map", "baseline", "orchestrator-bci8:oops=0,2,3;token=4:int;depth=0|",
      "orchestrator-bci8:oops=0,2;token=4:int;depth=0|"],
    ["phase0-edge", "baseline", "ReferenceStoreGroupRelocationRelay);\n  body.u8(0x0b);\n}\n\nstatic void emit_reference_store_group_relocation_phase1",
      "ReferenceStoreGroupRelocationLeaf);\n  body.u8(0x0b);\n}\n\nstatic void emit_reference_store_group_relocation_phase1"],
    ["probe-call", "fixture", "forceYoungRelocation();", "forceYoungRelocatioN();"],
    ["root-token", "fixture", "int token = 1;", "int token = 0;"],
    ["gc", "probe", "// Stage 1 must not execute GC.", "System.gc(); // Stage 1 must not execute GC."],
    // Blocker 4: indirect activation. A wrapper, a function-pointer call, a
    // module/slot assignment and a weakened guarantee must all be rejected.
    ["installer-wrapper", "baseline",
      "    (void)&zbb_reference_store_group_relocation_install_stage1;",
      "    (void)&zbb_reference_store_group_relocation_install_stage1;\n    stage1_install_wrapper();"],
    ["installer-pointer", "baseline",
      "    (void)&zbb_reference_store_group_relocation_install_stage1;",
      "    int (*install)(const unsigned char*, int, const char*, int, const char*, const char*, const char*, const char*, const char*, const char*) = &zbb_reference_store_group_relocation_install_stage1;"],
    ["builder-invocation", "baseline",
      "    (void)&build_reference_store_group_relocation_module;",
      "    WasmBuf staged; build_reference_store_group_relocation_module(staged, layout);"],
    ["slot-assignment", "baseline", "    return NotRun;\n  }\n  if (UseZeroWasmReferenceStoreGroupPerf) {",
      "    _linked_reference_store_group_relocation_slot = 0;\n    return NotRun;\n  }\n  if (UseZeroWasmReferenceStoreGroupPerf) {"],
    ["weakened-guarantee", "baseline",
      "    guarantee(_linked_reference_store_group_relocation_module_id == -1",
      "    assert(_linked_reference_store_group_relocation_module_id == -1"],
    ["branch-early-return", "baseline", "    return NotRun;\n  }\n  if (UseZeroWasmReferenceStoreGroupPerf) {",
      "    return Ran;\n  }\n  if (UseZeroWasmReferenceStoreGroupPerf) {"],
    // Blocker 6: emitter identity, store families and module topology.
    ["leaf-body", "baseline",
      "  body.u8(0x20); body.uleb(0); body.u8(0x0b);\n}",
      "  body.u8(0x20); body.uleb(0); body.u8(0x1a); body.u8(0x0b);\n}"],
    ["relay-i64-store", "baseline",
      "static void emit_reference_store_group_relocation_relay(WasmBuf& body) {\n  empty_locals(body);",
      "static void emit_reference_store_group_relocation_relay(WasmBuf& body) {\n  empty_locals(body);\n  body.u8(0x37);"],
    ["dispatcher-bulk-write", "baseline",
      "  body.u8(0x20); body.uleb(0); body.u8(0x45); // phase == 0",
      "  body.u8(0xfc); body.uleb(11);\n  body.u8(0x20); body.uleb(0); body.u8(0x45); // phase == 0"],
    ["dispatcher-guard-mutation", "baseline",
      "  body.u8(0x20); body.uleb(2);\n  body.u8(0x20); body.uleb(1);\n  body.u8(0x28); body.uleb(2); body.uleb((unsigned)layout.length_offset);\n  body.u8(0x4f); // unsigned index >= length",
      "  body.u8(0x20); body.uleb(2);\n  body.u8(0x20); body.uleb(1);\n  body.u8(0x28); body.uleb(2); body.uleb((unsigned)layout.length_offset);\n  body.u8(0x4a); // unsigned index >= length"],
    ["extra-export", "baseline",
      "  emit_linked_export(exports, \"groupedReferenceStoreAcrossRelocation\",\n                     ReferenceStoreGroupRelocationDispatcher);",
      "  emit_linked_export(exports, \"groupedReferenceStoreAcrossRelocation\",\n                     ReferenceStoreGroupRelocationDispatcher);\n  emit_linked_export(exports, \"phase1\", ReferenceStoreGroupRelocationPhase1);"],
    ["extra-function", "baseline", "  functions.uleb(6);\n  functions.uleb(0); // dispatcher",
      "  functions.uleb(7);\n  functions.uleb(0); // dispatcher"],
    ["element-section", "baseline", "  module.section(7, exports);",
      "  module.section(4, table);\n  module.section(7, exports);"],
    // Blocker 7: the cache record must carry every pinned contract.
    ["cache-root-map-key", "baseline", "rootMaps, phaseAbi, phaseEdges, mutationVocabulary,",
      "phaseAbi, phaseEdges, mutationVocabulary,"],
    ["cache-slot-identity", "baseline", "&& cached.slot === cached.ownedSlot && cached.slot >= 0",
      "&& cached.slot >= 0"],
    ["cache-frozen", "baseline", "      value: Object.freeze({", "      value: ({"],
    ["cache-writable", "baseline", "      writable: false,\n      value: Object.freeze({", "      writable: true,\n      value: Object.freeze({"],
    ["cache-export-closure", "baseline",
      "        || Object.keys(instance.exports).length !== 1) return -1;",
      "        ) return -1;"],
    // Blocker 8: the Stage-1 probe seam stays exactly empty.
    ["probe-allocation", "probe", "        // Stage 1 must not execute GC.",
      "        Object filler = new Object();\n        // Stage 1 must not execute GC."],
    ["probe-helper-call", "probe", "        // Stage 1 must not execute GC.",
      "        require(true, \"seam\");\n        // Stage 1 must not execute GC."]
  ];
  for (const flag of collisionFlags) {
    mutations.push(["collision-" + flag, "interpreter", flag,
      "REMOVED_COLLISION_FLAG"]);
  }
  for (const [label, file, before, after] of mutations) {
    if (!source[file].includes(before)) throw new Error("self-test anchor missing " + label);
    const changed = { ...source,
      [file]: source[file].split(before).join(after) };
    let rejected = false;
    try { validate(changed); } catch (error) { rejected = true; }
    if (!rejected) throw new Error("self-negative accepted " + label);
  }
  console.log("reference-store-group-relocation-source-selftest=pass"
    + " negatives=" + mutations.length
    + " continuation=unarmed gc=not-executed");
};

if (process.argv[2] === "--self-test") {
  selfTest();
} else {
  validate(load());
  console.log("reference-store-group-relocation-source=pass"
    + " flags=3 funcs=6 exports=1 cache=isolated continuation=unarmed");
}
