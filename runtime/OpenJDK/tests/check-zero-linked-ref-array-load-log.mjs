#!/usr/bin/env node
// Ordered semantic checker for the isolated M2-C1 reference-array load lane.
// It treats the real interpreter opcode as the canonical fallback and never
// accepts a linked marker outside the exact CASE window that caused it.
import fs from "node:fs";

const [, , logPath, mode = "linked"] = process.argv;
if (!logPath) {
  throw new Error("usage: check-zero-linked-ref-array-load-log.mjs LOG [linked|forced|off|negative|collision|osr-collision|osr-aggregate|root|cache-poison]");
}
const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
const semanticMode = mode === "cache-poison" ? "linked" : mode;
const linkedMarker = /(REF_ARRAY_ENTER|REF_ARRAY_ADAPTER|REF_ARRAY_TABLE_CALL|REF_ARRAY_STATUS|REF_ARRAY_EXIT|REF_ARRAY_OPCODE_REEXECUTE|DIRECT_REF_LOAD)/;
const anyMarker = /(REF_ARRAY_ENTER|REF_ARRAY_ADAPTER|REF_ARRAY_TABLE_CALL|REF_ARRAY_STATUS|REF_ARRAY_EXIT|REF_ARRAY_OPCODE_REEXECUTE|DIRECT_REF_LOAD|INTERPRETER_AALOAD)/;
const normalCases = ["identity", "null-element", "covariant", "null", "negative", "length", "min-index", "empty"];
const expected = semanticMode === "root" ? ["root-liveness"]
  : semanticMode === "negative" ? []
  : semanticMode === "osr-collision" || semanticMode === "osr-aggregate"
    ? ["osr-collision"] : normalCases;

const blocks = new Map();
let current = null;
for (const [lineIndex, line] of lines.entries()) {
  const begin = line.match(/^CASE_BEGIN (.+)$/);
  const end = line.match(/^CASE_END (.+)$/);
  if (begin) {
    if (current) throw new Error(`nested case ${begin[1]}`);
    if (blocks.has(begin[1])) throw new Error(`duplicate case ${begin[1]}`);
    current = { name: begin[1], lines: [] };
    blocks.set(begin[1], current);
    continue;
  }
  if (end) {
    if (!current || current.name !== end[1]) throw new Error(`case order/end mismatch ${end[1]}`);
    current = null;
    continue;
  }
  if (current) current.lines.push({ text: line, lineIndex });
  else if (linkedMarker.test(line)) {
    throw new Error(`reference-array linked marker outside case window: ${line}`);
  }
}
if (current) throw new Error(`unterminated case ${current.name}`);
if (blocks.size !== expected.length || expected.some((name, i) => [...blocks.keys()][i] !== name)) {
  throw new Error(`case order mismatch: ${[...blocks.keys()].join(",")}`);
}

const count = (block, expression) => block.lines.filter(({ text }) => expression.test(text)).length;
const one = (block, expression, label) => {
  const found = block.lines.filter(({ text }) => expression.test(text));
  if (found.length !== 1) throw new Error(`${block.name}: ${label} count=${found.length}`);
  return found[0];
};
const pointer = (value) => {
  if (value === "0" || value === "(nil)" || value === "0x0") return 0;
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new Error(`bad pointer ${value}`);
  return Number.parseInt(value.slice(2), 16) >>> 0;
};
const expectedInput = (name, call) => {
  if (name === "identity") return { index: call, length: 3, nonnull: true, direct: true };
  if (name === "root-liveness") return { index: 0, length: 1, nonnull: true, direct: true };
  if (name === "null-element") return { index: 1, length: 3, nonnull: true, direct: true, nullResult: true };
  if (name === "covariant") return { index: 1, length: 2, nonnull: true, direct: true };
  if (name === "null") return { index: 0, length: -1, nonnull: false, reason: "null" };
  if (name === "negative") return { index: -1, length: 3, nonnull: true, reason: "bounds" };
  if (name === "length") return { index: 3, length: 3, nonnull: true, reason: "bounds" };
  if (name === "min-index") return { index: -2147483648, length: 3, nonnull: true, reason: "bounds" };
  return { index: 0, length: 0, nonnull: true, reason: "bounds" };
};

