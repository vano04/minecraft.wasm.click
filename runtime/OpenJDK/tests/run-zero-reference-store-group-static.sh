#!/bin/sh
# Stage-1 only: source/class/syntax checks for M2-C3a. No HotSpot build or run.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=${WORK:-$(mktemp -d /private/tmp/mcweb-zero-reference-store-group-static.XXXXXX)}
JAVAC=${JAVAC:-javac}
JAVA=${JAVA:-java}
NODE=${NODE:-node}

reject() {
  echo "REJECT reference-store-group-static reason=$1 work=$WORK" >&2
  exit 1
}

GLOBALS=$ROOT/work/jdk25/src/hotspot/cpu/zero/globals_zero.hpp
INTERPRETER=$ROOT/work/jdk25/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp
BASELINE=$ROOT/work/jdk25/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp
FIXTURE=$ROOT/tests/ZeroReferenceStoreGroupFixture.java
NEAR=$ROOT/tests/ZeroReferenceStoreGroupNearMiss.java
PROBE=$ROOT/tests/ZeroReferenceStoreGroupProbe.java
CARD_HELPER=$ROOT/tests/ZeroReferenceArrayStoreFixture.java
CARD_NEAR=$ROOT/tests/ZeroReferenceArrayStoreNearMiss.java
CLASS_CHECKER=$ROOT/tests/check-zero-reference-store-group-class.mjs
WAT_CHECKER=$ROOT/tests/check-zero-reference-store-group-wat.mjs
LOG_CHECKER=$ROOT/tests/check-zero-reference-store-group-log.mjs
MANIFEST_CHECKER=$ROOT/tests/check-zero-reference-store-group-manifest.mjs
MANIFEST=$ROOT/tests/zero-reference-store-group-c3a-manifest.sha256

mkdir -p "$WORK/classes"
for file in "$GLOBALS" "$INTERPRETER" "$BASELINE" "$FIXTURE" "$NEAR" \
            "$PROBE" "$CARD_HELPER" "$CARD_NEAR" "$CLASS_CHECKER" "$WAT_CHECKER" "$LOG_CHECKER" \
            "$MANIFEST_CHECKER" "$MANIFEST"; do
  [ -f "$file" ] || reject "missing-$(basename "$file")"
done

"$NODE" --check "$CLASS_CHECKER"
"$NODE" --check "$WAT_CHECKER"
"$NODE" --check "$LOG_CHECKER"
"$NODE" --check "$MANIFEST_CHECKER"
"$NODE" "$LOG_CHECKER" --self-test > "$WORK/log-checker-selftest.log"
sh -n "$0"

if rg -q 'Object relayed|astore_3|aload_3' "$FIXTURE"; then
  reject "entry-extra-reference-local"
fi
rg -Fq 'return commit(values, index, relay(value));' "$FIXTURE" \
  || reject "nested-entry-source"

rg -q 'UseZeroWasmLinkedReferenceStoreGroup' "$GLOBALS" "$INTERPRETER" "$BASELINE" \
  || reject "dedicated-flag"
rg -q 'ZeroWasmLinkedReferenceStoreGroupMemoryLimitForTest' "$GLOBALS" "$BASELINE" \
  || reject "memory-limit-flag"
rg -q 'ZeroWasmLinkedReferenceStoreGroupCacheMutationForTest' "$GLOBALS" "$BASELINE" \
  || reject "cache-mutation-flag"
rg -q '__mcwebZeroReferenceStoreGroupCache' "$BASELINE" \
  || reject "dedicated-js-cache"
rg -q 'build_reference_store_group_module' "$BASELINE" \
  || reject "module-builder"
rg -q 'emit_reference_store_group_commit' "$BASELINE" \
  || reject "private-commit"
rg -q 'edges=entry>relay,relay>leaf,entry>commit' "$BASELINE" \
  || reject "edge-manifest"
rg -q 'group-edges' "$BASELINE" || reject "group-edge-cache-identity"
rg -q 'commit-bci3-resume=0' "$BASELINE" || reject "whole-method-fallback"
rg -q 'internal-direct-calls=3 oop-stores=1' "$BASELINE" \
  || reject "direct-call-counter"
rg -Fq 'entry-body=2a1b2cb8??b8??b0' "$BASELINE" \
  || reject "entry-bytecode-key"
rg -q 'relay-bci=3;commit-bci=6;return-bci=9' "$BASELINE" \
  || reject "entry-bcis-key"
rg -Fq 'opcode == (unsigned char)Bytecodes::_aload_0' "$BASELINE" \
  || reject "quickening-aload0"
rg -Fq 'opcode == (unsigned char)Bytecodes::_fast_aload_0' "$BASELINE" \
  || reject "quickening-fast-aload0"
rg -Fq 'opcode == (unsigned char)Bytecodes::_nofast_aload_0' "$BASELINE" \
  || reject "quickening-nofast-aload0"
