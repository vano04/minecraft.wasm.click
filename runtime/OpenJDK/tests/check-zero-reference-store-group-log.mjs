#!/usr/bin/env node
// Strict transcript checker for the focused M2-C3a reference-store group.
import fs from "node:fs";

const fatalPatterns = [
  /ReferenceError|TypeError|RangeError|SyntaxError/,
  /uncaught|UnhandledPromiseRejection|Pthread.*error/i,
  /Broken pipe|SIGPIPE|hs_err|fatal error|Internal Error/,
  /CALL MISMATCH|unexpected status|publication invariant failed/,
  /JS_CACHE_CLEANUP_UNSUPPORTED/
];
const cacheMutations = ["compiler", "digest", "bytes", "memory", "metadata",
  "slot", "card-layout", "group-edges", "poison"];
const collisionLanes = ["group", "int-load", "int-store", "benchmark",
  "ref-load", "ref-store", "baseline", "jit"];
const collisionMarker = /^\[zbg\] REFERENCE_STORE_GROUP_REJECT reason=flag-collision group=([01]) int-load=([01]) int-store=([01]) benchmark=([01]) ref-load=([01]) ref-store=([01]) reference-store-group=1 baseline=([01]) jit=([01])$/;
const checkCollisionVector = (line, expectedLane) => {
  const expected = expectedLane.split(",");
  if (!expected.length || expected.some((lane) => !collisionLanes.includes(lane))) {
    throw new Error("collision lane detail");
  }
  const match = line.match(collisionMarker);
  if (!match) throw new Error("collision marker ordered shape");
  const enabled = collisionLanes.filter((lane, index) => match[index + 1] === "1");
  if (enabled.join(",") !== expected.join(",")) {
    throw new Error("collision vector=" + enabled.join(","));
  }
};
const orderedIndexes = (indexes, label) => {
  for (let i = 1; i < indexes.length; i++) {
    if (indexes[i - 1] >= indexes[i]) throw new Error(label + " order");
  }
};
const cleanupProven = ({ empty, recordPresent, callableBefore, removed,
                         callableAfter, expectedProbeComplete,
                         expectedCallableAfter }) => empty
    && (!recordPresent || (callableBefore && removed && !callableAfter))
    && expectedProbeComplete && !expectedCallableAfter;
const simulatedPresentRecordCleanup = ({ ownedSlot, expectedSlot,
                                          callableAtExpectedAfter }) =>
  cleanupProven({
    empty: true, recordPresent: true, callableBefore: true, removed: true,
    callableAfter: false, expectedProbeComplete: true,
    expectedCallableAfter: expectedSlot === ownedSlot
        ? false : callableAtExpectedAfter
  });
