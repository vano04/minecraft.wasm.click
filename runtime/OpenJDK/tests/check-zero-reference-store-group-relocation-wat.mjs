#!/usr/bin/env node
// Structural binary/WAT oracle for the C3b Stage-1 six-function module.
import fs from "node:fs";

const encU = (value) => {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
};
const str = (value) => {
  const encoded = Buffer.from(value, "utf8");
  return [...encU(encoded.length), ...encoded];
};
const section = (id, payload) => [id, ...encU(payload.length), ...payload];
const body = (payload) => [...encU(payload.length), ...payload];

const canonicalBodies = () => {
  // The dispatcher is a compact structural oracle body. The C++ source gate
  // separately pins the full widened guard emitter before a runtime dump is
  // admitted in a later stage.
  const dispatcher = [
    0x01, 0x02, 0x7f,
    0x20, 0x00, 0x45, 0x04, 0x7e,
    0x20, 0x03, 0x10, 0x01, 0xad, 0x42, 0x00, 0x84,
    0x05,
    0x20, 0x03, 0x20, 0x04, 0x47,
    0x20, 0x05, 0x45, 0x72,
    0x04, 0x7e, 0x42, 0x00, 0x05,
    0x20, 0x04, 0xad, 0x42, 0x00, 0x84,
    0x20, 0x09, 0x20, 0x04, 0x20, 0x0a, 0x10, 0x02,
    0x0b, 0x0b, 0x0b
  ];
  return [
    dispatcher,
    [0x00, 0x20, 0x00, 0x10, 0x04, 0x0b],
    [0x00, 0x20, 0x00, 0x20, 0x01, 0x10, 0x04,
      0x20, 0x02, 0x10, 0x05, 0x0b],
    [0x00, 0x20, 0x00, 0x0b],
    [0x00, 0x20, 0x00, 0x10, 0x03, 0x0b],
    [0x00, 0x20, 0x00, 0x20, 0x01, 0x36, 0x02, 0x00,
      0x20, 0x02, 0x41, 0x00, 0x3a, 0x00, 0x00, 0x0b]
  ];
};

const canonicalBinary = (bodies = canonicalBodies(), options = {}) => {
  const types = [
    0x03,
    0x60, 0x09, ...Array(9).fill(0x7f), 0x01, 0x7e,
    0x60, 0x01, 0x7f, 0x01, 0x7f,
    0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x00
  ];
  const imports = [0x01, ...str("env"), ...str("memory"),
    0x02, 0x03, 0x00, 0x80, 0x80, 0x04];
  const functions = [0x06, 0x00, 0x01, 0x02, 0x01, 0x01, 0x02];
  const name = "groupedReferenceStoreAcrossRelocation";
  const exports = [0x01, ...str(name), 0x00, 0x00];
  const code = [0x06, ...bodies.flatMap((value) => body(value))];
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types), ...section(2, imports), ...section(3, functions),
    // A table is never part of the Stage-1 module. The self-test builds one
    // only to prove the section closure and the indirect-edge scan reject it.
    ...(options.withTable ? section(4, [0x01, 0x70, 0x00, 0x01]) : []),
    ...section(7, exports), ...section(10, code)
  ]);
};

const readU = (bytes, cursor) => {
  let value = 0;
  let shift = 0;
  for (let count = 0; count < 5; count++) {
    if (cursor.pos >= bytes.length) throw new Error("truncated uleb");
    const byte = bytes[cursor.pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
  }
  throw new Error("oversized uleb");
};
const readBytes = (bytes, cursor, length) => {
  if (cursor.pos + length > bytes.length) throw new Error("truncated bytes");
  const result = bytes.subarray(cursor.pos, cursor.pos + length);
  cursor.pos += length;
  return result;
};
const readString = (bytes, cursor) =>
  readBytes(bytes, cursor, readU(bytes, cursor)).toString("utf8");

const parseModule = (bytes) => {
  if (!bytes.subarray(0, 8).equals(Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00
  ]))) throw new Error("bad wasm header");
  const cursor = { pos: 8 };
  const sections = new Map();
  let previous = 0;
  while (cursor.pos < bytes.length) {
    const id = bytes[cursor.pos++];
    const length = readU(bytes, cursor);
    if (id === 0 || id <= previous || sections.has(id)) {
      throw new Error("section order/duplicate/custom");
    }
    previous = id;
    sections.set(id, Buffer.from(readBytes(bytes, cursor, length)));
  }
  const ids = [...sections.keys()];
  if (ids.join(",") !== "1,2,3,7,10") {
    throw new Error("section ids=" + ids.join(","));
  }
  return sections;
};

