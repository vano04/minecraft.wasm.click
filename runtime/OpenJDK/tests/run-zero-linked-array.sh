#!/bin/sh
# OSS-only M2-A real int[] load gate.  The linked function is an opt-in,
# call-free linear-memory read; null/OOB/memory guards resume the real Zero
# interpreter at iaload.  This is not a general Java array compiler.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JAVAC=${JAVAC:-/opt/homebrew/opt/openjdk@25/bin/javac}
JAR=${JAR:-/opt/homebrew/opt/openjdk@25/bin/jar}
JAVAP=${JAVAP:-/opt/homebrew/opt/openjdk@25/bin/javap}
WASM_DIS=${WASM_DIS:-/opt/homebrew/bin/wasm-dis}
NODE=${NODE:-node}
LOG_CHECKER="$ROOT/tests/check-zero-linked-array-log.mjs"
RELOC_CHECKER="$ROOT/tests/check-zero-linked-array-relocation.mjs"
COMPANION_MANIFEST="$ROOT/tests/zero-linked-array-manifest.sha256"
RUN_JAVA="$ROOT/run-java.sh"
JDK="$ROOT/work/jdk25"
WASM_DUMP=/private/tmp/mcweb-zero-linked-group.wasm
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-array.XXXXXX)
LOCK_HELPER="$ROOT/tests/zero-runtime-gate-lock.sh"
PATCH14="$ROOT/patches/0014-zero-wasm-linked-int-array-load.patch"
PATCH15="$ROOT/patches/0015-zero-wasm-linked-int-array-store.patch"
PATCH16="$ROOT/patches/0016-zero-wasm-linked-ref-array-load.patch"
PATCH17="$ROOT/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch"
PATCH18="$ROOT/patches/0018-zero-wasm-linked-ref-array-store.patch"
PATCH13="$ROOT/patches/0013-zero-wasm-linked-benchmark.patch"
EXPECTED_PATCH14_SHA=8320faa76eb1288c066bbd8ae86a14333cb4737c030e683d7ec4ccabb644aa11
EXPECTED_PATCH15_SHA=9d76abe0cd8818b37089ff96386203cb9f2de3d0f6591768119c1e8213ffe2d2
EXPECTED_PATCH16_SHA=0d7c204725b28cb1824f49cc2988f86ba07fea98098dbad126c98861ddb7c7ee
EXPECTED_PATCH17_SHA=ddb93941e71c293b6b20ca2810806301aaddf046f1f0cd24d2bb21366cac96a8
EXPECTED_PATCH18_SHA=53cf9d1332f70d3f83e101ec73b5f6d3ebde7e9bb059fd8456754a3e0bcc0024
EXPECTED_LOAD_SHA=afee9f6dd2ea0feeb96d8615918703ef2797b6b26e57e2a8269bd667c47750a3
EXPECTED_LOAD_SIZE=680
EXPECTED_BENCH_SHA=de66a54524031d40c5fa5abf2d4874fa8f9aace99a6b2d440b2d663fdc7dab41
EXPECTED_BENCH_SIZE=1392
EXPECTED_RELOC_CHECKER_SHA=42f1e1c137f2f06dd11de9f9e6afae51bafc858973b228ada8e88761f6c18436
EXPECTED_HEAD=6c48f4ed707bf0b15f9b6098de30db8aae6fa40f
EXPECTED_GLOBALS_SHA=5858ac45c26e463689b779d1b3b0b3b2d6a9d454f45b550b1290f280e9f9a449
EXPECTED_INTERPRETER_SHA=ce3ab6676d3133d2f98d765de3cd849a8e54caf5cbe7cf3d375c9f9622e91c10
EXPECTED_BASELINE_SHA=a340329a2ce46d5313437302df8fa26512207086166f2552c90880d3d38710d3
EXPECTED_0017_GLOBALS_SHA=5858ac45c26e463689b779d1b3b0b3b2d6a9d454f45b550b1290f280e9f9a449
EXPECTED_0017_INTERPRETER_SHA=ce3ab6676d3133d2f98d765de3cd849a8e54caf5cbe7cf3d375c9f9622e91c10
EXPECTED_0017_BASELINE_SHA=c356dfa1a70f0f90e9e716870c8d8b809568130cd8e5a21709eec99aa978e47c
EXPECTED_0018_GLOBALS_SHA=6c8ac8a604881191755b876c9cfad596948dcf22642a6af1ea5d7c72e6fdbc27
EXPECTED_0018_INTERPRETER_SHA=e54f7456695ea2fab786a439da94d27ba94e41574f9fea15fb84def6a3ab04a1
EXPECTED_0018_BASELINE_SHA=892cb9d63b3909d8acb933cd8849c9b9caeef17353ad0d655d3822737abb4733
LEGACY_CONTEXT=${MCWEB_ZERO_LEGACY_PROVENANCE_CONTEXT:-final-0018}
case "$LEGACY_CONTEXT" in
  final-0018)
    EXPECTED_OVERLAY_GLOBALS_SHA=$EXPECTED_0018_GLOBALS_SHA
    EXPECTED_OVERLAY_INTERPRETER_SHA=$EXPECTED_0018_INTERPRETER_SHA
    EXPECTED_OVERLAY_BASELINE_SHA=$EXPECTED_0018_BASELINE_SHA
    ;;
  final-0019)
    EXPECTED_OVERLAY_GLOBALS_SHA=bd76b9d3df38fc45892a45b9ebb5d54b1d5fb8fec5917a47929ef8e634082265
    EXPECTED_OVERLAY_INTERPRETER_SHA=08e457e0a1551d8f3c3c16b0b4aa1f2608f630babe3ccd54f3e1fba316fc3676
    EXPECTED_OVERLAY_BASELINE_SHA=d2276be03aa03375fa59e9ccae10fee21b65f63d30c509f9fdfcbac349573420
    ;;
  *) echo "REJECT M2-A linked int[] gate: unknown legacy context: $LEGACY_CONTEXT" >&2; exit 1 ;;
esac
EXPECTED_0015_GLOBALS_SHA=194c8187621a306f76a7db4fab54c54b5a164449e413d575120385aa11b0e692
EXPECTED_0015_INTERPRETER_SHA=cea189b172c8ed050912f4ea92e4caf08268445f45a6daf2c1ce905fb5496fb5
EXPECTED_0015_BASELINE_SHA=0207ad4a93fca8352fa24f64f520484306be969605239b7eca2ffa97cc0ffa37
EXPECTED_0014_GLOBALS_SHA=735562249a2c08ea8fb6d93385808b6a120c3a1e3625c75eb45c37d0ab9cbb5b
EXPECTED_0014_INTERPRETER_SHA=1ad779cc376ad368bd324546c53829c3717cb25e1b2fd6ecafc36885d66160fa
EXPECTED_0014_BASELINE_SHA=9dfbf68c352cf563842f979b18e6e4b55fc7a10218dd4ac51a8ee888467352db
cleanup_array_gate() {
  status=$?
  trap - EXIT INT TERM
  runtime_gate_lock_release || :
  rm -rf -- "$WORK"
  exit "$status"
}
trap cleanup_array_gate EXIT INT TERM

