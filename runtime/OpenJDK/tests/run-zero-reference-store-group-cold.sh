#!/bin/sh
# OSS-only M2-C3a cold executable gate. Class-directory execution; the JAR is
# deterministic provenance/cache identity input only. No legacy/perf lanes.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JDK=$ROOT/work/jdk25
JAVAC=/opt/homebrew/opt/openjdk@25/bin/javac
JAR=/opt/homebrew/opt/openjdk@25/bin/jar
WASM_DIS=/opt/homebrew/bin/wasm-dis
TIMEOUT=/opt/homebrew/bin/timeout
NODE=node
RUN_JAVA=$ROOT/run-java.sh
LOCK_HELPER=$ROOT/tests/zero-runtime-gate-lock.sh
LIBJVM=$JDK/build/wasm-zero/jdk/lib/zero/libjvm.so
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
STARTED_EPOCH=$(date +%s)
WORK=$(mktemp -d /private/tmp/mcweb-zero-reference-store-group-c3a-cold.XXXXXX)
C3A_COLD_OUTPUT=${C3A_COLD_OUTPUT:?explicit fresh C3A_COLD_OUTPUT is required}
EVIDENCE=$C3A_COLD_OUTPUT
STAGE=$EVIDENCE.tmp.$$
RUN_PID=

reject() {
  echo "REJECT M2-C3a cold gate reason=$1 work=$WORK stage=$STAGE" >&2
  exit 1
}
terminate_owned() {
  owned_pid=$1
  [ -n "$owned_pid" ] || return 0
  kill -TERM "$owned_pid" 2>/dev/null || true
  tries=0
  while [ "$tries" -lt 20 ]; do
    kill -0 "$owned_pid" 2>/dev/null || return 0
    tries=$((tries + 1))
    sleep 0.05
  done
  kill -KILL "$owned_pid" 2>/dev/null || true
}
cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ -z "$RUN_PID" ] || terminate_owned "$RUN_PID"
  runtime_gate_lock_release 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM

[ -x "$JAVAC" ] && [ -x "$JAR" ] && [ -x "$WASM_DIS" ] \
  && [ -x "$TIMEOUT" ] && [ -x "$RUN_JAVA" ] || reject tools
[ -f "$LIBJVM" ] && [ -f "$MANIFEST" ] && [ -f "$LOCK_HELPER" ] \
  || reject inputs
for source in "$FIXTURE" "$NEAR" "$PROBE" "$CARD_HELPER" "$CARD_NEAR"; do
  [ -f "$source" ] || reject source-closure-missing
done
case "$EVIDENCE" in
  /private/tmp/mcweb-zero-reference-store-group-c3a-cold-accept.*) ;;
  *) reject unsafe-evidence-root ;;
esac
. "$LOCK_HELPER"
runtime_gate_lock_acquire || reject shared-lock
[ ! -e "$EVIDENCE" ] && [ ! -e "$STAGE" ] || reject evidence-path-collision
mkdir -p "$WORK/classes"

"$NODE" "$MANIFEST_CHECKER" "$ROOT" "$MANIFEST" \
  >"$WORK/check-manifest.log" 2>&1 || reject manifest
compile_source_list_exact() {
  [ "$#" -eq 5 ] \
    && [ "$1" = "$FIXTURE" ] && [ "$2" = "$NEAR" ] \
    && [ "$3" = "$PROBE" ] && [ "$4" = "$CARD_HELPER" ] \
    && [ "$5" = "$CARD_NEAR" ]
}
if compile_source_list_exact "$FIXTURE" "$NEAR" "$PROBE" "$CARD_NEAR"; then
  reject source-list-omission-self-negative-accepted
fi
set -- "$FIXTURE" "$NEAR" "$PROBE" "$CARD_HELPER" "$CARD_NEAR"
compile_source_list_exact "$@" || reject source-list-closure
"$JAVAC" -g:none -d "$WORK/classes" "$@" \
  >"$WORK/javac.log" 2>&1 || reject javac
"$NODE" "$CLASS_CHECKER" "$WORK/classes/ZeroReferenceStoreGroupFixture.class" \
  >"$WORK/check-class.log" 2>&1 || reject class-shape
if "$NODE" "$CLASS_CHECKER" \
    "$WORK/classes/ZeroReferenceStoreGroupNearMiss.class" \
    >"$WORK/check-near.log" 2>&1; then
  reject near-miss-accepted
fi
"$JAR" --create --date=2026-01-01T00:00:00+00:00 \
  --file "$WORK/fixture.jar" -C "$WORK/classes" . || reject jar

CLASS_SHA=$(shasum -a 256 \
  "$WORK/classes/ZeroReferenceStoreGroupFixture.class" | awk '{print $1}')
