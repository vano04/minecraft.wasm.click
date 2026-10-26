#!/usr/bin/env node
// Ordered, case-window checker for the synthetic M2-A array transcript.
import fs from "node:fs";

const [, , logPath, mode = "linked"] = process.argv;
if (!logPath) throw new Error("usage: check-zero-linked-array-log.mjs LOG [linked|forced|negative]");
const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
const expected = mode === "negative" ? ["near-misses"]
  : ["valid-first", "mutated", "valid-last", "null", "negative", "length", "min-index", "empty"];
const blocks = new Map();
let current = null;
for (const line of lines) {
  const begin = line.match(/^CASE_BEGIN (.+)$/);
  const end = line.match(/^CASE_END (.+)$/);
  if (begin) {
    if (current) throw new Error(`nested case ${begin[1]}`);
    if (blocks.has(begin[1])) throw new Error(`duplicate case ${begin[1]}`);
    current = { name: begin[1], lines: [] };
    blocks.set(begin[1], current);
    continue;
  }
  if (end) {
    if (!current || current.name !== end[1]) throw new Error(`case order/end mismatch ${end[1]}`);
    current = null;
    continue;
  }
  if (current) current.lines.push(line);
  else if (/(ARRAY_ENTER|ARRAY_TABLE_CALL|ARRAY_STATUS|ARRAY_EXIT|ARRAY_OPCODE_REEXECUTE|INTERPRETER_IALOAD|DIRECT_LOAD)/.test(line)) {
    throw new Error(`array marker outside case window: ${line}`);
  }
}
if (current) throw new Error(`unterminated case ${current.name}`);
if (blocks.size !== expected.length || expected.some((name, i) => [...blocks.keys()][i] !== name)) {
  throw new Error(`case order mismatch: ${[...blocks.keys()].join(",")}`);
}

function one(block, expression, label) {
  const matches = block.lines.filter((line) => expression.test(line));
  if (matches.length !== 1) throw new Error(`${block.name}: ${label} count=${matches.length}`);
  const sequence = matches[0].match(/seq=(\d+)/)?.[1];
  if (sequence !== String(expected.indexOf(block.name) + 1)) {
    throw new Error(`${block.name}: ${label} sequence=${sequence}`);
  }
}

for (const name of expected) {
  const block = blocks.get(name);
  if (mode === "negative") {
    if (block.lines.some((line) => /(ARRAY_ENTER|ARRAY_TABLE_CALL|ARRAY_STATUS|ARRAY_EXIT|ARRAY_OPCODE_REEXECUTE|INTERPRETER_IALOAD|DIRECT_LOAD)/.test(line))) {
      throw new Error("near-miss case entered array linked path");
    }
    continue;
  }
  one(block, /ARRAY_ENTER seq=\d+ /, "ENTER");
  one(block, /ARRAY_TABLE_CALL seq=\d+ /, "TABLE_CALL");
  one(block, /ARRAY_STATUS seq=\d+ /, "STATUS");
  one(block, /ARRAY_EXIT seq=\d+ /, "EXIT");
  const isDirect = expected.indexOf(name) < 3 && mode === "linked";
  const reexec = block.lines.filter((line) => /ARRAY_OPCODE_REEXECUTE seq=\d+ /.test(line));
  const interpreter = block.lines.filter((line) => /INTERPRETER_IALOAD seq=\d+ /.test(line));
  const direct = block.lines.filter((line) => /DIRECT_LOAD intArrayLoad runtime=1 seq=\d+ /.test(line));
  if (isDirect && (reexec.length || interpreter.length || direct.length !== 1)) {
    throw new Error(`${name}: direct/fallback event mismatch`);
  }
  if (!isDirect && (reexec.length !== 1 || interpreter.length !== 1 || direct.length)) {
    throw new Error(`${name}: fallback event mismatch`);
  }
  if (!isDirect) {
    const reason = reexec[0].match(/reason=([a-z-]+)/)?.[1];
    const expectedReason = mode === "forced" && expected.indexOf(name) < 3
      ? "memory" : (name === "null" ? "null" : "bounds");
    if (reason !== expectedReason) {
      throw new Error(`${name}: reason=${reason} expected=${expectedReason}`);
    }
  }
}
console.log(`array-log-order=pass mode=${mode} cases=${expected.length}`);
