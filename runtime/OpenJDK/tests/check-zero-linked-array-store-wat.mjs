#!/usr/bin/env node
// Structural and byte-level checker for the dedicated M2-B int[] store
// module. The module is a diagnostic artifact produced by Zero; it is not a
// general Java compiler or an arbitrary-JAR compatibility claim.
import fs from "node:fs";
import crypto from "node:crypto";

const [, , binaryPath, watPath] = process.argv;
if (!binaryPath || !watPath) {
  console.error("usage: check-zero-linked-array-store-wat.mjs MODULE.wasm MODULE.wat");
  process.exit(2);
}

const binary = fs.readFileSync(binaryPath);
const wat = fs.readFileSync(watPath, "utf8");

function fail(message) {
  throw new Error(message);
}

if (!WebAssembly.validate(binary)) fail("binary validation failed");

function readUleb(bytes, start) {
  let value = 0;
  let shift = 0;
  let cursor = start;
  while (cursor < bytes.length) {
    const byte = bytes[cursor++];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
    if (shift > 35) fail("uleb overflow");
  }
  fail("truncated uleb");
}

function wasmSections(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from(
      [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))) {
    fail("bad wasm header");
  }
  const sections = [];
  let cursor = 8;
  while (cursor < bytes.length) {
    const id = bytes[cursor++];
    const size = readUleb(bytes, cursor);
    cursor = size.next;
    const end = cursor + size.value;
    if (end > bytes.length) fail("truncated wasm section");
    sections.push({ id, payload: bytes.subarray(cursor, end), payloadStart: cursor });
    cursor = end;
  }
  if (cursor !== bytes.length) fail("trailing wasm bytes");
  return sections;
}

function vectorCount(payload) {
  return readUleb(payload, 0).value;
}

function readSleb(bytes, start) {
  let value = 0n;
  let shift = 0;
  let cursor = start;
  let byte = 0;
  while (cursor < bytes.length) {
    byte = bytes[cursor++];
    value |= BigInt(byte & 0x7f) << BigInt(shift);
    shift += 7;
    if ((byte & 0x80) === 0) {
      if (byte & 0x40) value |= -1n << BigInt(shift);
      return { value, next: cursor };
    }
    if (shift > 70) fail("signed leb overflow");
  }
  fail("truncated signed immediate");
}

function decodedInstructions(bytes) {
  const instructions = [];
  let cursor = readUleb(bytes, 0).next; // local-declaration vector
  while (cursor < bytes.length) {
    const start = cursor;
    const opcode = bytes[cursor++];
    const immediates = [];
    const immediateStarts = [];
    const readUnsignedImmediate = () => {
      immediateStarts.push(cursor);
      const result = readUleb(bytes, cursor);
      cursor = result.next;
      immediates.push(result.value);
    };
    switch (opcode) {
      case 0x04: // if: block type
        immediateStarts.push(cursor);
        immediates.push(bytes[cursor++]);
        break;
      case 0x10: // call
      case 0x11: // call_indirect
      case 0x0c: // br
      case 0x0d: // br_if
      case 0x20: // local.get
      case 0x21: // local.set
      case 0x22: // local.tee
      case 0x23: // global.get
      case 0x24: // global.set
        readUnsignedImmediate();
        break;
      case 0x28: // i32.load memarg
      case 0x36: // i32.store memarg
        readUnsignedImmediate(); // alignment
        readUnsignedImmediate(); // offset
        break;
      case 0x41: // i32.const
      case 0x42: { // i64.const
        immediateStarts.push(cursor);
        const result = readSleb(bytes, cursor);
        cursor = result.next;
        immediates.push(result.value);
        break;
      }
      default:
        break;
    }
    if (cursor > bytes.length) fail("instruction immediate exceeds body");
    instructions.push({ opcode, start, end: cursor, immediates, immediateStarts });
  }
  return instructions;
}

