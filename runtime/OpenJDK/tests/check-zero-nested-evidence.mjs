#!/usr/bin/env node
// Strict verifier for the two accepted C3a nested-evidence index formats.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [, , evidenceRoot, selfTestFlag, otherRoot] = process.argv;
if (!evidenceRoot) {
  throw new Error("usage: check-zero-nested-evidence.mjs EVIDENCE [--self-test OTHER_EVIDENCE]");
}

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const safeRelative = (relative) => relative.length > 0 && !path.isAbsolute(relative)
  && !relative.split("/").some((part) => part === "" || part === "." || part === "..");

function rowsFrom(root, text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const structured = lines[0] === "m2-c3a-focused-atomic-evidence-v1";
  const rows = [];
  if (structured) {
    const headers = [
      /^m2-c3a-focused-atomic-evidence-v1$/,
      /^accept=m2-c3a-focused-final-0019 exit=0$/,
      /^started-epoch=\d+ finished-epoch=\d+$/,
      /^cold-module-sha=[0-9a-f]{64} cold-wat-sha=[0-9a-f]{64} nested-cold-index-sha=[0-9a-f]{64}$/,
      /^modes=off,linked,forced,root cache=9 rollback=2 collisions=8 aggregate=1 osr=2$/,
      /^linked=direct6,fallback8,events14,calls18,oop6,card6 forced=memory13,null1,calls0,stores0$/,
      /^root=old-array,young-child,clean-to-dirty,young-only,weak-identity$/,
      /^gate-sha=[0-9a-f]{64} manifest-sha=[0-9a-f]{64} runtime-sha=[0-9a-f]{64}$/,
    ];
    if (lines.length <= headers.length) throw new Error("structured index empty");
    headers.forEach((pattern, index) => {
      if (!pattern.test(lines[index])) throw new Error("structured header " + index);
    });
    for (const line of lines.slice(headers.length)) {
      const match = /^bundle-file path=([^ ]+) sha256=([0-9a-f]{64}) bytes=(0|[1-9][0-9]*)$/.exec(line);
      if (!match) throw new Error("structured unknown/mixed row");
      rows.push({relative: match[1], hash: match[2], bytes: Number(match[3])});
    }
  } else {
    for (const line of lines) {
      const match = /^([0-9a-f]{64})  (0|[1-9][0-9]*)  ([^ ]+)$/.exec(line);
      if (!match) throw new Error("three-column unknown/mixed row");
      rows.push({relative: match[3], hash: match[1], bytes: Number(match[2])});
    }
  }
  const relatives = rows.map((row) => row.relative);
  if (new Set(relatives).size !== relatives.length) throw new Error("duplicate path");
  if (relatives.join("\n") !== [...relatives].sort().join("\n")) throw new Error("unsorted paths");
  for (const row of rows) {
    if (!safeRelative(row.relative)) throw new Error("unsafe path");
    const payload = fs.readFileSync(path.join(root, row.relative));
    if (payload.length !== row.bytes || sha256(payload) !== row.hash) {
      throw new Error("payload mismatch " + row.relative);
    }
  }
  return {format: structured ? "structured" : "three-column", rows: rows.length};
}

function verify(root) {
  const index = fs.readFileSync(path.join(root, "evidence.index"));
  const sidecar = fs.readFileSync(path.join(root, "evidence.index.sha256"), "utf8");
  const sidecarMatch = /^([0-9a-f]{64})  evidence\.index\n?$/.exec(sidecar);
  if (!sidecarMatch || sidecarMatch[1] !== sha256(index)) throw new Error("index sidecar");
  return rowsFrom(root, index.toString("utf8"));
}

const result = verify(evidenceRoot);
if (selfTestFlag === "--self-test") {
  if (!otherRoot) throw new Error("self-test other evidence missing");
  const other = verify(otherRoot);
  if (result.format === other.format
      || new Set([result.format, other.format]).size !== 2) {
    throw new Error("self-test requires both accepted formats");
  }
  const structuredRoot = result.format === "structured" ? evidenceRoot : otherRoot;
  const columnRoot = result.format === "three-column" ? evidenceRoot : otherRoot;
  const structuredText = fs.readFileSync(path.join(structuredRoot, "evidence.index"), "utf8");
  const columnText = fs.readFileSync(path.join(columnRoot, "evidence.index"), "utf8");
  const structuredLines = structuredText.trimEnd().split("\n");
  const columnLines = columnText.trimEnd().split("\n");
  const negatives = [
    [structuredRoot, [...structuredLines.slice(0, 8), columnLines[0], ...structuredLines.slice(9)].join("\n") + "\n"],
    [columnRoot, [structuredLines[8], ...columnLines.slice(1)].join("\n") + "\n"],
    [columnRoot, [columnLines[0], columnLines[0], ...columnLines.slice(1)].join("\n") + "\n"],
    [columnRoot, [columnLines[1], columnLines[0], ...columnLines.slice(2)].join("\n") + "\n"],
    [columnRoot, columnText.replace(/  ([^ \n]+)\n/, "  ../$1\n")],
    [columnRoot, "unknown-format\n"],
  ];
  for (const [root, text] of negatives) {
    let rejected = false;
    try { rowsFrom(root, text); } catch { rejected = true; }
    if (!rejected) throw new Error("nested evidence self-negative accepted");
  }
  console.log("C3A_NESTED_EVIDENCE_SELF_NEGATIVES mixed=2 duplicate=1 unsorted=1 traversal=1 unknown=1 count=6 result=pass");
}
console.log(`C3A_NESTED_EVIDENCE format=${result.format} rows=${result.rows} result=pass`);
