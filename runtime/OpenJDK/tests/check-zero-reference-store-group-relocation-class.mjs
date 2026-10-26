#!/usr/bin/env node
// Exact class-file/root-map gate for the OSS-only M2-C3b Stage-1 fixture.
import fs from "node:fs";
import os from "node:os";
import pathModule from "node:path";
import { spawnSync } from "node:child_process";

const selfTestMode = process.argv[2] === "--self-test";
const path = selfTestMode ? process.argv[3] : process.argv[2];
if (!path) {
  throw new Error("usage: ... CLASS | --self-test CLASS");
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
const minorVersion = u2();
const majorVersion = u2();
if (minorVersion !== 0 || majorVersion !== 69) {
  throw new Error("class version=" + majorVersion + "." + minorVersion);
}
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
      skip(4); cp[i] = { tag }; break;
    case 5:
    case 6:
      skip(8); cp[i] = { tag }; cp.push(null); i++; break;
    case 7:
    case 8:
    case 16:
    case 19:
    case 20:
      cp[i] = { tag, a: u2() }; break;
    case 9:
    case 10:
    case 11:
    case 12:
    case 17:
    case 18:
      cp[i] = { tag, a: u2(), b: u2() }; break;
    case 15:
      cp[i] = { tag, a: u1(), b: u2() }; break;
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
  return { owner: className(ref.a), name: utf8(pair.a), descriptor: utf8(pair.b) };
};
const skipAttributes = (count) => {
  for (let i = 0; i < count; i++) { u2(); skip(u4()); }
};

const classAccess = u2();
const thisClass = u2();
const superClass = u2();
const owner = className(thisClass);
if (owner !== "ZeroReferenceStoreGroupRelocationFixture") {
  throw new Error("unexpected fixture owner " + owner);
}
if (classAccess !== 0x0031) {
  throw new Error("unexpected class access 0x" + classAccess.toString(16));
}
if (className(superClass) !== "java/lang/Object") {
  throw new Error("unexpected superclass " + className(superClass));
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
  const methodAttributeNames = [];
  let code = null;
  let maxStack = null;
  let maxLocals = null;
  let exceptionTableLength = null;
  const codeAttributeNames = [];
  const codeAttributePayloads = [];
  for (let a = 0; a < attributes; a++) {
    const attributeName = utf8(u2());
    methodAttributeNames.push(attributeName);
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
      const nested = u2();
      for (let n = 0; n < nested; n++) {
        const nestedName = utf8(u2());
        const nestedLength = u4();
        codeAttributeNames.push(nestedName);
        need(nestedLength);
        codeAttributePayloads.push(Buffer.from(
            bytes.subarray(offset, offset + nestedLength)));
        skip(nestedLength);
      }
    }
    offset = start + length;
    need(0);
  }
  methods.push({ access, name, descriptor, code, maxStack, maxLocals,
                 exceptionTableLength, codeAttributeNames,
                 codeAttributePayloads, methodAttributeNames });
}
const classAttributes = u2();
if (classAttributes !== 0) throw new Error("class attributes=" + classAttributes);
if (offset !== bytes.length) throw new Error("trailing class bytes");
if (methods.some((method) => method.name === "<clinit>")) {
  throw new Error("unexpected <clinit>");
}
if (methods.length !== 7) throw new Error("method count=" + methods.length);

const byName = (name, descriptor) => {
  const found = methods.filter((method) => method.name === name
      && method.descriptor === descriptor);
  if (found.length !== 1) throw new Error(name + " candidate count=" + found.length);
  return found[0];
};
const targetAt = (code, bci, expected) => {
  if (code[bci] !== 0xb8) return false;
  const target = methodRef(code.readUInt16BE(bci + 1));
  return target?.owner === expected.owner && target.name === expected.name
      && target.descriptor === expected.descriptor;
};
const constructorTargetAt = (code, bci, expected) => {
  if (code[bci] !== 0xb7) return false;
  const target = methodRef(code.readUInt16BE(bci + 1));
  return target?.owner === expected.owner && target.name === expected.name
      && target.descriptor === expected.descriptor;
};
const classTargetAt = (code, bci, opcode, expectedOwner) => {
  if (code[bci] !== opcode) return false;
  return className(code.readUInt16BE(bci + 1)) === expectedOwner;
};
const requireShape = (method, expected) => {
  const attrs = [...method.codeAttributeNames].sort();
  const expectedAttrs = [...(expected.codeAttributes ?? [])].sort();
  if (method.access !== expected.access || method.code === null
      || method.methodAttributeNames.length !== 1
      || method.methodAttributeNames[0] !== "Code"
      || method.maxStack !== expected.maxStack
      || method.maxLocals !== expected.maxLocals
      || method.exceptionTableLength !== 0
      || JSON.stringify(attrs) !== JSON.stringify(expectedAttrs)
      || (expected.codeAttributePayloads
          && JSON.stringify(method.codeAttributePayloads.map((payload) => payload.toString("hex")))
              !== JSON.stringify(expected.codeAttributePayloads))
      || !expected.code(method.code)) {
    throw new Error(method.name + " Code shape mismatch " + JSON.stringify({
      access: method.access,
      maxStack: method.maxStack,
      maxLocals: method.maxLocals,
      exceptionTableLength: method.exceptionTableLength,
      codeAttributeNames: method.codeAttributeNames,
      code: method.code?.toString("hex")
    }));
  }
};

