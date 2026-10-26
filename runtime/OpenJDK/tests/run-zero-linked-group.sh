#!/bin/sh
# OSS-only M1-A direct-call plus guarded-resume gate for the Zero fixture.
# This gate never reads Minecraft, proprietary, or player-supplied inputs.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JAVAC=${JAVAC:-/opt/homebrew/opt/openjdk@25/bin/javac}
JAR=${JAR:-/opt/homebrew/opt/openjdk@25/bin/jar}
JAVAP=${JAVAP:-/opt/homebrew/opt/openjdk@25/bin/javap}
RUN_JAVA="$ROOT/run-java.sh"
PATCH6="$ROOT/patches/0006-zero-wasm-linked-group.patch"
PATCH7="$ROOT/patches/0007-zero-wasm-linked-oop-store.patch"
PATCH8="$ROOT/patches/0008-zero-wasm-linked-alloc-bail.patch"
PATCH9="$ROOT/patches/0009-zero-wasm-linked-class-init-bail.patch"
PATCH10="$ROOT/patches/0010-zero-wasm-linked-virtual-guard.patch"
PATCH11="$ROOT/patches/0011-zero-wasm-linked-idiv-resume.patch"
PATCH12="$ROOT/patches/0012-zero-wasm-linked-invoke-throw-resume.patch"
PATCH13="$ROOT/patches/0013-zero-wasm-linked-benchmark.patch"
PATCH14="$ROOT/patches/0014-zero-wasm-linked-int-array-load.patch"
PATCH15="$ROOT/patches/0015-zero-wasm-linked-int-array-store.patch"
PATCH16="$ROOT/patches/0016-zero-wasm-linked-ref-array-load.patch"
JDK="$ROOT/work/jdk25"
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-gate.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

reject() {
  echo "REJECT M1-A linked-group gate: $*" >&2
  exit 1
}

[ -x "$JAVAC" ] || reject "javac unavailable: $JAVAC"
[ -x "$JAR" ] || reject "jar unavailable: $JAR"
[ -x "$JAVAP" ] || reject "javap unavailable: $JAVAP"
[ -x "$RUN_JAVA" ] || reject "run-java.sh unavailable"
[ -f "$PATCH6" ] || reject "missing 0006 source patch"
[ -f "$PATCH7" ] || reject "missing 0007 source patch"
[ -f "$PATCH8" ] || reject "missing 0008 source patch"
[ -f "$PATCH9" ] || reject "missing 0009 source patch"
[ -f "$PATCH10" ] || reject "missing 0010 source patch"
[ -f "$PATCH11" ] || reject "missing 0011 source patch"
[ -f "$PATCH12" ] || reject "missing 0012 source patch"
[ -f "$PATCH13" ] || reject "missing 0013 source patch"
[ -f "$PATCH14" ] || reject "missing 0014 source patch"
[ -f "$PATCH15" ] || reject "missing 0015 source patch"
[ -f "$PATCH16" ] || reject "missing 0016 source patch"
[ -d "$JDK/.git" ] || reject "missing prepared OpenJDK checkout"

# Keep the gate itself and setup.sh valid for the declared /bin/sh contract.
sh -n "$0" || reject "gate shell syntax"
sh -n "$ROOT/setup.sh" || reject "setup shell syntax"
PROVENANCE18="$ROOT/tests/check-zero-0018-legacy-provenance.sh"
[ -x "$PROVENANCE18" ] || reject "0018 provenance checker unavailable"
"$PROVENANCE18" "$ROOT" "$JDK" "$WORK/provenance-0018" \
  || reject "0018 clean/final provenance failed"
if [ "${MCWEB_ZERO_VALIDATE_LEGACY_0016_SOURCE:-0}" = 1 ]; then

