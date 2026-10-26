#!/bin/sh
# OSS-only, opt-in M1-P1b linked-Wasm hot-path benchmark.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JAVAC=${JAVAC:-/opt/homebrew/opt/openjdk@25/bin/javac}
JAR=${JAR:-/opt/homebrew/opt/openjdk@25/bin/jar}
WASM_DIS=${WASM_DIS:-/opt/homebrew/bin/wasm-dis}
NODE=${NODE:-node}
RUN_JAVA="$ROOT/run-java.sh"
RELOC_CHECKER="$ROOT/tests/check-zero-linked-array-relocation.mjs"
JDK="$ROOT/work/jdk25"
PATCH13="$ROOT/patches/0013-zero-wasm-linked-benchmark.patch"
PATCH14="$ROOT/patches/0014-zero-wasm-linked-int-array-load.patch"
PATCH15="$ROOT/patches/0015-zero-wasm-linked-int-array-store.patch"
PATCH16="$ROOT/patches/0016-zero-wasm-linked-ref-array-load.patch"
PATCH17="$ROOT/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch"
PATCH18="$ROOT/patches/0018-zero-wasm-linked-ref-array-store.patch"
LOCK_HELPER="$ROOT/tests/zero-runtime-gate-lock.sh"
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-performance.XXXXXX)
git_safe() {
  git -c core.fsmonitor=false -c gc.auto=0 -c maintenance.auto=false "$@"
}
cleanup_work() {
  status=$?
  trap - EXIT INT TERM
  case "$WORK" in
    /private/tmp/mcweb-zero-linked-performance.??????)
      if [ -f "$WORK/perf.log" ]; then
        cp "$WORK/perf.log" /private/tmp/mcweb-zero-linked-performance-last.log || :
      fi
      rm -rf -- "$WORK" || :
      ;;
  esac
  runtime_gate_lock_release || :
  exit "$status"
}
trap cleanup_work EXIT INT TERM
TIMED_N=5000000
TRIALS=31
PRIM_ORACLE=25000095000000
DISPATCH_ORACLE=12500087500000
STORE_ORACLE=207500000
DIV_ORACLE=4166675833333
THROW_ORACLE=12500037500000
PRIM_WARM_ORACLE=10001900000
DISPATCH_WARM_ORACLE=5001750000
STORE_WARM_ORACLE=4150000
DIV_WARM_ORACLE=1666850000
THROW_WARM_ORACLE=5000750000
# Java fixture methods return int; these are the signed 32-bit projections of
# the i64 Wasm checksums above, while the C++ markers remain full-width.
PRIM_JAVA_ORACLE=-909630016
DISPATCH_JAVA_ORACLE=1732668640
STORE_JAVA_ORACLE=207500000
DIV_JAVA_ORACLE=557556213
THROW_JAVA_ORACLE=1682668640
EXPECTED_MODULE_SHA=de66a54524031d40c5fa5abf2d4874fa8f9aace99a6b2d440b2d663fdc7dab41
EXPECTED_MODULE_SIZE=1392
EXPECTED_RELOC_CHECKER_SHA=42f1e1c137f2f06dd11de9f9e6afae51bafc858973b228ada8e88761f6c18436
EXPECTED_PATCH13_SHA=a68e95c8c22e303561b9811fe4368875fcf2d16911873a90fa5289ffef852c5c
EXPECTED_PATCH14_SHA=8320faa76eb1288c066bbd8ae86a14333cb4737c030e683d7ec4ccabb644aa11
EXPECTED_PATCH15_SHA=9d76abe0cd8818b37089ff96386203cb9f2de3d0f6591768119c1e8213ffe2d2
EXPECTED_PATCH16_SHA=0d7c204725b28cb1824f49cc2988f86ba07fea98098dbad126c98861ddb7c7ee
EXPECTED_PATCH17_SHA=ddb93941e71c293b6b20ca2810806301aaddf046f1f0cd24d2bb21366cac96a8
EXPECTED_PATCH18_SHA=53cf9d1332f70d3f83e101ec73b5f6d3ebde7e9bb059fd8456754a3e0bcc0024
EXPECTED_PREPARED_HEAD=6c48f4ed707bf0b15f9b6098de30db8aae6fa40f
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
  *) echo "REJECT P1b: unknown legacy context: $LEGACY_CONTEXT" >&2; exit 1 ;;
esac
EXPECTED_0015_GLOBALS_SHA=194c8187621a306f76a7db4fab54c54b5a164449e413d575120385aa11b0e692
EXPECTED_0015_INTERPRETER_SHA=cea189b172c8ed050912f4ea92e4caf08268445f45a6daf2c1ce905fb5496fb5
EXPECTED_0015_BASELINE_SHA=0207ad4a93fca8352fa24f64f520484306be969605239b7eca2ffa97cc0ffa37
EXPECTED_0014_GLOBALS_SHA=735562249a2c08ea8fb6d93385808b6a120c3a1e3625c75eb45c37d0ab9cbb5b
EXPECTED_0014_INTERPRETER_SHA=1ad779cc376ad368bd324546c53829c3717cb25e1b2fd6ecafc36885d66160fa
EXPECTED_0014_BASELINE_SHA=9dfbf68c352cf563842f979b18e6e4b55fc7a10218dd4ac51a8ee888467352db
PATCH_NAMES="0001 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018"
PATCH13_PATHS="src/hotspot/cpu/zero/globals_zero.hpp
src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp
src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp"
PATCH14_PATHS="$PATCH13_PATHS"
PATCH15_PATHS="$PATCH13_PATHS"
PATCH16_PATHS="$PATCH13_PATHS"
for tool in "$JAVAC" "$JAR" "$WASM_DIS" "$RUN_JAVA"; do
  [ -x "$tool" ] || { echo "REJECT P1a: missing $tool" >&2; exit 1; }
done
[ -x "$(command -v "$NODE" 2>/dev/null || true)" ] || { echo 'REJECT P1a: node unavailable' >&2; exit 1; }
[ -f "$RELOC_CHECKER" ] || { echo 'REJECT P1b: relocation checker unavailable' >&2; exit 1; }
[ "$(shasum -a 256 "$RELOC_CHECKER" | awk '{print $1}')" = "$EXPECTED_RELOC_CHECKER_SHA" ] \
  || { echo 'REJECT P1b: relocation checker drift' >&2; exit 1; }
[ -d "$JDK/.git" ] || { echo 'REJECT P1b: missing prepared OpenJDK checkout' >&2; exit 1; }
[ -f "$PATCH13" ] || { echo 'REJECT P1b: missing 0013 runtime patch' >&2; exit 1; }
[ -f "$PATCH14" ] || { echo 'REJECT P1b: missing 0014 runtime patch' >&2; exit 1; }
[ -f "$PATCH15" ] || { echo 'REJECT P1b: missing 0015 runtime patch' >&2; exit 1; }
[ -f "$PATCH16" ] || { echo 'REJECT P1b: missing 0016 runtime patch' >&2; exit 1; }
[ -f "$PATCH17" ] || { echo 'REJECT P1b: missing 0017 runtime patch' >&2; exit 1; }
[ -f "$PATCH18" ] || { echo 'REJECT P1b: missing 0018 runtime patch' >&2; exit 1; }
[ -r "$LOCK_HELPER" ] || { echo 'REJECT P1b: missing runtime gate lock helper' >&2; exit 1; }
. "$LOCK_HELPER"
if [ "${MCWEB_RUNTIME_GATE_LOCK_PROBE:-0}" = 1 ]; then
  runtime_gate_lock_acquire || exit 1
  exit 0
