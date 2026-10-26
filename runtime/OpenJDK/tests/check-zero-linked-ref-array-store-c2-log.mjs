#!/usr/bin/env node
// Ordered transcript checker for the isolated M2-C2 checked Object[] store.
// Java's interpreter remains the semantic oracle: only valid direct stores
// may return from the linked lane; every guard/assignability miss must resume
// the original aastore at BCI 3.
import fs from "node:fs";

const argv = process.argv;
if (!argv[2]) throw new Error("usage: check-zero-linked-ref-array-store-c2-log.mjs LOG MODE");
const logPath = argv[2];
const mode = argv[3] || "linked";
const expectedMutation = argv[4] || null;
const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
const uncaughtJsDiagnostic = lines.find((line) =>
  /\b(?:ReferenceError|TypeError|RangeError|SyntaxError)\b/i.test(line)
  || /captured an uncaught exception/i.test(line)
  || /^\s*worker\b.*\buncaught\b/i.test(line)
  || /^\s*Pthread\b.*\bsent an error!/i.test(line));
if (uncaughtJsDiagnostic) {
  throw new Error("uncaught JS runtime diagnostic: " + uncaughtJsDiagnostic);
}
const linkedMarker = /(REF_ARRAY_STORE_(?:CLASSIFY|ENTER|ADAPTER|TABLE_CALL|STATUS|EXIT|OPCODE_REEXECUTE)|DIRECT_REF_STORE)/;
const eventMarker = /(REF_ARRAY_STORE_(?:ENTER|ADAPTER|TABLE_CALL|STATUS|EXIT|OPCODE_REEXECUTE)|DIRECT_REF_STORE|INTERPRETER_AASTORE)/;

function summary() {
  const line = lines.find((value) => value.startsWith("ref-array-store direct-first="));
  if (!line) throw new Error("fixture summary missing");
  const fields = [
    "direct-first=1", "direct-middle=1", "direct-last=1", "subclass=1",
    "interface=1", "covariant-array=1", "null-value=1", "null-npe=1",
    "negative-aioobe=1", "length-aioobe=1", "min-index-aioobe=1",
    "empty-aioobe=1", "bounds-ase-aioobe=1", "string-ase=1", "number-ase=1",
    "reject-array-unchanged=1",
  ];
  for (const field of fields) if (!line.includes(field)) throw new Error("summary " + field);
  if (!lines.includes("reject-array-unchanged=1")) {
    throw new Error("reject-array-unchanged marker missing");
  }
}

function cases() {
  const result = new Map();
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const begin = lines[i].match(/^CASE_BEGIN (.+)$/);
    const end = lines[i].match(/^CASE_END (.+)$/);
    if (begin) {
      if (current || result.has(begin[1])) throw new Error("bad case begin " + begin[1]);
      current = { name: begin[1], lines: [] };
      result.set(begin[1], current);
    } else if (end) {
      if (!current || current.name !== end[1]) throw new Error("bad case end " + end[1]);
      current = null;
    } else if (current) {
      current.lines.push({ text: lines[i], lineIndex: i });
    }
  }
  if (current) throw new Error("unterminated case " + current.name);
  return result;
}

function one(records, expression, label) {
  const found = records.filter((record) => expression.test(record.text));
  if (found.length !== 1) throw new Error(label + " count=" + found.length);
  return found[0];
}

function order(records, label) {
  for (let i = 1; i < records.length; i++) {
    if (records[i - 1].lineIndex >= records[i].lineIndex) throw new Error(label + " order");
  }
}

