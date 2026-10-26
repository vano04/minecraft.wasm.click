#!/bin/sh
# OSS-only M1-D1 exact-class invokevirtual guard gate.
# The fixture is compiled locally; no Minecraft, proprietary, or player input
# is read by this test.  Class names in DISPATCH_BAIL are diagnostics only.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JAVAC=${JAVAC:-/opt/homebrew/opt/openjdk@25/bin/javac}
JAR=${JAR:-/opt/homebrew/opt/openjdk@25/bin/jar}
JAVAP=${JAVAP:-/opt/homebrew/opt/openjdk@25/bin/javap}
WASM_DIS=${WASM_DIS:-/opt/homebrew/bin/wasm-dis}
RUN_JAVA="$ROOT/run-java.sh"
JDK="$ROOT/work/jdk25"
WASM_DUMP=/private/tmp/mcweb-zero-linked-group.wasm
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-virtual.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

reject() { echo "REJECT M1-D1 linked virtual gate: $*" >&2; exit 1; }

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
  "$ROOT/patches/0006-zero-wasm-linked-group.patch" \
  "$ROOT/patches/0007-zero-wasm-linked-oop-store.patch" \
  "$ROOT/patches/0008-zero-wasm-linked-alloc-bail.patch" \
  "$ROOT/patches/0009-zero-wasm-linked-class-init-bail.patch" \
  "$ROOT/patches/0010-zero-wasm-linked-virtual-guard.patch" \
  "$ROOT/patches/0012-zero-wasm-linked-invoke-throw-resume.patch" \
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

# Verify the prepared source against the complete newest-to-oldest nested
# delta without mutating the checkout.
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
  git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$patch" \
    || reject "prepared source does not match $(basename "$patch")"
  git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$patch" \
    || reject "reverse application failed: $(basename "$patch")"
done
fi

mkdir -p "$WORK/classes"
"$JAVAC" -g:none -d "$WORK/classes" "$ROOT/tests/ZeroBaselineFixture.java"
expected_classes='ZeroBaselineFixture.class
ZeroBaselineFixture$Base.class
ZeroBaselineFixture$Box.class
ZeroBaselineFixture$Good.class
ZeroBaselineFixture$InitFail.class
ZeroBaselineFixture$InitOK.class
ZeroBaselineFixture$Other.class
ZeroBaselineFixture$Shape.class
ZeroBaselineFixture$SubGood.class
ZeroBaselineFixture$Trace.class'
printf '%s\n' "$expected_classes" | while IFS= read -r f; do
  [ -f "$WORK/classes/$f" ] || reject "missing dependency class $f"
done
class_count=$(find "$WORK/classes" -type f -name '*.class' | wc -l | awk '{print $1}')
[ "$class_count" -eq 10 ] || reject "fixture closure has $class_count classes, expected 10"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$WORK/fixture.jar" -C "$WORK/classes" .

DISPATCH_BCI=$(
  "$JAVAP" -classpath "$WORK/classes" -c -p ZeroBaselineFixture |
    awk '/public static int dispatch\(/ { in_dispatch=1; next }
      in_dispatch && /^  public static int / { exit }
      in_dispatch && /invokevirtual/ { sub(":", "", $1); print $1; exit }'
)
[ "$DISPATCH_BCI" = 2 ] || reject "derived dispatch invoke BCI=$DISPATCH_BCI expected 2"

JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture.class" | awk '{print $1}')
DEPS=''
for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
  class_name=${class_file#"$WORK/classes/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  DEPS="${DEPS:+$DEPS,}${class_name}=sha256:$class_hash"
done
[ -n "$DEPS" ] || reject "empty dependency manifest"
LINKED_ARGS="-XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmLinkedGroup -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS -XX:+ZeroWasmLinkedGroupVerbose"

rm -f "$WASM_DUMP"
"$RUN_JAVA" -Xmx256m -Xms16m -XX:+UseSerialGC -cp "$WORK/classes" \
  ZeroBaselineFixture dispatch >"$WORK/off.log" 2>&1
# shellcheck disable=SC2086
"$RUN_JAVA" -Xmx256m -Xms16m -XX:+UseSerialGC $LINKED_ARGS \
  -cp "$WORK/classes" ZeroBaselineFixture dispatch >"$WORK/on.log" 2>&1
off_transcript=$(rg '^dispatch ' "$WORK/off.log" || true)
on_transcript=$(rg '^dispatch ' "$WORK/on.log" || true)
[ "$off_transcript" = "$on_transcript" ] || reject "off/on transcript mismatch"
[ "$on_transcript" = 'dispatch warm 18 good 18 subgood 18 other 22 null-npe 1' ] \
  || reject "unexpected dispatch transcript"

[ "$(rg -c '^\[zbg\] ENTRY method=dispatch kind=0 params=2 static=1 ' "$WORK/on.log" || true)" -eq 1 ] \
  || reject "warm unresolved interpreter dispatch count is not one"
[ "$(rg -c '^\[zbg\] ENTRY method=dispatch kind=10 params=2 static=1 ' "$WORK/on.log" || true)" -eq 4 ] \
  || reject "linked dispatch entry count is not four"
metadata=$(rg '^\[zbg\] DIRECT_CALL dispatch->Good\.value runtime=1 table-index=[1-9][0-9]* target-bytecode-hash=[0-9a-f]+$' "$WORK/on.log" || true)
[ "$(printf '%s\n' "$metadata" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
  || reject "Good metadata/direct marker count is not one"
table_index=$(printf '%s\n' "$metadata" | sed -n 's/.*table-index=\([0-9][0-9]*\).*/\1/p')
target_hash=$(printf '%s\n' "$metadata" | sed -n 's/.*target-bytecode-hash=\([0-9a-f][0-9a-f]*\).*/\1/p')
[ -n "$table_index" ] && [ -n "$target_hash" ] || reject "missing resolved table index/target hash"

bail_count=$(rg -c '^\[zbg\] DISPATCH_BAIL reason=exact-class-or-null ' "$WORK/on.log" || true)
[ "$bail_count" -eq 3 ] || reject "dispatch bail count=$bail_count expected=3"
for receiver in 'ZeroBaselineFixture\$SubGood' 'ZeroBaselineFixture\$Other' null; do
  rg -q "^\[zbg\] DISPATCH_BAIL reason=exact-class-or-null receiver-class=$receiver expected-class=ZeroBaselineFixture\\\$Good resume-bci=$DISPATCH_BCI depth=2 pending=0$" "$WORK/on.log" \
    || reject "missing exact-class diagnostic for $receiver"
done
! rg -q 'CALL MISMATCH|PUSH_REJECT|RESUME_REJECT|pending=1|install failed|\b(fallback|FALLBACK)\b' "$WORK/on.log" \
  || reject "runtime emitted a failure/fallback marker"

[ -s "$WASM_DUMP" ] || reject "linked module dump missing"
"$WASM_DIS" "$WASM_DUMP" -o "$WORK/linked.wat" || reject "wasm-dis rejected linked module"
export_count=$(rg -c '^[[:space:]]*\(export ' "$WORK/linked.wat" || true)
[ "$export_count" -eq 10 ] || reject "module export count=$export_count expected 10"
for export_name in leaf caller virtualValue safeDiv storeChild storeChildCaller goodValue dispatch; do
  rg -q "^[[:space:]]*\(export \"$export_name\" " "$WORK/linked.wat" || reject "missing export $export_name"
done
import_count=$(rg -c '^[[:space:]]*\(import ' "$WORK/linked.wat" || true)
[ "$import_count" -eq 1 ] || reject "module import count=$import_count expected 1"
rg -q '^[[:space:]]*\(import "env" "memory" .*shared\)' "$WORK/linked.wat" || reject "module lacks shared env.memory import"
! rg -q 'call_indirect' "$WORK/linked.wat" || reject "module contains call_indirect"
rg -q '\(call \$6' "$WORK/linked.wat" || reject "dispatch lacks direct Good body call"
rg -q 'i32\.load offset=4' "$WORK/linked.wat" || reject "dispatch lacks VM-derived klass load offset"
! rg -q 'synthetic-tag|receiver-tag|dispatch.*tag' "$ROOT/work/jdk25/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" || reject "synthetic tag acceptance found"

printf 'derived-dispatch-bci=%s source=javap-invokevirtual\n' "$DISPATCH_BCI"
printf 'fixture-jar-sha256=%s fixture-class-sha256=%s table-index=%s target-bytecode-hash=%s\n' "$JAR_SHA" "$CLASS_SHA" "$table_index" "$target_hash"
printf 'module-export-count=%s module-import-count=%s wasm-dump=%s\n' "$export_count" "$import_count" "$WASM_DUMP"
printf 'diagnostic-class-names=SubGood,Other,null; guard acceptance=oop klass pointer equality only\n'
printf 'ACCEPT M1-D1 exact-class invokevirtual guard slice\n'
printf 'M1-D2 REJECT: cache/unloading/redefinition/performance/resource gates remain open; no cache or class-lifetime claim\n'