const cacheSlotIdentity = ({ mutation, originalOwnedSlot,
                             invalidationExpectedSlot,
                             invalidationOwnedSlot, passOldSlot,
                             passOldOwnedSlot, freshSlot, slotReused }) => {
  const owned = Number(originalOwnedSlot);
  const expected = mutation === "slot" ? owned + 1 : owned;
  return Number(invalidationExpectedSlot) === expected
      && Number(invalidationOwnedSlot) === owned
      && Number(passOldSlot) === expected
      && Number(passOldOwnedSlot) === owned
      && Number(freshSlot) === owned
      && slotReused === (mutation === "slot" ? "0" : "1");
};
if (process.argv[2] === "--self-test") {
  if (cacheMutations.length !== 9 || new Set(cacheMutations).size !== 9) {
    throw new Error("cache mutation self-test accounting");
  }
  orderedIndexes([1, 2, 3, 4], "valid transcript self-test");
  let rejected = false;
  try { orderedIndexes([1, 3, 2, 4], "reordered transcript self-test"); }
  catch (error) { rejected = /order/.test(error.message); }
  const validCollision = "[zbg] REFERENCE_STORE_GROUP_REJECT reason=flag-collision"
    + " group=0 int-load=0 int-store=0 benchmark=0 ref-load=0 ref-store=0"
    + " reference-store-group=1 baseline=0 jit=1";
  checkCollisionVector(validCollision, "jit");
  for (const malformed of [
    validCollision.replace(" group=0 int-load=0", " int-load=0 group=0"),
    validCollision.replace(" baseline=0", ""),
    validCollision + " extra=0"
  ]) {
    let malformedRejected = false;
    try { checkCollisionVector(malformed, "jit"); }
    catch (error) { malformedRejected = true; }
    if (!malformedRejected) throw new Error("collision near-miss accepted");
  }
  const sharedPostRemoval = simulatedPresentRecordCleanup({
    ownedSlot: 41, expectedSlot: 41, callableAtExpectedAfter: false
  });
  const mismatchedExpectedStillCallable = simulatedPresentRecordCleanup({
    ownedSlot: 41, expectedSlot: 17, callableAtExpectedAfter: true
  });
  if (!sharedPostRemoval || mismatchedExpectedStillCallable) {
    throw new Error("mismatched expected-slot cleanup proof self-negative");
  }
  const validSlot = {
    mutation: "slot", originalOwnedSlot: 41,
    invalidationExpectedSlot: 42, invalidationOwnedSlot: 41,
    passOldSlot: 42, passOldOwnedSlot: 41, freshSlot: 41, slotReused: "0"
  };
  const validNonSlot = { ...validSlot, mutation: "digest",
    invalidationExpectedSlot: 41, passOldSlot: 41, slotReused: "1" };
  const slotRemovesCorrupted = { ...validSlot, invalidationOwnedSlot: 42 };
  const slotHidesOwned = { ...validSlot, passOldOwnedSlot: 42 };
  const slotClaimsReused = { ...validSlot, slotReused: "1" };
  const nonSlotMismatch = { ...validNonSlot, invalidationExpectedSlot: 42 };
  if (!cacheSlotIdentity(validSlot) || !cacheSlotIdentity(validNonSlot)
      || cacheSlotIdentity(slotRemovesCorrupted)
      || cacheSlotIdentity(slotHidesOwned)
      || cacheSlotIdentity(slotClaimsReused)
      || cacheSlotIdentity(nonSlotMismatch)) {
    throw new Error("cache slot identity self-negatives");
  }
  if (!rejected || !fatalPatterns.some((pattern) => pattern.test("ReferenceError"))) {
    throw new Error("log checker self-negative");
  }
  console.log("reference-store-group-log-self-negatives=pass"
    + " reordered=1 fatal-js=1 cache-mutations=9 collision-shape=3"
    + " mismatched-expected-slot-callable=1 cache-slot-identity=4");
  process.exit(0);
}

const [, , logPath, mode, expectedDetail] = process.argv;
if (!logPath || !mode) {
  throw new Error("usage: check-zero-reference-store-group-log.mjs LOG MODE [DETAIL]");
}
const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
const fail = (message) => { throw new Error(message); };
const matching = (pattern) => lines.filter((line) => pattern.test(line));
const exactly = (pattern, count, label) => {
  const found = matching(pattern);
  if (found.length !== count) fail(`${label} count=${found.length} expected=${count}`);
  return found;
};
const absent = (pattern, label) => {
  const found = matching(pattern);
  if (found.length) fail(`${label} present: ${found[0]}`);
};
const lineIndex = (line) => {
  const index = lines.indexOf(line);
  if (index < 0) fail("missing transcript line");
  return index;
};
let successDetail = "";

for (const pattern of fatalPatterns) {
  absent(pattern, "fatal diagnostic");
}
absent(/^\[zbg\] REF_ARRAY_REJECT reason=flag-collision /,
       "foreign collision diagnostic");
absent(/^\[zbg\] REFERENCE_STORE_GROUP_CLASSIFY /,
       "unexplained classifier rejection");