function cacheEvidence() {
  const allowedMutations = new Set([
    "compiler", "digest", "bytes", "memory", "metadata", "slot",
    "card-layout", "poison",
  ]);
  if (expectedMutation && !allowedMutations.has(expectedMutation)) {
    throw new Error("unknown expected cache mutation=" + expectedMutation);
  }
  const indexed = lines.map((text, lineIndex) => ({ text, lineIndex }));
  const installs = indexed.filter((record) => /^\[zbg\] JS_INSTALL ref-array-store /.test(record.text));
  const hits = indexed.filter((record) => /^\[zbg\] JS_CACHE_HIT ref-array-store /.test(record.text));
  const invalidations = indexed.filter((record) => /^\[zbg\] JS_CACHE_INVALIDATE ref-array-store /.test(record.text));
  const passes = indexed.filter((record) => /^\[zbg\] JS_CACHE_MUTATION_PASS ref-array-store /.test(record.text));
  const installRe = /^\[zbg\] JS_INSTALL ref-array-store exports=1 id=(\d+) slot=(\d+) /;
  const hitRe = /^\[zbg\] JS_CACHE_HIT ref-array-store id=(\d+) slot=(\d+) /;
  const invalidateRe = /^\[zbg\] JS_CACHE_INVALIDATE ref-array-store slot=(\d+) old-id=(\d+) owned-slot=(\d+) /;
  const passRe = /^\[zbg\] JS_CACHE_MUTATION_PASS ref-array-store mutation=([a-z-]+) miss=-1 old-id=(\d+) new-id=(\d+) old-slot=(\d+) new-slot=(\d+) old-owned-slot=(\d+) /;
  const parseOne = (record, expression, label) => {
    const match = record.text.match(expression);
    if (!match) throw new Error(label + " shape");
    return match;
  };
  if (passes.length === 0) {
    if (expectedMutation) throw new Error("expected cache mutation pass missing");
    if (installs.length !== 1 || hits.length !== 1 || invalidations.length !== 0) {
      throw new Error("cache hit/install transcript");
    }
    const first = parseOne(installs[0], installRe, "cache first install");
    const hit = parseOne(hits[0], hitRe, "cache hit");
    if (installs[0].lineIndex >= hits[0].lineIndex
        || Number(first[1]) !== Number(hit[1])
        || Number(first[2]) !== Number(hit[2])) {
      throw new Error("cache hit/install id-slot binding");
    }
    if (!/instance-reused=1 memory-reused=1 .* bytes-exact=1 card-layout-exact=1 export-match=1$/.test(hits[0].text)) {
      throw new Error("cache hit identity transcript");
    }
    return;
  }
  if (passes.length !== 1 || installs.length !== 2 || hits.length !== 1
      || invalidations.length !== 1) {
    throw new Error("cache mutation count transcript");
  }
  const first = parseOne(installs[0], installRe, "cache first install");
  const second = parseOne(installs[1], installRe, "cache replacement install");
  const hit = parseOne(hits[0], hitRe, "cache hit");
  const invalidation = parseOne(invalidations[0], invalidateRe, "cache invalidation");
  const pass = passes[0];
  const passMatch = parseOne(pass, passRe, "cache mutation pass");
  if (!allowedMutations.has(passMatch[1])) {
    throw new Error("unexpected cache mutation=" + passMatch[1]);
  }
  if (expectedMutation && passMatch[1] !== expectedMutation) {
    throw new Error("cache mutation binding expected=" + expectedMutation
      + " actual=" + passMatch[1]);
  }
  if (installs[0].lineIndex >= hits[0].lineIndex
      || hits[0].lineIndex >= invalidations[0].lineIndex
      || invalidations[0].lineIndex >= installs[1].lineIndex
      || installs[1].lineIndex >= pass.lineIndex
      || Number(first[1]) !== Number(hit[1])
      || Number(first[2]) !== Number(hit[2])
      || Number(first[1]) !== Number(invalidation[2])
      || Number(invalidation[2]) !== Number(passMatch[2])
      || Number(invalidation[1]) !== Number(passMatch[4])
      || Number(invalidation[3]) !== Number(passMatch[6])
      || Number(second[1]) !== Number(passMatch[3])
      || Number(second[2]) !== Number(passMatch[5])) {
    throw new Error("cache mutation id-slot cross-binding");
  }
  if (!/old-callable-before=1 export-match=(0|1) /.test(pass.text)
      || !/old-callable-after=0 removed=1 instance-reused=0 cache-cleared=1 last-instance-cleared=1 bytes-exact=1 card-layout-exact=1$/.test(pass.text)) {
    throw new Error("cache mutation identity transcript");
  }
  const poison = passMatch[1] === "poison";
  const expectedFlags = poison
    ? /removed=1 old-callable=1 export-match=0 old-callable-after=0 poisoning=1 poison-visible=1 old-export-visible=0 poison-removed=1 poison-callable-after=0 instance-cleared=1 cache-cleared=1 last-instance-cleared=1$/
    : /removed=1 old-callable=1 export-match=1 old-callable-after=0 poisoning=0 poison-visible=0 old-export-visible=1 poison-removed=1 poison-callable-after=0 instance-cleared=1 cache-cleared=1 last-instance-cleared=1$/;
  if (!expectedFlags.test(invalidations[0].text)) {
    throw new Error("cache invalidation poison/non-poison transcript");
  }
  if (!new RegExp(poison
      ? "poisoning=1 poison-visible=1 old-export-visible=0 poison-removed=1 poison-callable-after=0 "
      : "poisoning=0 poison-visible=0 old-export-visible=1 poison-removed=1 poison-callable-after=0 ").test(pass.text)) {
    throw new Error("poison cache identity transcript");
  }
}

