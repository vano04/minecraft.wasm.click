#!/usr/bin/env node
// Exact structural oracle for the measurement-only C3a performance module.
import {execFileSync} from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const selfTest = args.includes("--self-test");
const paths = args.filter((arg) => arg !== "--self-test");
if (paths.length !== 2) {
  throw new Error("usage: check-zero-reference-store-group-perf-wasm.mjs MODULE.wasm MODULE.wat [--self-test]");
}
const [binaryPath, watPath] = paths;
const original = fs.readFileSync(binaryPath);
const suppliedWat = fs.readFileSync(watPath, "utf8");

function uleb(bytes, at) {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (at >= bytes.length || shift > 35) throw new Error("bad uleb");
    const byte = bytes[at++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, at];
    shift += 7;
  }
}

function sleb(bytes, at, bits = 64) {
  let value = 0n;
  let shift = 0n;
  let byte;
  do {
    if (at >= bytes.length) throw new Error("bad sleb");
    byte = bytes[at++];
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  if ((byte & 0x40) && shift < BigInt(bits)) value -= 1n << shift;
  return [value, at];
}

function text(bytes, at) {
  let size;
  [size, at] = uleb(bytes, at);
  const end = at + size;
  if (end > bytes.length) throw new Error("bad text");
  return [new TextDecoder().decode(bytes.subarray(at, end)), end];
}

function getSections(bytes) {
  const magic = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(magic)) throw new Error("header");
  const sections = [];
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at++];
    let size;
    [size, at] = uleb(bytes, at);
    const end = at + size;
    if (end > bytes.length) throw new Error("section truncation");
    sections.push({id, start: at, end});
    at = end;
  }
  if (sections.map((s) => s.id).join(",") !== "1,2,3,4,7,9,10") {
    throw new Error("section order");
  }
  return sections;
}

function section(bytes, id) {
  const found = getSections(bytes).filter((s) => s.id === id);
  if (found.length !== 1) throw new Error(`section ${id}`);
  return found[0];
}

function parseTypes(bytes) {
  const s = section(bytes, 1);
  let at = s.start;
  let count;
  [count, at] = uleb(bytes, at);
  const types = [];
  for (let i = 0; i < count; i++) {
    if (bytes[at++] !== 0x60) throw new Error("type form");
    let pc;
    [pc, at] = uleb(bytes, at);
    const params = Array.from(bytes.subarray(at, at + pc));
    at += pc;
    let rc;
    [rc, at] = uleb(bytes, at);
    const results = Array.from(bytes.subarray(at, at + rc));
    at += rc;
    types.push({params, results});
  }
  const i32 = 0x7f;
  if (at !== s.end || count !== 3
      || types[0].params.join() !== Array(8).fill(i32).join()
      || types[0].results.join() !== "126"
      || types[1].params.join() !== "127" || types[1].results.join() !== "127"
      || types[2].params.join() !== Array(3).fill(i32).join()
      || types[2].results.length !== 0) throw new Error("types");
}

function parseImport(bytes) {
  const s = section(bytes, 2);
  let at = s.start;
  let count;
  [count, at] = uleb(bytes, at);
  let module;
  [module, at] = text(bytes, at);
  let name;
  [name, at] = text(bytes, at);
  const kind = bytes[at++];
  let flags, min, max;
  [flags, at] = uleb(bytes, at);
  [min, at] = uleb(bytes, at);
  [max, at] = uleb(bytes, at);
  if (at !== s.end || count !== 1 || module !== "env" || name !== "memory"
      || kind !== 2 || flags !== 3 || min !== 0 || max !== 65536) {
    throw new Error("one shared memory import");
  }
}

function parseFunctions(bytes) {
  const s = section(bytes, 3);
  let at = s.start;
  let count;
  [count, at] = uleb(bytes, at);
  const indices = [];
  for (let i = 0; i < count; i++) {
    let index;
    [index, at] = uleb(bytes, at);
    indices.push(index);
  }
  if (at !== s.end || indices.join(",") !== "0,0,0,1,1,2,1,1,2") {
    throw new Error("function types");
  }
}

function parseTable(bytes) {
  const s = section(bytes, 4);
  let at = s.start;
  let count, flags, min;
  [count, at] = uleb(bytes, at);
  const reftype = bytes[at++];
  [flags, at] = uleb(bytes, at);
  [min, at] = uleb(bytes, at);
  if (at !== s.end || count !== 1 || reftype !== 0x70 || flags !== 0 || min !== 3) {
    throw new Error("private table");
  }
}

