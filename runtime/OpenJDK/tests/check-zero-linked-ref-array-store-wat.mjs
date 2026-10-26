#!/usr/bin/env node
// Byte- and WAT-level checker for the isolated M2-C2 checked reference-array
// store.  The binary is authoritative: the disassembly is paired with it and
// is independently made stale once.  This checker is intentionally specific
// to the six-i32 -> i64, one-export OSS fixture ABI; it is not a general Java
// or Minecraft Wasm validator.
import fs from "node:fs";
import crypto from "node:crypto";

const [, , binaryPath, watPath] = process.argv;
if (!binaryPath || !watPath) {
  console.error("usage: check-zero-linked-ref-array-store-wat.mjs MODULE.wasm MODULE.wat");
  process.exit(2);
}

const original = fs.readFileSync(binaryPath);
const wat = fs.readFileSync(watPath, "utf8");

function uleb(bytes, at) {
  let value = 0;
  let shift = 0;
  while (at < bytes.length) {
    const byte = bytes[at++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, at];
    shift += 7;
    if (shift > 35) throw new Error("invalid unsigned leb");
  }
  throw new Error("truncated unsigned leb");
}

function sleb(bytes, at, bits = 64) {
  let value = 0n;
  let shift = 0n;
  let byte = 0;
  do {
    if (at >= bytes.length) throw new Error("truncated signed leb");
    byte = bytes[at++];
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if (shift > BigInt(bits + 7)) throw new Error("invalid signed leb");
  } while (byte & 0x80);
  if ((byte & 0x40) && shift < BigInt(bits)) value -= 1n << shift;
  return [value, at];
}

function readString(bytes, at) {
  const [length, next] = uleb(bytes, at);
  const end = next + length;
  if (end > bytes.length) throw new Error("truncated wasm string");
  return [new TextDecoder().decode(bytes.subarray(next, end)), end];
}

function sections(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61
      || bytes[2] !== 0x73 || bytes[3] !== 0x6d
      || bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
    throw new Error("bad wasm header");
  }
  const result = [];
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at++];
    const [size, next] = uleb(bytes, at);
    at = next;
    const end = at + size;
    if (end > bytes.length) throw new Error("truncated wasm section");
    result.push({ id, start: at, end });
    at = end;
  }
  return result;
}

function parseMemoryImport(bytes) {
  const imports = sections(bytes).filter(({ id }) => id === 2);
  if (imports.length !== 1) throw new Error(`memory import sections=${imports.length}`);
  let at = imports[0].start;
  let count;
  [count, at] = uleb(bytes, at);
  if (count !== 1) throw new Error(`memory imports=${count}`);
  let module;
  [module, at] = readString(bytes, at);
  let field;
  [field, at] = readString(bytes, at);
  if (module !== "env" || field !== "memory" || bytes[at++] !== 0x02) {
    throw new Error("memory import name/kind mismatch");
  }
  const flagsPosition = at;
  const [flags, afterFlags] = uleb(bytes, at);
  at = afterFlags;
  const minimumPosition = at;
  const [minimum, afterMinimum] = uleb(bytes, at);
  at = afterMinimum;
  const maximumPosition = at;
  const [maximum, afterMaximum] = uleb(bytes, at);
  at = afterMaximum;
  if (flags !== 3 || minimum !== 0 || maximum !== 65536 || at !== imports[0].end) {
    throw new Error(`memory limits flags=${flags} min=${minimum} max=${maximum}`);
  }
  return { flagsPosition, minimumPosition, maximumPosition };
}

