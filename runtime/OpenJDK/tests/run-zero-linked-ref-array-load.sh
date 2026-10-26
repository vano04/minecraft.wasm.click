#!/bin/sh
# OSS-only M2-C1 reference-array load gate.  This gate exercises one exact
# Object[]/aaload fixture through a cold, one-export Wasm module.  It is not a
# general JAR compiler, browser proof, Minecraft proof, or proprietary-image
# package.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JAVAC=${JAVAC:-/opt/homebrew/opt/openjdk@25/bin/javac}
JAR=${JAR:-/opt/homebrew/opt/openjdk@25/bin/jar}
JAVAP=${JAVAP:-/opt/homebrew/opt/openjdk@25/bin/javap}
WASM_DIS=${WASM_DIS:-/opt/homebrew/bin/wasm-dis}
NODE=${NODE:-node}
TIMEOUT=${TIMEOUT:-/opt/homebrew/bin/timeout}
RUN_JAVA="$ROOT/run-java.sh"
JDK="$ROOT/work/jdk25"
LOCK_HELPER="$ROOT/tests/zero-runtime-gate-lock.sh"
LOG_CHECKER="$ROOT/tests/check-zero-linked-ref-array-load-log.mjs"
WAT_CHECKER="$ROOT/tests/check-zero-linked-ref-array-load-wat.mjs"
PATCH_BOUNDARY_CHECKER="$ROOT/tests/check-zero-0019-patch-boundary.sh"
LEGACY_PATCH_BOUNDARY_CHECKER="$ROOT/tests/check-zero-0015-patch-boundary.sh"
PROVENANCE19="$ROOT/tests/check-zero-0019-legacy-provenance.sh"
PROVENANCE18="$ROOT/tests/check-zero-0018-legacy-provenance.sh"
LEGACY_SUITE_PRODUCER="$ROOT/tests/run-zero-0019-final-legacy-suite.sh"
MANIFEST="$ROOT/tests/zero-linked-ref-array-load-manifest.sha256"
PATCH15="$ROOT/patches/0015-zero-wasm-linked-int-array-store.patch"
PATCH16="$ROOT/patches/0016-zero-wasm-linked-ref-array-load.patch"
PATCH17="$ROOT/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch"
PATCH18="$ROOT/patches/0018-zero-wasm-linked-ref-array-store.patch"
PATCH19="$ROOT/patches/0019-zero-wasm-reference-store-group.patch"
FIXTURE="$ROOT/tests/ZeroReferenceArrayLoadFixture.java"
NEAR_MISS="$ROOT/tests/ZeroReferenceArrayLoadNearMiss.java"
WASM_REF=/private/tmp/mcweb-zero-linked-ref-array-load.wasm
STARTED_EPOCH=$(date +%s)
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-ref-array-load.XXXXXX)
PATCH_BOUNDARY_EVIDENCE=$WORK/patch-boundary.log
EVIDENCE_ROOT=${C1_EVIDENCE_ROOT:?explicit fresh C1_EVIDENCE_ROOT is required}
EVIDENCE_STAGE=$EVIDENCE_ROOT.tmp.$$
LEGACY_EVIDENCE_FILES="\
/private/tmp/mcweb-0019-audit-setup.log \
/private/tmp/mcweb-0019-audit-patch-boundary.log \
/private/tmp/mcweb-0019-audit-m1-group.log \
/private/tmp/mcweb-0019-audit-m1-gc.log \
/private/tmp/mcweb-0019-audit-m1-alloc.log \
/private/tmp/mcweb-0019-audit-m1-class-init.log \
/private/tmp/mcweb-0019-audit-m1-virtual.log \
/private/tmp/mcweb-0019-audit-m1-idiv.log \
/private/tmp/mcweb-0019-audit-m1-throw.log \
/private/tmp/mcweb-0019-audit-m2a-array.log \
/private/tmp/mcweb-0019-audit-m2b-store.log \
/private/tmp/mcweb-0019-audit-p1-performance.log"
RUN_PID=

terminate_owned() {
  root=$1
  [ -n "$root" ] || return 0
  kill -TERM "$root" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    kill -0 "$root" 2>/dev/null || return 0
    sleep 0.05
  done
  kill -KILL "$root" 2>/dev/null || true
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "${RUN_PID:-}" ]; then
    terminate_owned "$RUN_PID"
    RUN_PID=
  fi
  runtime_gate_lock_release 2>/dev/null || true
  case "$WORK" in
    /private/tmp/mcweb-zero-linked-ref-array-load.??????) rm -rf -- "$WORK" || true ;;
  esac
  case "$EVIDENCE_STAGE" in
    /private/tmp/mcweb-zero-linked-ref-array-load-0019-accept.*.tmp.[0-9]*)
      rm -rf -- "$EVIDENCE_STAGE" || true ;;
  esac
  exit "$status"
}
trap cleanup EXIT INT TERM

reject() {
  echo "REJECT M2-C1 linked reference-array load gate: $*" >&2
  for name in off linked forced root negative collision-group collision-int-load \
      collision-int-store collision-benchmark collision-baseline collision-jit \
      collision-legacy collision-osr collision-aggregate-osr cache-compiler \
      cache-digest cache-bytes cache-memory cache-metadata cache-slot cache-poison; do
    [ -f "$WORK/$name.log" ] && cp "$WORK/$name.log" \
      "/private/tmp/mcweb-zero-linked-ref-array-load-$name-failure.log" || true
  done
  exit 1
}

[ -x "$JAVAC" ] || reject "javac unavailable: $JAVAC"
[ -x "$JAR" ] || reject "jar unavailable: $JAR"
[ -x "$JAVAP" ] || reject "javap unavailable: $JAVAP"
[ -x "$WASM_DIS" ] || reject "wasm-dis unavailable: $WASM_DIS"
[ -x "$(command -v "$NODE" 2>/dev/null || true)" ] || reject "node unavailable: $NODE"
[ -x "$TIMEOUT" ] || reject "timeout unavailable: $TIMEOUT"
[ -x "$RUN_JAVA" ] || reject "run-java.sh unavailable"
[ -d "$JDK/.git" ] || reject "prepared OpenJDK checkout unavailable"
[ -r "$LOCK_HELPER" ] || reject "runtime lock helper unavailable"
[ -f "$FIXTURE" ] && [ -f "$NEAR_MISS" ] || reject "fixture source closure unavailable"
[ -f "$LOG_CHECKER" ] && [ -f "$WAT_CHECKER" ] \
  && [ -f "$PATCH_BOUNDARY_CHECKER" ] && [ -f "$LEGACY_PATCH_BOUNDARY_CHECKER" ] \
  || reject "checker closure unavailable"
[ -x "$PROVENANCE19" ] || reject "0019 provenance helper unavailable"
[ -x "$PROVENANCE18" ] || reject "0018 provenance helper unavailable"
[ -x "$LEGACY_SUITE_PRODUCER" ] || reject "0019 legacy suite producer unavailable"
[ -f "$MANIFEST" ] || reject "independent fixture manifest unavailable"
[ -f "$PATCH15" ] || reject "accepted 0015 patch unavailable"
[ -f "$PATCH16" ] || reject "accepted 0016 patch unavailable"
[ -f "$PATCH17" ] || reject "accepted 0017 patch unavailable"
[ -f "$PATCH18" ] || reject "accepted 0018 patch unavailable"
[ -f "$PATCH19" ] || reject "accepted 0019 patch unavailable"

. "$LOCK_HELPER"
if [ "${MCWEB_RUNTIME_GATE_LOCK_PROBE:-0}" = 1 ]; then
  runtime_gate_lock_acquire || exit 1
  exit 0
fi
runtime_gate_lock_acquire || reject "another Zero runtime gate owns the lock"
runtime_gate_lock_self_test "$0" "$WASM_REF" || reject "runtime lock self-test failed"
printf '%s\n' 'runtime-gate-lock=self-test-pass'
case "$EVIDENCE_ROOT" in
  /private/tmp/mcweb-zero-linked-ref-array-load-0019-accept.*) ;;
  *) reject "unsafe explicit C1 evidence root" ;;
esac
# Stale acceptance and boundary artifacts are replaced only while this process
# owns the shared runtime gate lock. Failure cleanup removes only our stage.
rm -rf -- "$EVIDENCE_ROOT" "$EVIDENCE_STAGE"
sh -n "$0" || reject "gate shell syntax"

SOURCE_BASELINE="$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp"
SOURCE_INTERPRETER="$JDK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp"
SOURCE_GLOBALS="$JDK/src/hotspot/cpu/zero/globals_zero.hpp"
[ -f "$SOURCE_BASELINE" ] && [ -f "$SOURCE_INTERPRETER" ] && [ -f "$SOURCE_GLOBALS" ] \
  || reject "prepared source files unavailable"
JDK_HEAD=$(git -c core.fsmonitor=false -c gc.auto=0 -c maintenance.auto=false -C "$JDK" rev-parse HEAD)
PATCH15_SHA=$(shasum -a 256 "$PATCH15" | awk '{print $1}')
PATCH16_SHA=$(shasum -a 256 "$PATCH16" | awk '{print $1}')
PATCH17_SHA=$(shasum -a 256 "$PATCH17" | awk '{print $1}')
PATCH18_SHA=$(shasum -a 256 "$PATCH18" | awk '{print $1}')
PATCH19_SHA=$(shasum -a 256 "$PATCH19" | awk '{print $1}')
rg -q 'UseZeroWasmLinkedRefArrayLoad' "$SOURCE_GLOBALS" \
  || reject "reference-array flag missing"