function inspectBinary(bytes) {
  if (!WebAssembly.validate(bytes)) fail("binary validation failed");
  const sections = wasmSections(bytes);
  const sectionIds = sections.map((section) => section.id);
  const expectedSectionIds = [1, 2, 3, 7, 10];
  if (sectionIds.length !== expectedSectionIds.length
      || sectionIds.some((id, i) => id !== expectedSectionIds[i])) {
    fail(`unexpected section ids: ${sectionIds.join(",")}`);
  }
  for (const id of expectedSectionIds) {
    if (sections.filter((section) => section.id === id).length !== 1) {
      fail(`duplicate or missing section ${id}`);
    }
  }
  const typeSection = sections.find((section) => section.id === 1).payload;
  const importSection = sections.find((section) => section.id === 2).payload;
  const functionSection = sections.find((section) => section.id === 3).payload;
  const exportSection = sections.find((section) => section.id === 7).payload;
  const codeSectionRecord = sections.find((section) => section.id === 10);
  const codeSection = codeSectionRecord.payload;
  if (vectorCount(typeSection) !== 1 || vectorCount(importSection) !== 1
      || vectorCount(functionSection) !== 1 || vectorCount(exportSection) !== 1
      || vectorCount(codeSection) !== 1) {
    fail("module vectors are not exactly one");
  }

  // Bind structural checks to the actual bytes, rather than accepting a
  // hand-edited WAT beside a valid module.
  let codeCursor = readUleb(codeSection, 0).next;
  const bodyLength = readUleb(codeSection, codeCursor);
  codeCursor = bodyLength.next;
  const bodyBytes = codeSection.subarray(codeCursor, codeCursor + bodyLength.value);
  if (bodyBytes.length !== bodyLength.value
      || codeCursor + bodyLength.value !== codeSection.length) {
    fail("truncated or trailing code body");
  }
  if (bodyBytes[0] !== 0) fail("store body unexpectedly declares locals");
  return {
    sections,
    bodyBytes,
    bodyOffset: codeSectionRecord.payloadStart + codeCursor,
    instructions: decodedInstructions(bodyBytes),
  };
}

function checkActualBinary(info) {
  const decoded = info.instructions.map((instruction) => instruction.opcode);
  const opcodeCount = (opcode) => decoded.filter((value) => value === opcode).length;
  if (opcodeCount(0x28) !== 1) fail("actual bytes do not contain exactly one i32.load");
  if (opcodeCount(0x36) !== 1) fail("actual bytes do not contain exactly one i32.store");
  if (opcodeCount(0x10) !== 0 || opcodeCount(0x11) !== 0) {
    fail("actual bytes contain a call or call_indirect");
  }
  for (const [opcode, expected, label] of [
    [0x45, 3, "i32.eqz"], [0x4b, 1, "unsigned length guard"],
    [0x58, 2, "unsigned end guards"], [0x3f, 6, "memory.size"],
    [0x84, 1, "status merge"], [0xa7, 1, "i32.wrap_i64"],
  ]) {
    if (opcodeCount(opcode) !== expected) fail(`actual ${label} count drift`);
  }
  const load = info.instructions.find((instruction) => instruction.opcode === 0x28);
  const store = info.instructions.find((instruction) => instruction.opcode === 0x36);
  if (load.immediates[0] !== 2 || load.immediates[1] !== 8) {
    fail("actual i32.load memarg drift");
  }
  if (store.immediates[0] !== 2 || store.immediates[1] !== 0) {
    fail("actual i32.store memarg drift");
  }
  const localGets = info.instructions
    .filter((instruction) => instruction.opcode === 0x20)
    .map((instruction) => instruction.immediates[0]);
  if (localGets.filter((index) => index === 2).length !== 2
      || localGets.filter((index) => index === 3).length !== 6) {
    fail("actual value/limit local counts drift");
  }
  const i64Constants = info.instructions
    .filter((instruction) => instruction.opcode === 0x42)
    .map((instruction) => instruction.immediates[0].toString());
  for (const [literal, expected] of [
    ["8", 1], ["12", 1], ["4", 3], ["16", 1], ["65536", 10],
    ["844437815033856", 4],
  ]) {
    if (i64Constants.filter((value) => value === literal).length !== expected) {
      fail(`actual literal ${literal} count drift`);
    }
  }
}

const actualBinary = inspectBinary(binary);
checkActualBinary(actualBinary);

function balancedSlice(source, needle) {
  const start = source.indexOf(needle);
  if (start < 0) fail(`missing ${needle}`);
  let depth = 0;
  let quote = false;
  let lineComment = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (!quote && ch === ";" && next === ";") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '"' && source[i - 1] !== "\\") {
      quote = !quote;
      continue;
    }
    if (quote) continue;
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  fail(`unbalanced ${needle}`);
}

