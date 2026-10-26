#!/usr/bin/env node
// Exact transcript oracle for the C3a two-slot long publication gate.
import fs from "node:fs";

const [, , logPath, selfTestFlag] = process.argv;
if (!logPath) {
  throw new Error("usage: check-zero-reference-store-group-perf-publication-log.mjs LOG [--self-test]");
}

function fieldsOf(line) {
  const result = Object.create(null);
  for (const token of line.slice("[zbp3] PERF_WINDOW ".length).split(" ")) {
    const at = token.indexOf("=");
    if (at <= 0 || at === token.length - 1) throw new Error("malformed field");
    const key = token.slice(0, at);
    if (Object.hasOwn(result, key)) throw new Error("duplicate field " + key);
    result[key] = token.slice(at + 1);
  }
  return result;
}

function verify(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const begin = lines.indexOf("PERF_PUBLICATION_BEGIN lane=direct n=1,64,65");
  const end = lines.indexOf("PERF_PUBLICATION_END windows=3 high32=zero,nonzero,nonzero sink-consumed=1");
  const terminal = lines.indexOf("ZERO_REFERENCE_STORE_GROUP_PERF_PUBLICATION result=pass");
  if (begin < 0 || end <= begin || terminal <= end
      || lines.lastIndexOf(lines[begin]) !== begin
      || lines.lastIndexOf(lines[end]) !== end
      || lines.lastIndexOf(lines[terminal]) !== terminal) {
    throw new Error("publication marker order/cardinality");
  }
  const events = lines.slice(begin + 1, end).filter((line) =>
    line.startsWith("[zbp3] PERF_WINDOW ")
      || line.startsWith("[zbp3] PERF_ELAPSED_RETURN "));
  if (events.length !== 6) throw new Error("publication event count");
  const windows = events.filter((_, index) => index % 2 === 0);
  const expectedN = [1, 64, 65];
  const expectedHigh = [0, 1, 1];
  windows.forEach((line, index) => {
    if (!line.startsWith("[zbp3] PERF_WINDOW ")
        || !events[index * 2 + 1].startsWith("[zbp3] PERF_ELAPSED_RETURN ")) {
      throw new Error("publication event order");
    }
    const f = fieldsOf(line);
    const elapsed = Object.fromEntries(events[index * 2 + 1]
      .slice("[zbp3] PERF_ELAPSED_RETURN ".length).split(" ")
      .map((token) => token.split("=")));
    const checksum = BigInt(f.checksum);
    const high = Number(checksum >> 32n);
    if (f.lane !== "direct" || Number(f.n) !== expectedN[index]
        || f.checksum !== f.oracle || Number(f["checksum-high32"]) !== high
        || (high === 0 ? 0 : 1) !== expectedHigh[index]
        || f.span !== "64" || f["thread-identity"] !== "1"
        || f["stack-depth"] !== "2" || f["stack-value"] !== "1"
        || f["pending-cleared"] !== "1"
        || f["card-globals-cleared"] !== "1" || f["elapsed-pending"] !== "1"
        || elapsed["elapsed-ns"] !== f["elapsed-ns"]
        || elapsed["thread-identity"] !== "1" || elapsed["stack-depth"] !== "2"
        || elapsed["stack-value"] !== "1" || elapsed["globals-cleared"] !== "1"
        || elapsed.pending !== "0"
        || f.fallback !== "0" || f.trap !== "0" || f.map !== "pass"
        || f.card !== "clean-dirty-clean"
        || f["pages-before"] !== f["pages-after"]
        || f["gc-before"] !== f["gc-after"]
        || f["safepoint-before"] !== f["safepoint-after"]) {
      throw new Error("publication invariant " + line);
    }
  });
  return windows;
}

const text = fs.readFileSync(logPath, "utf8");
const windows = verify(text);
if (selfTestFlag === "--self-test") {
  const negatives = [
    text.replace("stack-depth=2", "stack-depth=1"),
    text.replace("thread-identity=1", "thread-identity=0"),
    text.replace("pending-cleared=1", "pending-cleared=0"),
    text.replace("globals-cleared=1", "globals-cleared=0"),
    text.replace("n=1 start=", "n=2 start="),
  ];
  for (const negative of negatives) {
    let rejected = false;
    try { verify(negative); } catch { rejected = true; }
    if (!rejected) throw new Error("self-negative accepted");
  }
  console.log("C3A_PERF_PUBLICATION_SELF_NEGATIVES count=5 result=pass");
}
console.log(`C3A_PERF_PUBLICATION windows=${windows.length} high32=zero,nonzero,nonzero thread=stable stack=depth2 result=pass`);