rg -q 'reference_array_fixture_class\(method\)' "$SOURCE_BASELINE" \
  || reject "holder classifier missing"
rg -q 'addFunction\(exportedLoad, "jiii"\)' \
  "$SOURCE_BASELINE" || reject "dynamic jiii registration missing"
check_c1_export_identity_source() {
  source=$1
  rg -q 'let cachedExportMatches = false;' "$source" \
    && rg -q 'cached\.slot !== cached\.ownedSlot \|\| !cachedExportMatches' "$source" \
    && rg -q 'getWasmTableEntry\(cached\.ownedSlot\) === cached\.export' "$source" \
    && rg -q 'const exportedLoad = instance\.exports\.referenceArrayLoad' "$source" \
    && rg -q 'Object\.defineProperty\(cache\[metadata\], "export"' "$source" \
    && rg -q 'case "poison":' "$source" \
    && rg -q 'const poisonProof = mutation === "poison"' "$source" \
    && rg -q 'poisonRemoved && !invalidation\.poisonCallableAfter' "$source" \
    && rg -q 'cacheIdentityProven = poisoning' "$source"
}
check_c1_export_identity_source "$SOURCE_BASELINE" \
  || reject "immutable C1 cached export identity missing"
C1_EXPORT_NEGATIVE="$WORK/c1-export-identity-negative.cpp"
sed 's/getWasmTableEntry(cached.ownedSlot) === cached.export/getWasmTableEntry(cached.ownedSlot) !== cached.export/' \
  "$SOURCE_BASELINE" >"$C1_EXPORT_NEGATIVE"
if check_c1_export_identity_source "$C1_EXPORT_NEGATIVE"; then
  reject "C1 cached-export identity source negative was accepted"
fi
! rg -q '9913|9914|reservedSlot|reserve.*slot' \
  "$SOURCE_BASELINE" "$SOURCE_INTERPRETER" || reject "physical slot contract leaked into source"
rg -q 'barrier->is_a\(BarrierSet::CardTableBarrierSet\)' "$SOURCE_BASELINE" \
  || reject "Serial/no-load-barrier guard missing"
rg -q 'layout->length_offset % 4|layout->base_offset % 4|element_size == \(int\)sizeof\(oop\)' \
  "$SOURCE_BASELINE" || reject "aligned Object[] layout guard missing"
rg -q 'array->klass\(\)->is_objArray_klass' "$SOURCE_BASELINE" \
  || reject "actual ObjArrayKlass guard missing"
rg -q 'push_oop\(tos, value\)' "$SOURCE_BASELINE" \
  || reject "returned oop push missing"
rg -q 'linked_prepare_state\(istate, tos, pc, code_base \+ return_bci, 1\)' \
  "$SOURCE_BASELINE" || reject "returned oop publish state missing"
check_stack_rollback_source() {
  source=$1
  rg -q 'const intptr_t saved_slots\[1\].*pre_tos\[0\]' "$source" \
    && rg -q 'const intptr_t saved_slots\[2\].*pre_tos\[0\].*pre_tos\[-1\]' \
      "$source" \
    && rg -q 'linked_restore_stack_slots\(pre_tos, saved_slots, 1\)' \
      "$source" \
    && rg -q 'linked_restore_stack_slots\(pre_tos, saved_slots, 2\)' \
      "$source"
}
check_stack_rollback_source "$SOURCE_BASELINE" \
  || reject "transactional stack-slot rollback missing"
ROLLBACK_NEGATIVE="$WORK/rollback-negative.cpp"
sed -E '/linked_restore_stack_slots\(pre_tos, saved_slots, [12]\);/d' \
  "$SOURCE_BASELINE" >"$ROLLBACK_NEGATIVE"
if check_stack_rollback_source "$ROLLBACK_NEGATIVE"; then
  reject "rollback source negative was accepted"
fi
rg -q 'if \(UseZeroWasmBaseline && !zero_ref_array_collision' "$SOURCE_INTERPRETER" \
  || reject "baseline collision fail-closed guard missing"
rg -q 'UseZeroWasmJIT && !zero_ref_array_collision' "$SOURCE_INTERPRETER" \
  || reject "OSR collision fail-closed guard missing"
rg -q 'ZeroWasmCompiler::maybe_run_osr' "$SOURCE_INTERPRETER" \
  || reject "OSR call site missing"
rg -q 'invalid-frame-before-install|linked_validate_pre_push\(istate, \*tos, 2\)' \
  "$SOURCE_BASELINE" || reject "pre-install frame guard missing"
rg -q 'removeFunction\(ownedSlot\)|oldCallableAfter|cached\.binary|sameBytes' \
  "$SOURCE_BASELINE" || reject "JS cache release/full-byte identity missing"
rg -q 'ownedSlot|ownedSlots|cleanupProven|missing-removeFunction' \
  "$SOURCE_BASELINE" || reject "owned-slot cache cleanup contract missing"
! rg -q 'ZeroRefArrayLoadOwnedSlots|ownedSlots\[' "$SOURCE_BASELINE" \
  || reject "mutable global owned-slot side map leaked into cache authority"
rg -q 'ZeroWasmLinkedRefArrayCacheMutationForTest|zbb_ref_array_load_cache_mutation' \
  "$SOURCE_BASELINE" "$SOURCE_GLOBALS" \
  || reject "JS cache mutation test hook missing"
rg -q 'build_linked_ref_array_load_module|emit_linked_ref_array_load' "$SOURCE_BASELINE" \
  || reject "dedicated reference module builder missing"

mkdir -p "$WORK/classes"
"$JAVAC" -g:none -d "$WORK/classes" "$FIXTURE" "$NEAR_MISS" \
  || reject "fixture javac failed"
[ "$(find "$WORK/classes" -type f -name '*.class' | wc -l | awk '{print $1}')" -eq 2 ] \
  || reject "fixture closure is not exactly two class files"

JAR_A="$WORK/ref-array-a.jar"
JAR_B="$WORK/ref-array-b.jar"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$JAR_A" \
  -C "$WORK/classes" . || reject "fixture jar A failed"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$JAR_B" \
  -C "$WORK/classes" . || reject "fixture jar B failed"
