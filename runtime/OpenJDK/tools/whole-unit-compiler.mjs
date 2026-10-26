/*
 * Local OSS-only Java class-file -> one Wasm linked-unit fixture.
 *
 * This is deliberately a small, fail-fast compiler rather than a general
 * Java compiler.  It parses real javac class files, verifies the bytecode
 * shape of the selected group, and emits one Wasm module.  The selected
 * methods are enough to exercise direct primitive calls, handle-based object
 * and array access, class-initialisation guards, a guarded interface call,
 * and an exception/deopt result which the fixture host can resume against its
 * Java oracle.  Unsupported bytecode is rejected before a module is emitted.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const textDecoder = new TextDecoder();
const COMPILER_VERSION = "whole-unit-oss-compiler-v2-m0";
const REQUIRED_CLOSURE = [
  "WholeUnitFixture",
  "WholeUnitFixture$Box",
  "WholeUnitFixture$Holder",
  "WholeUnitFixture$Shape",
  "WholeUnitFixture$Good",
  "WholeUnitFixture$Other"
];
const REQUIRED_CLASS_FILES = REQUIRED_CLOSURE.map((name) => `${name}.class`);
const SUPPORTED_OPCODES = new Map([
  [0x02, 1], [0x03, 1], [0x04, 1], [0x05, 1], [0x06, 1], [0x07, 1], [0x08, 1],
  [0x10, 2], [0x11, 3], [0x1a, 1], [0x1b, 1], [0x1c, 1], [0x1d, 1],
  [0x2a, 1], [0x2b, 1], [0x2c, 1], [0x2d, 1], [0x2e, 1],
  [0x4d, 1], [0x60, 1], [0x68, 1], [0x6c, 1],
  [0xac, 1], [0xb2, 3], [0xb4, 3], [0xb8, 3], [0xb9, 5]
]);

class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
  }

  u1() {
    if (this.pos >= this.end) throw new Error("class file truncated at u1");
    return this.bytes[this.pos++];
  }

  u2() {
    return (this.u1() << 8) | this.u1();
  }

  u4() {
    return ((this.u1() * 0x1000000) + (this.u1() << 16)
      + (this.u1() << 8) + this.u1()) >>> 0;
  }

  bytesOf(length) {
    if (this.pos + length > this.end) throw new Error("class file truncated at bytes");
    const value = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return value;
  }

}

function utf8(cp, index) {
  const entry = cp[index];
  if (!entry || entry.tag !== 1) throw new Error(`constant-pool ${index} is not Utf8`);
  return entry.value;
}

function className(cp, index) {
  const entry = cp[index];
  if (!entry || entry.tag !== 7) throw new Error(`constant-pool ${index} is not Class`);
  return utf8(cp, entry.nameIndex);
}

function nameAndType(cp, index) {
  const entry = cp[index];
  if (!entry || entry.tag !== 12) throw new Error(`constant-pool ${index} is not NameAndType`);
  return { name: utf8(cp, entry.nameIndex), descriptor: utf8(cp, entry.descriptorIndex) };
}

function memberRef(cp, index) {
  const entry = cp[index];
  if (!entry || ![9, 10, 11].includes(entry.tag)) {
    throw new Error(`constant-pool ${index} is not a member reference`);
  }
  const nt = nameAndType(cp, entry.nameTypeIndex);
  return { owner: className(cp, entry.classIndex), ...nt, tag: entry.tag };
}

function parseClass(filePath) {
  const bytes = fs.readFileSync(filePath);
  const r = new Reader(bytes);
  if (r.u4() !== 0xcafebabe) throw new Error(`${filePath}: bad class magic`);
  const minor = r.u2();
  const major = r.u2();
  const cp = new Array(r.u2());
  for (let i = 1; i < cp.length; i++) {
    const tag = r.u1();
    switch (tag) {
      case 1: {
        const length = r.u2();
        cp[i] = { tag, value: textDecoder.decode(r.bytesOf(length)) };
        break;
      }
      case 3:
      case 4:
        cp[i] = { tag, value: r.u4() };
        break;
      case 5:
      case 6:
        cp[i] = { tag, high: r.u4(), low: r.u4() };
        i++;
        break;
      case 7:
      case 8:
      case 16:
      case 19:
      case 20:
        cp[i] = { tag, nameIndex: r.u2() };
        break;
      case 9:
      case 10:
      case 11:
        cp[i] = { tag, classIndex: r.u2(), nameTypeIndex: r.u2() };
        break;
      case 12:
        cp[i] = { tag, nameIndex: r.u2(), descriptorIndex: r.u2() };
        break;
      case 15:
        cp[i] = { tag, referenceKind: r.u1(), referenceIndex: r.u2() };
        break;
      case 17:
      case 18:
        cp[i] = { tag, bootstrapIndex: r.u2(), nameTypeIndex: r.u2() };
        break;
      default:
        throw new Error(`${filePath}: unsupported constant-pool tag ${tag} at ${i}`);
    }
  }

  const access = r.u2();
  const thisName = className(cp, r.u2());
  const superName = className(cp, r.u2());
  const interfaces = [];
  for (let i = 0, count = r.u2(); i < count; i++) interfaces.push(className(cp, r.u2()));

  const fields = [];
  for (let i = 0, count = r.u2(); i < count; i++) {
    const field = { access: r.u2(), name: utf8(cp, r.u2()), descriptor: utf8(cp, r.u2()), attributes: [] };
    readAttributes(r, cp, field.attributes);
    fields.push(field);
  }

  const methods = [];
  for (let i = 0, count = r.u2(); i < count; i++) {
    const method = { access: r.u2(), name: utf8(cp, r.u2()), descriptor: utf8(cp, r.u2()), attributes: [] };
    readAttributes(r, cp, method.attributes);
    const code = method.attributes.find((attribute) => attribute.name === "Code");
    if (code) method.code = code.value;
    methods.push(method);
  }

  const attributes = [];
  readAttributes(r, cp, attributes);
  return { filePath, bytes, minor, major, access, thisName, superName, interfaces, cp, fields, methods, attributes };
}

function readAttributes(r, cp, out) {
  for (let i = 0, count = r.u2(); i < count; i++) {
    const name = utf8(cp, r.u2());
    const length = r.u4();
    const start = r.pos;
    if (name === "Code") {
      const codeReader = new Reader(r.bytes, start, start + length);
      const maxStack = codeReader.u2();
      const maxLocals = codeReader.u2();
      const code = codeReader.bytesOf(codeReader.u4());
      const codeOffset = codeReader.pos - code.length;
      const exceptionTable = [];
      for (let j = 0, n = codeReader.u2(); j < n; j++) {
        exceptionTable.push({ startPc: codeReader.u2(), endPc: codeReader.u2(),
          handlerPc: codeReader.u2(), catchType: codeReader.u2() });
      }
      const nested = [];
      readAttributes(codeReader, cp, nested);
      out.push({ name, length, value: {
        maxStack, maxLocals, code, codeOffset, exceptionTable, attributes: nested
      } });
    } else {
      out.push({ name, length, value: r.bytesOf(length) });
    }
    r.pos = start + length;
  }
}

function methodOf(clazz, name, descriptor) {
  const method = clazz.methods.find((candidate) => candidate.name === name
    && candidate.descriptor === descriptor);
  if (!method) throw new Error(`${clazz.thisName}: missing ${name}${descriptor}`);
  if (!method.code) throw new Error(`${clazz.thisName}: ${name}${descriptor} has no Code`);
  return method;
}

function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cacheKeyFor(identity) {
  return hash(Buffer.from(canonical(identity)));
}

function verifyCacheRecord(bytes, record) {
  if (!record || record.recordVersion !== "whole-unit-cache-record-v1"
      || record.outputBytes !== bytes.length
      || record.outputSha256 !== hash(bytes)) return false;
  const { recordSha256, ...base } = record;
  return recordSha256 === hash(Buffer.from(canonical(base)));
}

function scanForbiddenPayload(filePaths) {
  const forbiddenPatterns = ["minecraft", "net/minecraft", "com/mojang", "40896ee9f1e2"];
  const hits = [];
  for (const filePath of filePaths) {
    const contents = fs.readFileSync(filePath).toString("utf8").toLowerCase();
    for (const pattern of forbiddenPatterns) {
      if (contents.includes(pattern)) hits.push(`${filePath}:${pattern}`);
    }
  }
  if (hits.length) throw new Error(`REJECT forbidden fixture payload: ${hits.join(",")}`);
  // Keep provenance deterministic across fresh temp class directories.  The
  // absolute input paths are process-local and must never become manifest
  // identity/report data.
  return { status: "clean", files: filePaths.map((filePath) => path.basename(filePath)), patterns: forbiddenPatterns };
}

function enumerateClassFiles(classDir) {
  const files = [];
  function visit(directory, relativeDirectory = "") {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => stableCompare(left.name, right.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath, relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".class")) {
        files.push({ filePath, relativePath });
      }
    }
  }
  visit(classDir);
  return files.sort((left, right) => stableCompare(left.relativePath, right.relativePath));
}

function summarizeWholeUnitInputs(classDir) {
  const files = enumerateClassFiles(classDir);
  const sizes = files.map(({ filePath }) => fs.statSync(filePath).size);
  return {
    classFiles: files.length,
    totalBytes: sizes.reduce((sum, size) => sum + size, 0),
    maxClassBytes: sizes.length ? Math.max(...sizes) : 0,
    dependencyBytes: sizes.reduce((sum, size) => sum + size, 0),
    files: files.map(({ relativePath, filePath }) => ({ relativePath, filePath, bytes: fs.statSync(filePath).size }))
  };
}

function uleb(value) {
  const out = [];
  let n = Number(value);
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

function sleb(value, bits = 32) {
  const out = [];
  let n = BigInt(value);
  const width = BigInt(bits);
  const mask = (1n << width) - 1n;
  n = BigInt.asIntN(Number(width), n & mask);
  while (true) {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    const sign = (byte & 0x40) !== 0;
    if ((n === 0n && !sign) || (n === -1n && sign)) return [...out, byte];
    out.push(byte | 0x80);
  }
}

function str(value) {
  const bytes = [...new TextEncoder().encode(value)];
  return [...uleb(bytes.length), ...bytes];
}

function concat(...parts) {
  const out = [];
  for (const part of parts) out.push(...part);
  return out;
}

function section(id, body) {
  return [id, ...uleb(body.length), ...body];
}

function vec(values) {
  return [...uleb(values.length), ...concat(...values)];
}

const I32 = 0x7f;
const I64 = 0x7e;

class Fn {
  constructor(params, results, locals = []) {
    this.params = params;
    this.results = results;
    this.locals = locals;
    this.body = [];
  }
  op(...bytes) { this.body.push(...bytes); return this; }
  localGet(index) { return this.op(0x20, ...uleb(index)); }
  localSet(index) { return this.op(0x21, ...uleb(index)); }
  localTee(index) { return this.op(0x22, ...uleb(index)); }
  call(index) { return this.op(0x10, ...uleb(index)); }
  i32Const(value) { return this.op(0x41, ...sleb(value, 32)); }
  i64Const(value) { return this.op(0x42, ...sleb(value, 64)); }
  end() { return this.op(0x0b); }
  bytes() {
    const groups = [];
    for (const type of this.locals) {
      const last = groups[groups.length - 1];
      if (last && last.type === type) last.count++;
      else groups.push({ count: 1, type });
    }
    const locals = [
      ...uleb(groups.length),
      ...concat(...groups.map((group) => [...uleb(group.count), group.type]))
    ];
    return concat(locals, this.body);
  }
}

function type(params, results) {
  return [0x60, ...vec(params.map((value) => [value])), ...vec(results.map((value) => [value]))];
}

function customSection(name, payload) {
  return section(0, concat(str(name), payload));
}

function pack(status, bci, value = 0) {
  return (BigInt(status) << 48n) | (BigInt(bci) << 32n) | BigInt(value >>> 0);
}

function decodeInstructions(code, label) {
  const instructions = [];
  for (let bci = 0; bci < code.length;) {
    const opcode = code[bci];
    const width = SUPPORTED_OPCODES.get(opcode);
    if (!width) {
      throw new Error(`REJECT unsupported ${label} opcode 0x${opcode.toString(16)} @bci=${bci}`);
    }
    if (bci + width > code.length) {
      throw new Error(`REJECT truncated ${label} opcode @bci=${bci}`);
    }
    instructions.push({ bci, opcode, args: [...code.slice(bci + 1, bci + width)] });
    bci += width;
  }
  return instructions;
}

function integerConstantOpcode(opcode) {
  return opcode >= 0x02 && opcode <= 0x08 || opcode === 0x10 || opcode === 0x11;
}

function verifyExact(method, label, expected, maxStack, maxLocals) {
  const code = method.code.code;
  const actual = decodeInstructions(code, label);
  if (method.code.maxStack !== maxStack || method.code.maxLocals !== maxLocals) {
    throw new Error(`REJECT ${label} frame shape maxStack=${method.code.maxStack}/${maxStack} maxLocals=${method.code.maxLocals}/${maxLocals}`);
  }
  if (actual.length !== expected.length) {
    throw new Error(`REJECT ${label} instruction count ${actual.length}/${expected.length}`);
  }
  for (let i = 0; i < expected.length; i++) {
    const wanted = expected[i];
    const got = actual[i];
    const matches = typeof wanted === "function" ? wanted(got) : got.opcode === wanted;
    if (!matches) {
      throw new Error(`REJECT ${label} opcode/control-flow drift @bci=${got.bci}`);
    }
  }
  return actual;
}

function popType(stack, wanted, label, bci) {
  const got = stack.pop();
  if (got !== wanted) throw new Error(`REJECT ${label} stack type ${got}/${wanted} @bci=${bci}`);
}

function verifyStackPath(instructions, label, initial, invokes = {}) {
  const stack = [...initial];
  for (const instruction of instructions) {
    const { opcode, bci } = instruction;
    if (opcode >= 0x1a && opcode <= 0x1d) stack.push("i32");
    else if (opcode >= 0x2a && opcode <= 0x2d) stack.push("ref");
    else if (integerConstantOpcode(opcode)) stack.push("i32");
    else if (opcode === 0x4d) popType(stack, "ref", label, bci);
    else if (opcode === 0xb2) stack.push("i32");
    else if (opcode === 0xb4) {
      popType(stack, "ref", label, bci);
      stack.push("i32");
    } else if (opcode === 0x2e) {
      popType(stack, "i32", label, bci);
      popType(stack, "ref", label, bci);
      stack.push("i32");
    } else if (opcode === 0x60 || opcode === 0x68 || opcode === 0x6c) {
      popType(stack, "i32", label, bci);
      popType(stack, "i32", label, bci);
      stack.push("i32");
    } else if (opcode === 0xb8 || opcode === 0xb9) {
      const effect = invokes[bci];
      if (!effect) throw new Error(`REJECT ${label} unverified invoke @bci=${bci}`);
      for (const typeName of effect.pops) popType(stack, typeName, label, bci);
      for (const typeName of effect.pushes) stack.push(typeName);
    } else if (opcode === 0xac) {
      popType(stack, "i32", label, bci);
      if (stack.length !== 0) throw new Error(`REJECT ${label} non-empty return stack @bci=${bci}`);
    } else {
      throw new Error(`REJECT ${label} stack verifier opcode @bci=${bci}`);
    }
  }
  if (stack.length !== 0) throw new Error(`REJECT ${label} stack depth ${stack.length}`);
}

function verifyExceptionTable(clazz, method, label) {
  const table = method.code.exceptionTable;
  if (table.length !== 1) throw new Error(`REJECT ${label} exception table count ${table.length}/1`);
  const entry = table[0];
  const catchName = className(clazz.cp, entry.catchType);
  if (entry.startPc !== 0 || entry.endPc !== 3 || entry.handlerPc !== 4
      || catchName !== "java/lang/ArithmeticException") {
    throw new Error(`REJECT ${label} exception control flow is not exact`);
  }
}

function cpIndexAt(code, offset) {
  if (offset + 2 >= code.length) throw new Error("REJECT truncated constant-pool operand");
  return (code[offset + 1] << 8) | code[offset + 2];
}

function signed8(value) { return value & 0x80 ? value - 0x100 : value; }

function signed16(high, low) {
  const value = (high << 8) | low;
  return value & 0x8000 ? value - 0x10000 : value;
}

function integerConstant(code, offset) {
  const opcode = code[offset];
  if (opcode >= 0x02 && opcode <= 0x08) return opcode - 0x03;
  if (opcode === 0x10) return signed8(code[offset + 1]);
  if (opcode === 0x11) return signed16(code[offset + 1], code[offset + 2]);
  throw new Error(`REJECT unsupported integer constant opcode 0x${opcode.toString(16)}`);
}

function compileWholeUnit(classDir, options = {}) {
  if (!options.sourcePath) throw new Error("REJECT fixture source path is required for provenance");
  const inputFiles = enumerateClassFiles(classDir);
  if (!inputFiles.length) throw new Error(`no class files in ${classDir}`);
  const classes = new Map();
  const parsedFiles = inputFiles.map(({ filePath, relativePath }) => ({
    filePath,
    relativePath,
    clazz: parseClass(filePath)
  }));
  for (const { filePath, clazz } of parsedFiles) {
    if (classes.has(clazz.thisName)) {
      const previous = classes.get(clazz.thisName);
      throw new Error(`REJECT duplicate declared class ${clazz.thisName}: ${previous.filePath}, ${filePath}`);
    }
    classes.set(clazz.thisName, clazz);
  }
  for (const { relativePath, clazz } of parsedFiles) {
    if (relativePath !== `${clazz.thisName}.class`) {
      throw new Error(`REJECT class path/declaration mismatch: ${relativePath} declares ${clazz.thisName}`);
    }
  }
  const actualFiles = inputFiles.map(({ relativePath }) => relativePath);
  const missingFiles = REQUIRED_CLASS_FILES.filter((file) => !actualFiles.includes(file));
  const unexpectedFiles = actualFiles.filter((file) => !REQUIRED_CLASS_FILES.includes(file));
  if (missingFiles.length || unexpectedFiles.length) {
    throw new Error(`REJECT class input set: missing=${missingFiles.join(",") || "none"} unexpected=${unexpectedFiles.join(",") || "none"}`);
  }
  const missing = REQUIRED_CLOSURE.filter((name) => !classes.has(name));
  if (missing.length) throw new Error(`REJECT missing dependency closure: ${missing.join(",")}`);
  const unexpected = [...classes.keys()].filter((name) => !REQUIRED_CLOSURE.includes(name));
  if (unexpected.length) throw new Error(`REJECT unexpected dependency closure: ${unexpected.join(",")}`);
  const paths = inputFiles.map(({ filePath }) => filePath);
  const root = classes.get("WholeUnitFixture");
  const good = classes.get("WholeUnitFixture$Good");

  const selected = {
    leaf: methodOf(root, "leaf", "(I)I"),
    linked: methodOf(root, "linked", "(I)I"),
    objectArray: methodOf(root, "objectArray", "(LWholeUnitFixture$Box;[II)I"),
    classInit: methodOf(root, "classInit", "(I)I"),
    virtual: methodOf(root, "virtual", "(LWholeUnitFixture$Shape;I)I"),
    safeDiv: methodOf(root, "safeDiv", "(II)I"),
    goodValue: methodOf(good, "value", "(I)I")
  };
  const leafInstructions = verifyExact(selected.leaf, "leaf",
    [0x1a, (instruction) => integerConstantOpcode(instruction.opcode), 0x60, 0xac], 2, 1);
  verifyStackPath(leafInstructions, "leaf", []);
  const linkedInstructions = verifyExact(selected.linked, "linked",
    [0x1a, 0xb8, (instruction) => integerConstantOpcode(instruction.opcode), 0x68, 0xac], 2, 1);
  const objectArrayInstructions = verifyExact(selected.objectArray, "objectArray",
    [0x2a, 0xb4, 0x2b, 0x1c, 0x2e, 0x60, 0xac], 3, 3);
  verifyStackPath(objectArrayInstructions, "objectArray", []);
  const classInitInstructions = verifyExact(selected.classInit, "classInit",
    [0xb2, 0x1a, 0x60, 0xac], 2, 1);
  verifyStackPath(classInitInstructions, "classInit", []);
  const virtualInstructions = verifyExact(selected.virtual, "virtual",
    [0x2a, 0x1b, 0xb9, 0xac], 2, 2);
  const safeDivInstructions = verifyExact(selected.safeDiv, "safeDiv",
    [0x1a, 0x1b, 0x6c, 0xac, 0x4d, (instruction) => instruction.opcode === 0x02, 0xac], 2, 3);
  const goodInstructions = verifyExact(selected.goodValue, "Good.value",
    [0x1b, (instruction) => instruction.opcode === 0x10, 0x60, 0xac], 2, 2);

  const leafConstant = integerConstant(selected.leaf.code.code, leafInstructions[1].bci);
  const linkedInvokeAt = linkedInstructions[1].bci;
  const linkedRef = memberRef(root.cp,
    cpIndexAt(selected.linked.code.code, linkedInvokeAt));
  verifyStackPath(linkedInstructions, "linked", [], {
    [linkedInvokeAt]: { pops: ["i32"], pushes: ["i32"] }
  });
  if (linkedInstructions[1].args.length !== 2) throw new Error("REJECT linked invoke operand width");
  if (linkedRef.owner !== "WholeUnitFixture" || linkedRef.name !== "leaf" || linkedRef.descriptor !== "(I)I") {
    throw new Error(`REJECT linked edge is ${linkedRef.owner}.${linkedRef.name}${linkedRef.descriptor}`);
  }
  const linkedConstant = integerConstant(selected.linked.code.code, linkedInstructions[2].bci);
  const fieldAt = objectArrayInstructions[1].bci;
  const fieldRef = memberRef(root.cp, cpIndexAt(selected.objectArray.code.code, fieldAt));
  if (fieldRef.owner !== "WholeUnitFixture$Box" || fieldRef.name !== "value" || fieldRef.descriptor !== "I") {
    throw new Error(`REJECT object field edge is ${fieldRef.owner}.${fieldRef.name}${fieldRef.descriptor}`);
  }
  const staticAt = classInitInstructions[0].bci;
  const staticRef = memberRef(root.cp, cpIndexAt(selected.classInit.code.code, staticAt));
  if (staticRef.owner !== "WholeUnitFixture$Holder" || staticRef.name !== "VALUE" || staticRef.descriptor !== "I") {
    throw new Error(`REJECT class-init edge is ${staticRef.owner}.${staticRef.name}${staticRef.descriptor}`);
  }
  const virtualAt = virtualInstructions[2].bci;
  const virtualRef = memberRef(root.cp, cpIndexAt(selected.virtual.code.code, virtualAt));
  verifyStackPath(virtualInstructions, "virtual", [], {
    [virtualAt]: { pops: ["i32", "ref"], pushes: ["i32"] }
  });
  if (virtualInstructions[2].args.length !== 4 || virtualInstructions[2].args[2] !== 2
      || virtualInstructions[2].args[3] !== 0) {
    throw new Error("REJECT virtual invokeinterface count/reserved operands");
  }
  if (virtualRef.owner !== "WholeUnitFixture$Shape" || virtualRef.name !== "value" || virtualRef.descriptor !== "(I)I") {
    throw new Error(`REJECT virtual edge is ${virtualRef.owner}.${virtualRef.name}${virtualRef.descriptor}`);
  }
  const goodConstant = integerConstant(selected.goodValue.code.code, goodInstructions[1].bci);
  const exceptionHandler = selected.safeDiv.code.exceptionTable[0]?.handlerPc;
  verifyExceptionTable(root, selected.safeDiv, "safeDiv");
  verifyStackPath(safeDivInstructions.slice(0, 4), "safeDiv.main", []);
  verifyStackPath(safeDivInstructions.slice(4), "safeDiv.handler", ["ref"]);
  if (exceptionHandler === undefined || safeDivInstructions[4].bci !== exceptionHandler) {
    throw new Error("REJECT safeDiv handler does not store the pending exception");
  }
  const safeDivConstant = integerConstant(selected.safeDiv.code.code, safeDivInstructions[5].bci);

  const selectedOrder = ["leaf", "linked", "objectArray", "classInit", "goodValue", "virtual", "safeDiv"];
  const selectedOwners = {
    leaf: root,
    linked: root,
    objectArray: root,
    classInit: root,
    goodValue: good,
    virtual: root,
    safeDiv: root
  };
  const methods = [
    { key: "leaf", name: "unit_leaf", params: [I32], result: I64 },
    { key: "linked", name: "unit_linked", params: [I32], result: I64 },
    { key: "objectArray", name: "unit_objectArray", params: [I32, I32, I32], result: I64 },
    { key: "classInit", name: "unit_classInit", params: [I32], result: I64 },
    { key: "goodValue", name: "unit_goodValue", params: [I32], result: I64 },
    { key: "virtual", name: "unit_virtual", params: [I32, I32], result: I64 },
    { key: "safeDiv", name: "unit_safeDiv", params: [I32, I32], result: I64 }
  ];
  // Handles are byte offsets into the module's imported linear memory.  This
  // is the MVP representation used by the OSS fixture; it is deliberately
  // not advertised as WasmGC references.  The host owns validation/lifetime
  // and can refuse a handle before the load.
  const memoryImport = { module: "env", name: "memory", kind: "memory", min: 1 };
  const imports = [
    { name: "rt_get_field", params: [I32, I32], results: [I32] },
    { name: "rt_array_get", params: [I32, I32], results: [I32] },
    { name: "rt_ensure_class_init", params: [I32], results: [I32] },
    { name: "rt_get_static", params: [I32, I32], results: [I32] },
    { name: "rt_class_id", params: [I32], results: [I32] }
  ];

  // Function indices are imports first, then the linked methods, then the
  // two measurement functions.  Direct call edges use these stable indices;
  // they never cross JS or the runtime ABI.
  const importIndices = new Map(imports.map((entry, index) => [entry.name, index]));
  const functionIndices = new Map();
  methods.forEach((method, index) => functionIndices.set(method.key, imports.length + index));
  const directMathIndex = imports.length + methods.length;
  const benchDirectIndex = directMathIndex + 1;
  const benchLinkedIndex = benchDirectIndex + 1;

  const functions = [];
  const leaf = new Fn([I32], [I64]);
  leaf.localGet(0).i32Const(leafConstant).op(0x6a).op(0xac).end();
  functions.push(leaf);

  const linked = new Fn([I32], [I64]);
  linked.localGet(0).call(functionIndices.get("leaf")).op(0xa7).i32Const(linkedConstant).op(0x6c).op(0xac).end();
  functions.push(linked);

  const objectArray = new Fn([I32, I32, I32], [I64]);
  objectArray.localGet(0).i32Const(0).call(importIndices.get("rt_get_field"));
  objectArray.localGet(1).localGet(2).call(importIndices.get("rt_array_get"));
  objectArray.op(0x6a).op(0xac).end();
  functions.push(objectArray);

  const classInit = new Fn([I32], [I64]);
  classInit.i32Const(1).call(importIndices.get("rt_ensure_class_init"));
  classInit.op(0x04, I64); // if (result i64)
  classInit.i64Const(pack(1, 0));
  classInit.op(0x05); // else
  classInit.i32Const(1).i32Const(0).call(importIndices.get("rt_get_static"));
  classInit.localGet(0).op(0x6a).op(0xac);
  classInit.op(0x0b).op(0x0b);
  functions.push(classInit);

  const goodValue = new Fn([I32], [I64]);
  goodValue.localGet(0).i32Const(goodConstant).op(0x6a).op(0xac).end();
  functions.push(goodValue);

  const virtual = new Fn([I32, I32], [I64]);
  virtual.localGet(0).call(importIndices.get("rt_class_id")).i32Const(1).op(0x46);
  virtual.op(0x04, I64);
  virtual.localGet(1).call(functionIndices.get("goodValue"));
  virtual.op(0x05).i64Const(pack(1, 2));
  virtual.op(0x0b).end();
  functions.push(virtual);

  const safeDiv = new Fn([I32, I32], [I64]);
  safeDiv.localGet(1).op(0x45).op(0x04, I64).i64Const(pack(2, 2, safeDivConstant));
  safeDiv.op(0x05).localGet(0).localGet(1).op(0x6d).op(0xac);
  safeDiv.op(0x0b).end();
  functions.push(safeDiv);

  // The direct-Wasm reference and linked path use the same i64 result ABI.
  // The former has no intra-unit Java call; the latter calls unit_leaf
  // directly.  Their enclosing benchmark signatures and side effects match.
  const directMath = new Fn([I32], [I64]);
  directMath.localGet(0).i32Const(leafConstant).op(0x6a).i32Const(linkedConstant).op(0x6c).op(0xac).end();
  functions.push(directMath);

  function benchmark(callIndex) {
    const fn = new Fn([I32], [I64], [I32, I64]);
    const index = 1;
    const acc = 2;
    fn.i32Const(0).localSet(index).i64Const(0).localSet(acc);
    fn.op(0x02, 0x40); // block
    fn.op(0x03, 0x40); // loop
    fn.localGet(index).localGet(0).op(0x4f).op(0x0d, 1); // i32.ge_u, br_if block
    fn.localGet(acc).localGet(index).call(callIndex);
    fn.op(0x7c).localSet(acc);
    fn.localGet(index).i32Const(1).op(0x6a).localSet(index);
    fn.op(0x0c, 0); // br loop
    fn.op(0x0b, 0x0b); // end loop, block
    fn.localGet(acc).end();
    return fn;
  }
  functions.push(benchmark(directMathIndex));
  functions.push(benchmark(functionIndices.get("linked")));

  const types = [];
  const typeIndex = new Map();
  function addType(params, results) {
    const key = `${params.join(",")}->${results.join(",")}`;
    if (!typeIndex.has(key)) {
      typeIndex.set(key, types.length);
      types.push(type(params, results));
    }
    return typeIndex.get(key);
  }
  imports.forEach((entry) => { entry.type = addType(entry.params, entry.results); });
  methods.forEach((entry) => { entry.type = addType(entry.params, [entry.result]); });
  const directType = addType([I32], [I64]);
  const benchType = addType([I32], [I64]);

  const module = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const maxModuleBytes = options.maxModuleBytes ?? Number.POSITIVE_INFINITY;
  function appendModule(part) {
    if (module.length + part.length > maxModuleBytes) {
      throw new Error(`REJECT bounded Wasm emitter module limit ${maxModuleBytes}`);
    }
    module.push(...part);
  }
  appendModule(section(1, vec(types)));
  const importBody = concat(str(memoryImport.module), str(memoryImport.name),
    [0x02, 0x00, ...uleb(memoryImport.min)]);
  appendModule(section(2, concat(uleb(imports.length + 1), importBody, ...imports.map((entry) =>
    concat(str("runtime"), str(entry.name), [0x00], uleb(entry.type))))));
  appendModule(section(3, concat(uleb(functions.length), ...functions.map((fn, index) => {
    const type = index < methods.length ? methods[index].type
      : index === methods.length ? directType : benchType;
    return uleb(type);
  }))));

  const exportEntries = [];
  for (const method of methods) exportEntries.push(concat(str(method.name), [0x00], uleb(functionIndices.get(method.key))));
  exportEntries.push(concat(str("directBaseline"), [0x00], uleb(directMathIndex)));
  exportEntries.push(concat(str("benchDirect"), [0x00], uleb(benchDirectIndex)));
  exportEntries.push(concat(str("benchLinked"), [0x00], uleb(benchLinkedIndex)));
  const exportManifest = [
    ...methods.map((entry) => ({ name: entry.name, type: entry.type })),
    { name: "directBaseline", type: directType },
    { name: "benchDirect", type: benchType },
    { name: "benchLinked", type: benchType }
  ];
  appendModule(section(7, concat(uleb(exportEntries.length), ...exportEntries)));
  const codeBodies = functions.map((fn) => {
    const body = fn.bytes();
    return concat(uleb(body.length), body);
  });
  appendModule(section(10, concat(uleb(codeBodies.length), ...codeBodies)));

  const forbiddenPayloadScan = scanForbiddenPayload([options.sourcePath, ...paths]);
  const dependencyManifest = REQUIRED_CLOSURE.map((name) => {
    const clazz = classes.get(name);
    const methodsWithCode = clazz.methods.filter((method) => method.code);
    return {
      name,
      classSha256: hash(clazz.bytes),
      bytecodeSha256: hash(Buffer.concat(methodsWithCode.map((method) => Buffer.from(method.code.code)))),
      fileBytes: clazz.bytes.length,
      methodCount: clazz.methods.length,
      file: `${name}.class`
    };
  });
  const groupManifest = selectedOrder.map((key) => {
    const method = selected[key];
    const owner = selectedOwners[key];
    return {
      key,
      owner: owner.thisName,
      name: method.name,
      descriptor: method.descriptor,
      classSha256: hash(owner.bytes),
      bytecodeSha256: hash(method.code.code)
    };
  });
  const methodIdentity = selectedOrder.map((key) => {
    const method = selected[key];
    const owner = selectedOwners[key];
    return {
      key,
      owner: owner.thisName,
      name: method.name,
      descriptor: method.descriptor,
      classSha256: hash(owner.bytes),
      codeSha256: hash(method.code.code),
      codeLength: method.code.code.length,
      bciMap: decodeInstructions(method.code.code, key).map(({ bci, opcode, args }) => ({ bci, opcode, args })),
      exceptionTable: method.code.exceptionTable
    };
  });
  const directCallGraph = {
    schema: "whole-unit-call-graph-v1",
    bodies: [
      { id: "unit_leaf", functionIndex: functionIndices.get("leaf"), calls: [] },
      { id: "unit_linked", functionIndex: functionIndices.get("linked"), calls: [
        { kind: "internal", target: "unit_leaf" }
      ] },
      { id: "unit_objectArray", functionIndex: functionIndices.get("objectArray"), calls: [
        { kind: "runtime-import", target: "runtime.rt_get_field" },
        { kind: "runtime-import", target: "runtime.rt_array_get" }
      ] },
      { id: "unit_classInit", functionIndex: functionIndices.get("classInit"), calls: [
        { kind: "runtime-import", target: "runtime.rt_ensure_class_init" },
        { kind: "runtime-import", target: "runtime.rt_get_static" }
      ] },
      { id: "unit_goodValue", functionIndex: functionIndices.get("goodValue"), calls: [] },
      { id: "unit_virtual", functionIndex: functionIndices.get("virtual"), calls: [
        { kind: "runtime-import", target: "runtime.rt_class_id" },
        { kind: "internal", target: "unit_goodValue" }
      ] },
      { id: "unit_safeDiv", functionIndex: functionIndices.get("safeDiv"), calls: [] },
      { id: "unit_directMath", functionIndex: directMathIndex, calls: [] },
      { id: "unit_benchDirect", functionIndex: benchDirectIndex, calls: [
        { kind: "internal", target: "unit_directMath" }
      ] },
      { id: "unit_benchLinked", functionIndex: benchLinkedIndex, calls: [
        { kind: "internal", target: "unit_linked" }
      ] }
    ],
    incoming: {
      unit_leaf: ["unit_linked"],
      unit_goodValue: ["unit_virtual"],
      unit_directMath: ["unit_benchDirect"],
      unit_linked: ["unit_benchLinked"]
    }
  };
  const fixtureSourceSha256 = hash(fs.readFileSync(options.sourcePath));
  const compilerSourceSha256 = hash(fs.readFileSync(new URL(import.meta.url)));
  const wasmFeatures = options.wasmFeatures || ["wasm32", "i32", "i64", "linear-memory"];
  const compilerFlags = options.compilerFlags || ["exact-opcode-verifier", "-g:none", "--release=11"];
  const toolchain = options.toolchain || { javac: "unspecified", java: "unspecified", wasmDis: "unspecified" };
  const gcMode = options.gcMode || "linear-memory-handle-mvp";
  const runtimeMode = options.runtimeMode || "fixture-host-oracle";
  const loaderIdentity = options.loaderIdentity || {
    kind: "host-oss-fixture-loader",
    version: "whole-unit-loader-v1",
    policySha256: hash(Buffer.from("exact-six-class-closure"))
  };
  const patchStack = options.patchStack || [{
    name: "whole-unit-host-fixture-source",
    sha256: fixtureSourceSha256
  }];
  const abi = {
    version: "whole-unit-runtime-abi-v1",
    result: "i64(status:u16,bci:u16,value:i32)",
    status: { RETURN: 0, DEOPT: 1, EXCEPTION: 2 },
    handles: "i32 byte offset into imported env.memory; host owns validation/lifetime",
    state: "entry(method,args); return(status=0,value); deopt(status=1,bci); exception(status=2,bci)",
    fallback: "fixture host resumes original args and compares to Java oracle; not a connected Zero interpreter frame",
    memory: "env.memory min=1 page; object field 0 and int-array length/elements are host-owned",
    imports: imports.map((entry) => `runtime.${entry.name}`),
    unsupported: "monitor/GC barriers and arbitrary bytecode return REJECT before emission",
    verifier: "exact decoded opcode/control-flow/type-stack shapes"
  };
  const cacheIdentity = {
    identityVersion: "whole-unit-cache-identity-v2",
    compiler: { version: COMPILER_VERSION, sourceSha256: compilerSourceSha256 },
    source: { fixtureSha256: fixtureSourceSha256, inputKind: "oss-synthetic-fixture" },
    config: {
      selectedGroup: selectedOrder,
      verifier: "exact-decoded-opcode-frame-stack-exception-control-flow",
      output: "one-wasm-module-direct-intra-unit-calls",
      memory: "imported-linear-memory-byte-offset-handles",
      loader: loaderIdentity,
      patchStack,
      exportManifest
    },
    compilerFlags,
    wasmFeatures,
    gcMode,
    runtimeMode,
    toolchain,
    abi,
    group: groupManifest,
    methods: methodIdentity,
    dispatchTargets: [{
      callsite: "virtual",
      invokeBci: virtualAt,
      opcode: "invokeinterface",
      owner: "WholeUnitFixture$Shape",
      name: "value",
      descriptor: "(I)I",
      expectedClass: "WholeUnitFixture$Good",
      targetMethod: "WholeUnitFixture$Good.value(I)I",
      targetBytecodeSha256: hash(selected.goodValue.code.code),
      tableIndex: null,
      mode: "fixture-host-class-id-guard"
    }],
    loader: loaderIdentity,
    patchStack,
    exportManifest,
    directCallGraph,
    fieldLayout: { mode: "host-owned-linear-memory", fields: ["Box.value@0:I"] },
    cardLayout: { mode: "not-applicable-linear-memory-mvp", clean: null, dirty: null },
    dependencies: dependencyManifest,
    forbiddenPayloadScan: { status: forbiddenPayloadScan.status, patterns: forbiddenPayloadScan.patterns }
  };
  const cacheKey = cacheKeyFor(cacheIdentity);
  const manifest = {
    compilerVersion: COMPILER_VERSION,
    abi,
    root: root.thisName,
    methods: selectedOrder,
    expectedDirectCallEdges: ["linked->leaf", "virtual->Good.value (guard hit)", "benchLinked->unit_linked"],
    expectedDirectCallCounters: { "linked->leaf": 1, "virtual->Good.value": 1, "benchLinked->unit_linked": 1 },
    fallback: ["virtual guard miss @bci=2", "class-init guard miss @bci=0", "safeDiv exception @bci=2"],
    dependencyManifest,
    groupManifest,
    directCallGraph,
    methodIdentity,
    exportManifest,
    verifiedConstants: { leaf: leafConstant, linkedMultiplier: linkedConstant,
      goodValue: goodConstant, safeDivHandler: safeDivConstant },
    cacheIdentity,
    cacheKey,
    cachePersistence: "none",
    provenance: {
      sourceHashes: { fixture: fixtureSourceSha256, compiler: compilerSourceSha256 },
      toolchain,
      forbiddenPayloadScan
    },
    functionIndices: {
      leaf: functionIndices.get("leaf"),
      goodValue: functionIndices.get("goodValue"),
      linked: functionIndices.get("linked"),
      benchLinked: benchLinkedIndex
    },
    importFunctionCount: imports.length
  };
  // The cache identity is a lookup/record concern, not emitted program data.
  // Keeping it out of the Wasm bytes lets an unselected dependency mutation
  // miss the cache without falsely changing the executable code artifact.
  const abiPayload = new TextEncoder().encode(JSON.stringify(abi));
  appendModule(customSection("mcweb.runtime-abi", [...abiPayload]));
  manifest.outputBytes = module.length;
  manifest.outputSha256 = hash(Buffer.from(module));
  const cacheRecordBase = {
    recordVersion: "whole-unit-cache-record-v1",
    cacheKey,
    outputBytes: manifest.outputBytes,
    outputSha256: manifest.outputSha256,
    abiVersion: abi.version,
    identitySha256: cacheKey
  };
  manifest.cacheRecord = {
    ...cacheRecordBase,
    recordSha256: hash(Buffer.from(canonical(cacheRecordBase)))
  };
  return { module: new Uint8Array(module), manifest, classes, selected };
}

export { compileWholeUnit, parseClass, summarizeWholeUnitInputs, pack, cacheKeyFor, verifyCacheRecord, canonical, hash };

if (import.meta.url === `file://${process.argv[1]}`) {
  const classDir = process.argv[2];
  const sourcePath = process.argv[3];
  if (!classDir || !sourcePath) throw new Error("usage: node whole-unit-compiler.mjs <class-dir> <fixture-source>");
  const result = compileWholeUnit(classDir, { sourcePath });
  process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
}
