#!/bin/sh
# OSS-only M1-B2 allocation-bail/root-liveness gate for the Zero linked unit.
# Allocation remains in the real interpreter; no Minecraft or proprietary
# input is read by this test.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JAVAC=${JAVAC:-/opt/homebrew/opt/openjdk@25/bin/javac}
JAR=${JAR:-/opt/homebrew/opt/openjdk@25/bin/jar}
JAVAP=${JAVAP:-/opt/homebrew/opt/openjdk@25/bin/javap}
RUN_JAVA="$ROOT/run-java.sh"
JDK="$ROOT/work/jdk25"
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
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-alloc-bail.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

reject() {
  echo "REJECT M1-B2 linked allocation-bail gate: $*" >&2
  exit 1
}

[ -x "$JAVAC" ] || reject "javac unavailable: $JAVAC"
[ -x "$JAR" ] || reject "jar unavailable: $JAR"
[ -x "$JAVAP" ] || reject "javap unavailable: $JAVAP"
[ -x "$RUN_JAVA" ] || reject "run-java.sh unavailable"
[ -d "$JDK/.git" ] || reject "missing prepared OpenJDK checkout"
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

sh -n "$0" || reject "gate shell syntax"
sh -n "$ROOT/setup.sh" || reject "setup shell syntax"
PROVENANCE18="$ROOT/tests/check-zero-0018-legacy-provenance.sh"
[ -x "$PROVENANCE18" ] || reject "0018 provenance checker unavailable"
"$PROVENANCE18" "$ROOT" "$JDK" "$WORK/provenance-0018" \
  || reject "0018 clean/final provenance failed"
if [ "${MCWEB_ZERO_VALIDATE_LEGACY_0016_SOURCE:-0}" = 1 ]; then
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
                six_line == five_line + 1 && seven_line == six_line + 1 &&
                eight_line == seven_line + 1 && nine_line == eight_line + 1 &&
                ten_line == nine_line + 1 && eleven_line == ten_line + 1 &&
                twelve_line == eleven_line + 1 && thirteen_line == twelve_line + 1 && fourteen_line == thirteen_line + 1 && fifteen_line == fourteen_line + 1 && sixteen_line == fifteen_line + 1) }
' "$ROOT/setup.sh" || reject "setup patch order is not atomic"

# Reverse-check the current nested source through the new patch and both
# object-lane predecessors without mutating the prepared checkout.
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
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH16" \
  || reject "prepared source does not match 0016 patch"
git -C "$PATCH_CHECK" apply --reverse "$PATCH16" \
  || reject "0016 reverse application failed"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH15" \
  || reject "prepared source does not match 0015 patch"
git -C "$PATCH_CHECK" apply --reverse "$PATCH15" \
  || reject "0015 reverse application failed"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH14" \
  || reject "prepared source does not match 0014 patch"
git -C "$PATCH_CHECK" apply --reverse "$PATCH14" \
  || reject "0014 reverse application failed"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH13" \
  || reject "prepared source does not match 0013 patch"
git -C "$PATCH_CHECK" apply --reverse "$PATCH13" \
  || reject "0013 reverse application failed"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH12" \
  || reject "prepared source does not match 0012 patch"
git -C "$PATCH_CHECK" apply --reverse "$PATCH12" \
  || reject "0012 reverse application failed"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH11" \
  || reject "prepared source does not match 0011 patch"
git -C "$PATCH_CHECK" apply --reverse "$PATCH11" \
  || reject "0011 reverse application failed"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH10" \
  || reject "prepared source does not match 0010 patch"
git -C "$PATCH_CHECK" apply --reverse "$PATCH10" \
  || reject "0010 reverse application failed"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH9" \
  || reject "prepared source does not match 0009 patch"
git -C "$PATCH_CHECK" apply --reverse "$PATCH9" \
  || reject "0009 reverse application failed"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH8" \
  || reject "prepared source does not match 0008 patch"
git -C "$PATCH_CHECK" apply --reverse "$PATCH8"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH7" \
  || reject "prepared source does not match 0007 after 0008"
git -C "$PATCH_CHECK" apply --reverse "$PATCH7"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH6" \
  || reject "prepared source does not match 0006 after 0008 and 0007"
fi