cmp -s "$JAR_A" "$JAR_B" || reject "fixture jar is not deterministic"
JAR_SHA=$(shasum -a 256 "$JAR_A" | awk '{print $1}')
JAR_BYTES=$(stat -f '%z' "$JAR_A")
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceArrayLoadFixture.class" | awk '{print $1}')
SOURCE_SHA=$(shasum -a 256 "$FIXTURE" | awk '{print $1}')
DEPS=""
for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
  class_name=${class_file#"$WORK/classes/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  DEPS="${DEPS:+$DEPS,}${class_name}=sha256:${class_hash}"
done

"$JAVAP" -classpath "$WORK/classes" -c -p ZeroReferenceArrayLoadFixture \
  >"$WORK/fixture.javap" || reject "fixture javap failed"
BODY=$(awk '
  /public static java.lang.Object referenceArrayLoad\(java.lang.Object\[\], int\);/ { in_method=1; next }
  in_method && /^  public / { exit }
  in_method && /^[[:space:]]+[0-9]+:/ { print }
' "$WORK/fixture.javap")
EXPECTED_BODY=$(printf '%s\n' \
  '         0: aload_0' '         1: iload_1' \
  '         2: aaload' '         3: areturn')
[ "$BODY" = "$EXPECTED_BODY" ] || reject "fixture body drift: $(printf '%s' "$BODY" | tr '\n' ';')"
rg -q '^[[:space:]]+2: aaload$' "$WORK/fixture.javap" || reject "aaload BCI drift"
rg -q '^[[:space:]]+3: areturn$' "$WORK/fixture.javap" || reject "areturn BCI drift"

MANIFEST_ACTUAL="$WORK/manifest.actual"
resolved_tool() { realpath "$(command -v "$1")"; }
NODE_RESOLVED=$(resolved_tool "$NODE")
JAVAC_RESOLVED=$(realpath "$JAVAC")
JAR_RESOLVED=$(realpath "$JAR")
JAVAP_RESOLVED=$(realpath "$JAVAP")
WASM_DIS_RESOLVED=$(realpath "$WASM_DIS")
{
  printf '%s\n' 'zero-linked-ref-array-load-companion-manifest-v1'
  printf 'provenance jdk-head %s\n' "$JDK_HEAD"
  printf 'provenance patch-0015 %s\n' "$PATCH15_SHA"
  printf 'provenance patch-0016 %s\n' "$PATCH16_SHA"
  printf 'provenance patch-0017 %s\n' "$PATCH17_SHA"
  printf 'provenance patch-0018 %s\n' "$PATCH18_SHA"
  printf 'provenance patch-0019 %s\n' "$PATCH19_SHA"
  printf 'provenance c1-0016-baseline %s\n' \
    a340329a2ce46d5313437302df8fa26512207086166f2552c90880d3d38710d3
  printf 'provenance c1-0017-baseline %s\n' \
    c356dfa1a70f0f90e9e716870c8d8b809568130cd8e5a21709eec99aa978e47c
  printf 'asset tests/check-zero-linked-ref-array-load-log.mjs %s\n' \
    "$(shasum -a 256 "$LOG_CHECKER" | awk '{print $1}')"
  printf 'asset tests/check-zero-linked-ref-array-load-wat.mjs %s\n' \
    "$(shasum -a 256 "$WAT_CHECKER" | awk '{print $1}')"
  printf 'asset tests/check-zero-0015-patch-boundary.sh %s\n' \
    "$(shasum -a 256 "$LEGACY_PATCH_BOUNDARY_CHECKER" | awk '{print $1}')"
  printf 'asset tests/check-zero-0019-patch-boundary.sh %s\n' \
    "$(shasum -a 256 "$PATCH_BOUNDARY_CHECKER" | awk '{print $1}')"
  printf 'asset tests/check-zero-0019-legacy-provenance.sh %s\n' \
    "$(shasum -a 256 "$PROVENANCE19" | awk '{print $1}')"
  printf 'asset tests/check-zero-0018-legacy-provenance.sh %s\n' \
    "$(shasum -a 256 "$PROVENANCE18" | awk '{print $1}')"
  printf 'asset tests/run-zero-0019-final-legacy-suite.sh %s\n' \
    "$(shasum -a 256 "$LEGACY_SUITE_PRODUCER" | awk '{print $1}')"
  printf 'class ZeroReferenceArrayLoadFixture.class %s\n' "$CLASS_SHA"
  printf 'class ZeroReferenceArrayLoadNearMiss.class %s\n' \
    "$(shasum -a 256 "$WORK/classes/ZeroReferenceArrayLoadNearMiss.class" | awk '{print $1}')"
  printf 'fixture-jar fixture.jar %s %s\n' "$JAR_SHA" "$JAR_BYTES"
  printf 'source tests/ZeroReferenceArrayLoadFixture.java %s\n' "$SOURCE_SHA"
  printf 'source tests/ZeroReferenceArrayLoadNearMiss.java %s\n' \
    "$(shasum -a 256 "$NEAR_MISS" | awk '{print $1}')"
  printf 'tool javac %s %s\n' "$JAVAC_RESOLVED" "$(shasum -a 256 "$JAVAC_RESOLVED" | awk '{print $1}')"
  printf 'tool jar %s %s\n' "$JAR_RESOLVED" "$(shasum -a 256 "$JAR_RESOLVED" | awk '{print $1}')"
  printf 'tool javap %s %s\n' "$JAVAP_RESOLVED" "$(shasum -a 256 "$JAVAP_RESOLVED" | awk '{print $1}')"
  printf 'tool node %s %s\n' "$NODE_RESOLVED" "$(shasum -a 256 "$NODE_RESOLVED" | awk '{print $1}')"
  printf 'tool wasm-dis %s %s\n' "$WASM_DIS_RESOLVED" "$(shasum -a 256 "$WASM_DIS_RESOLVED" | awk '{print $1}')"
  printf 'tool launcher run-java.sh %s\n' "$(shasum -a 256 "$RUN_JAVA" | awk '{print $1}')"
  printf 'runtime-source-final-0019 src/hotspot/cpu/zero/globals_zero.hpp %s\n' \
    "$(shasum -a 256 "$SOURCE_GLOBALS" | awk '{print $1}')"
  printf 'runtime-source-final-0019 src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp %s\n' \
    "$(shasum -a 256 "$SOURCE_INTERPRETER" | awk '{print $1}')"
  printf 'runtime-source-final-0019 src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp %s\n' \
    "$(shasum -a 256 "$SOURCE_BASELINE" | awk '{print $1}')"
  printf 'asset tests/run-zero-linked-ref-array-load.sh %s\n' \
    "$(shasum -a 256 "$0" | awk '{print $1}')"
  printf 'asset tests/zero-runtime-gate-lock.sh %s\n' \
    "$(shasum -a 256 "$LOCK_HELPER" | awk '{print $1}')"
} >"$MANIFEST_ACTUAL"
cmp -s "$MANIFEST_ACTUAL" "$MANIFEST" || reject "independent fixture manifest drift"
awk '$2 != "tests/check-zero-0018-legacy-provenance.sh"' \
  "$MANIFEST_ACTUAL" >"$WORK/manifest.helper18-omitted"
if cmp -s "$WORK/manifest.helper18-omitted" "$MANIFEST"; then
  reject "helper18 manifest omission self-negative accepted"
fi
sed 's/98210162e613050c97e02d881be392b022e6cb04710d7c144698d9d32d70a310/0000000000000000000000000000000000000000000000000000000000000000/' \
  "$MANIFEST_ACTUAL" >"$WORK/manifest.helper18-drift"
if cmp -s "$WORK/manifest.helper18-drift" "$MANIFEST"; then
  reject "helper18 manifest drift self-negative accepted"
fi
printf '%s\n' 'c1-manifest-self-negatives=pass helper18-omission=reject helper18-drift=reject count=2'
if [ "${MCWEB_C1_MANIFEST_ONLY:-0}" = 1 ]; then
  printf '%s\n' 'WIP m2-c1-manifest=PASS rows=exact helper18=bound self-negatives=2 no-acceptance-evidence=1'
  exit 0
fi

# Reconstruct the accepted numbered OSS stack from a clean base through 0019
# and reverse it completely. Keep the prior 0015 boundary as retained legacy
# evidence; neither boundary claims that the C1 fixture JAR was executed.
MCWEB_PATCH_BOUNDARY_COMMAND=OpenJDK/tests/check-zero-0019-patch-boundary.sh \
  sh "$PATCH_BOUNDARY_CHECKER" >"$PATCH_BOUNDARY_EVIDENCE" 2>&1 \
  || reject "0019 clean forward/reverse patch boundary failed"

check_late_cmd_cleanup() {
  log_path=$1
  final_marker=$2
  awk -v marker="$final_marker" '
    BEGIN { markers=0; late=0; bad=0; after=0 }
    $0 ~ marker { markers++; after=1; next }
    tolower($0) ~ /terminated worker/ {
      if (!after || $0 !~ /^received "6" command from terminated worker: [1-9][0-9]*$/) bad=1
      else late++
    }
    # A Java launch may leave two worker teardown acknowledgements after its
    # final semantic marker. Keep the allowance bounded and require every
    # late line to be the exact CMD6 form above.
    END { if (markers != 1 || bad || late > 2) exit 1; print late }
  ' "$log_path" >/dev/null
}

run_java_supervised() {
  log_path=$1
  final_marker=$2
  shift 2
  "$TIMEOUT" --signal=TERM --kill-after=5s 180 "$RUN_JAVA" "$@" \
    >"$log_path" 2>&1 &
  RUN_PID=$!
  if wait "$RUN_PID"; then status=0; else status=$?; fi
  RUN_PID=
  [ "$status" -eq 0 ] || reject "runtime exited status=$status log=$log_path"
  check_late_cmd_cleanup "$log_path" "$final_marker" \
    || reject "late-CMD6 teardown ordering log=$log_path"
}

BASE_ARGS="-XX:+UnlockExperimentalVMOptions -XX:+UseSerialGC -XX:+UseZeroWasmLinkedRefArrayLoad -XX:+ZeroWasmLinkedGroupVerbose -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS"
run_java_supervised "$WORK/off.log" '^ref-array-exceptions ' \
  -Xmx256m -Xms16m -XX:+UnlockExperimentalVMOptions -XX:+UseSerialGC \
  -XX:+ZeroWasmLinkedGroupVerbose \
  -cp "$WORK/classes" ZeroReferenceArrayLoadFixture ref-array-load
# shellcheck disable=SC2086
run_java_supervised "$WORK/linked.log" '^ref-array-exceptions ' \
  -Xmx256m -Xms16m $BASE_ARGS -cp "$WORK/classes" \
  ZeroReferenceArrayLoadFixture ref-array-load
# Exercise the real EM_JS cache identity mismatch path. Each process first
# installs normally, mutates exactly one cached identity field, requires a
# miss/release, and then rebuilds before running the semantic fixture.
for mutation in compiler digest bytes memory metadata slot poison; do
  # shellcheck disable=SC2086
  run_java_supervised "$WORK/cache-$mutation.log" '^ref-array-exceptions ' \
    -Xmx256m -Xms16m $BASE_ARGS \
    -XX:ZeroWasmLinkedRefArrayCacheMutationForTest="$mutation" \
    -cp "$WORK/classes" ZeroReferenceArrayLoadFixture ref-array-load
done
# shellcheck disable=SC2086
run_java_supervised "$WORK/forced.log" '^ref-array-exceptions ' \
  -Xmx256m -Xms16m $BASE_ARGS \
  -XX:ZeroWasmLinkedRefArrayMemoryLimitForTest=1 \
  -cp "$WORK/classes" ZeroReferenceArrayLoadFixture ref-array-load
# shellcheck disable=SC2086
run_java_supervised "$WORK/root.log" '^ref-array-root ' \
  -Xmx256m -Xms16m $BASE_ARGS -Xlog:gc=info -cp "$WORK/classes" \
  ZeroReferenceArrayLoadFixture ref-array-root
run_java_supervised "$WORK/negative.log" '^ref-array-negatives ' \
  -Xmx256m -Xms16m $BASE_ARGS -cp "$WORK/classes" \
  ZeroReferenceArrayLoadFixture ref-array-negatives

for pair in \
  'collision-group UseZeroWasmLinkedGroup' \
  'collision-int-load UseZeroWasmLinkedIntArray' \
  'collision-int-store UseZeroWasmLinkedIntArrayStore' \
  'collision-benchmark UseZeroWasmLinkedBenchmark' \
  'collision-baseline UseZeroWasmBaseline' \
  'collision-jit UseZeroWasmJIT'; do
  set -- $pair
  name=$1
  flag=$2
  # shellcheck disable=SC2086
  run_java_supervised "$WORK/$name.log" '^ref-array-exceptions ' \
    -Xmx256m -Xms16m $BASE_ARGS -XX:+"$flag" -cp "$WORK/classes" \
    ZeroReferenceArrayLoadFixture ref-array-load
done
# Aggregate legacy opt-ins must fail closed as one bounded collision too.
# shellcheck disable=SC2086
run_java_supervised "$WORK/collision-legacy.log" '^ref-array-exceptions ' \
  -Xmx256m -Xms16m $BASE_ARGS -XX:+UseZeroWasmLinkedGroup \
  -XX:+UseZeroWasmLinkedIntArray -XX:+UseZeroWasmLinkedIntArrayStore \
  -XX:+UseZeroWasmLinkedBenchmark -XX:+UseZeroWasmBaseline -XX:+UseZeroWasmJIT \
  -cp "$WORK/classes" \
  ZeroReferenceArrayLoadFixture ref-array-load

# A real back-edge must also remain interpreter-owned when the incompatible
# reference lane is combined with the trace JIT.  Threshold=1 makes the OSR
# opportunity immediate; the fixture itself supplies 512 back-edges.
# shellcheck disable=SC2086
run_java_supervised "$WORK/collision-osr.log" '^ref-array-osr-collision ' \
  -Xmx256m -Xms16m $BASE_ARGS -XX:+UseZeroWasmJIT \
  -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITThreshold=1 \
  -XX:ZeroWasmJITOnly=runOsrCollisionCase -cp "$WORK/classes" \
  ZeroReferenceArrayLoadFixture ref-array-osr-collision
# Aggregate legacy opt-ins, including baseline and JIT, must fail closed at a
# looping OSR site as one bounded collision rather than entering either lane.
# shellcheck disable=SC2086
run_java_supervised "$WORK/collision-aggregate-osr.log" '^ref-array-osr-collision ' \
  -Xmx256m -Xms16m $BASE_ARGS -XX:+UseZeroWasmLinkedGroup \
  -XX:+UseZeroWasmLinkedIntArray -XX:+UseZeroWasmLinkedIntArrayStore \
  -XX:+UseZeroWasmLinkedBenchmark -XX:+UseZeroWasmBaseline \
  -XX:+UseZeroWasmJIT -XX:+ZeroWasmJITVerbose \
  -XX:ZeroWasmJITThreshold=1 -XX:ZeroWasmJITOnly=runOsrCollisionCase \
  -cp "$WORK/classes" ZeroReferenceArrayLoadFixture ref-array-osr-collision

"$NODE" "$LOG_CHECKER" "$WORK/off.log" off >"$WORK/check-off.log" 2>&1 \
  || reject "off transcript checker failed"
"$NODE" "$LOG_CHECKER" "$WORK/linked.log" linked >"$WORK/check-linked.log" 2>&1 \
  || reject "linked transcript checker failed"
for mutation in compiler digest bytes memory metadata slot; do
  "$NODE" "$LOG_CHECKER" "$WORK/cache-$mutation.log" linked \
    >"$WORK/check-cache-$mutation.log" 2>&1 \
    || reject "cache mutation transcript checker failed: $mutation"
done
"$NODE" "$LOG_CHECKER" "$WORK/cache-poison.log" cache-poison \
  >"$WORK/check-cache-poison.log" 2>&1 \
  || reject "cache poison transcript checker failed"
sed 's/poison-callable-after=0/poison-callable-after=1/g' \
  "$WORK/cache-poison.log" >"$WORK/cache-poison-negative.log"
if "$NODE" "$LOG_CHECKER" "$WORK/cache-poison-negative.log" cache-poison \
    >"$WORK/check-cache-poison-negative.log" 2>&1; then
  reject "cache poison callable-after negative was accepted"
fi
"$NODE" "$LOG_CHECKER" "$WORK/forced.log" forced >"$WORK/check-forced.log" 2>&1 \
  || reject "forced transcript checker failed"
"$NODE" "$LOG_CHECKER" "$WORK/root.log" root >"$WORK/check-root.log" 2>&1 \
  || reject "root transcript checker failed"
"$NODE" "$LOG_CHECKER" "$WORK/negative.log" negative >"$WORK/check-negative.log" 2>&1 \
  || reject "near-miss transcript checker failed"
for name in group int-load int-store benchmark baseline jit legacy; do
  "$NODE" "$LOG_CHECKER" "$WORK/collision-$name.log" collision \
    >"$WORK/check-collision-$name.log" 2>&1 \
    || reject "collision transcript checker failed: $name"
done
"$NODE" "$LOG_CHECKER" "$WORK/collision-osr.log" osr-collision \
  >"$WORK/check-collision-osr.log" 2>&1 \
  || reject "OSR collision transcript checker failed"
"$NODE" "$LOG_CHECKER" "$WORK/collision-aggregate-osr.log" osr-aggregate \
  >"$WORK/check-collision-aggregate-osr.log" 2>&1 \
  || reject "aggregate OSR collision transcript checker failed"
# The complete OSR marker intentionally has legitimate fields after the
# baseline/jit pair. Keep one accepted full-tail transcript above and reject
# both an extra field and a reordered tail so a suffix-only checker cannot
# regress.
sed 's/ref-store=0$/ref-store=0 extra=0/' "$WORK/collision-osr.log" \
  >"$WORK/collision-osr-extra-field.log"
if "$NODE" "$LOG_CHECKER" "$WORK/collision-osr-extra-field.log" osr-collision \
    >"$WORK/check-collision-osr-extra-field.log" 2>&1; then
  reject "OSR collision extra-field negative was accepted"
fi
sed 's/ref-load=1 ref-store=0$/ref-store=0 ref-load=1/' "$WORK/collision-osr.log" \
  >"$WORK/collision-osr-reordered-tail.log"
if "$NODE" "$LOG_CHECKER" "$WORK/collision-osr-reordered-tail.log" osr-collision \
    >"$WORK/check-collision-osr-reordered-tail.log" 2>&1; then
  reject "OSR collision reordered-tail negative was accepted"
fi

rg -q '^ref-array-load first=1 middle=1 last=1 null-element=1 covariant=1 null-npe=1 negative-aioobe=1 length-aioobe=1 min-index-aioobe=1 empty-aioobe=1$' "$WORK/off.log" \
  || reject "off fixture semantics mismatch"
rg -q '^ref-array-load first=1 middle=1 last=1 null-element=1 covariant=1 null-npe=1 negative-aioobe=1 length-aioobe=1 min-index-aioobe=1 empty-aioobe=1$' "$WORK/linked.log" \
  || reject "linked fixture semantics mismatch"
rg -q '^ref-array-root identity=1$' "$WORK/root.log" || reject "root identity mismatch"
ROOT_EXIT_LINE=$(rg -n '^\[zbg\] REF_ARRAY_EXIT .*status=RETURN bci=0$' "$WORK/root.log" | tail -1 | cut -d: -f1)
ROOT_GC_BEGIN_LINE=$(rg -n '^ROOT_POST_RETURN_GC_BEGIN$' "$WORK/root.log" | cut -d: -f1)
ROOT_GC_END_LINE=$(rg -n '^ROOT_POST_RETURN_GC_END$' "$WORK/root.log" | cut -d: -f1)
[ -n "$ROOT_EXIT_LINE" ] && [ -n "$ROOT_GC_BEGIN_LINE" ] && [ -n "$ROOT_GC_END_LINE" ] \
  || reject "root post-return GC markers missing"
[ "$ROOT_EXIT_LINE" -lt "$ROOT_GC_BEGIN_LINE" ] && [ "$ROOT_GC_BEGIN_LINE" -lt "$ROOT_GC_END_LINE" ] \
  || reject "root GC request was not after linked return"
awk -v begin="$ROOT_GC_BEGIN_LINE" -v end="$ROOT_GC_END_LINE" \
  'NR > begin && NR < end && /GC\(/ { found=1 } END { exit found ? 0 : 1 }' \
  "$WORK/root.log" || reject "root post-return GC event missing"
rg -q '^ref-array-negatives descriptor=1 owner=1 static=1 body=1 instance=1$' "$WORK/negative.log" \
  || reject "near-miss fixture semantics mismatch"
[ "$(rg -c '^\[zbg\] DIRECT_REF_LOAD ' "$WORK/linked.log" || printf 0)" -eq 5 ] \
  || reject "linked direct reference result count mismatch"
[ "$(rg -c '^\[zbg\] REF_ARRAY_OPCODE_REEXECUTE ' "$WORK/linked.log" || printf 0)" -eq 5 ] \
  || reject "linked fallback count mismatch"
[ "$(rg -c '^\[zbg\] DIRECT_REF_LOAD ' "$WORK/forced.log" || printf 0)" -eq 0 ] \
  || reject "forced lane unexpectedly returned directly"
[ "$(rg -c '^\[zbg\] REF_ARRAY_OPCODE_REEXECUTE ' "$WORK/forced.log" || printf 0)" -eq 10 ] \
  || reject "forced lane did not reexecute all ten calls"
! rg -q 'JS_INSTALL ref-array-load|REF_ARRAY_ENTER|REF_ARRAY_TABLE_CALL|REF_ARRAY_STATUS|REF_ARRAY_EXIT|REF_ARRAY_OPCODE_REEXECUTE|DIRECT_REF_LOAD' "$WORK/negative.log" \
  || reject "near-miss unexpectedly entered linked lane"
rg -q '^ref-array-osr-collision checksum=512$' "$WORK/collision-osr.log" \
  || reject "OSR collision fixture semantics mismatch"
rg -q '^ref-array-osr-collision checksum=512$' "$WORK/collision-aggregate-osr.log" \
  || reject "aggregate OSR collision fixture semantics mismatch"
for mutation in compiler digest bytes memory metadata slot poison; do
  cache_log="$WORK/cache-$mutation.log"
  [ "$(rg -c '^\[zbg\] JS_INSTALL ref-array-load ' "$cache_log" || printf 0)" -eq 2 ] \
    || reject "cache mutation did not perform miss/reinstall: $mutation"
  [ "$(rg -c '^\[zbg\] JS_CACHE_HIT ref-array-load ' "$cache_log" || printf 0)" -eq 1 ] \
    || reject "cache mutation did not exercise initial JS hit: $mutation"
  [ "$(rg -c '^\[zbg\] JS_CACHE_INVALIDATE ref-array-load ' "$cache_log" || printf 0)" -eq 1 ] \
    || reject "cache invalidation marker count drift: $mutation"
  if [ "$mutation" = poison ]; then
    rg -q '^\[zbg\] JS_CACHE_INVALIDATE ref-array-load slot=[0-9][0-9]* owned-slot=[0-9][0-9]* removed=1 old-callable=1 export-match=0 old-callable-after=0 poisoning=1 poison-visible=1 old-export-visible=0 poison-removed=1 poison-callable-after=0 instance-cleared=1 cache-cleared=1 last-instance-cleared=1$' \
      "$cache_log" || reject "cache poison owned-slot release evidence drift"
  else
    rg -q '^\[zbg\] JS_CACHE_INVALIDATE ref-array-load slot=[0-9][0-9]* owned-slot=[0-9][0-9]* removed=1 old-callable=1 export-match=1 old-callable-after=0 poisoning=0 poison-visible=0 old-export-visible=1 poison-removed=1 poison-callable-after=0 instance-cleared=1 cache-cleared=1 last-instance-cleared=1$' \
      "$cache_log" || reject "cache owned-slot release evidence drift: $mutation"
  fi
  [ "$(rg -c '^\[zbg\] JS_CACHE_MUTATION_PASS ref-array-load ' "$cache_log" || printf 0)" -eq 1 ] \
    || reject "cache mutation pass marker count drift: $mutation"
  if [ "$mutation" = poison ]; then
    rg -q '^\[zbg\] JS_CACHE_MUTATION_PASS ref-array-load mutation=poison miss=-1 old-id=[0-9][0-9]* new-id=[0-9][0-9]* old-slot=[0-9][0-9]* new-slot=[0-9][0-9]* old-owned-slot=[0-9][0-9]* slot-reused=[01] old-callable-before=1 export-match=0 poisoning=1 poison-visible=1 old-export-visible=0 poison-removed=1 poison-callable-after=0 old-callable-after=0 removed=1 instance-reused=0 cache-cleared=1 last-instance-cleared=1 bytes-exact=1$' \
      "$cache_log" || reject "cache poison mutation identity closure drift"
  else
    rg -q "^\[zbg\] JS_CACHE_MUTATION_PASS ref-array-load mutation=$mutation miss=-1 old-id=[0-9][0-9]* new-id=[0-9][0-9]* old-slot=[0-9][0-9]* new-slot=[0-9][0-9]* old-owned-slot=[0-9][0-9]* slot-reused=[01] old-callable-before=1 export-match=1 poisoning=0 poison-visible=0 old-export-visible=1 poison-removed=1 poison-callable-after=0 old-callable-after=0 removed=1 instance-reused=0 cache-cleared=1 last-instance-cleared=1 bytes-exact=1$" \
      "$cache_log" || reject "cache mutation identity closure drift: $mutation"
  fi
  ! rg -q 'ref-array install reject=cache-release|JS_CACHE_CLEANUP_UNSUPPORTED|REF_ARRAY_CACHE_REJECT|wasm trap|FATAL' "$cache_log" \
    || reject "cache mutation install failed: $mutation"
done

[ -s "$WASM_REF" ] || reject "linked module dump missing"
cp "$WASM_REF" "$WORK/ref-array-load.wasm"
"$WASM_DIS" "$WORK/ref-array-load.wasm" -o "$WORK/ref-array-load.wat" \
  || reject "wasm-dis failed"
"$NODE" "$WAT_CHECKER" "$WORK/ref-array-load.wasm" "$WORK/ref-array-load.wat" \
  >"$WORK/ref-array-wat.log" 2>&1 || reject "module structural checker failed"
[ "$(rg -c '^ref-array-binary-negative label=' "$WORK/ref-array-wat.log" || printf 0)" -eq 11 ] \
  || reject "binary mutation oracle count drift"
rg -q '^ref-array-body-binary-self-negatives=11 valid-same-length rejected$' \
  "$WORK/ref-array-wat.log" || reject "valid same-length mutation accounting missing"
rg -q '^ref-array-body-binary-invalid-negatives=1 truncation rejected ' \
  "$WORK/ref-array-wat.log" || reject "truncation accounting missing"
! rg -q 'same-length mutation is not valid wasm|mutation changed [^1]|mutation offset reused|mutation hash reused|mutation rejection reason reused' \
  "$WORK/ref-array-wat.log" || reject "binary mutation oracle self-check failed"

# Bind fresh 0019-final setup/boundary/M1/M2-A/relocation-P1/M2-B records into the
# final evidence. Each record is an exact terminal envelope: current
# command/script/helper/0015..0019 hashes, one target semantic ACCEPT, explicitly
# scoped intentional diagnostics, and exit=0 immediately before its timestamp.
legacy_diagnostics_clean() {
  diagnostic_log=$1
  diagnostic_accept=$2
  diagnostic_allowed=$3
  awk -v accept="$diagnostic_accept" -v allowed="$diagnostic_allowed" '
    BEGIN { seen=0; bad=0 }
    $0 == accept { seen++; next }
    {
      lowered=tolower($0)
    }
    lowered ~ /(reject|fatal|error|failed|failure|panic|broken pipe)/ {
      if (allowed == "m2b-exact" &&
          ($0 == "[zbg] STORE_CLASSIFY holder=ZeroBaselineFixture method=intArrayStore descriptor=([III)I static=1 params=3 code-size=6 code-shape=1 exception-table=1 accepted=0 reject=exception-table" ||
           $0 == "array-store-wat-self-negatives=16 rejected" ||
           $0 == "array-store-binary-self-negatives=6 rejected")) next
      if (allowed == "m2b-exact") { bad=1; next }
      if (allowed != "" && $0 ~ allowed) next
      bad=1
    }
    END { exit !(seen == 1 && bad == 0) }
  ' "$diagnostic_log"
}

printf '%s\n' 'ACCEPT diagnostic oracle' 'printf: write error: Broken pipe' \
  >"$WORK/lowercase-failure.oracle"
if legacy_diagnostics_clean "$WORK/lowercase-failure.oracle" \
    'ACCEPT diagnostic oracle' ''; then
  reject "legacy diagnostic oracle accepted lowercase failure"
fi
printf '%s\n' 'ACCEPT diagnostic oracle' \
  'array-store-wat-self-negatives=17 rejected' \
  >"$WORK/m2b-allowlist-near-miss.oracle"
if legacy_diagnostics_clean "$WORK/m2b-allowlist-near-miss.oracle" \
    'ACCEPT diagnostic oracle' 'm2b-exact'; then
  reject "legacy diagnostic oracle accepted M2-B allowlist near-miss"
fi

validate_legacy_envelope() {
  log=$1
  command_name=$2
  script_name=$3
  accept_marker=$4
  allowed_diagnostics=$5
  audit_label=$6
  binding_mode=${7:-strict}
  [ -f "$log" ] || reject "retained legacy evidence missing: $log"
  script_path="$ROOT/../$script_name"
  [ -f "$script_path" ] || reject "legacy command source missing: $script_path"
  script_sha=$(shasum -a 256 "$script_path" | awk '{print $1}')
  [ "$(rg -c -x -F "command=$command_name" "$log" || printf 0)" -eq 1 ] \
    || reject "legacy command envelope drift: $log"
  [ "$(rg -c -x -F "audit=$audit_label" "$log" || printf 0)" -eq 1 ] \
    || reject "legacy audit label drift: $log"
  recorded_script_sha=$(sed -n 's/^script-sha256=\([0-9a-f][0-9a-f]*\)$/\1/p' "$log")
  [ "$(printf '%s\n' "$recorded_script_sha" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
    || reject "legacy script binding missing: $log"
  printf '%s\n' "$recorded_script_sha" | rg -q '^[0-9a-f]{64}$' \
    || reject "legacy script binding malformed: $log"
  if [ "$binding_mode" = strict ] && [ "$recorded_script_sha" != "$script_sha" ]; then
    reject "current script binding drift: $log"
  fi
  [ "$(rg -c -x -F "patch0015-sha256=$PATCH15_SHA" "$log" || printf 0)" -eq 1 ] \
    || reject "legacy 0015 binding drift: $log"
  [ "$(rg -c -x -F "patch0016-sha256=$PATCH16_SHA" "$log" || printf 0)" -eq 1 ] \
    || reject "legacy 0016 binding drift: $log"
  [ "$(rg -c -x -F "patch0017-sha256=$PATCH17_SHA" "$log" || printf 0)" -eq 1 ] \
    || reject "legacy 0017 binding drift: $log"
  [ "$(rg -c -x -F "patch0018-sha256=$PATCH18_SHA" "$log" || printf 0)" -eq 1 ] \
    || reject "legacy 0018 binding drift: $log"
  [ "$(rg -c -x -F "patch0019-sha256=$PATCH19_SHA" "$log" || printf 0)" -eq 1 ] \
    || reject "legacy 0019 binding drift: $log"
  if [ "$audit_label" = 0019-final ]; then
    provenance_sha=$(shasum -a 256 "$PROVENANCE19" | awk '{print $1}')
    producer_sha=$(shasum -a 256 "$LEGACY_SUITE_PRODUCER" | awk '{print $1}')
    [ "$(rg -c -x -F "provenance-helper-sha256=$provenance_sha" "$log" || printf 0)" -eq 1 ] \
      || reject "legacy provenance helper binding drift: $log"
    provenance18_sha=$(shasum -a 256 "$PROVENANCE18" | awk '{print $1}')
    [ "$(rg -c -x -F "legacy-provenance-helper18-sha256=$provenance18_sha" "$log" || printf 0)" -eq 1 ] \
      || reject "legacy provenance helper18 binding drift: $log"
    [ "$(rg -c -x -F 'record-producer=OpenJDK/tests/run-zero-0019-final-legacy-suite.sh' "$log" || printf 0)" -eq 1 ] \
      || reject "legacy producer command binding drift: $log"
    [ "$(rg -c -x -F "record-producer-sha256=$producer_sha" "$log" || printf 0)" -eq 1 ] \
      || reject "legacy producer hash binding drift: $log"
    [ "$(rg -c -x -F 'legacy-provenance-context=final-0019' "$log" || printf 0)" -eq 1 ] \
      || reject "legacy provenance context binding drift: $log"
  fi
  [ "$(rg -c -x -F "$accept_marker" "$log" || printf 0)" -eq 1 ] \
    || reject "legacy target ACCEPT count drift: $log"
  [ "$(rg -c '^ACCEPT ' "$log" || printf 0)" -eq 1 ] \
    || reject "legacy generic ACCEPT count drift: $log"
  started=$(sed -n 's/^started-epoch=\([0-9][0-9]*\)$/\1/p' "$log")
  finished=$(sed -n 's/^finished-epoch=\([0-9][0-9]*\)$/\1/p' "$log")
  [ "$(printf '%s\n' "$started" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
    && [ "$(printf '%s\n' "$finished" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
    || reject "legacy completed timestamp missing: $log"
  [ "$finished" -gt "$started" ] || reject "legacy timestamp order drift: $log"
  [ "$(tail -n 2 "$log" | sed -n '1p')" = 'exit=0' ] \
    && [ "$(tail -n 1 "$log")" = "finished-epoch=$finished" ] \
    || reject "legacy terminal envelope drift: $log"
  legacy_diagnostics_clean "$log" "$accept_marker" "$allowed_diagnostics" \
    || reject "legacy unexpected failure diagnostic: $log"
}

validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-setup.log \
  OpenJDK/tests/run-zero-setup-transaction.sh \
  OpenJDK/tests/run-zero-setup-transaction.sh \
  'ACCEPT setup transaction mock gate' '^failure-mocks=' 0019-final
validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-patch-boundary.log \
  OpenJDK/tests/check-zero-0019-patch-boundary.sh \
  OpenJDK/tests/check-zero-0019-patch-boundary.sh \
  'ACCEPT patch-boundary clean-base-forward-0019-reverse-0019-exact-0018-postimages' '' 0019-final
validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-m1-group.log \
  OpenJDK/tests/run-zero-linked-group.sh \
  OpenJDK/tests/run-zero-linked-group.sh \
  'ACCEPT M1-A direct+guard slice' '^M1-B REJECT: ' 0019-final
validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-m1-gc.log \
  OpenJDK/tests/run-zero-linked-gc.sh \
  OpenJDK/tests/run-zero-linked-gc.sh \
  'ACCEPT M1-B1 linked oop store slice' \
  '^M1-B2 REJECT: |^post-store-gc=.*allocation-failure' 0019-final
validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-m1-alloc.log \
  OpenJDK/tests/run-zero-linked-alloc-bail.sh \
  OpenJDK/tests/run-zero-linked-alloc-bail.sh \
  'ACCEPT M1-B2 allocation-bail/root-liveness slice' \
  '^M1-B3 REJECT: |^gc-evidence=.*allocation-failure' 0019-final
validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-m1-class-init.log \
  OpenJDK/tests/run-zero-linked-class-init.sh \
  OpenJDK/tests/run-zero-linked-class-init.sh \
  'ACCEPT M1-C class-init fallback slice (second successful access interpreter-only)' \
  '^M1-D REJECT: ' 0019-final
validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-m1-virtual.log \
  OpenJDK/tests/run-zero-linked-virtual.sh \
  OpenJDK/tests/run-zero-linked-virtual.sh \
  'ACCEPT M1-D1 exact-class invokevirtual guard slice' '^M1-D2 REJECT: ' 0019-final
validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-m1-idiv.log \
  OpenJDK/tests/run-zero-linked-idiv.sh \
  OpenJDK/tests/run-zero-linked-idiv.sh \
  'ACCEPT M1-E1 same-frame idiv re-execution slice' '^E2 REJECT: ' 0019-final
validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-m1-throw.log \
  OpenJDK/tests/run-zero-linked-throw.sh \
  OpenJDK/tests/run-zero-linked-throw.sh \
  'ACCEPT M1-E2 direct-callee throw/invoke-resume slice' '^E3 REJECT: ' 0019-final
validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-m2a-array.log \
  OpenJDK/tests/run-zero-linked-array.sh \
  OpenJDK/tests/run-zero-linked-array.sh \
  'ACCEPT M2-A int[] load linked-success plus canonical fallback slice' \
  '^M2-B REJECT: ' 0019-final
validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-m2b-store.log \
  OpenJDK/tests/run-zero-linked-array-store.sh \
  OpenJDK/tests/run-zero-linked-array-store.sh \
  'ACCEPT M2-B int[] store linked-success plus canonical fallback slice' \
  'm2b-exact' 0019-final
validate_legacy_envelope \
  /private/tmp/mcweb-0019-audit-p1-performance.log \
  OpenJDK/tests/run-zero-linked-performance.sh \
  OpenJDK/tests/run-zero-linked-performance.sh \
  'ACCEPT M1-P1b synthetic emitter hot-path benchmark evidence' '' 0019-final
rg -qx 'audit=0019-final-patch-boundary' "$PATCH_BOUNDARY_EVIDENCE" \
  || reject 'patch-boundary audit drift'
rg -qx 'ACCEPT patch-boundary clean-base-forward-0019-reverse-0019-exact-0018-postimages' \
  "$PATCH_BOUNDARY_EVIDENCE" || reject 'patch-boundary terminal drift'
rg -q "^base-head-commit=$JDK_HEAD$" "$PATCH_BOUNDARY_EVIDENCE" \
  || reject 'patch-boundary base head drift'
rg -q '^patch-stack=0001 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0019$' \
  "$PATCH_BOUNDARY_EVIDENCE" || reject 'patch-boundary stack drift'
rg -q "^patch0017-sha256=$PATCH17_SHA$" "$PATCH_BOUNDARY_EVIDENCE" \
  || reject 'patch-boundary 0017 binding drift'
rg -q "^patch0018-sha256=$PATCH18_SHA$" "$PATCH_BOUNDARY_EVIDENCE" \
  || reject 'patch-boundary 0018 binding drift'
rg -q "^patch0019-sha256=$PATCH19_SHA$" "$PATCH_BOUNDARY_EVIDENCE" \
  || reject 'patch-boundary 0019 binding drift'
rg -q '^postimage-0018-restored globals=.* interpreter=.* baseline=.* status=pass$' \
  "$PATCH_BOUNDARY_EVIDENCE" || reject '0019 reverse 0018 postimage proof missing'
rg -q '^clean-base-return=pass$' "$PATCH_BOUNDARY_EVIDENCE" \
  || reject 'patch-boundary clean return missing'

install_line=$(rg '^\[zbg\] JS_INSTALL ref-array-load ' "$WORK/linked.log" || true)
cache_line=$(rg '^\[zbg\] JS_CACHE_HIT ref-array-load ' "$WORK/linked.log" || true)
key_line=$(rg '^\[zbg\] REF_ARRAY_MODULE_KEY ' "$WORK/linked.log" || true)
[ "$(printf '%s\n' "$install_line" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
  || reject "install marker count drift"
[ "$(printf '%s\n' "$cache_line" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
  || reject "cache marker count drift"
[ "$(printf '%s\n' "$key_line" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
  || reject "module-key marker count drift"
install_slot=$(printf '%s\n' "$install_line" | sed -n 's/.* slot=\([0-9][0-9]*\) .*/\1/p')
cache_slot=$(printf '%s\n' "$cache_line" | sed -n 's/.* slot=\([0-9][0-9]*\) .*/\1/p')
key_slot=$(printf '%s\n' "$key_line" | sed -n 's/.* slot=\([0-9][0-9]*\) .*/\1/p')
[ -n "$install_slot" ] && [ "$install_slot" = "$cache_slot" ] && [ "$install_slot" = "$key_slot" ] \
  || reject "dynamic slot/cache/module-key identity drift"
validate_cache_identity() {
  transcript=$1
  install=$(rg '^\[zbg\] JS_INSTALL ref-array-load ' "$transcript" || true)
  cache=$(rg '^\[zbg\] JS_CACHE_HIT ref-array-load ' "$transcript" || true)
  key=$(rg '^\[zbg\] REF_ARRAY_MODULE_KEY ' "$transcript" || true)
  [ "$(printf '%s\n' "$install" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] || return 1
  [ "$(printf '%s\n' "$cache" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] || return 1
  [ "$(printf '%s\n' "$key" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] || return 1
  install_slot=$(printf '%s\n' "$install" | sed -n 's/.* slot=\([0-9][0-9]*\) .*/\1/p')
  cache_slot=$(printf '%s\n' "$cache" | sed -n 's/.* slot=\([0-9][0-9]*\) .*/\1/p')
  key_slot=$(printf '%s\n' "$key" | sed -n 's/.* slot=\([0-9][0-9]*\) .*/\1/p')
  [ -n "$install_slot" ] && [ "$install_slot" = "$cache_slot" ] \
    && [ "$install_slot" = "$key_slot" ] || return 1
  rg -q 'instance-reused=1 memory-reused=1 compiler=zero-baseline-abi-v1 digest=[0-9a-f]{16} bytes-exact=1$' "$transcript" || return 1
  install_digest=$(printf '%s\n' "$install" | sed -n 's/.* digest=\([0-9a-f][0-9a-f]*\) memory=.*/\1/p')
  cache_digest=$(printf '%s\n' "$cache" | sed -n 's/.* digest=\([0-9a-f][0-9a-f]*\) bytes-exact=1$/\1/p')
  [ -n "$install_digest" ] && [ "$install_digest" = "$cache_digest" ] || return 1
}
validate_cache_identity "$WORK/linked.log" || reject "cache did not bind instance/memory/compiler/digest"
for mutation in slot digest compiler memory; do
  mutated="$WORK/cache-$mutation-mutated.log"
  case "$mutation" in
    slot) sed -E 's/(JS_CACHE_HIT ref-array-load id=[0-9]+ slot=)[0-9]+/\19999/' "$WORK/linked.log" >"$mutated" ;;
    digest) sed -E 's/(JS_CACHE_HIT ref-array-load .* digest=)[0-9a-f]+ bytes-exact=1$/\1deadbeefdeadbeef bytes-exact=1/' "$WORK/linked.log" >"$mutated" ;;
    compiler) sed 's/compiler=zero-baseline-abi-v1/compiler=mutated/' "$WORK/linked.log" >"$mutated" ;;
    memory) sed 's/memory-reused=1/memory-reused=0/' "$WORK/linked.log" >"$mutated" ;;
  esac
  if validate_cache_identity "$mutated"; then reject "cache $mutation mutation accepted"; fi
done
rg -q 'memory=shared max-pages=65536$' "$WORK/linked.log" \
  || reject "shared memory/max identity marker missing"
rg -q 'exports=1 slot=[0-9][0-9]* collector=serial compressed-oops=0 compressed-class-pointers=0 compact-headers=0 pointer-bytes=4 oop-bytes=4 heap-oop-bytes=4 memory=shared max-pages=65536 length-offset=[0-9][0-9]* base-offset=[0-9][0-9]* element-size=4 bytes=[1-9][0-9]*$' "$WORK/linked.log" \
  || reject "dedicated module key ABI/layout drift"
! rg -q 'REF_ARRAY_CACHE_REJECT|install reject=|wasm trap|unreachable|CALL MISMATCH|PUSH_REJECT|RESUME_REJECT|pending=1|FATAL' "$WORK/linked.log" \
  || reject "linked runtime failure marker present"

MODULE_SHA=$(shasum -a 256 "$WORK/ref-array-load.wasm" | awk '{print $1}')
MODULE_BYTES=$(wc -c < "$WORK/ref-array-load.wasm" | awk '{print $1}')
WAT_SHA=$(shasum -a 256 "$WORK/ref-array-load.wat" | awk '{print $1}')
MANIFEST_SHA=$(shasum -a 256 "$MANIFEST" | awk '{print $1}')
LIBJVM="$JDK/build/wasm-zero/support/modules_libs/java.base/zero/libjvm.so"
[ -f "$LIBJVM" ] || reject "built libjvm missing for atomic evidence"
LIBJVM_SHA=$(shasum -a 256 "$LIBJVM" | awk '{print $1}')
LAUNCHER_SHA=$(shasum -a 256 "$RUN_JAVA" | awk '{print $1}')
LOCK_SHA=$(shasum -a 256 "$LOCK_HELPER" | awk '{print $1}')
SOURCE_GLOBALS_SHA=$(shasum -a 256 "$SOURCE_GLOBALS" | awk '{print $1}')
SOURCE_INTERPRETER_SHA=$(shasum -a 256 "$SOURCE_INTERPRETER" | awk '{print $1}')
SOURCE_BASELINE_SHA=$(shasum -a 256 "$SOURCE_BASELINE" | awk '{print $1}')
C1_0017_GLOBALS_SHA=5858ac45c26e463689b779d1b3b0b3b2d6a9d454f45b550b1290f280e9f9a449
C1_0017_INTERPRETER_SHA=ce3ab6676d3133d2f98d765de3cd849a8e54caf5cbe7cf3d375c9f9622e91c10
C1_0017_BASELINE_SHA=c356dfa1a70f0f90e9e716870c8d8b809568130cd8e5a21709eec99aa978e47c
C1_0018_GLOBALS_SHA=6c8ac8a604881191755b876c9cfad596948dcf22642a6af1ea5d7c72e6fdbc27
C1_0018_INTERPRETER_SHA=e54f7456695ea2fab786a439da94d27ba94e41574f9fea15fb84def6a3ab04a1
C1_0018_BASELINE_SHA=892cb9d63b3909d8acb933cd8849c9b9caeef17353ad0d655d3822737abb4733
C1_0019_GLOBALS_SHA=bd76b9d3df38fc45892a45b9ebb5d54b1d5fb8fec5917a47929ef8e634082265
C1_0019_INTERPRETER_SHA=08e457e0a1551d8f3c3c16b0b4aa1f2608f630babe3ccd54f3e1fba316fc3676
C1_0019_BASELINE_SHA=d2276be03aa03375fa59e9ccae10fee21b65f63d30c509f9fdfcbac349573420
if [ "$SOURCE_GLOBALS_SHA" = "$C1_0019_GLOBALS_SHA" ] \
    && [ "$SOURCE_INTERPRETER_SHA" = "$C1_0019_INTERPRETER_SHA" ] \
    && [ "$SOURCE_BASELINE_SHA" = "$C1_0019_BASELINE_SHA" ]; then
  C1_RUNTIME_LANE=c1-on-final-0019
  C1_SOURCE_MATCH=1
else
  C1_RUNTIME_LANE=source-drift
  C1_SOURCE_MATCH=0
fi
[ "$C1_SOURCE_MATCH" -eq 1 ] || reject "runtime source is not exact final 0019 postimage"

# Nothing under the acceptance path is written until every runtime lane,
# transcript checker, binary/WAT checker, and retained legacy binding above has
# passed. The stage is then atomically renamed into place after a filesystem
# sync; a stale path was removed before this gate started.
mkdir -p "$EVIDENCE_STAGE/logs" "$EVIDENCE_STAGE/checks" "$EVIDENCE_STAGE/legacy"
cp "$WORK/ref-array-load.wasm" "$EVIDENCE_STAGE/module.wasm"
cp "$WORK/ref-array-load.wat" "$EVIDENCE_STAGE/module.wat"
cp "$WORK/ref-array-wat.log" "$EVIDENCE_STAGE/checks/wat.log"
cp "$WORK/manifest.actual" "$EVIDENCE_STAGE/checks/manifest.actual"
cp "$WORK/fixture.javap" "$EVIDENCE_STAGE/checks/fixture.javap"
for log in "$WORK"/*.log; do
  cp "$log" "$EVIDENCE_STAGE/logs/$(basename "$log")"
done
for legacy_log in $LEGACY_EVIDENCE_FILES; do
  cp "$legacy_log" "$EVIDENCE_STAGE/legacy/$(basename "$legacy_log")"
done
cp "$PATCH_BOUNDARY_EVIDENCE" \
  "$EVIDENCE_STAGE/legacy/$(basename "$PATCH_BOUNDARY_EVIDENCE")"
FINISHED_EPOCH=$(date +%s)
find "$EVIDENCE_STAGE/checks" "$EVIDENCE_STAGE/legacy" \
  "$EVIDENCE_STAGE/logs" -type f -print \
  | sed "s#^$EVIDENCE_STAGE/##" | LC_ALL=C sort >"$WORK/bundle-files.list"

{
  printf '%s\n' 'm2-c1-atomic-accept-evidence-v1'
  printf 'accept m2-c1 exit=0\n'
  printf 'gate-envelope started-epoch=%s finished-epoch=%s exit=0\n' \
    "$STARTED_EPOCH" "$FINISHED_EPOCH"
  printf 'execution-input class-directory fixture-jar=provenance/cache-identity-only\n'
  printf 'class-directory-limitation fixture-jar-is-not-executed=1 arbitrary-jar-compiler=not-claimed\n'
  printf 'command gate=%s exit=0\n' "$0"
  printf 'command javac=%s exit=0\n' "$JAVAC"
  printf 'command jar=%s exit=0\n' "$JAR"
  printf 'command javap=%s exit=0\n' "$JAVAP"
  printf 'command wasm-dis=%s exit=0\n' "$WASM_DIS"
  printf 'command log-checker=%s exit=0\n' "$LOG_CHECKER"
  printf 'command wat-checker=%s exit=0\n' "$WAT_CHECKER"
  printf 'command patch-boundary=%s exit=0\n' "$PATCH_BOUNDARY_CHECKER"
  printf 'lane-exits off=0 linked=0 forced=0 root=0 negative=0 cache=0 collision=0 osr=0 aggregate-osr=0\n'
  printf 'counts direct=5 fallback=5 forced-fallback=10 root=post-return-gc-identity osr-calls=512\n'
  printf 'collision-count group=1 int-load=1 int-store=1 benchmark=1 baseline=1 jit=1 legacy=1 osr=1 aggregate-osr=1\n'
  printf 'collision-policy linked-direct=0 jit-osr=0 installs=0\n'
  for mutation in compiler digest bytes memory metadata slot poison; do
    cache_log="$WORK/cache-$mutation.log"
    printf 'cache mutation=%s installs=%s hits=%s invalidations=%s passes=%s\n' "$mutation" \
      "$(rg -c '^\[zbg\] JS_INSTALL ref-array-load ' "$cache_log" || printf 0)" \
      "$(rg -c '^\[zbg\] JS_CACHE_HIT ref-array-load ' "$cache_log" || printf 0)" \
      "$(rg -c '^\[zbg\] JS_CACHE_INVALIDATE ref-array-load ' "$cache_log" || printf 0)" \
      "$(rg -c '^\[zbg\] JS_CACHE_MUTATION_PASS ref-array-load ' "$cache_log" || printf 0)"
  done
  printf 'root-order exit-line=%s gc-begin-line=%s gc-end-line=%s\n' \
    "$ROOT_EXIT_LINE" "$ROOT_GC_BEGIN_LINE" "$ROOT_GC_END_LINE"
  printf 'wat module-sha=%s wat-sha=%s bytes=%s semantic-valid-same-length=11 truncation=1 stale-pairing=1\n' \
    "$MODULE_SHA" "$WAT_SHA" "$MODULE_BYTES"
  printf 'fixture source-sha=%s class-sha=%s jar-sha=%s jar-bytes=%s\n' \
    "$SOURCE_SHA" "$CLASS_SHA" "$JAR_SHA" "$JAR_BYTES"
  printf 'provenance jdk-head=%s patch0015=%s patch0016=%s patch0017=%s patch0018=%s patch0019=%s\n' \
    "$JDK_HEAD" "$PATCH15_SHA" "$PATCH16_SHA" "$PATCH17_SHA" "$PATCH18_SHA" "$PATCH19_SHA"
  printf 'runtime-lane=%s final-0019-source-match=%s\n' \
    "$C1_RUNTIME_LANE" "$C1_SOURCE_MATCH"
  printf 'runtime-source-final-0019 globals=%s interpreter=%s baseline=%s\n' \
    "$SOURCE_GLOBALS_SHA" "$SOURCE_INTERPRETER_SHA" "$SOURCE_BASELINE_SHA"
  printf 'runtime-source-0017-postimage globals=%s interpreter=%s baseline=%s\n' \
    "$C1_0017_GLOBALS_SHA" "$C1_0017_INTERPRETER_SHA" "$C1_0017_BASELINE_SHA"
  printf 'runtime-source-0018-postimage globals=%s interpreter=%s baseline=%s\n' \
    "$C1_0018_GLOBALS_SHA" "$C1_0018_INTERPRETER_SHA" "$C1_0018_BASELINE_SHA"
  printf 'runtime-source-0019-postimage globals=%s interpreter=%s baseline=%s\n' \
    "$C1_0019_GLOBALS_SHA" "$C1_0019_INTERPRETER_SHA" "$C1_0019_BASELINE_SHA"
  printf 'runtime-artifact libjvm=%s libjvm-sha=%s launcher-sha=%s lock-sha=%s\n' \
    "$LIBJVM" "$LIBJVM_SHA" "$LAUNCHER_SHA" "$LOCK_SHA"
  printf 'gate-artifacts gate-sha=%s log-checker-sha=%s wat-checker-sha=%s manifest-sha=%s\n' \
    "$(shasum -a 256 "$0" | awk '{print $1}')" \
    "$(shasum -a 256 "$LOG_CHECKER" | awk '{print $1}')" \
    "$(shasum -a 256 "$WAT_CHECKER" | awk '{print $1}')" "$MANIFEST_SHA"
  printf 'patch-boundary-artifact checker-sha=%s log-sha=%s\n' \
    "$(shasum -a 256 "$PATCH_BOUNDARY_CHECKER" | awk '{print $1}')" \
    "$(shasum -a 256 "$PATCH_BOUNDARY_EVIDENCE" | awk '{print $1}')"
  printf 'legacy-preservation mode=retained-evidence-bound-after-final-source\n'
  for legacy_log in $LEGACY_EVIDENCE_FILES; do
    printf 'legacy-evidence path=%s sha256=%s\n' "$legacy_log" \
      "$(shasum -a 256 "$legacy_log" | awk '{print $1}')"
  done
  printf 'legacy-evidence path=%s sha256=%s\n' "$PATCH_BOUNDARY_EVIDENCE" \
    "$(shasum -a 256 "$PATCH_BOUNDARY_EVIDENCE" | awk '{print $1}')"
  bundle_file_count=0
  while IFS= read -r bundle_path; do
    bundle_file="$EVIDENCE_STAGE/$bundle_path"
    printf 'bundle-file path=%s sha256=%s bytes=%s\n' \
      "$bundle_path" \
      "$(shasum -a 256 "$bundle_file" | awk '{print $1}')" \
      "$(wc -c < "$bundle_file" | awk '{print $1}')"
    bundle_file_count=$((bundle_file_count + 1))
  done <"$WORK/bundle-files.list"
  printf 'bundle-file-count checks-legacy-and-logs=%s\n' "$bundle_file_count"
} >"$EVIDENCE_STAGE/evidence.index"
actual_bundle_file_count=$(find "$EVIDENCE_STAGE/checks" "$EVIDENCE_STAGE/legacy" \
  "$EVIDENCE_STAGE/logs" -type f | wc -l | awk '{print $1}')
indexed_bundle_file_count=$(rg -c '^bundle-file path=(checks|legacy|logs)/' \
  "$EVIDENCE_STAGE/evidence.index" || printf 0)
[ "$actual_bundle_file_count" -eq "$indexed_bundle_file_count" ] \
  || reject "atomic evidence bundle file index count drift"
while IFS= read -r bundle_path; do
  bundle_file="$EVIDENCE_STAGE/$bundle_path"
  bundle_sha=$(shasum -a 256 "$bundle_file" | awk '{print $1}')
  bundle_bytes=$(wc -c < "$bundle_file" | awk '{print $1}')
  [ "$(rg -c -x -F "bundle-file path=$bundle_path sha256=$bundle_sha bytes=$bundle_bytes" \
    "$EVIDENCE_STAGE/evidence.index" || printf 0)" -eq 1 ] \
    || reject "atomic evidence bundle file index binding drift: $bundle_path"
done <"$WORK/bundle-files.list"
printf '# sha256  evidence.index\n' >"$EVIDENCE_STAGE/evidence.index.sha256"
shasum -a 256 "$EVIDENCE_STAGE/evidence.index" | awk '{print $1 "  evidence.index"}' \
  >>"$EVIDENCE_STAGE/evidence.index.sha256"
sync
mv -f -- "$EVIDENCE_STAGE" "$EVIDENCE_ROOT"
EVIDENCE_INDEX_SHA=$(shasum -a 256 "$EVIDENCE_ROOT/evidence.index" | awk '{print $1}')
printf '%s\n' \
  "m2-c1=ACCEPT fixture-source-sha=$SOURCE_SHA fixture-jar-sha=$JAR_SHA fixture-jar-bytes=$JAR_BYTES" \
  "execution-input=class-directory fixture-jar=provenance/cache-identity-only" \
  "direct=5 fallback=5 forced-fallback=10 root=post-return-gc-identity" \
  "module-sha=$MODULE_SHA module-bytes=$MODULE_BYTES dynamic-slot=$install_slot" \
  "compiler=zero-baseline-abi-v1 memory=shared max-pages=65536" \
  "source-sha-baseline=$SOURCE_BASELINE_SHA" \
  "source-sha-interpreter=$SOURCE_INTERPRETER_SHA" \
  "source-sha-globals=$SOURCE_GLOBALS_SHA" \
  "runtime-lane=$C1_RUNTIME_LANE final-0019-source-match=$C1_SOURCE_MATCH" \
  "runtime-source-0017-postimage globals=$C1_0017_GLOBALS_SHA interpreter=$C1_0017_INTERPRETER_SHA baseline=$C1_0017_BASELINE_SHA" \
  "runtime-source-0018-postimage globals=$C1_0018_GLOBALS_SHA interpreter=$C1_0018_INTERPRETER_SHA baseline=$C1_0018_BASELINE_SHA" \
  "runtime-source-0019-postimage globals=$C1_0019_GLOBALS_SHA interpreter=$C1_0019_INTERPRETER_SHA baseline=$C1_0019_BASELINE_SHA" \
  "provenance patch0015=$PATCH15_SHA patch0016=$PATCH16_SHA patch0017=$PATCH17_SHA patch0018=$PATCH18_SHA patch0019=$PATCH19_SHA" \
  "gate-envelope started-epoch=$STARTED_EPOCH finished-epoch=$FINISHED_EPOCH exit=0" \
  "evidence-root=$EVIDENCE_ROOT evidence-index-sha=$EVIDENCE_INDEX_SHA"
