#!/usr/bin/env node
// Ordered semantic checker for the dedicated M2-B int[] store transcript.
// A linked return is accepted only when the real heap mutation and the return
// value have both been observed; every guard must resume at iastore with the
// exact array/index/value stack slice.
import fs from "node:fs";

const [, , logPath, mode = "linked"] = process.argv;
if (!logPath) {
  throw new Error("usage: check-zero-linked-array-store-log.mjs LOG [linked|forced|negative|combined]");
}
const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);

const marker = /(STORE_ENTER|STORE_ADAPTER|STORE_TABLE_CALL|STORE_STATUS|STORE_EXIT|STORE_OPCODE_REEXECUTE|DIRECT_STORE|INTERPRETER_IASTORE)/;
if (mode === "negative" || mode === "combined") {
  const forbidden = mode === "combined"
    ? /(STORE_ENTER|STORE_ADAPTER|STORE_TABLE_CALL|STORE_STATUS|STORE_EXIT|STORE_OPCODE_REEXECUTE|DIRECT_STORE)/
    : marker;
  if (lines.some((line) => forbidden.test(line))) {
    throw new Error(`${mode}: linked store marker entered a fail-closed lane`);
  }
  if (mode === "combined") {
    const interpreter = lines.filter((line) => /^\[zbg\] INTERPRETER_IASTORE seq=0 bci=3$/.test(line));
    if (interpreter.length !== 13) {
      throw new Error(`combined: interpreter-only iastore count=${interpreter.length}`);
    }
  }
  console.log(`array-store-log-order=pass mode=${mode} markers=0`);
  process.exit(0);
}

const expectedCases = ["first", "middle", "last", "values", "null",
  "negative", "length", "min-index", "empty"];
const expectedCalls = new Map([
  ["first", 1], ["middle", 1], ["last", 1], ["values", 5],
  ["null", 1], ["negative", 1], ["length", 1], ["min-index", 1],
  ["empty", 1],
]);
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
  else if (marker.test(line)) throw new Error(`store marker outside case window: ${line}`);
}
if (current) throw new Error(`unterminated case ${current.name}`);
if (blocks.size !== expectedCases.length
    || expectedCases.some((name, i) => [...blocks.keys()][i] !== name)) {
  throw new Error(`case order mismatch: ${[...blocks.keys()].join(",")}`);
}

function matches(block, expression, label, count = 1) {
  const found = block.lines.filter(({ text }) => expression.test(text));
  if (found.length !== count) {
    throw new Error(`${block.name}: ${label} count=${found.length} expected=${count}`);
  }
  return found;
}

function text(record) {
  return record.text;
}

function assertEventOrder(events, label) {
  const positions = events.map((event) => event.lineIndex);
  for (let i = 1; i < positions.length; i++) {
    if (!(positions[i - 1] < positions[i])) {
      throw new Error(`${label}: event order ${positions.join("<")} is invalid`);
    }
  }
}

function expectedDirectValues(name) {
  if (name === "first") return [-2147483648];
  if (name === "middle") return [42];
  if (name === "last") return [2147483647];
  if (name === "values") return [0, 1, 42, -2147483648, 2147483647];
  return [7];
}

function expectedStoreInput(name, call) {
  if (name === "first") return { index: 0, value: -2147483648, length: 3, oop: "nonnull" };
  if (name === "middle") return { index: 1, value: 42, length: 3, oop: "nonnull" };
  if (name === "last") return { index: 2, value: 2147483647, length: 3, oop: "nonnull" };
  if (name === "values") {
    return { index: call, value: [0, 1, 42, -2147483648, 2147483647][call],
      length: 5, oop: "nonnull" };
  }
  if (name === "null") return { index: 0, value: 7, length: -1, oop: "null" };
  if (name === "negative") return { index: -1, value: 7, length: 3, oop: "nonnull" };
  if (name === "length") return { index: 3, value: 7, length: 3, oop: "nonnull" };
  if (name === "min-index") {
    return { index: -2147483648, value: 7, length: 3, oop: "nonnull" };
  }
  return { index: 0, value: 7, length: 0, oop: "nonnull" };
}