const enterRe = /^\[zbg\] REF_ARRAY_STORE_ENTER seq=(\d+) method=referenceArrayStore static=1 params=3 max-stack=3 max-locals=3 raw32=1 actual-klass=objArrayKlass length-offset=(\d+) base-offset=(\d+) element-size=(\d+) card-base=(\d+) card-shift=(\d+) clean-card=(-?\d+) dirty-card=(-?\d+) limit-pages=(-?\d+) slot=(\d+) assignable=(\d+)$/;

function rootedAbiAssignableMatches(statusParts, tableParts) {
  return Number(statusParts[6]) === Number(tableParts[7]);
}

// Self-negative: status=3 and assignable=1 must compare the assignability
// capture (sp[6]), not the status capture (sp[1]); corrupting that capture is
// rejected while the valid status/assignability pair remains accepted.
const rootedAbiSelfStatus = ["", "3", "3", "0", "3", "0", "1"];
const rootedAbiSelfTable = ["", "", "", "", "", "", "0", "1"];
if (!rootedAbiAssignableMatches(rootedAbiSelfStatus, rootedAbiSelfTable)) {
  throw new Error("rooted ABI assignability self-test failed");
}
const rootedAbiSelfNegative = rootedAbiSelfStatus.slice();
rootedAbiSelfNegative[6] = "0";
if (rootedAbiAssignableMatches(rootedAbiSelfNegative, rootedAbiSelfTable)) {
  throw new Error("rooted ABI assignability self-negative accepted");
}

