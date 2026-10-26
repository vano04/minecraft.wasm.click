#!/usr/bin/env node
// Exact class-file gate for the OSS-only M2-C3a reference-store group.
import fs from "node:fs";

const path = process.argv[2];
if (!path) {
  throw new Error("usage: check-zero-reference-store-group-class.mjs CLASS");
}
const bytes = fs.readFileSync(path);
let offset = 0;
const need = (count) => {
  if (offset + count > bytes.length) throw new Error("truncated class file");
};
const u1 = () => { need(1); return bytes[offset++]; };
const u2 = () => {
  need(2);
  const value = bytes.readUInt16BE(offset);
  offset += 2;
  return value;
};
const u4 = () => {
  need(4);
  const value = bytes.readUInt32BE(offset);
  offset += 4;
  return value;
};
const skip = (count) => { need(count); offset += count; };

if (u4() !== 0xcafebabe) throw new Error("bad class magic");
u2();
u2();
const cp = [null];
const cpCount = u2();
for (let i = 1; i < cpCount; i++) {
  const tag = u1();
  switch (tag) {
    case 1: {
      const length = u2();
      need(length);
      cp[i] = { tag, text: bytes.subarray(offset, offset + length).toString("utf8") };
      offset += length;
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

const utf8 = (index) => cp[index]?.tag === 1 ? cp[index].text : null;
const className = (index) => cp[index]?.tag === 7 ? utf8(cp[index].a) : null;
const methodRef = (index) => {
  const ref = cp[index];
  if (!ref || ref.tag !== 10) return null;
  const pair = cp[ref.b];
  if (!pair || pair.tag !== 12) return null;
  return {
    owner: className(ref.a),
    name: utf8(pair.a),
    descriptor: utf8(pair.b)
  };
};
const skipAttributes = (count) => {
  for (let i = 0; i < count; i++) {
    u2();
    skip(u4());
  }
};

const classAccess = u2();
const thisClass = u2();
u2();
const owner = className(thisClass);
if (owner !== "ZeroReferenceStoreGroupFixture") {
  throw new Error("unexpected fixture owner " + owner);
}
if (classAccess !== 0x0031) {
  throw new Error("unexpected class access 0x" + classAccess.toString(16));
}
const interfaces = u2();
if (interfaces !== 0) throw new Error("interfaces=" + interfaces);
const fields = u2();
if (fields !== 0) throw new Error("fields=" + fields);

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
  let codeAttributes = null;
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
      codeAttributes = u2();
      skipAttributes(codeAttributes);
    }
    offset = start + length;
    need(0);
  }
  methods.push({ access, name, descriptor, code, maxStack, maxLocals,
                 exceptionTableLength, codeAttributes });
}
const classAttributes = u2();
if (classAttributes !== 0) throw new Error("class attributes=" + classAttributes);
if (offset !== bytes.length) throw new Error("trailing class bytes");
if (methods.some((method) => method.name === "<clinit>")) {
  throw new Error("unexpected <clinit>");
}
if (methods.length !== 5) throw new Error("method count=" + methods.length);

const byName = (name, descriptor) => {
  const found = methods.filter((method) => method.name === name
      && method.descriptor === descriptor);
  if (found.length !== 1) throw new Error(name + " candidate count=" + found.length);
  return found[0];
};
const requireShape = (method, expected) => {
  if (method.access !== expected.access || method.code === null
      || method.maxStack !== expected.maxStack
      || method.maxLocals !== expected.maxLocals
      || method.exceptionTableLength !== 0 || method.codeAttributes !== 0
      || !expected.code(method.code)) {
    throw new Error(method.name + " Code shape mismatch " + JSON.stringify({
      access: method.access,
      maxStack: method.maxStack,
      maxLocals: method.maxLocals,
      exceptionTableLength: method.exceptionTableLength,
      codeAttributes: method.codeAttributes,
      code: method.code?.toString("hex")
    }));
  }
};
const targetAt = (code, bci, expected) => {
  if (code[bci] !== 0xb8) return false;
  const target = methodRef(code.readUInt16BE(bci + 1));
  return target?.owner === expected.owner && target.name === expected.name
      && target.descriptor === expected.descriptor;
};
const objectDescriptor = "(Ljava/lang/Object;)Ljava/lang/Object;";
const storeDescriptor = "([Ljava/lang/Object;ILjava/lang/Object;)Ljava/lang/Object;";

const constructor = byName("<init>", "()V");
requireShape(constructor, {
  access: 0x0002,
  maxStack: 1,
  maxLocals: 1,
  code: (code) => code.length === 5 && code[0] === 0x2a && code[1] === 0xb7
      && code[4] === 0xb1
      && (() => {
        const target = methodRef(code.readUInt16BE(2));
        return target?.owner === "java/lang/Object" && target.name === "<init>"
            && target.descriptor === "()V";
      })()
});
const leaf = byName("leaf", objectDescriptor);
requireShape(leaf, {
  access: 0x000a,
  maxStack: 1,
  maxLocals: 1,
  code: (code) => code.equals(Buffer.from([0x2a, 0xb0]))
});
const relay = byName("relay", objectDescriptor);
requireShape(relay, {
  access: 0x000a,
  maxStack: 1,
  maxLocals: 1,
  code: (code) => code.length === 5 && code[0] === 0x2a && code[4] === 0xb0
      && targetAt(code, 1, { owner, name: "leaf", descriptor: objectDescriptor })
});
const commit = byName("commit", storeDescriptor);
requireShape(commit, {
  access: 0x000a,
  maxStack: 3,
  maxLocals: 3,
  code: (code) => code.equals(Buffer.from([0x2a, 0x1b, 0x2c, 0x53, 0x2c, 0xb0]))
});
const entry = byName("groupedReferenceStore", storeDescriptor);
requireShape(entry, {
  access: 0x0009,
  maxStack: 3,
  maxLocals: 3,
  code: (code) => code.length === 10 && code[0] === 0x2a
      && code[1] === 0x1b && code[2] === 0x2c
      && targetAt(code, 3, { owner, name: "relay", descriptor: objectDescriptor })
      && targetAt(code, 6, { owner, name: "commit", descriptor: storeDescriptor })
      && code[9] === 0xb0
});

console.log("reference-store-group-class=pass owner=" + owner
  + " fields=0 clinit=0 methods=5"
  + " leaf=2ab0 relay=2ab8??b0 commit=2a1b2c532cb0"
  + " entry=2a1b2cb8??b8??b0 relay-bci=3 commit-bci=6 return-bci=9"
  + " edges=entry->relay,relay->leaf,entry->commit"
  + " classifier-predicates=holder,member,body,edge,quickening"
  + " quickening-bci0=aload_0|fast_aload_0|nofast_aload_0");
