#!/usr/bin/env node
// Exact class-file gate for the M2-C2 fixture. This intentionally parses one
// method's Code attribute instead of grepping javap output or broad class-file
// hex, so a near miss cannot accidentally satisfy the production classifier.
import fs from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: check-zero-reference-array-store-class.mjs CLASS");
const bytes = fs.readFileSync(path);
let offset = 0;
const need = (count) => {
  if (offset + count > bytes.length) throw new Error("truncated class file");
};
const u1 = () => { need(1); return bytes[offset++]; };
const u2 = () => { need(2); const value = bytes.readUInt16BE(offset); offset += 2; return value; };
const u4 = () => { need(4); const value = bytes.readUInt32BE(offset); offset += 4; return value; };
const skip = (count) => { need(count); offset += count; };

if (u4() !== 0xcafebabe) throw new Error("bad class magic");
u2(); // minor
u2(); // major
const cp = [null];
const cpCount = u2();
for (let i = 1; i < cpCount; i++) {
  const tag = u1();
  switch (tag) {
    case 1: {
      const length = u2();
      need(length);
      const text = bytes.subarray(offset, offset + length).toString("utf8");
      offset += length;
      cp[i] = { tag, text };
      break;
    }
    case 3:
    case 4:
      skip(4);
      cp[i] = { tag };
      break;
    case 5:
    case 6:
      skip(8);
      cp[i] = { tag };
      cp.push(null);
      i++;
      break;
    case 7:
    case 8:
    case 16:
    case 19:
    case 20:
      cp[i] = { tag, a: u2() };
      break;
    case 9:
    case 10:
    case 11:
    case 12:
    case 17:
    case 18:
      cp[i] = { tag, a: u2(), b: u2() };
      break;
    case 15:
      cp[i] = { tag, a: u1(), b: u2() };
      break;
    default:
      throw new Error("unsupported constant-pool tag " + tag);
  }
}

const utf8 = (index) => {
  const entry = cp[index];
  return entry && entry.tag === 1 ? entry.text : null;
};
const className = (index) => {
  const entry = cp[index];
  return entry && entry.tag === 7 ? utf8(entry.a) : null;
};

const skipAttributes = (count) => {
  for (let i = 0; i < count; i++) {
    u2();
    const length = u4();
    skip(length);
  }
};

u2(); // access flags
const thisClass = u2();
u2(); // super
if (className(thisClass) !== "ZeroReferenceArrayStoreFixture") {
  throw new Error("unexpected fixture owner " + className(thisClass));
}
const interfaces = u2();
skip(interfaces * 2);
const fields = u2();
for (let i = 0; i < fields; i++) {
  u2(); u2(); u2();
  skipAttributes(u2());
}

const methods = [];
const methodCount = u2();
for (let i = 0; i < methodCount; i++) {
  const access = u2();
  const name = utf8(u2());
  const descriptor = utf8(u2());
  const attributes = u2();
  let code = null;
  let maxStack = null;
  let maxLocals = null;
  let exceptionTableLength = null;
  for (let a = 0; a < attributes; a++) {
    const attributeName = utf8(u2());
    const length = u4();
    const start = offset;
    if (attributeName === "Code") {
      maxStack = u2();
      maxLocals = u2();
      const codeLength = u4();
      need(codeLength);
      code = Buffer.from(bytes.subarray(offset, offset + codeLength));
      offset += codeLength;
      exceptionTableLength = u2();
      skip(exceptionTableLength * 8);
      skipAttributes(u2());
    }
    offset = start + length;
    need(0);
  }
  methods.push({ access, name, descriptor, code, maxStack, maxLocals,
                 exceptionTableLength });
}

const matches = methods.filter((method) =>
  method.name === "referenceArrayStore"
  && method.descriptor === "([Ljava/lang/Object;ILjava/lang/Object;)Ljava/lang/Object;");
if (matches.length !== 1) throw new Error("candidate method count=" + matches.length);
const candidate = matches[0];
const expected = Buffer.from([0x2a, 0x1b, 0x2c, 0x53, 0x2c, 0xb0]);
if ((candidate.access & 0x0008) === 0 || (candidate.access & 0x0100) !== 0
    || (candidate.access & 0x0020) !== 0 || candidate.code === null
    || candidate.maxStack !== 3 || candidate.maxLocals !== 3
    || candidate.exceptionTableLength !== 0
    || candidate.code.length !== expected.length
    || !candidate.code.equals(expected)) {
  throw new Error("candidate Code shape mismatch " + JSON.stringify({
    access: candidate.access, maxStack: candidate.maxStack,
    maxLocals: candidate.maxLocals,
    exceptionTableLength: candidate.exceptionTableLength,
    code: candidate.code && candidate.code.toString("hex")
  }));
}
console.log("reference-array-store-class=pass owner=ZeroReferenceArrayStoreFixture"
  + " method=referenceArrayStore descriptor=" + candidate.descriptor
    + " max-stack=3 max-locals=3 parameters=3 exception-table=0"
  + " code=" + candidate.code.toString("hex"));

const helperMatches = methods.filter((method) =>
  method.name === "prepareReferenceArrayStoreCardProbe"
  && method.descriptor === "([Ljava/lang/Object;)[Ljava/lang/Object;");
if (helperMatches.length !== 1) {
  throw new Error("card-probe helper method count=" + helperMatches.length);
}
const helper = helperMatches[0];
const helperExpected = Buffer.from([0x2a, 0xb0]);
if ((helper.access & 0x0008) === 0 || (helper.access & 0x0100) !== 0
    || (helper.access & 0x0020) !== 0 || helper.code === null
    || helper.maxStack !== 1 || helper.maxLocals !== 1
    || helper.exceptionTableLength !== 0
    || helper.code.length !== helperExpected.length
    || !helper.code.equals(helperExpected)) {
  throw new Error("card-probe helper Code shape mismatch " + JSON.stringify({
    access: helper.access, maxStack: helper.maxStack,
    maxLocals: helper.maxLocals,
    exceptionTableLength: helper.exceptionTableLength,
    code: helper.code && helper.code.toString("hex")
  }));
}
console.log("reference-array-store-card-probe-helper=pass"
  + " owner=ZeroReferenceArrayStoreFixture"
  + " method=prepareReferenceArrayStoreCardProbe"
  + " descriptor=" + helper.descriptor
  + " max-stack=1 max-locals=1 parameters=1 exception-table=0"
  + " code=" + helper.code.toString("hex"));