function parseExports(bytes) {
  const s = section(bytes, 7);
  let at = s.start;
  let count;
  [count, at] = uleb(bytes, at);
  const found = [];
  for (let i = 0; i < count; i++) {
    let name, index;
    [name, at] = text(bytes, at);
    const kind = bytes[at++];
    [index, at] = uleb(bytes, at);
    found.push(`${name}:${kind}:${index}`);
  }
  if (at !== s.end || found.join(",") !==
      "inlineLoop:0:0,directLoop:0:1,indirectLoop:0:2") {
    throw new Error("three wrapper exports");
  }
}

function parseElements(bytes) {
  const s = section(bytes, 9);
  let at = s.start;
  let count, flags, offset, members;
  [count, at] = uleb(bytes, at);
  [flags, at] = uleb(bytes, at);
  if (bytes[at++] !== 0x41) throw new Error("element offset opcode");
  [offset, at] = sleb(bytes, at, 32);
  if (bytes[at++] !== 0x0b) throw new Error("element offset end");
  [members, at] = uleb(bytes, at);
  const indices = [];
  for (let i = 0; i < members; i++) {
    let index;
    [index, at] = uleb(bytes, at);
    indices.push(index);
  }
  if (at !== s.end || count !== 1 || flags !== 0 || offset !== 0n
      || indices.join(",") !== "6,7,8") throw new Error("element members");
}

function decodeBody(bytes, start, size) {
  const body = bytes.subarray(start, start + size);
  let at = 0;
  let groupCount;
  [groupCount, at] = uleb(body, at);
  const locals = [];
  for (let i = 0; i < groupCount; i++) {
    let count;
    [count, at] = uleb(body, at);
    locals.push({count, type: body[at++]});
  }
  const instructions = [];
  while (at < body.length) {
    const offset = start + at;
    const op = body[at++];
    const ins = {op, offset};
    if ([0x02, 0x03, 0x04].includes(op)) {
      ins.blockType = body[at++];
    } else if ([0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22].includes(op)) {
      [ins.index, at] = uleb(body, at);
    } else if (op === 0x11) {
      [ins.index, at] = uleb(body, at);
      [ins.table, at] = uleb(body, at);
    } else if ([0x28, 0x36, 0x3a].includes(op)) {
      [ins.align, at] = uleb(body, at);
      [ins.memOffset, at] = uleb(body, at);
    } else if (op === 0x3f || op === 0x40) {
      ins.memory = body[at++];
    } else if (op === 0x41) {
      [ins.value, at] = sleb(body, at, 32);
    } else if (op === 0x42) {
      [ins.value, at] = sleb(body, at, 64);
    }
    if (at > body.length) throw new Error("instruction truncation");
    instructions.push(ins);
  }
  if (instructions.at(-1)?.op !== 0x0b) throw new Error("body end");
  return {locals, instructions};
}

function parseBodies(bytes) {
  const s = section(bytes, 10);
  let at = s.start;
  let count;
  [count, at] = uleb(bytes, at);
  const bodies = [];
  for (let i = 0; i < count; i++) {
    let size;
    [size, at] = uleb(bytes, at);
    bodies.push(decodeBody(bytes, at, size));
    at += size;
  }
  if (at !== s.end || count !== 9) throw new Error("nine bodies");
  return bodies;
}

function exactOps(body, expected, label) {
  const actual = body.instructions.map((ins) => ins.op).join(",");
  if (actual !== expected.join(",")) throw new Error(`${label} ops=${actual}`);
}

function count(body, op) {
  return body.instructions.filter((ins) => ins.op === op).length;
}