function assertOrder(records, label) {
  const positions = records.map(({ lineIndex }) => lineIndex);
  for (let i = 1; i < positions.length; i++) {
    if (!(positions[i - 1] < positions[i])) throw new Error(`${label}: event order invalid`);
  }
}

function checkCachePoison() {
  const install = lines
    .map((text, lineIndex) => ({ text, lineIndex }))
    .filter(({ text }) => /^\[zbg\] JS_INSTALL ref-array-load /.test(text));
  const hit = lines
    .map((text, lineIndex) => ({ text, lineIndex }))
    .filter(({ text }) => /^\[zbg\] JS_CACHE_HIT ref-array-load /.test(text));
  const invalidation = lines
    .map((text, lineIndex) => ({ text, lineIndex }))
    .filter(({ text }) => /^\[zbg\] JS_CACHE_INVALIDATE ref-array-load /.test(text));
  const pass = lines
    .map((text, lineIndex) => ({ text, lineIndex }))
    .filter(({ text }) => /^\[zbg\] JS_CACHE_MUTATION_PASS ref-array-load /.test(text));
  if (install.length !== 2 || hit.length !== 1 || invalidation.length !== 1 || pass.length !== 1) {
    throw new Error("cache-poison counts install=" + install.length
        + " hit=" + hit.length + " invalidation=" + invalidation.length
        + " pass=" + pass.length);
  }
  const invalidate = invalidation[0].text.match(
    /^\[zbg\] JS_CACHE_INVALIDATE ref-array-load slot=(\d+) owned-slot=(\d+) removed=1 old-callable=1 export-match=0 old-callable-after=0 poisoning=1 poison-visible=1 old-export-visible=0 poison-removed=1 poison-callable-after=0 instance-cleared=1 cache-cleared=1 last-instance-cleared=1$/);
  if (!invalidate) throw new Error("cache-poison invalidation identity/cleanup proof missing");
  const mutation = pass[0].text.match(
    /^\[zbg\] JS_CACHE_MUTATION_PASS ref-array-load mutation=poison miss=-1 old-id=(\d+) new-id=(\d+) old-slot=(\d+) new-slot=(\d+) old-owned-slot=(\d+) slot-reused=[01] old-callable-before=1 export-match=0 poisoning=1 poison-visible=1 old-export-visible=0 poison-removed=1 poison-callable-after=0 old-callable-after=0 removed=1 instance-reused=0 cache-cleared=1 last-instance-cleared=1 bytes-exact=1$/);
  if (!mutation) throw new Error("cache-poison mutation closure missing");
  const oldSlot = Number(invalidate[1]);
  const ownedSlot = Number(invalidate[2]);
  if (oldSlot !== ownedSlot || Number(mutation[3]) !== oldSlot
      || Number(mutation[5]) !== oldSlot || Number(mutation[1]) === Number(mutation[2])) {
    throw new Error("cache-poison owned-slot/id binding drift");
  }
  if (!(install[0].lineIndex < hit[0].lineIndex
      && hit[0].lineIndex < invalidation[0].lineIndex
      && invalidation[0].lineIndex < install[1].lineIndex
      && install[1].lineIndex < pass[0].lineIndex)) {
    throw new Error("cache-poison transcript order drift");
  }
  if (lines.some((line) => /poison (?:reject|cleanup reject)|CLEANUP_UNSUPPORTED|uncaught|ReferenceError|TypeError|RangeError|SyntaxError|FATAL|broken pipe/i.test(line))) {
    throw new Error("cache-poison failure/uncaught diagnostic present");
  }
  console.log("ref-array-cache-poison=pass old-slot=" + oldSlot
      + " new-slot=" + mutation[4] + " old-id=" + mutation[1]
      + " new-id=" + mutation[2]);
}