const parseCodeBodies = (payload) => {
  const cursor = { pos: 0 };
  const count = readU(payload, cursor);
  const bodies = [];
  for (let i = 0; i < count; i++) {
    bodies.push(Buffer.from(readBytes(payload, cursor, readU(payload, cursor))));
  }
  if (cursor.pos !== payload.length) throw new Error("code trailing bytes");
  return bodies;
};
// A real instruction decoder. Raw-byte scanning cannot tell a store opcode
// from a byte inside an immediate, so every structural claim below is made on
// decoded instructions and any opcode outside this whitelist fails closed.
const NONE = "none", U32 = "u32", S32 = "s32", S64 = "s64", BT = "blocktype",
      MEMARG = "memarg", U32X2 = "u32x2", F32 = "f32", F64 = "f64",
      PREFIX = "prefix";
const opcodeTable = new Map([
  [0x00, ["unreachable", NONE]], [0x01, ["nop", NONE]],
  [0x02, ["block", BT]], [0x03, ["loop", BT]], [0x04, ["if", BT]],
  [0x05, ["else", NONE]], [0x0b, ["end", NONE]],
  [0x0c, ["br", U32]], [0x0d, ["br_if", U32]], [0x0f, ["return", NONE]],
  [0x10, ["call", U32]], [0x11, ["call_indirect", U32X2]],
  [0x1a, ["drop", NONE]], [0x1b, ["select", NONE]],
  [0x20, ["local.get", U32]], [0x21, ["local.set", U32]],
  [0x22, ["local.tee", U32]], [0x23, ["global.get", U32]],
  [0x24, ["global.set", U32]],
  [0x3f, ["memory.size", U32]], [0x40, ["memory.grow", U32]],
  [0x41, ["i32.const", S32]], [0x42, ["i64.const", S64]],
  [0x43, ["f32.const", F32]], [0x44, ["f64.const", F64]],
  [0xfc, ["prefix.fc", PREFIX]], [0xfe, ["prefix.atomic", PREFIX]]
]);
const loadNames = ["i32.load", "i64.load", "f32.load", "f64.load",
  "i32.load8_s", "i32.load8_u", "i32.load16_s", "i32.load16_u",
  "i64.load8_s", "i64.load8_u", "i64.load16_s", "i64.load16_u",
  "i64.load32_s", "i64.load32_u"];
const storeNames = ["i32.store", "i64.store", "f32.store", "f64.store",
  "i32.store8", "i32.store16", "i64.store8", "i64.store16", "i64.store32"];
