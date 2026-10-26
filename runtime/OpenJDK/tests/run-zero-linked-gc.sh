#!/bin/sh
# OSS-only M1-B1 real-oop field-store gate for the opt-in Zero linked unit.
# The fixture is generated locally; no Minecraft, proprietary, or player input
# is read by this test.
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
WASM_DIS=${WASM_DIS:-/opt/homebrew/bin/wasm-dis}
WASM_DUMP=/private/tmp/mcweb-zero-linked-group.wasm
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-gc.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

reject() {
  echo "REJECT M1-B1 linked oop-store gate: $*" >&2
  exit 1
}

[ -x "$JAVAC" ] || reject "javac unavailable: $JAVAC"
[ -x "$JAR" ] || reject "jar unavailable: $JAR"
[ -x "$JAVAP" ] || reject "javap unavailable: $JAVAP"
[ -x "$RUN_JAVA" ] || reject "run-java.sh unavailable"
[ -x "$WASM_DIS" ] || reject "wasm-dis unavailable: $WASM_DIS"
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

# The source stack is transactional and ordered. Keep this check here as a
# cheap provenance guard in addition to the M1-A gate.
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

# Check 0007 against the prepared source without mutating the checkout.
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
git -C "$PATCH_CHECK" apply --reverse "$PATCH8" \
  || reject "0008 reverse application failed"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH7" \
  || reject "prepared source does not match 0007 patch after 0008"
git -C "$PATCH_CHECK" apply --reverse "$PATCH7" \
  || reject "0007 reverse application failed"
git -C "$PATCH_CHECK" apply --reverse --check "$PATCH6" \
  || reject "prepared source does not match 0006 after 0008 and 0007"
fi

mkdir -p "$WORK/classes"
"$JAVAC" -g:none -d "$WORK/classes" "$ROOT/tests/ZeroBaselineFixture.java"
class_count=$(find "$WORK/classes" -type f -name '*.class' | wc -l | awk '{print $1}')
[ "$class_count" -eq 10 ] || reject "fixture dependency closure has $class_count classes, expected 10"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$WORK/fixture.jar" -C "$WORK/classes" .