if (mode === "cache-poison") checkCachePoison();

function checkEvent(block, call, forced, allowLinked) {
  const input = expectedInput(block.name, call);
  const enterPattern =
    /^\[zbg\] REF_ARRAY_ENTER seq=(\d+) method=referenceArrayLoad static=1 params=2 raw32=1 actual-klass=objArrayKlass length-offset=(\d+) base-offset=(\d+) element-size=(\d+) limit-pages=(\d+) slot=(\d+)$/;
  const enters = block.lines.filter(({ text }) => enterPattern.test(text));
  if (!enters[call]) throw new Error(`${block.name}: REF_ARRAY_ENTER call=${call} missing`);
  const enter = enters[call];
  const sequence = Number(enter.text.match(/seq=(\d+)/)[1]);
  // The identity CASE intentionally exercises first/middle/last in one
  // strict window. Scope each event assertion to its sequence so repeated
  // calls cannot be mistaken for one another.
  const eventBlock = {
    name: block.name,
    lines: block.lines.filter(({ text }) =>
      new RegExp(`(?:^|\\s)seq=${sequence}(?:\\s|$)`).test(text)),
  };
  const adapter = one(eventBlock,
    /^\[zbg\] REF_ARRAY_ADAPTER seq=(\d+) oop=(0x[0-9a-f]+|0|\(nil\)) index=(-?\d+) length=(-?\d+) klass=(null|objArrayKlass) length-offset=(\d+) base-offset=(\d+) slot=(\d+)$/,
    "REF_ARRAY_ADAPTER");
  const table = one(eventBlock,
    /^\[zbg\] REF_ARRAY_TABLE_CALL seq=(\d+) slot=(\d+) oop=(0x[0-9a-f]+|0|\(nil\)) index=(-?\d+) limit-pages=(\d+)$/,
    "REF_ARRAY_TABLE_CALL");
  const status = one(eventBlock,
    /^\[zbg\] REF_ARRAY_STATUS seq=(\d+) status=(\d+) bci=(\d+) oop-bits=(\d+) expected-bci=(\d+) limit-pages=(\d+)$/,
    "REF_ARRAY_STATUS");
  const exit = one(eventBlock,
    /^\[zbg\] REF_ARRAY_EXIT seq=(\d+) status=(RETURN|REEXECUTE) bci=(\d+)(?: reason=([a-z-]+))?$/,
    "REF_ARRAY_EXIT");
  const enterParts = enter.text.match(/length-offset=(\d+) base-offset=(\d+) element-size=(\d+) limit-pages=(\d+) slot=(\d+)/);
  const adapterParts = adapter.text.match(/oop=(0x[0-9a-f]+|0|\(nil\)) index=(-?\d+) length=(-?\d+) klass=(null|objArrayKlass)/);
  const tableParts = table.text.match(/slot=(\d+) oop=(0x[0-9a-f]+|0|\(nil\)) index=(-?\d+) limit-pages=(\d+)/);
  const statusParts = status.text.match(/status=(\d+) bci=(\d+) oop-bits=(\d+) expected-bci=(\d+) limit-pages=(\d+)/);
  const exitParts = exit.text.match(/status=(RETURN|REEXECUTE) bci=(\d+)(?: reason=([a-z-]+))?/);
  if (!enterParts || !adapterParts || !tableParts || !statusParts || !exitParts) {
    throw new Error(`${block.name}: malformed event fields`);
  }
  const enterLimit = Number(enterParts[4]);
  const expectedLimit = forced ? 1 : 0;
  if (enterLimit !== expectedLimit || Number(statusParts[5]) !== expectedLimit
      || Number(tableParts[4]) !== expectedLimit) {
    throw new Error(`${block.name}: memory-limit override drift`);
  }
  const adapterPointer = pointer(adapterParts[1]);
  const tablePointer = pointer(tableParts[2]);
  if ((adapterPointer === 0) !== !input.nonnull || tablePointer !== adapterPointer
      || Number(adapterParts[2]) !== input.index
      || Number(adapterParts[3]) !== input.length
      || (input.nonnull ? adapterParts[4] !== "objArrayKlass" : adapterParts[4] !== "null")
      || Number(tableParts[3]) !== input.index
      || Number(tableParts[1]) !== Number(enterParts[5])) {
    throw new Error(`${block.name}: adapter/table input drift`);
  }
  for (const record of [adapter, table, status, exit]) {
    if (Number(record.text.match(/seq=(\d+)/)[1]) !== sequence) {
      throw new Error(`${block.name}: sequence mismatch`);
    }
  }
  if (eventBlock.lines.some(({ text }) => /safepoint|safepoint-check|gc-before|gc-after/i.test(text))) {
    throw new Error(`${block.name}: safepoint/GC marker inside call window`);
  }

  const direct = eventBlock.lines.filter(({ text }) =>
    new RegExp(`^\\[zbg\\] DIRECT_REF_LOAD referenceArrayLoad runtime=1 seq=${sequence} result-oop=(0x[0-9a-f]+|0|\\(nil\\))$`, "i").test(text));
  const reexec = eventBlock.lines.filter(({ text }) =>
    new RegExp(`^\\[zbg\\] REF_ARRAY_OPCODE_REEXECUTE seq=${sequence} reason=([a-z-]+) resume-bci=2 depth=2 pending=0$`).test(text));
  const interpreted = eventBlock.lines.filter(({ text }) =>
    new RegExp(`^\\[zbg\\] INTERPRETER_AALOAD seq=${sequence} bci=2$`).test(text));
  const directExpected = allowLinked && input.direct;
  if (directExpected) {
    if (Number(statusParts[1]) !== 0 || Number(statusParts[2]) !== 0
        || exitParts[1] !== "RETURN" || Number(exitParts[2]) !== 0
        || direct.length !== 1 || reexec.length || interpreted.length) {
      throw new Error(`${block.name}: direct status/event mismatch`);
    }
    const resultPointer = pointer(direct[0].text.match(/result-oop=(0x[0-9a-f]+|0|\(nil\))/i)[1]);
    if ((resultPointer === 0) !== !!input.nullResult
        || Number(statusParts[3]) !== resultPointer) {
      throw new Error(`${block.name}: returned oop bits mismatch`);
    }
    assertOrder([enter, adapter, table, status, exit, direct[0]], `${block.name} direct`);
  } else {
    if (Number(statusParts[1]) !== 3 || Number(statusParts[2]) !== 2
        || statusParts[3] !== "0" || exitParts[1] !== "REEXECUTE"
        || Number(exitParts[2]) !== 2 || direct.length || reexec.length !== 1
        || interpreted.length !== 1) {
      throw new Error(`${block.name}: fallback status/event mismatch`);
    }
    // The module checks the header before the unsigned index guard. The
    // forced-memory transcript therefore reports memory for valid direct
    // inputs, while invalid/null inputs retain their canonical JVM reason.
    const expectedReason = forced && input.direct ? "memory" : input.reason;
    const reason = reexec[0].text.match(/reason=([a-z-]+)/)[1];
    if (reason !== expectedReason || exitParts[3] !== reason) {
      throw new Error(`${block.name}: fallback reason=${reason} expected=${expectedReason}`);
    }
    assertOrder([enter, adapter, table, status, exit, reexec[0], interpreted[0]], `${block.name} fallback`);
  }
  return sequence;
}

