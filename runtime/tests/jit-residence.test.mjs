import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const patch = readFileSync(new URL("../OpenJDK/patches/0025-zero-wasm-jit-residence-stats.patch", import.meta.url), "utf8");
const baseline = readFileSync(new URL("../OpenJDK/patches/0022-zero-wasm-jit-direct-entry-typed-inline.patch", import.meta.url), "utf8");
const cppPath = "src/hotspot/share/interpreter/zero/zeroWasmCompiler.cpp";
const headerPath = "src/hotspot/share/interpreter/zero/zeroWasmResidence.hpp";
function fileDiff(text, path) {
  const section = text.split("diff --git a/" + path + " b/" + path + "\n")[1];
  assert.ok(section, "missing patch path " + path);
  return section.split("\ndiff --git ")[0];
}
function postImage(text) {
  return text.split("\n").filter(line => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" ")).map(line => line.slice(1)).join("\n");
}
const header = postImage(fileDiff(patch, headerPath));
const factoryCode = header.split("// MCWEB_RESIDENCE_FACTORY_BEGIN\n")[1].split("// MCWEB_RESIDENCE_FACTORY_END")[0];
// Tests execute the exact factory shipped in the OpenJDK header, not a mirror.
const factory = new Function(factoryCode + "\nreturn makeResidenceLedger;")();
function ledger(options = {}) { return factory({ worker: 123, ...options }); }
function emJs(source, name) {
  const match = source.match(new RegExp("EM_JS\\([^,]+, " + name + ", \\(([^]*?)\\), \\{([^]*?)\\n\\}\\);"));
  assert.ok(match, "missing EM_JS " + name);
  return { names: match[1].split(",").map(arg => arg.trim().match(/(\w+)$/)[1]), body: match[2] };
}
// Recover the pinned installers from their source patch, then apply the new
// matching source hunks. No ignored build tree, compiler or browser is needed.
let installerSource = postImage(fileDiff(baseline, cppPath));
for (const hunk of fileDiff(patch, cppPath).split(/^@@[^\n]*\n/m).slice(1)) {
  const old = hunk.split("\n").filter(line => /^[ -]/.test(line)).map(line => line.slice(1)).join("\n").replace(/\n$/, "");
  const next = hunk.split("\n").filter(line => /^[ +]/.test(line)).map(line => line.slice(1)).join("\n").replace(/\n$/, "");
  if (old && installerSource.includes(old)) installerSource = installerSource.replace(old, next);
}
const singleInstaller = emJs(installerSource, "zwc_install");
const unitInstaller = emJs(installerSource, "zwc_install_unit");
assert.equal(unitInstaller.names.at(-1), "residence");
assert.equal(singleInstaller.names.at(-1), "residence");

function install(r, { entry = 100, method = 200, gen = 1, slots = [101], bytes = 100, imports = [], kind = "jit", table = new Map() } = {}) {
  const build = kind === "ffi" ? 0 : r.reserve(entry, method, gen, slots[0], slots[1] || 0, 0);
  const id = r.begin(bytes, slots, kind, 7);
  r.moduleCreated(id); imports.forEach((fn, i) => r.bind(id, i, fn)); r.instanceCreated(id);
  const functions = slots.map(() => function originalFixtureExport() {});
  functions.forEach((fn, i) => r.register(id, i, slots[i], fn));
  slots.forEach((slot, i) => { const previous = table.get(slot); table.set(slot, functions[i]); r.written(id, i, slot, previous); });
  if (build) r.finish(build, true, slots.length > 1, gen);
  return { id, build, functions, table, entry, method, gen, slots };
}
function retire(r, item, reason = 2) { r.retire(item.entry, item.method, item.gen, item.slots[0], item.slots[1] || 0, reason, 0); }