SOURCE_SHA=$(shasum -a 256 "$ROOT/tests/ZeroBaselineFixture.java" | awk '{print $1}')
JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture.class" | awk '{print $1}')
DEPS=""
for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
  class_name=${class_file#"$WORK/classes/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  DEPS="${DEPS:+$DEPS,}${class_name}=sha256:$class_hash"
done
[ -n "$DEPS" ] || reject "empty fixture dependency closure"

LINKED_ARGS="-XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmLinkedGroup -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS -XX:+ZeroWasmLinkedGroupVerbose"

run_case() {
  mode=$1
  log="$WORK/$mode.log"
  if [ "$mode" = on ]; then
    # shellcheck disable=SC2086
    "$RUN_JAVA" -Xmx32m -Xms16m -XX:+UseSerialGC -Xlog:gc*=info $LINKED_ARGS \
      -cp "$WORK/classes" ZeroBaselineFixture 1 >"$log" 2>&1
  else
    "$RUN_JAVA" -Xmx32m -Xms16m -XX:+UseSerialGC -Xlog:gc*=info \
      -cp "$WORK/classes" ZeroBaselineFixture 1 >"$log" 2>&1
  fi
}

rm -f "$WASM_DUMP"
run_case off
run_case on

off_transcript=$(rg '^baseline-fixture |^linked-gc ' "$WORK/off.log" || true)
on_transcript=$(rg '^baseline-fixture |^linked-gc ' "$WORK/on.log" || true)
[ -n "$off_transcript" ] || reject "missing off transcript"
[ "$off_transcript" = "$on_transcript" ] || reject "off/on transcript mismatch"
printf '%s\n' "$on_transcript"

rg -q '^baseline-fixture checksum 46 caught -1$' "$WORK/on.log" \
  || reject "unexpected fixture checksum or exception result"
rg -q '^linked-gc stored-tag 42 child-tag 42$' "$WORK/on.log" \
  || reject "child did not survive with tag 42"

direct_store=$(rg -c '^\[zbg\] DIRECT_CALL storeChildCaller->storeChild runtime=1$' "$WORK/on.log" || true)
[ "$direct_store" -eq 1 ] || reject "direct store edge count=$direct_store"
store_count=$(rg -c '^\[zbg\] OOP_STORE ' "$WORK/on.log" || true)
[ "$store_count" -eq 1 ] || reject "OOP_STORE count=$store_count"
store_line=$(rg -n '^\[zbg\] OOP_STORE ' "$WORK/on.log" | cut -d: -f1)
card_line=$(sed -n "${store_line}p" "$WORK/on.log")
card_before=$(printf '%s\n' "$card_line" | sed -n 's/.*card-before=\([0-9][0-9]*\).*/\1/p')
card_after=$(printf '%s\n' "$card_line" | sed -n 's/.*card-after=\([0-9][0-9]*\).*/\1/p')
card_dirty=$(printf '%s\n' "$card_line" | sed -n 's/.*card-dirty=\([0-9][0-9]*\).*/\1/p')
[ "$card_before" = 255 ] || reject "card-before=$card_before expected=255"
[ -n "$card_after" ] && [ "$card_after" = "$card_dirty" ] \
  || reject "card-after=$card_after card-dirty=$card_dirty"

# The first explicit full collection is the aging boundary for the Box root;
# the store must then be followed by an allocation-failure Young collection
# before the Java verification line. This avoids treating Full GC alone as the
# post-store reachability proof. The native marker does not expose object
# addresses/generations, so the gate reports that limitation explicitly.
pre_full=$(awk -v stop="$store_line" 'NR < stop && /Pause Full \(System\.gc\(\)\)/ { n++ } END { print n + 0 }' "$WORK/on.log")
[ "$pre_full" -ge 1 ] || reject "no pre-store System.gc full collection"
post_young=$(awk -v start="$store_line" 'NR > start && /Pause Young / { print NR; exit }' "$WORK/on.log")
verify_line=$(rg -n '^linked-gc stored-tag 42 child-tag 42$' "$WORK/on.log" | cut -d: -f1)
[ -n "$post_young" ] && [ "$post_young" -lt "$verify_line" ] \
  || reject "no post-store Young GC before verification"
post_gc_event=$(awk -v start="$store_line" -v stop="$verify_line" '
  NR > start && NR < stop && /\[info\]\[gc[[:space:]]*\].*Pause (Young|Full) / {
    if ($0 ~ /Pause Full /) { print "full"; exit }
    if ($0 ~ /Pause Young /) { print "young"; exit }
  }
' "$WORK/on.log")
[ "$post_gc_event" = young ] \
  || reject "first post-store GC event before verification was $post_gc_event, expected Young"

! rg -q '^\[zbg\] ENTRY method=storeChild kind=' "$WORK/on.log" \
  || reject "store leaf fell back to interpreter"
! rg -q 'CALL MISMATCH|PUSH_REJECT|pending=1|install failed|RESUME_REJECT' "$WORK/on.log" \
  || reject "runtime reported fallback, stack, pending, or install failure"
! rg -q '\b(fallback|FALLBACK)\b' "$WORK/on.log" \
  || reject "runtime emitted an explicit fallback diagnostic"
rg -q '^\[zbg\] ENTRY method=storeChildCaller kind=6 ' "$WORK/on.log" \
  || reject "store caller did not enter the linked group"
rg -q '^\[zbg\] ENTRY method=safeDiv kind=4 ' "$WORK/on.log" \
  || reject "safeDiv did not enter the accepted M1-E1 verifier"

[ -s "$WASM_DUMP" ] || reject "verbose linked module dump was not produced"
"$WASM_DIS" "$WASM_DUMP" -o "$WORK/linked-group.wat" \
  || reject "wasm-dis rejected the verbose linked module"
export_count=$(rg -c '^[[:space:]]*\(export ' "$WORK/linked-group.wat" || true)
[ "$export_count" -eq 10 ] || reject "linked module export count=$export_count expected=10"
for export_name in leaf caller virtualValue safeDiv storeChild storeChildCaller goodValue dispatch; do
  rg -q "^[[:space:]]*\\(export \"$export_name\" " "$WORK/linked-group.wat" \
    || reject "linked module is missing export $export_name"
done
import_count=$(rg -c '^[[:space:]]*\(import ' "$WORK/linked-group.wat" || true)
[ "$import_count" -eq 1 ] || reject "linked module import count=$import_count expected=1"
rg -q '^[[:space:]]*\(import "env" "memory" .* shared\)\)[[:space:]]*$' "$WORK/linked-group.wat" \
  || reject "linked module does not have only shared env.memory import"
! rg -q 'call_indirect' "$WORK/linked-group.wat" \
  || reject "linked module used an indirect call"
leaf_call_count=$(rg -c '\(call \$0' "$WORK/linked-group.wat" || true)
store_call_count=$(rg -c '\(call \$4' "$WORK/linked-group.wat" || true)
[ "$leaf_call_count" -eq 1 ] || reject "caller->leaf direct call count=$leaf_call_count"
[ "$store_call_count" -eq 1 ] || reject "storeChildCaller->storeChild direct call count=$store_call_count"

MODULE_SHA=$(shasum -a 256 "$WASM_DUMP" | awk '{print $1}')
printf 'fixture-source-sha256=%s\nfixture-jar-sha256=%s\nfixture-class-sha256=%s\nmodule-sha256=%s\n' "$SOURCE_SHA" "$JAR_SHA" "$CLASS_SHA" "$MODULE_SHA"
printf 'runtime-binding=fixture/module hashes asserted; machine libjvm hash intentionally not asserted\n'
printf 'guards=UseSerialGC/raw32/uncompressed/card-table (install and OOP_STORE evidence)\n'
printf 'tenuring-evidence=pre-store System.gc full collection; object generations/addresses are not exposed by the marker ABI\n'
printf 'post-store-gc=Young allocation-failure collection observed before verification\n'
printf 'ACCEPT M1-B1 linked oop store slice\n'
printf 'M1-B2 REJECT: Zero-frame continuation, reference arrays, monitors, real class-init, virtual JVM dispatch, exception continuation, and cache/resource gates remain open\n'
