#!/usr/bin/env node
// Whole-file source oracle for C3a's canonical Zero long-result publication.
import crypto from "node:crypto";
import fs from "node:fs";

const [, , sourcePath, selfTestFlag] = process.argv;
if (!sourcePath) {
  throw new Error("usage: check-zero-reference-store-group-perf-publication-source.mjs SOURCE [--self-test]");
}

const helperName = "reference_store_group_perf_push_long_infallible";
const helperSignature = `static void ${helperName}(`;

function functionBlock(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0 || source.indexOf(signature, start + 1) >= 0) {
    throw new Error("canonical helper definition cardinality");
  }
  const open = source.indexOf("{", start + signature.length);
  if (open < 0) throw new Error("canonical helper open brace");
  let depth = 0;
  let state = "code";
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    const n = source[i + 1];
    if (state === "line") {
      if (c === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; i++; }
      continue;
    }
    if (state === "string" || state === "char") {
      if (c === "\\") { i++; continue; }
      if ((state === "string" && c === '"') || (state === "char" && c === "'")) state = "code";
      continue;
    }
    if (c === "/" && n === "/") { state = "line"; i++; continue; }
    if (c === "/" && n === "*") { state = "block"; i++; continue; }
    if (c === '"') { state = "string"; continue; }
    if (c === "'") { state = "char"; continue; }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("canonical helper unbalanced body");
}

function verify(source) {
  if (/\bpush_long\s*\(/.test(source)) throw new Error("dead generic push_long present");
  if (/(?:jlong|VMJavaVal64)[^;\n]*&?top\[0\][^;\n]*=|(?:jlong|VMJavaVal64)[^;\n]*=.+&?top\[0\]/.test(source)) {
    throw new Error("top[0] long write present");
  }
  const block = functionBlock(source, helperSignature);
  const normalized = block.replace(/\s+/g, " ");
  if (!normalized.includes("interpreterState istate, intptr_t** tos, intptr_t* expected_top, jlong value, JavaThread* expected_thread)")) {
    throw new Error("canonical helper arguments");
  }
  const canonicalWrites = block.match(/\*\(\(jlong\*\)&expected_top\[-1\]\)\s*=\s*value\s*;/g) || [];
  if (canonicalWrites.length !== 1
      || /\*\(\(jlong\*\)&expected_top\[0\]\)\s*=/.test(block)
      || !block.includes("*tos = expected_top - 2;")
      || (block.match(/istate->thread\(\) != expected_thread/g) || []).length < 2) {
    throw new Error("canonical helper body");
  }
  const allNames = source.match(new RegExp(`\\b${helperName}\\s*\\(`, "g")) || [];
  const exactCalls = [...source.matchAll(new RegExp(
    `${helperName}\\s*\\(\\s*istate,\\s*tos,\\s*publication_top,\\s*(elapsed|raw),\\s*expected_thread\\s*\\);`, "g"))];
  if (allNames.length !== 3 || exactCalls.length !== 2
      || exactCalls.map((match) => match[1]).sort().join(",") !== "elapsed,raw") {
    throw new Error("canonical helper exact call sites");
  }
  return crypto.createHash("sha256").update(source).digest("hex");
}

const source = fs.readFileSync(sourcePath, "utf8");
const sha = verify(source);
if (selfTestFlag === "--self-test") {
  const negatives = [
    source.replaceAll(helperName, `${helperName}_renamed`),
    source.replace("publication_top, elapsed, expected_thread",
                   "publication_top, raw, expected_thread"),
    source.replace("&expected_top[-1]) = value;", "&expected_top[0]) = value;"),
  ];
  for (const negative of negatives) {
    let rejected = false;
    try { verify(negative); } catch { rejected = true; }
    if (!rejected) throw new Error("source self-negative accepted");
  }
  console.log("C3A_PERF_PUBLICATION_SOURCE_SELF_NEGATIVES renamed=reject argument=reject top0=reject count=3 result=pass");
}
console.log(`C3A_PERF_PUBLICATION_SOURCE sha256=${sha} generic=absent top0-long-writes=0 canonical-writes=1 exact-calls=2 result=pass`);
