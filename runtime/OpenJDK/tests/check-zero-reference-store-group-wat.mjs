#!/usr/bin/env node
// Exact M2-C3a four-function reference-store-group Wasm/WAT checker.
import crypto from "node:crypto";
import fs from "node:fs";

const [, , binaryPath, watPath] = process.argv;
if (!binaryPath || !watPath) {
  throw new Error("usage: check-zero-reference-store-group-wat.mjs MODULE.wasm BOUND-MODULE.wat");
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
    if (shift > 35) throw new Error("invalid uleb");
  }
  throw new Error("truncated uleb");
}

function sleb(bytes, at, bits = 64) {
  let value = 0n;
  let shift = 0n;
  let byte = 0;
  do {
    if (at >= bytes.length) throw new Error("truncated sleb");
    byte = bytes[at++];
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  if ((byte & 0x40) && shift < BigInt(bits)) value -= 1n << shift;
  return [value, at];
}

function string(bytes, at) {
  let length;
  [length, at] = uleb(bytes, at);
  const end = at + length;
  if (end > bytes.length) throw new Error("truncated string");
  return [new TextDecoder().decode(bytes.subarray(at, end)), end];
}

function sections(bytes) {
  if (bytes.length < 8
      || !bytes.subarray(0, 8).equals(Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))) {
    throw new Error("bad wasm header");
  }
  const result = [];
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at++];
    let size;
    [size, at] = uleb(bytes, at);
    const end = at + size;
    if (end > bytes.length) throw new Error("truncated section");
    result.push({ id, start: at, end });
    at = end;
  }
  if (result.map(({ id }) => id).join(",") !== "1,2,3,7,10") {
    throw new Error("section shape=" + result.map(({ id }) => id).join(","));
  }
  return result;
}

function oneSection(bytes, id) {
  const found = sections(bytes).filter((section) => section.id === id);
  if (found.length !== 1) throw new Error(`section ${id} count=${found.length}`);
  return found[0];
}

function parseTypes(bytes) {
  const section = oneSection(bytes, 1);
  let at = section.start;
  let count;
  [count, at] = uleb(bytes, at);
  const types = [];
  for (let i = 0; i < count; i++) {
    if (bytes[at++] !== 0x60) throw new Error("non-function type");
    let params;
    [params, at] = uleb(bytes, at);
    const p = [];
    for (let j = 0; j < params; j++) p.push(bytes[at++]);
    const resultsCountPosition = at;
    let results;
    [results, at] = uleb(bytes, at);
    const r = [];
    for (let j = 0; j < results; j++) r.push(bytes[at++]);
    types.push({ p, r, resultsCountPosition });
  }
  if (at !== section.end || types.length !== 3
      || types[0].p.join() !== Array(6).fill(0x7f).join()
      || types[0].r.join() !== "126"
      || types[1].p.join() !== "127" || types[1].r.join() !== "127"
      || types[2].p.join() !== Array(3).fill(0x7f).join()
      || types[2].r.length !== 0) {
    throw new Error("exact type shape drift");
  }
  return types;
}

function parseImport(bytes) {
  const section = oneSection(bytes, 2);
  let at = section.start;
  let count;
  [count, at] = uleb(bytes, at);
  let module;
  [module, at] = string(bytes, at);
  let field;
  [field, at] = string(bytes, at);
  if (count !== 1 || module !== "env" || field !== "memory"
      || bytes[at++] !== 2) throw new Error("memory import shape");
  const flagsPosition = at;
  let flags;
  [flags, at] = uleb(bytes, at);
  const minimumPosition = at;
  let minimum;
  [minimum, at] = uleb(bytes, at);
  const maximumPosition = at;
  let maximum;
  [maximum, at] = uleb(bytes, at);
  if (flags !== 3 || minimum !== 0 || maximum !== 65536 || at !== section.end) {
    throw new Error("memory import limits");
  }
  return { flagsPosition, minimumPosition, maximumPosition };
}

