#!/bin/sh
# OSS-only M1-E2 direct-callee throw and same-frame invoke-resume gate.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JAVAC=${JAVAC:-/opt/homebrew/opt/openjdk@25/bin/javac}
JAR=${JAR:-/opt/homebrew/opt/openjdk@25/bin/jar}
JAVAP=${JAVAP:-/opt/homebrew/opt/openjdk@25/bin/javap}
WASM_DIS=${WASM_DIS:-/opt/homebrew/bin/wasm-dis}
RUN_JAVA="$ROOT/run-java.sh"
JDK="$ROOT/work/jdk25"
WASM_DUMP=/private/tmp/mcweb-zero-linked-group.wasm
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-throw.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM
reject() { echo "REJECT M1-E2 linked throw gate: $*" >&2; exit 1; }
for tool in "$JAVAC" "$JAR" "$JAVAP" "$WASM_DIS" "$RUN_JAVA"; do
  [ -x "$tool" ] || reject "tool unavailable: $tool"
done
[ -d "$JDK/.git" ] || reject "missing prepared OpenJDK checkout"
PATCHES="0006-zero-wasm-linked-group.patch
0007-zero-wasm-linked-oop-store.patch
0008-zero-wasm-linked-alloc-bail.patch
0009-zero-wasm-linked-class-init-bail.patch
0010-zero-wasm-linked-virtual-guard.patch
0011-zero-wasm-linked-idiv-resume.patch
0012-zero-wasm-linked-invoke-throw-resume.patch
0013-zero-wasm-linked-benchmark.patch
0014-zero-wasm-linked-int-array-load.patch
0015-zero-wasm-linked-int-array-store.patch
0016-zero-wasm-linked-ref-array-load.patch"
for patch_name in $PATCHES; do
  [ -f "$ROOT/patches/$patch_name" ] || reject "missing source patch: $patch_name"
done
sh -n "$0" || reject "gate shell syntax"
sh -n "$ROOT/setup.sh" || reject "setup syntax"
PROVENANCE18="$ROOT/tests/check-zero-0018-legacy-provenance.sh"
[ -x "$PROVENANCE18" ] || reject "0018 provenance checker unavailable"
"$PROVENANCE18" "$ROOT" "$JDK" "$WORK/provenance-0018" \
  || reject "0018 clean/final provenance failed"
if [ "${MCWEB_ZERO_VALIDATE_LEGACY_0016_SOURCE:-0}" = 1 ]; then
awk '
 /git apply.*0005-zero-wasm-baseline\.patch/ {five=NR}
 /git apply.*0006-zero-wasm-linked-group\.patch/ {six=NR}
 /git apply.*0007-zero-wasm-linked-oop-store\.patch/ {seven=NR}
 /git apply.*0008-zero-wasm-linked-alloc-bail\.patch/ {eight=NR}
 /git apply.*0009-zero-wasm-linked-class-init-bail\.patch/ {nine=NR}
 /git apply.*0010-zero-wasm-linked-virtual-guard\.patch/ {ten=NR}
 /git apply.*0011-zero-wasm-linked-idiv-resume\.patch/ {eleven=NR}
 /git apply.*0012-zero-wasm-linked-invoke-throw-resume\.patch/ {twelve=NR}
 /git apply.*0013-zero-wasm-linked-benchmark\.patch/ {thirteen=NR}
 /git apply.*0014-zero-wasm-linked-int-array-load\.patch/ {fourteen=NR}
 /git apply.*0015-zero-wasm-linked-int-array-store\.patch/ {fifteen=NR}
 /git apply.*0016-zero-wasm-linked-ref-array-load\.patch/ {sixteen=NR}
 END {exit !(five&&six&&seven&&eight&&nine&&ten&&eleven&&twelve&&thirteen&&fourteen&&fifteen&&sixteen&&six==five+1&&seven==six+1&&eight==seven+1&&nine==eight+1&&ten==nine+1&&eleven==ten+1&&twelve==eleven+1&&thirteen==twelve+1&&fourteen==thirteen+1&&fifteen==fourteen+1&&sixteen==fifteen+1)}' "$ROOT/setup.sh" ||
 reject "setup patch order is not atomic"