const objectDescriptor = "(Ljava/lang/Object;)Ljava/lang/Object;";
const storeDescriptor = "([Ljava/lang/Object;ILjava/lang/Object;)Ljava/lang/Object;";
const phase1Descriptor = "([Ljava/lang/Object;ILjava/lang/Object;Ljava/lang/Object;I)Ljava/lang/Object;";

const constructor = byName("<init>", "()V");
requireShape(constructor, {
  access: 0x0002, maxStack: 1, maxLocals: 1,
  code: (code) => code.length === 5 && code[0] === 0x2a
      && constructorTargetAt(code, 1,
          { owner: "java/lang/Object", name: "<init>", descriptor: "()V" })
      && code[4] === 0xb1
});
const leaf = byName("leaf", objectDescriptor);
requireShape(leaf, {
  access: 0x000a, maxStack: 1, maxLocals: 1,
  code: (code) => code.equals(Buffer.from([0x2a, 0xb0]))
});
const relay = byName("relay", objectDescriptor);
requireShape(relay, {
  access: 0x000a, maxStack: 1, maxLocals: 1,
  code: (code) => code.length === 5 && code[0] === 0x2a
      && targetAt(code, 1, { owner, name: "leaf", descriptor: objectDescriptor })
      && code[4] === 0xb0
});
const commit = byName("commit", storeDescriptor);
requireShape(commit, {
  access: 0x000a, maxStack: 3, maxLocals: 3,
  code: (code) => code.equals(Buffer.from([0x2a, 0x1b, 0x2c, 0x53, 0x2c, 0xb0]))
});
const phase0 = byName("phase0", objectDescriptor);
requireShape(phase0, {
  access: 0x000a, maxStack: 1, maxLocals: 1,
  code: (code) => code.length === 5 && code[0] === 0x2a
      && targetAt(code, 1, { owner, name: "relay", descriptor: objectDescriptor })
      && code[4] === 0xb0
});
const phase1 = byName("phase1", phase1Descriptor);
requireShape(phase1, {
  access: 0x000a, maxStack: 3, maxLocals: 5,
  codeAttributes: ["StackMapTable"],
  codeAttributePayloads: ["00020a07"],
  code: (code) => code.length === 28
      && code.subarray(0, 10).equals(Buffer.from([
        0x2c, 0x2d, 0xa6, 0x00, 0x08, 0x15, 0x04, 0x9a, 0x00, 0x0b
      ]))
      && classTargetAt(code, 10, 0xbb, "java/lang/IllegalStateException")
      && code[13] === 0x59
      && constructorTargetAt(code, 14,
          { owner: "java/lang/IllegalStateException", name: "<init>", descriptor: "()V" })
      && code[17] === 0xbf
      && code.subarray(18, 21).equals(Buffer.from([0x2a, 0x1b, 0x2d]))
      && targetAt(code, 21, { owner, name: "relay", descriptor: objectDescriptor })
      && targetAt(code, 24, { owner, name: "commit", descriptor: storeDescriptor })
      && code[27] === 0xb0
});
const entry = byName("groupedReferenceStoreAcrossRelocation", storeDescriptor);
requireShape(entry, {
  access: 0x0009, maxStack: 5, maxLocals: 5,
  code: (code) => code.length === 21 && code[0] === 0x2c
      && targetAt(code, 1, { owner, name: "phase0", descriptor: objectDescriptor })
      && code.subarray(4, 8).equals(Buffer.from([0x4e, 0x04, 0x36, 0x04]))
      && targetAt(code, 8, {
        owner: "ZeroReferenceStoreGroupRelocationProbe",
        name: "forceYoungRelocation", descriptor: "()V"
      })
      && code.subarray(11, 17).equals(Buffer.from([0x2a, 0x1b, 0x2c, 0x2d, 0x15, 0x04]))
      && targetAt(code, 17, { owner, name: "phase1", descriptor: phase1Descriptor })
      && code[20] === 0xb0
});

// These root maps are derived only after the exact signatures and bytecode
// above are accepted. BCI 8 is immediately before the no-arg relocation seam.
const orchestratorRootMap = { bci: 8, oops: [0, 2, 3], token: 4, depth: 0 };
const phase1RootMap = { bci: 0, oops: [0, 2, 3], token: 4, depth: 0 };

