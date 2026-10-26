#!/usr/bin/env node
// Compare saved evidence only: no browser, game, or GPU process is launched.
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { compareScenes, fingerprintPng } from "./scene-fingerprint.mjs";

function readRun(path) {
  const file = path.endsWith(".json") ? path : join(path, "result.json");
  const run = JSON.parse(readFileSync(file, "utf8"));
  for (const label of ["start", "end"]) {
    const scene = run.sceneEvidence?.[label];
    if (!scene) continue;
    try {
      if (!scene.file || basename(scene.file) !== scene.file) throw Error("unsafe/missing checkpoint filename");
      const image = fingerprintPng(readFileSync(resolve(dirname(file), scene.file)));
      if (JSON.stringify(image) !== JSON.stringify(scene.image)) throw Error("saved PNG does not match recorded decoded image");
    } catch (error) { scene.error = String(error.message); }
  }
  return run;
}
if (process.argv.length !== 4) {
  console.error("usage: node tools/compare-scenes.mjs RUN_A_DIR_OR_JSON RUN_B_DIR_OR_JSON");
  process.exitCode = 2;
} else {
  try {
    const verdict = compareScenes(readRun(process.argv[2]), readRun(process.argv[3]));
    console.log(JSON.stringify(verdict, null, 2));
    if (verdict.status === "inconclusive") process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ status: "inconclusive", reasons: [String(error.message)], performanceVerdict: "inconclusive" }, null, 2));
    process.exitCode = 1;
  }
}
