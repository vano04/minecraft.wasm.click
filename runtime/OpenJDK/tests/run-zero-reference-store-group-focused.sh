#!/bin/sh
# Focused final-0019 C3a correctness gate. No performance or legacy suite.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JDK=$ROOT/work/jdk25
JAVAC=/opt/homebrew/opt/openjdk@25/bin/javac
JAR=/opt/homebrew/opt/openjdk@25/bin/jar
TIMEOUT=/opt/homebrew/bin/timeout
NODE=node
RUN_JAVA=$ROOT/run-java.sh
LOCK_HELPER=$ROOT/tests/zero-runtime-gate-lock.sh
MANIFEST=$ROOT/tests/zero-reference-store-group-c3a-manifest.sha256
MANIFEST_CHECKER=$ROOT/tests/check-zero-reference-store-group-manifest.mjs
CLASS_CHECKER=$ROOT/tests/check-zero-reference-store-group-class.mjs
WAT_CHECKER=$ROOT/tests/check-zero-reference-store-group-wat.mjs
LOG_CHECKER=$ROOT/tests/check-zero-reference-store-group-log.mjs
FIXTURE=$ROOT/tests/ZeroReferenceStoreGroupFixture.java
NEAR=$ROOT/tests/ZeroReferenceStoreGroupNearMiss.java
PROBE=$ROOT/tests/ZeroReferenceStoreGroupProbe.java
CARD_HELPER=$ROOT/tests/ZeroReferenceArrayStoreFixture.java
CARD_NEAR=$ROOT/tests/ZeroReferenceArrayStoreNearMiss.java
LIBJVM=$JDK/build/wasm-zero/jdk/lib/zero/libjvm.so
COLD_EVIDENCE=${C3A_COLD_EVIDENCE:?explicit fresh C3A_COLD_EVIDENCE is required}
STARTED_EPOCH=$(date +%s)
WORK=$(mktemp -d /private/tmp/mcweb-zero-reference-store-group-focused.XXXXXX)
EVIDENCE=${C3A_FOCUSED_OUTPUT:?explicit fresh C3A_FOCUSED_OUTPUT is required}
STAGE=$EVIDENCE.tmp.$$
RUN_PID=

reject() {
  echo "REJECT M2-C3a focused reason=$1 work=$WORK stage=$STAGE" >&2
  exit 1
}
terminate_owned() {
  pid=$1
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  count=0
  while [ "$count" -lt 20 ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    count=$((count + 1)); sleep 0.05
  done
  kill -KILL "$pid" 2>/dev/null || true
}
cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ -z "$RUN_PID" ] || terminate_owned "$RUN_PID"
  runtime_gate_lock_release 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM

for tool in "$JAVAC" "$JAR" "$TIMEOUT" "$RUN_JAVA"; do
  [ -x "$tool" ] || reject "tool-$(basename "$tool")"
done
for input in "$LOCK_HELPER" "$MANIFEST" "$MANIFEST_CHECKER" "$CLASS_CHECKER" \
    "$WAT_CHECKER" "$LOG_CHECKER" "$FIXTURE" "$NEAR" "$PROBE" \
    "$CARD_HELPER" "$CARD_NEAR" "$LIBJVM" "$COLD_EVIDENCE/evidence.index" \
    "$COLD_EVIDENCE/evidence.index.sha256" "$COLD_EVIDENCE/checks/module.wasm" \
    "$COLD_EVIDENCE/checks/module.wat"; do
  [ -f "$input" ] || reject "input-$(basename "$input")"
done
case "$COLD_EVIDENCE" in
  /private/tmp/mcweb-zero-reference-store-group-c3a-cold-accept.*) ;;
  *) reject unsafe-cold-evidence-root ;;
esac
case "$EVIDENCE" in
  /private/tmp/mcweb-zero-reference-store-group-focused-accept.*) ;;
  *) reject unsafe-evidence-root ;;
esac
. "$LOCK_HELPER"
runtime_gate_lock_acquire || reject shared-lock
[ ! -e "$EVIDENCE" ] && [ ! -e "$STAGE" ] || reject evidence-collision
mkdir -p "$WORK/classes" "$WORK/dumps" "$WORK/checks" "$STAGE/current/assets" \
  "$STAGE/current/runtime" \
  "$STAGE/logs" "$STAGE/cold"

(cd "$COLD_EVIDENCE" && shasum -a 256 -c evidence.index.sha256) \
  >"$WORK/check-cold-sidecar.log" 2>&1 || reject cold-sidecar