test("unit bytes counted once across sibling exports; native retirement does not remove table roots", () => {
  const r = ledger(), a = install(r, { slots: [101, 102], bytes: 777 });
  let s = r.snapshot();
  assert.equal(s.incomplete, false); assert.equal(s.knownReachability.units, 1);
  assert.equal(s.knownReachability.encodedBytes, 777); assert.equal(s.knownReachability.tableSlots, 2);
  r.retire(a.entry, a.method, a.gen, 0, 102, 4, 0);
  s = r.snapshot();
  assert.equal(s.knownReachability.retiredRoots, 1); assert.equal(s.knownReachability.currentRoots, 1);
  assert.equal(s.knownReachability.mixedSiblingUnits, 1);
  assert.equal(s.knownReachability.mixedSiblingEncodedBytes, 777);
  assert.equal(s.knownReachability.tableLagMarginalEncodedBytes, 0);
  assert.equal(s.knownReachability.retiredBuildGenerations, 1);
});

test("direct import keeps its exact old unit after table reuse, with overlapping attribution", () => {
  const r = ledger(), table = new Map(), a = install(r, { table });
  retire(r, a);
  const b = install(r, { entry: 300, method: 400, slots: [201], imports: [a.functions[0]], table, bytes: 200 });
  assert.equal(r.snapshot().knownReachability.tableLagMarginalEncodedBytes, 0);
  install(r, { gen: 2, table, bytes: 300 });
  const s = r.snapshot("after reuse", true);
  assert.equal(s.incomplete, false); assert.equal(s.knownReachability.tableSlots, 2);
  assert.equal(s.knownReachability.units, 3); assert.equal(s.knownReachability.encodedBytes, 600);
  assert.equal(s.knownReachability.importOnlyUnits, 1); assert.equal(s.knownReachability.importOnlyEncodedBytes, 100);
  assert.equal(s.knownReachability.fullyRetiredUnits, 1);
  assert.equal(s.cumulative.overwrittenRetired, 1);
  assert.deepEqual(s.units.find(u => u.id === b.id).imports[0].target, { unit: a.id, ordinal: 0 });
});

test("unimported retired generation disappears from modeled closure after overwrite", () => {
  const r = ledger(), a = install(r); retire(r, a);
  assert.equal(r.snapshot().knownReachability.tableLagMarginalEncodedBytes, 100);
  install(r, { gen: 2, table: a.table });
  assert.equal(r.snapshot().knownReachability.units, 1);
  assert.equal(r.snapshot().cumulative.attempts, 2);
});

test("fixed table working set separates continued retired-generation growth from reusable roots", () => {
  for (const retainImports of [false, true]) {
    const r = ledger(), table = new Map();
    let a = install(r, { table, slots: [101], bytes: 100 });
    let b = install(r, { table, entry: 300, method: 400, slots: [201], bytes: 200, imports: retainImports ? a.functions : [] });
    for (let cycle = 1; cycle <= 4; cycle++) {
      r.sweep(0); retire(r, a);
      a = install(r, { table, gen: cycle + 1, slots: [101], bytes: 100, imports: retainImports ? b.functions : [] });
      retire(r, b);
      b = install(r, { table, entry: 300, method: 400, gen: cycle + 1, slots: [201], bytes: 200, imports: retainImports ? a.functions : [] });
      r.sweep(1);
      const s = r.snapshot();
      assert.equal(s.incomplete, false); assert.equal(s.knownReachability.tableSlots, 2);
      assert.equal(s.knownReachability.encodedBytes, retainImports ? 300 * (cycle + 1) : 300);
      assert.equal(s.cumulative.attempts, 2 * (cycle + 1));
      assert.equal(s.cumulative.sweepsCompleted, cycle);
    }
  }
});

test("import graph closure visits units only once even in a synthetic cycle", () => {
  const r = ledger(), a = install(r), b = install(r, { entry: 300, method: 400, slots: [201], imports: a.functions });
  // Deliberately malformed event order exercises closure robustness; actual
  // installers bind imports before instantiation and cannot create this cycle.
  r.bind(a.id, 0, b.functions[0]);
  assert.equal(r.snapshot().knownReachability.units, 2);
  assert.equal(r.snapshot().knownReachability.encodedBytes, 200);
});

