#!/bin/sh
# OSS-only M1-E1 same-frame idiv re-execution gate.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JAVAC=${JAVAC:-/opt/homebrew/opt/openjdk@25/bin/javac}
JAR=${JAR:-/opt/homebrew/opt/openjdk@25/bin/jar}
JAVAP=${JAVAP:-/opt/homebrew/opt/openjdk@25/bin/javap}
WASM_DIS=${WASM_DIS:-/opt/homebrew/bin/wasm-dis}
RUN_JAVA="$ROOT/run-java.sh"
JDK="$ROOT/work/jdk25"
WASM_DUMP=/private/tmp/mcweb-zero-linked-group.wasm
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-idiv.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

reject() { echo "REJECT M1-E1 linked idiv gate: $*" >&2; exit 1; }
[ -x "$JAVAC" ] || reject "javac unavailable: $JAVAC"
[ -x "$JAR" ] || reject "jar unavailable: $JAR"
[ -x "$JAVAP" ] || reject "javap unavailable: $JAVAP"
[ -x "$WASM_DIS" ] || reject "wasm-dis unavailable: $WASM_DIS"
[ -x "$RUN_JAVA" ] || reject "run-java.sh unavailable"
[ -d "$JDK/.git" ] || reject "missing prepared OpenJDK checkout"
PATCH14="$ROOT/patches/0014-zero-wasm-linked-int-array-load.patch"
PATCH15="$ROOT/patches/0015-zero-wasm-linked-int-array-store.patch"
PATCH16="$ROOT/patches/0016-zero-wasm-linked-ref-array-load.patch"
for patch in \
  "$PATCH16" \
  "$PATCH15" \
  "$PATCH14" \
  "$ROOT/patches/0013-zero-wasm-linked-benchmark.patch" \
  "$ROOT/patches/0012-zero-wasm-linked-invoke-throw-resume.patch" \
  "$ROOT/patches/0006-zero-wasm-linked-group.patch" \
  "$ROOT/patches/0007-zero-wasm-linked-oop-store.patch" \
  "$ROOT/patches/0008-zero-wasm-linked-alloc-bail.patch" \
  "$ROOT/patches/0009-zero-wasm-linked-class-init-bail.patch" \
  "$ROOT/patches/0010-zero-wasm-linked-virtual-guard.patch" \
  "$ROOT/patches/0011-zero-wasm-linked-idiv-resume.patch"; do
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

PATCH_CHECK="$WORK/patch-check"
mkdir -p "$PATCH_CHECK"
for patch in "$ROOT/patches/0016-zero-wasm-linked-ref-array-load.patch" \
             "$ROOT/patches/0015-zero-wasm-linked-int-array-store.patch" \
             "$ROOT/patches/0014-zero-wasm-linked-int-array-load.patch" \
             "$ROOT/patches/0013-zero-wasm-linked-benchmark.patch" \
             "$ROOT/patches/0012-zero-wasm-linked-invoke-throw-resume.patch" \
             "$ROOT/patches/0011-zero-wasm-linked-idiv-resume.patch" \
             "$ROOT/patches/0010-zero-wasm-linked-virtual-guard.patch" \
             "$ROOT/patches/0009-zero-wasm-linked-class-init-bail.patch" \
             "$ROOT/patches/0008-zero-wasm-linked-alloc-bail.patch" \
             "$ROOT/patches/0007-zero-wasm-linked-oop-store.patch" \
             "$ROOT/patches/0006-zero-wasm-linked-group.patch"; do
  for file_path in $(awk '/^diff --git / { print $4 }' "$patch" | sed 's#^b/##' | LC_ALL=C sort -u); do
    [ -f "$JDK/$file_path" ] || reject "prepared source is missing $file_path"
    mkdir -p "$PATCH_CHECK/$(dirname "$file_path")"
    cp "$JDK/$file_path" "$PATCH_CHECK/$file_path"
  done
done
git -C "$PATCH_CHECK" init -q
for patch in "$ROOT/patches/0016-zero-wasm-linked-ref-array-load.patch" \
             "$ROOT/patches/0015-zero-wasm-linked-int-array-store.patch" \
             "$ROOT/patches/0014-zero-wasm-linked-int-array-load.patch" \
             "$ROOT/patches/0013-zero-wasm-linked-benchmark.patch" \
             "$ROOT/patches/0012-zero-wasm-linked-invoke-throw-resume.patch" \
             "$ROOT/patches/0011-zero-wasm-linked-idiv-resume.patch" \
             "$ROOT/patches/0010-zero-wasm-linked-virtual-guard.patch" \
             "$ROOT/patches/0009-zero-wasm-linked-class-init-bail.patch" \
             "$ROOT/patches/0008-zero-wasm-linked-alloc-bail.patch" \
             "$ROOT/patches/0007-zero-wasm-linked-oop-store.patch" \
             "$ROOT/patches/0006-zero-wasm-linked-group.patch"; do
  git -C "$PATCH_CHECK" apply --reverse --check "$patch" || reject "source drift: $(basename "$patch")"
  git -C "$PATCH_CHECK" apply --reverse "$patch" || reject "reverse failed: $(basename "$patch")"
done
fi

mkdir -p "$WORK/classes"
"$JAVAC" -g:none -d "$WORK/classes" "$ROOT/tests/ZeroBaselineFixture.java"
for expected in \
  ZeroBaselineFixture.class ZeroBaselineFixture\$Base.class \
  ZeroBaselineFixture\$Box.class ZeroBaselineFixture\$Good.class \
  ZeroBaselineFixture\$InitFail.class ZeroBaselineFixture\$InitOK.class \
  ZeroBaselineFixture\$Other.class ZeroBaselineFixture\$Shape.class \
  ZeroBaselineFixture\$SubGood.class ZeroBaselineFixture\$Trace.class; do
  [ -f "$WORK/classes/$expected" ] || reject "missing dependency class $expected"