if (mode === "negative") {
  if (lines.some((line) => anyMarker.test(line))) throw new Error("near-miss lane entered reference-array path");
  console.log("ref-array-log-order=pass mode=negative cases=0");
  process.exit(0);
}

if (mode === "osr-collision" || mode === "osr-aggregate") {
  if (lines.some((line) => linkedMarker.test(line))) {
    throw new Error("osr collision entered linked reference-array path");
  }
  const collision = lines.filter((line) =>
    /^\[zbg\] REF_ARRAY_REJECT reason=flag-collision /.test(line));
  if (collision.length !== 1) throw new Error(`osr collision marker count=${collision.length}`);
  const expectedFlags = mode === "osr-aggregate"
    ? [["group", "1"], ["int-load", "1"], ["int-store", "1"],
       ["benchmark", "1"], ["baseline", "1"], ["jit", "1"],
       ["ref-load", "1"], ["ref-store", "0"]]
    : [["group", "0"], ["int-load", "0"], ["int-store", "0"],
       ["benchmark", "0"], ["baseline", "0"], ["jit", "1"],
       ["ref-load", "1"], ["ref-store", "0"]];
  const collisionPrefix = "[zbg] REF_ARRAY_REJECT reason=flag-collision ";
  const flagTokens = collision[0].slice(collisionPrefix.length).split(" ");
  if (flagTokens.length !== expectedFlags.length) {
    throw new Error(`osr collision field count=${flagTokens.length} line=${collision[0]}`);
  }
  const actualFlags = Object.create(null);
  for (const [index, token] of flagTokens.entries()) {
    const match = token.match(/^([a-z-]+)=([01])$/);
    const [expectedName, expectedValue] = expectedFlags[index];
    if (!match || match[1] !== expectedName || actualFlags[match[1]] !== undefined
        || match[2] !== expectedValue) {
      throw new Error(`osr collision fields=${collision[0]}`);
    }
    actualFlags[match[1]] = match[2];
  }
  if (lines.some((line) => /^\[zwc\]/.test(line))) {
    throw new Error("osr collision reached JIT compile/OSR path");
  }
  const interpreted = lines.filter((line) =>
    /^\[zbg\] INTERPRETER_AALOAD seq=0 bci=2$/.test(line));
  if (interpreted.length !== 512) {
    throw new Error(`osr collision interpreter aaload count=${interpreted.length}`);
  }
  console.log("ref-array-log-order=pass mode=osr-collision calls=512 jit-osr=0");
  process.exit(0);
}