for (let i = 0; i < loadNames.length; i++) {
  opcodeTable.set(0x28 + i, [loadNames[i], MEMARG]);
}
for (let i = 0; i < storeNames.length; i++) {
  opcodeTable.set(0x36 + i, [storeNames[i], MEMARG]);
}
// 0x45..0xc4 are the MVP numeric operators; none carries an immediate.
for (let op = 0x45; op <= 0xc4; op++) {
  if (!opcodeTable.has(op)) opcodeTable.set(op, ["numeric." + op.toString(16), NONE]);
}
const writeOpcodes = new Set(storeNames);
const decodeLocals = (bodyBytes, cursor) => {
  const groups = readU(bodyBytes, cursor);
  const locals = [];
  for (let i = 0; i < groups; i++) {
    const count = readU(bodyBytes, cursor);
    const type = bodyBytes[cursor.pos++];
    locals.push({ count, type });
  }
  return locals;
};
const readS = (bytes, cursor, maxBytes) => {
  let shift = 0;
  let value = 0n;
  for (let count = 0; count < maxBytes; count++) {
    if (cursor.pos >= bytes.length) throw new Error("truncated sleb");
    const byte = bytes[cursor.pos++];
    value |= BigInt(byte & 0x7f) << BigInt(shift);
    shift += 7;
    if ((byte & 0x80) === 0) return value;
  }
  throw new Error("oversized sleb");
};
const decodeBody = (bodyBytes) => {
  const cursor = { pos: 0 };
  const locals = decodeLocals(bodyBytes, cursor);
  const instructions = [];
  let depth = 0;
  while (cursor.pos < bodyBytes.length) {
    const at = cursor.pos;
    const opcode = bodyBytes[cursor.pos++];
    const entry = opcodeTable.get(opcode);
    if (!entry) throw new Error("unknown opcode 0x" + opcode.toString(16)
        + " at " + at);
    const [name, immediate] = entry;
    let detail = null;
    switch (immediate) {
      case NONE: break;
      case U32: detail = readU(bodyBytes, cursor); break;
      case S32: detail = readS(bodyBytes, cursor, 5); break;
      case S64: detail = readS(bodyBytes, cursor, 10); break;
      case F32: readBytes(bodyBytes, cursor, 4); break;
      case F64: readBytes(bodyBytes, cursor, 8); break;
      case BT: {
        const type = bodyBytes[cursor.pos++];
        if (type !== 0x40 && type !== 0x7f && type !== 0x7e && type !== 0x7d
            && type !== 0x7c) throw new Error("unsupported blocktype");
        detail = type;
        break;
      }
      case MEMARG: {
        const align = readU(bodyBytes, cursor);
        const offset = readU(bodyBytes, cursor);
        detail = { align, offset };
        break;
      }
      case U32X2: { readU(bodyBytes, cursor); readU(bodyBytes, cursor); break; }
      // Every prefixed instruction is treated as a potential memory write:
      // bulk memory and the atomic family both mutate linear memory.
      case PREFIX: {
        const sub = readU(bodyBytes, cursor);
        detail = sub;
        break;
      }
      default: throw new Error("immediate kind " + immediate);
    }
    if (name === "block" || name === "loop" || name === "if") depth++;
    if (name === "end") depth--;
    instructions.push({ at, opcode, name, detail });
  }
  if (depth !== -1) throw new Error("unbalanced body depth=" + depth);
  return { locals, instructions };
};
const writesOf = (decoded) => decoded.instructions.filter((instruction) =>
    writeOpcodes.has(instruction.name) || instruction.name === "prefix.fc"
    || instruction.name === "prefix.atomic" || instruction.name === "memory.grow"
    || instruction.name === "global.set");
const callsOf = (decoded) => decoded.instructions
    .filter((instruction) => instruction.name === "call")
    .map((instruction) => instruction.detail);
const indirectOf = (decoded) => decoded.instructions.filter((instruction) =>
    instruction.name === "call_indirect" || instruction.name === "unreachable");