function parseType(bytes) {
  const types = sections(bytes).filter(({ id }) => id === 1);
  if (types.length !== 1) throw new Error(`type sections=${types.length}`);
  let at = types[0].start;
  let count;
  [count, at] = uleb(bytes, at);
  if (count !== 1 || bytes[at++] !== 0x60) throw new Error("function type count");
  let params;
  [params, at] = uleb(bytes, at);
  if (params !== 6) throw new Error(`ABI parameter count=${params}`);
  for (let i = 0; i < params; i++) {
    if (bytes[at++] !== 0x7f) throw new Error("ABI parameter is not i32");
  }
  let results;
  [results, at] = uleb(bytes, at);
  if (results !== 1 || bytes[at++] !== 0x7e || at !== types[0].end) {
    throw new Error("ABI result is not one i64");
  }
}

function parseFunctionSection(bytes) {
  const functions = sections(bytes).filter(({ id }) => id === 3);
  if (functions.length !== 1) throw new Error(`function sections=${functions.length}`);
  let at = functions[0].start;
  let count;
  [count, at] = uleb(bytes, at);
  if (count !== 1) throw new Error(`defined functions=${count}`);
  let typeIndex;
  [typeIndex, at] = uleb(bytes, at);
  if (typeIndex !== 0 || at !== functions[0].end) {
    throw new Error(`function type index=${typeIndex}`);
  }
  return { typeIndex };
}

function parseExports(bytes) {
  const exports = sections(bytes).filter(({ id }) => id === 7);
  if (exports.length !== 1) throw new Error(`export sections=${exports.length}`);
  let at = exports[0].start;
  let count;
  [count, at] = uleb(bytes, at);
  if (count !== 1) throw new Error(`exports=${count}`);
  const nameLengthPosition = at;
  const [nameLength, nameStart] = uleb(bytes, at);
  at = nameStart;
  const nameEnd = nameStart + nameLength;
  if (nameEnd > exports[0].end) throw new Error("truncated export name");
  const name = new TextDecoder().decode(bytes.subarray(nameStart, nameEnd));
  at = nameEnd;
  if (name !== "referenceArrayStore" || bytes[at++] !== 0x00) {
    throw new Error("export name/kind");
  }
  let functionIndex;
  [functionIndex, at] = uleb(bytes, at);
  if (functionIndex !== 0 || at !== exports[0].end) throw new Error("export function");
  return { nameLengthPosition, nameStart, nameLength };
}

function parseFunction(bytes) {
  const code = sections(bytes).filter(({ id }) => id === 10);
  if (code.length !== 1) throw new Error(`code sections=${code.length}`);
  const section = code[0];
  let at = section.start;
  let count;
  [count, at] = uleb(bytes, at);
  if (count !== 1) throw new Error(`code count=${count}`);
  let bodySize;
  [bodySize, at] = uleb(bytes, at);
  if (at + bodySize !== section.end) throw new Error("code body size mismatch");
  const bodyOffset = at;
  const body = bytes.subarray(at, at + bodySize);
  let cursor = 0;
  let localGroups;
  [localGroups, cursor] = uleb(body, cursor);
  for (let i = 0; i < localGroups; i++) {
    let localCount;
    [localCount, cursor] = uleb(body, cursor);
    if (cursor >= body.length) throw new Error("truncated local type");
    cursor++;
    if (localCount < 0) throw new Error("bad locals");
  }
  const instructions = [];
  while (cursor < body.length) {
    const position = cursor;
    const op = body[cursor++];
    const instruction = { op, position };
    switch (op) {
      case 0x02: case 0x03: case 0x04:
        if (cursor >= body.length) throw new Error("truncated block type");
        instruction.blockType = body[cursor++];
        break;
      case 0x0c: case 0x0d: case 0x10:
        instruction.immediatePosition = cursor;
        [instruction.index, cursor] = uleb(body, cursor);
        break;
      case 0x20: case 0x21:
        instruction.immediatePosition = cursor;
        [instruction.index, cursor] = uleb(body, cursor);
        break;
      case 0x28: case 0x29: case 0x2a: case 0x2b:
      case 0x2c: case 0x2d: case 0x2e: case 0x2f:
      case 0x30: case 0x31: case 0x32: case 0x33:
      case 0x34: case 0x35: case 0x36: case 0x37:
      case 0x38: case 0x39: case 0x3a: case 0x3b:
      case 0x3c: case 0x3d: case 0x3e: case 0x3f:
        if (op === 0x3f) {
          if (body[cursor++] !== 0) throw new Error("memory.size reserved byte");
        } else {
          instruction.memargAlignmentPosition = cursor;
          [instruction.memargAlignment, cursor] = uleb(body, cursor);
          instruction.memargOffsetPosition = cursor;
          [instruction.memargOffset, cursor] = uleb(body, cursor);
        }
        break;
      case 0x41:
        instruction.immediatePosition = cursor;
        [instruction.immediateValue, cursor] = sleb(body, cursor, 32);
        break;
      case 0x42:
        instruction.immediatePosition = cursor;
        [instruction.immediateValue, cursor] = sleb(body, cursor, 64);
        break;
      case 0x11:
        instruction.immediatePosition = cursor;
        [, cursor] = uleb(body, cursor);
        [, cursor] = uleb(body, cursor);
        break;
      default:
        break;
    }
    if (cursor > body.length) throw new Error("truncated instruction");
    instructions.push(instruction);
  }
  if (instructions.length === 0 || instructions.at(-1).op !== 0x0b) {
    throw new Error("function has no final end");
  }
  return { body, bodyOffset, localGroups, instructions };
}

