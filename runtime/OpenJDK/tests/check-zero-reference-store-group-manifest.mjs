#!/usr/bin/env node
// Fail-closed final-0019 pre-run manifest checker. Runtime acceptance belongs
// only to the atomic post-run evidence, never to this static manifest.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [, , root, manifestPath] = process.argv;
if (!root || !manifestPath) {
  throw new Error("usage: check-zero-reference-store-group-manifest.mjs ROOT MANIFEST");
}
const lines = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean);
const values = new Map();
const files = [];
for (const line of lines) {
  const file = line.match(/^file-sha256=([0-9a-f]{64}) path=([^ ]+)$/);
  if (file) {
    files.push({ sha256: file[1], relative: file[2] });
    continue;
  }
  const equals = line.indexOf("=");
  if (equals <= 0) throw new Error("malformed manifest row: " + line);
  const key = line.slice(0, equals);
  if (values.has(key)) throw new Error("duplicate manifest key: " + key);
  values.set(key, line.slice(equals + 1));
}
const expected = new Map([
  ["manifest", "zero-reference-store-group-c3a-v1"],
  ["phase", "final-0019-fresh-run-ready"],
  ["acceptance-target", "FINAL_0019_ATOMIC"],
  ["acceptance-state", "PRE_RUN_READY"],
  ["prior-runtime-evidence", "SUPERSEDED_V8_ACCEPTED"],
  ["runtime-execution-state", "EXECUTED_ACCEPTED_V8_REQUIRES_FRESH_V9"],
  ["package-phase", "0019-final-suite-wired"],
  ["package-state", "READY_FOR_FRESH_FINAL_RUN"],
  ["runtime-status", "fresh-built"],
  ["module-status", "fresh-dumped"],
  ["members", "leaf:2ab0,relay:leaf,commit:2a1b2c532cb0,entry:2a1b2cb8??b8??b0"],
  ["entry-bcis", "entry:0,relay:3,commit:6,return:9"],
  ["edges", "entry>relay,relay>leaf,entry>commit"],
  ["wasm-shape", "funcs4,exports1,private3,tableSlots1,privateSlots0"],
  ["cache-mutations", "compiler,digest,bytes,memory,metadata,slot,card-layout,group-edges,poison"],
  ["cache-rollback-selftests", "selftest-fresh-false,selftest-fresh-throw"],
  ["cache-reject-cleanup-self-negative", "owned41-expected17-callable-rejected"],
  ["card-shift", "9"],
  ["patch0019-sha256", "983ed617633fbf9b2635a3a175dfbf96850c72412388f3fb6474e9364e935905"],
  ["setup0019-sha256", "28a0e97b7dec05b61eb4204c6acdd61613cd314b0e5d240f9a0db1104346d7c2"],
  ["boundary0019-sha256", "2469f814f314fe7a90d7160879417a549c6599e46f19b012d78130ba9de95e73"],
  ["perf-gate-sha256", "c3f08cd7d19479dfe2dfa1d6a2641fa1f1c66c4f8e966ca7a827a158fbf68fdc"],
  ["perf-publication-gate-sha256", "189621977e80313d199376deb4abacedd4116a81fc418e2745ca1c7fbbce9aa9"],
  ["perf-log-checker-sha256", "cf8b0a9bf3c0f8cf12fc69bff9e4049f18fb7e93e3c906142cc1a924b6fe4c6e"],
  ["perf-nested-checker-sha256", "16e8fcda12969331013a36d1e7e59ed765581c9fa39ba2b8f238b74732fc9a51"],
  ["perf-source-checker-sha256", "7a8af382906077be03adde6721a19b6268db7a8bedd37b2b1c8fd2b0be492e4f"],
  ["provenance0019-sha256", "4867c4d6910ebf17783c83640ab0547f08230e501c0b2e5e2ddd7dbe783e30cf"],
  ["legacy-helper0018-sha256", "98210162e613050c97e02d881be392b022e6cb04710d7c144698d9d32d70a310"],
  ["legacy-m2a-gate-sha256", "b813e0af5dc645ab4d11aaa29b83ceceb68460bbbade802f719f8f750d38fe1c"],
  ["legacy-m2b-gate-sha256", "3106c47100cef41fbfeb8e0812993c4aff2a35eaff8c86741e788fc6de0471e0"],
  ["legacy-p1-gate-sha256", "5e878dcc641ea06eaf0b8bd801b57568cc9be26f5280f7cbd5b51a5adf26550d"],
  ["legacy-suite0019-sha256", "5277fa1fef8b3fa84f95fdc1d267a33069287ab584c62573f5874de629c900cd"],
  ["final-suite0019-sha256", "0cdf32769f697611f1b410b1e3c7398b142f531051af43d59118ea1b273dff64"],
  ["module-provenance-checker-sha256", "6d69546ddc3df88fa736c23cb77419d5cf27705a5de2fe3b05692ca18904d8d0"],
  ["c1-gate-sha256", "f544ad387fc01de409d84d355f2f6055f668b0b221d092614972fbca5766ae4d"],
  ["c1-manifest-sha256", "cfe441f1d451eda3913ff0e6d9b1eff3e36b080fc186e032b872dc59505a4251"],
  ["c2-gate-sha256", "b20239aa793e439a4e285844f48af69aba9b93b7c11871c2d979cca42b428eda"],
  ["c2-manifest-sha256", "03faf9f568a40459ea14c69fecc3e4088784841432f30f7993d14745c360d094"],
  ["generated-class-sha256", "e95bf022ddd3a9c47e24dd06698fb8b4edde18b2fd96bdbddcb74c35410e2a5f"],
  ["generated-near-class-sha256", "e6d32e74edc08c2022bf3b9f8f775bff6779b15218cb2330150d4a383ad12006"],
  ["generated-probe-class-sha256", "6532d033598f32535350f121699212e24f966b362157cfe8788b7321a334c6b1"],
  ["generated-card-helper-class-sha256", "409e29a6727e189b9870bdac4ec470a02528420d6422d871cf7153345075ba51"],
  ["generated-card-helper-near-class-sha256", "c17577d5d336dfc34ff7dd1e1456bfd9029105947cf524630cd2bc118370fa05"],
  ["generated-fixture-jar-sha256", "a0e30d1d287c9da1940b4468836a1fa3e19306aa1a62cf2640f360e4593894f6"],
  ["generated-module-sha256", "9b9ab39a8cef7afc616dadc42881ab7ef4d4390ef0f7506a705daeebf0259107"],
  ["generated-wat-sha256", "b9e261d479bb90eb5226f1226da1e90b7e3f51ae97b44f1d2d5b171858fecf2e"],
  ["generated-runtime-sha256", "ab1f8ae6fc79d5e376f755f2196191078bbd347e73663a92d6ef530819496a6a"]
]);
const acceptanceGuard = (candidate) => {
  if (candidate.get("acceptance-state") !== "PRE_RUN_READY") {
    throw new Error("static manifest may not claim runtime ACCEPT");
  }
  if (candidate.get("runtime-status") !== "fresh-built"
      || candidate.get("module-status") !== "fresh-dumped") {
    throw new Error("stale runtime/module state");
  }
  for (const key of ["generated-class-sha256", "generated-module-sha256",
    "generated-wat-sha256", "generated-runtime-sha256"]) {
    const value = candidate.get(key);
    if (!/^[0-9a-f]{64}$/.test(value ?? "")) {
      throw new Error("generated placeholder: " + key);
    }
  }
};
acceptanceGuard(values);
for (const [key, value] of expected) {
  if (values.get(key) !== value) throw new Error(`manifest ${key}=${values.get(key)}`);
}
if (files.length !== 40 || new Set(files.map(({ relative }) => relative)).size !== 40) {
  throw new Error("manifest file closure=" + files.length);
}
for (const { sha256, relative } of files) {
  if (path.isAbsolute(relative) || relative.split("/").includes("..")) {
    throw new Error("unsafe manifest path=" + relative);
  }
  const bytes = fs.readFileSync(path.join(root, relative));
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) throw new Error(`manifest stale path=${relative}`);
}
if (process.argv[4] === "--self-test-stale-runtime") {
  const rejects = (candidate, pattern) => {
    try { acceptanceGuard(candidate); }
    catch (error) { return pattern.test(error.message); }
    return false;
  };
  const staticAccept = new Map(values);
  staticAccept.set("acceptance-state", "ACCEPTED");
  if (!rejects(staticAccept, /may not claim runtime ACCEPT/)) {
    throw new Error("static-accept self-negative accepted");
  }
  const staleRuntime = new Map(values);
  staleRuntime.set("runtime-status", "stale-unbuilt");
  staleRuntime.set("module-status", "not-dumped");
  if (!rejects(staleRuntime, /stale runtime\/module/)) {
    throw new Error("stale-runtime self-negative accepted");
  }
  const placeholder = new Map(values);
  placeholder.set("generated-runtime-sha256", "WIP_UNBUILT");
  if (!rejects(placeholder, /generated placeholder/)) {
    throw new Error("generated-placeholder self-negative accepted");
  }
  console.log("reference-store-group-manifest-self-negatives=pass"
    + " static-accept=reject stale-runtime=reject generated-placeholders=reject count=3");
}
console.log("reference-store-group-manifest=pass phase=final-0019-fresh-run-ready"
  + " acceptance-target=FINAL_0019_ATOMIC acceptance-state=PRE_RUN_READY"
  + " prior-runtime-evidence=SUPERSEDED_V8_ACCEPTED package=0019-final-suite-wired"
  + " files=40 generated-placeholders=0 runtime=fresh-built module=fresh-dumped");