function parseFunctions(bytes) {
  const section = oneSection(bytes, 3);
  let at = section.start;
  let count;
  [count, at] = uleb(bytes, at);
  const typeIndices = [];
  const typeIndexPositions = [];
  for (let i = 0; i < count; i++) {
    typeIndexPositions.push(at);
    let type;
    [type, at] = uleb(bytes, at);
    typeIndices.push(type);
  }
  if (at !== section.end || typeIndices.join(",") !== "0,1,1,2") {
    throw new Error("function type indices=" + typeIndices.join(","));
  }
  return { typeIndices, typeIndexPositions };
}

function parseExport(bytes) {
  const section = oneSection(bytes, 7);
  let at = section.start;
  let count;
  [count, at] = uleb(bytes, at);
  const nameLengthPosition = at;
  let nameLength;
  [nameLength, at] = uleb(bytes, at);
  const nameStart = at;
  const nameEnd = at + nameLength;
  const name = new TextDecoder().decode(bytes.subarray(at, nameEnd));
  at = nameEnd;
  if (count !== 1 || name !== "groupedReferenceStore" || bytes[at++] !== 0) {
    throw new Error("exact export shape");
  }
  const functionIndexPosition = at;
  let functionIndex;
  [functionIndex, at] = uleb(bytes, at);
  if (functionIndex !== 0 || at !== section.end) throw new Error("export index");
  return { nameLengthPosition, nameStart, functionIndexPosition };
}

function decodeBody(bytes, bodyOffset, bodySize) {
  const body = bytes.subarray(bodyOffset, bodyOffset + bodySize);
  let at = 0;
  let localGroups;
  [localGroups, at] = uleb(body, at);
  const locals = [];
  for (let i = 0; i < localGroups; i++) {
    const countPosition = at;
    let count;
    [count, at] = uleb(body, at);
    const type = body[at++];
    locals.push({ count, type, countPosition });
  }
  const instructions = [];
  while (at < body.length) {
    const position = at;
    const op = body[at++];
    const ins = { op, position };
    if (op === 0x02 || op === 0x03 || op === 0x04) {
      ins.blockType = body[at++];
    } else if (op === 0x0c || op === 0x0d || op === 0x10
        || op === 0x20 || op === 0x21) {
      ins.immediatePosition = at;
      [ins.index, at] = uleb(body, at);
    } else if (op === 0x11) {
      ins.immediatePosition = at;
      [ins.index, at] = uleb(body, at);
      [ins.table, at] = uleb(body, at);
    } else if (op === 0x28 || op === 0x36 || op === 0x3a) {
      ins.alignmentPosition = at;
      [ins.alignment, at] = uleb(body, at);
      ins.offsetPosition = at;
      [ins.offset, at] = uleb(body, at);
    } else if (op === 0x3f) {
      if (body[at++] !== 0) throw new Error("memory.size reserved byte");
    } else if (op === 0x41) {
      ins.immediatePosition = at;
      [ins.value, at] = sleb(body, at, 32);
    } else if (op === 0x42) {
      ins.immediatePosition = at;
      [ins.value, at] = sleb(body, at, 64);
    }
    if (at > body.length) throw new Error("truncated instruction");
    instructions.push(ins);
  }
  if (instructions.at(-1)?.op !== 0x0b) throw new Error("missing function end");
  return { body, bodyOffset, locals, instructions };
}

function parseBodies(bytes) {
  const section = oneSection(bytes, 10);
  let at = section.start;
  let count;
  [count, at] = uleb(bytes, at);
  const bodies = [];
  for (let i = 0; i < count; i++) {
    let size;
    [size, at] = uleb(bytes, at);
    const start = at;
    if (start + size > section.end) throw new Error("truncated body");
    bodies.push(decodeBody(bytes, start, size));
    at += size;
  }
  if (count !== 4 || at !== section.end) throw new Error("code count=" + count);
  return bodies;
}

const REEXECUTE_BCI0 = 3n << 48n;
const RETURN_BCI0 = 0n;