const REEXECUTE_BCI3 = (3n << 48n) | (3n << 32n);

function checkBinary(binary) {
  if (!WebAssembly.validate(binary)) throw new Error("binary validation failed");
  parseMemoryImport(binary);
  parseType(binary);
  const functionInfo = parseFunctionSection(binary);
  parseExports(binary);
  const parsed = parseFunction(binary);
  if (parsed.localGroups !== 0) throw new Error("store function has locals");
  const ops = parsed.instructions.map(({ op }) => op);
  const count = (op) => ops.filter((value) => value === op).length;
  // Four unsigned i64 end/address guards are required before either store:
  // array header end, element end, card address <= UINT32_MAX, and card
  // byte end <= effective memory. They are all emitted by the production
  // body and every one must remain mutation-covered below.
  if (count(0x45) < 5 || count(0x4f) !== 1 || count(0x56) !== 4
      || count(0x54) !== 3 || count(0x88) !== 3 || count(0x89) !== 0) {
    throw new Error("guard/shift opcode shape drift");
  }
  if (count(0x3f) !== 9) throw new Error("effective-memory guard count drift");
  if (count(0x28) !== 1) throw new Error("store lane must load only array length");
  const loads = parsed.instructions.filter(({ op }) => op === 0x28);
  if (loads[0].memargAlignment !== 2) throw new Error("length load alignment drift");
  if (count(0x36) !== 1 || count(0x3a) !== 1) {
    throw new Error("exactly one oop store and one card store8 required");
  }
  const oopStores = parsed.instructions.filter(({ op }) => op === 0x36);
  const cardStores = parsed.instructions.filter(({ op }) => op === 0x3a);
  if (oopStores[0].memargAlignment !== 2 || oopStores[0].memargOffset !== 0
      || cardStores[0].memargAlignment !== 0 || cardStores[0].memargOffset !== 0) {
    throw new Error("store alignment/offset drift");
  }
  if (count(0x10) || count(0x11) || count(0x00) || count(0x0e)) {
    throw new Error("store body contains call/trap/table/branch-table");
  }
  if (count(0xa7) !== 2) throw new Error("wrap count drift");
  if (count(0x7e) !== 20 || count(0x7c) !== 16 || count(0xad) !== 30) {
    throw new Error("widened arithmetic shape drift");
  }
  if (count(0xac) !== 0) throw new Error("signed extension entered unsigned ABI");
  const shifts = parsed.instructions
    .map((instruction, index) => instruction.op === 0x88
      ? parsed.instructions[index - 1]?.immediateValue : undefined)
    .filter((value) => value !== undefined);
  if (shifts.length !== 3 || shifts.some((value) => value !== shifts[0])) {
    throw new Error("card shift constants are not stable");
  }
  const statusCount = parsed.instructions.filter(({ op, immediateValue }) =>
    op === 0x42 && immediateValue === REEXECUTE_BCI3).length;
  if (statusCount !== 8) throw new Error(`status/BCI3 literals=${statusCount}`);
  const firstNull = parsed.instructions.findIndex(({ op }) => op === 0x45);
  if (firstNull <= 0 || parsed.instructions[firstNull - 1].op !== 0x20
      || parsed.instructions[firstNull - 1].index !== 0) {
    throw new Error("null guard does not inspect array parameter");
  }
  const memoryOverrideGuard = parsed.instructions.findIndex(({ op, index }, i) =>
    op === 0x45 && parsed.instructions[i - 1]?.op === 0x20
      && parsed.instructions[i - 1]?.index === 3);
  if (memoryOverrideGuard < 0 || memoryOverrideGuard <= firstNull
      || memoryOverrideGuard >= parsed.instructions.findIndex(({ op }) => op === 0x4f)
      || parsed.instructions[memoryOverrideGuard + 1]?.op !== 0x45) {
    throw new Error("memory override guard precedence drift");
  }
  const assignableGuard = parsed.instructions.findIndex(({ op }, index) =>
    op === 0x45 && parsed.instructions[index - 1]?.op === 0x20
      && parsed.instructions[index - 1]?.index === 5);
  if (assignableGuard < 0) throw new Error("assignability ABI guard missing");
  const ge = parsed.instructions.findIndex(({ op }) => op === 0x4f);
  if (ge < 3 || parsed.instructions[ge - 1].op !== 0x28
      || parsed.instructions[ge - 2].op !== 0x20
      || parsed.instructions[ge - 3].op !== 0x20
      || parsed.instructions[ge - 3].index !== 1) {
    throw new Error("unsigned index >= length guard shape drift");
  }
  const stores = parsed.instructions.filter(({ op }) => op === 0x36 || op === 0x3a);
  if (!(stores[0].op === 0x36 && stores[1].op === 0x3a)) {
    throw new Error("oop store/card mark order drift");
  }
  const oopStoreIndex = parsed.instructions.findIndex(({ op }) => op === 0x36);
  const cardStoreIndex = parsed.instructions.findIndex(({ op }) => op === 0x3a);
  if (oopStoreIndex < 0 || cardStoreIndex <= oopStoreIndex) {
    throw new Error("store order indices missing");
  }
  // This body is deliberately straight-line validation followed by exactly
  // two stores. Requiring every guard and every memory-size probe to precede
  // the first store proves that all fallible checks dominate both side
  // effects; requiring the rooted value/card-base locals in the same prefix
  // prevents an ABI-local drift from silently storing a different operand.
  // The three shifts are address arithmetic and one is legitimately
  // recomputed after the oop store for the card mark. Comparisons and
  // memory-size probes, however, are all fallible guards and must dominate
  // the first side effect.
  const guardOps = new Set([0x3f, 0x45, 0x4f, 0x54, 0x56]);
  const guardAfterStore = parsed.instructions.slice(oopStoreIndex)
    .filter(({ op }) => guardOps.has(op));
  if (guardAfterStore.length) throw new Error("guard follows oop store");
  const prefix = parsed.instructions.slice(0, oopStoreIndex);
  const localGets = (index, before = parsed.instructions) => before.filter(
    ({ op, index: local }) => op === 0x20 && local === index);
  if (!localGets(0, prefix).length || !localGets(1, prefix).length
      || !localGets(2, prefix).length) {
    throw new Error("array/index/value locals do not dominate oop store");
  }
  if (!localGets(4, parsed.instructions.slice(0, cardStoreIndex)).length) {
    throw new Error("card-base local does not dominate card store");
  }
  if (parsed.instructions[oopStoreIndex - 1]?.op !== 0x20
      || parsed.instructions[oopStoreIndex - 1]?.index !== 2) {
    throw new Error("oop store value is not rooted local 2");
  }
  const cardPrefix = parsed.instructions.slice(oopStoreIndex + 1, cardStoreIndex);
  if (!localGets(4, cardPrefix).length) {
    throw new Error("card store lacks live card-base local");
  }
  const afterCard = parsed.instructions.slice(cardStoreIndex + 1);
  if (afterCard.some(({ op }) => op !== 0x0b)) {
    throw new Error("instruction follows card mark");
  }
  return { ...parsed, functionInfo, oopStoreIndex, cardStoreIndex };
}

