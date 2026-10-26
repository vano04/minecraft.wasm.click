#!/usr/bin/env node
// One-process C3a calibration/trusted timing transcript oracle.
import fs from "node:fs";

const [, , logPath, mode = "final"] = process.argv;
if (!logPath || !["final", "diagnostics"].includes(mode)) {
  throw new Error("usage: check-zero-reference-store-group-perf-log.mjs LOG final|diagnostics");
}
const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
const laneName = ["inline", "direct", "indirect"];
const candidateList = [5_000_000, 25_000_000, 50_000_000, 100_000_000, 200_000_000];
const windows = [];
let phase = "before";
let round = -1;
let expectedOrder = null;
let roundLanes = [];
let currentCandidate = -1;
let chosenN = -1;
let pendingElapsed = null;
const candidateStarts = [];
let confirmationMarkerN = -1;

function parseFields(line, prefix) {
  const fields = Object.create(null);
  for (const token of line.slice(prefix.length).split(" ")) {
    const at = token.indexOf("=");
    if (at <= 0 || at === token.length - 1) throw new Error("malformed field");
    const key = token.slice(0, at);
    if (Object.hasOwn(fields, key)) throw new Error("duplicate field " + key);
    fields[key] = token.slice(at + 1);
  }
  return fields;
}

for (const line of lines) {
  if (line.startsWith("PERF_WARMUP_BEGIN ")) phase = "warmup";
  else if (line === "PERF_WARMUP_END windows=30") phase = "between";
  else if (line === "PERF_CALIBRATION_BEGIN candidates=5000000,25000000,50000000,100000000,200000000 triads=5") phase = "calibration";
  else if (line.startsWith("PERF_CANDIDATE_BEGIN n=")) {
    currentCandidate = Number(line.slice("PERF_CANDIDATE_BEGIN n=".length));
    if (!candidateList.includes(currentCandidate)) throw new Error("candidate value");
    candidateStarts.push(currentCandidate);
    phase = "candidate";
  } else if (line.startsWith("PERF_CANDIDATE_END n=")) {
    const match = /^PERF_CANDIDATE_END n=(\d+) windows=3 eligible=([01])$/.exec(line);
    if (!match || Number(match[1]) !== currentCandidate) throw new Error("candidate end");
    const rows = windows.filter((w) => w.phase === "candidate" && w.n === currentCandidate);
    const eligible = rows.length === 3 && rows.every((w) => w.elapsed >= 50_000_000 && w.elapsed <= 250_000_000);
    if (Number(match[2]) !== (eligible ? 1 : 0)) throw new Error("candidate eligibility");
    currentCandidate = -1;
    phase = "calibration";
  } else if (line.startsWith("PERF_CALIBRATION_END ")) {
    const match = /^PERF_CALIBRATION_END chosen=(\d+) smallest-supported=1$/.exec(line);
    if (!match) throw new Error("calibration end");
    chosenN = Number(match[1]);
    phase = "between";
  } else if (line.startsWith("PERF_CONFIRMATIONS_BEGIN ")) {
    const match = /^PERF_CONFIRMATIONS_BEGIN n=(\d+) triads=2 acceptance=0$/.exec(line);
    if (!match) throw new Error("confirmation begin");
    confirmationMarkerN = Number(match[1]);
    phase = "confirmation";
  }
  else if (line === "PERF_CONFIRMATIONS_END windows=6 excluded=1") phase = "between";
  else if (line.startsWith("PERF_TRIADS_BEGIN ")) phase = "timed";
  else if (line === "PERF_TRIADS_END windows=93 sink-consumed=1") phase = "after";
  else if (line === "PERF_DIAGNOSTICS_BEGIN acceptance=0") phase = "diagnostics";
  else if (line === "PERF_SCALING_BEGIN acceptance=0") phase = "scaling";
  else if (line === "PERF_SCALING_END windows=15") phase = "diagnostics";
  else if (line === "PERF_MAP_EDGE_BEGIN acceptance=0 n=1,64,65 lane=direct") phase = "map-edge";
  else if (line === "PERF_MAP_EDGE_END windows=3 result=pass") phase = "diagnostics";
  else if (line === "PERF_AMORTIZATION_UNBATCHED_BEGIN acceptance=0 calls=32 n=1 lane=direct") phase = "unbatched";
  else if (line === "PERF_AMORTIZATION_UNBATCHED_END windows=32") phase = "diagnostics";
  else if (line === "PERF_AMORTIZATION_BATCHED_BEGIN acceptance=0 calls=1 n=32 lane=direct") phase = "batched";
  else if (line === "PERF_AMORTIZATION_BATCHED_END windows=1") phase = "diagnostics";
  else if (line.startsWith("PERF_TRIAD round=")) {
    const match = /^PERF_TRIAD round=(\d+) order=([0-2]),([0-2]),([0-2])$/.exec(line);
    if (!match) throw new Error("triad marker");
    if (round >= 0 && roundLanes.join(",") !== expectedOrder.join(",")) throw new Error("prior round order");
    round = Number(match[1]);
    expectedOrder = match.slice(2).map(Number);
    if (round < 0 || round > 30 || new Set(expectedOrder).size !== 3) throw new Error("round shape");
    roundLanes = [];
  } else if (line.startsWith("[zbp3] PERF_WINDOW ")) {
    if (pendingElapsed !== null) throw new Error("missing elapsed publication");
    const f = parseFields(line, "[zbp3] PERF_WINDOW ");
    const lane = laneName.indexOf(f.lane);
    const n = Number(f.n);
    const elapsed = Number(f["elapsed-ns"]);
    if (lane < 0 || !Number.isSafeInteger(elapsed) || elapsed <= 0
        || f.checksum !== f.oracle || f.span !== "64"
        || f["thread-identity"] !== "1" || f["stack-depth"] !== "2"
        || f["stack-value"] !== "1" || f["pending-cleared"] !== "1"
        || f["card-globals-cleared"] !== "1" || f["elapsed-pending"] !== "1"
        || f.fallback !== "0" || f.trap !== "0" || f.map !== "pass"
        || f.card !== "clean-dirty-clean"
        || f["pages-before"] !== f["pages-after"]
        || f["gc-before"] !== f["gc-after"]
        || f["safepoint-before"] !== f["safepoint-after"]) throw new Error("window invariant " + line);
    const row = {phase, round, lane, n, elapsed, checksum: f.checksum};
    windows.push(row);
    pendingElapsed = row;
    if (phase === "timed") roundLanes.push(lane);
  } else if (line.startsWith("[zbp3] PERF_ELAPSED_RETURN ")) {
    if (pendingElapsed === null) throw new Error("orphan elapsed publication");
    const f = parseFields(line, "[zbp3] PERF_ELAPSED_RETURN ");
    if (Number(f["elapsed-ns"]) !== pendingElapsed.elapsed
        || f["thread-identity"] !== "1" || f["stack-depth"] !== "2"
        || f["stack-value"] !== "1" || f["globals-cleared"] !== "1"
        || f.pending !== "0") throw new Error("elapsed publication invariant");
    pendingElapsed = null;
  }
}
if (pendingElapsed !== null) throw new Error("terminal elapsed publication missing");
const uniqueIndex = (predicate, name) => {
  const found = lines.map((line, index) => predicate(line) ? index : -1).filter((index) => index >= 0);
  if (found.length !== 1) throw new Error(name + " cardinality");
  return found[0];
};
const installIndex = uniqueIndex((line) => line === "[zbp3] PERF_INSTALL_ONLY installed=1 measurement-only=1", "install");
const ageBeginIndex = uniqueIndex((line) => line === "PERF_PREWARMUP_AGE_BEGIN pressure=512 system-gc=1", "age begin");
const ageEndIndex = uniqueIndex((line) => line === "PERF_PREWARMUP_AGE_END array-length=2048 result=pass", "age end");
if (!(installIndex < ageBeginIndex && ageBeginIndex < ageEndIndex)) throw new Error("install/age order");

