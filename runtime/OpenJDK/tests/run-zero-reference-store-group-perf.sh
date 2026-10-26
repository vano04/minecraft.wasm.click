#!/bin/sh
# Measurement-only C3a performance experiment. Never production acceptance.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JDK=$ROOT/work/jdk25
JAVAC=/opt/homebrew/opt/openjdk@25/bin/javac
JAR=/opt/homebrew/opt/openjdk@25/bin/jar
TIMEOUT=/opt/homebrew/bin/timeout
WASM_DIS=/opt/homebrew/bin/wasm-dis
RUN_JAVA=$ROOT/run-java.sh
LOCK_HELPER=$ROOT/tests/zero-runtime-gate-lock.sh
WASM_CHECKER=$ROOT/tests/check-zero-reference-store-group-perf-wasm.mjs
PRODUCTION_CHECKER=$ROOT/tests/check-zero-reference-store-group-wat.mjs
LOG_CHECKER=$ROOT/tests/check-zero-reference-store-group-perf-log.mjs
SOURCE_CHECKER=$ROOT/tests/check-zero-reference-store-group-perf-publication-source.mjs
MANIFEST_CHECKER=$ROOT/tests/check-zero-reference-store-group-manifest.mjs
NESTED_CHECKER=$ROOT/tests/check-zero-nested-evidence.mjs
MANIFEST=$ROOT/tests/zero-reference-store-group-c3a-manifest.sha256
BASELINE=$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp
LIBJVM=$JDK/build/wasm-zero/jdk/lib/zero/libjvm.so
FOCUSED=${C3A_FOCUSED_EVIDENCE:?explicit fresh C3A_FOCUSED_EVIDENCE is required}
PUBLICATION=${C3A_PUBLICATION_EVIDENCE:?explicit fresh C3A_PUBLICATION_EVIDENCE is required}
START=$(date +%s)
WORK=$(mktemp -d /private/tmp/mcweb-zero-reference-store-group-perf.XXXXXX)
EVIDENCE=${C3A_PERF_OUTPUT:?explicit fresh C3A_PERF_OUTPUT is required}
STAGE=$EVIDENCE.tmp.$$
RUN_PID=
reject() { echo "REJECT C3a-perf reason=$1 work=$WORK stage=$STAGE" >&2; exit 1; }
cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ -z "$RUN_PID" ] || kill -TERM "$RUN_PID" 2>/dev/null || true
  runtime_gate_lock_release 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM
for tool in "$JAVAC" "$JAR" "$TIMEOUT" "$WASM_DIS" "$RUN_JAVA"; do
  [ -x "$tool" ] || reject "tool-$(basename "$tool")"
done
for input in "$LOCK_HELPER" "$WASM_CHECKER" "$PRODUCTION_CHECKER" "$LOG_CHECKER" \
  "$SOURCE_CHECKER" "$MANIFEST_CHECKER" "$NESTED_CHECKER" "$MANIFEST" "$BASELINE" "$LIBJVM" \
  "$ROOT/tests/ZeroReferenceArrayStoreFixture.java" \
  "$ROOT/tests/ZeroReferenceArrayStoreNearMiss.java" \
  "$ROOT/tests/ZeroReferenceStoreGroupPerfFixture.java" \
  "$ROOT/tests/ZeroReferenceStoreGroupPerfProbe.java" \
  "$FOCUSED/evidence.index" "$FOCUSED/evidence.index.sha256" \
  "$PUBLICATION/evidence.index" "$PUBLICATION/evidence.index.sha256" \
  "$PUBLICATION/source/zeroWasmBaseline.cpp" \
  "$PUBLICATION/runtime/libjvm.so" "$PUBLICATION/checks/structure.wasm"; do
  [ -f "$input" ] || reject "input-$(basename "$input")"
done
case "$FOCUSED" in
  /private/tmp/mcweb-zero-reference-store-group-focused-accept.*) ;;
  *) reject unsafe-focused-evidence-root ;;
esac
case "$PUBLICATION" in
  /private/tmp/mcweb-zero-reference-store-group-perf-publication-accept.*) ;;
  *) reject unsafe-publication-evidence-root ;;
esac
case "$EVIDENCE" in
  /private/tmp/mcweb-zero-reference-store-group-perf-accept.*) ;;
  *) reject unsafe-evidence-root ;;