PATCH_CHECK="$WORK/patch-check"; mkdir -p "$PATCH_CHECK"
for patch_name in 0016-zero-wasm-linked-ref-array-load.patch 0015-zero-wasm-linked-int-array-store.patch 0014-zero-wasm-linked-int-array-load.patch 0013-zero-wasm-linked-benchmark.patch 0012-zero-wasm-linked-invoke-throw-resume.patch 0011-zero-wasm-linked-idiv-resume.patch 0010-zero-wasm-linked-virtual-guard.patch 0009-zero-wasm-linked-class-init-bail.patch 0008-zero-wasm-linked-alloc-bail.patch 0007-zero-wasm-linked-oop-store.patch 0006-zero-wasm-linked-group.patch; do
  patch="$ROOT/patches/$patch_name"
  for file_path in $(awk '/^diff --git / {print $4}' "$patch" | sed 's#^b/##' | LC_ALL=C sort -u); do
    [ -f "$JDK/$file_path" ] || reject "prepared source missing $file_path"
    mkdir -p "$PATCH_CHECK/$(dirname "$file_path")"
    cp "$JDK/$file_path" "$PATCH_CHECK/$file_path"
  done
done
git -c core.fsmonitor=false -C "$PATCH_CHECK" init -q
for patch_name in 0016-zero-wasm-linked-ref-array-load.patch 0015-zero-wasm-linked-int-array-store.patch 0014-zero-wasm-linked-int-array-load.patch 0013-zero-wasm-linked-benchmark.patch 0012-zero-wasm-linked-invoke-throw-resume.patch 0011-zero-wasm-linked-idiv-resume.patch 0010-zero-wasm-linked-virtual-guard.patch 0009-zero-wasm-linked-class-init-bail.patch 0008-zero-wasm-linked-alloc-bail.patch 0007-zero-wasm-linked-oop-store.patch 0006-zero-wasm-linked-group.patch; do
  patch="$ROOT/patches/$patch_name"
  git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse --check "$patch" || reject "source drift: $patch_name"
  git -c core.fsmonitor=false -C "$PATCH_CHECK" apply --reverse "$patch" || reject "reverse failed: $patch_name"
done
fi
mkdir -p "$WORK/classes"
"$JAVAC" -g:none -d "$WORK/classes" "$ROOT/tests/ZeroBaselineFixture.java"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$WORK/fixture.jar" -C "$WORK/classes" .
JAVAP_FIXTURE="$WORK/fixture.javap"
CALLER="$WORK/throw-caller.javap"
LEAF="$WORK/throw-leaf.javap"
"$JAVAP" -classpath "$WORK/classes" -c -p ZeroBaselineFixture >"$JAVAP_FIXTURE"
awk '/public static int throwCaller\(/ {in_method=1;next}
  in_method && /^  public static int / {in_method=0}
  in_method {print}' "$JAVAP_FIXTURE" >"$CALLER"
awk '/public static int throwLeaf\(/ {in_method=1;next}
  in_method && /^  public static int / {in_method=0}
  in_method {print}' "$JAVAP_FIXTURE" >"$LEAF"