function countExact(source, expression) {
  return [...source.matchAll(expression)].length;
}

function checkBody(body) {
  const required = [
    "(i32.eqz", "(i32.gt_u", "(i64.le_u", "(i64.mul",
    "(i64.add", "(i64.extend_i32_u", "(i32.wrap_i64", "(i32.load offset=8",
    "(i32.store", "(i64.or", "(memory.size)",
  ];
  const missing = required.filter((token) => !body.includes(token));
  if (missing.length) fail(`missing store structure: ${missing.join(",")}`);
  if (!body.startsWith("(func $0 (param $0 i32) (param $1 i32) "
      + "(param $2 i32) (param $3 i32) (result i64)")) {
    fail("wrong store ABI or result type");
  }
  if (countExact(body, /\(i32\.eqz/g) !== 3) fail("null/limit guards incomplete");
  if (countExact(body, /\(i32\.gt_u/g) !== 1) fail("unsigned length guard incomplete");
  if (countExact(body, /\(i64\.le_u/g) !== 2) fail("widened end guards incomplete");
  if (countExact(body, /\(memory\.size\)/g) !== 6) fail("memory-size guards incomplete");
  if (countExact(body, /\(i32\.load/g) !== 1) fail("unexpected load count");
  if (countExact(body, /\(i32\.store/g) !== 1) fail("store count is not exactly one");
  if (countExact(body, /\(i64\.or/g) !== 1) fail("return value/status merge missing");
  for (const [literal, expected] of [
    [8, 1], [12, 1], [4, 3], [16, 1], [65536, 10],
    [844437815033856, 4],
  ]) {
    const actual = countExact(body, new RegExp(`\\(i64\\.const ${literal}\\)`, "g"));
    if (actual !== expected) fail(`literal ${literal} count=${actual} expected=${expected}`);
  }
  if (countExact(body, /\(local\.get \$2\)/g) !== 2) fail("value local is not exact");
  if (countExact(body, /\(local\.get \$3\)/g) !== 6) fail("memory-limit local is not exact");
  const store = balancedSlice(body, "(i32.store");
  if (!store.includes("(local.get $2)")) fail("i32.store does not use value local2");
  if (store.includes("(local.get $3)")) fail("i32.store uses limit local3 as value");
  if (!body.includes("(i32.load offset=8\n         (local.get $0)")) {
    fail("int[] length offset/base is not exact");
  }
  if (!body.includes("(i64.const 12)")) fail("int[] base offset is not exact");
  if (countExact(body, /\(i64\.const 12\)/g) !== 1) fail("base offset count drift");
  if (/\(call(?:_indirect)?\b|\bunreachable\b/.test(body)) {
    fail("store body contains call/trap");
  }
  return true;
}

function checkWat(source) {
  let depth = 0;
  for (const character of source) {
    if (character === "(") depth++;
    else if (character === ")") {
      depth--;
      if (depth < 0) fail("WAT has an extra closing parenthesis");
    }
  }
  if (depth !== 0) fail("WAT parentheses are unbalanced");
  const imports = [...source.matchAll(/^\s*\(import /gm)];
  if (imports.length !== 1
      || !source.includes('(import "env" "memory"')
      || !source.includes("(memory $mimport$0 0 65536 shared)")) {
    fail("unexpected memory import");
  }
  const exports = [...source.matchAll(/^\s*\(export "([^"]+)"/gm)].map((match) => match[1]);
  if (exports.length !== 1 || exports[0] !== "intArrayStore") {
    fail(`unexpected exports: ${exports.join(",")}`);
  }
  if ([...source.matchAll(/^\s*\(func \$[0-9]+/gm)].length !== 1) {
    fail("unexpected function count");
  }
  checkBody(balancedSlice(source, "(func $0 "));
}

function checkBinaryWatPair(info, source) {
  const actualLocals = info.instructions
    .filter((instruction) => instruction.opcode === 0x20)
    .map((instruction) => instruction.immediates[0]);
  const watLocals = [...source.matchAll(/\(local\.get \$(\d+)\)/g)]
    .map((match) => Number(match[1]));
  if (JSON.stringify(actualLocals) !== JSON.stringify(watLocals)) {
    fail("WAT local.get sequence does not match actual bytes");
  }
  const actualConstants = info.instructions
    .filter((instruction) => instruction.opcode === 0x42)
    .map((instruction) => instruction.immediates[0].toString());
  const watConstants = [...source.matchAll(/\(i64\.const (-?\d+)\)/g)]
    .map((match) => match[1]);
  if (JSON.stringify(actualConstants) !== JSON.stringify(watConstants)) {
    fail("WAT i64.const sequence does not match actual bytes");
  }
  const actualLoads = info.instructions
    .filter((instruction) => instruction.opcode === 0x28)
    .map((instruction) => instruction.immediates[1]);
  const actualStores = info.instructions
    .filter((instruction) => instruction.opcode === 0x36)
    .map((instruction) => instruction.immediates[1]);
  const watLoads = [...source.matchAll(/\(i32\.load(?: offset=(\d+))?/g)]
    .map((match) => Number(match[1] ?? 0));
  const watStores = [...source.matchAll(/\(i32\.store(?: offset=(\d+))?/g)]
    .map((match) => Number(match[1] ?? 0));
  if (JSON.stringify(actualLoads) !== JSON.stringify(watLoads)
      || JSON.stringify(actualStores) !== JSON.stringify(watStores)) {
    fail("WAT load/store memargs do not match actual bytes");
  }
}

checkWat(wat);
checkBinaryWatPair(actualBinary, wat);

function expectReject(label, mutate) {
  try {
    const candidate = mutate(wat);
    checkWat(candidate);
    checkBinaryWatPair(actualBinary, candidate);
  } catch {
    return;
  }
  fail(`checker negative accepted: ${label}`);
}

expectReject("signed bounds", (source) => source.replace("(i32.gt_u", "(i32.gt_s"));
expectReject("wrong length offset", (source) => source.replace("offset=8", "offset=12"));
expectReject("wrong base offset", (source) => source.replace("(i64.const 12)", "(i64.const 16)"));
expectReject("wrong element scale", (source) => source.replaceAll("(i64.const 4)", "(i64.const 8)"));
expectReject("missing end guard", (source) => source.replaceAll("(i64.le_u", "(i64.lt_u"));
expectReject("limit local used as value", (source) => source.replace(
  "(local.get $2)\n          )\n          (i64.or",
  "(local.get $3)\n          )\n          (i64.or"));
expectReject("value local used as limit", (source) => source.replaceAll("(local.get $3)", "(local.get $2)"));
expectReject("missing store", (source) => source.replace("(i32.store", "(i32.load"));
expectReject("duplicate store", (source) => source.replace("(i32.load offset=8", "(i32.store offset=8"));
expectReject("swapped address/value", (source) => source.replace(
  "(local.get $2)\n          )\n          (i64.or",
  "(local.get $1)\n          )\n          (i64.or"));
expectReject("wrong status/BCI", (source) => source.replaceAll(
  "844437815033856", "844437815033857"));
expectReject("wrong import", (source) => source.replace('(import "env" "memory"',
  '(import "other" "memory"'));
expectReject("wrong export slot", (source) => source.replace('"intArrayStore"', '"wrongSlot"'));
expectReject("call edge", (source) => source.replace("(i32.store", "(call $0)\n   (i32.store"));
expectReject("truncated body", (source) => source.slice(0, source.length - 3));
expectReject("stale WAT pairing", (source) => source.replace(
  "(i64.const 0)", "(i64.const 1)"));

const binaryMutationEvidence = [];
const binaryMutationOffsets = [];
const binaryMutationHashes = new Set();

function expectBinaryReject(label, mutationOffset, mutate, expectedReason) {
  const original = Buffer.from(binary);
  const candidate = mutate(Buffer.from(original));
  if (candidate === original) {
    fail(`${label}: mutation aliased original buffer`);
  }
  if (candidate.length !== original.length) {
    fail(`${label}: mutation changed binary length`);
  }
  const changedOffsets = [];
  for (let i = 0; i < original.length; i++) {
    if (candidate[i] !== original[i]) changedOffsets.push(i);
  }
  if (changedOffsets.length !== 1) {
    fail(`${label}: changed-byte count=${changedOffsets.length}`);
  }
  if (changedOffsets[0] !== mutationOffset) {
    fail(`${label}: changed-byte offset=${changedOffsets[0]} expected=${mutationOffset}`);
  }
  if (binaryMutationOffsets.includes(mutationOffset)) {
    fail(`${label}: mutation offset was reused`);
  }
  binaryMutationOffsets.push(mutationOffset);
  if (!WebAssembly.validate(candidate)) {
    fail(`${label}: same-length mutation is not a valid Wasm module`);
  }
  const candidateHash = crypto.createHash("sha256").update(candidate).digest("hex");
  if (binaryMutationHashes.has(candidateHash)) {
    fail(`${label}: candidate hash was reused`);
  }
  binaryMutationHashes.add(candidateHash);
  try {
    const info = inspectBinary(candidate);
    checkActualBinary(info);
    checkBinaryWatPair(info, wat);
  } catch (error) {
    const reason = String(error?.message ?? error);
    if (!reason.includes(expectedReason)) {
      fail(`${label}: rejection reason=${reason} expected=${expectedReason}`);
    }
    binaryMutationEvidence.push(`${label} offset=${mutationOffset} sha256=${candidateHash} reason=${expectedReason}`);
    return;
  }
  fail(`binary checker negative accepted: ${label}`);
}

const storeInstruction = actualBinary.instructions
  .find((instruction) => instruction.opcode === 0x36);
const firstValueLocal = actualBinary.instructions
  .find((instruction) => instruction.opcode === 0x20
      && instruction.immediates[0] === 2);
const firstLimitLocal = actualBinary.instructions
  .find((instruction) => instruction.opcode === 0x20
      && instruction.immediates[0] === 3);
const unsignedLengthGuard = actualBinary.instructions
  .find((instruction) => instruction.opcode === 0x4b);
const firstEndGuard = actualBinary.instructions
  .find((instruction) => instruction.opcode === 0x58);
if (!storeInstruction || !firstValueLocal || !firstLimitLocal
    || !unsignedLengthGuard || !firstEndGuard) {
  fail("missing binary mutation anchors");
}
function mutateBodyByte(bytes, bodyOffset, position, value) {
  bytes[bodyOffset + position] = value;
  return bytes;
}
expectBinaryReject("store opcode", actualBinary.bodyOffset + storeInstruction.start, (bytes) => {
  return mutateBodyByte(bytes, actualBinary.bodyOffset, storeInstruction.start,
    0x20); // valid local.get, wrong store opcode
}, "actual bytes do not contain exactly one i32.store");
expectBinaryReject("store memarg", actualBinary.bodyOffset + storeInstruction.immediateStarts[1], (bytes) => {
  return mutateBodyByte(bytes, actualBinary.bodyOffset,
    storeInstruction.immediateStarts[1], 4);
}, "actual i32.store memarg drift");
expectBinaryReject("value local", actualBinary.bodyOffset + firstValueLocal.immediateStarts[0], (bytes) => {
  return mutateBodyByte(bytes, actualBinary.bodyOffset,
    firstValueLocal.immediateStarts[0], 3);
}, "actual value/limit local counts drift");
expectBinaryReject("limit local", actualBinary.bodyOffset + firstLimitLocal.immediateStarts[0], (bytes) => {
  return mutateBodyByte(bytes, actualBinary.bodyOffset,
    firstLimitLocal.immediateStarts[0], 2);
}, "actual value/limit local counts drift");
expectBinaryReject("unsigned bound", actualBinary.bodyOffset + unsignedLengthGuard.start, (bytes) => {
  return mutateBodyByte(bytes, actualBinary.bodyOffset, unsignedLengthGuard.start,
    0x4a); // i32.gt_s, same-length valid op
}, "actual unsigned length guard count drift");
expectBinaryReject("end guard", actualBinary.bodyOffset + firstEndGuard.start, (bytes) => {
  return mutateBodyByte(bytes, actualBinary.bodyOffset, firstEndGuard.start,
    0x57); // i64.le_s, same-length valid op
}, "actual unsigned end guards count drift");
if (binaryMutationOffsets.length !== 6 || binaryMutationHashes.size !== 6) {
  fail(`binary mutation evidence count offsets=${binaryMutationOffsets.length} hashes=${binaryMutationHashes.size}`);
}

console.log("array-store-wat-binary-validation=pass");
console.log("array-store-body-depth-aware=pass imports=1 exports=1 funcs=1");
console.log("array-store-wat-self-negatives=16 rejected");
console.log("array-store-binary-self-negatives=6 rejected");
for (const evidence of binaryMutationEvidence) console.log(`array-store-binary-negative ${evidence}`);