esac
. "$LOCK_HELPER"
runtime_gate_lock_acquire || reject shared-lock
[ ! -e "$EVIDENCE" ] && [ ! -e "$STAGE" ] || reject evidence-collision
node "$NESTED_CHECKER" "$FOCUSED" --self-test "$PUBLICATION" \
  >"$WORK/focused-prerequisite.log" 2>&1 \
  || reject focused-prerequisite
node "$NESTED_CHECKER" "$PUBLICATION" --self-test "$FOCUSED" \
  >"$WORK/publication-prerequisite.log" 2>&1 \
  || reject publication-prerequisite
node "$MANIFEST_CHECKER" "$ROOT" "$MANIFEST" --self-test-stale-runtime \
  >"$WORK/manifest-check.log" 2>&1 || reject manifest
node "$SOURCE_CHECKER" "$BASELINE" --self-test >"$WORK/source-check.log" 2>&1 \
  || reject source
cmp -s "$BASELINE" "$PUBLICATION/source/zeroWasmBaseline.cpp" \
  || reject publication-source-drift
cmp -s "$LIBJVM" "$PUBLICATION/runtime/libjvm.so" \
  || reject publication-runtime-drift
mkdir -p "$WORK/classes" "$WORK/dump" "$STAGE/runtime" "$STAGE/assets" \
  "$STAGE/logs" "$STAGE/checks" "$STAGE/prerequisite" "$STAGE/source"
"$JAVAC" -g:none -d "$WORK/classes" \
  "$ROOT/tests/ZeroReferenceArrayStoreFixture.java" \
  "$ROOT/tests/ZeroReferenceArrayStoreNearMiss.java" \
  "$ROOT/tests/ZeroReferenceStoreGroupPerfFixture.java" \
  "$ROOT/tests/ZeroReferenceStoreGroupPerfProbe.java" \
  >"$WORK/javac.log" 2>&1 || reject javac
"$JAR" --create --date=2026-01-01T00:00:00+00:00 \
  --file "$WORK/fixture.jar" -C "$WORK/classes" . || reject jar
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceStoreGroupPerfFixture.class" | awk '{print $1}')
PROBE_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceStoreGroupPerfProbe.class" | awk '{print $1}')
HELPER_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceArrayStoreFixture.class" | awk '{print $1}')
NEAR_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceArrayStoreNearMiss.class" | awk '{print $1}')
JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
DEPS=ZeroReferenceStoreGroupPerfProbe.class=sha256:$PROBE_SHA,ZeroReferenceArrayStoreFixture.class=sha256:$HELPER_SHA,ZeroReferenceArrayStoreNearMiss.class=sha256:$NEAR_SHA
BASE="-Xmx256m -Xms16m -XX:+UnlockExperimentalVMOptions -XX:+UseSerialGC -XX:+UseZeroWasmReferenceStoreGroupPerf -XX:+ZeroWasmLinkedRefArrayStoreCardProbeForTest -XX:+ZeroWasmLinkedGroupVerbose -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS"
run_supervised() {
  mode=$1; dump=$2; log=$3
  shift 3
  [ ! -e "$dump" ] || reject "stale-dump-$mode"
  MCWEB_ZERO_REFERENCE_STORE_GROUP_PERF_WASM_DUMP="$dump" \
    "$TIMEOUT" --signal=TERM --kill-after=5s 900 "$RUN_JAVA" "$@" \
    >"$log" 2>&1 &
  RUN_PID=$!
  if wait "$RUN_PID"; then status=0; else status=$?; fi
  RUN_PID=
  [ "$status" -eq 0 ] || reject "runtime-$mode-status-$status"
  [ -s "$dump" ] || reject "dump-$mode"
  if rg -qi 'ReferenceError|TypeError|RangeError|SyntaxError|uncaught|UnhandledPromiseRejection|Pthread.*error|Broken pipe|SIGPIPE|hs_err|fatal(?: error)?|Internal Error|wasm trap|unreachable|CALL MISMATCH' "$log"; then
    reject "diagnostic-$mode"
  fi
}
# Dump-only structural run. Its timing is diagnostic and is not trusted.
# shellcheck disable=SC2086
run_supervised dump "$WORK/dump/structure.wasm" "$WORK/dump.log" $BASE \
  -cp "$WORK/classes" ZeroReferenceStoreGroupPerfProbe dump
