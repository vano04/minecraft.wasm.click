#!/usr/bin/env node
// Structural and byte-level checker for the isolated M2-C1 module. The WAT
// is diagnostic; the actual Wasm parser below owns validation and mutation
// positions so a stale/disconnected disassembly cannot satisfy the gate.
import fs from "node:fs";
import crypto from "node:crypto";

const [, , binaryPath, watPath] = process.argv;
if (!binaryPath || !watPath) {
  console.error("usage: check-zero-linked-ref-array-load-wat.mjs MODULE.wasm MODULE.wat");
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

function parseFunction(bytes) {
  const code = sections(bytes).filter(({ id }) => id === 10);
  if (code.length !== 1) throw new Error(`code sections=${code.length}`);
  const section = code[0];
  let at = section.start;
  const [count, afterCount] = uleb(bytes, at);
  at = afterCount;
  if (count !== 1) throw new Error(`code count=${count}`);
  const [bodySize, afterSize] = uleb(bytes, at);
  at = afterSize;
  if (at + bodySize !== section.end) throw new Error("code body size mismatch");
  const bodyOffset = at;
  const body = bytes.subarray(at, at + bodySize);
  let cursor = 0;
  const [localGroups, afterLocals] = uleb(body, cursor);
  cursor = afterLocals;
  for (let i = 0; i < localGroups; i++) {
    const [localCount, afterCount] = uleb(body, cursor);
    cursor = afterCount + 1; // count plus one value-type byte
    if (cursor > body.length || localCount < 0) throw new Error("bad locals");
  }
  const instructions = [];
  while (cursor < body.length) {
    const position = cursor;
    const op = body[cursor++];
    const instruction = { op, position };
    switch (op) {
      case 0x02: case 0x03: case 0x04:
        if (cursor >= body.length) throw new Error("truncated block type");
        cursor++;
        break;
      case 0x0c: case 0x0d: case 0x10:
        [, cursor] = uleb(body, cursor);
        break;
      case 0x20:
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
        [, cursor] = uleb(body, cursor);
        [, cursor] = uleb(body, cursor);
        break;
      default:
        break;
    }
    if (cursor > body.length) throw new Error("truncated instruction");
    instructions.push(instruction);
  }
  return { body, bodyOffset, localGroups, instructions };
}

function parseMemoryImport(bytes) {
  const imports = sections(bytes).filter(({ id }) => id === 2);
  if (imports.length !== 1) throw new Error(`import sections=${imports.length}`);
  let at = imports[0].start;
  const [count, afterCount] = uleb(bytes, at);
  at = afterCount;
  if (count !== 1) throw new Error(`imports=${count}`);
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
  if (params !== 3 || bytes[at++] !== 0x7f || bytes[at++] !== 0x7f
      || bytes[at++] !== 0x7f) throw new Error("jiii params");
  let results;
  [results, at] = uleb(bytes, at);
  if (results !== 1 || bytes[at++] !== 0x7e || at !== types[0].end) {
    throw new Error("i64 result");
  }
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
  if (name !== "referenceArrayLoad" || bytes[at++] !== 0x00) throw new Error("export name/kind");
  [, at] = uleb(bytes, at);
  if (at !== exports[0].end) throw new Error("export trailing bytes");
  return { nameLengthPosition, nameStart, nameLength };
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

function checkBinary(binary) {
  if (!WebAssembly.validate(binary)) throw new Error("binary validation failed");
  parseMemoryImport(binary);
  parseType(binary);
  parseExports(binary);
  const parsed = parseFunction(binary);
  if (parsed.localGroups !== 0) throw new Error("reference function has locals");
  const ops = parsed.instructions.map(({ op }) => op);
  const count = (op) => ops.filter((value) => value === op).length;
  // One null-array guard plus the two independent effective-memory checks
  // (header and element end) each exercise the zero override branch.
  if (count(0x45) < 3) throw new Error("null/override guards incomplete");
  if (count(0x4b) !== 1) throw new Error("unsigned length/index guard missing");
  if (count(0x58) < 2) throw new Error("widened end guards incomplete");
  if (count(0x3f) !== 6) throw new Error("memory.size guards incomplete");
  if (count(0x7e) !== 12 || count(0x7c) !== 7) {
    throw new Error("widened arithmetic shape drift");
  }
  if (count(0xad) !== 16) throw new Error("unsigned i32-to-i64 extension drift");
  const loads = parsed.instructions.filter(({ op }) => op === 0x28);
  if (loads.length !== 2) throw new Error("reference lane must have exactly two i32.loads");
  const loadOffsets = loads.map(({ memargOffset }) => memargOffset);
  if (loads.some(({ memargAlignment }) => memargAlignment !== 2)
      || loadOffsets.filter((offset) => offset === 0).length !== 1
      || loadOffsets.filter((offset) => offset === 8).length !== 1) {
    throw new Error(`length/element load offsets=${loadOffsets.join(",")}`);
  }
  if (ops.some((op) => op >= 0x36 && op <= 0x3e)
      || ops.includes(0x10) || ops.includes(0x11) || ops.includes(0x00)) {
    throw new Error("reference lane contains a store/call/trap");
  }
  const status = parsed.instructions.filter(({ op, immediateValue }) =>
    op === 0x42 && immediateValue === 844433520066560n);
  if (status.length !== 4) throw new Error(`status/BCI literals=${status.length}`);

  // The first null check must inspect the incoming array reference itself.
  // This catches a same-length local-index mutation while the Wasm remains
  // valid, unlike changing i32.eqz into a binary comparison.
  const firstNullGuard = parsed.instructions.findIndex(({ op }) => op === 0x45);
  if (firstNullGuard <= 0
      || parsed.instructions[firstNullGuard - 1].op !== 0x20
      || parsed.instructions[firstNullGuard - 1].index !== 0) {
    throw new Error("null guard does not inspect array parameter");
  }
  return parsed;
}

function checkWatText(source) {
  if (!source.includes('(import "env" "memory"')) {
    throw new Error("memory import missing");
  }
  const exports = [...source.matchAll(/^\s*\(export "([^"]+)"/gm)]
    .map((m) => m[1]);
  if (exports.length !== 1 || exports[0] !== "referenceArrayLoad") {
    throw new Error(`unexpected exports: ${exports.join(",")}`);
  }
  const funcs = [...source.matchAll(/^\s*\(func \$[0-9]+/gm)];
  if (funcs.length !== 1) throw new Error(`function count=${funcs.length}`);
  const body = balancedSlice(source, "(func $0 ");
  // wasm-dis may print a multi-value parameter group as either
  // `(param i32 i32 i32)` or three named groups such as
  // `(param $0 i32) (param $1 i32) (param $2 i32)`.  Normalize both forms;
  // the binary type-section parser below remains authoritative.
  const watParamTypes = [];
  for (const match of body.matchAll(/\(param([^)]*)\)/g)) {
    for (const token of match[1].trim().split(/\s+/).filter(Boolean)) {
      if (!token.startsWith("$")) watParamTypes.push(token);
    }
  }
  if (watParamTypes.join(" ") !== "i32 i32 i32"
      || !/\(result(?:\s+\$[^\s()]+)?\s+i64\)/.test(body)) {
    throw new Error("jiii -> i64 function type missing");
  }
  const watLoads = [...body.matchAll(/\(i32\.load(?:\s+offset=(\d+))?/g)]
    .map((match) => match[1] === undefined ? 0 : Number(match[1]));
  if (watLoads.length !== 2 || watLoads.filter((offset) => offset === 0).length !== 1
      || watLoads.filter((offset) => offset === 8).length !== 1) {
    throw new Error(`expected one length load and one oop load: ${watLoads.join(",")}`);
  }
  for (const token of ["(i32.eqz", "(i32.gt_u", "(i64.le_u", "(i64.mul",
    "(i64.add", "(i64.extend_i32_u", "(i32.wrap_i64", "(memory.size)"]) {
    if (!body.includes(token)) throw new Error(`missing ${token}`);
  }
  if (/\(call(?:_indirect)?\b|\bunreachable\b|\(i32\.store/.test(body)) {
    throw new Error("reference body contains call/trap/store");
  }
  if ((body.match(/844433520066560/g) || []).length !== 4) {
    throw new Error("status/BCI literal mismatch");
  }
  return { body, watLoads };
}

const watDetails = checkWatText(wat);
const parsedOriginal = checkBinary(original);
const binaryLoads = parsedOriginal.instructions
  .filter(({ op }) => op === 0x28).map(({ memargOffset }) => memargOffset);
if (JSON.stringify(watDetails.watLoads) !== JSON.stringify(binaryLoads)) {
  throw new Error(`WAT/binary load pairing drift: wat=${watDetails.watLoads.join(",")} binary=${binaryLoads.join(",")}`);
}

// A stale disassembly must fail its own structural check and cannot be paired
// with the accepted binary merely because the function/export shape matches.
const staleWat = wat.replace("(i32.load offset=8", "(i32.load offset=12");
if (staleWat === wat) throw new Error("stale WAT mutation target absent");
try {
  checkWatText(staleWat);
  throw new Error("stale WAT pairing accepted");
} catch (error) {
  if (error?.message === "stale WAT pairing accepted") throw error;
}

const semanticMutations = [];
const mutationOffsets = new Set();
const mutationHashes = new Set();
const mutationReasons = new Set();

function expectReject(label, mutate, expectedReason) {
  const before = Buffer.from(original);
  const candidate = mutate(Buffer.from(original));
  if (!(candidate instanceof Uint8Array)) {
    throw new Error(`mutation did not return bytes: ${label}`);
  }
  if (candidate.length !== before.length) {
    throw new Error(`same-length mutation changed length: ${label}`);
  }
  const changed = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== candidate[i]) {
      changed.push({ offset: i, before: before[i], after: candidate[i] });
    }
  }
  if (changed.length !== 1) {
    throw new Error(`mutation changed ${changed.length} bytes: ${label}`);
  }
  const change = changed[0];
  if (mutationOffsets.has(change.offset)) {
    throw new Error(`mutation offset reused: ${label} offset=${change.offset}`);
  }
  mutationOffsets.add(change.offset);
  if (!WebAssembly.validate(candidate)) {
    throw new Error(`same-length mutation is not valid wasm: ${label}`);
  }
  let rejection;
  try {
    checkBinary(candidate);
  } catch (error) {
    rejection = error;
  }
  if (!rejection) {
    throw new Error(`binary checker accepted mutation: ${label}`);
  }
  const reason = String(rejection.message || rejection);
  if (expectedReason && !reason.includes(expectedReason)) {
    throw new Error(`mutation reason drift: ${label} reason=${reason}`);
  }
  if (mutationReasons.has(reason)) {
    throw new Error(`mutation rejection reason reused: ${label} reason=${reason}`);
  }
  mutationReasons.add(reason);
  const sha256 = crypto.createHash("sha256").update(candidate).digest("hex");
  if (mutationHashes.has(sha256)) {
    throw new Error(`mutation hash reused: ${label}`);
  }
  mutationHashes.add(sha256);
  semanticMutations.push({ label, ...change, sha256, reason });
}

function absoluteInstructionPosition(parsed, predicate) {
  const instruction = parsed.instructions.find(predicate);
  if (!instruction) throw new Error("instruction mutation target absent");
  return parsed.bodyOffset + instruction.position;
}

function absoluteImmediatePosition(parsed, predicate, field = "immediatePosition") {
  const instruction = parsed.instructions.find(predicate);
  if (!instruction || instruction[field] === undefined) {
    throw new Error("instruction immediate mutation target absent");
  }
  return parsed.bodyOffset + instruction[field];
}

// Valid same-length mutations exercise the actual binary parser, not only
// textual WAT predicates.
expectReject("signed length guard", (bytes) => {
  bytes[absoluteInstructionPosition(parsedOriginal, ({ op }) => op === 0x4b)] = 0x4a;
  return bytes;
}, "unsigned length/index guard missing");
expectReject("wrong widened arithmetic", (bytes) => {
  bytes[absoluteInstructionPosition(parsedOriginal, ({ op }) => op === 0x7e)] = 0x7c;
  return bytes;
}, "widened arithmetic shape drift");
expectReject("wrong widened end operator", (bytes) => {
  bytes[absoluteInstructionPosition(parsedOriginal, ({ op }) => op === 0x58)] = 0x57;
  return bytes;
}, "widened end guards incomplete");
expectReject("wrong length load offset", (bytes) => {
  const target = parsedOriginal.instructions.find(({ op, memargOffset }) =>
    op === 0x28 && memargOffset === 8);
  bytes[parsedOriginal.bodyOffset + target.memargOffsetPosition] = 12;
  return bytes;
}, "length/element load offsets=12,0");
expectReject("wrong load memarg alignment", (bytes) => {
  const target = parsedOriginal.instructions.find(({ op }) => op === 0x28);
  bytes[parsedOriginal.bodyOffset + target.memargAlignmentPosition] = 0;
  return bytes;
}, "length/element load offsets=8,0");
expectReject("wrong status BCI", (bytes) => {
  const target = parsedOriginal.instructions.find(({ op, immediateValue }) =>
    op === 0x42 && immediateValue === 844433520066560n);
  bytes[parsedOriginal.bodyOffset + target.immediatePosition] ^= 1;
  return bytes;
}, "status/BCI literals=3");
expectReject("wrong null guard local", (bytes) => {
  const firstNullGuard = parsedOriginal.instructions.findIndex(({ op }) => op === 0x45);
  const target = parsedOriginal.instructions[firstNullGuard - 1];
  bytes[parsedOriginal.bodyOffset + target.immediatePosition] = 1;
  return bytes;
}, "null guard does not inspect array parameter");
expectReject("signed i32-to-i64 extension", (bytes) => {
  bytes[absoluteInstructionPosition(parsedOriginal, ({ op }) => op === 0xad)] = 0xac;
  return bytes;
}, "unsigned i32-to-i64 extension drift");
const memoryImport = parseMemoryImport(original);
expectReject("memory import minimum", (bytes) => {
  bytes[memoryImport.minimumPosition] = 1;
  return bytes;
}, "memory limits flags=3 min=1");
expectReject("memory import maximum", (bytes) => {
  // 65536 is encoded as 80 80 04; changing the final payload to 03 yields
  // the equally-sized valid maximum 49152, which the exact limit guard rejects.
  bytes[memoryImport.maximumPosition + 2] = 0x03;
  return bytes;
}, "memory limits flags=3 min=0 max=49152");
const exportInfo = parseExports(original);
expectReject("export name", (bytes) => {
  bytes[exportInfo.nameStart] = "x".charCodeAt(0);
  return bytes;
}, "export name/kind");
const truncated = original.subarray(0, original.length - 1);
if (WebAssembly.validate(truncated)) throw new Error("truncated module validated");
let truncationReason;
try {
  checkBinary(truncated);
} catch (error) {
  truncationReason = String(error.message || error);
}
if (!truncationReason) throw new Error("truncated module checker accepted");
if (semanticMutations.length !== 11 || mutationOffsets.size !== 11
    || mutationHashes.size !== 11 || mutationReasons.size !== 11) {
  throw new Error(`semantic mutation accounting drift: ${semanticMutations.length}`);
}

console.log("ref-array-wat-binary-validation=pass");
console.log("ref-array-body-depth-aware=pass imports=1 exports=1 funcs=1 loads=2");
for (const mutation of semanticMutations) {
  console.log(`ref-array-binary-negative label=${mutation.label.replace(/[^a-z0-9]+/gi, "-")}`
    + ` offset=${mutation.offset} before=0x${mutation.before.toString(16).padStart(2, "0")}`
    + ` after=0x${mutation.after.toString(16).padStart(2, "0")}`
    + ` sha256=${mutation.sha256} reason=${mutation.reason.replace(/\s+/g, "_")}`);
}
console.log("ref-array-body-binary-self-negatives=11 valid-same-length rejected");
console.log(`ref-array-body-binary-invalid-negatives=1 truncation rejected reason=${truncationReason.replace(/\s+/g, "_")}`);
console.log("ref-array-wat-stale-pairing-negative=1 rejected");