fi
runtime_gate_lock_acquire || { echo 'REJECT P1b: another Zero runtime gate owns the lock' >&2; exit 1; }
runtime_gate_lock_self_test "$0" /private/tmp/mcweb-zero-linked-group.wasm /private/tmp/mcweb-zero-linked-benchmark.wasm \
  || { echo 'REJECT P1b: second invocation lock self-test failed' >&2; exit 1; }
printf '%s\n' 'runtime-gate-lock=self-test-pass'
PROVENANCE18="$ROOT/tests/check-zero-0018-legacy-provenance.sh"
[ -x "$PROVENANCE18" ] || { echo 'REJECT P1b: 0018 provenance checker unavailable' >&2; exit 1; }
"$PROVENANCE18" "$ROOT" "$JDK" "$WORK/provenance-0018" \
  || { echo 'REJECT P1b: 0018 clean/final provenance failed' >&2; exit 1; }

patch_for_name() {
  name=$1
  set -- "$ROOT"/patches/"$name"-*.patch
  [ "$#" -eq 1 ] && [ -f "$1" ] || return 1
  printf '%s\n' "$1"
}

patch_paths() {
  awk '/^diff --git / { print $4 }' "$1" | sed 's#^b/##' | LC_ALL=C sort -u
}

check_patch13_paths() {
  patch_paths "$1" >"$WORK/patch13-paths.$$.tmp"
  printf '%s\n' "$PATCH13_PATHS" | LC_ALL=C sort -u >"$WORK/patch13-expected.$$.tmp"
  cmp -s "$WORK/patch13-paths.$$.tmp" "$WORK/patch13-expected.$$.tmp"
}

check_patch14_paths() {
  patch_paths "$1" >"$WORK/patch14-paths.$$.tmp"
  printf '%s\n' "$PATCH14_PATHS" | LC_ALL=C sort -u >"$WORK/patch14-expected.$$.tmp"
  cmp -s "$WORK/patch14-paths.$$.tmp" "$WORK/patch14-expected.$$.tmp"
}

check_patch15_paths() {
  patch_paths "$1" >"$WORK/patch15-paths.$$.tmp"
  printf '%s\n' "$PATCH15_PATHS" | LC_ALL=C sort -u >"$WORK/patch15-expected.$$.tmp"
  cmp -s "$WORK/patch15-paths.$$.tmp" "$WORK/patch15-expected.$$.tmp" || return 1
  ! rg -q '^(GIT binary patch|Binary files |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )' "$1"
}

check_patch16_paths() {
  patch_paths "$1" >"$WORK/patch16-paths.$$.tmp"
  printf '%s\n' "$PATCH16_PATHS" | LC_ALL=C sort -u >"$WORK/patch16-expected.$$.tmp"
  cmp -s "$WORK/patch16-paths.$$.tmp" "$WORK/patch16-expected.$$.tmp" || return 1
  ! rg -q '^(GIT binary patch|Binary files |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )' "$1"
}