if (mode === "final") {
  if (!lines.includes("ZERO_REFERENCE_STORE_GROUP_PERF_DONE result=pass")
      || lines.includes("PERF_DIAGNOSTICS_BEGIN acceptance=0")) throw new Error("final terminal/separation");
  const warmup = windows.filter((w) => w.phase === "warmup");
  const candidates = windows.filter((w) => w.phase === "candidate");
  const confirmations = windows.filter((w) => w.phase === "confirmation");
  const timed = windows.filter((w) => w.phase === "timed");
  const warmupBeginIndex = uniqueIndex((line) => line === "PERF_WARMUP_BEGIN lanes=3 iterations=10 n=100000", "warmup begin");
  const doneIndex = uniqueIndex((line) => line === "ZERO_REFERENCE_STORE_GROUP_PERF_DONE result=pass", "perf done");
  const triadsEndIndex = uniqueIndex((line) => line === "PERF_TRIADS_END windows=93 sink-consumed=1", "triads end");
  if (!(ageEndIndex < warmupBeginIndex && triadsEndIndex < doneIndex)
      || candidateStarts.join(",") !== candidateList.join(",")
      || confirmationMarkerN !== chosenN
      || !lines.includes(`PERF_TRIADS_BEGIN seed=0x5eed5eed rounds=31 n=${chosenN}`)
      || warmup.length !== 30 || candidates.length !== 15 || confirmations.length !== 6
      || timed.length !== 93 || round !== 30 || roundLanes.join(",") !== expectedOrder.join(",")) throw new Error("final window counts/order");
  candidateList.forEach((n) => {
    const rows = candidates.filter((w) => w.n === n);
    if (rows.length !== 3 || rows.map((w) => w.lane).join(",") !== "0,1,2") throw new Error("candidate triad " + n);
  });
  const smallest = candidateList.find((n) => candidates.filter((w) => w.n === n)
    .every((w) => w.elapsed >= 50_000_000 && w.elapsed <= 250_000_000));
  if (smallest !== chosenN || confirmations.some((w) => w.n !== chosenN || w.elapsed < 50_000_000 || w.elapsed > 250_000_000)
      || timed.some((w) => w.n !== chosenN || w.elapsed < 50_000_000 || w.elapsed > 250_000_000)) throw new Error("calibrated n/range");
  for (let lane = 0; lane < 3; lane++) {
    if (warmup.filter((w) => w.lane === lane && w.n === 100_000).length !== 10
        || confirmations.filter((w) => w.lane === lane).length !== 2
        || timed.filter((w) => w.lane === lane).length !== 31) throw new Error("lane counts");
  }
  const stats = [];
  for (let lane = 0; lane < 3; lane++) {
    const ordered = timed.filter((w) => w.lane === lane).map((w) => w.elapsed).sort((a, b) => a - b);
    stats.push({sample16: ordered[15], sample30: ordered[29]});
  }
  const medianRatio = stats[1].sample16 / stats[0].sample16;
  const p95Ratio = stats[1].sample30 / stats[0].sample30;
  if (medianRatio > 2.0 || p95Ratio > 2.0) throw new Error("hard GO ratio");
  console.log("phase,round,lane,n,elapsed_ns,checksum");
  for (const w of candidates) console.log(`candidate,-1,${laneName[w.lane]},${w.n},${w.elapsed},${w.checksum}`);
  for (const w of confirmations) console.log(`confirmation,-1,${laneName[w.lane]},${w.n},${w.elapsed},${w.checksum}`);
  for (const w of timed) console.log(`trusted,${w.round},${laneName[w.lane]},${w.n},${w.elapsed},${w.checksum}`);
  console.log(`C3A_PERF_CALIBRATION candidates=5000000,25000000,50000000,100000000,200000000 candidate-windows=15 chosen=${chosenN} smallest-supported=1`);
  console.log(`C3A_PERF_CONFIRMATIONS chosen=${chosenN} triads=2 windows=6 excluded=1 result=pass`);
  console.log("C3A_PERF_COUNTERS warmup=30 candidate=15 confirmation=6 trusted=93 pages-growth=0 gc=0 safepoint=0 fallback=0 trap=0 map=pass card=clean-dirty-clean result=pass");
  console.log(`C3A_PERF_STATS chosen=${chosenN} inline-sample16=${stats[0].sample16} inline-sample30=${stats[0].sample30} direct-sample16=${stats[1].sample16} direct-sample30=${stats[1].sample30} indirect-sample16=${stats[2].sample16} indirect-sample30=${stats[2].sample30} direct-inline-median=${medianRatio.toFixed(6)} direct-inline-p95=${p95Ratio.toFixed(6)} windows=93 confirmations=6 result=GO`);
} else {
  if (!lines.includes("ZERO_REFERENCE_STORE_GROUP_PERF_DIAGNOSTICS result=pass")
      || lines.some((line) => line.startsWith("PERF_TRIADS_BEGIN "))) throw new Error("diagnostic terminal/separation");
  const scaling = windows.filter((w) => w.phase === "scaling");
  const edge = windows.filter((w) => w.phase === "map-edge");
  const unbatched = windows.filter((w) => w.phase === "unbatched");
  const batched = windows.filter((w) => w.phase === "batched");
  if (scaling.length !== 15 || edge.map((w) => w.n).join(",") !== "1,64,65"
      || edge.some((w) => w.lane !== 1) || unbatched.length !== 32
      || unbatched.some((w) => w.lane !== 1 || w.n !== 1)
      || batched.length !== 1 || batched[0].lane !== 1 || batched[0].n !== 32) throw new Error("diagnostic counts");
  const external = unbatched.reduce((sum, w) => sum + w.elapsed, 0);
  console.log(`C3A_PERF_DIAGNOSTICS acceptance=0 scaling=${scaling.length} map-edge=${edge.length} external-total-ns=${external} batched-ns=${batched[0].elapsed} result=reported`);
}