mkdir -p "$WORK/classes"
"$JAVAC" -g:none -d "$WORK/classes" "$ROOT/tests/ZeroBaselineFixture.java"
class_count=$(find "$WORK/classes" -type f -name '*.class' | wc -l | awk '{print $1}')
[ "$class_count" -eq 10 ] || reject "fixture dependency closure has $class_count classes, expected 10"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$WORK/fixture.jar" -C "$WORK/classes" .
JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture.class" | awk '{print $1}')
DEPS=""
for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
  class_name=${class_file#"$WORK/classes/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  DEPS="${DEPS:+$DEPS,}${class_name}=sha256:$class_hash"
done

ALLOC_BCI=$(
  "$JAVAP" -classpath "$WORK/classes" -c -p ZeroBaselineFixture |
    awk '
      /^  public static int allocCaller/ { in_alloc = 1; next }
      in_alloc && /^  public static int / { exit }
      in_alloc && /invokestatic/ { sub(":", "", $1); print $1; exit }
    '
)
[ -n "$ALLOC_BCI" ] || reject "could not derive allocCaller invoke BCI"

LINKED_ARGS="-XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmLinkedGroup -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS -XX:+ZeroWasmLinkedGroupVerbose"

run_case() {
  mode=$1
  log="$WORK/$mode.log"
  if [ "$mode" = on ]; then
    # shellcheck disable=SC2086
    "$RUN_JAVA" -Xmx32m -Xms16m -XX:+UseSerialGC '-Xlog:gc*=info' $LINKED_ARGS \
      -cp "$WORK/classes" ZeroBaselineFixture alloc >"$log" 2>&1
  else
    "$RUN_JAVA" -Xmx32m -Xms16m -XX:+UseSerialGC '-Xlog:gc*=info' \
      -cp "$WORK/classes" ZeroBaselineFixture alloc >"$log" 2>&1
  fi
}

run_case off
run_case on
off_transcript=$(rg '^alloc-bail ' "$WORK/off.log" || true)
on_transcript=$(rg '^alloc-bail ' "$WORK/on.log" || true)
[ "$off_transcript" = "$on_transcript" ] || reject "off/on transcript mismatch"
[ "$on_transcript" = "alloc-bail stored-tag 43 child-tag 43" ] \
  || reject "allocation result/root reachability mismatch"
printf '%s\n' "$on_transcript"

alloc_bail_pattern="^\\[zbg\\] ALLOC_BAIL allocCaller->allocLeaf reason=allocation resume-bci=$ALLOC_BCI depth=2 sp-offset=3 root-spilled=1 pending=0$"
[ "$(rg -c "$alloc_bail_pattern" "$WORK/on.log" || true)" -eq 1 ] \
  || reject "allocation bail marker missing or duplicated"
[ "$(rg -c '^\[zbg\] ENTRY method=allocCaller kind=7 ' "$WORK/on.log" || true)" -eq 1 ] \
  || reject "allocCaller was not recognized as linked-eligible"
[ "$(rg -c '^\[zbg\] ENTRY method=allocLeaf kind=0 ' "$WORK/on.log" || true)" -eq 1 ] \
  || reject "allocation leaf did not remain interpreted"
interpreter_alloc_markers=$(rg -c '^\[zbg\] INTERPRETER_ALLOC_LEAF count=' "$WORK/on.log" || true)
[ "$interpreter_alloc_markers" = 1 ] \
  || reject "allocation leaf interpreter marker count=$interpreter_alloc_markers expected=1"
interpreter_alloc_count=$(rg '^\[zbg\] INTERPRETER_ALLOC_LEAF count=' "$WORK/on.log" \
  | sed -n 's/.*count=\([0-9][0-9]*\)$/\1/p')
[ "$interpreter_alloc_count" = 1 ] \
  || reject "allocation leaf interpreter execution count=$interpreter_alloc_count expected=1"
! rg -q 'DIRECT_CALL allocCaller->allocLeaf' "$WORK/on.log" \
  || reject "allocation callee was called directly from Wasm"
! rg -q 'CALL MISMATCH|PUSH_REJECT|pending=1|install failed|RESUME_REJECT|\\b(fallback|FALLBACK)\\b' "$WORK/on.log" \
  || reject "allocation bail reported stack, pending, install, or fallback failure"

bail_line=$(rg -n '^\[zbg\] ALLOC_BAIL ' "$WORK/on.log" | cut -d: -f1)
verify_line=$(rg -n '^alloc-bail stored-tag 43 child-tag 43$' "$WORK/on.log" | cut -d: -f1)
post_young=$(awk -v start="$bail_line" -v stop="$verify_line" '
  NR > start && NR < stop && /Pause Young / { print NR; exit }
' "$WORK/on.log")
[ -n "$post_young" ] || reject "no external Young GC observed after allocation bail"
pre_full=$(awk -v stop="$bail_line" 'NR < stop && /Pause Full \(System\.gc\(\)\)/ { n++ } END { print n + 0 }' "$WORK/on.log")
[ "$pre_full" -ge 1 ] || reject "no pre-bail root-aging collection observed"

SOURCE_SHA=$(shasum -a 256 "$ROOT/tests/ZeroBaselineFixture.java" | awk '{print $1}')
printf 'fixture-source-sha256=%s\nfixture-jar-sha256=%s\nfixture-class-sha256=%s\n' "$SOURCE_SHA" "$JAR_SHA" "$CLASS_SHA"
printf 'invoke-bci=%s derived=javap-invokestatic\n' "$ALLOC_BCI"
printf 'gc-evidence=pre-bail System.gc full plus post-bail Young allocation-failure collection\n'
printf 'ACCEPT M1-B2 allocation-bail/root-liveness slice\n'
printf 'M1-B3 REJECT: compiled allocation/GC continuation, reference arrays, monitors, class-init, virtual dispatch, exception continuation, and cache/resource gates remain open\n'