function checkBinary(bytes) {
  if (!WebAssembly.validate(bytes)) throw new Error("WebAssembly.validate=false");
  const types = parseTypes(bytes);
  const memory = parseImport(bytes);
  const functions = parseFunctions(bytes);
  const exported = parseExport(bytes);
  const bodies = parseBodies(bytes);
  const [entry, leaf, relay, commit] = bodies;
  const ops = (body) => body.instructions.map(({ op }) => op);
  const count = (body, op) => ops(body).filter((candidate) => candidate === op).length;

  if (entry.locals.length !== 1 || entry.locals[0].count !== 2
      || entry.locals[0].type !== 0x7f) throw new Error("entry locals");
  if (count(entry, 0x28) !== 1 || count(entry, 0x3f) !== 9
      || count(entry, 0x45) < 5 || count(entry, 0x4f) !== 1
      || count(entry, 0x56) !== 4 || count(entry, 0x54) !== 3
      || count(entry, 0x88) !== 3 || count(entry, 0x89) !== 0
      || count(entry, 0xa7) !== 2 || count(entry, 0x36) !== 0
      || count(entry, 0x3a) !== 0 || count(entry, 0x11) !== 0) {
    throw new Error("entry guard/store opcode shape");
  }
  const status = entry.instructions.filter(({ op, value }) =>
    op === 0x42 && value === REEXECUTE_BCI0);
  if (status.length !== 8) throw new Error("entry BCI0 status count=" + status.length);
  const success = entry.instructions.filter(({ op, value }) =>
    op === 0x42 && value === RETURN_BCI0);
  if (success.length !== 1) throw new Error("entry packed success count=" + success.length);
  const calls = entry.instructions.filter(({ op }) => op === 0x10);
  if (calls.map(({ index }) => index).join(",") !== "2,3") {
    throw new Error("entry call edges=" + calls.map(({ index }) => index).join(","));
  }
  const firstCall = entry.instructions.indexOf(calls[0]);
  const guardOps = new Set([0x28, 0x3f, 0x45, 0x4f, 0x54, 0x56, 0x88]);
  if (entry.instructions.slice(firstCall).some(({ op }) => guardOps.has(op))) {
    throw new Error("guard or load follows first private call");
  }
  const firstCallIndex = entry.instructions.indexOf(calls[0]);
  const commitCallIndex = entry.instructions.indexOf(calls[1]);
  const packedPrefix = entry.instructions.slice(firstCallIndex - 6, firstCallIndex);
  if (packedPrefix.map(({ op }) => op).join(",") !== "32,173,66,132,32,32"
      || packedPrefix[0].index !== 2 || packedPrefix[2].value !== RETURN_BCI0
      || packedPrefix[4].index !== 6 || packedPrefix[5].index !== 2
      || commitCallIndex !== firstCallIndex + 2
      || entry.instructions[firstCallIndex + 1].op !== 0x20
      || entry.instructions[firstCallIndex + 1].index !== 7
      || entry.instructions.slice(commitCallIndex + 1).some(({ op }) => op !== 0x0b)) {
    throw new Error("entry buried-result/void-commit terminal tail");
  }
  const nullGuard = entry.instructions.findIndex(({ op }) => op === 0x45);
  if (nullGuard < 1 || entry.instructions[nullGuard - 1].op !== 0x20
      || entry.instructions[nullGuard - 1].index !== 0) {
    throw new Error("null precedence/local");
  }
  const bounds = entry.instructions.findIndex(({ op }) => op === 0x4f);
  const assignability = entry.instructions.findIndex(({ op }, i) =>
    op === 0x45 && entry.instructions[i - 1]?.op === 0x20
      && entry.instructions[i - 1]?.index === 5);
  if (bounds < 0 || assignability <= bounds || calls[0].position <= assignability) {
    throw new Error("bounds/assignability/call order");
  }
  const shifts = entry.instructions.map((instruction, index) =>
    instruction.op === 0x88 ? entry.instructions[index - 1] : null).filter(Boolean);
  if (shifts.length !== 3 || shifts.some(({ op }) => op !== 0x42)
      || shifts.some(({ value }) => value !== 9n)) {
    throw new Error("exact card-shift constants");
  }

  if (leaf.locals.length !== 0 || ops(leaf).join(",") !== "32,11"
      || leaf.instructions[0].index !== 0) throw new Error("leaf body");
  if (relay.locals.length !== 0 || ops(relay).join(",") !== "32,16,11"
      || relay.instructions[0].index !== 0 || relay.instructions[1].index !== 1) {
    throw new Error("relay body/edge");
  }
  if (commit.locals.length !== 0 || count(commit, 0x36) !== 1
      || count(commit, 0x3a) !== 1 || count(commit, 0x10) !== 0
      || count(commit, 0x11) !== 0 || count(commit, 0x28) !== 0) {
    throw new Error("commit store/call shape");
  }
  const oopStore = commit.instructions.find(({ op }) => op === 0x36);
  const cardStore = commit.instructions.find(({ op }) => op === 0x3a);
  const oopIndex = commit.instructions.indexOf(oopStore);
  const cardIndex = commit.instructions.indexOf(cardStore);
  if (ops(commit).join(",") !== "32,32,54,32,65,58,11"
      || commit.instructions[0].index !== 0
      || commit.instructions[1].index !== 1
      || commit.instructions[3].index !== 2
      || oopIndex !== 2 || cardIndex !== 5
      || oopStore.alignment !== 2 || oopStore.offset !== 0
      || cardStore.alignment !== 0 || cardStore.offset !== 0
      || commit.instructions[4].value !== 0n
      || commit.instructions.slice(cardIndex + 1).some(({ op }) => op !== 0x0b)) {
    throw new Error("void commit exact oop-store/card-store/end tail");
  }
  const all = bodies.flatMap((body) => body.instructions);
  if (all.filter(({ op }) => op === 0x10).length !== 3
      || all.some(({ op }) => op === 0x11 || op === 0x00 || op === 0x0e)) {
    throw new Error("direct-call/table/trap shape");
  }
  return { types, functions, memory, exported, bodies, entry, relay, commit,
           cardShift: shifts[0].value };
}