console.log("reference-store-group-relocation-class=pass owner=" + owner
  + " fields=0 clinit=0 methods=7"
  + " public-size=21 public-max-stack=5 public-max-locals=5"
  + " probe-bci=" + orchestratorRootMap.bci
  + " probe-owner=ZeroReferenceStoreGroupRelocationProbe"
  + " orchestrator-oops=" + orchestratorRootMap.oops.join(",")
  + " orchestrator-token=" + orchestratorRootMap.token + ":int"
  + " orchestrator-depth=" + orchestratorRootMap.depth
  + " phase1-size=28 phase1-max-stack=3 phase1-max-locals=5"
  + " phase1-entry-oops=" + phase1RootMap.oops.join(",")
  + " phase1-token=" + phase1RootMap.token + ":int"
  + " phase1-depth=" + phase1RootMap.depth
  + " edges=public->phase0,public->probe,public->phase1,phase0->relay,phase1->relay,phase1->commit,relay->leaf");

if (selfTestMode) {
  const directory = fs.mkdtempSync(pathModule.join(os.tmpdir(), "mcweb-c3b-class-negative."));
  const rejectMutation = (label, mutate) => {
    const candidate = Buffer.from(bytes);
    mutate(candidate);
    const candidatePath = pathModule.join(directory, label + ".class");
    fs.writeFileSync(candidatePath, candidate);
    const result = spawnSync(process.execPath, [process.argv[1], candidatePath],
        { encoding: "utf8" });
    if (result.status === 0) throw new Error("class self-negative accepted " + label);
  };
  const uniqueAt = (candidate, pattern, label) => {
    const first = candidate.indexOf(pattern);
    if (first < 0 || candidate.indexOf(pattern, first + 1) >= 0) {
      throw new Error("class self-test anchor " + label);
    }
    return first;
  };
  try {
    rejectMutation("version", (candidate) => { candidate[7] ^= 1; });
    rejectMutation("probe-bci", (candidate) => {
      const at = uniqueAt(candidate,
          Buffer.from([0x4e, 0x04, 0x36, 0x04, 0xb8]), "probe-bci");
      const call = Buffer.from(candidate.subarray(at + 4, at + 7));
      candidate.set(call, at + 1);
      candidate.set(Buffer.from([0x04, 0x36, 0x04]), at + 4);
    });
    // A same-length, still-verifiable removal of the relocation seam: the
    // three call bytes become nops, so phase 0 and phase 1 collapse into one
    // uninterrupted window. The gate must reject it exactly like a moved call.
    rejectMutation("missing-probe", (candidate) => {
      const at = uniqueAt(candidate,
          Buffer.from([0x4e, 0x04, 0x36, 0x04, 0xb8]), "missing-probe");
      candidate.set(Buffer.from([0x00, 0x00, 0x00]), at + 4);
    });
    // The token local is part of the root map, so its opcode and type are
    // pinned: an int store must not become a float store of the same length.
    rejectMutation("token-local-type", (candidate) => {
      const at = uniqueAt(candidate,
          Buffer.from([0x4e, 0x04, 0x36, 0x04, 0xb8]), "token-local-type");
      candidate.set(Buffer.from([0x0b, 0x38, 0x04]), at + 1);
    });
    rejectMutation("phase1-branch-bci", (candidate) => {
      const at = uniqueAt(candidate,
          Buffer.from([0x2c, 0x2d, 0xa6, 0x00, 0x08, 0x15, 0x04]),
          "phase1-branch-bci");
      candidate[at + 4] = 0x09;
    });
    rejectMutation("phase1-call-order", (candidate) => {
      const at = uniqueAt(candidate,
          Buffer.from([0x2a, 0x1b, 0x2d, 0xb8]), "phase1-call-order");
      const firstA = candidate[at + 4];
      const firstB = candidate[at + 5];
      const second = at + 6;
      if (candidate[second] !== 0xb8) throw new Error("second call anchor");
      candidate[at + 4] = candidate[second + 1];
      candidate[at + 5] = candidate[second + 2];
      candidate[second + 1] = firstA;
      candidate[second + 2] = firstB;
    });
    rejectMutation("stack-map-root", (candidate) => {
      const at = uniqueAt(candidate, Buffer.from([0x00, 0x02, 0x0a, 0x07]),
          "stack-map-root");
      candidate[at + 3] = 0x06;
    });
    rejectMutation("method-attribute", (candidate) => {
      const text = Buffer.from("StackMapTable");
      const at = uniqueAt(candidate, text, "method-attribute");
      candidate[at + text.length - 1] ^= 1;
    });
    rejectMutation("class-attribute", (candidate) => {
      if (candidate.readUInt16BE(candidate.length - 2) !== 0) {
        throw new Error("class attribute count anchor");
      }
      candidate.writeUInt16BE(1, candidate.length - 2);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log("reference-store-group-relocation-class-selftest=pass"
    + " negatives=9 version=69 probe-bci=8 phase1-bci=exact"
    + " stack-map=exact attributes=exact");
}