test("FFI permanent roots and failed/abandoned reservations are distinct", () => {
  const r = ledger(); install(r, { kind: "ffi", slots: [90], bytes: 40 });
  const build = r.reserve(1, 2, 1, 100, 101, 0); r.pending(build); r.drop(build, 101);
  assert.equal(r.snapshot().records.reservations, 1); r.drop(build);
  const failed = r.begin(30, [100], "jit", 7); r.failed(failed);
  const s = r.snapshot();
  assert.equal(s.incomplete, false); assert.equal(s.knownReachability.ffiRoots, 1);
  assert.equal(s.knownReachability.encodedBytes, 40); assert.equal(s.cumulative.attemptedBytes, 70);
  assert.equal(s.cumulative.instances, 1); assert.equal(s.cumulative.failures, 1);
  assert.equal(s.records.reservations, 0); assert.equal(s.cumulative.abandonedBuilds, 1);
});

test("cache assignment changes cannot merge distinct build identities", () => {
  const r = ledger(), a = install(r); retire(r, a);
  const b = install(r, { method: 201, gen: 2, table: a.table });
  const units = r.snapshot("detail", true).units;
  assert.notEqual(units[0].exports[0].build, units[1].exports[0].build);
  assert.notEqual(units[0].exports[0].assignment, units[1].exports[0].assignment);
  r.retire(b.entry, a.method, 2, 101, 0, 2, 0);
  assert.equal(r.snapshot().incomplete, true);
});

test("unobserved table mutation and unknown generated import invalidate evidence", () => {
  const r = ledger();
  install(r, { imports: [function unknownCallee() {}] });
  assert.equal(r.snapshot().incomplete, true); assert.equal(r.snapshot().cumulative.unknownImports, 1);
  const s = ledger(), a = install(s); retire(s, a); a.table.set(101, function outsideWriter() {});
  install(s, { table: a.table, gen: 2 });
  assert.equal(s.snapshot().incomplete, true);
});

test("observer record and output budgets fail incomplete, never silently plateau", () => {
  const emitted = [], r = ledger({ unitLimit: 1, reportLimit: 2, emit: row => emitted.push(row) });
  const a = install(r); retire(r, a);
  assert.equal(r.begin(20, [102], "jit", 7), 0);
  for (let i = 0; i < 10; i++) r.report("bounded");
  const s = r.snapshot();
  assert.equal(s.incomplete, true); assert.equal(s.records.units, 1);
  assert.equal(s.cumulative.droppedUnits, 1); assert.equal(emitted.length, 2);
  assert.ok(s.cumulative.droppedReports > 0);
  for (const [option, mutate] of [
    ["buildLimit", x => x.reserve(1, 2, 1, 1, 0, 0)],
    ["exportLimit", x => x.begin(1, [1], "jit", 7)],
    ["edgeLimit", x => { const id = x.begin(1, [1], "jit", 7); x.bind(id, 0, () => {}); }],
  ]) { const x = ledger({ [option]: 0 }); mutate(x); assert.equal(x.snapshot().incomplete, true); }
});

test("snapshots contain only numeric/string data and cannot mutate the ledger", () => {
  const r = ledger(); install(r);
  const detail = r.snapshot("details", true);
  const visit = value => { assert.notEqual(typeof value, "function"); if (value && typeof value === "object") for (const child of Object.values(value)) visit(child); };
  visit(detail);
  detail.units[0].exports[0].native = "retired";
  assert.equal(r.snapshot().knownReachability.currentRoots, 1);
});

