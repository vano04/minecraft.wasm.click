#!/usr/bin/env node
// Bind final 0019 publication to the modules in this run's cold/perf roots.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXPECTED = {
  production: {
    prefix: "/private/tmp/mcweb-zero-reference-store-group-c3a-cold-accept.",
    format: "structured",
    sha256: "9b9ab39a8cef7afc616dadc42881ab7ef4d4390ef0f7506a705daeebf0259107",
    bytes: 533,
  },
  perf: {
    prefix: "/private/tmp/mcweb-zero-reference-store-group-perf-accept.",
    format: "three-column",
    sha256: "13a5cff21e2c98eae7791eda3deca79794a509a5b468efee0ea60fc64494b49d",
    bytes: 1096,
  },
};

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function indexRows(text, format) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    let match;
    if (format === "structured") {
      match = /^bundle-file path=([^ ]+) sha256=([0-9a-f]{64}) bytes=(0|[1-9][0-9]*)$/.exec(line);
      if (!match) continue;
      rows.push({ relative: match[1], sha256: match[2], bytes: Number(match[3]) });
    } else {
      match = /^([0-9a-f]{64})  (0|[1-9][0-9]*)  ([^ ]+)$/.exec(line);
      if (!match) throw new Error("unknown or mixed three-column index row");
      rows.push({ relative: match[3], sha256: match[1], bytes: Number(match[2]) });
    }
  }
  return rows;
}

function verifyRoot(root, runId, spec) {
  if (root !== `${spec.prefix}${runId}`) throw new Error("stale or foreign evidence root");
  const indexPath = path.join(root, "evidence.index");
  const sidecarPath = path.join(root, "evidence.index.sha256");
  const index = fs.readFileSync(indexPath);
  const sidecar = fs.readFileSync(sidecarPath, "utf8");
  const sidecarMatch = /^([0-9a-f]{64})  evidence\.index\n?$/.exec(sidecar);
  const indexSha256 = sha256(index);
  if (!sidecarMatch || sidecarMatch[1] !== indexSha256) throw new Error("index sidecar mismatch");
  const rows = indexRows(index.toString("utf8"), spec.format);
  const moduleRows = rows.filter(({ relative }) => relative === "checks/module.wasm");
  if (moduleRows.length !== 1) throw new Error("module index row count");
  const module = fs.readFileSync(path.join(root, "checks/module.wasm"));
  const actual = { sha256: sha256(module), bytes: module.length, indexSha256 };
  const row = moduleRows[0];
  if (row.sha256 !== actual.sha256 || row.bytes !== actual.bytes) {
    throw new Error("module index payload mismatch");
  }
  if (actual.sha256 !== spec.sha256 || actual.bytes !== spec.bytes) {
    throw new Error("unexpected module identity");
  }
  return actual;
}

function writeFixture(root, format, bytes) {
  fs.mkdirSync(path.join(root, "checks"), { recursive: true });
  const module = Buffer.from(bytes);
  fs.writeFileSync(path.join(root, "checks/module.wasm"), module);
  const hash = sha256(module);
  const row = format === "structured"
    ? `bundle-file path=checks/module.wasm sha256=${hash} bytes=${module.length}\n`
    : `${hash}  ${module.length}  checks/module.wasm\n`;
  const header = format === "structured" ? "fixture-header\n" : "";
  const index = Buffer.from(header + row);
  fs.writeFileSync(path.join(root, "evidence.index"), index);
  fs.writeFileSync(path.join(root, "evidence.index.sha256"), `${sha256(index)}  evidence.index\n`);
  return { prefix: root.slice(0, root.lastIndexOf(".") + 1), format, sha256: hash, bytes: module.length };
}

function expectReject(label, action) {
  let rejected = false;
  try { action(); } catch { rejected = true; }
  if (!rejected) throw new Error(`self-negative accepted: ${label}`);
}

function selfTest() {
  const runId = `selftest-${process.pid}`;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mcweb-0019-module-provenance."));
  try {
    const coldRoot = path.join(base, `cold.${runId}`);
    const perfRoot = path.join(base, `perf.${runId}`);
    const coldSpec = writeFixture(coldRoot, "structured", [0, 97, 115, 109]);
    const perfSpec = writeFixture(perfRoot, "three-column", [0, 97, 115, 109, 1]);
    verifyRoot(coldRoot, runId, coldSpec);
    verifyRoot(perfRoot, runId, perfSpec);
    expectReject("typoed expected hash", () => verifyRoot(coldRoot, runId,
      { ...coldSpec, sha256: "0".repeat(64) }));
    expectReject("stale run root", () => verifyRoot(coldRoot, `${runId}-stale`, coldSpec));
    const perfIndex = path.join(perfRoot, "evidence.index");
    fs.writeFileSync(perfIndex, fs.readFileSync(perfIndex, "utf8").replace(/  5  /, "  4  "));
    const changed = fs.readFileSync(perfIndex);
    fs.writeFileSync(path.join(perfRoot, "evidence.index.sha256"), `${sha256(changed)}  evidence.index\n`);
    expectReject("index payload mismatch", () => verifyRoot(perfRoot, runId, perfSpec));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log("0019-module-provenance-self-negatives typo-sha=reject stale-root=reject payload=reject count=3 result=pass");
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--self-test") {
  selfTest();
} else {
  if (args.length !== 4 || args[2] !== "--run-id" || !/^[0-9]+\.[0-9]+$/.test(args[3])) {
    throw new Error("usage: check-zero-0019-module-provenance.mjs COLD_ROOT PERF_ROOT --run-id EPOCH.PID");
  }
  const production = verifyRoot(args[0], args[3], EXPECTED.production);
  const perf = verifyRoot(args[1], args[3], EXPECTED.perf);
  console.log(`0019-module-provenance production-sha256=${production.sha256}`
    + ` production-bytes=${production.bytes} production-index-sha256=${production.indexSha256}`
    + ` perf-sha256=${perf.sha256} perf-bytes=${perf.bytes}`
    + ` perf-index-sha256=${perf.indexSha256} result=pass`);
}