let nextSequence = 1;
for (const name of expectedCases) {
  const block = blocks.get(name);
  const callCount = expectedCalls.get(name);
  const enter = matches(block,
    /^\[zbg\] STORE_ENTER seq=(\d+) method=intArrayStore static=1 params=3 raw32=1 exact-klass=intArrayKlass length-offset=(\d+) base-offset=(\d+) limit-pages=(\d+) slot=(\d+)$/,
    "STORE_ENTER", callCount);
  const adapter = matches(block, /^\[zbg\] STORE_ADAPTER seq=(\d+) oop=(?:0x[0-9a-f]+|0) index=(-?\d+) value=(-?\d+) length=(-?\d+)$/, "STORE_ADAPTER", callCount);
  const table = matches(block, /^\[zbg\] STORE_TABLE_CALL seq=(\d+) slot=(\d+) oop=(?:0x[0-9a-f]+|0) index=(-?\d+) value=(-?\d+) limit-pages=(\d+)$/, "STORE_TABLE_CALL", callCount);
  const status = matches(block, /^\[zbg\] STORE_STATUS seq=(\d+) status=(\d+) bci=(\d+) value=(-?\d+) expected-bci=(\d+) limit-pages=(\d+)$/, "STORE_STATUS", callCount);
  const exit = matches(block, /^\[zbg\] STORE_EXIT seq=(\d+) status=(RETURN|REEXECUTE) bci=(\d+)(?: reason=([a-z-]+))?$/, "STORE_EXIT", callCount);
  for (let i = 0; i < callCount; i++) {
    const sequence = Number(text(enter[i]).match(/seq=(\d+)/)[1]);
    if (sequence !== nextSequence++) throw new Error(`${name}: non-contiguous sequence ${sequence}`);
    const enterLimit = Number(text(enter[i]).match(/limit-pages=(\d+)/)[1]);
    const enterSlot = Number(text(enter[i]).match(/slot=(\d+)/)[1]);
    if (enterSlot !== 9913) throw new Error(`${name}: slot=${enterSlot} expected 9913`);
    if (enterLimit !== (mode === "forced" ? 1 : 0)) {
      throw new Error(`${name}: limit-pages=${enterLimit}`);
    }
    const getSeq = (line) => Number(text(line).match(/seq=(\d+)/)[1]);
    for (const [label, line] of [["adapter", adapter[i]], ["table", table[i]],
      ["status", status[i]], ["exit", exit[i]]]) {
      if (getSeq(line) !== sequence) throw new Error(`${name}: ${label} sequence mismatch`);
    }
    if (!text(table[i]).includes(`slot=${enterSlot} `)) throw new Error(`${name}: table slot mismatch`);
    const statusParts = text(status[i]).match(/status=(\d+) bci=(\d+) value=(-?\d+) expected-bci=(\d+) limit-pages=(\d+)/);
    if (Number(statusParts[4]) !== 3) throw new Error(`${name}: expected iastore BCI mismatch`);
    const adapterParts = text(adapter[i]).match(
      /oop=(0x[0-9a-f]+|0) index=(-?\d+) value=(-?\d+) length=(-?\d+)/);
    const tableParts = text(table[i]).match(
      /slot=(\d+) oop=(0x[0-9a-f]+|0) index=(-?\d+) value=(-?\d+) limit-pages=(\d+)/);
    if (!adapterParts || !tableParts) throw new Error(`${name}: malformed adapter/table fields`);
    const expectedInput = expectedStoreInput(name, i);
    if (Number(adapterParts[2]) !== expectedInput.index
        || Number(adapterParts[3]) !== expectedInput.value
        || Number(adapterParts[4]) !== expectedInput.length) {
      throw new Error(`${name}: adapter input fields drift`);
    }
    if ((expectedInput.oop === "null") !== (adapterParts[1] === "0")) {
      throw new Error(`${name}: adapter oop nullness drift`);
    }
    if (tableParts[2] !== adapterParts[1]
        || Number(tableParts[3]) !== expectedInput.index
        || Number(tableParts[4]) !== expectedInput.value
        || Number(tableParts[5]) !== (mode === "forced" ? 1 : 0)) {
      throw new Error(`${name}: table-call fields drift`);
    }
    const expectedStatusValue = isFinite(expectedInput.value)
      ? expectedInput.value : 0;
    if (Number(statusParts[5]) !== (mode === "forced" ? 1 : 0)) {
      throw new Error(`${name}: status memory-limit drift`);
    }
    const direct = block.lines.filter(({ text: line }) => new RegExp(`^\\[zbg\\] DIRECT_STORE intArrayStore runtime=1 seq=${sequence} result=(-?\\d+)$`).test(line));
    const reexec = block.lines.filter(({ text: line }) => new RegExp(`^\\[zbg\\] STORE_OPCODE_REEXECUTE seq=${sequence} reason=([a-z-]+) resume-bci=3 depth=3 pending=0$`).test(line));
    const interpreted = block.lines.filter(({ text: line }) => new RegExp(`^\\[zbg\\] INTERPRETER_IASTORE seq=${sequence} bci=3$`).test(line));
    const isValid = ["first", "middle", "last", "values"].includes(name);
    const mustDirect = mode === "linked" && isValid;
    if (mustDirect) {
      if (direct.length !== 1 || reexec.length || interpreted.length) {
        throw new Error(`${name} seq=${sequence}: direct/fallback mismatch`);
      }
      assertEventOrder([enter[i], adapter[i], table[i], status[i], exit[i], direct[0]],
        `${name} seq=${sequence}: direct`);
      const result = Number(text(direct[0]).match(/result=(-?\d+)/)[1]);
      if (result !== expectedDirectValues(name)[i]) throw new Error(`${name}: direct result=${result}`);
      if (Number(statusParts[1]) !== 0 || Number(statusParts[2]) !== 0
          || Number(statusParts[3]) !== result || result !== expectedStatusValue) {
        throw new Error(`${name}: return status mismatch`);
      }
      if (text(exit[i]) !== `[zbg] STORE_EXIT seq=${sequence} status=RETURN bci=0`) {
        throw new Error(`${name}: return exit mismatch`);
      }
    } else {
      if (direct.length || reexec.length !== 1 || interpreted.length !== 1) {
        throw new Error(`${name} seq=${sequence}: fallback count mismatch`);
      }
      if (Number(statusParts[1]) !== 3 || Number(statusParts[2]) !== 3
          || Number(statusParts[3]) !== 0) {
        throw new Error(`${name}: reexecute status mismatch`);
      }
      assertEventOrder([enter[i], adapter[i], table[i], status[i], exit[i], reexec[0], interpreted[0]],
        `${name} seq=${sequence}: fallback`);
      const reason = text(reexec[0]).match(/reason=([a-z-]+)/)[1];
      const expectedReason = mode === "forced" && isValid
        ? "memory" : (name === "null" ? "null" : "bounds");
      if (reason !== expectedReason) throw new Error(`${name}: reason=${reason} expected=${expectedReason}`);
      if (text(exit[i]) !== `[zbg] STORE_EXIT seq=${sequence} status=REEXECUTE bci=3 reason=${reason}`) {
        throw new Error(`${name}: reexecute exit mismatch`);
      }
    }
  }
}
if (nextSequence !== 14) throw new Error(`expected 13 calls, ended at ${nextSequence}`);

function expectOrderReject(label, indexes) {
  try {
    assertEventOrder(indexes.map((lineIndex) => ({ lineIndex })), label);
  } catch {
    return;
  }
  throw new Error(`checker order negative accepted: ${label}`);
}

// Keep the ordering oracle independently fail-closed for the common marker
// corruption cases: adjacent direct events swapped, fallback exit moved after
// the opcode marker, and the interpreter marker moved ahead of reexecute.
expectOrderReject("direct adjacent reorder", [10, 11, 12, 13, 15, 14]);
expectOrderReject("fallback early marker", [20, 21, 22, 23, 25, 24, 26]);
expectOrderReject("fallback late marker", [30, 31, 32, 33, 34, 36, 35]);

console.log(`array-store-log-order=pass mode=${mode} cases=${expectedCases.length} calls=13 line-order-self-negatives=3`);