rg -Fq 'descriptor=%s accepted=0 holder-predicate=%d' "$BASELINE" \
  || reject "classifier-holder-predicate-diagnostic"
rg -Fq 'member-predicate=%d body-predicate=%d edge-predicate=%d' "$BASELINE" \
  || reject "classifier-member-body-edge-diagnostics"
rg -Fq 'quickening-predicate=%d' "$BASELINE" \
  || reject "classifier-quickening-diagnostic"
rg -Fq 'linked_void_type(types, 3); // type 2: commit(element,value,card) -> void' \
  "$BASELINE" || reject "void-commit-type"
rg -Fq 'entry buried-result/void-commit terminal tail' "$WAT_CHECKER" \
  || reject "void-commit-oracle"
rg -q 'JS_CACHE_REJECT_CLEANUP reference-store-group' "$BASELINE" \
  || reject "cache-hit-reject-cleanup"
rg -q 'zbb_reference_store_group_reject_cleanup' "$BASELINE" \
  || reject "cache-hit-cleanup-call"
[ "$(rg -c 'zbb_reference_store_group_reject_cleanup' "$BASELINE")" -eq 3 ] \
  || reject "cache-cleanup-declaration-and-two-callers"
rg -q 'expected_slot === ownedSlot' "$BASELINE" \
  || reject "expected-owned-slot-reuse"
rg -Fq 'expectedCallableAfter = callableAt(expected_slot)' "$BASELINE" \
  || reject "mismatched-expected-slot-probe"
rg -q 'const expectedCleanupProven = expectedProbeComplete' "$BASELINE" \
  || reject "expected-slot-proof-probe"
rg -Fq 'const proven = empty && ownedCleanupProven && expectedCleanupProven' \
  "$BASELINE" || reject "expected-slot-required-by-proof"
rg -q 'mcweb-binary-sha256' "$WAT_CHECKER" \
  || reject "wat-binary-digest-binding"
for mutation in compiler digest bytes memory metadata slot card-layout group-edges poison; do
  rg -q "case \"$mutation\"" "$BASELINE" || reject "cache-$mutation"
done
for selftest in selftest-fresh-false selftest-fresh-throw; do
  rg -q "$selftest" "$BASELINE" || reject "$selftest"
done

"$JAVAC" -g:none -d "$WORK/classes" "$FIXTURE" "$NEAR" "$PROBE" "$CARD_HELPER" "$CARD_NEAR"
"$NODE" "$CLASS_CHECKER" "$WORK/classes/ZeroReferenceStoreGroupFixture.class" \
  > "$WORK/class-check.log"
if "$NODE" "$CLASS_CHECKER" "$WORK/classes/ZeroReferenceStoreGroupNearMiss.class" \
    > "$WORK/class-near-miss.log" 2>&1; then
  reject "wrong-owner-class-accepted"
fi
"$JAVA" -cp "$WORK/classes" ZeroReferenceStoreGroupProbe matrix \
  > "$WORK/jvm-matrix.log"
"$JAVA" -cp "$WORK/classes" ZeroReferenceStoreGroupProbe near-miss \
  > "$WORK/jvm-near-miss.log"
"$JAVA" -cp "$WORK/classes" ZeroReferenceStoreGroupProbe osr \
  > "$WORK/jvm-osr.log"
rg -qx 'reference-store-group direct=6 reexec=8 reject-array-unchanged=8 result=pass' \
  "$WORK/jvm-matrix.log" || reject "jvm-matrix"
rg -qx 'reference-store-group-near-miss owner=1 result=pass' \
  "$WORK/jvm-near-miss.log" || reject "jvm-near-miss"
rg -qx 'reference-store-group-osr checksum=512 result=pass' \
  "$WORK/jvm-osr.log" || reject "jvm-osr"

"$NODE" "$MANIFEST_CHECKER" "$ROOT" "$MANIFEST" \
  > "$WORK/manifest-check.log"
"$NODE" "$MANIFEST_CHECKER" "$ROOT" "$MANIFEST" \
  --self-test-stale-runtime > "$WORK/manifest-stale-runtime-negative.log"
rg -qx 'reference-store-group-manifest-self-negatives=pass static-accept=reject stale-runtime=reject generated-placeholders=reject count=3' \
  "$WORK/manifest-stale-runtime-negative.log" \
  || reject "manifest-stale-runtime-self-negative"

echo "reference-store-group-static=pass class=exact wrong-owner=rejected"
echo "reference-store-group-jvm=pass direct=6 reexec=8 osr=512"
echo "reference-store-group-structural-input=available runtime=fresh-built module=fresh-dumped"
echo "ACCEPT C3a static final-0019-fresh-run-ready runtime=fresh-built module=fresh-dumped work=$WORK"