const validateBinary = (bytes, options = {}) => {
  const identity = options.identity !== false;
  if (!WebAssembly.validate(bytes)) throw new Error("synthetic binary invalid");
  const sections = parseModule(bytes);
  const expected = parseModule(canonicalBinary());
  const bodies = parseCodeBodies(sections.get(10));
  if (bodies.length !== 6) throw new Error("function count=" + bodies.length);
  const decoded = bodies.map(decodeBody);

  // Topology: exactly one export, six functions, no table/element section.
  if (sections.get(7)[0] !== 0x01) throw new Error("export count");
  if (sections.get(3)[0] !== 0x06) throw new Error("function count section");

  // Only commit may write. Every other body is proven write-free by decode.
  for (const index of [0, 1, 2, 3, 4]) {
    const writes = writesOf(decoded[index]);
    if (writes.length !== 0) {
      throw new Error("body " + index + " writes memory: "
          + writes.map((instruction) => instruction.name).join(","));
    }
    if (indirectOf(decoded[index]).length !== 0) {
      throw new Error("body " + index + " indirect/unreachable");
    }
  }
  const commitWrites = writesOf(decoded[5]).map((instruction) => instruction.name);
  if (commitWrites.join(",") !== "i32.store,i32.store8") {
    throw new Error("commit writes=" + commitWrites.join(","));
  }
  const commitShape = decoded[5].instructions
      .map((instruction) => instruction.name).join(",");
  if (commitShape !== "local.get,local.get,i32.store,local.get,i32.const,"
      + "i32.store8,end") {
    throw new Error("commit shape=" + commitShape);
  }
  const store = decoded[5].instructions[2].detail;
  const store8 = decoded[5].instructions[5].detail;
  if (store.align !== 2 || store.offset !== 0 || store8.align !== 0
      || store8.offset !== 0) throw new Error("commit memarg");

  // Exact per-body direct-call topology; the dispatcher owns both phase edges.
  const edges = decoded.map((value) => callsOf(value).join("."));
  // dispatcher|phase0|phase1|leaf|relay|commit — leaf and commit are sinks.
  if (edges.join("|") !== "1.2|4|4.5||3|") {
    throw new Error("edge topology=" + edges.join("|"));
  }
  const dispatcherLocals = decoded[0].locals;
  if (dispatcherLocals.length !== 1 || dispatcherLocals[0].count !== 2
      || dispatcherLocals[0].type !== 0x7f) throw new Error("dispatcher locals");
  for (const index of [1, 2, 3, 4, 5]) {
    if (decoded[index].locals.length !== 0) {
      throw new Error("private body " + index + " declares locals");
    }
  }
  const dispatcherNames = new Set(decoded[0].instructions
      .map((instruction) => instruction.name));
  for (const guard of ["i32.eqz", "i32.ne", "i32.or"]) {
    const opcode = guard === "i32.eqz" ? 0x45 : guard === "i32.ne" ? 0x47 : 0x72;
    if (!dispatcherNames.has("numeric." + opcode.toString(16))) {
      throw new Error("phase guard vocabulary missing " + guard);
    }
  }
  // phase1 must end at its commit call: no post-commit work.
  const phase1Names = decoded[2].instructions.map((instruction) => instruction.name);
  if (phase1Names.at(-1) !== "end" || phase1Names.at(-2) !== "call"
      || callsOf(decoded[2]).at(-1) !== 5) {
    throw new Error("phase1 post-commit tail");
  }

  if (identity) {
    if (!bytes.equals(canonicalBinary())) {
      throw new Error("synthetic binary byte identity mismatch");
    }
    for (const id of [1, 2, 3, 7]) {
      if (!sections.get(id).equals(expected.get(id))) {
        throw new Error("section " + id + " mismatch");
      }
    }
    const canonical = canonicalBodies();
    for (const index of [1, 2, 3, 4, 5]) {
      if (!bodies[index].equals(Buffer.from(canonical[index]))) {
        throw new Error("private body mismatch index=" + index);
      }
    }
  }
  return { functions: 6, exports: 1, privateFunctions: 5,
           calls: decoded.flatMap(callsOf).length };
};

const canonicalWat = `(module
  (import "env" "memory" (memory 0 65536 shared))
  (func $dispatcher (export "groupedReferenceStoreAcrossRelocation")
    (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i64)
    (local i32 i32)
    local.get 0 i32.eqz if (result i64)
      local.get 3 call $phase0 i64.extend_i32_u i64.const 0 i64.or
    else
      local.get 3 local.get 4 i32.ne local.get 5 i32.eqz i32.or
      if (result i64) i64.const 0 else
        local.get 4 i64.extend_i32_u i64.const 0 i64.or
        local.get 9 local.get 4 local.get 10 call $phase1
      end
    end)
  (func $phase0 (param i32) (result i32) local.get 0 call $relay)
  (func $phase1 (param i32 i32 i32)
    local.get 0 local.get 1 call $relay local.get 2 call $commit)
  (func $leaf (param i32) (result i32) local.get 0)
  (func $relay (param i32) (result i32) local.get 0 call $leaf)
  (func $commit (param i32 i32 i32)
    local.get 0 local.get 1 i32.store align=4
    local.get 2 i32.const 0 i32.store8
  )
)`;