NEAR_SHA=$(shasum -a 256 \
  "$WORK/classes/ZeroReferenceStoreGroupNearMiss.class" | awk '{print $1}')
PROBE_SHA=$(shasum -a 256 \
  "$WORK/classes/ZeroReferenceStoreGroupProbe.class" | awk '{print $1}')
CARD_HELPER_SHA=$(shasum -a 256 \
  "$WORK/classes/ZeroReferenceArrayStoreFixture.class" | awk '{print $1}')
CARD_NEAR_SHA=$(shasum -a 256 \
  "$WORK/classes/ZeroReferenceArrayStoreNearMiss.class" | awk '{print $1}')
JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
DEPS=ZeroReferenceStoreGroupNearMiss.class=sha256:$NEAR_SHA,ZeroReferenceStoreGroupProbe.class=sha256:$PROBE_SHA
printf 'c3a-provenance-v1 execution-input=class-directory fixture-jar=provenance/cache-identity-only class=%s near=%s probe=%s jar=%s dependencies=%s\n' \
  "$CLASS_SHA" "$NEAR_SHA" "$PROBE_SHA" "$JAR_SHA" "$DEPS" \
  >"$WORK/provenance.manifest"

for expected in \
  "generated-class-sha256=$CLASS_SHA" \
  "generated-near-class-sha256=$NEAR_SHA" \
  "generated-probe-class-sha256=$PROBE_SHA" \
  "generated-card-helper-class-sha256=$CARD_HELPER_SHA" \
  "generated-card-helper-near-class-sha256=$CARD_NEAR_SHA" \
  "generated-fixture-jar-sha256=$JAR_SHA"; do
  rg -qx "$expected" "$MANIFEST" || reject generated-manifest-drift
done

if [ "${MCWEB_C3A_COLD_COMPILE_ONLY:-0}" = 1 ]; then
  printf 'WIP m2-c3a-cold-compile=PASS sources=5 source-omission-negative=reject group-class=exact near-miss=rejected card-helper=bound card-near=bound jar=manifest-exact no-linked-runtime=1 work=%s\n' \
    "$WORK"
  exit 0
fi

mkdir -p "$WORK/dumps" "$STAGE/checks" "$STAGE/logs"

DUMP=$WORK/dumps/linked.wasm
LOG=$WORK/linked.log
[ ! -e "$DUMP" ] || reject stale-dump
MCWEB_ZERO_REFERENCE_STORE_GROUP_WASM_DUMP="$DUMP" \
  "$TIMEOUT" --signal=TERM --kill-after=5s 180 "$RUN_JAVA" \
  -Xmx256m -Xms16m -XX:+UnlockExperimentalVMOptions -XX:+UseSerialGC \
  -XX:+UseZeroWasmLinkedReferenceStoreGroup -XX:+ZeroWasmLinkedGroupVerbose \
  -XX:ZeroWasmBaselineJarHash="$JAR_SHA" \
  -XX:ZeroWasmBaselineClassHash="$CLASS_SHA" \
  -XX:ZeroWasmBaselineDependencyHashes="$DEPS" \
  -cp "$WORK/classes" ZeroReferenceStoreGroupProbe matrix >"$LOG" 2>&1 &
RUN_PID=$!
if wait "$RUN_PID"; then run_status=0; else run_status=$?; fi
RUN_PID=
[ "$run_status" -eq 0 ] || reject runtime-status-$run_status
if rg -qi 'ReferenceError|TypeError|RangeError|SyntaxError|uncaught|UnhandledPromiseRejection|Pthread.*error|Broken pipe|SIGPIPE|hs_err|fatal(?: error)?|Internal Error|wasm trap|unreachable|CALL MISMATCH' "$LOG"; then
  reject fatal-runtime-diagnostic
fi
rg -qx 'reference-store-group direct=6 reexec=8 reject-array-unchanged=8 result=pass' \
  "$LOG" || reject terminal-marker
awk '
  BEGIN { terminal=0; late=0; bad=0 }
  /^reference-store-group direct=6 reexec=8 reject-array-unchanged=8 result=pass$/ {
    terminal++; next
  }
  tolower($0) ~ /terminated worker/ {
    if (!terminal || $0 !~ /^received "6" command from terminated worker: [1-9][0-9]*$/) bad=1
    else late++
  }
  END { if (terminal != 1 || bad || late > 2) exit 1 }