function boundBinaryDigest(source) {
  const bindings = [...source.matchAll(
    /^;; mcweb-binary-sha256=([0-9a-f]{64})$/gm)];
  if (bindings.length !== 1) throw new Error("WAT binary digest binding count");
  return bindings[0][1];
}

function checkPairing(bytes, source) {
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (boundBinaryDigest(source) !== actual) throw new Error("WAT/binary digest mismatch");
}

function definedWatFunctions(source) {
  const starts = [...source.matchAll(/^\s*\(func(?:\s|$)/gm)]
    .map((match) => match.index + match[0].indexOf("(func"));
  return starts.map((start) => {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let at = start; at < source.length; at++) {
      const ch = source[at];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return source.slice(start, at + 1);
    }
    throw new Error("unterminated WAT function");
  });
}

function watExpression(source) {
  const tokens = [];
  let at = 0;
  while (at < source.length) {
    if (/\s/.test(source[at])) { at++; continue; }
    if (source.startsWith(";;", at)) {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source[at] === "(" || source[at] === ")") {
      tokens.push(source[at++]);
      continue;
    }
    if (source[at] === '"') {
      const start = at++;
      let escaped = false;
      while (at < source.length) {
        const ch = source[at++];
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') break;
      }
      if (source[at - 1] !== '"') throw new Error("unterminated WAT string");
      tokens.push(source.slice(start, at));
      continue;
    }
    const start = at;
    while (at < source.length && !/[\s()]/.test(source[at])) at++;
    if (start === at) throw new Error("invalid WAT token");
    tokens.push(source.slice(start, at));
  }
  let cursor = 0;
  const parse = () => {
    if (tokens[cursor++] !== "(") throw new Error("expected WAT list");
    const list = [];
    while (cursor < tokens.length && tokens[cursor] !== ")") {
      list.push(tokens[cursor] === "(" ? parse() : tokens[cursor++]);
    }
    if (tokens[cursor++] !== ")") throw new Error("unbalanced WAT expression");
    return list;
  };
  const result = parse();
  if (cursor !== tokens.length) throw new Error("trailing WAT expression");
  return result;
}