reject() {
  echo "REJECT M2-A linked int[] gate: $*" >&2
  if [ -d "${WORK:-}" ]; then
    cp "$WORK/on.log" /private/tmp/mcweb-zero-linked-array-failure.log 2>/dev/null || true
    cp "$WORK/off.log" /private/tmp/mcweb-zero-linked-array-off-failure.log 2>/dev/null || true
    cp "$WORK/forced.log" /private/tmp/mcweb-zero-linked-array-forced-failure.log 2>/dev/null || true
    cp "$WORK/negative.log" /private/tmp/mcweb-zero-linked-array-negative-failure.log 2>/dev/null || true
    cp "$WORK/combined.log" /private/tmp/mcweb-zero-linked-array-combined-failure.log 2>/dev/null || true
  fi
  exit 1
}

check_late_cmd_cleanup() {
  log_path=$1
  final_marker=$2
  count=$(awk -v marker="$final_marker" '
    BEGIN { marker_count=0; cleanup_count=0; bad=0; after=0 }
    $0 ~ marker { marker_count++; after=1; next }
    tolower($0) ~ /terminated worker/ {
      if (!after || $0 !~ /^received "6" command from terminated worker: [1-9][0-9]*$/) {
        bad=1
      } else {
        cleanup_count++
      }
    }
    END {
      if (marker_count != 1 || bad || cleanup_count > 1) exit 1
      print cleanup_count
    }
  ' "$log_path") || return 1
  printf 'pthread-teardown-race-count=%s classification=late-CMD_CLEANUP_THREAD\n' "$count"
}

pthread_teardown_parser_self_test() {
  printf 'received "6" command from terminated worker: 32\nBENCH_WINDOW_END\n' >"$WORK/pthread-early.log"
  if check_late_cmd_cleanup "$WORK/pthread-early.log" '^BENCH_WINDOW_END$' >/dev/null 2>&1; then return 1; fi
  printf 'BENCH_WINDOW_END\nreceived "5" command from terminated worker: 32\n' >"$WORK/pthread-command.log"
  if check_late_cmd_cleanup "$WORK/pthread-command.log" '^BENCH_WINDOW_END$' >/dev/null 2>&1; then return 1; fi
  printf 'BENCH_WINDOW_END\nreceived "6" command from terminated worker: 32\nreceived "6" command from terminated worker: 31\n' >"$WORK/pthread-duplicate.log"
  if check_late_cmd_cleanup "$WORK/pthread-duplicate.log" '^BENCH_WINDOW_END$' >/dev/null 2>&1; then return 1; fi
  printf 'BENCH_WINDOW_END\nreceived "6" command from terminated worker: 0\n' >"$WORK/pthread-malformed.log"
  if check_late_cmd_cleanup "$WORK/pthread-malformed.log" '^BENCH_WINDOW_END$' >/dev/null 2>&1; then return 1; fi
}

pthread_teardown_parser_self_test || reject "pthread teardown parser negative was accepted"

[ -x "$JAVAC" ] || reject "javac unavailable: $JAVAC"
[ -x "$JAR" ] || reject "jar unavailable: $JAR"
[ -x "$JAVAP" ] || reject "javap unavailable: $JAVAP"
[ -x "$WASM_DIS" ] || reject "wasm-dis unavailable: $WASM_DIS"
[ -x "$(command -v "$NODE" 2>/dev/null || true)" ] || reject "node unavailable: $NODE"
[ -f "$LOG_CHECKER" ] || reject "array log checker unavailable"
[ -f "$RELOC_CHECKER" ] || reject "array relocation checker unavailable"
[ -f "$COMPANION_MANIFEST" ] || reject "array companion manifest unavailable"
[ -x "$RUN_JAVA" ] || reject "run-java.sh unavailable"
[ -d "$JDK/.git" ] || reject "missing prepared OpenJDK checkout"
[ -f "$PATCH13" ] || reject "missing 0013 patch"
[ -f "$PATCH14" ] || reject "missing 0014 patch"
[ -f "$PATCH15" ] || reject "missing 0015 patch"
[ -f "$PATCH16" ] || reject "missing 0016 patch"
[ -f "$PATCH17" ] || reject "missing 0017 patch"
[ -f "$PATCH18" ] || reject "missing 0018 patch"
[ -r "$LOCK_HELPER" ] || reject "runtime gate lock helper unavailable"
. "$LOCK_HELPER"
if [ "${MCWEB_RUNTIME_GATE_LOCK_PROBE:-0}" = 1 ]; then
  runtime_gate_lock_acquire || exit 1
  exit 0
fi
runtime_gate_lock_acquire || reject "another Zero runtime gate owns the lock"
runtime_gate_lock_self_test "$0" "$WASM_DUMP" /private/tmp/mcweb-zero-linked-benchmark.wasm \
  || reject "second invocation lock self-test failed"
printf '%s\n' 'runtime-gate-lock=self-test-pass'
sh -n "$0" || reject "gate shell syntax"
PROVENANCE18="$ROOT/tests/check-zero-0018-legacy-provenance.sh"
[ -x "$PROVENANCE18" ] || reject "0018 provenance checker unavailable"
"$PROVENANCE18" "$ROOT" "$JDK" "$WORK/provenance-0018" \
  || reject "0018 clean/final provenance failed"

# Full-stack prepared-source provenance is separate from the OSS fixture.
git_safe() { git -c core.fsmonitor=false -c gc.auto=0 -c maintenance.auto=false "$@"; }
[ "$(shasum -a 256 "$PATCH14" | awk '{print $1}')" = "$EXPECTED_PATCH14_SHA" ] || reject "0014 patch hash drift"
[ "$(shasum -a 256 "$PATCH15" | awk '{print $1}')" = "$EXPECTED_PATCH15_SHA" ] || reject "0015 patch hash drift"
[ "$(shasum -a 256 "$PATCH16" | awk '{print $1}')" = "$EXPECTED_PATCH16_SHA" ] || reject "0016 patch hash drift"
[ "$(shasum -a 256 "$PATCH17" | awk '{print $1}')" = "$EXPECTED_PATCH17_SHA" ] || reject "0017 patch hash drift"
[ "$(shasum -a 256 "$PATCH18" | awk '{print $1}')" = "$EXPECTED_PATCH18_SHA" ] || reject "0018 patch hash drift"
[ "$(shasum -a 256 "$RELOC_CHECKER" | awk '{print $1}')" = "$EXPECTED_RELOC_CHECKER_SHA" ] \
  || reject "array relocation checker drift"
[ "$(git_safe -C "$JDK" rev-parse HEAD)" = "$EXPECTED_HEAD" ] || reject "prepared JDK HEAD drift"
for path_name in \
  src/hotspot/cpu/zero/globals_zero.hpp \
  src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp \
  src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp; do
  rg -q "^diff --git a/$path_name b/$path_name$" "$PATCH14" || reject "0014 path allowlist drift: $path_name"
done
[ "$(rg -c '^diff --git ' "$PATCH14")" -eq 3 ] || reject "0014 has unexpected path count"
check_0014_payload() {
  patch_path=$1
  [ "$(rg -c '^diff --git ' "$patch_path")" -eq 3 ] || return 1
  for path_name in \
    src/hotspot/cpu/zero/globals_zero.hpp \
    src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp \
    src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp; do
    rg -q "^diff --git a/$path_name b/$path_name$" "$patch_path" || return 1
  done
  ! rg -q '^(GIT binary patch|Binary files )' "$patch_path"
}
check_0014_payload "$PATCH14" || reject "0014 binary/path payload drift"
check_0015_payload() {
  patch_path=$1
  [ "$(rg -c '^diff --git ' "$patch_path")" -eq 3 ] || return 1
  for path_name in \
    src/hotspot/cpu/zero/globals_zero.hpp \
    src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp \
    src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp; do
    rg -q "^diff --git a/$path_name b/$path_name$" "$patch_path" || return 1
  done
  ! rg -q '^(GIT binary patch|Binary files |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )' "$patch_path"
}
check_0015_payload "$PATCH15" || reject "0015 path/mode/binary payload drift"
check_0016_payload() { check_0015_payload "$1"; }
check_0016_payload "$PATCH16" || reject "0016 path/mode/binary payload drift"
EXTRA_0014="$WORK/0014-extra-path.patch"
cp "$PATCH14" "$EXTRA_0014"
printf '%s\n' 'diff --git a/tests/unowned.bin b/tests/unowned.bin' >>"$EXTRA_0014"
if check_0014_payload "$EXTRA_0014"; then reject "0014 extra-path negative accepted"; fi
BINARY_0014="$WORK/0014-binary-payload.patch"
cp "$PATCH14" "$BINARY_0014"
printf '%s\n' 'GIT binary patch' >>"$BINARY_0014"
if check_0014_payload "$BINARY_0014"; then reject "0014 binary-payload negative accepted"; fi
EXTRA_0015="$WORK/0015-extra-path.patch"
cp "$PATCH15" "$EXTRA_0015"
printf '%s\n' 'diff --git a/tests/unowned.bin b/tests/unowned.bin' >>"$EXTRA_0015"
if check_0015_payload "$EXTRA_0015"; then reject "0015 extra-path negative accepted"; fi
BINARY_0015="$WORK/0015-binary-payload.patch"
cp "$PATCH15" "$BINARY_0015"
printf '%s\n' 'GIT binary patch' >>"$BINARY_0015"
if check_0015_payload "$BINARY_0015"; then reject "0015 binary-payload negative accepted"; fi
MODE_0015="$WORK/0015-mode-payload.patch"
cp "$PATCH15" "$MODE_0015"
printf '%s\n' 'new mode 100755' >>"$MODE_0015"
if check_0015_payload "$MODE_0015"; then reject "0015 mode-change negative accepted"; fi
awk '
  /git apply.*0014-zero-wasm-linked-int-array-load\.patch/ { fourteen = NR }
  /git apply.*0015-zero-wasm-linked-int-array-store\.patch/ { fifteen = NR }
  /git apply.*0016-zero-wasm-linked-ref-array-load\.patch/ { sixteen = NR }
  /git apply.*0017-zero-wasm-linked-ref-array-load-cache-integrity\.patch/ { seventeen = NR }
  /git apply.*0018-zero-wasm-linked-ref-array-store\.patch/ { eighteen = NR }
  END { exit !(fourteen && fifteen && sixteen && seventeen && eighteen && fifteen == fourteen + 1 && sixteen == fifteen + 1 && seventeen == sixteen + 1 && eighteen == seventeen + 1) }
' "$ROOT/setup.sh" || reject "setup 0014/0015/0016/0017/0018 patch order is not atomic"
[ "$(shasum -a 256 "$JDK/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_OVERLAY_GLOBALS_SHA" ] || reject "overlay globals source drift"
[ "$(shasum -a 256 "$JDK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_OVERLAY_INTERPRETER_SHA" ] || reject "overlay interpreter source drift"
[ "$(shasum -a 256 "$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_OVERLAY_BASELINE_SHA" ] || reject "overlay baseline source drift"
PROVENANCE="$WORK/provenance"
PRE12="$WORK/pre-0012"
mkdir -p "$PROVENANCE" "$PRE12"
git_safe -C "$JDK" archive HEAD | tar -x -C "$PROVENANCE"
git_safe -C "$JDK" archive HEAD | tar -x -C "$PRE12"
git_safe -C "$PROVENANCE" init -q
git_safe -C "$PRE12" init -q
git_safe -C "$PROVENANCE" add -A
git_safe -C "$PRE12" add -A
git_safe -C "$PROVENANCE" -c user.name=mcweb -c user.email=mcweb@example.invalid commit -qm base
git_safe -C "$PRE12" -c user.name=mcweb -c user.email=mcweb@example.invalid commit -qm base
for patch_name in 0001 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018; do
  set -- "$ROOT"/patches/"$patch_name"-*.patch
  [ "$#" -eq 1 ] || reject "missing or duplicate patch $patch_name"
  git_safe -C "$PROVENANCE" apply --check "$1" || reject "forward patch failed: $patch_name"
  git_safe -C "$PROVENANCE" apply "$1"
  case "$patch_name" in
    0013|0014|0015|0016|0017|0018) ;;
    *) git_safe -C "$PRE12" apply --check "$1" || reject "pre-0013 stack failed: $patch_name"
       git_safe -C "$PRE12" apply "$1" ;;
  esac
done
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0018_GLOBALS_SHA" ] || reject "reconstructed 0018 globals drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0018_INTERPRETER_SHA" ] || reject "reconstructed 0018 interpreter drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0018_BASELINE_SHA" ] || reject "reconstructed 0018 baseline drift"
set -- "$ROOT"/patches/0018-*.patch
git_safe -C "$PROVENANCE" apply --reverse --check "$1" || reject "0018 reverse check failed"
git_safe -C "$PROVENANCE" apply --reverse "$1"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0017_GLOBALS_SHA" ] || reject "0018 globals preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0017_INTERPRETER_SHA" ] || reject "0018 interpreter preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0017_BASELINE_SHA" ] || reject "0018 baseline preimage drift"
set -- "$ROOT"/patches/0017-*.patch
git_safe -C "$PROVENANCE" apply --reverse --check "$1" || reject "0017 reverse check failed"
git_safe -C "$PROVENANCE" apply --reverse "$1"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_GLOBALS_SHA" ] || reject "0017 globals preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_INTERPRETER_SHA" ] || reject "0017 interpreter preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_BASELINE_SHA" ] || reject "0017 baseline preimage drift"
set -- "$ROOT"/patches/0016-*.patch
git_safe -C "$PROVENANCE" apply --reverse --check "$1" || reject "0016 reverse check failed"
git_safe -C "$PROVENANCE" apply --reverse "$1"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0015_GLOBALS_SHA" ] || reject "0016 globals preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0015_INTERPRETER_SHA" ] || reject "0016 interpreter preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0015_BASELINE_SHA" ] || reject "0016 baseline preimage drift"
set -- "$ROOT"/patches/0015-*.patch
git_safe -C "$PROVENANCE" apply --reverse --check "$1" || reject "0015 reverse check failed"
git_safe -C "$PROVENANCE" apply --reverse "$1"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0014_GLOBALS_SHA" ] || reject "0015 globals preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0014_INTERPRETER_SHA" ] || reject "0015 interpreter preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0014_BASELINE_SHA" ] || reject "0015 baseline preimage drift"
set -- "$ROOT"/patches/0014-*.patch
git_safe -C "$PROVENANCE" apply --reverse --check "$1" || reject "0014 reverse check failed"
git_safe -C "$PROVENANCE" apply --reverse "$1"
set -- "$ROOT"/patches/0013-*.patch
git_safe -C "$PROVENANCE" apply --reverse --check "$1" || reject "0013 reverse check failed"
git_safe -C "$PROVENANCE" apply --reverse "$1"
for path_name in \
  src/hotspot/cpu/zero/globals_zero.hpp \
  src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp \
  src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp; do
  cmp -s "$PROVENANCE/$path_name" "$PRE12/$path_name" || reject "0013 preimage differs: $path_name"
done
for patch_name in 0012 0011 0010 0009 0008 0007 0006 0005 0004 0003 0001; do
  set -- "$ROOT"/patches/"$patch_name"-*.patch
  git_safe -C "$PROVENANCE" apply --reverse --check "$1" || reject "reverse stack failed: $patch_name"
  git_safe -C "$PROVENANCE" apply --reverse "$1"
done
git_safe -C "$PROVENANCE" diff --quiet HEAD || reject "reverse stack did not return to base"

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
[ "$(find "$WORK/classes" -type f -name '*.class' | wc -l | awk '{print $1}')" -eq 10 ] \
  || reject "fixture closure is not exactly ten classes"
JAR_A="$WORK/fixture-a.jar"
JAR_B="$WORK/fixture-b.jar"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$JAR_A" -C "$WORK/classes" .
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$JAR_B" -C "$WORK/classes" .
cmp -s "$JAR_A" "$JAR_B" || reject "fixed-date fixture JAR is not deterministic"
cp "$JAR_A" "$WORK/fixture.jar"
JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
JAR_BYTES=$(stat -f '%z' "$WORK/fixture.jar")
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture.class" | awk '{print $1}')
SOURCE_SHA=$(shasum -a 256 "$ROOT/tests/ZeroBaselineFixture.java" | awk '{print $1}')
GLOBALS_SHA=$(shasum -a 256 "$JDK/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')
INTERPRETER_SHA=$(shasum -a 256 "$JDK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')
BASELINE_SHA=$(shasum -a 256 "$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')
BUILT_JAVA="$JDK/build/wasm-zero/jdk/bin/java"
BUILT_LIBJVM="$JDK/build/wasm-zero/jdk/lib/zero/libjvm.so"
[ -r "$BUILT_JAVA" ] || reject "built launcher unavailable"
[ -r "$BUILT_LIBJVM" ] || reject "built libjvm unavailable"
BUILT_JAVA_SHA=$(shasum -a 256 "$BUILT_JAVA" | awk '{print $1}')
BUILT_LIBJVM_SHA=$(shasum -a 256 "$BUILT_LIBJVM" | awk '{print $1}')
LAUNCHER_SHA=$(shasum -a 256 "$RUN_JAVA" | awk '{print $1}')
CHECKER_SHA=$(shasum -a 256 "$ROOT/tests/check-zero-linked-array-wat.mjs" | awk '{print $1}')
LOG_CHECKER_SHA=$(shasum -a 256 "$LOG_CHECKER" | awk '{print $1}')
SCRIPT_SHA=$(shasum -a 256 "$ROOT/tests/run-zero-linked-array.sh" | awk '{print $1}')
MANIFEST_ACTUAL="$WORK/companion-manifest.actual"
resolved_tool() { realpath "$(command -v "$1")"; }
NODE_RESOLVED=$(resolved_tool "$NODE")
JAVAC_RESOLVED=$(realpath "$JAVAC")
JAR_RESOLVED=$(realpath "$JAR")
JAVAP_RESOLVED=$(realpath "$JAVAP")
WASM_DIS_RESOLVED=$(realpath "$WASM_DIS")
{
  printf '%s\n' 'whole-unit-array-companion-manifest-v2'
  printf 'asset tests/check-zero-linked-array-log.mjs %s\n' "$LOG_CHECKER_SHA"
  printf 'asset tests/check-zero-linked-array-wat.mjs %s\n' "$CHECKER_SHA"
  printf 'class ZeroBaselineFixture$Base.class %s\n' "$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture\$Base.class" | awk '{print $1}')"
  printf 'class ZeroBaselineFixture$Box.class %s\n' "$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture\$Box.class" | awk '{print $1}')"
  printf 'class ZeroBaselineFixture$Good.class %s\n' "$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture\$Good.class" | awk '{print $1}')"
  printf 'class ZeroBaselineFixture$InitFail.class %s\n' "$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture\$InitFail.class" | awk '{print $1}')"
  printf 'class ZeroBaselineFixture$InitOK.class %s\n' "$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture\$InitOK.class" | awk '{print $1}')"
  printf 'class ZeroBaselineFixture$Other.class %s\n' "$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture\$Other.class" | awk '{print $1}')"
  printf 'class ZeroBaselineFixture$Shape.class %s\n' "$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture\$Shape.class" | awk '{print $1}')"
  printf 'class ZeroBaselineFixture$SubGood.class %s\n' "$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture\$SubGood.class" | awk '{print $1}')"
  printf 'class ZeroBaselineFixture$Trace.class %s\n' "$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture\$Trace.class" | awk '{print $1}')"
  printf 'class ZeroBaselineFixture.class %s\n' "$CLASS_SHA"
  printf 'fixture-jar fixture.jar %s %s\n' "$JAR_SHA" "$JAR_BYTES"
  printf 'source tests/ZeroBaselineFixture.java %s\n' "$SOURCE_SHA"
  printf 'tool javac %s %s\n' "$JAVAC_RESOLVED" "$(shasum -a 256 "$JAVAC_RESOLVED" | awk '{print $1}')"
  printf 'tool jar %s %s\n' "$JAR_RESOLVED" "$(shasum -a 256 "$JAR_RESOLVED" | awk '{print $1}')"
  printf 'tool javap %s %s\n' "$JAVAP_RESOLVED" "$(shasum -a 256 "$JAVAP_RESOLVED" | awk '{print $1}')"
  printf 'tool node %s %s\n' "$NODE_RESOLVED" "$(shasum -a 256 "$NODE_RESOLVED" | awk '{print $1}')"
  printf 'tool wasm-dis %s %s\n' "$WASM_DIS_RESOLVED" "$(shasum -a 256 "$WASM_DIS_RESOLVED" | awk '{print $1}')"
  printf 'tool launcher run-java.sh %s\n' "$LAUNCHER_SHA"
} >"$MANIFEST_ACTUAL"
cmp -s "$MANIFEST_ACTUAL" "$COMPANION_MANIFEST" || reject "array companion manifest drift"
MANIFEST_NEGATIVE="$WORK/companion-manifest-negative"
cp "$COMPANION_MANIFEST" "$MANIFEST_NEGATIVE"
printf '%s\n' 'unowned negative-entry sha256' >>"$MANIFEST_NEGATIVE"
if cmp -s "$MANIFEST_ACTUAL" "$MANIFEST_NEGATIVE"; then
  reject "array companion manifest negative accepted"
