#!/usr/bin/env node
// Structural checker for the synthetic M2-A array module.  The WAT is a
// diagnostic disassembly; the binary is validated independently below.
import fs from "node:fs";

const [, , binaryPath, watPath] = process.argv;
if (!binaryPath || !watPath) {
  console.error("usage: check-zero-linked-array-wat.mjs MODULE.wasm MODULE.wat");
  process.exit(2);
}

const binary = fs.readFileSync(binaryPath);
if (!WebAssembly.validate(binary)) throw new Error("binary validation failed");
const wat = fs.readFileSync(watPath, "utf8");

function balancedSlice(source, needle) {
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`missing ${needle}`);
  let depth = 0;
  let quote = false;
  let lineComment = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (!quote && ch === ";" && next === ";") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '"' && source[i - 1] !== "\\") {
      quote = !quote;
      continue;
    }
    if (quote) continue;
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${needle}`);
}

function count(source, token) {
  return source.split(token).length - 1;
}

function checkBody(body) {
  const required = [
    "(i32.eqz", "(i32.gt_u", "(i64.le_u", "(i64.mul",
    "(i64.add", "(i64.extend_i32_u", "(i32.wrap_i64", "(memory.size)",
    "(i32.load offset=8", "(i32.load\n",
  ];
  const missing = required.filter((token) => !body.includes(token));
  if (missing.length) throw new Error(`missing array structure: ${missing.join(",")}`);
  if (count(body, "(i32.eqz") < 3) throw new Error("null/override guards incomplete");
  if (count(body, "(memory.size)") < 3) throw new Error("memory guards incomplete");
  if (count(body, "(i64.le_u") < 2) throw new Error("widened end guards incomplete");
  if (count(body, "(i32.load") !== 2) throw new Error("unexpected load count");
  if (count(body, "(i32.load offset=8") !== 1) throw new Error("wrong length offset");
  if (/\(call(?:_indirect)?\b|\bunreachable\b/.test(body)) {
    throw new Error("array body contains call/trap");
  }
  // Four invalid paths return the exact iaload-BCl/status literal for the
  // current fixture. The positive value is computed by the only load above.
  if (count(body, "844433520066560") !== 4) throw new Error("status/BCI literal mismatch");
  return true;
}

function expectReject(label, mutate) {
  try {
    checkBody(mutate(actualBody));
  } catch {
    return;
  }
  throw new Error(`checker negative accepted: ${label}`);
}

const imports = [...wat.matchAll(/^\s*\(import /gm)];
if (imports.length !== 1 || !wat.includes('(import "env" "memory"')) {
  throw new Error("unexpected import set");
}
const exports = [...wat.matchAll(/^\s*\(export "([^"]+)"/gm)].map((m) => m[1]);
const expectedExports = ["leaf", "caller", "virtualValue", "safeDiv",
  "storeChild", "storeChildCaller", "goodValue", "dispatch", "throwLeaf",
  "throwCaller", "intArrayLoad"];
if (exports.length !== expectedExports.length
    || exports.some((name, i) => name !== expectedExports[i])) {
  throw new Error(`unexpected export set: ${exports.join(",")}`);
}
if ([...wat.matchAll(/^\s*\(func \$([0-9]+)/gm)].length !== 11) {
  throw new Error("unexpected function count");
}
const actualBody = balancedSlice(wat, "(func $10 ");
checkBody(actualBody);

// These are checker self-negatives, not artifact mutations. They ensure the
// gate rejects the common audit failures independently of the current module.
expectReject("signed bounds", (body) => body.replace("(i32.gt_u", "(i32.gt_s"));
expectReject("wrong offset", (body) => body.replace("offset=8", "offset=12"));
expectReject("mul versus add", (body) => body.replaceAll("(i64.mul", "(i64.add"));
expectReject("missing memory guard", (body) => body.replaceAll("(memory.size)", "(i32.const 0)"));
expectReject("missing null guard", (body) => body.replace("(i32.eqz", "(i32.ne"));
expectReject("wrong status/BCI", (body) => body.replaceAll("844433520066560", "844433520066561"));
expectReject("extra edge", (body) => `${body}\n(call $0)`);

console.log("array-wat-binary-validation=pass");
console.log("array-body-depth-aware=pass imports=1 exports=11 funcs=11");
console.log("array-body-self-negatives=7 rejected");