INVOKE_BCI=$(awk '/invokestatic.*throwLeaf/ && !found {sub(":", "", $1); print $1; found=1}' "$CALLER")
EXC_START=$(awk '/Class java\/lang\/IllegalStateException/ && !found {print $1; found=1}' "$CALLER")
EXC_END=$(awk '/Class java\/lang\/IllegalStateException/ && !found {print $2; found=1}' "$CALLER")
HANDLER_BCI=$(awk '/Class java\/lang\/IllegalStateException/ && !found {print $3; found=1}' "$CALLER")
[ "$INVOKE_BCI" = 1 ] || reject "invoke BCI=$INVOKE_BCI"
[ "$EXC_START" = 0 ] && [ "$EXC_END" = 6 ] && [ "$HANDLER_BCI" = 7 ] || reject "exception table"
rg -q '^ *0: iload_0$' "$CALLER" || reject "caller iload"
rg -q '^ *1: invokestatic .*throwLeaf' "$CALLER" || reject "caller invoke"
rg -q '^ *4: iconst_1$' "$CALLER" || reject "caller add"
rg -q '^ *5: iadd$' "$CALLER" || reject "caller iadd"
rg -q '^ *7: astore_1$' "$CALLER" || reject "caller handler"
rg -q '^ *0: iload_0$' "$LEAF" || reject "leaf iload"
rg -q '^ *1: ifne *12$' "$LEAF" || reject "leaf branch"
rg -q '^ *4: new .*IllegalStateException' "$LEAF" || reject "leaf new"
rg -q '^ *7: dup$' "$LEAF" || reject "leaf dup"
rg -q '^ *8: invokespecial .*IllegalStateException.*<init>' "$LEAF" || reject "leaf init"
rg -q '^ *11: athrow$' "$LEAF" || reject "leaf throw"
rg -q '^ *12: iload_0$' "$LEAF" || reject "leaf return"
rg -q '^ *13: ireturn$' "$LEAF" || reject "leaf ireturn"
JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture.class" | awk '{print $1}')
DEPS=''
for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
  class_name=${class_file#"$WORK/classes/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  DEPS="${DEPS:+$DEPS,}${class_name}=sha256:${class_hash}"
done
"$RUN_JAVA" -Xmx256m -Xms16m -XX:+UseSerialGC -cp "$WORK/classes" ZeroBaselineFixture throw >"$WORK/off.log" 2>&1
"$RUN_JAVA" -Xmx256m -Xms16m -XX:+UseSerialGC -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmLinkedGroup "-XX:ZeroWasmBaselineJarHash=$JAR_SHA" "-XX:ZeroWasmBaselineClassHash=$CLASS_SHA" "-XX:ZeroWasmBaselineDependencyHashes=$DEPS" -XX:+ZeroWasmLinkedGroupVerbose -cp "$WORK/classes" ZeroBaselineFixture throw >"$WORK/on.log" 2>&1
expected='throw normal 6 caught 77'
[ "$(rg '^throw ' "$WORK/off.log")" = "$expected" ] || reject "off transcript"
[ "$(rg '^throw ' "$WORK/on.log")" = "$expected" ] || reject "linked transcript"
warm_line=$(awk '/^\[zbg\] INTERPRETER_THROW_LEAF count=1$/ && !found {print NR; found=1}' "$WORK/on.log")
linked_line=$(awk '/^\[zbg\] ENTRY method=throwCaller kind=11 / && !found {print NR; found=1}' "$WORK/on.log")
[ -n "$warm_line" ] && [ -n "$linked_line" ] && [ "$warm_line" -lt "$linked_line" ] || reject "warm leaf order"
[ "$(rg -c 'DIRECT_CALL throwCaller->throwLeaf runtime=1 result=6' "$WORK/on.log" || true)" -eq 1 ] || reject "direct edge"
[ "$(rg -c 'INVOKE_REEXECUTE throwCaller resume-bci=1 handler-bci=7 depth=1 pending=0' "$WORK/on.log" || true)" -eq 1 ] || reject "invoke resume"
[ "$(rg -c 'INTERPRETER_THROW_LEAF count=2' "$WORK/on.log" || true)" -eq 1 ] || reject "leaf count"
[ "$(rg -c 'INTERPRETER_HANDLER throwCaller throw-bci=1' "$WORK/on.log" || true)" -eq 1 ] || reject "handler"
! rg -q 'CALL MISMATCH|PUSH_REJECT|RESUME_REJECT|pending=1|install failed|fallback|FALLBACK|wasm trap|sentinel|FATAL' "$WORK/on.log" || reject "failure marker"
[ -s "$WASM_DUMP" ] || reject "module dump"
"$WASM_DIS" "$WASM_DUMP" -o "$WORK/linked.wat" || reject "wasm-dis"
[ "$(rg -c '^[[:space:]]*\(export ' "$WORK/linked.wat" || true)" -eq 10 ] || reject "export count"
for export_name in leaf caller virtualValue safeDiv storeChild storeChildCaller goodValue dispatch throwLeaf throwCaller; do
  rg -q "^[[:space:]]*\(export \"$export_name\" " "$WORK/linked.wat" || reject "missing export $export_name"
done
rg -q '\(call \$8' "$WORK/linked.wat" || reject "direct throw edge"
! rg -q 'call_indirect|unreachable' "$WORK/linked.wat" || reject "indirect/trap path"
printf 'derived-invoke-bci=%s exception-range=%s..%s handler-bci=%s catch=java/lang/IllegalStateException\n' "$INVOKE_BCI" "$EXC_START" "$EXC_END" "$HANDLER_BCI"
printf 'warm-interpreter-leaf=1 direct-result=6 invoke-resume=1 interpreter-leaf=2 handler=1\n'
printf 'module-export-count=10 direct-edge=throwCaller->throwLeaf call-index=8\n'
printf 'ACCEPT M1-E2 direct-callee throw/invoke-resume slice\n'
printf 'E3 REJECT: compiled handlers/continuations/performance/cache/resource gates remain open\n'
printf 'source-patch-reverse-check=pass setup-order=pass shell-syntax=pass\n'