function mockInstaller({ r = ledger(), single = false, disabled = false, observerThrows = false, moduleFails = false, instanceFails = false, failSet = 0, directTarget } = {}) {
  const table = new Map(), buffer = new ArrayBuffer(2048), errors = [];
  for (let i = 1; i < 8; i++) table.set(i, function staticHelper() {});
  const slots = single ? [101] : [101, 102];
  new Int32Array(buffer, 128, slots.length).set(slots);
  if (directTarget) { table.set(99, directTarget); new Int32Array(buffer, 64, 1)[0] = 99; }
  const build = single ? 0 : r.reserve(100, 200, 1, 101, 102, 0);
  const context = vm.createContext({ wasmMemory: { buffer }, ___stack_pointer: 1,
    performance: { now: () => 0 }, err: text => errors.push(text),
    wasmTable: { get: slot => table.get(slot), set: (slot, fn) => { if (slot === failSet) throw Error("fixture set failure"); table.set(slot, fn); } },
    WebAssembly: { Module: class { constructor() { if (moduleFails) throw Error("fixture Module failure"); } },
      Instance: class { constructor() { if (instanceFails) throw Error("fixture Instance failure"); this.exports = { 0: function body0() {}, 1: function body1() {}, f: function ffi() {} }; } } } });
  if (disabled) Object.defineProperty(context, "__zwcResidence", { get() { throw Error("disabled observer accessed"); } });
  else if (observerThrows) context.__zwcResidence = new Proxy(r, { get(target, key) { if (key === "problem") return target.problem; return () => { throw Error("fixture observer failure"); }; } });
  else context.__zwcResidence = r;
  const code = single ? singleInstaller : unitInstaller;
  const fn = vm.runInContext("(function(" + code.names.join(",") + ") {" + code.body + "\n})", context);
  const values = { bytes: 0, len: 10, slot: 101, slots: 128, n: slots.length, invoke: single ? 0 : 1,
    subtype: 2, flcall: 3, fbail: 4, frem: 5, drem: 6, clock: 7, direct: 64, ndirect: directTarget ? 1 : 0, residence: disabled ? 0 : 1 };
  const result = fn(...code.names.map(name => values[name]));
  return { result, r, table, build, errors };
}

test("actual patched installers preserve real success with diagnostics off or throwing", () => {
  for (const single of [false, true]) {
    assert.equal(mockInstaller({ single, disabled: true }).result, 1);
    const observed = mockInstaller({ single, observerThrows: true });
    assert.equal(observed.result, 1); assert.equal(observed.r.snapshot().incomplete, true);
  }
});

test("actual patched unit installer counts constructor and partial-publication failures", () => {
  const a = mockInstaller({ moduleFails: true });
  assert.equal(a.result, 0); assert.equal(a.r.snapshot().cumulative.modules, 0);
  const b = mockInstaller({ instanceFails: true });
  assert.equal(b.result, 0); assert.equal(b.r.snapshot().cumulative.modules, 1); assert.equal(b.r.snapshot().cumulative.instances, 0);
  const c = mockInstaller({ failSet: 102 });
  assert.equal(c.result, 0); c.r.finish(c.build, false, false, 0);
  const s = c.r.snapshot("partial", true);
  assert.equal(s.incomplete, false); assert.equal(s.cumulative.partialFailures, 1);
  assert.equal(s.cumulative.instances, 1); assert.equal(s.knownReachability.tableSlots, 1);
  assert.equal(s.knownReachability.notCurrentRoots, 1);
  assert.equal(s.knownReachability.encodedBytes, 10);
  assert.equal(s.knownReachability.retiredRoots, 0);
  assert.equal(s.knownReachability.tableLagMarginalEncodedBytes, 0);
});

test("actual installer binds dN identity at wasmTable.get, not after slot reuse", () => {
  const r = ledger(), a = install(r, { slots: [99] });
  const observed = mockInstaller({ r, directTarget: a.functions[0] });
  assert.equal(observed.result, 1); r.finish(observed.build, true, true, 1);
  assert.equal(r.snapshot().incomplete, false);
  const imported = r.snapshot("details", true).units.at(-1).imports[0];
  assert.deepEqual(imported.target, { unit: a.id, ordinal: 0 });
});

