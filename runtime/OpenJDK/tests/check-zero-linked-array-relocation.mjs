#!/usr/bin/env node
// Verify the live SerialGC card-base relocation in the preserved M2-A/P1
// modules, then emit a same-length canonical copy for hash comparison.  The
// live module is the one executed by the Java probe; the canonical copy is
// only an artifact-normalization input and is never executed.
import crypto from "node:crypto";
import fs from "node:fs";

const [, , modulePath, watPath, liveBaseText, countText, expectedSha,
  canonicalPath, label] = process.argv;

function fail(message) {
  console.error(`array-relocation-reject ${label || "<missing-label>"} ${message}`);
  process.exit(1);
}

if (!modulePath || !watPath || liveBaseText === undefined || countText === undefined
    || !expectedSha || !canonicalPath || !label) {
  fail("usage=module.wasm wat live-base expected-occurrences canonical-sha output label");
}

const liveBase = Number(liveBaseText);
const expectedCount = Number(countText);
const canonicalBase = 0x246d0000;
if (!Number.isSafeInteger(liveBase) || liveBase < -0x80000000
    || liveBase > 0x7fffffff || !Number.isInteger(expectedCount)
    || expectedCount <= 0) {
  fail(`arguments live-base=${liveBaseText} occurrences=${countText}`);
}

function signedLeb32(value) {
  const bytes = [];
  let remaining = value;
  let done = false;
  while (!done) {
    let byte = remaining & 0x7f;
    remaining = Math.trunc(remaining / 128);
    const sign = (byte & 0x40) !== 0;
    done = (remaining === 0 && !sign) || (remaining === -1 && sign);
    if (!done) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

const liveEncoding = signedLeb32(liveBase);
const canonicalEncoding = signedLeb32(canonicalBase);
if (liveEncoding.length !== 5 || canonicalEncoding.length !== 5) {
  fail(`non-fixed-card-base-encoding live-bytes=${liveEncoding.length} `
       + `canonical-bytes=${canonicalEncoding.length}`);
}

let moduleBytes;
let wat;
try {
  moduleBytes = fs.readFileSync(modulePath);
  wat = fs.readFileSync(watPath, "utf8");
} catch (error) {
  fail(`read=${error}`);
}
if (!WebAssembly.validate(moduleBytes)) fail("module-invalid");

// wasm-dis emits the card mark as i32.store8(i32.add(i32.const BASE,...)).
// Count only that exact shape, rather than every occurrence of the base in
// the text or binary.
const cardBases = [...wat.matchAll(
  /\(i32\.store8\s+\(i32\.add\s+\(i32\.const\s+(-?\d+)\)/gs,
)].map((match) => Number(match[1]));
if (cardBases.length !== expectedCount) {
  fail(`wat-card-context-count=${cardBases.length} expected=${expectedCount}`);
}
if (cardBases.some((base) => base !== liveBase)) {
  fail(`wat-card-context-base=${cardBases.join(",")} expected=${liveBase}`);
}

const offsets = [];
for (let offset = 0; offset <= moduleBytes.length - liveEncoding.length;) {
  let equal = true;
  for (let i = 0; i < liveEncoding.length; i++) {
    if (moduleBytes[offset + i] !== liveEncoding[i]) {
      equal = false;
      break;
    }
  }
  if (equal) offsets.push(offset);
  offset++;
}
if (offsets.length !== expectedCount) {
  fail(`binary-card-base-count=${offsets.length} expected=${expectedCount}`);
}
if (new Set(offsets).size !== offsets.length) fail("duplicate-card-base-offset");

const normalized = Buffer.from(moduleBytes);
for (const offset of offsets) canonicalEncoding.copy(normalized, offset);
if (!WebAssembly.validate(normalized)) fail("canonical-module-invalid");
const moduleSha = crypto.createHash("sha256").update(moduleBytes).digest("hex");
const canonicalSha = crypto.createHash("sha256").update(normalized).digest("hex");
if (canonicalSha !== expectedSha) {
  fail(`canonical-sha=${canonicalSha} expected=${expectedSha}`);
}
try {
  fs.writeFileSync(canonicalPath, normalized);
} catch (error) {
  fail(`write=${error}`);
}
console.log(`array-relocation label=${label} live-base=${liveBase} `
  + `card-contexts=${cardBases.length} binary-offsets=${offsets.join(",")} `
  + `live-sha=${moduleSha} canonical-base=${canonicalBase} `
  + `canonical-sha=${canonicalSha} execution-input=unmodified-live`);