# Patches 0005, 0006, and 0007 must be adjacent in the one-time checkout block, so
# the source used by this gate and the durable patch cannot silently diverge.
awk '
  /git apply.*0005-zero-wasm-baseline\.patch/ { five_line = NR }
  /git apply.*0006-zero-wasm-linked-group\.patch/ { six_line = NR }
  /git apply.*0007-zero-wasm-linked-oop-store\.patch/ { seven_line = NR }
  /git apply.*0008-zero-wasm-linked-alloc-bail\.patch/ { eight_line = NR }
  /git apply.*0009-zero-wasm-linked-class-init-bail\.patch/ { nine_line = NR }
  /git apply.*0010-zero-wasm-linked-virtual-guard\.patch/ { ten_line = NR }
  /git apply.*0011-zero-wasm-linked-idiv-resume\.patch/ { eleven_line = NR }
  /git apply.*0012-zero-wasm-linked-invoke-throw-resume\.patch/ { twelve_line = NR }
  /git apply.*0013-zero-wasm-linked-benchmark\.patch/ { thirteen_line = NR }
  /git apply.*0014-zero-wasm-linked-int-array-load\.patch/ { fourteen_line = NR }
  /git apply.*0015-zero-wasm-linked-int-array-store\.patch/ { fifteen_line = NR }
  /git apply.*0016-zero-wasm-linked-ref-array-load\.patch/ { sixteen_line = NR }
  END { exit !(five_line && six_line && seven_line && eight_line && nine_line && ten_line && eleven_line && twelve_line && thirteen_line && fourteen_line && fifteen_line && sixteen_line &&
                six_line == (five_line + 1) && seven_line == (six_line + 1) &&
                eight_line == (seven_line + 1) && nine_line == (eight_line + 1) &&
                ten_line == (nine_line + 1) && eleven_line == (ten_line + 1) &&
                twelve_line == (eleven_line + 1) && thirteen_line == (twelve_line + 1) && fourteen_line == (thirteen_line + 1) && fifteen_line == (fourteen_line + 1) && sixteen_line == (fifteen_line + 1)) }
' "$ROOT/setup.sh" || reject "setup patch order is not atomic"

# The prepared checkout must be exactly reverse-applicable to 0008, 0007, and
# then 0006. Check in a temporary copy so the real checkout remains untouched
# and each older patch is checked against its true predecessor.
PATCH_CHECK="$WORK/patch-check"
mkdir -p "$PATCH_CHECK"
for patch in "$PATCH16" "$PATCH15" "$PATCH14" "$PATCH13" "$PATCH12" "$PATCH11" "$PATCH10" "$PATCH9" "$PATCH8" "$PATCH7" "$PATCH6"; do
  for file_path in $(awk '/^diff --git / { print $4 }' "$patch" | sed 's#^b/##' | LC_ALL=C sort -u); do
    [ -n "$file_path" ] || continue
    [ -f "$JDK/$file_path" ] || reject "prepared source is missing $file_path"
    mkdir -p "$PATCH_CHECK/$(dirname "$file_path")"
    cp "$JDK/$file_path" "$PATCH_CHECK/$file_path"
  done
done
git -C "$PATCH_CHECK" init -q
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$PATCH16" \
  || reject "prepared source does not match 0016 patch"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$PATCH16" \
  || reject "0016 reverse application failed"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$PATCH15" \
  || reject "prepared source does not match 0015 patch"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$PATCH15" \
  || reject "0015 reverse application failed"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$PATCH14" \
  || reject "prepared source does not match 0014 patch"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$PATCH14" \
  || reject "0014 reverse application failed"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$PATCH13" \
  || reject "prepared source does not match 0013 patch"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$PATCH13" \
  || reject "0013 reverse application failed"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$PATCH12" \
  || reject "prepared source does not match 0012 patch"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$PATCH12" \
  || reject "0012 reverse application failed"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$PATCH11" \
  || reject "prepared source does not match 0011 patch"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$PATCH11" \
  || reject "0011 reverse application failed"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$PATCH10" \
  || reject "prepared source does not match 0010 patch"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$PATCH10" \
  || reject "0010 reverse application failed"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$PATCH9" \
  || reject "prepared source does not match 0009 patch"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$PATCH9" \
  || reject "0009 reverse application failed"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$PATCH8" \
  || reject "prepared source does not match 0008 patch"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$PATCH8" \
  || reject "0008 reverse application failed"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$PATCH7" \
  || reject "prepared source does not match 0007 patch after 0009 and 0008"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$PATCH7" \
  || reject "0007 reverse application failed"
git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$PATCH6" \
  || reject "prepared source does not match 0006 patch after 0009 through 0007"
fi

mkdir -p "$WORK/classes"
"$JAVAC" -g:none -d "$WORK/classes" "$ROOT/tests/ZeroBaselineFixture.java"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$WORK/fixture.jar" -C "$WORK/classes" .
JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture.class" | awk '{print $1}')

# The resume BCI is derived from the compiled fixture, not hard-coded only in
# the shell assertion. javap's first field is the actual bytecode index.
VIRTUAL_BCI=$(
  "$JAVAP" -classpath "$WORK/classes" -c -p ZeroBaselineFixture |
    awk '
      /^  public static int virtualValue/ { in_virtual = 1; next }
      in_virtual && /^  public static int / { exit }
      in_virtual && /invokeinterface/ { sub(":", "", $1); print $1; exit }
    '
)
[ -n "$VIRTUAL_BCI" ] || reject "could not derive virtual invoke BCI"