COLD_MODULE_SHA=$(shasum -a 256 "$COLD_EVIDENCE/checks/module.wasm" | awk '{print $1}')
COLD_WAT_SHA=$(shasum -a 256 "$COLD_EVIDENCE/checks/module.wat" | awk '{print $1}')
rg -qx "generated-module-sha256=$COLD_MODULE_SHA" "$MANIFEST" \
  || reject cold-module-manifest
rg -qx "generated-wat-sha256=$COLD_WAT_SHA" "$MANIFEST" \
  || reject cold-wat-manifest
"$NODE" "$WAT_CHECKER" "$COLD_EVIDENCE/checks/module.wasm" \
  "$COLD_EVIDENCE/checks/module.wat" >"$WORK/check-cold-oracle.log" 2>&1 \
  || reject cold-oracle
"$NODE" "$MANIFEST_CHECKER" "$ROOT" "$MANIFEST" \
  >"$WORK/check-manifest.log" 2>&1 || reject manifest

"$JAVAC" -g:none -d "$WORK/classes" "$FIXTURE" "$NEAR" "$PROBE" \
  "$CARD_HELPER" "$CARD_NEAR" >"$WORK/javac.log" 2>&1 || reject javac
"$NODE" "$CLASS_CHECKER" "$WORK/classes/ZeroReferenceStoreGroupFixture.class" \
  >"$WORK/check-class.log" 2>&1 || reject class
"$JAR" --create --date=2026-01-01T00:00:00+00:00 \
  --file "$WORK/fixture.jar" -C "$WORK/classes" . || reject jar
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceStoreGroupFixture.class" | awk '{print $1}')
NEAR_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceStoreGroupNearMiss.class" | awk '{print $1}')
PROBE_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceStoreGroupProbe.class" | awk '{print $1}')
HELPER_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceArrayStoreFixture.class" | awk '{print $1}')
HELPER_NEAR_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceArrayStoreNearMiss.class" | awk '{print $1}')
JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
for row in "generated-class-sha256=$CLASS_SHA" \
  "generated-near-class-sha256=$NEAR_SHA" \
  "generated-probe-class-sha256=$PROBE_SHA" \
  "generated-card-helper-class-sha256=$HELPER_SHA" \
  "generated-card-helper-near-class-sha256=$HELPER_NEAR_SHA" \
  "generated-fixture-jar-sha256=$JAR_SHA"; do
  rg -qx "$row" "$MANIFEST" || reject generated-manifest-drift
done
DEPS=ZeroReferenceStoreGroupNearMiss.class=sha256:$NEAR_SHA,ZeroReferenceStoreGroupProbe.class=sha256:$PROBE_SHA,ZeroReferenceArrayStoreFixture.class=sha256:$HELPER_SHA,ZeroReferenceArrayStoreNearMiss.class=sha256:$HELPER_NEAR_SHA
BASE="-Xmx256m -Xms16m -XX:+UnlockExperimentalVMOptions -XX:+UseSerialGC -XX:+UseZeroWasmLinkedReferenceStoreGroup -XX:+ZeroWasmLinkedGroupVerbose -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS"

run_lane() {
  name=$1; marker=$2; checker_mode=$3; detail=$4; trusted=$5; shift 5
  log=$WORK/$name.log
  dump=$WORK/dumps/$name.wasm
  [ ! -e "$dump" ] || reject "stale-dump-$name"
  MCWEB_ZERO_REFERENCE_STORE_GROUP_WASM_DUMP="$dump" \
    "$TIMEOUT" --signal=TERM --kill-after=5s 180 "$RUN_JAVA" "$@" \
    >"$log" 2>&1 &
  RUN_PID=$!
  if wait "$RUN_PID"; then status=0; else status=$?; fi
  RUN_PID=
  [ "$status" -eq 0 ] || reject "runtime-$name-status-$status"
  if rg -qi 'ReferenceError|TypeError|RangeError|SyntaxError|uncaught|UnhandledPromiseRejection|Pthread.*error|Broken pipe|SIGPIPE|hs_err|fatal(?: error)?|Internal Error|wasm trap|unreachable|CALL MISMATCH' "$log"; then
    reject "runtime-diagnostic-$name"
  fi
  rg -q "$marker" "$log" || reject "terminal-$name"
  awk -v marker="$marker" '
    BEGIN { terminal=0; late=0; bad=0 }
    $0 ~ marker { terminal++; next }
    tolower($0) ~ /terminated worker/ {
      if (!terminal || $0 !~ /^received "6" command from terminated worker: [1-9][0-9]*$/) bad=1
      else late++
    }
    END { if (terminal != 1 || bad || late > 2) exit 1 }
  ' "$log" || reject "late-cmd6-$name"
  if [ "$trusted" -eq 1 ]; then
    [ -s "$dump" ] || reject "dump-missing-$name"
    lane_sha=$(shasum -a 256 "$dump" | awk '{print $1}')
    [ "$lane_sha" = "$COLD_MODULE_SHA" ] || reject "module-drift-$name"
  else
    [ ! -e "$dump" ] || reject "collision-installed-$name"
  fi
  if [ -n "$detail" ]; then
    "$NODE" "$LOG_CHECKER" "$log" "$checker_mode" "$detail" \
      >"$WORK/check-$name.log" 2>&1 || reject "transcript-$name"
  else
    "$NODE" "$LOG_CHECKER" "$log" "$checker_mode" \
      >"$WORK/check-$name.log" 2>&1 || reject "transcript-$name"
  fi
}