done
class_count=$(find "$WORK/classes" -type f -name '*.class' | wc -l | awk '{print $1}')
[ "$class_count" -eq 10 ] || reject "fixture closure has $class_count classes, expected 10"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$WORK/fixture.jar" -C "$WORK/classes" .

JAVAP_SAFE="$WORK/fixture.javap"
"$JAVAP" -classpath "$WORK/classes" -c -p ZeroBaselineFixture >"$JAVAP_SAFE"
IDIV_BCI=$(awk '/public static int safeDiv\(/ { in_safe=1; next }
  in_safe && /^  public static int / { in_safe=0 }
  in_safe && /: idiv/ && !found { sub(":", "", $1); print $1; found=1 }' "$JAVAP_SAFE")
EXC_START=$(awk '/Class java\/lang\/ArithmeticException/ && !found { print $1; found=1 }' "$JAVAP_SAFE")
EXC_END=$(awk '/Class java\/lang\/ArithmeticException/ && !found { print $2; found=1 }' "$JAVAP_SAFE")
HANDLER_BCI=$(awk '/Class java\/lang\/ArithmeticException/ && !found { print $3; found=1 }' "$JAVAP_SAFE")
[ -n "$IDIV_BCI" ] && [ -n "$EXC_START" ] && [ -n "$EXC_END" ] && [ -n "$HANDLER_BCI" ] || reject "javap metadata missing"
[ "$EXC_START" -le "$IDIV_BCI" ] && [ "$IDIV_BCI" -lt "$EXC_END" ] || reject "exception range misses idiv"

JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture.class" | awk '{print $1}')
DEPS=''
for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
  class_name=${class_file#"$WORK/classes/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  DEPS="${DEPS:+$DEPS,}${class_name}=sha256:${class_hash}"
done

"$RUN_JAVA" -Xmx256m -Xms16m -XX:+UseSerialGC -cp "$WORK/classes" ZeroBaselineFixture safeDiv >"$WORK/off.log" 2>&1
"$RUN_JAVA" -Xmx256m -Xms16m -XX:+UseSerialGC \
  -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmLinkedGroup \
  "-XX:ZeroWasmBaselineJarHash=$JAR_SHA" "-XX:ZeroWasmBaselineClassHash=$CLASS_SHA" \
  "-XX:ZeroWasmBaselineDependencyHashes=$DEPS" -XX:+ZeroWasmLinkedGroupVerbose \
  -cp "$WORK/classes" ZeroBaselineFixture safeDiv >"$WORK/on.log" 2>&1

expected='safeDiv normal 2 zero -1 min-over-minus-one -2147483648 min-over-zero -1'
[ "$(rg '^safeDiv ' "$WORK/off.log")" = "$expected" ] || reject "unexpected off result"
[ "$(rg '^safeDiv ' "$WORK/on.log")" = "$expected" ] || reject "unexpected linked result"
[ "$(rg -c '^\[zbg\] MODULE_ENTRY safeDiv ' "$WORK/on.log" || true)" -eq 4 ] || reject "module entry count"
[ "$(rg -c "^\[zbg\] OPCODE_REEXECUTE safeDiv resume-bci=$IDIV_BCI handler-bci=$HANDLER_BCI depth=2 .* pending=0$" "$WORK/on.log" || true)" -eq 3 ] || reject "opcode resume count/state"
[ "$(rg -c "^\[zbg\] INTERPRETER_IDIV_REEXEC safeDiv bci=$IDIV_BCI$" "$WORK/on.log" || true)" -eq 3 ] || reject "interpreter idiv count"
[ "$(rg -c "^\[zbg\] INTERPRETER_HANDLER safeDiv throw-bci=$IDIV_BCI$" "$WORK/on.log" || true)" -eq 2 ] || reject "handler count"
for pair in 'x=7 y=3' 'x=7 y=0' 'x=-2147483648 y=-1' 'x=-2147483648 y=0'; do
  rg -q "^\[zbg\] MODULE_ENTRY safeDiv $pair idiv-bci=$IDIV_BCI$" "$WORK/on.log" || reject "operand order: $pair"
done
! rg -q 'CALL MISMATCH|PUSH_REJECT|RESUME_REJECT|pending=1|install failed|fallback|FALLBACK|wasm trap|sentinel|FATAL' "$WORK/on.log" || reject "failure marker present"

[ -s "$WASM_DUMP" ] || reject "linked module dump missing"
"$WASM_DIS" "$WASM_DUMP" -o "$WORK/linked.wat" || reject "wasm-dis rejected module"
[ "$(rg -c '^[[:space:]]*\(export ' "$WORK/linked.wat" || true)" -eq 10 ] || reject "superset export count"
for export_name in leaf caller virtualValue safeDiv storeChild storeChildCaller goodValue dispatch; do
  rg -q "^[[:space:]]*\(export \"$export_name\" " "$WORK/linked.wat" || reject "missing export $export_name"
done

printf 'derived-idiv-bci=%s exception-range=%s..%s handler-bci=%s catch=java/lang/ArithmeticException\n' "$IDIV_BCI" "$EXC_START" "$EXC_END" "$HANDLER_BCI"
printf 'module-entry=4 opcode-reexecute=3 interpreter-idiv=3 canonical-handler=2\n'
printf 'operand-order=x-then-y markers verified; module-export-count=10\n'
printf 'ACCEPT M1-E1 same-frame idiv re-execution slice\n'
printf 'E2 REJECT: compiled handlers/direct-callee continuation/performance/cache/resource gates remain open\n'
