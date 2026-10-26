#!/bin/sh
# OSS-only M1-C class-initialization fallback gate for the Zero linked unit.
# InitOK/InitFail are synthetic fixture classes; no Minecraft or proprietary
# input is read by this test. The second successful access remains interpreted.
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
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-class-init.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

reject() {
  echo "REJECT M1-C linked class-init gate: $*" >&2
  exit 1
}

[ -x "$JAVAC" ] || reject "javac unavailable: $JAVAC"
[ -x "$JAR" ] || reject "jar unavailable: $JAR"
[ -x "$JAVAP" ] || reject "javap unavailable: $JAVAP"
[ -x "$RUN_JAVA" ] || reject "run-java.sh unavailable"
[ -d "$JDK/.git" ] || reject "missing prepared OpenJDK checkout"
for patch in "$PATCH6" "$PATCH7" "$PATCH8" "$PATCH9" "$PATCH10" "$PATCH11" "$PATCH12" "$PATCH13" "$PATCH14" "$PATCH15" "$PATCH16"; do
  [ -f "$patch" ] || reject "missing source patch: $patch"
done

sh -n "$0" || reject "gate shell syntax"
sh -n "$ROOT/setup.sh" || reject "setup shell syntax"
PROVENANCE18="$ROOT/tests/check-zero-0018-legacy-provenance.sh"
[ -x "$PROVENANCE18" ] || reject "0018 provenance checker unavailable"
"$PROVENANCE18" "$ROOT" "$JDK" "$WORK/provenance-0018" \
  || reject "0018 clean/final provenance failed"
if [ "${MCWEB_ZERO_VALIDATE_LEGACY_0016_SOURCE:-0}" = 1 ]; then
awk '
  /git apply.*0005-zero-wasm-baseline\.patch/ { five = NR }
  /git apply.*0006-zero-wasm-linked-group\.patch/ { six = NR }
  /git apply.*0007-zero-wasm-linked-oop-store\.patch/ { seven = NR }
  /git apply.*0008-zero-wasm-linked-alloc-bail\.patch/ { eight = NR }
  /git apply.*0009-zero-wasm-linked-class-init-bail\.patch/ { nine = NR }
  /git apply.*0010-zero-wasm-linked-virtual-guard\.patch/ { ten = NR }
  /git apply.*0011-zero-wasm-linked-idiv-resume\.patch/ { eleven = NR }
  /git apply.*0012-zero-wasm-linked-invoke-throw-resume\.patch/ { twelve = NR }
  /git apply.*0013-zero-wasm-linked-benchmark\.patch/ { thirteen = NR }
  /git apply.*0014-zero-wasm-linked-int-array-load\.patch/ { fourteen = NR }
  /git apply.*0015-zero-wasm-linked-int-array-store\.patch/ { fifteen = NR }
  /git apply.*0016-zero-wasm-linked-ref-array-load\.patch/ { sixteen = NR }
  END { exit !(five && six && seven && eight && nine && ten && eleven && twelve && thirteen && fourteen && fifteen && sixteen &&
    six == five + 1 && seven == six + 1 && eight == seven + 1 &&
    nine == eight + 1 && ten == nine + 1 && eleven == ten + 1 &&
    twelve == eleven + 1 && thirteen == twelve + 1 && fourteen == thirteen + 1 && fifteen == fourteen + 1 && sixteen == fifteen + 1) }
' "$ROOT/setup.sh" || reject "setup patch order is not atomic"

# Reverse the complete nested source delta in a temporary tree, newest first.
PATCH_CHECK="$WORK/patch-check"
mkdir -p "$PATCH_CHECK"
for patch in "$PATCH16" "$PATCH15" "$PATCH14" "$PATCH13" "$PATCH12" "$PATCH11" "$PATCH10" "$PATCH9" "$PATCH8" "$PATCH7" "$PATCH6"; do
  for file_path in $(awk '/^diff --git / { print $4 }' "$patch" | sed 's#^b/##' | LC_ALL=C sort -u); do
    [ -f "$JDK/$file_path" ] || reject "prepared source is missing $file_path"
    mkdir -p "$PATCH_CHECK/$(dirname "$file_path")"
    cp "$JDK/$file_path" "$PATCH_CHECK/$file_path"
  done
done
git -C "$PATCH_CHECK" init -q
for patch in "$PATCH16" "$PATCH15" "$PATCH14" "$PATCH13" "$PATCH12" "$PATCH11" "$PATCH10" "$PATCH9" "$PATCH8" "$PATCH7" "$PATCH6"; do
  git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$patch" \
    || reject "prepared source does not match $(basename "$patch")"
  git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$patch" \
    || reject "reverse application failed: $(basename "$patch")"
done
fi

mkdir -p "$WORK/classes"
"$JAVAC" -g:none -d "$WORK/classes" "$ROOT/tests/ZeroBaselineFixture.java"
for expected in \
  ZeroBaselineFixture.class \
  ZeroBaselineFixture\$Box.class \
  ZeroBaselineFixture\$Trace.class \
  ZeroBaselineFixture\$InitOK.class \
  ZeroBaselineFixture\$InitFail.class \
  ZeroBaselineFixture\$Shape.class \
  ZeroBaselineFixture\$Good.class \
  ZeroBaselineFixture\$Other.class \
  ZeroBaselineFixture\$Base.class \
  ZeroBaselineFixture\$SubGood.class; do
  [ -f "$WORK/classes/$expected" ] || reject "missing dependency class $expected"
done
class_count=$(find "$WORK/classes" -type f -name '*.class' | wc -l | awk '{print $1}')
[ "$class_count" -eq 10 ] || reject "fixture dependency closure has $class_count classes, expected 10"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$WORK/fixture.jar" -C "$WORK/classes" .