function event(block, call, forced) {
  const enters = block.lines.filter((record) => enterRe.test(record.text));
  if (!enters[call]) throw new Error(block.name + " enter " + call);
  const enter = enters[call];
  const seq = Number(enter.text.match(/seq=(\d+)/)[1]);
  const records = block.lines.filter((record) =>
    new RegExp("(^|\\s)seq=" + seq + "(\\s|$)").test(record.text));
  const adapter = one(records,
    /^\[zbg\] REF_ARRAY_STORE_ADAPTER seq=(\d+) array-bits=(\d+) index=(-?\d+) value-bits=(\d+) length=(-?\d+) klass=(null|objArrayKlass) bounds=(\d) assignable=(\d)$/,
    block.name + " adapter");
  const table = one(records,
    /^\[zbg\] REF_ARRAY_STORE_TABLE_CALL seq=(\d+) slot=(\d+) array-bits=(\d+) index=(-?\d+) value-bits=(\d+) limit-pages=(-?\d+) live-card-base=(\d+) assignable=(\d)$/,
    block.name + " table");
  const status = one(records,
    /^\[zbg\] REF_ARRAY_STORE_STATUS seq=(\d+) status=(\d+) bci=(\d+) value-oop-bits=(\d+) expected-bci=(\d+) limit-pages=(-?\d+) assignable=(\d)$/,
    block.name + " status");
  const exit = one(records,
    /^\[zbg\] REF_ARRAY_STORE_EXIT seq=(\d+) status=(RETURN|REEXECUTE) bci=(\d+)(?: reason=([a-z-]+))?$/,
    block.name + " exit");
  const ep = enter.text.match(enterRe);
  const ap = adapter.text.match(/array-bits=(\d+) index=(-?\d+) value-bits=(\d+) length=(-?\d+) klass=(null|objArrayKlass) bounds=(\d) assignable=(\d+)/);
  const tp = table.text.match(/slot=(\d+) array-bits=(\d+) index=(-?\d+) value-bits=(\d+) limit-pages=(-?\d+) live-card-base=(\d+) assignable=(\d+)/);
  const sp = status.text.match(/status=(\d+) bci=(\d+) value-oop-bits=(\d+) expected-bci=(\d+) limit-pages=(-?\d+) assignable=(\d+)/);
  const xp = exit.text.match(/status=(RETURN|REEXECUTE) bci=(\d+)(?: reason=([a-z-]+))?/);
  const expectedLimit = forced ? 1 : 0;
  if (!ep || !ap || !tp || !sp || !xp || Number(ep[9]) !== expectedLimit
      || Number(sp[5]) !== expectedLimit || Number(tp[5]) !== expectedLimit) {
    throw new Error(block.name + " malformed ABI or memory limit");
  }
  if (Number(ap[1]) !== Number(tp[2]) || Number(ap[2]) !== Number(tp[3])
      || Number(ap[3]) !== Number(tp[4]) || Number(ap[7]) !== Number(tp[7])
      || Number(ep[10]) !== Number(tp[1])
      || !rootedAbiAssignableMatches(sp, tp)) {
    throw new Error(block.name + " rooted ABI drift");
  }
  const direct = records.filter((record) => new RegExp(
    "^\\[zbg\\] DIRECT_REF_STORE referenceArrayStore runtime=1 seq=" + seq
    + " result-oop-bits=(\\d+) card-mark=(\\d) card-after-dirty=(\\d)$"
  ).test(record.text));
  const reexec = records.filter((record) => new RegExp(
    "^\\[zbg\\] REF_ARRAY_STORE_OPCODE_REEXECUTE seq=" + seq
    + " reason=([a-z-]+) resume-bci=3 depth=3 pending=0$"
  ).test(record.text));
  const interpreted = records.filter((record) =>
    new RegExp("^\\[zbg\\] INTERPRETER_AASTORE seq=" + seq + " bci=3$").test(record.text));
  const shouldReturn = !forced
      && (block.name === "direct" || block.name === "root-liveness");
  if (shouldReturn) {
    if (Number(sp[1]) !== 0 || Number(sp[2]) !== 0 || xp[1] !== "RETURN"
        || Number(xp[2]) !== 0 || direct.length !== 1 || reexec.length
        || interpreted.length) throw new Error(block.name + " direct event mismatch");
    const dp = direct[0].text.match(/result-oop-bits=(\d+) card-mark=(\d) card-after-dirty=(\d+)/);
    if (!dp || dp[2] !== "1" || dp[3] !== "1"
        || Number(sp[3]) !== Number(dp[1])) throw new Error(block.name + " card proof");
    order([enter, adapter, table, status, exit, direct[0]], block.name);
  } else {
    if (Number(sp[1]) !== 3 || Number(sp[2]) !== 3 || xp[1] !== "REEXECUTE"
        || Number(xp[2]) !== 3 || direct.length || reexec.length !== 1
        || interpreted.length !== 1) throw new Error(block.name + " reexecute event mismatch");
    const reason = reexec[0].text.match(/reason=([a-z-]+)/)[1];
    const expected = {
      direct: "memory",
      null: "null", negative: "bounds", length: "bounds", "min-index": "bounds",
      empty: "bounds", "bounds-ase": "bounds", "string-ase": "assignability",
      "number-ase": "assignability",
    }[block.name];
    const expectedReason = forced && block.name !== "null" ? "memory" : expected;
    if (!expectedReason || reason !== expectedReason) {
      throw new Error(block.name + " reason=" + reason);
    }
    order([enter, adapter, table, status, exit, reexec[0], interpreted[0]], block.name);
  }
  return seq;
}