DEPS=""
for class_file in $(rg --files -g '*.class' "$WORK/classes" | LC_ALL=C sort); do
  class_name=${class_file#"$WORK/classes/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  DEPS="${DEPS:+$DEPS,}${class_name}=sha256:$class_hash"
done
[ -n "$DEPS" ] || reject "empty fixture dependency closure"

LINKED_ARGS="-XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmLinkedGroup -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS -XX:+ZeroWasmLinkedGroupVerbose"

run_case() {
  count=$1
  mode=$2
  log="$WORK/$mode-$count.log"
  if [ "$mode" = on ]; then
    # shellcheck disable=SC2086
    "$RUN_JAVA" -Xmx256m -Xms16m -XX:+UseSerialGC $LINKED_ARGS \
      -cp "$WORK/classes" ZeroBaselineFixture "$count" >"$log" 2>&1
  else
    "$RUN_JAVA" -Xmx256m -Xms16m -XX:+UseSerialGC \
      -cp "$WORK/classes" ZeroBaselineFixture "$count" >"$log" 2>&1
  fi
  echo "$log"
}

OFF_1=$(run_case 1 off)
ON_1=$(run_case 1 on)
OFF_10=$(run_case 10 off)
ON_10=$(run_case 10 on)

for count in 1 10; do
  off_log=$WORK/off-$count.log
  on_log=$WORK/on-$count.log
  off_result=$(rg '^baseline-fixture ' "$off_log" || true)
  on_result=$(rg '^baseline-fixture ' "$on_log" || true)
  [ -n "$off_result" ] || reject "missing off result n=$count"
  [ "$off_result" = "$on_result" ] \
    || reject "stable checksum result mismatch n=$count"
done

direct_count=$(rg -c '^\[zbg\] DIRECT_CALL caller->leaf runtime=1$' "$ON_1" || true)
[ "$direct_count" -eq 1 ] || reject "n=1 direct caller marker count=$direct_count"
rg -q '^\[zbg\] ENTRY method=caller kind=2 ' "$ON_1" \
  || reject "n=1 caller was not linked kind=2"

direct_count_10=$(rg -c '^\[zbg\] DIRECT_CALL caller->leaf runtime=1$' "$ON_10" || true)
[ "$direct_count_10" -eq 1 ] \
  || reject "n=10 direct caller marker count=$direct_count_10"
rg -q '^\[zbg\] ENTRY method=caller kind=2 ' "$ON_10" \
  || reject "n=10 caller was not linked kind=2"

guard_pattern="^\\[zbg\\] STATE_SPILL virtualValue status=DEOPT resume-bci=$VIRTUAL_BCI depth=2 sp-offset=3 pending=0$"
guard_1=$(rg -c "$guard_pattern" "$ON_1" || true)
guard_10=$(rg -c "$guard_pattern" "$ON_10" || true)
[ "$guard_1" -eq 2 ] || reject "n=1 guard spill count=$guard_1 expected=2"
[ "$guard_10" -eq 11 ] || reject "n=10 guard spill count=$guard_10 expected=11"

# Exception fallback is deliberately outside M1-A: the exact verifier must
# M1-E1 now owns safeDiv's exact opcode-reexecute lane; this M1-A gate only
# checks that the earlier direct/guard transcript remains intact.
rg -q '^\[zbg\] ENTRY method=safeDiv kind=4 ' "$ON_1" \
  || reject "safeDiv did not enter the accepted M1-E1 verifier"

for log in "$ON_1" "$ON_10"; do
  ! rg -q 'CALL MISMATCH|PUSH_REJECT|pending=1|install failed|RESUME_REJECT' "$log" \
    || reject "fail-closed/runtime error marker in $log"
done

echo "ACCEPT M1-A direct+guard slice"
echo "derived-virtual-resume-bci=$VIRTUAL_BCI source=javap-invokeinterface"
echo "n1-result=$(rg '^baseline-fixture ' "$ON_1")"
echo "n10-result=$(rg '^baseline-fixture ' "$ON_10")"
echo "n1-direct-marker-count=$direct_count n1-guard-spills=$guard_1"
echo "n10-direct-marker-count=$direct_count_10 n10-guard-spills=$guard_10"
echo "M1-B REJECT: Zero frame/GC/monitors/real class-init/dispatch/exceptions/cache/resource gates open"
echo "source-patch-reverse-check=pass setup-order=pass shell-syntax=pass"
