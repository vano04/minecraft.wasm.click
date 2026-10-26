#!/usr/bin/env node
// Deterministically add one synthetic exception-table entry to the exact
// ZeroBaselineFixture.intArrayStore([III)I Code attribute, or verify that a
// candidate is exactly that transformation.  The six code bytes are never
// changed.  This is an OSS-only classifier fixture, not production bytecode.
import crypto from "node:crypto";
import fs from "node:fs";

const [, , mode, originalPath, candidatePath] = process.argv;

function fail(message) {
  console.error(`exception-class-reject ${message}`);
  process.exit(1);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  need(length) {
    requireCondition(this.offset + length <= this.buffer.length,
      `truncated offset=${this.offset} need=${length}`);
  }

  u1() {
    this.need(1);
    return this.buffer[this.offset++];
  }

  u2() {
    this.need(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  u4() {
    this.need(4);
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  skip(length) {
    this.need(length);
    this.offset += length;
  }
}

function parseClass(buffer) {
  const reader = new Reader(buffer);
  requireCondition(reader.u4() === 0xcafebabe, "bad-magic");
  const minor = reader.u2();
  const major = reader.u2();
  const constantPoolCount = reader.u2();
  const constantPool = new Array(constantPoolCount);
  for (let index = 1; index < constantPoolCount; index++) {
    const tag = reader.u1();
    const entry = { tag };
    constantPool[index] = entry;
    switch (tag) {
      case 1: {
        const length = reader.u2();
        reader.need(length);
        entry.value = reader.buffer.toString("utf8", reader.offset,
          reader.offset + length);
        reader.skip(length);
        break;
      }
      case 3:
      case 4:
        reader.skip(4);
        break;
      case 5:
      case 6:
        reader.skip(8);
        index++;
        break;
      case 7:
        entry.nameIndex = reader.u2();
        break;
      case 8:
      case 16:
      case 19:
      case 20:
        reader.skip(2);
        break;
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        reader.skip(4);
        break;
      case 15:
        reader.skip(3);
        break;
      default:
        fail(`unknown-constant-pool-tag=${tag} index=${index}`);
    }
  }
  const utf8 = (index) => {
    const entry = constantPool[index];
    requireCondition(entry && entry.tag === 1,
      `constant-pool-utf8 index=${index}`);
    return entry.value;
  };
  reader.u2();
  const thisClassIndex = reader.u2();
  reader.u2();
  const thisClass = constantPool[thisClassIndex];
  requireCondition(thisClass && thisClass.tag === 7, "this-class-entry");
  const holder = utf8(thisClass.nameIndex);
  const interfaceCount = reader.u2();
  reader.skip(interfaceCount * 2);

  const skipAttributes = (count) => {
    for (let index = 0; index < count; index++) {
      reader.u2();
      reader.skip(reader.u4());
    }
  };
  const fieldCount = reader.u2();
  for (let index = 0; index < fieldCount; index++) {
    reader.skip(6);
    skipAttributes(reader.u2());
  }

  let target = null;
  const methodCount = reader.u2();
  for (let methodIndex = 0; methodIndex < methodCount; methodIndex++) {
    const accessFlags = reader.u2();
    const nameIndex = reader.u2();
    const descriptorIndex = reader.u2();
    const name = utf8(nameIndex);
    const descriptor = utf8(descriptorIndex);
    const attributeCount = reader.u2();
    for (let attributeIndex = 0; attributeIndex < attributeCount;
        attributeIndex++) {
      const attributeNameIndex = reader.u2();
      const attributeLengthOffset = reader.offset;
      const attributeLength = reader.u4();
      const infoOffset = reader.offset;
      const attributeName = utf8(attributeNameIndex);
      if (name === "intArrayStore" && descriptor === "([III)I"
          && attributeName === "Code") {
        requireCondition(target === null, "duplicate-target-code");
        const codeReader = new Reader(buffer);
        codeReader.offset = infoOffset;
        const maxStack = codeReader.u2();
        const maxLocals = codeReader.u2();
        const codeLength = codeReader.u4();
        const codeOffset = codeReader.offset;
        codeReader.skip(codeLength);
        const exceptionCountOffset = codeReader.offset;
        const exceptionCount = codeReader.u2();
        const exceptionTableOffset = codeReader.offset;
        const exceptionEntries = [];
        for (let exceptionIndex = 0; exceptionIndex < exceptionCount;
            exceptionIndex++) {
          exceptionEntries.push({
            startPc: codeReader.u2(),
            endPc: codeReader.u2(),
            handlerPc: codeReader.u2(),
            catchType: codeReader.u2(),
          });
        }
        const nestedAttributeCount = codeReader.u2();
        for (let nestedIndex = 0; nestedIndex < nestedAttributeCount;
            nestedIndex++) {
          codeReader.u2();
          codeReader.skip(codeReader.u4());
        }
        requireCondition(codeReader.offset === infoOffset + attributeLength,
          `code-attribute-length parsed=${codeReader.offset - infoOffset} `
            + `declared=${attributeLength}`);
        target = {
          accessFlags,
          attributeLength,
          attributeLengthOffset,
          codeLength,
          codeOffset,
          exceptionCount,
          exceptionCountOffset,
          exceptionEntries,
          exceptionTableOffset,
          maxLocals,
          maxStack,
          name,
          descriptor,
          nestedAttributeCount,
        };
      }
      reader.offset = infoOffset + attributeLength;
      reader.need(0);
    }
  }
  skipAttributes(reader.u2());
  requireCondition(reader.offset === buffer.length,
    `trailing-class-bytes=${buffer.length - reader.offset}`);
  requireCondition(target !== null, "target-code-missing");
  return { holder, major, minor, target };
}

const expectedCode = Buffer.from([0x2a, 0x1b, 0x1c, 0x4f, 0x1c, 0xac]);
const syntheticEntry = Buffer.from([0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00]);

function verifyOriginal(buffer) {
  const parsed = parseClass(buffer);
  const target = parsed.target;
  requireCondition(parsed.holder === "ZeroBaselineFixture",
    `holder=${parsed.holder}`);
  requireCondition(target.name === "intArrayStore"
      && target.descriptor === "([III)I", "target-identity");
  requireCondition(target.codeLength === expectedCode.length,
    `original-code-length=${target.codeLength}`);
  requireCondition(buffer.subarray(target.codeOffset,
    target.codeOffset + target.codeLength).equals(expectedCode),
  "original-code-bytes");
  requireCondition(target.exceptionCount === 0,
    `original-exception-count=${target.exceptionCount}`);
  return parsed;
}

function transform(original) {
  const parsed = verifyOriginal(original);
  const target = parsed.target;
  const prefix = Buffer.from(original.subarray(0, target.exceptionTableOffset));
  prefix.writeUInt32BE(target.attributeLength + syntheticEntry.length,
    target.attributeLengthOffset);
  prefix.writeUInt16BE(1, target.exceptionCountOffset);
  return Buffer.concat([
    prefix,
    syntheticEntry,
    original.subarray(target.exceptionTableOffset),
  ]);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function verifyCandidate(original, candidate) {
  const originalParsed = verifyOriginal(original);
  const expected = transform(original);
  requireCondition(candidate.length === original.length + syntheticEntry.length,
    `candidate-size=${candidate.length} expected=${expected.length}`);
  requireCondition(candidate.equals(expected),
    `candidate-not-exact-transform sha=${sha256(candidate)} `
      + `expected=${sha256(expected)}`);
  const candidateParsed = parseClass(candidate);
  const originalTarget = originalParsed.target;
  const candidateTarget = candidateParsed.target;
  requireCondition(candidateParsed.holder === originalParsed.holder,
    "candidate-holder-drift");
  requireCondition(candidateTarget.codeLength === expectedCode.length
      && candidate.subarray(candidateTarget.codeOffset,
        candidateTarget.codeOffset + candidateTarget.codeLength).equals(expectedCode),
  "candidate-code-drift");
  requireCondition(candidateTarget.maxStack === originalTarget.maxStack
      && candidateTarget.maxLocals === originalTarget.maxLocals
      && candidateTarget.nestedAttributeCount === originalTarget.nestedAttributeCount,
  "candidate-code-metadata-drift");
  requireCondition(candidateTarget.attributeLength
      === originalTarget.attributeLength + syntheticEntry.length,
  "candidate-code-attribute-length-drift");
  requireCondition(candidateTarget.exceptionCount === 1,
    `candidate-exception-count=${candidateTarget.exceptionCount}`);
  const entry = candidateTarget.exceptionEntries[0];
  requireCondition(entry.startPc === 0 && entry.endPc === 1
      && entry.handlerPc === 0 && entry.catchType === 0,
  `candidate-exception-entry=${entry.startPc}:${entry.endPc}:`
    + `${entry.handlerPc}:${entry.catchType}`);
  return { originalParsed, candidateParsed };
}

if (mode !== "transform" && mode !== "check") {
  fail("usage=transform|check original.class candidate.class");
}
if (!originalPath || !candidatePath) {
  fail("usage=transform|check original.class candidate.class");
}
const original = fs.readFileSync(originalPath);
if (mode === "transform") {
  const candidate = transform(original);
  fs.writeFileSync(candidatePath, candidate);
  verifyCandidate(original, candidate);
  console.log(`exception-class-transform=pass original-sha=${sha256(original)} `
    + `candidate-sha=${sha256(candidate)} delta-bytes=${candidate.length - original.length}`);
} else {
  const candidate = fs.readFileSync(candidatePath);
  const { originalParsed } = verifyCandidate(original, candidate);
  console.log("exception-class-structure=pass holder=ZeroBaselineFixture "
    + "method=intArrayStore descriptor=([III)I code=2a1b1c4f1cac code-length=6 "
    + "original-exception-table=0 transformed-exception-table=1 "
    + "entry=0:1:0:0 delta-bytes=8 only-exception-metadata-added=1 "
    + `class-version=${originalParsed.major}.${originalParsed.minor} `
    + `original-sha=${sha256(original)} transformed-sha=${sha256(candidate)}`);
}