function normal(mode) {
  const blockMap = cases();
  const names = mode === "root"
    ? ["root-liveness"]
    : ["direct", "null", "negative", "length", "min-index", "empty",
       "bounds-ase", "string-ase", "number-ase"];
  let next = 1;
  for (const name of names) {
    const block = blockMap.get(name);
    if (!block) throw new Error("missing case " + name);
    const count = name === "direct" ? 6 : 1;
    if (block.lines.filter((record) => /^\[zbg\] REF_ARRAY_STORE_ENTER seq=/.test(record.text)).length !== count) {
      throw new Error(name + " call count");
    }
    for (let i = 0; i < count; i++) {
      const sequence = event(block, i, mode === "forced");
      if (sequence !== next) throw new Error(name + " sequence=" + sequence);
      next++;
    }
  }
  if (next !== (mode === "root" ? 2 : 15)) throw new Error("sequence total=" + (next - 1));
  if (mode === "forced") {
    const forcedReasons = lines
      .map((line) => line.match(/^\[zbg\] REF_ARRAY_STORE_OPCODE_REEXECUTE seq=\d+ reason=([a-z-]+) /))
      .filter(Boolean)
      .map((match) => match[1]);
    const memory = forcedReasons.filter((reason) => reason === "memory").length;
    const nullCount = forcedReasons.filter((reason) => reason === "null").length;
    if (forcedReasons.length !== 14 || memory !== 13 || nullCount !== 1
        || forcedReasons.some((reason) => reason !== "memory" && reason !== "null")) {
      throw new Error(`forced reason counts memory=${memory} null=${nullCount}`);
    }
    console.log("ref-array-store-forced-reasons memory=13 null=1");
  }
  if (mode !== "root") summary();
  if (mode === "root" && !lines.includes("ref-array-store-root identity=1 array-identity=1 weak=1")) {
    throw new Error("root identity evidence missing");
  }
  if (mode === "root") {
    const probe = lines.filter((line) =>
      /^\[zbg\] REF_ARRAY_STORE_CARD_PROBE_SETUP /.test(line));
    if (probe.length !== 1
        || !/array-bits=\d+ card-address=\d+ length=\d+ index=\d+ array-old=1 all-null=1 card-clean=1 span-kind=1 prepared=1 pending=1$/.test(probe[0])) {
      throw new Error("root card setup evidence missing");
    }
    const post = lines.filter((line) =>
      /^\[zbg\] REF_ARRAY_STORE_CARD_PROBE_POST seq=/.test(line));
    if (post.length !== 1
        || !/array-old=1 child-young=1 card-before-clean=1 card-after-dirty=1 restored=0$/.test(post[0])) {
      throw new Error("root card post evidence missing");
    }
  }
  if (mode === "root") {
    const preBegin = lines.indexOf("ROOT_PRE_STORE_GC_BEGIN");
    const preEnd = lines.indexOf("ROOT_PRE_STORE_GC_END");
    const caseBegin = lines.indexOf("CASE_BEGIN root-liveness");
    const caseEnd = lines.indexOf("CASE_END root-liveness");
    const setup = lines.findIndex((line) =>
      /^\[zbg\] REF_ARRAY_STORE_CARD_PROBE_SETUP /.test(line));
    const postBegin = lines.indexOf("ROOT_POST_STORE_YOUNG_BEGIN");
    const postEnd = lines.indexOf("ROOT_POST_STORE_YOUNG_END");
    const weakIdentity = lines.indexOf("ref-array-store-root identity=1 array-identity=1 weak=1");
    if (preBegin < 0 || preEnd <= preBegin || caseBegin <= preEnd
        || setup <= preEnd || setup >= caseBegin || caseEnd <= caseBegin
        || postBegin <= caseEnd || postEnd <= postBegin
        || weakIdentity <= postEnd) {
      throw new Error("root aging/GC marker order");
    }
    const preWindow = lines.slice(preBegin, preEnd + 1);
    const postWindow = lines.slice(postBegin, postEnd + 1);
    if (!preWindow.some((line) => /Pause (?:Full|Young) /.test(line))) {
      throw new Error("root GC evidence missing");
    }
    if (postWindow.some((line) => /Pause Full /.test(line))
        || !postWindow.some((line) => /Pause Young /.test(line))) {
      throw new Error("post-store allocation-failure Young-only GC evidence missing");
    }
    const post = lines.findIndex((line) =>
      /^\[zbg\] REF_ARRAY_STORE_CARD_PROBE_POST seq=/.test(line));
    const eventBegin = lines.findIndex((line) =>
      /^\[zbg\] REF_ARRAY_STORE_ENTER seq=/.test(line));
    const direct = lines.findIndex((line) =>
      /^\[zbg\] DIRECT_REF_STORE referenceArrayStore /.test(line));
    if (eventBegin <= setup || direct <= eventBegin || post <= direct
        || post >= caseEnd || caseBegin >= eventBegin) {
      throw new Error("root card transcript order");
    }
  }
  cacheEvidence();
  console.log("ref-array-store-log-order=pass mode=" + mode + " calls=" + (next - 1));
}