function balancedSlice(source, needle) {
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`missing ${needle}`);
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
  throw new Error(`unbalanced ${needle}`);
}

function checkWatText(source) {
  if (!source.includes('(import "env" "memory"')) throw new Error("memory import missing");
  const exports = [...source.matchAll(/^\s*\(export "([^"]+)"/gm)].map((m) => m[1]);
  if (exports.length !== 1 || exports[0] !== "referenceArrayStore") {
    throw new Error(`unexpected exports: ${exports.join(",")}`);
  }
  const body = balancedSlice(source, "(func $0 ");
  const watParamTypes = [];
  for (const match of body.matchAll(/\(param([^)]*)\)/g)) {
    for (const token of match[1].trim().split(/\s+/).filter(Boolean)) {
      if (!token.startsWith("$")) watParamTypes.push(token);
    }
  }
  if (watParamTypes.join(" ") !== "i32 i32 i32 i32 i32 i32"
      || !/\(result(?:\s+\$[^\s()]+)?\s+i64\)/.test(body)) {
    throw new Error("jiiiiii -> i64 function type missing");
  }
  const loads = [...body.matchAll(/\(i32\.load(?:\s+offset=(\d+))?/g)];
  const stores = [...body.matchAll(/\(i32\.store(?!8\b)/g)];
  const store8 = [...body.matchAll(/\(i32\.store8\b/g)];
  if (loads.length !== 1 || stores.length !== 1 || store8.length !== 1) {
    throw new Error(`WAT loads=${loads.length} stores=${stores.length} store8=${store8.length}`);
  }
  const tail = body.slice(body.lastIndexOf("(i32.store8"));
  if (/\((?:else|br|br_if|call|i32\.load|memory\.size)|unreachable/.test(tail)) {
    throw new Error("WAT instruction follows card mark");
  }
  for (const token of ["(i32.eqz", "(i32.ge_u", "(i64.gt_u", "(i64.lt_u",
    "(i64.shr_u", "(i64.mul", "(i64.add", "(i64.extend_i32_u",
    "(i32.wrap_i64", "(memory.size)"]) {
    if (!body.includes(token)) throw new Error(`missing ${token}`);
  }
  if ((body.match(/\(i64\.shr_u\b/g) || []).length !== 3) {
    throw new Error("WAT i64.shr_u count drift");
  }
  if (/(call(?:_indirect)?\b|\bunreachable\b)/.test(body)) {
    throw new Error("WAT store body contains call/trap");
  }
  if ((body.match(/844437815033856/g) || []).length !== 8) {
    throw new Error("WAT status/BCI3 literal mismatch");
  }
  return { body };
}

const watDetails = checkWatText(wat);
const parsedOriginal = checkBinary(original);
if (watDetails.body.match(/\(i32\.store8\b/g)?.length !== 1) {
  throw new Error("WAT/binary store pairing drift");
}

// Pairing negative: a stale disassembly with the same surrounding shape must
// not be accepted after its card-store mnemonic is changed.
const staleWat = wat.replace("(i32.store8", "(i32.store");
if (staleWat === wat) throw new Error("stale WAT mutation target absent");
try {
  checkWatText(staleWat);
  throw new Error("stale WAT pairing accepted");
} catch (error) {
  if (error?.message === "stale WAT pairing accepted") throw error;
}

const mutationOffsets = new Set();
const mutationHashes = new Set();
const mutations = [];

function changedByte(before, candidate, label) {
  if (candidate.length !== before.length) throw new Error(`length changed: ${label}`);
  const changed = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== candidate[i]) changed.push({ offset: i, before: before[i], after: candidate[i] });
  }
  if (changed.length !== 1) throw new Error(`mutation byte count=${changed.length}: ${label}`);
  const change = changed[0];
  if (mutationOffsets.has(change.offset)) throw new Error(`mutation offset reused: ${label}`);
  mutationOffsets.add(change.offset);
  return change;
}

function expectReject(label, mutate) {
  const before = Buffer.from(original);
  const candidate = mutate(Buffer.from(original));
  const change = changedByte(before, candidate, label);
  if (!WebAssembly.validate(candidate)) throw new Error(`invalid same-length wasm: ${label}`);
  let reason;
  try {
    checkBinary(candidate);
  } catch (error) {
    reason = String(error?.message || error);
  }
  if (!reason) throw new Error(`checker accepted mutation: ${label}`);
  const sha256 = crypto.createHash("sha256").update(candidate).digest("hex");
  if (mutationHashes.has(sha256)) throw new Error(`mutation hash reused: ${label}`);
  mutationHashes.add(sha256);
  mutations.push({ label, ...change, sha256, reason });
}

function absoluteInstructionPosition(parsed, predicate) {
  const instruction = parsed.instructions.find(predicate);
  if (!instruction) throw new Error("instruction mutation target absent");
  return parsed.bodyOffset + instruction.position;
}

function absoluteImmediatePosition(parsed, predicate) {
  const instruction = parsed.instructions.find(predicate);
  if (!instruction || instruction.immediatePosition === undefined) {
    throw new Error("immediate mutation target absent");
  }
  return parsed.bodyOffset + instruction.immediatePosition;
}

const gtPositions = parsedOriginal.instructions
  .filter(({ op }) => op === 0x56).map(({ position }) => parsedOriginal.bodyOffset + position);
gtPositions.forEach((position, i) => expectReject(`gt-u-${i}`, (bytes) => {
  bytes[position] = 0x55; // valid i64.lt_u, rejected by the exact guard count
  return bytes;
}));

const shiftPositions = parsedOriginal.instructions
  .map((instruction, index) => instruction.op === 0x88
    ? parsedOriginal.instructions[index - 1] : null).filter(Boolean);
shiftPositions.forEach((instruction, i) => expectReject(`card-shift-${i}`, (bytes) => {
  bytes[parsedOriginal.bodyOffset + instruction.immediatePosition] ^= 1;
  return bytes;
}));

const firstShiftPosition = absoluteInstructionPosition(parsedOriginal,
  ({ op }) => op === 0x88);
expectReject("card-shr-u-opcode", (bytes) => {
  bytes[firstShiftPosition] = 0x89; // i64.rotl, valid but not the exact shift
  return bytes;
});

expectReject("oop-store-alignment", (bytes) => {
  const store = parsedOriginal.instructions.find(({ op }) => op === 0x36);
  bytes[parsedOriginal.bodyOffset + store.memargAlignmentPosition] = 1;
  return bytes;
});
expectReject("card-store-opcode", (bytes) => {
  bytes[absoluteInstructionPosition(parsedOriginal, ({ op }) => op === 0x3a)] = 0x36;
  return bytes;
});
expectReject("bounds-opcode", (bytes) => {
  bytes[absoluteInstructionPosition(parsedOriginal, ({ op }) => op === 0x4f)] = 0x4b;
  return bytes;
});
expectReject("unsigned-extension", (bytes) => {
  bytes[absoluteInstructionPosition(parsedOriginal, ({ op }) => op === 0xad)] = 0xac;
  return bytes;
});
expectReject("widened-multiply", (bytes) => {
  bytes[absoluteInstructionPosition(parsedOriginal, ({ op }) => op === 0x7e)] = 0x7c;
  return bytes;
});
expectReject("null-local", (bytes) => {
  const firstNull = parsedOriginal.instructions.findIndex(({ op }) => op === 0x45);
  const local = parsedOriginal.instructions[firstNull - 1];
  bytes[parsedOriginal.bodyOffset + local.immediatePosition] = 1;
  return bytes;
});
expectReject("assignability-local", (bytes) => {
  const guard = parsedOriginal.instructions.findIndex(({ op }, index) =>
    op === 0x45 && parsedOriginal.instructions[index - 1]?.index === 5);
  const local = parsedOriginal.instructions[guard - 1];
  bytes[parsedOriginal.bodyOffset + local.immediatePosition] = 4;
  return bytes;
});
expectReject("reexecute-status", (bytes) => {
  const status = parsedOriginal.instructions.find(({ op, immediateValue }) =>
    op === 0x42 && immediateValue === REEXECUTE_BCI3);
  bytes[parsedOriginal.bodyOffset + status.immediatePosition] ^= 1;
  return bytes;
});

const memory = parseMemoryImport(original);
expectReject("memory-minimum", (bytes) => {
  bytes[memory.minimumPosition] = 1;
  return bytes;
});
expectReject("memory-maximum", (bytes) => {
  bytes[memory.maximumPosition + 2] = 3;
  return bytes;
});
const exportInfo = parseExports(original);
expectReject("export-name", (bytes) => {
  bytes[exportInfo.nameStart] = "x".charCodeAt(0);
  return bytes;
});

const truncated = original.subarray(0, original.length - 1);
if (WebAssembly.validate(truncated)) throw new Error("truncated module validated");
let truncationReason;
try {
  checkBinary(truncated);
} catch (error) {
  truncationReason = String(error?.message || error);
}
if (!truncationReason) throw new Error("truncated module checker accepted");
const expectedLabels = [
  "gt-u-0", "gt-u-1", "gt-u-2", "gt-u-3", "card-shift-0", "card-shift-1",
  "card-shift-2", "card-shr-u-opcode", "oop-store-alignment", "card-store-opcode", "bounds-opcode",
  "unsigned-extension", "widened-multiply", "null-local",
  "assignability-local", "reexecute-status", "memory-minimum",
  "memory-maximum", "export-name"];
const actualLabels = mutations.map(({ label }) => label);
if (mutations.length !== expectedLabels.length
    || actualLabels.some((label, index) => label !== expectedLabels[index])
    || new Set(actualLabels).size !== expectedLabels.length
    || mutationOffsets.size !== mutations.length
    || mutationHashes.size !== mutations.length) {
  throw new Error(`same-length mutation accounting=${mutations.length}`);
}

console.log("ref-array-store-wat-binary-validation=pass");
console.log("ref-array-store-body-depth-aware=pass imports=1 exports=1 funcs=1 loads=1 stores=1 store8=1");
for (const mutation of mutations) {
  console.log(`ref-array-store-binary-negative label=${mutation.label}`
    + ` offset=${mutation.offset} before=0x${mutation.before.toString(16).padStart(2, "0")}`
    + ` after=0x${mutation.after.toString(16).padStart(2, "0")}`
    + ` sha256=${mutation.sha256} reason=${mutation.reason.replace(/\s+/g, "_")}`);
}
console.log(`ref-array-store-body-binary-self-negatives=${mutations.length} valid-same-length rejected`);
console.log(`ref-array-store-body-binary-invalid-negatives=1 truncation rejected reason=${truncationReason.replace(/\s+/g, "_")}`);
console.log("ref-array-store-wat-stale-pairing-negative=1 rejected");