const validateWat = (wat) => {
  if (wat.trim() !== canonicalWat.trim()) {
    throw new Error("synthetic WAT byte/text identity mismatch");
  }
  let depth = 0;
  for (const char of wat.replace(/;;[^\n]*/g, "")) {
    if (char === "(") depth++;
    if (char === ")" && --depth < 0) throw new Error("unbalanced WAT");
  }
  if (depth !== 0) throw new Error("unbalanced WAT");
  const required = [
    `(export "groupedReferenceStoreAcrossRelocation")`,
    `(func $phase0`, `(func $phase1`, `(func $leaf`, `(func $relay`,
    `(func $commit`, `call $phase0`, `call $phase1`, `call $relay`,
    `call $commit`, `call $leaf`, `i32.store align=4`, `i32.store8`
  ];
  for (const token of required) {
    if (!wat.includes(token)) throw new Error("WAT missing " + token);
  }
  for (const token of ["call_indirect", "memory.grow", "unreachable", "table ",
                        "(elem", "(export \"phase", "(export \"leaf",
                        "(export \"relay", "(export \"commit"]) {
    if (wat.includes(token)) throw new Error("WAT forbidden " + token);
  }
  const commitStart = wat.indexOf("(func $commit");
  const commitEnd = wat.indexOf("\n  )", commitStart);
  const commit = wat.slice(commitStart, commitEnd);
  if (!/local\.get 0 local\.get 1 i32\.store align=4\s+local\.get 2 i32\.const 0 i32\.store8\s*$/.test(commit)) {
    throw new Error("WAT commit terminal shape");
  }
};

const requireStage1PublicationLabel = (line) => {
  if (!line.includes("module=synthetic runtime=not-executed")
      || /(?:module=(?:emitted|runtime|production)|runtime=executed|\bACCEPT\b|publication=(?:accepted|ready))/i.test(line)) {
    throw new Error("Stage-1 publication label");
  }
};