const install = /^\[zbg\] JS_INSTALL reference-store-group funcs=4 exports=1 private=3 table-slots=1 private-slots=0 id=(\d+) slot=(\d+) bytes=(\d+) compiler=zero-baseline-abi-v1 digest=([0-9a-f]{16}) memory=shared max-pages=65536 card-layout=(.+) group-edges=(.+)$/;
const hit = /^\[zbg\] JS_CACHE_HIT reference-store-group id=(\d+) slot=(\d+) instance-reused=1 memory-reused=1 compiler=zero-baseline-abi-v1 digest=([0-9a-f]{16}) bytes-exact=1 card-layout-exact=1 group-edges-exact=1 export-match=1$/;
const moduleKey = /^\[zbg\] REFERENCE_STORE_GROUP_MODULE_KEY abi=groupedReferenceStore:\(Object\[\],int,Object\)->Object wasm=\(i32,i32,i32,i32,i32,i32\)->i64 funcs=4 exports=1 private=3 table-slots=1 private-slots=0 slot=(\d+) direct-edges=entry>relay,relay>leaf,entry>commit collector=serial raw32=1 length-offset=(\d+) base-offset=(\d+) element-size=4 card-base=(\d+) card-shift=(\d+) clean-card=(\d+) dirty-card=(\d+) bytes=(\d+)$/;
const enter = /^\[zbg\] REFERENCE_STORE_GROUP_ENTER seq=(\d+) method=groupedReferenceStore entry-bci=0 relay-bci=3 commit-bci=6 return-bci=9 array-bits=(\d+) index=(-?\d+) value-bits=(\d+) length=(-?\d+) limit-pages=(-?\d+) card-base=(\d+) assignable=([01]) slot=(\d+)$/;
const status = /^\[zbg\] REFERENCE_STORE_GROUP_STATUS seq=(\d+) status=(\d+) bci=(\d+) result-oop-bits=(\d+)$/;
const returned = /^\[zbg\] REFERENCE_STORE_GROUP_EXIT seq=(\d+) status=RETURN bci=0 funcs=4 exports=1 private=3 table-slots=1 private-slots=0 internal-direct-calls=3 oop-stores=1 card-stores=1 card-after-dirty=1$/;
const notRun = /^\[zbg\] REFERENCE_STORE_GROUP_EXIT seq=(\d+) status=NOT_RUN bci=0 reason=(null|memory|bounds|assignability|memory-or-card) frame-untouched=1 commit-bci3-resume=0$/;
const invalidated = /^\[zbg\] JS_CACHE_INVALIDATE reference-store-group slot=(\d+) old-id=(\d+) owned-slot=(\d+) removed=1 old-callable=1 export-match=([01]) old-callable-after=0 poisoning=([01]) poison-visible=([01]) old-export-visible=([01]) poison-removed=1 poison-callable-after=0 instance-cleared=1 cache-cleared=1 last-instance-cleared=1$/;
const mutationPass = /^\[zbg\] JS_CACHE_MUTATION_PASS reference-store-group mutation=([^ ]+) miss=-1 old-id=(\d+) new-id=(\d+) old-slot=(\d+) new-slot=(\d+) old-owned-slot=(\d+) slot-reused=([01]) export-match=([01]) poisoning=([01]) poison-visible=([01]) old-export-visible=([01]) poison-removed=1 poison-callable-after=0 old-callable-after=0 removed=1 instance-reused=0 cache-cleared=1 last-instance-cleared=1 bytes-exact=1 card-layout-exact=1 group-edges-exact=1$/;
const freshReject = /^\[zbg\] JS_CACHE_FRESH_REJECT reference-store-group fresh-id=(\d+) validation=(selftest-fresh-(?:false|throw)) fresh-slot=(\d+) removed=1 callable-before=1 callable-after=0 cleanup-proven=1 metadata-cleared=1 last-instance-cleared=1$/;
const rejectCleanup = /^\[zbg\] JS_CACHE_REJECT_CLEANUP reference-store-group expected-id=(\d+) expected-slot=(\d+) record-present=0 owned-slot=-1 removed=0 callable-before=0 callable-after=0 expected-probe=1 expected-callable-after=0 cache-empty=1 cpp-slot=-1 proven=1$/;