"$WASM_DIS" "$WORK/dump/structure.wasm" >"$WORK/dump/structure.wat" \
  || reject wasm-dis
WASM_DIS="$WASM_DIS" node "$WASM_CHECKER" "$WORK/dump/structure.wasm" \
  "$WORK/dump/structure.wat" --self-test >"$WORK/wasm-check.log" 2>&1 \
  || reject wasm-structure
cmp -s "$WORK/dump/structure.wasm" "$PUBLICATION/checks/structure.wasm" \
  || reject publication-module-drift
if node "$PRODUCTION_CHECKER" "$WORK/dump/structure.wasm" \
    "$WORK/dump/structure.wat" >"$WORK/production-negative.log" 2>&1; then
  reject production-checker-accepted-perf-module
fi
echo 'production-acceptance-negative=result=pass' >>"$WORK/production-negative.log"
# One trusted process owns installation, pre-warmup aging/GC, all 30 warmups,
# five ordered candidate triads, two excluded confirmations, and the 93 hard
# windows.  It exits before any report-only diagnostic process starts.
# shellcheck disable=SC2086
run_supervised perf "$WORK/dump/perf.wasm" "$WORK/perf.log" $BASE \
  -cp "$WORK/classes" ZeroReferenceStoreGroupPerfProbe perf
cmp -s "$WORK/dump/structure.wasm" "$WORK/dump/perf.wasm" \
  || reject module-drift
node "$LOG_CHECKER" "$WORK/perf.log" final \
  >"$WORK/raw.csv" 2>"$WORK/log-check.err" \
  || reject performance-oracle
rg -q '^C3A_PERF_STATS .* windows=93 confirmations=6 result=GO$' "$WORK/raw.csv" \
  || reject terminal-go
rg '^candidate,' "$WORK/raw.csv" >"$WORK/pilots.csv" || reject pilots-csv
rg '^confirmation,' "$WORK/raw.csv" >"$WORK/confirmations.csv" \
  || reject confirmations-csv
rg '^trusted,' "$WORK/raw.csv" >"$WORK/trusted.csv" || reject trusted-csv
rg '^(PERF_(WARMUP|CALIBRATION|CANDIDATE|CONFIRMATIONS|TRIADS|TRIAD)|ZERO_REFERENCE_STORE_GROUP_PERF_DONE)' \
  "$WORK/perf.log" >"$WORK/order.log" || reject order-log
rg '^C3A_PERF_(CALIBRATION|CONFIRMATIONS|COUNTERS|STATS)' "$WORK/raw.csv" \
  >"$WORK/counters.log" || reject counters-log
# Diagnostics are intentionally outside the acceptance process and cannot
# influence its calibration, ordering, ratios, or terminal PERF_DONE marker.
DIAGNOSTIC_RESULT=pass
DIAGNOSTIC_REASON=none
diagnostic_dump=$WORK/dump/diagnostics.wasm
diagnostic_log=$WORK/diagnostics.log
if [ -e "$diagnostic_dump" ]; then
  DIAGNOSTIC_RESULT=fail; DIAGNOSTIC_REASON=stale-dump
else
  # shellcheck disable=SC2086
  MCWEB_ZERO_REFERENCE_STORE_GROUP_PERF_WASM_DUMP="$diagnostic_dump" \
    "$TIMEOUT" --signal=TERM --kill-after=5s 900 "$RUN_JAVA" $BASE \
    -cp "$WORK/classes" ZeroReferenceStoreGroupPerfProbe diagnostics \
    >"$diagnostic_log" 2>&1 &
  RUN_PID=$!
  if wait "$RUN_PID"; then diagnostic_status=0; else diagnostic_status=$?; fi
  RUN_PID=
  if [ "$diagnostic_status" -ne 0 ]; then
    DIAGNOSTIC_RESULT=fail; DIAGNOSTIC_REASON=runtime-status-$diagnostic_status
  elif [ ! -s "$diagnostic_dump" ]; then
    DIAGNOSTIC_RESULT=fail; DIAGNOSTIC_REASON=missing-dump
  elif ! cmp -s "$WORK/dump/structure.wasm" "$diagnostic_dump"; then
    DIAGNOSTIC_RESULT=fail; DIAGNOSTIC_REASON=module-drift
  elif rg -qi 'ReferenceError|TypeError|RangeError|SyntaxError|uncaught|UnhandledPromiseRejection|Pthread.*error|Broken pipe|SIGPIPE|hs_err|fatal(?: error)?|Internal Error|wasm trap|unreachable|CALL MISMATCH' "$diagnostic_log"; then
    DIAGNOSTIC_RESULT=fail; DIAGNOSTIC_REASON=diagnostic
  elif ! node "$LOG_CHECKER" "$diagnostic_log" diagnostics \
      >"$WORK/diagnostics-check.log" 2>&1; then
    DIAGNOSTIC_RESULT=fail; DIAGNOSTIC_REASON=oracle
  fi