const selfTest = () => {
  validateBinary(canonicalBinary());
  validateWat(canonicalWat);
  const negatives = [];
  const reject = (label, fn) => {
    let rejected = false;
    try { fn(); } catch (error) { rejected = true; }
    if (!rejected) throw new Error("self-negative accepted " + label);
    negatives.push(label);
  };
  // Structural negatives: identity is disabled so each one must be caught by
  // the decoder, not by the byte-identity backstop.
  // Each structural negative must itself be a *valid* Wasm module, so the
  // rejection proves the decoder caught it rather than the validator.
  const structural = (label, mutate) => {
    const bodies = canonicalBodies();
    mutate(bodies);
    const candidate = canonicalBinary(bodies);
    if (!WebAssembly.validate(candidate)) {
      throw new Error("structural negative is not valid wasm: " + label);
    }
    reject(label, () => validateBinary(candidate, { identity: false }));
  };
  structural("phase0-i32-store", (bodies) => {
    bodies[1] = [0x00, 0x20, 0x00, 0x20, 0x00, 0x36, 0x02, 0x00, 0x20, 0x00,
                 0x10, 0x04, 0x0b];
  });
  structural("phase0-i64-store", (bodies) => {
    bodies[1] = [0x00, 0x20, 0x00, 0x20, 0x00, 0xad, 0x37, 0x03, 0x00,
                 0x20, 0x00, 0x10, 0x04, 0x0b];
  });
  structural("relay-memory-fill", (bodies) => {
    bodies[4] = [0x00, 0x20, 0x00, 0x20, 0x00, 0x20, 0x00, 0xfc, 0x0b, 0x00,
                 0x20, 0x00, 0x10, 0x03, 0x0b];
  });
  structural("dispatcher-atomic-store", (bodies) => {
    bodies[0] = [...bodies[0].slice(0, -1),
                 0x20, 0x00, 0x20, 0x00, 0xfe, 0x17, 0x02, 0x00, 0x0b];
  });
  structural("dispatcher-memory-grow", (bodies) => {
    bodies[0] = [...bodies[0].slice(0, -1),
                 0x41, 0x00, 0x40, 0x00, 0x1a, 0x0b];
  });
  reject("table-and-call-indirect", () => {
    const bodies = canonicalBodies();
    bodies[3] = [0x00, 0x20, 0x00, 0x11, 0x01, 0x00, 0x0b];
    const candidate = canonicalBinary(bodies, { withTable: true });
    if (!WebAssembly.validate(candidate)) {
      throw new Error("table negative is not valid wasm");
    }
    validateBinary(candidate, { identity: false });
  });
  structural("dispatcher-extra-edge", (bodies) => {
    bodies[0] = [...bodies[0].slice(0, -1), 0x20, 0x00, 0x10, 0x03, 0x1a, 0x0b];
  });
  structural("relay-edge", (bodies) => { bodies[4][4] = 0x04; });
  structural("commit-post-op", (bodies) => {
    bodies[5] = [...bodies[5].slice(0, -1), 0x20, 0x00, 0x1a, 0x0b];
  });
  structural("commit-memarg", (bodies) => { bodies[5][6] = 0x01; });
  structural("private-local", (bodies) => {
    bodies[3] = [0x01, 0x01, 0x7f, 0x20, 0x00, 0x0b];
  });
  structural("unknown-opcode", (bodies) => {
    bodies[3] = [0x00, 0x20, 0x00, 0xd0, 0x70, 0x1a, 0x0b];
  });
  // Positive control: a store opcode byte hidden inside an i64.const immediate
  // is not an instruction. A raw-byte scanner would report a write here; the
  // decoder must not, so only byte identity may reject this module.
  const hidden = canonicalBodies();
  hidden[3] = [0x00, 0x42, 0xb6, 0x00, 0x1a, 0x20, 0x00, 0x0b];
  validateBinary(canonicalBinary(hidden), { identity: false });
  reject("hidden-immediate-identity", () =>
    validateBinary(canonicalBinary(hidden)));
  negatives.push("hidden-immediate-decoded-clean");
  reject("commit-reversed", () => validateWat(canonicalWat.replace(
    "local.get 0 local.get 1 i32.store align=4\n    local.get 2 i32.const 0 i32.store8",
    "local.get 2 i32.const 0 i32.store8\n    local.get 0 local.get 1 i32.store align=4")));
  reject("wat-commit-post-op", () => validateWat(canonicalWat.replace(
    "local.get 2 i32.const 0 i32.store8\n  )",
    "local.get 2 i32.const 0 i32.store8 local.get 0 drop\n  )")));
  reject("call-indirect", () => validateWat(canonicalWat.replace(
    "call $leaf", "call_indirect (type 1)")));
  reject("unbalanced", () => validateWat(canonicalWat.slice(0, -1)));
  reject("comment-confusion", () => validateWat(canonicalWat.replace(
    "call $leaf", ";; call $leaf\n    nop")));
  reject("extra-function", () => validateWat(canonicalWat.replace(
    "\n)", "\n  (func $evil)\n)")));
  const line = "reference-store-group-relocation-oracle-selftest=pass"
    + " functions=6 exports=1 private=5 calls=6"
    + " phase0-stores=0 phase1-store-owner=commit"
    + " commit=i32.store,i32.store8,end negatives=" + negatives.length
    + " module=synthetic runtime=not-executed publication=forbidden";
  requireStage1PublicationLabel(line);
  let publicationRejected = false;
  try {
    requireStage1PublicationLabel(line.replace(
      "module=synthetic runtime=not-executed publication=forbidden",
      "module=production runtime=executed publication=accepted"));
  } catch (error) {
    publicationRejected = true;
  }
  if (!publicationRejected) throw new Error("publication self-negative accepted");
  console.log(line + " publication-negative=pass");
};

if (process.argv[2] === "--self-test") {
  selfTest();
} else {
  const binaryPath = process.argv[2];
  const watPath = process.argv[3];
  if (!binaryPath || !watPath) {
    throw new Error("usage: ... --self-test | MODULE.wasm MODULE.wat");
  }
  const result = validateBinary(fs.readFileSync(binaryPath));
  validateWat(fs.readFileSync(watPath, "utf8"));
  const line = "reference-store-group-relocation-oracle=pass"
    + " functions=" + result.functions + " exports=" + result.exports
    + " private=" + result.privateFunctions + " calls=" + result.calls
    + " module=synthetic runtime=not-executed publication=forbidden";
  requireStage1PublicationLabel(line);
  console.log(line);
}