function bindInstall() {
  const firstLine = exactly(install, 1, "install")[0];
  const first = firstLine.match(install);
  const hitLines = matching(hit);
  const hits = hitLines;
  if (!hits.length) fail("cache hit missing");
  const firstHit = hitLines[0].match(hit);
  const keyLine = exactly(moduleKey, 1, "module key")[0];
  const key = keyLine.match(moduleKey);
  if (first[1] !== firstHit[1] || first[2] !== firstHit[2]
      || first[2] !== key[1] || first[4] !== firstHit[3]
      || first[3] !== key[8]) {
    fail("install/hit/module key identity mismatch");
  }
  orderedIndexes([lineIndex(firstLine), lineIndex(hitLines[0]), lineIndex(keyLine)],
                 "install/hit/module");
}

function bindEntries(expected, expectedReturns, expectedMisses) {
  const enterLines = exactly(enter, expected, "entry");
  const statusLines = exactly(status, expected, "status");
  const returnLines = exactly(returned, expectedReturns, "return exit");
  const missLines = exactly(notRun, expectedMisses, "NotRun exit");
  const enters = enterLines.map((line) => line.match(enter));
  const statuses = statusLines.map((line) => line.match(status));
  const returns = returnLines.map((line) => line.match(returned));
  const misses = missLines.map((line) => line.match(notRun));
  for (let i = 0; i < expected; i++) {
    const seq = String(i + 1);
    if (enters[i][1] !== seq || statuses[i][1] !== seq) {
      fail("entry/status sequence mismatch at " + seq);
    }
    const exitLine = [...returnLines, ...missLines].find((line) => {
      const match = line.match(returned) || line.match(notRun);
      return match && match[1] === seq;
    });
    if (!exitLine) fail("exit missing for sequence " + seq);
    orderedIndexes([lineIndex(enterLines[i]), lineIndex(statusLines[i]),
                    lineIndex(exitLine)], "entry/status/exit seq=" + seq);
    if (i > 0) {
      const previousExit = [...returnLines, ...missLines].find((line) => {
        const match = line.match(returned) || line.match(notRun);
        return match && match[1] === String(i);
      });
      orderedIndexes([lineIndex(previousExit), lineIndex(enterLines[i])],
                     "non-overlap seq=" + seq);
    }
  }
  const exitSeqs = new Set([...returns, ...misses].map((match) => match[1]));
  if (exitSeqs.size !== expected) fail("exit sequence coverage=" + exitSeqs.size);
  for (const match of returns) {
    const state = statuses[Number(match[1]) - 1];
    if (state[2] !== "0" || state[3] !== "0") fail("return status mismatch");
  }
  for (const match of misses) {
    const state = statuses[Number(match[1]) - 1];
    if (state[2] !== "3" || state[3] !== "0") fail("NotRun status mismatch");
  }
  return { enters, returns, misses };
}