' "$LOG" || reject late-cmd6
[ -s "$DUMP" ] || reject module-dump
DUMP_MTIME=$(stat -f '%m' "$DUMP")
[ "$DUMP_MTIME" -ge "$STARTED_EPOCH" ] || reject stale-module-mtime
cp "$DUMP" "$WORK/module.wasm"
"$WASM_DIS" "$WORK/module.wasm" -o "$WORK/module.raw.wat" \
  >"$WORK/wasm-dis.log" 2>&1 || reject wasm-dis
MODULE_SHA=$(shasum -a 256 "$WORK/module.wasm" | awk '{print $1}')
{
  printf ';; mcweb-binary-sha256=%s\n' "$MODULE_SHA"
  cat "$WORK/module.raw.wat"
} >"$WORK/module.wat"

# Structural trust precedes every semantic claim.
"$NODE" "$WAT_CHECKER" "$WORK/module.wasm" "$WORK/module.wat" \
  >"$WORK/check-wat.log" 2>&1 || reject wat-binary
rg -qx 'reference-store-group-binary-self-negatives=20 valid-same-length rejected' \
  "$WORK/check-wat.log" || reject mutation-count
rg -qx 'reference-store-group-binary-invalid-negatives=4 truncation,commit-type,commit-call,commit-tail rejected' \
  "$WORK/check-wat.log" || reject structural-invalid-negatives
rg -qx 'reference-store-group-wat-self-negatives=12 scratch=2 commit-structure=7 postcommit=call,load,branch rejected' \
  "$WORK/check-wat.log" || reject wat-self-negatives
rg -qx 'reference-store-group-wat-stale-pairing-negative=1 rejected' \
  "$WORK/check-wat.log" || reject stale-pair-negative

"$NODE" "$LOG_CHECKER" "$LOG" linked >"$WORK/check-linked.log" 2>&1 \
  || reject semantic-transcript
rg -qx 'reference-store-group-log=pass mode=linked direct=6 fallback=8 internal-direct-calls=18 oop-stores=6 card-stores=6 unchanged-rejects=8' \
  "$WORK/check-linked.log" || reject semantic-counters

cp "$WORK/module.wasm" "$WORK/module.wat" "$WORK/module.raw.wat" \
  "$WORK/check-wat.log" "$WORK/check-class.log" "$WORK/check-manifest.log" \
  "$WORK/provenance.manifest" "$WORK/fixture.jar" "$STAGE/checks/"
cp "$WORK/linked.log" "$WORK/check-linked.log" "$WORK/javac.log" \
  "$WORK/wasm-dis.log" /private/tmp/mcweb-c3a-void-hotspot-build.log \
  /private/tmp/mcweb-c3a-void-jdk-build.log "$STAGE/logs/"
MODULE_BYTES=$(wc -c <"$WORK/module.wasm" | awk '{print $1}')
FINISHED_EPOCH=$(date +%s)
{
  printf '%s\n' 'm2-c3a-cold-atomic-evidence-v1' 'accept=m2-c3a-cold exit=0'
  printf 'started-epoch=%s finished-epoch=%s\n' "$STARTED_EPOCH" "$FINISHED_EPOCH"
  printf 'module-sha=%s module-bytes=%s wat-mutations=20 invalid-mutations=4 stale-pair=1\n' \
    "$MODULE_SHA" "$MODULE_BYTES"
  printf 'semantics=direct6,fallback8,unchanged8 internal-direct-calls=18 oop-stores=6 card-stores=6 no-post-commit-fallback=1\n'
  printf 'shape=funcs4,exports1,private3,table-slots1,private-slots0\n'
  printf 'gate-sha=%s manifest-sha=%s libjvm-sha=%s\n' \
    "$(shasum -a 256 "$0" | awk '{print $1}')" \
    "$(shasum -a 256 "$MANIFEST" | awk '{print $1}')" \
    "$(shasum -a 256 "$LIBJVM" | awk '{print $1}')"
  find "$STAGE/checks" "$STAGE/logs" -type f -print | LC_ALL=C sort \
    | while IFS= read -r evidence_file; do
        relative=${evidence_file#"$STAGE/"}
        printf 'bundle-file path=%s sha256=%s bytes=%s\n' "$relative" \
          "$(shasum -a 256 "$evidence_file" | awk '{print $1}')" \
          "$(wc -c <"$evidence_file" | awk '{print $1}')"
      done
} >"$STAGE/evidence.index"
shasum -a 256 "$STAGE/evidence.index" | awk \
  '{print $1 "  evidence.index"}' >"$STAGE/evidence.index.sha256"
sync
mv -- "$STAGE" "$EVIDENCE"
printf 'm2-c3a-cold=ACCEPT module-sha=%s module-bytes=%s wat-mutations=20 evidence-root=%s\n' \
  "$MODULE_SHA" "$MODULE_BYTES" "$EVIDENCE"