if (mode === "off" || mode === "collision") {
  if (lines.some((line) => linkedMarker.test(line))) throw new Error(`${mode}: linked marker entered interpreter-only lane`);
  if (mode === "collision") {
    const collision = lines.filter((line) => /^\[zbg\] REF_ARRAY_REJECT reason=flag-collision /.test(line));
    if (collision.length !== 1) throw new Error(`collision marker count=${collision.length}`);
  }
  const interpreted = lines.filter((line) => /^\[zbg\] INTERPRETER_AALOAD seq=0 bci=2$/.test(line));
  if (interpreted.length !== 10) throw new Error(`${mode}: interpreter aaload count=${interpreted.length}`);
  console.log(`ref-array-log-order=pass mode=${mode} cases=${normalCases.length} interpreter-aaload=10`);
  process.exit(0);
}

let nextSequence = 1;
for (const name of expected) {
  const block = blocks.get(name);
  const calls = name === "identity" ? 3 : 1;
  if (count(block, /REF_ARRAY_ENTER seq=/) !== calls) throw new Error(`${name}: call count mismatch`);
  for (let call = 0; call < calls; call++) {
    const sequence = checkEvent(block, call, semanticMode === "forced", semanticMode === "linked" || semanticMode === "root");
    if (sequence !== nextSequence++) throw new Error(`${name}: non-contiguous sequence ${sequence}`);
  }
}
if (nextSequence !== (mode === "root" ? 2 : 11)) throw new Error(`sequence ended at ${nextSequence}`);
console.log(`ref-array-log-order=pass mode=${mode} cases=${expected.length} calls=${nextSequence - 1}`);