switch (mode) {
  case "off":
    exactly(/^reference-store-group direct=6 reexec=8 reject-array-unchanged=8 result=pass$/, 1,
            "off terminal matrix");
    absent(/REFERENCE_STORE_GROUP_(?:MODULE_KEY|ENTER|STATUS|EXIT|CARD_PROBE)|JS_(?:INSTALL|CACHE_HIT) reference-store-group/,
           "off linked execution");
    break;
  case "linked": {
    exactly(/^reference-store-group direct=6 reexec=8 reject-array-unchanged=8 result=pass$/, 1,
            "terminal matrix");
    bindInstall();
    const transcript = bindEntries(14, 6, 8);
    const reasons = transcript.misses.map((match) => match[2]);
    if (reasons.filter((reason) => reason === "null").length !== 1
        || reasons.filter((reason) => reason === "bounds").length !== 5
        || reasons.filter((reason) => reason === "assignability").length !== 2) {
      fail("linked reason matrix=" + reasons.join(","));
    }
    successDetail = " direct=6 fallback=8 internal-direct-calls=18"
      + " oop-stores=6 card-stores=6 unchanged-rejects=8";
    break;
  }
  case "root": {
    exactly(/^reference-store-group-root identity=1 array-identity=1 weak=1$/, 1,
            "root identity");
    bindInstall();
    bindEntries(1, 1, 0);
    const setupPattern = /^\[zbg\] REF_ARRAY_STORE_CARD_PROBE_SETUP array-bits=\d+ card-address=\d+ length=2048 index=1024 array-old=1 all-null=1 card-clean=1 span-kind=1 prepared=1 pending=1$/;
    const postPattern = /^\[zbg\] REFERENCE_STORE_GROUP_CARD_PROBE seq=1 array-old=1 child-young=1 card-clean-before=1 card-dirty-after=1 span-kind=1 pending=0$/;
    const setup = exactly(setupPattern, 1, "root setup")[0];
    const post = exactly(postPattern, 1, "root post-card")[0];
    const preBegin = lines.indexOf("GROUP_ROOT_PRE_STORE_GC_BEGIN");
    const preEnd = lines.indexOf("GROUP_ROOT_PRE_STORE_GC_END");
    const caseBegin = lines.indexOf("CASE_BEGIN group-root-liveness");
    const caseEnd = lines.indexOf("CASE_END group-root-liveness");
    const postBegin = lines.indexOf("GROUP_ROOT_POST_STORE_YOUNG_BEGIN");
    const postEnd = lines.indexOf("GROUP_ROOT_POST_STORE_YOUNG_END");
    const identity = lines.indexOf("reference-store-group-root identity=1 array-identity=1 weak=1");
    const enterLine = exactly(enter, 1, "root enter")[0];
    const statusLine = exactly(status, 1, "root status")[0];
    const exitLine = exactly(returned, 1, "root exit")[0];
    orderedIndexes([preBegin, preEnd, lineIndex(setup), caseBegin,
      lineIndex(enterLine), lineIndex(statusLine), lineIndex(exitLine),
      lineIndex(post), caseEnd, postBegin, postEnd, identity], "root exact transcript");
    const preWindow = lines.slice(preBegin, preEnd + 1);
    const postWindow = lines.slice(postBegin, postEnd + 1);
    if (!preWindow.some((line) => /Pause (?:Full|Young) /.test(line))
        || postWindow.some((line) => /Pause Full /.test(line))
        || !postWindow.some((line) => /Pause Young /.test(line))) {
      fail("root Young-only GC proof");
    }
    break;
  }
  case "forced": {
    exactly(/^reference-store-group direct=6 reexec=8 reject-array-unchanged=8 result=pass$/, 1,
            "terminal matrix");
    bindInstall();
    const transcript = bindEntries(14, 0, 14);
    const reasons = transcript.misses.map((match) => match[2]);
    if (reasons.filter((reason) => reason === "null").length !== 1
        || reasons.filter((reason) => reason === "memory").length !== 13) {
      fail("forced reason matrix=" + reasons.join(","));
    }
    break;
  }
  case "single":
    exactly(/^reference-store-group-single result=pass$/, 1, "terminal single");
    bindInstall();
    bindEntries(1, 1, 0);
    break;
  case "cache": {
    if (!cacheMutations.includes(expectedDetail)) fail("cache mutation detail invalid");
    exactly(/^reference-store-group-single result=pass$/, 1, "terminal single");
    const installLines = exactly(install, 2, "cache installs");
    const hitLine = exactly(hit, 1, "cache initial hit")[0];
    const invalidationLine = exactly(invalidated, 1, "cache invalidation")[0];
    const passLine = exactly(mutationPass, 1, "cache mutation pass")[0];
    const keyLine = exactly(moduleKey, 1, "cache module key")[0];
    const oldInstall = installLines[0].match(install);
    const freshInstall = installLines[1].match(install);
    const initialHit = hitLine.match(hit);
    const invalidation = invalidationLine.match(invalidated);
    const pass = passLine.match(mutationPass);
    const key = keyLine.match(moduleKey);
    const slotsProven = cacheSlotIdentity({
      mutation: expectedDetail, originalOwnedSlot: oldInstall[2],
      invalidationExpectedSlot: invalidation[1],
      invalidationOwnedSlot: invalidation[3], passOldSlot: pass[4],
      passOldOwnedSlot: pass[6], freshSlot: freshInstall[2],
      slotReused: pass[7]
    });
    if (pass[1] !== expectedDetail || oldInstall[1] !== initialHit[1]
        || oldInstall[2] !== initialHit[2] || oldInstall[1] !== invalidation[2]
        || !slotsProven
        || pass[2] !== oldInstall[1] || pass[3] !== freshInstall[1]
        || pass[5] !== freshInstall[2] || key[1] !== freshInstall[2]
        || key[8] !== freshInstall[3]) {
      fail("cache transaction identity mismatch");
    }
    const poison = expectedDetail === "poison";
    if ((invalidation[4] === "1") === poison
        || (invalidation[5] === "1") !== poison
        || (invalidation[6] === "1") !== poison
        || (invalidation[7] === "1") === poison
        || (pass[8] === "1") === poison || (pass[9] === "1") !== poison
        || (pass[10] === "1") !== poison || (pass[11] === "1") === poison) {
      fail("cache poison/non-poison proof mismatch");
    }
    orderedIndexes(installLines.map(lineIndex).slice(0, 1)
      .concat(lineIndex(hitLine), lineIndex(invalidationLine),
              lineIndex(installLines[1]), lineIndex(passLine), lineIndex(keyLine)),
      "cache install/hit/invalidate/reinstall/pass");
    bindEntries(1, 1, 0);
    break;
  }
  case "selftest":
    if (!expectedDetail || !/^selftest-fresh-(?:false|throw)$/.test(expectedDetail)) {
      fail("selftest detail");
    }
    const installLines = exactly(install, 2, "selftest installs");
    const hitLine = exactly(hit, 1, "selftest initial hit")[0];
    const invalidationLine = exactly(invalidated, 1, "selftest invalidation")[0];
    const rejectLine = exactly(freshReject, 1, "fresh rollback")[0];
    const cleanupLine = exactly(rejectCleanup, 1, "C++ rejection cleanup proof")[0];
    if (rejectLine.match(freshReject)[2] !== expectedDetail) fail("wrong rollback mode");
    const cleanup = cleanupLine.match(rejectCleanup);
    const oldInstall = installLines[0].match(install);
    if (cleanup[1] !== oldInstall[1] || cleanup[2] !== oldInstall[2]) {
      fail("rollback cleanup expected identity mismatch");
    }
    orderedIndexes([lineIndex(installLines[0]), lineIndex(hitLine),
                    lineIndex(invalidationLine), lineIndex(installLines[1]),
                    lineIndex(rejectLine), lineIndex(cleanupLine)],
                   "selftest rollback transcript");
    absent(/^\[zbg\] JS_CACHE_MUTATION_PASS reference-store-group /,
           "selftest mutation pass");
    break;
  case "collision":
    exactly(/^reference-store-group direct=6 reexec=8 reject-array-unchanged=8 result=pass$/, 1,
            "terminal matrix");
    checkCollisionVector(exactly(collisionMarker, 1, "collision marker")[0],
                         expectedDetail);
    absent(/REFERENCE_STORE_GROUP_(?:MODULE_KEY|ENTER|STATUS|EXIT)|JS_INSTALL reference-store-group/,
           "collision execution");
    break;
  case "near-miss":
    exactly(/^reference-store-group-near-miss owner=1 result=pass$/, 1,
            "near-miss terminal");
    absent(/REFERENCE_STORE_GROUP_(?:MODULE_KEY|ENTER|STATUS|EXIT)|JS_INSTALL reference-store-group/,
           "near-miss execution");
    break;
  case "osr":
    exactly(/^reference-store-group-osr checksum=512 result=pass$/, 1, "OSR terminal");
    checkCollisionVector(exactly(collisionMarker, 1, "OSR collision marker")[0],
                         expectedDetail);
    absent(/REFERENCE_STORE_GROUP_(?:MODULE_KEY|ENTER|STATUS|EXIT)|JS_INSTALL reference-store-group|JIT_COMPILE|OSR_COMPILE/,
           "OSR collision execution");
    break;
  default:
    fail("unknown mode " + mode);
}

console.log(`reference-store-group-log=pass mode=${mode}`
  + (expectedDetail ? ` detail=${expectedDetail}` : "") + successDetail);