fi
printf 'C3A_PERF_DIAGNOSTIC acceptance=0 result=%s reason=%s\n' \
  "$DIAGNOSTIC_RESULT" "$DIAGNOSTIC_REASON" >"$WORK/diagnostic-status.log"
cp "$WORK/perf.log" "$STAGE/logs/perf.log"
[ ! -f "$WORK/diagnostics.log" ] || cp "$WORK/diagnostics.log" "$STAGE/logs/diagnostics.log"
cp "$WORK/dump.log" "$STAGE/logs/dump.log"
cp "$WORK/raw.csv" "$STAGE/checks/raw.csv"
[ ! -f "$WORK/diagnostics-check.log" ] || cp "$WORK/diagnostics-check.log" "$STAGE/checks/diagnostics-check.log"
cp "$WORK/pilots.csv" "$WORK/confirmations.csv" "$WORK/trusted.csv" \
  "$WORK/order.log" "$WORK/counters.log" "$WORK/diagnostic-status.log" \
  "$STAGE/checks/"
cp "$WORK/wasm-check.log" "$STAGE/checks/wasm-check.log"
cp "$WORK/production-negative.log" "$STAGE/checks/production-negative.log"
cp "$WORK/focused-prerequisite.log" "$WORK/publication-prerequisite.log" \
  "$WORK/manifest-check.log" "$WORK/source-check.log" "$STAGE/checks/"
cp "$WORK/dump/structure.wasm" "$STAGE/checks/module.wasm"
cp "$WORK/dump/structure.wat" "$STAGE/checks/module.wat"
cp "$LIBJVM" "$STAGE/runtime/libjvm.so"
cp "$BASELINE" "$STAGE/source/zeroWasmBaseline.cpp"
cp "$ROOT/tests/ZeroReferenceStoreGroupPerfFixture.java" "$STAGE/assets/"
cp "$ROOT/tests/ZeroReferenceStoreGroupPerfProbe.java" "$STAGE/assets/"
cp "$WASM_CHECKER" "$PRODUCTION_CHECKER" "$LOG_CHECKER" "$SOURCE_CHECKER" \
  "$MANIFEST_CHECKER" "$NESTED_CHECKER" "$MANIFEST" "$LOCK_HELPER" "$0" \
  "$STAGE/assets/"
mkdir -p "$STAGE/prerequisite/focused" "$STAGE/prerequisite/publication"
cp -R "$FOCUSED"/. "$STAGE/prerequisite/focused/"
cp -R "$PUBLICATION"/. "$STAGE/prerequisite/publication/"
(cd "$STAGE" && shasum -a 256 source/zeroWasmBaseline.cpp runtime/libjvm.so \
  checks/module.wasm assets/zero-reference-store-group-c3a-manifest.sha256 \
  >checks/current-provenance.sha256)
(cd "$STAGE" && find . -type f ! -name evidence.index ! -name evidence.index.sha256 \
  -print | LC_ALL=C sort | while IFS= read -r path; do \
    sha=$(shasum -a 256 "$path" | awk '{print $1}'); bytes=$(wc -c <"$path" | tr -d ' '); \
    printf '%s  %s  %s\n' "$sha" "$bytes" "${path#./}"; done >evidence.index)
(cd "$STAGE" && shasum -a 256 evidence.index >evidence.index.sha256)
mv "$STAGE" "$EVIDENCE"
FINISH=$(date +%s)
echo "ACCEPT C3a-perf measurement-only=1 diagnostic-result=$DIAGNOSTIC_RESULT evidence=$EVIDENCE start=$START finish=$FINISH exit=0"