INIT_BCI=$(
  "$JAVAP" -classpath "$WORK/classes" -c -p ZeroBaselineFixture |
    awk '/^  public static int initCaller/ { in_init = 1; next }
      in_init && /^  public static int / { exit }
      in_init && /invokestatic/ { sub(":", "", $1); print $1; exit }'
)
FAIL_BCI=$(
  "$JAVAP" -classpath "$WORK/classes" -c -p ZeroBaselineFixture |
    awk '/^  public static int failCaller/ { in_fail = 1; next }
      in_fail && /^  public static int / { exit }
      in_fail && /invokestatic/ { sub(":", "", $1); print $1; exit }'
)
[ -n "$INIT_BCI" ] || reject "could not derive initCaller invoke BCI"
[ -n "$FAIL_BCI" ] || reject "could not derive failCaller invoke BCI"
[ "$INIT_BCI" = 6 ] || reject "unexpected initCaller BCI=$INIT_BCI"
[ "$FAIL_BCI" = 0 ] || reject "unexpected failCaller BCI=$FAIL_BCI"

JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture.class" | awk '{print $1}')
DEPS=""
for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
  class_name=${class_file#"$WORK/classes/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  DEPS="${DEPS:+$DEPS,}${class_name}=sha256:$class_hash"
done

LINKED_ARGS="-XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmLinkedGroup -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS -XX:+ZeroWasmLinkedGroupVerbose"
"$RUN_JAVA" -Xmx32m -Xms16m -XX:+UseSerialGC '-Xlog:gc*=info' \
  -cp "$WORK/classes" ZeroBaselineFixture init >"$WORK/off.log" 2>&1
# shellcheck disable=SC2086
"$RUN_JAVA" -Xmx32m -Xms16m -XX:+UseSerialGC '-Xlog:gc*=info' $LINKED_ARGS \
  -cp "$WORK/classes" ZeroBaselineFixture init >"$WORK/on.log" 2>&1

off_transcript=$(rg '^init-' "$WORK/off.log" || true)
on_transcript=$(rg '^init-' "$WORK/on.log" || true)
[ "$off_transcript" = "$on_transcript" ] || reject "off/on transcript mismatch"
[ "$on_transcript" = "init-ok warm 0 first 42 second 42 runs 1 leaf-runs 2
init-fail first-eiie 1 second-ncdef 1 fail-runs 1" ] \
  || reject "unexpected init transcript"

[ "$(rg -c '^\[zbg\] INIT_DIRECT initCaller trigger=0 initialized=0$' "$WORK/on.log" || true)" = 1 ] \
  || reject "trigger=false unexpectedly initialized or did not return directly"
[ "$(rg -c "^\\[zbg\\] INIT_BAIL initCaller->InitOK.leaf reason=class-init resume-bci=$INIT_BCI depth=0 sp-offset=[0-9][0-9]* pending=0$" "$WORK/on.log" || true)" = 1 ] \
  || reject "success class-init bail missing or duplicated"
[ "$(rg -c '^\[zbg\] INIT_INTERPRETER initCaller initialized=1 reason=class-init-safe$' "$WORK/on.log" || true)" = 1 ] \
  || reject "second success access was not explicit interpreter-only"
[ "$(rg -c "^\\[zbg\\] INIT_FAIL_BAIL failCaller->InitFail.leaf reason=class-init resume-bci=$FAIL_BCI depth=0 pending=0$" "$WORK/on.log" || true)" = 1 ] \
  || reject "failing class-init bail missing or duplicated"
[ "$(rg -c '^\[zbg\] INIT_FAIL_INTERPRETER failCaller state=error$' "$WORK/on.log" || true)" = 1 ] \
  || reject "failing initializer did not enter error state"
[ "$(rg -c '^\[zbg\] ENTRY method=failCaller kind=9 params=0 static=1 arg0=na$' "$WORK/on.log" || true)" = 2 ] \
  || reject "zero-arg failCaller diagnostic count or shape incorrect"

direct_line=$(rg -n '^\[zbg\] INIT_DIRECT ' "$WORK/on.log" | cut -d: -f1)
bail_line=$(rg -n '^\[zbg\] INIT_BAIL ' "$WORK/on.log" | cut -d: -f1)
safe_line=$(rg -n '^\[zbg\] INIT_INTERPRETER ' "$WORK/on.log" | cut -d: -f1)
fail_bail_line=$(rg -n '^\[zbg\] INIT_FAIL_BAIL ' "$WORK/on.log" | cut -d: -f1)
fail_error_line=$(rg -n '^\[zbg\] INIT_FAIL_INTERPRETER ' "$WORK/on.log" | cut -d: -f1)
[ "$direct_line" -lt "$bail_line" ] && [ "$bail_line" -lt "$safe_line" ] \
  || reject "success class-init markers are out of order"
[ "$fail_bail_line" -lt "$fail_error_line" ] \
  || reject "failure class-init markers are out of order"
! rg -q 'CALL MISMATCH|PUSH_REJECT|pending=1|RESUME_REJECT|install failed' "$WORK/on.log" \
  || reject "runtime state/install failure marker present"
! rg -q '\b(fallback|FALLBACK)\b' "$WORK/on.log" \
  || reject "explicit fallback diagnostic present"

printf 'derived-init-bci=%s derived-fail-bci=%s source=javap-invokestatic\n' "$INIT_BCI" "$FAIL_BCI"
printf 'fixture-jar-sha256=%s fixture-class-sha256=%s\n' "$JAR_SHA" "$CLASS_SHA"
printf 'ACCEPT M1-C class-init fallback slice (second successful access interpreter-only)\n'
printf 'M1-D REJECT: compiled static read, virtual dispatch, exception continuation, GC/monitor continuation, cache, and resource gates remain open\n'