const watListEquals = (actual, expected) => Array.isArray(actual)
  && actual.length === expected.length
  && actual.every((value, index) => Array.isArray(expected[index])
    ? watListEquals(value, expected[index]) : value === expected[index]);

function checkVoidCommitWat(source) {
  const form = watExpression(source);
  const expectedParams = [
    ["param", "$0", "i32"],
    ["param", "$1", "i32"],
    ["param", "$2", "i32"]
  ];
  if (form[0] !== "func" || form[1] !== "$3"
      || !watListEquals(form[2], expectedParams[0])
      || !watListEquals(form[3], expectedParams[1])
      || !watListEquals(form[4], expectedParams[2])
      || form.slice(2).some((item) => Array.isArray(item)
        && (item[0] === "result" || item[0] === "local"))
      || form.length !== 7) {
    throw new Error("WAT void commit signature/operation count");
  }
  const oopStore = ["i32.store", ["local.get", "$0"], ["local.get", "$1"]];
  const cardStore = ["i32.store8", ["local.get", "$2"], ["i32.const", "0"]];
  if (!watListEquals(form[5], oopStore) || !watListEquals(form[6], cardStore)) {
    throw new Error("WAT void commit exact stores/memargs/terminal tail");
  }
}

function checkWat(source) {
  if (!source.includes('(import "env" "memory"')) throw new Error("WAT memory import");
  const exports = [...source.matchAll(/\(export "([^"]+)"/g)].map((match) => match[1]);
  if (exports.length !== 1 || exports[0] !== "groupedReferenceStore") {
    throw new Error("WAT exports=" + exports.join(","));
  }
  const definedFunctions = definedWatFunctions(source);
  if (definedFunctions.length !== 4
      || (source.match(/\(call\b/g) || []).length !== 3
      || /call_indirect|\(table\b|\(elem\b|unreachable/.test(source)
      || (source.match(/\(i32\.store(?!8\b)/g) || []).length !== 1
      || (source.match(/\(i32\.store8\b/g) || []).length !== 1
      || (source.match(/\(i64\.shr_u\b/g) || []).length !== 3) {
    throw new Error("WAT function/call/store shape");
  }
  const commit = definedFunctions[3];
  const oopStore = commit.indexOf("i32.store");
  const cardStore = commit.indexOf("i32.store8");
  if (oopStore < 0 || cardStore <= oopStore) {
    throw new Error("WAT void commit oop-store/card-store8/end order");
  }
  checkVoidCommitWat(commit);
  const entry = definedFunctions[0];
  const privateWat = definedFunctions.slice(1).join("\n");
  const scratchDecls = entry.match(/\(local\s+(\$[^\s()]+)\s+i64\)/g) || [];
  if (scratchDecls.length > 1 || /\(local\s+\$[^\s()]+\s+i64\)/.test(privateWat)) {
    throw new Error("WAT scratch confined to exported entry");
  }
  if (scratchDecls.length === 1) {
    const scratch = scratchDecls[0].match(/\(local\s+(\$[^\s()]+)/)[1];
    const escaped = scratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const scratchSets = [...entry.matchAll(new RegExp(
      `\\(local\\.set\\s+${escaped}(?=\\s|\\))`, "g"))];
    const scratchGets = [...entry.matchAll(new RegExp(
      `\\(local\\.get\\s+${escaped}(?=\\s|\\))`, "g"))];
    if (scratchSets.length !== 1 || scratchGets.length !== 1) {
      throw new Error("WAT exact buried-result scratch identity");
    }
    const commitCall = entry.lastIndexOf("(call $3");
    if (scratchSets[0].index >= commitCall || scratchGets[0].index <= commitCall) {
      throw new Error("WAT scratch set/call/get order");
    }
  }
  const shifts = [];
  const visit = (form) => {
    if (!Array.isArray(form)) return;
    if (form[0] === "i64.shr_u") shifts.push(form);
    for (const child of form) visit(child);
  };
  visit(watExpression(source));
  if (shifts.length !== 3 || shifts.some((form) => form.length !== 3
      || !watListEquals(form[2], ["i64.const", "9"]))) {
    throw new Error("WAT exact card-shift constants");
  }
  return { cardShift: 9n };
}

checkPairing(original, wat);
const watDetails = checkWat(wat);
const parsed = checkBinary(original);
if (watDetails.cardShift !== parsed.cardShift) {
  throw new Error("WAT/binary card-shift mismatch");
}
const staleBinary = Buffer.from(original);
staleBinary[parsed.exported.nameStart] = staleBinary[parsed.exported.nameStart] === 0x78
    ? 0x79 : 0x78;
if (!WebAssembly.validate(staleBinary)) throw new Error("stale-pair binary invalid");
try {
  checkPairing(staleBinary, wat);
  throw new Error("stale WAT accepted");
} catch (error) {
  if (error.message === "stale WAT accepted") throw error;
}

const offsets = new Set();
const hashes = new Set();
const mutations = [];
function absolute(body, instruction, field = "position") {
  if (!instruction || instruction[field] === undefined) throw new Error("mutation target");
  return body.bodyOffset + instruction[field];
}
function expectReject(label, mutate) {
  const candidate = mutate(Buffer.from(original));
  if (candidate.length !== original.length) throw new Error(label + " length");
  const changed = [];
  for (let i = 0; i < original.length; i++) {
    if (candidate[i] !== original[i]) changed.push(i);
  }
  if (changed.length !== 1 || offsets.has(changed[0])) {
    throw new Error(label + " unique one-byte mutation");
  }
  offsets.add(changed[0]);
  if (!WebAssembly.validate(candidate)) throw new Error(label + " did not validate");
  let reason = "";
  try { checkBinary(candidate); } catch (error) { reason = error.message; }
  if (!reason) throw new Error(label + " accepted");
  const sha256 = crypto.createHash("sha256").update(candidate).digest("hex");
  if (hashes.has(sha256)) throw new Error(label + " duplicate hash");
  hashes.add(sha256);
  mutations.push({ label, offset: changed[0], before: original[changed[0]],
                   after: candidate[changed[0]], sha256, reason });
}

const { entry, relay, commit, memory, exported, types } = parsed;
entry.instructions.filter(({ op }) => op === 0x56).forEach((instruction, i) =>
  expectReject(`gt-u-${i}`, (bytes) => {
    bytes[absolute(entry, instruction)] = 0x55;
    return bytes;
  }));
const shifts = entry.instructions.filter(({ op }) => op === 0x88);
expectReject("card-shr-u-opcode", (bytes) => {
  bytes[absolute(entry, shifts[0])] = 0x89;
  return bytes;
});
shifts.forEach((instruction, i) => {
  const index = entry.instructions.indexOf(instruction);
  const constant = entry.instructions[index - 1];
  expectReject(`card-shift-${i}`, (bytes) => {
    bytes[absolute(entry, constant, "immediatePosition")] ^= 1;
    return bytes;
  });
});
expectReject("bounds-opcode", (bytes) => {
  const instruction = entry.instructions.find(({ op }) => op === 0x4f);
  bytes[absolute(entry, instruction)] = 0x4b;
  return bytes;
});
expectReject("null-local", (bytes) => {
  const guard = entry.instructions.findIndex(({ op }) => op === 0x45);
  bytes[absolute(entry, entry.instructions[guard - 1], "immediatePosition")] = 1;
  return bytes;
});
expectReject("assignability-local", (bytes) => {
  const guard = entry.instructions.findIndex(({ op }, i) => op === 0x45
      && entry.instructions[i - 1]?.index === 5);
  bytes[absolute(entry, entry.instructions[guard - 1], "immediatePosition")] = 4;
  return bytes;
});
expectReject("reexecute-status", (bytes) => {
  const instruction = entry.instructions.find(({ op, value }) =>
    op === 0x42 && value === REEXECUTE_BCI0);
  bytes[absolute(entry, instruction, "immediatePosition")] ^= 1;
  return bytes;
});
expectReject("memory-minimum", (bytes) => {
  bytes[memory.minimumPosition] = 1;
  return bytes;
});
expectReject("memory-maximum", (bytes) => {
  bytes[memory.maximumPosition + 2] = 3;
  return bytes;
});
expectReject("export-name", (bytes) => {
  bytes[exported.nameStart] = "x".charCodeAt(0);
  return bytes;
});
expectReject("export-index", (bytes) => {
  bytes[exported.functionIndexPosition] = 1;
  return bytes;
});
expectReject("entry-relay-target", (bytes) => {
  const call = entry.instructions.find(({ op, index }) => op === 0x10 && index === 2);
  bytes[absolute(entry, call, "immediatePosition")] = 1;
  return bytes;
});
expectReject("relay-leaf-target", (bytes) => {
  const call = relay.instructions.find(({ op }) => op === 0x10);
  bytes[absolute(relay, call, "immediatePosition")] = 2;
  return bytes;
});
expectReject("oop-store-alignment", (bytes) => {
  const store = commit.instructions.find(({ op }) => op === 0x36);
  bytes[absolute(commit, store, "alignmentPosition")] = 1;
  return bytes;
});
expectReject("card-store-opcode", (bytes) => {
  const store = commit.instructions.find(({ op }) => op === 0x3a);
  bytes[absolute(commit, store)] = 0x36;
  return bytes;
});

const expectedLabels = [
  "gt-u-0", "gt-u-1", "gt-u-2", "gt-u-3", "card-shr-u-opcode",
  "card-shift-0", "card-shift-1", "card-shift-2", "bounds-opcode",
  "null-local", "assignability-local", "reexecute-status", "memory-minimum",
  "memory-maximum", "export-name", "export-index", "entry-relay-target",
  "relay-leaf-target", "oop-store-alignment", "card-store-opcode"
];
if (mutations.map(({ label }) => label).join(",") !== expectedLabels.join(",")
    || mutations.length !== 20 || offsets.size !== 20 || hashes.size !== 20) {
  throw new Error("mutation accounting=" + mutations.length);
}
const truncated = original.subarray(0, original.length - 1);
if (WebAssembly.validate(truncated)) throw new Error("truncation validated");
try {
  checkBinary(truncated);
  throw new Error("truncation accepted");
} catch (error) {
  if (error.message === "truncation accepted") throw error;
}

const invalidOffsets = new Set();
const invalidHashes = new Set();
const invalidMutations = [];
function expectInvalid(label, mutate) {
  const candidate = mutate(Buffer.from(original));
  if (candidate.length !== original.length) throw new Error(label + " invalid length");
  const changed = [];
  for (let i = 0; i < original.length; i++) {
    if (candidate[i] !== original[i]) changed.push(i);
  }
  if (changed.length !== 1 || invalidOffsets.has(changed[0])) {
    throw new Error(label + " invalid unique one-byte mutation");
  }
  invalidOffsets.add(changed[0]);
  let rejected = !WebAssembly.validate(candidate);
  if (!rejected) {
    try { checkBinary(candidate); }
    catch { rejected = true; }
  }
  if (!rejected) throw new Error(label + " invalid mutation accepted");
  const sha256 = crypto.createHash("sha256").update(candidate).digest("hex");
  if (invalidHashes.has(sha256)) throw new Error(label + " invalid duplicate hash");
  invalidHashes.add(sha256);
  invalidMutations.push({ label, offset: changed[0], sha256 });
}
expectInvalid("commit-type-result-count", (bytes) => {
  bytes[types[2].resultsCountPosition] = 1;
  return bytes;
});
expectInvalid("entry-commit-call-target", (bytes) => {
  const call = entry.instructions.find(({ op, index }) => op === 0x10 && index === 3);
  bytes[absolute(entry, call, "immediatePosition")] = 0;
  return bytes;
});
expectInvalid("commit-terminal-end", (bytes) => {
  bytes[absolute(commit, commit.instructions.at(-1))] = 0x01;
  return bytes;
});

function expectWatReject(label, candidate) {
  let rejected = false;
  try { checkWat(candidate); }
  catch { rejected = true; }
  if (!rejected) throw new Error(label + " WAT negative accepted");
}
expectWatReject("extra-entry-scratch", wat.replace(
  /^\s*\(func(?:\s|$)/m, (match) => match + "\n    (local $mcweb_extra i64)"));
expectWatReject("private-scratch", wat.replace(
  /^\s*\(func(?:\s|$)/gm, (match, offset) => offset === wat.indexOf(match)
    ? match : match + "\n    (local $mcweb_private i64)"));
const watRender = (value) => Array.isArray(value)
  ? `(${value.map(watRender).join(" ")})` : value;
const actualCommitWat = definedWatFunctions(wat)[3];
const rejectCommitMutation = (label, mutate) => {
  const form = structuredClone(watExpression(actualCommitWat));
  mutate(form);
  expectWatReject(label, wat.replace(actualCommitWat, watRender(form)));
};
rejectCommitMutation("commit-reversed-stores", (form) => {
  [form[5], form[6]] = [form[6], form[5]];
});
rejectCommitMutation("commit-extra-folded-operand", (form) => {
  form[6].push(["i32.const", "1"]);
});
rejectCommitMutation("commit-wrong-store8-address", (form) => {
  form[6][1] = ["local.get", "$1"];
});
rejectCommitMutation("commit-wrong-store8-value", (form) => {
  form[6][2] = ["i32.const", "1"];
});
rejectCommitMutation("commit-wrong-store8-value-local", (form) => {
  form[6][2] = ["local.get", "$0"];
});
rejectCommitMutation("commit-wrong-store8-memarg", (form) => {
  form[6].splice(1, 0, "offset=1");
});
expectWatReject("commit-malformed-unbalanced",
  wat.replace(actualCommitWat, actualCommitWat.slice(0, -1)));
for (const [label, instruction] of [
  ["postcommit-call", "(call $1 (i32.const 0))"],
  ["postcommit-load", "(drop (i32.load (i32.const 0)))"],
  ["postcommit-branch", "(block (br 0))"]
]) {
  const functions = definedWatFunctions(wat);
  const badCommit = functions[3].slice(0, -1) + `\n    ${instruction})`;
  expectWatReject(label, wat.replace(functions[3], badCommit));
}

console.log("reference-store-group-wat-binary=pass funcs=4 exports=1 private=3"
  + " table-slots=1 private-slots=0 direct-calls=3 oop-stores=1 card-stores=1");
for (const mutation of mutations) {
  console.log(`reference-store-group-binary-negative label=${mutation.label}`
    + ` offset=${mutation.offset}`
    + ` before=0x${mutation.before.toString(16).padStart(2, "0")}`
    + ` after=0x${mutation.after.toString(16).padStart(2, "0")}`
    + ` sha256=${mutation.sha256}`
    + ` reason=${mutation.reason.replace(/\s+/g, "_")}`);
}
console.log("reference-store-group-binary-self-negatives=20 valid-same-length rejected");
console.log("reference-store-group-binary-invalid-negatives=4"
  + " truncation,commit-type,commit-call,commit-tail rejected");
console.log("reference-store-group-wat-self-negatives=12"
  + " scratch=2 commit-structure=7 postcommit=call,load,branch rejected");
console.log("reference-store-group-wat-stale-pairing-negative=1 rejected");
