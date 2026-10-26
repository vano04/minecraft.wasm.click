#!/usr/bin/env node
// Fail-closed verifier for the C3b Stage-1 structural WIP manifest.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const requiredMetadata = new Map([
  ["phase", "C3B_STAGE1_STRUCTURAL_WIP"],
  ["acceptance", "NOT_EXECUTED"],
  ["runtime", "NOT_REBUILT"],
  ["module", "NOT_DUMPED"],
  ["continuation", "UNARMED"],
  ["gc", "NOT_EXECUTED"],
  ["class-contract", "ZeroReferenceStoreGroupRelocationFixture#groupedReferenceStoreAcrossRelocation@probe-bci8;phase1@bci0"],
  ["probe-contract", "ZeroReferenceStoreGroupRelocationProbe#forceYoungRelocation()V@bci8"],
  ["orchestrator-root-map", "bci8:oops=0,2,3;token=4:int;depth=0"],
  ["phase1-root-map", "bci0:oops=0,2,3;token=4:int;depth=0"],
  ["phase-abi", "dispatcher9->i64;phase0:i32->i32;phase1:3i32->void"],
  ["phase-edges", "dispatcher->phase0,dispatcher->phase1,phase0->relay,phase1->relay,phase1->commit,relay->leaf"],
  ["cache-mutations-planned", "compiler,digest,bytes,memory,metadata,slot,card-layout,phase-abi,phase-edges,root-map,poison"]
]);
const requiredPaths = [
  "OpenJDK/tests/ZeroReferenceStoreGroupRelocationFixture.java",
  "OpenJDK/tests/ZeroReferenceStoreGroupRelocationNearMiss.java",
  "OpenJDK/tests/ZeroReferenceStoreGroupRelocationProbe.java",
  "OpenJDK/tests/check-zero-reference-store-group-relocation-class.mjs",
  "OpenJDK/tests/check-zero-reference-store-group-relocation-log.mjs",
  "OpenJDK/tests/check-zero-reference-store-group-relocation-manifest.mjs",
  "OpenJDK/tests/check-zero-reference-store-group-relocation-source.mjs",
  "OpenJDK/tests/check-zero-reference-store-group-relocation-wat.mjs",
  "OpenJDK/tests/run-zero-reference-store-group-relocation-static.sh",
  "OpenJDK/work/jdk25/src/hotspot/cpu/zero/globals_zero.hpp",
  "OpenJDK/work/jdk25/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp",
  "OpenJDK/work/jdk25/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp",
  "OpenJDK/work/jdk25/src/hotspot/share/interpreter/zero/zeroWasmBaseline.hpp"
];

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const parse = (manifestPath, text) => {
  const metadata = new Map();
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const row = /^([0-9a-f]{64}) ([0-9]+) (\S+)$/.exec(line);
    if (row) {
      rows.push({ sha: row[1], bytes: Number(row[2]), path: row[3] });
      continue;
    }
    const meta = /^([a-z0-9-]+)=(.*)$/.exec(line);
    if (!meta || metadata.has(meta[1])) throw new Error("bad/duplicate manifest line " + line);
    metadata.set(meta[1], meta[2]);
  }
  for (const [key, value] of requiredMetadata) {
    if (metadata.get(key) !== value) throw new Error("metadata " + key + " mismatch");
  }
  if (metadata.size !== requiredMetadata.size) {
    throw new Error("metadata key closure count=" + metadata.size
        + " expected=" + requiredMetadata.size);
  }
  for (const key of metadata.keys()) {
    if (!requiredMetadata.has(key)) throw new Error("unknown metadata key " + key);
  }
  if ([...metadata.values()].some((value) => /ACCEPT|PASS|READY/.test(value))) {
    throw new Error("WIP manifest contains acceptance claim");
  }
  // Each structural fault gets its own branch so a negative proves the rule it
  // targets, rather than being absorbed by the closure comparison.
  for (const row of rows) {
    if (row.path.includes("..") || path.isAbsolute(row.path)
        || row.path.startsWith("/") || row.path.includes("\\")) {
      throw new Error("unsafe path " + row.path);
    }
  }
  if (new Set(rows.map((row) => row.path)).size !== rows.length) {
    throw new Error("duplicate asset path");
  }
  const paths = rows.map((row) => row.path);
  if (paths.join("\n") !== [...paths].sort().join("\n")) {
    throw new Error("asset rows are not sorted by path");
  }
  if (paths.join("\n") !== [...requiredPaths].sort().join("\n")) {
    throw new Error("asset path closure mismatch");
  }
  const root = path.resolve(path.dirname(manifestPath), "../..");
  for (const row of rows) {
    const bytes = fs.readFileSync(path.join(root, row.path));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha) {
      throw new Error("asset drift " + row.path);
    }
  }
  return { metadata, rows };
};

