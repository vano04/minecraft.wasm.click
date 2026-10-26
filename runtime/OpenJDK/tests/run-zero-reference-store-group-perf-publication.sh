#!/bin/sh
# Targeted C3a canonical two-slot long publication gate. Measurement acceptance=0.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JDK=$ROOT/work/jdk25
BASELINE=$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp
BYTECODE=$JDK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp
LIBJVM=$JDK/build/wasm-zero/jdk/lib/zero/libjvm.so
JAVAC=/opt/homebrew/opt/openjdk@25/bin/javac
JAR=/opt/homebrew/opt/openjdk@25/bin/jar
TIMEOUT=/opt/homebrew/bin/timeout
WASM_DIS=/opt/homebrew/bin/wasm-dis
RUN_JAVA=$ROOT/run-java.sh
LOCK_HELPER=$ROOT/tests/zero-runtime-gate-lock.sh
WASM_CHECKER=$ROOT/tests/check-zero-reference-store-group-perf-wasm.mjs
LOG_CHECKER=$ROOT/tests/check-zero-reference-store-group-perf-publication-log.mjs
SOURCE_CHECKER=$ROOT/tests/check-zero-reference-store-group-perf-publication-source.mjs
START=$(date +%s)
WORK=$(mktemp -d /private/tmp/mcweb-zero-reference-store-group-perf-publication.XXXXXX)
EVIDENCE=${C3A_PUBLICATION_OUTPUT:?explicit fresh C3A_PUBLICATION_OUTPUT is required}
STAGE=$EVIDENCE.tmp.$$
RUN_PID=
reject() { echo "REJECT C3a-perf-publication reason=$1 work=$WORK stage=$STAGE" >&2; exit 1; }
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
for input in "$LOCK_HELPER" "$WASM_CHECKER" "$LOG_CHECKER" "$SOURCE_CHECKER" "$BASELINE" \
  "$BYTECODE" "$LIBJVM" \
  "$ROOT/tests/ZeroReferenceArrayStoreFixture.java" \
  "$ROOT/tests/ZeroReferenceArrayStoreNearMiss.java" \
  "$ROOT/tests/ZeroReferenceStoreGroupPerfFixture.java" \
  "$ROOT/tests/ZeroReferenceStoreGroupPerfProbe.java"; do
  [ -f "$input" ] || reject "input-$(basename "$input")"
done
case "$EVIDENCE" in
  /private/tmp/mcweb-zero-reference-store-group-perf-publication-accept.*) ;;
  *) reject unsafe-evidence-root ;;
esac
. "$LOCK_HELPER"
runtime_gate_lock_acquire || reject shared-lock
[ ! -e "$EVIDENCE" ] && [ ! -e "$STAGE" ] || reject evidence-collision
[ "$LIBJVM" -nt "$BASELINE" ] || reject stale-libjvm-baseline
[ "$LIBJVM" -nt "$BYTECODE" ] || reject stale-libjvm-bytecode
mkdir -p "$WORK/classes" "$WORK/dump" "$STAGE/runtime" "$STAGE/assets" \
  "$STAGE/logs" "$STAGE/checks" "$STAGE/source"

# Whole-file oracle proves the obsolete generic helper is absent, no long is
# written at top[0], and the dedicated canonical helper has two exact callers.
SOURCE_SHA_START=$(shasum -a 256 "$BASELINE" | awk '{print $1}')
node "$SOURCE_CHECKER" "$BASELINE" --self-test >"$WORK/source-check.log" 2>&1 \
  || reject source-publication

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
  mode=$1; dump=$2; log=$3; shift 3
  [ ! -e "$dump" ] || reject "stale-dump-$mode"
  MCWEB_ZERO_REFERENCE_STORE_GROUP_PERF_WASM_DUMP="$dump" \
    "$TIMEOUT" --signal=TERM --kill-after=5s 300 "$RUN_JAVA" "$@" \
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

# Structural trust is established from a fresh dump before the publication
# transcript is interpreted semantically.
# shellcheck disable=SC2086
run_supervised structure "$WORK/dump/structure.wasm" "$WORK/structure.log" $BASE \
  -cp "$WORK/classes" ZeroReferenceStoreGroupPerfProbe dump
"$WASM_DIS" "$WORK/dump/structure.wasm" >"$WORK/dump/structure.wat" || reject wasm-dis
WASM_DIS="$WASM_DIS" node "$WASM_CHECKER" "$WORK/dump/structure.wasm" \
  "$WORK/dump/structure.wat" --self-test >"$WORK/wasm-check.log" 2>&1 \
  || reject wasm-structure

# shellcheck disable=SC2086
run_supervised publication "$WORK/dump/publication.wasm" "$WORK/publication.log" $BASE \
  -cp "$WORK/classes" ZeroReferenceStoreGroupPerfProbe publication
cmp -s "$WORK/dump/structure.wasm" "$WORK/dump/publication.wasm" \
  || reject module-drift
node "$LOG_CHECKER" "$WORK/publication.log" --self-test \
  >"$WORK/publication-check.log" 2>&1 || reject publication-oracle
rg -qx 'ZERO_REFERENCE_STORE_GROUP_PERF_PUBLICATION result=pass' "$WORK/publication.log" \
  || reject terminal
SOURCE_SHA_END=$(shasum -a 256 "$BASELINE" | awk '{print $1}')
[ "$SOURCE_SHA_END" = "$SOURCE_SHA_START" ] || reject source-drift

cp "$WORK/publication.log" "$STAGE/logs/"
cp "$WORK/structure.log" "$STAGE/logs/"
cp "$WORK/source-check.log" "$WORK/wasm-check.log" \
  "$WORK/publication-check.log" "$STAGE/checks/"
cp "$WORK/dump/structure.wasm" "$WORK/dump/structure.wat" "$STAGE/checks/"
cp "$LIBJVM" "$STAGE/runtime/"
cp "$BASELINE" "$STAGE/source/zeroWasmBaseline.cpp"
cp "$ROOT/tests/ZeroReferenceStoreGroupPerfFixture.java" \
  "$ROOT/tests/ZeroReferenceStoreGroupPerfProbe.java" "$WASM_CHECKER" \
  "$LOG_CHECKER" "$SOURCE_CHECKER" "$0" "$STAGE/assets/"
(cd "$STAGE" && shasum -a 256 source/zeroWasmBaseline.cpp \
  >checks/source-snapshot.sha256)
(cd "$STAGE" && find . -type f ! -name evidence.index ! -name evidence.index.sha256 \
  -print | LC_ALL=C sort | while IFS= read -r path; do \
    sha=$(shasum -a 256 "$path" | awk '{print $1}'); bytes=$(wc -c <"$path" | tr -d ' '); \
    printf '%s  %s  %s\n' "$sha" "$bytes" "${path#./}"; done >evidence.index)
(cd "$STAGE" && shasum -a 256 evidence.index >evidence.index.sha256)
mv "$STAGE" "$EVIDENCE"
FINISH=$(date +%s)
echo "ACCEPT C3a-perf-publication measurement-acceptance=0 evidence=$EVIDENCE start=$START finish=$FINISH exit=0"