test("native EM_JS diagnostic wrappers cannot propagate helper exceptions", () => {
  const context = vm.createContext({ __zwcResidence: { safe() { throw Error("observer failure"); }, problem() {} } });
  for (const name of ["build", "finish", "retire", "drop", "pending", "sweep"]) {
    const code = emJs(header, "zwc_residence_" + name);
    const fn = vm.runInContext("(function(" + code.names.join(",") + ") {" + code.body + "\n})", context);
    assert.doesNotThrow(() => fn(...code.names.map(() => 1)));
  }
});

test("real own Wasm exports keep identity through Table and direct imports snapshot the old function", () => {
  // Encode our two tiny source-authored programs: () => constant and
  // () => imported d0(). No downloaded/precompiled JVM or game binary.
  const uleb = value => { const bytes = []; do { const next = value & 127; value >>>= 7; bytes.push(next | (value ? 128 : 0)); } while (value); return bytes; };
  const text = value => [...uleb(value.length), ...Buffer.from(value)];
  const section = (id, bytes) => [id, ...uleb(bytes.length), ...bytes];
  function ownProgram({ constant, importCall = false }) {
    const type = section(1, [1, 0x60, 0, 1, 0x7f]);
    const imports = importCall ? section(2, [1, ...text("env"), ...text("d0"), 0, 0]) : [];
    const body = importCall ? [0, 0x10, 0, 0x0b] : [0, 0x41, constant, 0x0b];
    return Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...imports,
      ...section(3, [1, 0]), ...section(7, [1, ...text("f"), 0, importCall ? 1 : 0]),
      ...section(10, [1, ...uleb(body.length), ...body])]);
  }
  const r = ledger(), table = new WebAssembly.Table({ element: "anyfunc", initial: 3 });
  function actual(bytes, { slot, entry, method, gen = 1, imported } = {}) {
    const build = r.reserve(entry, method, gen, slot, 0, 0), id = r.begin(bytes.length, [slot], "jit", 0);
    const module = new WebAssembly.Module(bytes); r.moduleCreated(id);
    if (imported) r.bind(id, 0, imported);
    const instance = new WebAssembly.Instance(module, imported ? { env: { d0: imported } } : {}); r.instanceCreated(id);
    const fn = instance.exports.f; assert.equal(fn, instance.exports.f);
    r.register(id, 0, slot, fn);
    const previous = table.get(slot); table.set(slot, fn); r.written(id, 0, slot, previous);
    assert.equal(table.get(slot), fn);
    r.finish(build, true, false, gen);
    return { id, fn };
  }
  const firstBytes = ownProgram({ constant: 7 }), callerBytes = ownProgram({ importCall: true });
  const first = actual(firstBytes, { slot: 1, entry: 100, method: 200 });
  const caller = actual(callerBytes, { slot: 2, entry: 300, method: 400, imported: table.get(1) });
  assert.equal(caller.fn(), 7);
  r.retire(100, 200, 1, 1, 0, 2, 0);
  const replacement = actual(ownProgram({ constant: 9 }), { slot: 1, entry: 100, method: 200, gen: 2 });
  assert.notEqual(replacement.fn, first.fn); assert.equal(table.get(1)(), 9);
  assert.equal(caller.fn(), 7); // immutable import still executes the old body
  const snapshot = r.snapshot("actual API identity", true);
  assert.equal(snapshot.incomplete, false); assert.equal(snapshot.knownReachability.tableSlots, 2);
  assert.equal(snapshot.knownReachability.units, 3); assert.equal(snapshot.knownReachability.importOnlyUnits, 1);
  assert.equal(snapshot.knownReachability.encodedBytes, 2 * firstBytes.length + callerBytes.length);
  assert.deepEqual(snapshot.units.find(unit => unit.id === caller.id).imports[0].target, { unit: first.id, ordinal: 0 });
});