MATRIX='^reference-store-group direct=6 reexec=8 reject-array-unchanged=8 result=pass$'
SINGLE='^reference-store-group-single result=pass$'
OSR='^reference-store-group-osr checksum=512 result=pass$'
# shellcheck disable=SC2086
run_lane off "$MATRIX" off '' 0 -Xmx256m -Xms16m \
  -XX:+UnlockExperimentalVMOptions -XX:+UseSerialGC -XX:+ZeroWasmLinkedGroupVerbose \
  -cp "$WORK/classes" ZeroReferenceStoreGroupProbe matrix
# shellcheck disable=SC2086
run_lane linked "$MATRIX" linked '' 1 $BASE -cp "$WORK/classes" \
  ZeroReferenceStoreGroupProbe matrix
# shellcheck disable=SC2086
run_lane forced "$MATRIX" forced '' 1 $BASE \
  -XX:ZeroWasmLinkedReferenceStoreGroupMemoryLimitForTest=1 \
  -cp "$WORK/classes" ZeroReferenceStoreGroupProbe matrix
# shellcheck disable=SC2086
run_lane root '^reference-store-group-root identity=1 array-identity=1 weak=1$' \
  root '' 1 $BASE -XX:+ZeroWasmLinkedRefArrayStoreCardProbeForTest -Xlog:gc=info \
  -cp "$WORK/classes" ZeroReferenceStoreGroupProbe root

for mutation in compiler digest bytes memory metadata slot card-layout group-edges poison; do
  # shellcheck disable=SC2086
  run_lane "cache-$mutation" "$SINGLE" cache "$mutation" 1 $BASE \
    -XX:ZeroWasmLinkedReferenceStoreGroupCacheMutationForTest="$mutation" \
    -cp "$WORK/classes" ZeroReferenceStoreGroupProbe single
done
for selftest in selftest-fresh-false selftest-fresh-throw; do
  # shellcheck disable=SC2086
  run_lane "cache-$selftest" "$SINGLE" selftest "$selftest" 1 $BASE \
    -XX:ZeroWasmLinkedReferenceStoreGroupCacheMutationForTest="$selftest" \
    -cp "$WORK/classes" ZeroReferenceStoreGroupProbe single
done

for spec in 'group UseZeroWasmLinkedGroup' 'int-load UseZeroWasmLinkedIntArray' \
  'int-store UseZeroWasmLinkedIntArrayStore' 'benchmark UseZeroWasmLinkedBenchmark' \
  'baseline UseZeroWasmBaseline' 'jit UseZeroWasmJIT' \
  'ref-load UseZeroWasmLinkedRefArrayLoad' 'ref-store UseZeroWasmLinkedRefArrayStore'; do
  set -- $spec; lane=$1; flag=$2
  # shellcheck disable=SC2086
  run_lane "collision-$lane" "$MATRIX" collision "$lane" 0 $BASE \
    -XX:+"$flag" -cp "$WORK/classes" ZeroReferenceStoreGroupProbe matrix
done
# shellcheck disable=SC2086
run_lane collision-c1-c2-group "$MATRIX" collision 'group,ref-load,ref-store' 0 $BASE \
  -XX:+UseZeroWasmLinkedGroup -XX:+UseZeroWasmLinkedRefArrayLoad \
  -XX:+UseZeroWasmLinkedRefArrayStore -cp "$WORK/classes" \
  ZeroReferenceStoreGroupProbe matrix