check_source_hashes() {
  source_root=$1
  [ "$(shasum -a 256 "$source_root/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_OVERLAY_GLOBALS_SHA" ]
  [ "$(shasum -a 256 "$source_root/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_OVERLAY_INTERPRETER_SHA" ]
  [ "$(shasum -a 256 "$source_root/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_OVERLAY_BASELINE_SHA" ]
}

check_source_hashes_0018() {
  source_root=$1
  [ "$(shasum -a 256 "$source_root/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0018_GLOBALS_SHA" ]
  [ "$(shasum -a 256 "$source_root/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0018_INTERPRETER_SHA" ]
  [ "$(shasum -a 256 "$source_root/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0018_BASELINE_SHA" ]
}

check_patch_order() {
  order_file=$1
  printf '%s\n' $PATCH_NAMES >"$WORK/expected-patch-order.$$.tmp"
  awk '{ sub(/^.*\//, "", $0); sub(/-[^-]+\.patch$/, "", $0); print substr($0, 1, 4) }' "$order_file" \
    | cmp -s - "$WORK/expected-patch-order.$$.tmp"
}

check_source_drift() {
  source_root=$1
  allowed_paths=$2
  git_safe -C "$source_root" diff --name-only HEAD \
    | LC_ALL=C sort -u >"$WORK/tracked-drift.$$.tmp"
  comm -23 "$WORK/tracked-drift.$$.tmp" "$allowed_paths" >"$WORK/outside-drift.$$.tmp"
  [ ! -s "$WORK/outside-drift.$$.tmp" ] || return 1
  git_safe -C "$source_root" status --porcelain=v1 --untracked-files=all \
    | awk 'substr($0, 1, 2) == "??" { print substr($0, 4) }' >"$WORK/untracked-drift.$$.tmp"
  : >"$WORK/unexpected-untracked.$$.tmp"
  while IFS= read -r path_name; do
    [ -n "$path_name" ] || continue
    case "$path_name" in
      build/*|a.out|a.out.*|*.wasm|*.wat)
        printf '%s\n' "$path_name" >>"$WORK/categorized-generated.$$.tmp" ;;
      *)
        if grep -F -x -q "$path_name" "$allowed_paths"; then
          printf '%s\n' "$path_name" >>"$WORK/patch-owned-untracked.$$.tmp"
        else
          printf '%s\n' "$path_name" >>"$WORK/unexpected-untracked.$$.tmp"
        fi ;;
    esac
  done <"$WORK/untracked-drift.$$.tmp"
  if [ -s "$WORK/categorized-generated.$$.tmp" ]; then
    printf 'PROVENANCE categorized-generated-untracked=' >&2
    tr '\n' ',' <"$WORK/categorized-generated.$$.tmp" >&2
    printf '\n' >&2
  fi
  if [ -s "$WORK/outside-drift.$$.tmp" ] || [ -s "$WORK/unexpected-untracked.$$.tmp" ]; then
    cat "$WORK/outside-drift.$$.tmp" "$WORK/unexpected-untracked.$$.tmp" >&2
    return 1
  fi
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

pthread_teardown_parser_self_test || {
  echo 'REJECT P1b: pthread teardown parser negative was accepted' >&2
  exit 1
}

check_patch_union_bytes_and_modes() {
  source_root=$1
  reconstructed_root=$2
  allowed_paths=$3
  while IFS= read -r path_name; do
    [ -n "$path_name" ] || continue
    source_path="$source_root/$path_name"
    reconstructed_path="$reconstructed_root/$path_name"
    if [ -e "$source_path" ] && [ -e "$reconstructed_path" ]; then
      cmp -s "$source_path" "$reconstructed_path" || {
        echo "REJECT P1b: patch-owned source bytes drifted: $path_name" >&2
        return 1
      }
      source_mode=$(stat -f '%Lp' "$source_path")
      reconstructed_mode=$(stat -f '%Lp' "$reconstructed_path")
      [ "$source_mode" = "$reconstructed_mode" ] || {
        echo "REJECT P1b: patch-owned source mode drifted: $path_name" >&2
        return 1
      }
    elif [ -e "$source_path" ] || [ -e "$reconstructed_path" ]; then
      echo "REJECT P1b: patch-owned source presence drifted: $path_name" >&2
      return 1
    fi
  done <"$allowed_paths"
}

# Pin the prepared source and exact 0013 ownership before reconstruction.
[ "$(shasum -a 256 "$PATCH13" | awk '{print $1}')" = "$EXPECTED_PATCH13_SHA" ] \
  || { echo 'REJECT P1b: 0013 patch hash drift' >&2; exit 1; }
[ "$(shasum -a 256 "$PATCH14" | awk '{print $1}')" = "$EXPECTED_PATCH14_SHA" ] \
  || { echo 'REJECT P1b: 0014 patch hash drift' >&2; exit 1; }
[ "$(shasum -a 256 "$PATCH15" | awk '{print $1}')" = "$EXPECTED_PATCH15_SHA" ] \
  || { echo 'REJECT P1b: 0015 patch hash drift' >&2; exit 1; }
[ "$(shasum -a 256 "$PATCH16" | awk '{print $1}')" = "$EXPECTED_PATCH16_SHA" ] \
  || { echo 'REJECT P1b: 0016 patch hash drift' >&2; exit 1; }
[ "$(shasum -a 256 "$PATCH17" | awk '{print $1}')" = "$EXPECTED_PATCH17_SHA" ] \
  || { echo 'REJECT P1b: 0017 patch hash drift' >&2; exit 1; }
[ "$(shasum -a 256 "$PATCH18" | awk '{print $1}')" = "$EXPECTED_PATCH18_SHA" ] \
  || { echo 'REJECT P1b: 0018 patch hash drift' >&2; exit 1; }
[ "$(git_safe -C "$JDK" rev-parse HEAD)" = "$EXPECTED_PREPARED_HEAD" ] \
  || { echo 'REJECT P1b: prepared JDK HEAD drift' >&2; exit 1; }

# Validate the prepared runtime against 0013 and reconstruct/reverse the
# complete numbered stack. This is a prepared-source/full-stack preflight,
# not independent build provenance.
PATCH_CHECK="$WORK/patch-check"
mkdir -p "$PATCH_CHECK"
if [ "${MCWEB_ZERO_VALIDATE_LEGACY_0016_SOURCE:-0}" = 1 ]; then
while IFS= read -r file_path; do
  [ -f "$JDK/$file_path" ] || { echo "REJECT P1b: prepared source missing $file_path" >&2; exit 1; }
  mkdir -p "$PATCH_CHECK/$(dirname "$file_path")"
  cp "$JDK/$file_path" "$PATCH_CHECK/$file_path"
done <<EOF
$PATCH13_PATHS
EOF
git_safe -C "$PATCH_CHECK" init -q
git_safe -C "$PATCH_CHECK" apply --reverse --check "$PATCH16" \
  || { echo 'REJECT P1b: prepared runtime does not match 0016' >&2; exit 1; }
git_safe -C "$PATCH_CHECK" apply --reverse "$PATCH16"
git_safe -C "$PATCH_CHECK" apply --reverse --check "$PATCH15" \
  || { echo 'REJECT P1b: prepared runtime does not match 0015' >&2; exit 1; }
git_safe -C "$PATCH_CHECK" apply --reverse "$PATCH15"
git_safe -C "$PATCH_CHECK" apply --reverse --check "$PATCH14" \
  || { echo 'REJECT P1b: prepared runtime does not match 0014' >&2; exit 1; }
git_safe -C "$PATCH_CHECK" apply --reverse "$PATCH14"
git_safe -C "$PATCH_CHECK" apply --reverse --check "$PATCH13" \
  || { echo 'REJECT P1b: prepared runtime does not match 0013' >&2; exit 1; }
git_safe -C "$PATCH_CHECK" apply --reverse "$PATCH13"
fi

PATCH_STACK_LIST="$WORK/patch-stack.list"
: >"$PATCH_STACK_LIST"
for patch_name in $PATCH_NAMES; do
  patch_for_name "$patch_name" >>"$PATCH_STACK_LIST" \
    || { echo "REJECT P1b: missing patch $patch_name" >&2; exit 1; }
done
check_patch13_paths "$PATCH13" \
  || { echo 'REJECT P1b: 0013 path allowlist drift' >&2; exit 1; }
check_patch14_paths "$PATCH14" \
  || { echo 'REJECT P1b: 0014 path allowlist drift' >&2; exit 1; }
check_patch15_paths "$PATCH15" \
  || { echo 'REJECT P1b: 0015 path/mode/binary allowlist drift' >&2; exit 1; }
check_patch16_paths "$PATCH16" \
  || { echo 'REJECT P1b: 0016 path/mode/binary allowlist drift' >&2; exit 1; }
awk '
  /git apply.*0014-zero-wasm-linked-int-array-load\.patch/ { fourteen = NR }
  /git apply.*0015-zero-wasm-linked-int-array-store\.patch/ { fifteen = NR }
  /git apply.*0016-zero-wasm-linked-ref-array-load\.patch/ { sixteen = NR }
  /git apply.*0017-zero-wasm-linked-ref-array-load-cache-integrity\.patch/ { seventeen = NR }
  /git apply.*0018-zero-wasm-linked-ref-array-store\.patch/ { eighteen = NR }
  END { exit !(fourteen && fifteen && sixteen && seventeen && eighteen && fifteen == fourteen + 1 && sixteen == fifteen + 1 && seventeen == sixteen + 1 && eighteen == seventeen + 1) }
' "$ROOT/setup.sh" || { echo 'REJECT P1b: setup 0014/0015/0016/0017/0018 patch order drift' >&2; exit 1; }
check_patch_order "$PATCH_STACK_LIST" \
  || { echo 'REJECT P1b: patch stack order/omission drift' >&2; exit 1; }
PATCH_UNION="$WORK/patch-union.paths"
: >"$PATCH_UNION"
while IFS= read -r patch_path; do
  patch_paths "$patch_path" >>"$PATCH_UNION"
done <"$PATCH_STACK_LIST"
LC_ALL=C sort -u "$PATCH_UNION" -o "$PATCH_UNION"
check_source_hashes "$JDK" \
  || { echo 'REJECT P1b: prepared source hash drift' >&2; exit 1; }

STACK_CHECK="$WORK/full-stack"
PRE12_CHECK="$WORK/pre-0013"
mkdir -p "$STACK_CHECK" "$PRE12_CHECK"
git_safe -C "$JDK" archive HEAD | tar -x -C "$STACK_CHECK"
git_safe -C "$JDK" archive HEAD | tar -x -C "$PRE12_CHECK"
git_safe -C "$STACK_CHECK" init -q
git_safe -C "$PRE12_CHECK" init -q
git_safe -C "$STACK_CHECK" add -A
git_safe -C "$PRE12_CHECK" add -A
git_safe -C "$STACK_CHECK" -c user.name=mcweb -c user.email=mcweb@example.invalid commit -qm base
git_safe -C "$PRE12_CHECK" -c user.name=mcweb -c user.email=mcweb@example.invalid commit -qm base
while IFS= read -r patch_path; do
  git_safe -C "$STACK_CHECK" apply --check "$patch_path" \
    || { echo "REJECT P1b: forward patch check failed at $(basename "$patch_path")" >&2; exit 1; }
  git_safe -C "$STACK_CHECK" apply "$patch_path"
done <"$PATCH_STACK_LIST"
check_source_hashes_0018 "$STACK_CHECK" \
  || { echo 'REJECT P1b: reconstructed final source hash drift' >&2; exit 1; }
if [ "${MCWEB_ZERO_VALIDATE_LEGACY_0016_SOURCE:-0}" = 1 ]; then
  check_source_drift "$JDK" "$PATCH_UNION" \
    || { echo 'REJECT P1b: source drift outside patch union or unowned untracked source' >&2; exit 1; }
  check_patch_union_bytes_and_modes "$JDK" "$STACK_CHECK" "$PATCH_UNION" \
    || { echo 'REJECT P1b: prepared patch-owned source differs from clean forward reconstruction' >&2; exit 1; }
fi
PRE12_STACK="$WORK/pre12-stack.list"
: >"$PRE12_STACK"
for patch_name in 0001 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012; do
  patch_for_name "$patch_name" >>"$PRE12_STACK"
done
while IFS= read -r patch_path; do
  git_safe -C "$PRE12_CHECK" apply --check "$patch_path" \
    || { echo "REJECT P1b: independent 0012 reconstruction failed at $(basename "$patch_path")" >&2; exit 1; }
git_safe -C "$PRE12_CHECK" apply "$patch_path"
done <"$PRE12_STACK"
git_safe -C "$STACK_CHECK" apply --reverse --check "$PATCH18" \
  || { echo 'REJECT P1b: 0018 reverse preimage check failed' >&2; exit 1; }
git_safe -C "$STACK_CHECK" apply --reverse "$PATCH18"
[ "$(shasum -a 256 "$STACK_CHECK/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0017_GLOBALS_SHA" ] \
  || { echo 'REJECT P1b: 0018 globals preimage drift' >&2; exit 1; }
[ "$(shasum -a 256 "$STACK_CHECK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0017_INTERPRETER_SHA" ] \
  || { echo 'REJECT P1b: 0018 interpreter preimage drift' >&2; exit 1; }
[ "$(shasum -a 256 "$STACK_CHECK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0017_BASELINE_SHA" ] \
  || { echo 'REJECT P1b: 0018 baseline preimage drift' >&2; exit 1; }
git_safe -C "$STACK_CHECK" apply --reverse --check "$PATCH17" \
  || { echo 'REJECT P1b: 0017 reverse preimage check failed' >&2; exit 1; }
git_safe -C "$STACK_CHECK" apply --reverse "$PATCH17"
[ "$(shasum -a 256 "$STACK_CHECK/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_GLOBALS_SHA" ] \
  || { echo 'REJECT P1b: 0017 globals preimage drift' >&2; exit 1; }
[ "$(shasum -a 256 "$STACK_CHECK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_INTERPRETER_SHA" ] \
  || { echo 'REJECT P1b: 0017 interpreter preimage drift' >&2; exit 1; }
[ "$(shasum -a 256 "$STACK_CHECK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_BASELINE_SHA" ] \
  || { echo 'REJECT P1b: 0017 baseline preimage drift' >&2; exit 1; }
git_safe -C "$STACK_CHECK" apply --reverse --check "$PATCH16" \
  || { echo 'REJECT P1b: 0016 reverse preimage check failed' >&2; exit 1; }
git_safe -C "$STACK_CHECK" apply --reverse "$PATCH16"
check_source_hashes_0015() {
  source_root=$1
  [ "$(shasum -a 256 "$source_root/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0015_GLOBALS_SHA" ]
  [ "$(shasum -a 256 "$source_root/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0015_INTERPRETER_SHA" ]
  [ "$(shasum -a 256 "$source_root/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0015_BASELINE_SHA" ]
}
check_source_hashes_0015 "$STACK_CHECK" \
  || { echo 'REJECT P1b: 0016 preimage drift' >&2; exit 1; }
git_safe -C "$STACK_CHECK" apply --reverse --check "$PATCH15" \
  || { echo 'REJECT P1b: 0015 reverse preimage check failed' >&2; exit 1; }
git_safe -C "$STACK_CHECK" apply --reverse "$PATCH15"
[ "$(shasum -a 256 "$STACK_CHECK/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0014_GLOBALS_SHA" ] \
  || { echo 'REJECT P1b: 0015 globals preimage drift' >&2; exit 1; }
[ "$(shasum -a 256 "$STACK_CHECK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0014_INTERPRETER_SHA" ] \
  || { echo 'REJECT P1b: 0015 interpreter preimage drift' >&2; exit 1; }
[ "$(shasum -a 256 "$STACK_CHECK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0014_BASELINE_SHA" ] \
  || { echo 'REJECT P1b: 0015 baseline preimage drift' >&2; exit 1; }
git_safe -C "$STACK_CHECK" apply --reverse --check "$PATCH14" \
  || { echo 'REJECT P1b: 0014 reverse preimage check failed' >&2; exit 1; }
git_safe -C "$STACK_CHECK" apply --reverse "$PATCH14"
git_safe -C "$STACK_CHECK" apply --reverse --check "$PATCH13" \
  || { echo 'REJECT P1b: 0013 reverse preimage check failed' >&2; exit 1; }
git_safe -C "$STACK_CHECK" apply --reverse "$PATCH13"
while IFS= read -r source_path; do
  cmp -s "$STACK_CHECK/$source_path" "$PRE12_CHECK/$source_path" \
    || { echo "REJECT P1b: 0013 preimage differs from independent 0012 source: $source_path" >&2; exit 1; }
done <<EOF
$PATCH13_PATHS
EOF
reverse_index=$(wc -l <"$PATCH_STACK_LIST" | awk '{print $1}')
stack_count=$reverse_index
while [ "$reverse_index" -gt 0 ]; do
  patch_path=$(sed -n "${reverse_index}p" "$PATCH_STACK_LIST")
  if [ "$reverse_index" -lt "$((stack_count - 5))" ]; then
    git_safe -C "$STACK_CHECK" apply --reverse --check "$patch_path" \
      || { echo "REJECT P1b: reverse patch check failed at $(basename "$patch_path")" >&2; exit 1; }
    git_safe -C "$STACK_CHECK" apply --reverse "$patch_path"
  fi
  reverse_index=$((reverse_index - 1))
done
git_safe -C "$STACK_CHECK" diff --quiet HEAD \
  || { echo 'REJECT P1b: complete reverse stack did not return to clean base' >&2; exit 1; }

# Negative provenance self-tests exercise the checkers without changing the
# prepared checkout or the real patch artifact.
EXTRA_PATCH="$WORK/0013-extra.patch"
cp "$PATCH13" "$EXTRA_PATCH"
printf '\ndiff --git a/src/extra-unowned.cpp b/src/extra-unowned.cpp\n' >>"$EXTRA_PATCH"
if check_patch13_paths "$EXTRA_PATCH"; then
  echo 'REJECT P1b: extra 0013 path negative was accepted' >&2; exit 1
fi

EXTRA_PATCH15="$WORK/0015-extra.patch"
cp "$PATCH15" "$EXTRA_PATCH15"
printf '\ndiff --git a/src/extra-unowned.cpp b/src/extra-unowned.cpp\n' >>"$EXTRA_PATCH15"
if check_patch15_paths "$EXTRA_PATCH15"; then
  echo 'REJECT P1b: extra 0015 path negative was accepted' >&2; exit 1
fi
BINARY_PATCH15="$WORK/0015-binary.patch"
cp "$PATCH15" "$BINARY_PATCH15"
printf '\nGIT binary patch\n' >>"$BINARY_PATCH15"
if check_patch15_paths "$BINARY_PATCH15"; then
  echo 'REJECT P1b: 0015 binary payload negative was accepted' >&2; exit 1
fi
MODE_PATCH15="$WORK/0015-mode.patch"
cp "$PATCH15" "$MODE_PATCH15"
printf '\nnew mode 100755\n' >>"$MODE_PATCH15"
if check_patch15_paths "$MODE_PATCH15"; then
  echo 'REJECT P1b: 0015 mode payload negative was accepted' >&2; exit 1
fi
EXTRA_PATCH16="$WORK/0016-extra.patch"
cp "$PATCH16" "$EXTRA_PATCH16"
printf '\ndiff --git a/src/extra-unowned.cpp b/src/extra-unowned.cpp\n' >>"$EXTRA_PATCH16"
if check_patch16_paths "$EXTRA_PATCH16"; then
  echo 'REJECT P1b: extra 0016 path negative was accepted' >&2; exit 1
fi
BINARY_PATCH16="$WORK/0016-binary.patch"
cp "$PATCH16" "$BINARY_PATCH16"
printf '\nGIT binary patch\n' >>"$BINARY_PATCH16"
if check_patch16_paths "$BINARY_PATCH16"; then
  echo 'REJECT P1b: 0016 binary payload negative was accepted' >&2; exit 1
fi
MODE_PATCH16="$WORK/0016-mode.patch"
cp "$PATCH16" "$MODE_PATCH16"
printf '\nnew mode 100755\n' >>"$MODE_PATCH16"
if check_patch16_paths "$MODE_PATCH16"; then
  echo 'REJECT P1b: 0016 mode payload negative was accepted' >&2; exit 1
fi

HASH_NEGATIVE="$WORK/hash-negative"
mkdir -p "$HASH_NEGATIVE/src/hotspot/cpu/zero" "$HASH_NEGATIVE/src/hotspot/share/interpreter/zero"
cp "$JDK/src/hotspot/cpu/zero/globals_zero.hpp" "$HASH_NEGATIVE/src/hotspot/cpu/zero/globals_zero.hpp"
cp "$JDK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" "$HASH_NEGATIVE/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp"
cp "$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" "$HASH_NEGATIVE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp"
printf '\n// provenance negative\n' >>"$HASH_NEGATIVE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp"
if check_source_hashes "$HASH_NEGATIVE"; then
  echo 'REJECT P1b: owned-source append negative was accepted' >&2; exit 1
fi

OMITTED_ORDER="$WORK/omitted-order.list"
: >"$OMITTED_ORDER"
for patch_name in $PATCH_NAMES; do
  [ "$patch_name" = 0011 ] || patch_for_name "$patch_name" >>"$OMITTED_ORDER"
done
if check_patch_order "$OMITTED_ORDER"; then
  echo 'REJECT P1b: omitted earlier patch negative was accepted' >&2; exit 1
fi

REORDERED_ORDER="$WORK/reordered-order.list"
patch_for_name 0001 >"$REORDERED_ORDER"
patch_for_name 0004 >>"$REORDERED_ORDER"
patch_for_name 0003 >>"$REORDERED_ORDER"
for patch_name in 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018; do
  patch_for_name "$patch_name" >>"$REORDERED_ORDER"
done
if check_patch_order "$REORDERED_ORDER"; then
  echo 'REJECT P1b: reordered earlier patch negative was accepted' >&2; exit 1
fi

DRIFT_NEGATIVE="$WORK/drift-negative"
mkdir -p "$DRIFT_NEGATIVE/src"
git_safe -C "$DRIFT_NEGATIVE" init -q
printf 'base\n' >"$DRIFT_NEGATIVE/src/Owned.cpp"
printf 'base\n' >"$DRIFT_NEGATIVE/src/Unowned.cpp"
git_safe -C "$DRIFT_NEGATIVE" add -A
git_safe -C "$DRIFT_NEGATIVE" -c user.name=mcweb -c user.email=mcweb@example.invalid commit -qm base
printf 'changed\n' >"$DRIFT_NEGATIVE/src/Unowned.cpp"
printf 'untracked\n' >"$DRIFT_NEGATIVE/src/Unowned.hpp"
printf 'src/Owned.cpp\n' >"$WORK/drift-allowed.paths"
if check_source_drift "$DRIFT_NEGATIVE" "$WORK/drift-allowed.paths"; then
  echo 'REJECT P1b: unowned tracked/untracked source negative was accepted' >&2; exit 1
fi

"$JAVAC" -g:none -d "$WORK/classes" "$ROOT/tests/ZeroBaselineFixture.java"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$WORK/fixture.jar" -C "$WORK/classes" .
JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture.class" | awk '{print $1}')
DEPS=''
for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
  class_name=${class_file#"$WORK/classes/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  DEPS="${DEPS:+$DEPS,}${class_name}=sha256:${class_hash}"
done

rm -f /private/tmp/mcweb-zero-linked-benchmark.wasm
"$RUN_JAVA" -Xmx256m -Xms16m -XX:+UseSerialGC \
  -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmLinkedBenchmark \
  -Xlog:gc,safepoint \
  "-XX:ZeroWasmBaselineJarHash=$JAR_SHA" \
  "-XX:ZeroWasmBaselineClassHash=$CLASS_SHA" \
  "-XX:ZeroWasmBaselineDependencyHashes=$DEPS" \
  -XX:+ZeroWasmLinkedGroupVerbose -cp "$WORK/classes" \
  ZeroBaselineFixture perf >"$WORK/perf.log" 2>&1

[ "$(rg -c '^BENCH_PRIM trial ' "$WORK/perf.log")" -eq "$TRIALS" ]
[ "$(rg -c '^BENCH_DISPATCH trial ' "$WORK/perf.log")" -eq "$TRIALS" ]
[ "$(rg -c '^BENCH_STORE trial ' "$WORK/perf.log")" -eq "$TRIALS" ]
[ "$(rg -c '^BENCH_DIV trial ' "$WORK/perf.log")" -eq "$TRIALS" ]
[ "$(rg -c '^BENCH_THROW trial ' "$WORK/perf.log")" -eq "$TRIALS" ]
if rg -q 'BENCH_REJECT|install failed|checksum mismatch|wasm trap|fallback' "$WORK/perf.log"; then
  echo 'REJECT benchmark runtime emitted fallback/rejection diagnostics' >&2
  exit 1
fi
if rg -qi 'CALL MISMATCH|PUSH_REJECT|[[:space:]]RESUME|pending=1|reexecute|fallback|wasm trap|trap|(^|[[:space:]])ERROR([[:space:]]|$)' "$WORK/perf.log"; then
  echo 'REJECT benchmark runtime emitted forbidden fallback/resume diagnostics' >&2
  exit 1
fi
[ "$(rg -c '^\[zbp\] BENCH_ENTRY ' "$WORK/perf.log")" -eq 320 ]
[ "$(rg -c '^\[zbp\] BENCH_WASM_ELAPSED ' "$WORK/perf.log")" -eq 320 ]
rg -q '^BENCH_RESOLVE_WARM result 18 excluded 1$' "$WORK/perf.log"
rg -q '^BENCH_WINDOW_BEGIN$' "$WORK/perf.log"
rg -q '^BENCH_WINDOW_END$' "$WORK/perf.log"
check_late_cmd_cleanup "$WORK/perf.log" '^BENCH_WINDOW_END$' \
  || { echo 'REJECT P1b: invalid pthread teardown diagnostic ordering/count' >&2; exit 1; }
awk '
  /^BENCH_WINDOW_BEGIN$/ { inside=1; next }
  /^BENCH_WINDOW_END$/ { inside=0; next }
  inside && tolower($0) ~ /(^|[^[:alpha:]])(gc|safepoint)([^[:alpha:]]|$)/ { bad=1 }
  END { exit bad+0 }
' "$WORK/perf.log"
rg -q '^BENCH_WARMUP n 100000 calls 10$' "$WORK/perf.log"
order_line=$(rg '^BENCH_ORDER seed 0x5eed5eed sequence ' "$WORK/perf.log")
order_sequence=$(printf '%s\n' "$order_line" | awk '{print $5}')
[ "${#order_sequence}" -eq "$TRIALS" ]
printf '%s\n' "$order_line" | rg -q '^BENCH_ORDER seed 0x5eed5eed sequence [CR]{31}$'
# Every Java trial must be present exactly once for every lane.  The checksum
# fields are checked against the scalar oracle here; the elapsed-marker check
# below binds the same trial slots to the randomized C++/Wasm sequence.
awk -v trials="$TRIALS" \
    -v prim="$PRIM_JAVA_ORACLE" -v dispatch="$DISPATCH_JAVA_ORACLE" \
    -v store="$STORE_JAVA_ORACLE" -v div="$DIV_JAVA_ORACLE" -v throwing="$THROW_JAVA_ORACLE" '
  /^BENCH_(PRIM|DISPATCH|STORE|DIV|THROW) trial / {
    lane = $1; sub(/^BENCH_/, "", lane);
    trial = $3 + 0;
    key = lane SUBSEP trial;
    if (trial < 0 || trial >= trials || seen[key]++) bad++;
    if ($4 != "candidate-ns" || $6 != "reference-ns" || $8 != "candidate-checksum" || $10 != "reference-checksum" || $5 <= 0 || $7 <= 0) bad++;
    if (lane == "PRIM") expected = prim;
    else if (lane == "DISPATCH") expected = dispatch;
    else if (lane == "STORE") expected = store;
    else if (lane == "DIV") expected = div;
    else if (lane == "THROW") expected = throwing;
    if ($9 != expected || $11 != expected || $9 != $11) bad++;
    counts[lane]++;
  }
  END {
    split("PRIM DISPATCH STORE DIV THROW", lanes, " ");
    for (i = 1; i <= 5; i++) {
      lane = lanes[i];
      if (counts[lane] != trials) bad++;
      for (trial = 0; trial < trials; trial++)
        if (!((lane SUBSEP trial) in seen)) bad++;
    }
    if (bad) exit 1;
  }
' "$WORK/perf.log"
awk -v order="$order_sequence" '
  BEGIN { next_seq = 1 }
  $2 == "BENCH_WASM_ELAPSED" {
    split($5, s, "="); seq = s[2] + 0;
    if (seq != next_seq || seen[seq]++) bad++;
    next_seq++;
    lane = $3; sub(/^lane=/, "", lane);
    member = "";
    if (lane ~ /-candidate$/) { member = "candidate"; sub(/-candidate$/, "", lane); }
    else if (lane ~ /-reference$/) { member = "reference"; sub(/-reference$/, "", lane); }
    if (lane == "primitive") lane_index = 0;
    else if (lane == "dispatch") lane_index = 1;
    else if (lane == "store") lane_index = 2;
    else if (lane == "div") lane_index = 3;
    else if (lane == "throw") lane_index = 4;
    else { bad++; next; }
    if (seq <= 10) { pos = seq - 1; first = 1; }
    else if (seq <= 320) { pos = (seq - 11) % 10; first = substr(order, int((seq - 11) / 10) + 1, 1) == "C"; }
    else { bad++; next; }
    if ((pos % 2) == 0) {
      if (first) expected_member = "candidate"; else expected_member = "reference";
    } else {
      if (first) expected_member = "reference"; else expected_member = "candidate";
    }
    expected_lane_index = int(pos / 2);
    if (lane_index != expected_lane_index || member != expected_member) bad++;
  }
  END { if (next_seq != 321 || bad) exit 1; }
' "$WORK/perf.log"

for lane in PRIM DISPATCH STORE DIV THROW; do
  case "$lane" in
    PRIM) marker_lane=primitive; oracle="$PRIM_ORACLE" ;;
    DISPATCH) marker_lane=dispatch; oracle="$DISPATCH_ORACLE" ;;
    STORE) marker_lane=store; oracle="$STORE_ORACLE" ;;
    DIV) marker_lane=div; oracle="$DIV_ORACLE" ;;
    THROW) marker_lane=throw; oracle="$THROW_ORACLE" ;;
  esac
  awk -v lane="$lane" '$1 == ("BENCH_" lane) {
      if ($9 != $11) bad++
    } END { exit bad+0 }' "$WORK/perf.log"
  [ "$(awk -v lane="${marker_lane}-candidate" '$2 == "BENCH_WASM_ELAPSED" && $3 == ("lane=" lane) { count++ } END { print count + 0 }' "$WORK/perf.log")" -eq 32 ]
  [ "$(awk -v lane="${marker_lane}-reference" '$2 == "BENCH_WASM_ELAPSED" && $3 == ("lane=" lane) { count++ } END { print count + 0 }' "$WORK/perf.log")" -eq 32 ]
  awk -v lane="${marker_lane}-candidate" -v oracle="$oracle" \
      '$2 == "BENCH_WASM_ELAPSED" && $3 == ("lane=" lane) {
         split($4, n, "="); split($6, e, "="); split($7, c, "=");
         if (n[2] == 5000000) print e[2], c[2]
       }' "$WORK/perf.log" >"$WORK/$lane.candidate.internal"
  awk -v lane="${marker_lane}-reference" -v oracle="$oracle" \
      '$2 == "BENCH_WASM_ELAPSED" && $3 == ("lane=" lane) {
         split($4, n, "="); split($6, e, "="); split($7, c, "=");
         if (n[2] == 5000000) print e[2], c[2]
       }' "$WORK/perf.log" >"$WORK/$lane.reference.internal"
  [ "$(wc -l <"$WORK/$lane.candidate.internal" | awk '{print $1}')" -eq "$TRIALS" ]
  [ "$(wc -l <"$WORK/$lane.reference.internal" | awk '{print $1}')" -eq "$TRIALS" ]
  awk -v oracle="$oracle" '{if ($1 <= 0 || $2 != oracle) bad++} END {exit bad+0}' \
      "$WORK/$lane.candidate.internal" "$WORK/$lane.reference.internal"
  awk '{print $1}' "$WORK/$lane.candidate.internal" | sort -n >"$WORK/$lane.candidate"
  awk '{print $1}' "$WORK/$lane.reference.internal" | sort -n >"$WORK/$lane.reference"
  paste "$WORK/$lane.candidate" "$WORK/$lane.reference" \
      | awk '{if ($1 <= 0 || $2 <= 0) bad++; print $1, $2, ($1 / $2)} END {exit bad+0}' \
      >"$WORK/$lane.values"
  [ "$(wc -l <"$WORK/$lane.values" | awk '{print $1}')" -eq "$TRIALS" ]
  awk '{print $3}' "$WORK/$lane.values" | sort -n >"$WORK/$lane.ratio"
  candidate_median=$(sed -n '16p' "$WORK/$lane.candidate")
  candidate_p95=$(sed -n '30p' "$WORK/$lane.candidate")
  reference_median=$(sed -n '16p' "$WORK/$lane.reference")
  reference_p95=$(sed -n '30p' "$WORK/$lane.reference")
  ratio_median=$(sed -n '16p' "$WORK/$lane.ratio")
  ratio_p95=$(sed -n '30p' "$WORK/$lane.ratio")
  awk -v lane="$lane" -v n="$TIMED_N" -v cm="$candidate_median" -v cp="$candidate_p95" \
      -v rm="$reference_median" -v rp="$reference_p95" \
      -v xm="$ratio_median" -v xp="$ratio_p95" \
      'BEGIN {
         if (xm != xm || xp != xp || xm <= 0 || xp <= 0 || xm > 2.0 || xp > 2.0) exit 1;
         printf "%s candidate-median-ns-op=%.6f candidate-p95-ns-op=%.6f ",
                lane, cm / n, cp / n;
         printf "reference-median-ns-op=%.6f reference-p95-ns-op=%.6f ",
                rm / n, rp / n;
         printf "ratio-median=%.6f ratio-p95=%.6f checksum=match\n", xm, xp;
       }'
done

"$WASM_DIS" /private/tmp/mcweb-zero-linked-benchmark.wasm -o "$WORK/benchmark.wat"
exports=$(rg -c '^[[:space:]]*\(export ' "$WORK/benchmark.wat")
imports=$(rg -c '^[[:space:]]*\(import ' "$WORK/benchmark.wat")
functions=$(rg -c '^[[:space:]]*\(func ' "$WORK/benchmark.wat")
wat_types=$(rg -c '^[[:space:]]*\(type ' "$WORK/benchmark.wat" || true)
types=$(node -e '
  const fs = require("fs");
  const b = fs.readFileSync(process.argv[1]);
  let p = 8;
  const uleb = () => { let v = 0, s = 0, x; do { x = b[p++]; v |= (x & 127) << s; s += 7; } while (x & 128); return v; };
  while (p < b.length) { const id = b[p++], size = uleb(), end = p + size; if (id === 1) { console.log(uleb()); break; } p = end; }
' /private/tmp/mcweb-zero-linked-benchmark.wasm)
[ "$exports" -eq 20 ]
[ "$imports" -eq 1 ]
[ "$functions" -eq 28 ]
[ "$types" -eq 8 ]
! rg -q 'call_indirect|unreachable' "$WORK/benchmark.wat"
rg -q 'env.*memory' "$WORK/benchmark.wat"
rg -q 'benchPrimCandidate' "$WORK/benchmark.wat"
rg -q 'benchPrimReference' "$WORK/benchmark.wat"
rg -q 'benchDispatchCandidate' "$WORK/benchmark.wat"
rg -q 'benchDispatchReference' "$WORK/benchmark.wat"
rg -q 'benchStoreCandidate' "$WORK/benchmark.wat"
rg -q 'benchStoreReference' "$WORK/benchmark.wat"
rg -q 'benchDivCandidate' "$WORK/benchmark.wat"
rg -q 'benchDivReference' "$WORK/benchmark.wat"
rg -q 'benchThrowCandidate' "$WORK/benchmark.wat"
rg -q 'benchThrowReference' "$WORK/benchmark.wat"
rg -q '\(param i32 i32\).*\(result i64\)' "$WORK/benchmark.wat"
rg -q '\(param i32 i32 i32 i32\).*\(result i64\)' "$WORK/benchmark.wat"
for edge_count in 1:1 15:1 6:2 16:1 5:1 18:1 3:1 19:1 9:1 21:1; do
  edge=${edge_count%%:*}
  expected=${edge_count#*:}
  [ "$(awk -v edge="$edge" '
      { line = $0; sub(/^[[:space:]]*/, "", line); if (line == "(call $" edge) count++ }
      END { print count + 0 }
    ' "$WORK/benchmark.wat")" -eq "$expected" ]
done

# Every relevant function body must have exactly the expected direct-call
# multiset and no other direct calls. This rejects swapped wrappers even when
# aggregate edge counts remain unchanged.
exact_direct_call() {
  wat_file=$1
  function_index=$2
  target_index=$3
  awk -v function_index="$function_index" -v target_index="$target_index" '
    $0 ~ "^[[:space:]]*\\(func \\$" function_index "[[:space:]]" { inside=1; next }
    inside && $0 ~ "^[[:space:]]*\\(func \\$" { inside=0 }
    inside {
      line=$0; sub(/^[[:space:]]*/, "", line);
      if (line ~ /^\(call \$[0-9]+([[:space:]]|$)/) {
        calls++;
        expected = "(call $" target_index;
        suffix = substr(line, length(expected) + 1, 1);
        if (substr(line, 1, length(expected)) == expected && (suffix == "" || suffix ~ /[[:space:]]/)) target_calls++;
        else unexpected++;
      }
    }
    END { exit !(calls == 1 && target_calls == 1 && unexpected == 0) }
  ' "$wat_file"
}
for edge in 1:0 15:14 10:1 11:15 12:6 13:16 22:5 23:18 24:3 25:19 26:9 27:21 5:4 18:17 9:8 21:20; do
  function_index=${edge%%:*}
  target_index=${edge#*:}
  exact_direct_call "$WORK/benchmark.wat" "$function_index" "$target_index"
done

# Every relevant target must have exactly the expected incoming caller set.
exact_incoming_callers() {
  wat_file=$1
  target_index=$2
  expected_sources=$3
  awk -v target_index="$target_index" -v expected_sources="$expected_sources" '
    BEGIN {
      expected_count = split(expected_sources, expected, " ");
      for (i = 1; i <= expected_count; i++) expected_set[expected[i]] = 1;
    }
    $0 ~ "^[[:space:]]*\\(func \\$[0-9]+[[:space:]]" {
      line=$0; sub(/^[[:space:]]*\(func \$/, "", line);
      current=line; sub(/[[:space:]].*$/, "", current); next;
    }
    current != "" {
      line=$0; sub(/^[[:space:]]*/, "", line);
      call_prefix = "(call $" target_index;
      suffix = substr(line, length(call_prefix) + 1, 1);
      if (substr(line, 1, length(call_prefix)) == call_prefix && (suffix == "" || suffix ~ /[[:space:]]/)) {
        incoming++;
        if (!expected_set[current] || actual_set[current]++) unexpected++;
      }
    }
    END {
      for (caller in expected_set) if (!actual_set[caller]) missing++;
      exit !(incoming == expected_count && missing == 0 && unexpected == 0);
    }
  ' "$wat_file"
}
for incoming in \
  '0:1' '14:15' '1:10' '15:11' '6:7 12' '16:13' '5:22' '18:23' '3:24' '19:25' \
  '9:26' '21:27' '4:5' '17:18' '8:9' '20:21'; do
  target_index=${incoming%%:*}
  expected_sources=${incoming#*:}
  exact_incoming_callers "$WORK/benchmark.wat" "$target_index" "$expected_sources"
done

# Deliberate negative: a swapped synthetic wrapper must be rejected by both
# checkers. It never mutates the real benchmark artifact.
NEGATIVE_WAT="$WORK/call-graph-negative.wat"
printf '%s\n' '(module' '  (func $1 (result i64)' '    (call $0)' '  )' '  (func $10 (result i64)' '    (call $15)' '  )' '  (func $11 (result i64)' '    (call $1)' '  )' '  (func $12 (result i64)' '    (call $0)' '  )' '  (func $15 (result i64)' '    (call $14)' '  )' > "$NEGATIVE_WAT"
if exact_direct_call "$NEGATIVE_WAT" 10 1; then
  echo 'REJECT call-graph negative accepted by per-body checker' >&2
  exit 1
fi
if exact_incoming_callers "$NEGATIVE_WAT" 1 10; then
  echo 'REJECT call-graph negative accepted by incoming-edge checker' >&2
  exit 1
fi
if exact_incoming_callers "$NEGATIVE_WAT" 0 1; then
  echo 'REJECT extra primitive leaf incoming edge was accepted' >&2
  exit 1
fi

[ "$(rg -c '^\[zbp\] BENCH_STORE_RESET lane=store-candidate reset-excluded=1 field-null=1 card-before-clean=255 field-offset=12$' "$WORK/perf.log")" -eq 32 ]
[ "$(rg -c '^\[zbp\] BENCH_STORE_RESET lane=store-reference reset-excluded=1 field-null=1 card-before-clean=255 field-offset=12$' "$WORK/perf.log")" -eq 32 ]
[ "$(rg -c '^\[zbp\] BENCH_STORE_POST lane=store-candidate child-match=1 final-tag=42 card-after-dirty=0 expected-dirty=0 field-offset=12$' "$WORK/perf.log")" -eq 32 ]
[ "$(rg -c '^\[zbp\] BENCH_STORE_POST lane=store-reference child-match=1 final-tag=42 card-after-dirty=0 expected-dirty=0 field-offset=12$' "$WORK/perf.log")" -eq 32 ]

module_sha=$(shasum -a 256 /private/tmp/mcweb-zero-linked-benchmark.wasm | awk '{print $1}')
module_size=$(wc -c < /private/tmp/mcweb-zero-linked-benchmark.wasm | awk '{print $1}')
[ "$module_size" -eq "$EXPECTED_MODULE_SIZE" ]
BENCH_CARD_LINE=$(rg '^\[zbp\] CARD_BASE live=[0-9]+ context=benchmark-store expected-occurrences=2$' \
  "$WORK/perf.log" || true)
[ "$(printf '%s\n' "$BENCH_CARD_LINE" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
  || { echo 'REJECT P1b: live card-base marker count is not one' >&2; exit 1; }
BENCH_CARD_BASE=$(printf '%s\n' "$BENCH_CARD_LINE" | sed -E 's/.*live=([0-9]+).*/\1/')
case "$BENCH_CARD_BASE" in
  ''|*[!0-9]*) echo 'REJECT P1b: live card-base marker is not unsigned decimal' >&2; exit 1 ;;
esac
"$NODE" "$RELOC_CHECKER" /private/tmp/mcweb-zero-linked-benchmark.wasm \
  "$WORK/benchmark.wat" "$BENCH_CARD_BASE" 2 "$EXPECTED_MODULE_SHA" \
  "$WORK/benchmark-canonical.wasm" benchmark >"$WORK/benchmark-relocation.log" 2>&1 \
  || { cat "$WORK/benchmark-relocation.log" >&2; echo 'REJECT P1b: benchmark relocation check failed' >&2; exit 1; }
canonical_module_sha=$(shasum -a 256 "$WORK/benchmark-canonical.wasm" | awk '{print $1}')
[ "$canonical_module_sha" = "$EXPECTED_MODULE_SHA" ] \
  || { echo "REJECT P1b: canonical module hash changed: $canonical_module_sha" >&2; exit 1; }
awk -v prim="$PRIM_ORACLE" -v dispatch="$DISPATCH_ORACLE" \
    -v store="$STORE_ORACLE" -v div="$DIV_ORACLE" -v throwing="$THROW_ORACLE" \
    -v prim_warm="$PRIM_WARM_ORACLE" -v dispatch_warm="$DISPATCH_WARM_ORACLE" \
    -v store_warm="$STORE_WARM_ORACLE" -v div_warm="$DIV_WARM_ORACLE" -v throwing_warm="$THROW_WARM_ORACLE" '
  $2 == "BENCH_ENTRY" {
    split($3, l, "="); split($4, n, "="); split($8, c, "=");
    if (n[2] == 100000) {
      if (l[2] ~ /^primitive/) expected = prim_warm;
      else if (l[2] ~ /^dispatch/) expected = dispatch_warm;
      else if (l[2] ~ /^store/) expected = store_warm;
      else if (l[2] ~ /^div/) expected = div_warm;
      else if (l[2] ~ /^throw/) expected = throwing_warm;
    } else {
      if (l[2] ~ /^primitive/) expected = prim;
      else if (l[2] ~ /^dispatch/) expected = dispatch;
      else if (l[2] ~ /^store/) expected = store;
      else if (l[2] ~ /^div/) expected = div;
      else if (l[2] ~ /^throw/) expected = throwing;
    }
    if (c[2] != expected) bad++;
    counts[l[2]]++;
  }
  END { if (counts["primitive-candidate"] != 32 || counts["primitive-reference"] != 32 ||
             counts["dispatch-candidate"] != 32 || counts["dispatch-reference"] != 32 ||
             counts["store-candidate"] != 32 || counts["store-reference"] != 32 ||
             counts["div-candidate"] != 32 || counts["div-reference"] != 32 ||
             counts["throw-candidate"] != 32 || counts["throw-reference"] != 32 || bad) exit 1; }
' "$WORK/perf.log"
printf 'checksum-oracle primitive=%s dispatch=%s store=%s div=%s throw=%s\n' \
  "$PRIM_ORACLE" "$DISPATCH_ORACLE" "$STORE_ORACLE" "$DIV_ORACLE" "$THROW_ORACLE"
printf 'module-live-sha256=%s module-size=%s card-base=%s canonical-sha256=%s execution-input=unmodified-live\n' \
  "$module_sha" "$module_size" "$BENCH_CARD_BASE" "$canonical_module_sha"
sed -n '1p' "$WORK/benchmark-relocation.log"
printf 'warmup-n=100000 timed-n=%s trials=%s order-seed=0x5eed5eed\n' "$TIMED_N" "$TRIALS"
printf 'module-types-encoded=%s wat-unique-types=%s module-exports=%s module-imports=%s module-functions=%s call-indirect=0 unreachable=0 direct-edges=10\n' "$types" "$wat_types" "$exports" "$imports" "$functions"
printf 'patch-provenance base=%s patch0013=%s patch0014=%s patch0015=%s patch0016=%s patch0017=%s patch0018=%s stack=%s reverse=0018,0017,0016,0015,0014,0013..0001\n' \
  "$EXPECTED_PREPARED_HEAD" "$EXPECTED_PATCH13_SHA" "$EXPECTED_PATCH14_SHA" \
  "$EXPECTED_PATCH15_SHA" "$EXPECTED_PATCH16_SHA" "$EXPECTED_PATCH17_SHA" \
  "$EXPECTED_PATCH18_SHA" \
  "$(printf '%s' "$PATCH_NAMES" | tr ' ' ',')"
printf 'runtime-provenance lane=%s globals=%s interpreter=%s baseline=%s clean-0017-globals=%s clean-0017-interpreter=%s clean-0017-baseline=%s clean-0018-globals=%s clean-0018-interpreter=%s clean-0018-baseline=%s\n' \
  "$LEGACY_CONTEXT" \
  "$EXPECTED_OVERLAY_GLOBALS_SHA" "$EXPECTED_OVERLAY_INTERPRETER_SHA" \
  "$EXPECTED_OVERLAY_BASELINE_SHA" "$EXPECTED_0017_GLOBALS_SHA" \
  "$EXPECTED_0017_INTERPRETER_SHA" "$EXPECTED_0017_BASELINE_SHA" \
  "$EXPECTED_0018_GLOBALS_SHA" "$EXPECTED_0018_INTERPRETER_SHA" \
  "$EXPECTED_0018_BASELINE_SHA"
printf 'ACCEPT M1-P1b synthetic emitter hot-path benchmark evidence\n'
