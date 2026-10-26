#!/usr/bin/env node
// Fail-closed Stage-1 log checker. Linked relocation execution is forbidden.
import fs from "node:fs";

const success = "reference-store-group-relocation-stage1 fixture=pass near-miss=pass gc=not-executed";
const forbidden = /(?:\bACCEPT\b|RELOCATION_(?:ENTER|DIRECT|ARM|RESUME)|System\.gc|Pause Young|Pause Full|OutOfMemoryError|AssertionError|fatal error|SIG(?:SEGV|ABRT)|broken pipe)/i;

const validate = (text) => {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.filter((line) => line === success).length !== 1) {
    throw new Error("expected exactly one Stage-1 JVM success marker");
  }
  const bad = lines.find((line) => forbidden.test(line));
  if (bad) throw new Error("forbidden runtime/diagnostic marker: " + bad);
  return lines.length;
};

const selfTest = () => {
  validate(success + "\n");
  const negatives = [
    ["duplicate", success + "\n" + success + "\n"],
    ["gc", success + "\n[info][gc] Pause Young\n"],
    ["linked", success + "\n[zbr4] RELOCATION_DIRECT phase=1\n"],
    ["accept", success + "\nACCEPT\n"],
    ["missing", "reference-store-group-relocation-stage1 fixture=pass\n"]
  ];
  for (const [label, value] of negatives) {
    let rejected = false;
    try { validate(value); } catch (error) { rejected = true; }
    if (!rejected) throw new Error("self-negative accepted " + label);
  }
  console.log("reference-store-group-relocation-log-selftest=pass negatives="
    + negatives.length + " linked=not-executed gc=not-executed");
};

if (process.argv[2] === "--self-test") {
  selfTest();
} else {
  const path = process.argv[2];
  if (!path) throw new Error("usage: ... --self-test | LOG");
  const count = validate(fs.readFileSync(path, "utf8"));
  console.log("reference-store-group-relocation-log=pass lines=" + count
    + " linked=not-executed gc=not-executed");
}