# shellcheck disable=SC2086
run_lane osr-jit "$OSR" osr jit 0 $BASE -XX:+UseZeroWasmJIT \
  -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITThreshold=1 \
  -XX:ZeroWasmJITOnly=runOsr -cp "$WORK/classes" ZeroReferenceStoreGroupProbe osr
# shellcheck disable=SC2086
run_lane osr-aggregate "$OSR" osr \
  'group,int-load,int-store,benchmark,ref-load,ref-store,baseline,jit' 0 $BASE \
  -XX:+UseZeroWasmLinkedGroup -XX:+UseZeroWasmLinkedIntArray \
  -XX:+UseZeroWasmLinkedIntArrayStore -XX:+UseZeroWasmLinkedBenchmark \
  -XX:+UseZeroWasmLinkedRefArrayLoad -XX:+UseZeroWasmLinkedRefArrayStore \
  -XX:+UseZeroWasmBaseline -XX:+UseZeroWasmJIT -XX:+ZeroWasmJITVerbose \
  -XX:ZeroWasmJITThreshold=1 -XX:ZeroWasmJITOnly=runOsr \
  -cp "$WORK/classes" ZeroReferenceStoreGroupProbe osr

# No explicit Full GC may occur in the post-store window.
if sed -n '/GROUP_ROOT_POST_STORE_YOUNG_BEGIN/,/GROUP_ROOT_POST_STORE_YOUNG_END/p' \
    "$PROBE" | rg -q 'System\.gc'; then
  reject root-explicit-post-store-full
fi

cp "$WORK/check-manifest.log" "$WORK/check-class.log" \
  "$WORK/check-cold-oracle.log" "$WORK/check-cold-sidecar.log" \
  "$WORK/fixture.jar" "$STAGE/current/"
cp "$MANIFEST" "$MANIFEST_CHECKER" "$CLASS_CHECKER" "$WAT_CHECKER" \
  "$LOG_CHECKER" "$FIXTURE" "$NEAR" "$PROBE" "$CARD_HELPER" "$CARD_NEAR" \
  "$0" "$LOCK_HELPER" "$STAGE/current/assets/"
cp "$LIBJVM" /private/tmp/mcweb-c3a-focused-hotspot-build.log \
  /private/tmp/mcweb-c3a-focused-jdk-build.log "$STAGE/current/runtime/"
cp "$WORK"/*.log "$STAGE/logs/"
cp -R "$COLD_EVIDENCE"/. "$STAGE/cold/"
FINISHED_EPOCH=$(date +%s)
{
  printf '%s\n' 'm2-c3a-focused-atomic-evidence-v1' \
    'accept=m2-c3a-focused-final-0019 exit=0'
  printf 'started-epoch=%s finished-epoch=%s\n' "$STARTED_EPOCH" "$FINISHED_EPOCH"
  printf 'cold-module-sha=%s cold-wat-sha=%s nested-cold-index-sha=%s\n' \
    "$COLD_MODULE_SHA" "$COLD_WAT_SHA" \
    "$(shasum -a 256 "$COLD_EVIDENCE/evidence.index" | awk '{print $1}')"
  printf 'modes=off,linked,forced,root cache=9 rollback=2 collisions=8 aggregate=1 osr=2\n'
  printf 'linked=direct6,fallback8,events14,calls18,oop6,card6 forced=memory13,null1,calls0,stores0\n'
  printf 'root=old-array,young-child,clean-to-dirty,young-only,weak-identity\n'
  printf 'gate-sha=%s manifest-sha=%s runtime-sha=%s\n' \
    "$(shasum -a 256 "$0" | awk '{print $1}')" \
    "$(shasum -a 256 "$MANIFEST" | awk '{print $1}')" \
    "$(shasum -a 256 "$LIBJVM" | awk '{print $1}')"
  find "$STAGE/current" "$STAGE/logs" "$STAGE/cold" -type f -print \
    | LC_ALL=C sort | while IFS= read -r file; do
        relative=${file#"$STAGE/"}
        printf 'bundle-file path=%s sha256=%s bytes=%s\n' "$relative" \
          "$(shasum -a 256 "$file" | awk '{print $1}')" \
          "$(wc -c <"$file" | awk '{print $1}')"
      done
} >"$STAGE/evidence.index"
shasum -a 256 "$STAGE/evidence.index" | awk '{print $1 "  evidence.index"}' \
  >"$STAGE/evidence.index.sha256"
sync
mv -- "$STAGE" "$EVIDENCE"
printf 'm2-c3a-focused=ACCEPT module-sha=%s evidence-root=%s\n' \
  "$COLD_MODULE_SHA" "$EVIDENCE"