if (mode === "negative") {
  if (lines.some((line) => eventMarker.test(line))) throw new Error("near miss entered store lane");
  if (!lines.some((line) => line.includes("ref-array-store-negatives descriptor=1 owner=1 static=1 body=1 instance=1"))) {
    throw new Error("near miss summary missing");
  }
  console.log("ref-array-store-log-order=pass mode=negative linked=0");
} else if (mode === "off") {
  summary();
  if (lines.some((line) => linkedMarker.test(line))) throw new Error("off linked marker");
  const count = lines.filter((line) => /^\[zbg\] INTERPRETER_AASTORE seq=\d+ bci=3$/.test(line)).length;
  if (count !== 14) throw new Error("off interpreter count=" + count);
  console.log("ref-array-store-log-order=pass mode=off linked=0 interpreter-aastore=14");
} else if (mode === "fresh-reject") {
  summary();
  if (expectedMutation !== "selftest-fresh-false"
      && expectedMutation !== "selftest-fresh-throw") {
    throw new Error("fresh-reject expected mutation missing");
  }
  const rejects = lines.filter((line) =>
    /^\[zbg\] JS_CACHE_FRESH_REJECT ref-array-store /.test(line));
  if (rejects.length !== 1
      || !new RegExp(" validation=" + expectedMutation + " ").test(rejects[0])
      || !/ removed=1 removal-attempted=1 callable-before=1 callable-after=0 callable-probe-before=1 callable-probe-after=1 cleanup-proven=1 metadata-cleared=1 last-instance-cleared=1$/.test(rejects[0])) {
    throw new Error("fresh-reject rollback transcript");
  }
  if (lines.some((line) => /^\[zbg\] JS_CACHE_MUTATION_PASS ref-array-store /.test(line))) {
    throw new Error("fresh-reject emitted mutation pass");
  }
  if (lines.some((line) => /REF_ARRAY_STORE_(?:ENTER|ADAPTER|TABLE_CALL|STATUS|EXIT)|DIRECT_REF_STORE/.test(line))) {
    throw new Error("fresh-reject entered direct store lane");
  }
  const count = lines.filter((line) =>
    /^\[zbg\] INTERPRETER_AASTORE seq=\d+ bci=3$/.test(line)).length;
  if (count !== 14) throw new Error("fresh-reject interpreter count=" + count);
  console.log("ref-array-store-log-order=pass mode=fresh-reject mutation="
    + expectedMutation + " interpreter-aastore=14 rollback=1");
} else if (mode === "collision" || mode === "collision-pair"
    || mode === "collision-legacy") {
  summary();
  const collisions = lines.filter((line) => /^\[zbg\] REF_ARRAY_REJECT reason=flag-collision /.test(line));
  if (collisions.length !== 1) throw new Error("collision marker count=" + collisions.length);
  if ((mode === "collision-pair" || mode === "collision-legacy")
      && !/ref-load=1 ref-store=1/.test(collisions[0])) {
    throw new Error("collision marker lacks C1-load/C2-store pair");
  }
  if (lines.some((line) => linkedMarker.test(line))) throw new Error("collision linked marker");
  const count = lines.filter((line) => /^\[zbg\] INTERPRETER_AASTORE seq=\d+ bci=3$/.test(line)).length;
  if (count !== 14) throw new Error("collision interpreter count=" + count);
  console.log("ref-array-store-log-order=pass mode=" + mode
    + " interpreter-aastore=14");
} else if (mode === "osr-collision" || mode === "osr-aggregate") {
  if (lines.some((line) => /^\[zwc\]/.test(line))) {
    throw new Error("OSR collision reached JIT");
  }
  const collisions = lines.filter((line) => /^\[zbg\] REF_ARRAY_REJECT reason=flag-collision /.test(line));
  const expectedPair = mode === "osr-aggregate";
  if (collisions.length !== 1
      || (expectedPair && !/ref-load=1 ref-store=1/.test(collisions[0]))
      || (!expectedPair && !/ref-load=0 ref-store=1/.test(collisions[0]))) {
    throw new Error("OSR collision marker count/pair");
  }
  if (lines.some((line) => linkedMarker.test(line))) throw new Error("OSR collision linked marker");
  if (!lines.includes("ref-array-store-osr-collision checksum=512")) {
    throw new Error("OSR collision checksum missing");
  }
  const count = lines.filter((line) => /^\[zbg\] INTERPRETER_AASTORE seq=\d+ bci=3$/.test(line)).length;
  if (count !== 512) throw new Error("OSR collision interpreter count=" + count);
  console.log("ref-array-store-log-order=pass mode=" + mode
    + " interpreter-aastore=512");
} else if (mode === "linked" || mode === "forced" || mode === "root") {
  normal(mode);
} else {
  throw new Error("unknown mode=" + mode);
}