fi
DEPS=''
for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
  class_name=${class_file#"$WORK/classes/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  DEPS="${DEPS:+$DEPS,}${class_name}=sha256:${class_hash}"
done

"$JAVAP" -classpath "$WORK/classes" -c -p ZeroBaselineFixture >"$WORK/javap.txt"
IALOAD_BCI=$(awk '/public static int intArrayLoad\(/ { in_array=1; next }
  in_array && /^  public static int / { exit }
  in_array && /iaload/ { sub(":", "", $1); print $1; exit }' "$WORK/javap.txt")
RETURN_BCI=$(awk '/public static int intArrayLoad\(/ { in_array=1; next }
  in_array && /^  public static int / { exit }
  in_array && /ireturn/ { sub(":", "", $1); print $1; exit }' "$WORK/javap.txt")
[ "$IALOAD_BCI" = 2 ] && [ "$RETURN_BCI" = 3 ] \
  || reject "unexpected derived intArrayLoad BCIs iaload=$IALOAD_BCI return=$RETURN_BCI"

ARGS="-XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmLinkedIntArray -XX:+UseSerialGC -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS -XX:+ZeroWasmLinkedGroupVerbose"
FORCED_ARGS="$ARGS -XX:ZeroWasmLinkedArrayMemoryLimitForTest=1"
COMBINED_ARGS="$ARGS -XX:+UseZeroWasmLinkedBenchmark"
RUN_EPOCH_BEFORE=$(date +%s)
rm -f "$WASM_DUMP"
"$RUN_JAVA" -Xmx256m -Xms16m -XX:+UseSerialGC -cp "$WORK/classes" \
  ZeroBaselineFixture array >"$WORK/off.log" 2>&1
# shellcheck disable=SC2086
rm -f "$WASM_DUMP"
"$RUN_JAVA" -Xmx256m -Xms16m $ARGS -cp "$WORK/classes" \
  -Xlog:safepoint=debug \
  ZeroBaselineFixture array >"$WORK/on.log" 2>&1
# shellcheck disable=SC2086
rm -f "$WASM_DUMP"
"$RUN_JAVA" -Xmx256m -Xms16m $FORCED_ARGS -cp "$WORK/classes" \
  -Xlog:safepoint=debug \
  ZeroBaselineFixture array >"$WORK/forced.log" 2>&1
# The same-name descriptor, wrong-owner instance, baload, and aaload shapes
# are deliberately interpreter-only and must not consume the array slot.
# shellcheck disable=SC2086
"$RUN_JAVA" -Xmx256m -Xms16m $ARGS -cp "$WORK/classes" \
  ZeroBaselineFixture array-negatives >"$WORK/negative.log" 2>&1
# Both opt-in flags must coexist in one JVM. The array group is installed and
# exercised first; a benchmark method then installs the separate 10-slot
# benchmark module and executes through its own namespace.
rm -f "$WASM_DUMP" /private/tmp/mcweb-zero-linked-benchmark.wasm
# shellcheck disable=SC2086
"$RUN_JAVA" -Xmx256m -Xms16m $COMBINED_ARGS -cp "$WORK/classes" \
  ZeroBaselineFixture array-benchmark >"$WORK/combined.log" 2>&1

expected='array valid-first -2147483648 mutated -2147483648 valid-last 99 null-npe 1 negative-aioobe 1 length-aioobe 1 min-index-aioobe 1 empty-aioobe 1'
[ "$(rg '^array ' "$WORK/off.log")" = "$expected" ] || reject "off transcript mismatch"
[ "$(rg '^array ' "$WORK/on.log")" = "$expected" ] || reject "linked transcript mismatch"
[ "$(rg '^array ' "$WORK/forced.log")" = "$expected" ] || reject "forced-memory transcript mismatch"
check_late_cmd_cleanup "$WORK/off.log" '^array-exceptions ' \
  || reject "off pthread teardown diagnostic ordering/count"
check_late_cmd_cleanup "$WORK/on.log" '^array-exceptions ' \
  || reject "linked pthread teardown diagnostic ordering/count"
check_late_cmd_cleanup "$WORK/forced.log" '^array-exceptions ' \
  || reject "forced pthread teardown diagnostic ordering/count"
exceptions=$(rg '^array-exceptions ' "$WORK/off.log" || true)
[ -n "$exceptions" ] || reject "missing exception transcript"
[ "$(rg '^array-exceptions ' "$WORK/on.log")" = "$exceptions" ] \
  || reject "linked exception transcript mismatch"
[ "$(rg '^array-exceptions ' "$WORK/forced.log")" = "$exceptions" ] \
  || reject "forced-memory exception transcript mismatch"
for type in NullPointerException ArrayIndexOutOfBoundsException; do
  rg -q "^array-exceptions .*java\\.lang\\.$type\\|" "$WORK/off.log" \
    || reject "missing exact exception type $type"
done
[ "$(rg '^array-negatives ' "$WORK/negative.log")" = \
  "array-negatives descriptor 42 owner 42 baload 7 aaload 8 store-descriptor 9 store-owner 7 store-baload 7 store-aastore 8 store-altered 10" ] \
  || reject "near-miss transcript mismatch"
check_late_cmd_cleanup "$WORK/negative.log" '^array-negatives ' \
  || reject "negative pthread teardown diagnostic ordering/count"
if "$NODE" "$LOG_CHECKER" "$WORK/on.log" linked >/dev/null 2>&1; then :; else
  reject "linked case sequence/order failed"
fi
if "$NODE" "$LOG_CHECKER" "$WORK/forced.log" forced >/dev/null 2>&1; then :; else
  reject "forced case sequence/order failed"
fi
if "$NODE" "$LOG_CHECKER" "$WORK/negative.log" negative >/dev/null 2>&1; then :; else
  reject "near-miss case sequence/order failed"
fi
[ "$(rg -c '^\[zbg\] DIRECT_LOAD intArrayLoad runtime=1 seq=[0-9][0-9]* ' "$WORK/on.log" || true)" -eq 3 ] \
  || reject "expected three successful direct array loads"
[ "$(rg -c "^\[zbg\] ARRAY_OPCODE_REEXECUTE seq=[0-9][0-9]* reason=.* resume-bci=$IALOAD_BCI depth=2 pending=0$" "$WORK/on.log" || true)" -eq 5 ] \
  || reject "expected five exact iaload reexec spills"
[ "$(rg -c '^\[zbg\] INTERPRETER_IALOAD seq=[0-9][0-9]* bci=2$' "$WORK/on.log" || true)" -eq 5 ] \
  || reject "expected five interpreter iaload executions"
for marker in ARRAY_ENTER ARRAY_STATUS ARRAY_EXIT; do
  count=$(rg -c "^\\[zbg\\] $marker seq=[0-9][0-9]* " "$WORK/on.log" || true)
  [ "${count:-0}" -eq 8 ] || reject "linked lane marker count $marker=$count"
done
status_return=$(rg -c '^\[zbg\] ARRAY_STATUS seq=[0-9][0-9]* status=0 bci=0 ' "$WORK/on.log" || true)
status_resume=$(rg -c '^\[zbg\] ARRAY_STATUS seq=[0-9][0-9]* status=3 bci='"$IALOAD_BCI"' ' "$WORK/on.log" || true)
[ "${status_return:-0}" -eq 3 ] || reject "linked return status count=$status_return"
[ "${status_resume:-0}" -eq 5 ] || reject "linked reexecute status count=$status_resume"
on_null=$(rg -c '^\[zbg\] ARRAY_OPCODE_REEXECUTE seq=[0-9][0-9]* reason=null ' "$WORK/on.log" || true)
on_bounds=$(rg -c '^\[zbg\] ARRAY_OPCODE_REEXECUTE seq=[0-9][0-9]* reason=bounds ' "$WORK/on.log" || true)
[ "${on_null:-0}" -eq 1 ] || reject "linked null reason count=$on_null"
[ "${on_bounds:-0}" -eq 4 ] || reject "linked bounds reason count=$on_bounds"
forced_direct=$(rg -c '^\[zbg\] DIRECT_LOAD intArrayLoad runtime=1 seq=[0-9][0-9]* ' "$WORK/forced.log" || true)
[ "${forced_direct:-0}" -eq 0 ] \
  || reject "forced-memory lane unexpectedly direct-loaded"
[ "$(rg -c "^\\[zbg\\] ARRAY_OPCODE_REEXECUTE seq=[0-9][0-9]* reason=.* resume-bci=$IALOAD_BCI depth=2 pending=0$" "$WORK/forced.log" || true)" -eq 8 ] \
  || reject "forced-memory lane did not reexecute all eight loads"
[ "$(rg -c "^\\[zbg\\] INTERPRETER_IALOAD seq=[0-9][0-9]* bci=$IALOAD_BCI$" "$WORK/forced.log" || true)" -eq 8 ] \
  || reject "forced-memory lane did not interpret all eight loads"
[ "$(rg -c '^\[zbg\] ARRAY_ENTER seq=[0-9][0-9]* ' "$WORK/forced.log" || true)" -eq 8 ] \
  || reject "forced-memory entry count mismatch"
forced_status=$(rg -c '^\[zbg\] ARRAY_STATUS seq=[0-9][0-9]* ' "$WORK/forced.log" || true)
[ "${forced_status:-0}" -eq 8 ] || reject "forced-memory status count=$forced_status"
[ "$(rg -c '^\[zbg\] ARRAY_EXIT seq=[0-9][0-9]* ' "$WORK/forced.log" || true)" -eq 8 ] \
  || reject "forced-memory exit count mismatch"
[ "$(rg -c '^\[zbg\] ARRAY_OPCODE_REEXECUTE seq=[0-9][0-9]* reason=memory ' "$WORK/forced.log" || true)" -eq 3 ] \
  || reject "forced-memory lane missing three memory refusals"
forced_null=$(rg -c '^\[zbg\] ARRAY_OPCODE_REEXECUTE seq=[0-9][0-9]* reason=null ' "$WORK/forced.log" || true)
forced_bounds=$(rg -c '^\[zbg\] ARRAY_OPCODE_REEXECUTE seq=[0-9][0-9]* reason=bounds ' "$WORK/forced.log" || true)
[ "${forced_null:-0}" -eq 1 ] || reject "forced null reason count=$forced_null"
[ "${forced_bounds:-0}" -eq 4 ] || reject "forced bounds reason count=$forced_bounds"
rg -q '^\[zbg\] ARRAY_ENTER seq=[0-9][0-9]* method=intArrayLoad static=1 params=2 raw32=1 exact-klass=intArrayKlass length-offset=[0-9][0-9]* base-offset=[0-9][0-9]* limit-pages=0 slot=[0-9][0-9]*$' "$WORK/on.log" \
  || reject "linked layout/ABI marker incomplete"
rg -q '^\[zbg\] ARRAY_ENTER seq=[0-9][0-9]* method=intArrayLoad static=1 params=2 raw32=1 exact-klass=intArrayKlass length-offset=[0-9][0-9]* base-offset=[0-9][0-9]* limit-pages=1 slot=[0-9][0-9]*$' "$WORK/forced.log" \
  || reject "forced layout/ABI marker incomplete"
rg -q '^\[zbg\] ARRAY_MEMORY bytes=[1-9][0-9]*$' "$WORK/on.log" \
  || reject "active Wasm memory size marker missing"
rg -q '^\[zbg\] ARRAY_MEMORY bytes=[1-9][0-9]*$' "$WORK/forced.log" \
  || reject "forced active Wasm memory size marker missing"
on_slots=$(rg '^\[zbg\] ARRAY_ENTER ' "$WORK/on.log" | sed 's/.*slot=//' | LC_ALL=C sort -u | wc -l | awk '{print $1}')
[ "$on_slots" -eq 1 ] || reject "linked array slot identity changed"
forced_slots=$(rg '^\[zbg\] ARRAY_ENTER ' "$WORK/forced.log" | sed 's/.*slot=//' | LC_ALL=C sort -u | wc -l | awk '{print $1}')
[ "$forced_slots" -eq 1 ] || reject "forced array slot identity changed"
! rg -q 'CALL MISMATCH|PUSH_REJECT|RESUME_REJECT|pending=1|install failed|wasm trap|unreachable|FATAL' "$WORK/on.log" \
  || reject "runtime failure marker present"
! rg -q 'CALL MISMATCH|PUSH_REJECT|RESUME_REJECT|pending=1|install failed|wasm trap|unreachable|FATAL' "$WORK/forced.log" \
  || reject "forced-memory runtime failure marker present"
if awk '/ARRAY_ENTER / { inside=1; next }
         /ARRAY_EXIT / { inside=0; next }
         inside && tolower($0) ~ /safepoint/ { bad=1 }
         END { exit bad ? 1 : 0 }' "$WORK/on.log"; then :; else
  reject "safepoint observed inside linked array interval"
fi
if awk '/ARRAY_ENTER / { inside=1; next }
         /ARRAY_EXIT / { inside=0; next }
         inside && tolower($0) ~ /safepoint/ { bad=1 }
         END { exit bad ? 1 : 0 }' "$WORK/forced.log"; then :; else
  reject "safepoint observed inside forced array interval"
fi
! rg -q 'DIRECT_LOAD|ARRAY_OPCODE_REEXECUTE|ARRAY_ADAPTER' "$WORK/negative.log" \
  || reject "near-miss unexpectedly used linked array slot"
if "$NODE" "$LOG_CHECKER" "$WORK/combined.log" linked >/dev/null 2>&1; then :; else
  reject "combined array case sequence/order failed"
fi
rg -q '^COMBINED_RESULT array-and-benchmark ' "$WORK/combined.log" \
  || reject "combined benchmark call did not return"
check_late_cmd_cleanup "$WORK/combined.log" '^COMBINED_RESULT array-and-benchmark ' \
  || reject "combined pthread teardown diagnostic ordering/count"
rg -q '^\[zbg\] ENTRY method=intArrayLoad kind=12 ' "$WORK/combined.log" \
  || reject "combined array method did not use linked classifier"
rg -q '^\[zbp\] JS_INSTALL benchmark .* bytes=1392$' "$WORK/combined.log" \
  || reject "combined benchmark module was not independently installed"
rg -q '^\[zbp\] BENCH_INSTALL_RESULT module-id=[1-9][0-9]* slots=' "$WORK/combined.log" \
  || reject "combined benchmark slot namespace missing"
BENCH_SLOTS=$(sed -n 's/.*BENCH_INSTALL_RESULT .* slots=//p' "$WORK/combined.log" | head -1)
BENCH_SLOT_COUNT=$(printf '%s\n' "$BENCH_SLOTS" | awk -F, '{print NF}')
[ "$BENCH_SLOT_COUNT" -eq 10 ] || reject "combined registered benchmark slot count=$BENCH_SLOT_COUNT"
rg -q '^\[zbg\] ARRAY_MODULE_KEY .*exports=11 slot=10 ' "$WORK/combined.log" \
  || reject "combined logical array slot 10 manifest missing"
[ -s /private/tmp/mcweb-zero-linked-benchmark.wasm ] \
  || reject "combined benchmark dump missing"
COMBINED_BENCH_SHA=$(shasum -a 256 /private/tmp/mcweb-zero-linked-benchmark.wasm | awk '{print $1}')
COMBINED_BENCH_SIZE=$(wc -c < /private/tmp/mcweb-zero-linked-benchmark.wasm | awk '{print $1}')
[ "$COMBINED_BENCH_SIZE" -eq "$EXPECTED_BENCH_SIZE" ] \
  || reject "combined benchmark bytes=$COMBINED_BENCH_SIZE"
"$WASM_DIS" /private/tmp/mcweb-zero-linked-benchmark.wasm -o "$WORK/combined-benchmark.wat" \
  || reject "combined benchmark wasm-dis failed"
GROUP_CARD_LINE=$(rg '^\[zbg\] CARD_BASE live=[0-9]+ context=group-store-child expected-occurrences=1$' \
  "$WORK/combined.log" || true)
BENCH_CARD_LINE=$(rg '^\[zbp\] CARD_BASE live=[0-9]+ context=benchmark-store expected-occurrences=2$' \
  "$WORK/combined.log" || true)
[ "$(printf '%s\n' "$GROUP_CARD_LINE" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
  || reject "combined live array card-base marker count is not one"
[ "$(printf '%s\n' "$BENCH_CARD_LINE" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
  || reject "combined live benchmark card-base marker count is not one"
GROUP_CARD_BASE=$(printf '%s\n' "$GROUP_CARD_LINE" | sed -E 's/.*live=([0-9]+).*/\1/')
BENCH_CARD_BASE=$(printf '%s\n' "$BENCH_CARD_LINE" | sed -E 's/.*live=([0-9]+).*/\1/')
case "$GROUP_CARD_BASE:$BENCH_CARD_BASE" in
  ''|*[!0-9:]*) reject "combined live card-base marker is not unsigned decimal" ;;
esac
[ "$GROUP_CARD_BASE" = "$BENCH_CARD_BASE" ] \
  || reject "combined live card-base differs array=$GROUP_CARD_BASE benchmark=$BENCH_CARD_BASE"
COMBINED_ARRAY_WAT="$WORK/combined-array.wat"
"$WASM_DIS" "$WASM_DUMP" -o "$COMBINED_ARRAY_WAT" \
  || reject "combined array wasm-dis failed"
"$NODE" "$RELOC_CHECKER" "$WASM_DUMP" "$COMBINED_ARRAY_WAT" "$GROUP_CARD_BASE" 1 \
  "$EXPECTED_LOAD_SHA" "$WORK/combined-array-canonical.wasm" load \
  >"$WORK/combined-array-relocation.log" 2>&1 \
  || reject "combined array live card-base relocation check failed"
"$NODE" "$RELOC_CHECKER" /private/tmp/mcweb-zero-linked-benchmark.wasm \
  "$WORK/combined-benchmark.wat" "$BENCH_CARD_BASE" 2 \
  "$EXPECTED_BENCH_SHA" "$WORK/combined-benchmark-canonical.wasm" benchmark \
  >"$WORK/combined-benchmark-relocation.log" 2>&1 \
  || reject "combined benchmark live card-base relocation check failed"
COMBINED_ARRAY_CANONICAL_SHA=$(shasum -a 256 "$WORK/combined-array-canonical.wasm" | awk '{print $1}')
COMBINED_BENCH_CANONICAL_SHA=$(shasum -a 256 "$WORK/combined-benchmark-canonical.wasm" | awk '{print $1}')
[ "$COMBINED_ARRAY_CANONICAL_SHA" = "$EXPECTED_LOAD_SHA" ] \
  || reject "combined array canonical relocation hash changed: $COMBINED_ARRAY_CANONICAL_SHA"
[ "$COMBINED_BENCH_CANONICAL_SHA" = "$EXPECTED_BENCH_SHA" ] \
  || reject "combined benchmark canonical relocation hash changed: $COMBINED_BENCH_CANONICAL_SHA"
[ "$(rg -c '^[[:space:]]*\(export ' "$WORK/combined-benchmark.wat" || true)" -eq 20 ] \
  || reject "combined benchmark Wasm export count is not 20"
[ "$(rg -c '^[[:space:]]*\(func \$' "$WORK/combined-benchmark.wat" || true)" -eq 28 ] \
  || reject "combined benchmark function count is not 28"

[ -s "$WASM_DUMP" ] || reject "array module dump missing"
WASM_MTIME=$(stat -f %m "$WASM_DUMP")
[ "$WASM_MTIME" -ge "$RUN_EPOCH_BEFORE" ] || reject "array dump predates current run"
WASM_SIZE=$(wc -c < "$WASM_DUMP" | awk '{print $1}')
WASM_SHA=$(shasum -a 256 "$WASM_DUMP" | awk '{print $1}')
COMBINED_ARRAY_SIZE=$WASM_SIZE
COMBINED_ARRAY_SHA=$WASM_SHA
rg -F -q '[zbg] ARRAY_MODULE_KEY abi=intArrayLoad:([II)I->(i32,i32,i32)->i64 exports=11 slot=10 ' "$WORK/combined.log" \
  || reject "array module key manifest missing"
KEY_BYTES=$(sed -n 's/.*ARRAY_MODULE_KEY .* bytes=\([0-9][0-9]*\).*/\1/p' "$WORK/combined.log" | head -1)
INSTALL_BYTES=$(sed -n 's/.*JS_INSTALL linked-group direct-calls=.* bytes=\([0-9][0-9]*\).*/\1/p' "$WORK/combined.log" | head -1)
[ -n "$KEY_BYTES" ] && [ "$KEY_BYTES" = "$INSTALL_BYTES" ] && [ "$KEY_BYTES" = "$WASM_SIZE" ] \
  || reject "array module key/install/dump byte binding mismatch"
"$WASM_DIS" "$WASM_DUMP" -o "$WORK/linked.wat" || reject "wasm-dis rejected array module"
[ "$(rg -c '^[[:space:]]*\(export ' "$WORK/linked.wat" || true)" -eq 11 ] \
  || reject "array production module is not the eleven-export superset"
rg -q '^[[:space:]]*\(export "intArrayLoad" ' "$WORK/linked.wat" \
  || reject "missing intArrayLoad export"
"$NODE" "$ROOT/tests/check-zero-linked-array-wat.mjs" \
  "$WASM_DUMP" "$WORK/linked.wat" >"$WORK/shape.log" 2>&1 \
  || reject "depth-aware array WAT/binary checker failed"

echo "derived-intArrayLoad-iaload-bci=$IALOAD_BCI return-bci=$RETURN_BCI"
echo "array-module-export-count=11 direct-loads=3 opcode-reexec=5 interpreter-iaload=5 forced-memory-reexec=8"
echo "memory-size-guard=present call-free=present real-heap-mutation=present"
echo "array-provenance source-sha=$SOURCE_SHA fixture-jar-sha=$JAR_SHA class-sha=$CLASS_SHA wasm-sha=$WASM_SHA wasm-bytes=$WASM_SIZE wasm-mtime=$WASM_MTIME"
echo "array-runtime-provenance context=$LEGACY_CONTEXT globals=$GLOBALS_SHA interpreter=$INTERPRETER_SHA baseline=$BASELINE_SHA launcher=$LAUNCHER_SHA built-java=$BUILT_JAVA_SHA built-libjvm=$BUILT_LIBJVM_SHA checker=$CHECKER_SHA log-checker=$LOG_CHECKER_SHA gate=$SCRIPT_SHA"
echo "combined-module-binding array-sha=$COMBINED_ARRAY_SHA array-bytes=$COMBINED_ARRAY_SIZE array-card-base=$GROUP_CARD_BASE array-canonical-sha=$COMBINED_ARRAY_CANONICAL_SHA benchmark-sha=$COMBINED_BENCH_SHA benchmark-bytes=$COMBINED_BENCH_SIZE benchmark-card-base=$BENCH_CARD_BASE benchmark-canonical-sha=$COMBINED_BENCH_CANONICAL_SHA benchmark-wasm-exports=20 benchmark-registered-slots=$BENCH_SLOT_COUNT benchmark-funcs=28 array-logical-slot=10"
echo "ACCEPT M2-A int[] load linked-success plus canonical fallback slice"
echo "M2-B REJECT: reference arrays/bounds variants/compiled handlers/GC continuation/monitors/cache/resource gates remain open"