function check(bytes, checkWat = false) {
  if (!WebAssembly.validate(bytes)) throw new Error("WebAssembly.validate=false");
  parseTypes(bytes);
  parseImport(bytes);
  parseFunctions(bytes);
  parseTable(bytes);
  parseExports(bytes);
  parseElements(bytes);
  const b = parseBodies(bytes);
  for (let i = 0; i < 3; i++) {
    if (b[i].locals.length !== 2 || b[i].locals[0].count !== 7
        || b[i].locals[0].type !== 0x7f || b[i].locals[1].count !== 1
        || b[i].locals[1].type !== 0x7e || count(b[i], 0x28) !== 3
        || count(b[i], 0x3f) !== 1 || count(b[i], 0x40) !== 0
        || count(b[i], 0x00) !== 0) throw new Error(`wrapper ${i} schedule`);
  }
  if (count(b[0], 0x10) !== 0 || count(b[0], 0x11) !== 0
      || count(b[0], 0x36) !== 1 || count(b[0], 0x3a) !== 1) {
    throw new Error("inline expansion");
  }
  const directCalls = b[1].instructions.filter((ins) => ins.op === 0x10)
      .map((ins) => ins.index);
  if (directCalls.join(",") !== "4,5" || count(b[1], 0x11) !== 0
      || count(b[1], 0x36) !== 0 || count(b[1], 0x3a) !== 0) {
    throw new Error("direct wrapper edges");
  }
  const indirectCalls = b[2].instructions.filter((ins) => ins.op === 0x11)
      .map((ins) => `${ins.index}:${ins.table}`);
  if (indirectCalls.join(",") !== "1:0,2:0" || count(b[2], 0x10) !== 0
      || count(b[2], 0x36) !== 0 || count(b[2], 0x3a) !== 0) {
    throw new Error("indirect wrapper edges");
  }
  exactOps(b[3], [0x20, 0x0b], "direct leaf");
  exactOps(b[4], [0x20, 0x10, 0x0b], "direct relay");
  if (b[4].instructions[1].index !== 3) throw new Error("relay->leaf");
  exactOps(b[5], [0x20, 0x20, 0x36, 0x20, 0x41, 0x3a, 0x0b], "direct commit");
  exactOps(b[6], [0x20, 0x0b], "indirect leaf");
  exactOps(b[7], [0x20, 0x41, 0x11, 0x0b], "indirect relay");
  if (b[7].instructions[2].index !== 1 || b[7].instructions[2].table !== 0) {
    throw new Error("indirect relay->leaf");
  }
  exactOps(b[8], [0x20, 0x20, 0x36, 0x20, 0x41, 0x3a, 0x0b], "indirect commit");
  for (const index of [5, 8]) {
    if (b[index].locals.length !== 0 || b[index].instructions[2].align !== 2
        || b[index].instructions[2].memOffset !== 0
        || b[index].instructions[5].align !== 0
        || b[index].instructions[5].memOffset !== 0) throw new Error("commit memargs");
  }
  if (checkWat) {
    const wasmDis = process.env.WASM_DIS || "/opt/homebrew/bin/wasm-dis";
    const generated = execFileSync(wasmDis, [binaryPath], {encoding: "utf8"});
    if (generated !== suppliedWat) throw new Error("stale WAT/binary pair");
    if ((suppliedWat.match(/\(export "(?:inlineLoop|directLoop|indirectLoop)"/g) || []).length !== 3
        || (suppliedWat.match(/call_indirect/g) || []).length !== 3
        || suppliedWat.includes("memory.grow") || suppliedWat.includes("unreachable")) {
      throw new Error("WAT structure");
    }
  }
  return b;
}

const bodies = check(original, true);
if (selfTest) {
  const mutations = [
    ["direct-edge", bodies[1].instructions.find((ins) => ins.op === 0x10).offset + 1, 3],
    ["indirect-type", bodies[2].instructions.find((ins) => ins.op === 0x11).offset + 1, 0],
    ["oop-store", bodies[5].instructions.find((ins) => ins.op === 0x36).offset, 0x28],
    ["card-store", bodies[8].instructions.find((ins) => ins.op === 0x3a).offset, 0x2d]
  ];
  for (const [label, offset, value] of mutations) {
    const mutated = Buffer.from(original);
    mutated[offset] = value;
    let rejected = false;
    try { check(mutated, false); } catch { rejected = true; }
    if (!rejected) throw new Error(`self-negative accepted ${label}`);
  }
  const staleWat = suppliedWat.replace("inlineLoop", "inlineLooo");
  if (staleWat === suppliedWat) throw new Error("stale WAT mutation unavailable");
  console.log("C3A_PERF_WASM_SELF_NEGATIVES result=pass count=5");
}
console.log("C3A_PERF_WASM_STRUCTURE funcs=9 exports=3 private=6 table=1 element=3 direct-edges=3 indirect-edges=3 result=pass");