const validate = (manifestPath, text = fs.readFileSync(manifestPath, "utf8")) =>
  parse(manifestPath, text);

if (process.argv[2] === "--self-test") {
  const manifestPath = process.argv[3];
  if (!manifestPath) throw new Error("usage: ... --self-test MANIFEST");
  const text = fs.readFileSync(manifestPath, "utf8");
  validate(manifestPath, text);
  const swapRows = (value) => {
    const lines = value.split("\n");
    const indices = lines.reduce((acc, line, index) =>
      /^[0-9a-f]{64} /.test(line) ? [...acc, index] : acc, []);
    const [first, second] = [indices[0], indices[1]];
    const copy = [...lines];
    copy[first] = lines[second];
    copy[second] = lines[first];
    return copy.join("\n");
  };
  const firstRow = /^[0-9a-f]{64} [0-9]+ .+$/m.exec(text)[0];
  const mutations = [
    ["acceptance", text.replace("acceptance=NOT_EXECUTED", "acceptance=ACCEPTED"),
      /metadata acceptance mismatch/],
    ["digest", text.replace(/^([0-9a-f]{64}) /m, (row, digest) =>
      (digest[0] === "0" ? "1" : "0") + digest.slice(1) + " "),
      /asset drift/],
    ["missing-row", text.replace(/^([0-9a-f]{64} [0-9]+ .+\n)/m, ""),
      /asset path closure mismatch/],
    ["duplicate-metadata", text + "runtime=NOT_REBUILT\n",
      /bad\/duplicate manifest line/],
    ["unknown-key", text + "unknown-stage1-key=forbidden\n",
      /unknown metadata key|metadata key closure count/],
    ["root-map", text.replace("orchestrator-root-map=bci8:oops=0,2,3",
      "orchestrator-root-map=bci8:oops=0,2"),
      /metadata orchestrator-root-map mismatch/],
    ["phase1-root-map", text.replace("phase1-root-map=bci0:", "phase1-root-map=bci1:"),
      /metadata phase1-root-map mismatch/],
    ["phase-edges", text.replace("phase1->commit", "phase1->leaf"),
      /metadata phase-edges mismatch/],
    ["phase-abi", text.replace("phase1:3i32->void", "phase1:3i32->i32"),
      /metadata phase-abi mismatch/],
    ["class-contract", text.replace("@probe-bci8;phase1@bci0", "@probe-bci5;phase1@bci0"),
      /metadata class-contract mismatch/],
    ["row-order", swapRows(text), /asset rows are not sorted by path/],
    ["duplicate-path", text + firstRow + "\n", /duplicate asset path/],
    ["unsafe-path", text.replace(/^([0-9a-f]{64} [0-9]+ )\S+$/m,
      (row, prefix) => prefix + "../etc/passwd"), /unsafe path/],
    ["absolute-path", text.replace(/^([0-9a-f]{64} [0-9]+ )\S+$/m,
      (row, prefix) => prefix + "/etc/passwd"), /unsafe path/],
    ["byte-count", text.replace(/^([0-9a-f]{64}) ([0-9]+) /m,
      (row, digest, bytes) => digest + " " + (Number(bytes) + 1) + " "),
      /asset drift/]
  ];
  for (const [label, mutated, expected] of mutations) {
    let message = null;
    try { validate(manifestPath, mutated); } catch (error) { message = error.message; }
    if (message === null) throw new Error("manifest self-negative accepted " + label);
    if (!expected.test(message)) {
      throw new Error("manifest self-negative " + label
          + " rejected for the wrong reason: " + message);
    }
  }
  console.log("reference-store-group-relocation-manifest-selftest=pass negatives="
    + mutations.length + " reasons=pinned" + " metadata-keys=" + requiredMetadata.size
    + " unknown-key=reject acceptance=NOT_EXECUTED");
} else {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error("usage: ... MANIFEST");
  const result = validate(manifestPath);
  console.log("reference-store-group-relocation-manifest=pass assets="
    + result.rows.length + " metadata-keys=" + result.metadata.size
    + " acceptance=NOT_EXECUTED runtime=NOT_REBUILT"
    + " module=NOT_DUMPED continuation=UNARMED gc=NOT_EXECUTED");
}
