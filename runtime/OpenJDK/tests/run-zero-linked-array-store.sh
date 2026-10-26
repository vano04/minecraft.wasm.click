#!/bin/sh
# OSS-only M2-B real int[] store gate. The linked entry emits one guarded
# i32.store; null/OOB/linear-memory refusals resume the real Zero interpreter
# at iastore. This is not an arbitrary-JAR, browser, or Minecraft claim.
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
LOG_CHECKER="$ROOT/tests/check-zero-linked-array-store-log.mjs"
WAT_CHECKER="$ROOT/tests/check-zero-linked-array-store-wat.mjs"
RELOC_CHECKER="$ROOT/tests/check-zero-linked-array-relocation.mjs"
EXCEPTION_CLASS_CHECKER="$ROOT/tests/check-zero-linked-array-store-exception-class.mjs"
COMPANION_MANIFEST="$ROOT/tests/zero-linked-array-store-manifest.sha256"
M2A_COMPANION_MANIFEST="$ROOT/tests/zero-linked-array-manifest.sha256"
PATCH14="$ROOT/patches/0014-zero-wasm-linked-int-array-load.patch"
PATCH15="$ROOT/patches/0015-zero-wasm-linked-int-array-store.patch"
PATCH16="$ROOT/patches/0016-zero-wasm-linked-ref-array-load.patch"
PATCH17="$ROOT/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch"
PATCH18="$ROOT/patches/0018-zero-wasm-linked-ref-array-store.patch"
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-array-store.XXXXXX)
WASM_STORE=/private/tmp/mcweb-zero-linked-array-store.wasm
WASM_GROUP=/private/tmp/mcweb-zero-linked-group.wasm
WASM_BENCH=/private/tmp/mcweb-zero-linked-benchmark.wasm
ACCEPT_EVIDENCE=/private/tmp/mcweb-zero-linked-array-store-accept.txt
RUN_PID=

EXPECTED_PATCH14_SHA=8320faa76eb1288c066bbd8ae86a14333cb4737c030e683d7ec4ccabb644aa11
EXPECTED_PATCH15_SHA=9d76abe0cd8818b37089ff96386203cb9f2de3d0f6591768119c1e8213ffe2d2
EXPECTED_PATCH16_SHA=0d7c204725b28cb1824f49cc2988f86ba07fea98098dbad126c98861ddb7c7ee
EXPECTED_PATCH17_SHA=ddb93941e71c293b6b20ca2810806301aaddf046f1f0cd24d2bb21366cac96a8
EXPECTED_PATCH18_SHA=53cf9d1332f70d3f83e101ec73b5f6d3ebde7e9bb059fd8456754a3e0bcc0024
EXPECTED_STORE_SHA=2ea32239f62d07eda0f72e390b981024e920ca7272cf22503e1a9a78b0e5d138
EXPECTED_STORE_SIZE=286
EXPECTED_LOAD_SHA=afee9f6dd2ea0feeb96d8615918703ef2797b6b26e57e2a8269bd667c47750a3
EXPECTED_LOAD_SIZE=680
EXPECTED_BENCH_SHA=de66a54524031d40c5fa5abf2d4874fa8f9aace99a6b2d440b2d663fdc7dab41
EXPECTED_BENCH_SIZE=1392
EXPECTED_HEAD=6c48f4ed707bf0b15f9b6098de30db8aae6fa40f
EXPECTED_0014_GLOBALS_SHA=735562249a2c08ea8fb6d93385808b6a120c3a1e3625c75eb45c37d0ab9cbb5b
EXPECTED_0014_INTERPRETER_SHA=1ad779cc376ad368bd324546c53829c3717cb25e1b2fd6ecafc36885d66160fa
EXPECTED_0014_BASELINE_SHA=9dfbf68c352cf563842f979b18e6e4b55fc7a10218dd4ac51a8ee888467352db
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
  *) echo "REJECT M2-B linked int[] store gate: unknown legacy context: $LEGACY_CONTEXT" >&2; exit 1 ;;
esac
EXPECTED_0015_GLOBALS_SHA=194c8187621a306f76a7db4fab54c54b5a164449e413d575120385aa11b0e692
EXPECTED_0015_INTERPRETER_SHA=cea189b172c8ed050912f4ea92e4caf08268445f45a6daf2c1ce905fb5496fb5
EXPECTED_0015_BASELINE_SHA=0207ad4a93fca8352fa24f64f520484306be969605239b7eca2ffa97cc0ffa37
EXPECTED_LOCK_SHA=c6d9fcc5b201c2678e07c874cdff5d366c39b90726ae840cab69aeff19092c3f
EXPECTED_LOG_CHECKER_SHA=16b683b535579a7b26acecd7ae691f2349e42df30a25ca5a310d590cbb1e6ade
EXPECTED_WAT_CHECKER_SHA=a66f8b119c89900fb9136205bc2f5575d59d41e085039322ebdc0b9331db2adb
EXPECTED_RELOC_CHECKER_SHA=42f1e1c137f2f06dd11de9f9e6afae51bafc858973b228ada8e88761f6c18436
EXPECTED_EXCEPTION_CLASS_CHECKER_SHA=d64a3b365cbdd7da2b1345c9630249178293e5cd406620fcc865eda611ccdde7

terminate_owned_tree() {
  root=$1
  shift
  for process in "$@" "$root"; do
    kill -TERM "$process" 2>/dev/null || true
  done
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    alive=0
    for process in "$@" "$root"; do
      if kill -0 "$process" 2>/dev/null; then alive=1; fi
    done
    [ "$alive" -eq 0 ] && break
    sleep 0.05
  done
  if [ "$alive" -ne 0 ]; then
    for process in "$@" "$root"; do
      kill -KILL "$process" 2>/dev/null || true
    done
  fi
}

cleanup_store_gate() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "${RUN_PID:-}" ]; then
    terminate_owned_tree "$RUN_PID"
    RUN_PID=
  fi
  runtime_gate_lock_release 2>/dev/null || true
  case "$WORK" in
    /private/tmp/mcweb-zero-linked-array-store.??????)
      rm -rf -- "$WORK" || true
      ;;
  esac
  exit "$status"
}
trap cleanup_store_gate EXIT INT TERM
rm -f -- "$ACCEPT_EVIDENCE"

reject() {
  echo "REJECT M2-B linked int[] store gate: $*" >&2
  for name in off linked forced negative combined group-store group-load-store array-exception exception-predicate load-benchmark; do
    [ -f "$WORK/$name.log" ] && cp "$WORK/$name.log" "/private/tmp/mcweb-zero-linked-array-store-$name-failure.log" || true
  done
  exit 1
}

[ -x "$JAVAC" ] || reject "javac unavailable: $JAVAC"
[ -x "$JAR" ] || reject "jar unavailable: $JAR"
[ -x "$JAVAP" ] || reject "javap unavailable: $JAVAP"
[ -x "$WASM_DIS" ] || reject "wasm-dis unavailable: $WASM_DIS"
[ -x "$(command -v "$NODE" 2>/dev/null || true)" ] || reject "node unavailable: $NODE"
[ -x "$TIMEOUT" ] || reject "180s supervisor unavailable: $TIMEOUT"
[ -x "$RUN_JAVA" ] || reject "run-java.sh unavailable"
[ -d "$JDK/.git" ] || reject "missing prepared OpenJDK checkout"
[ -f "$PATCH14" ] || reject "missing 0014 patch"
[ -f "$PATCH15" ] || reject "missing 0015 patch"
[ -f "$PATCH16" ] || reject "missing 0016 patch"
[ -f "$PATCH17" ] || reject "missing 0017 patch"
[ -f "$PATCH18" ] || reject "missing 0018 patch"
[ -r "$LOCK_HELPER" ] || reject "runtime gate lock helper unavailable"
[ -f "$LOG_CHECKER" ] || reject "store log checker unavailable"
[ -f "$WAT_CHECKER" ] || reject "store WAT checker unavailable"
[ -f "$RELOC_CHECKER" ] || reject "array relocation checker unavailable"
[ -f "$EXCEPTION_CLASS_CHECKER" ] || reject "exception class structural checker unavailable"
[ -f "$COMPANION_MANIFEST" ] || reject "store companion manifest unavailable"
[ -f "$M2A_COMPANION_MANIFEST" ] || reject "M2-A companion manifest unavailable"
. "$LOCK_HELPER"
if [ "${MCWEB_RUNTIME_GATE_LOCK_PROBE:-0}" = 1 ]; then
  runtime_gate_lock_acquire || exit 1
  exit 0
fi
runtime_gate_lock_acquire || reject "another Zero runtime gate owns the lock"
runtime_gate_lock_self_test "$0" "$WASM_STORE" "$WASM_GROUP" "$WASM_BENCH" \
  || reject "second invocation lock self-test failed"
printf '%s\n' 'runtime-gate-lock=self-test-pass'
sh -n "$0" || reject "gate shell syntax"
sh -n "$ROOT/setup.sh" || reject "setup shell syntax"
PROVENANCE18="$ROOT/tests/check-zero-0018-legacy-provenance.sh"
[ -x "$PROVENANCE18" ] || reject "0018 provenance checker unavailable"
"$PROVENANCE18" "$ROOT" "$JDK" "$WORK/provenance-0018" \
  || reject "0018 clean/final provenance failed"

interrupt_cleanup_self_test() (
  tree_pid_file="$WORK/interrupt-tree-child.pid"
  tree_root=
  tree_child=

  # Every probe exit, including malformed/missing PID early exits, runs this
  # exact-PID cleanup. No process-name scan or system-wide kill is allowed.
  probe_cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ -n "$tree_root" ]; then
      case "$tree_child" in
        ''|*[!0-9]*) terminate_owned_tree "$tree_root" || true ;;
        *) terminate_owned_tree "$tree_root" "$tree_child" || true ;;
      esac
      wait "$tree_root" 2>/dev/null || true
    fi
    rm -f -- "$tree_pid_file"
    exit "$status"
  }
  trap probe_cleanup EXIT INT TERM

  rm -f -- "$tree_pid_file"
  # This is the real timeout -> shell launcher -> sleep topology used by the
  # gate. The launcher traps TERM and forwards it to its owned child.
  "$TIMEOUT" --signal=TERM --kill-after=1s 30 sh -c '
    pid_file=$1
    child=
    forward_term() {
      [ -n "$child" ] && kill -TERM "$child" 2>/dev/null || true
      exit 143
    }
    trap forward_term INT TERM
    sleep 30 & child=$!
    printf "%s\\n" "$child" >"$pid_file"
    wait "$child"
  ' sh "$tree_pid_file" &
  tree_root=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [ -s "$tree_pid_file" ] && break
    sleep 0.05
  done
  if [ ! -s "$tree_pid_file" ]; then exit 1; fi
  tree_child=$(sed -n '1p' "$tree_pid_file")
  case "$tree_child" in ''|*[!0-9]*) exit 1 ;; esac
  kill -0 "$tree_child" 2>/dev/null || exit 1

  # Interrupt the actual timeout supervisor, not a helper-created PID. The
  # supervisor forwards TERM through the shell launcher to the recorded child.
  kill -TERM "$tree_root" 2>/dev/null || true
  wait "$tree_root" 2>/dev/null || true
  if kill -0 "$tree_root" 2>/dev/null || kill -0 "$tree_child" 2>/dev/null; then
    exit 1
  fi
  printf 'owned-interrupt-cleanup=pass supervisor=%s launcher-child=%s forwarding=verified\n' \
    "$tree_root" "$tree_child" >"$WORK/interrupt-cleanup.txt"
  cat "$WORK/interrupt-cleanup.txt"
  exit 0
)
interrupt_cleanup_self_test || reject "owned child-tree interrupt cleanup self-test failed"

check_late_cmd_cleanup() {
  log_path=$1
  final_marker=$2
  count=$(awk -v marker="$final_marker" '
    BEGIN { marker_count=0; cleanup_count=0; bad=0; after=0 }
    $0 ~ marker { marker_count++; after=1; next }
    tolower($0) ~ /terminated worker/ {
      if (!after || $0 !~ /^received "6" command from terminated worker: [1-9][0-9]*$/) bad=1
      else cleanup_count++
    }
    END {
      if (marker_count != 1 || bad || cleanup_count > 1) exit 1
      print cleanup_count
    }
  ' "$log_path") || return 1
  printf 'pthread-teardown-race-count=%s classification=late-CMD_CLEANUP_THREAD\n' "$count"
}

pthread_teardown_parser_self_test() {
  printf 'received "6" command from terminated worker: 32\nARRAY_STORE_END\n' >"$WORK/pthread-early.log"
  if check_late_cmd_cleanup "$WORK/pthread-early.log" '^ARRAY_STORE_END$' >/dev/null 2>&1; then return 1; fi
  printf 'ARRAY_STORE_END\nreceived "5" command from terminated worker: 32\n' >"$WORK/pthread-command.log"
  if check_late_cmd_cleanup "$WORK/pthread-command.log" '^ARRAY_STORE_END$' >/dev/null 2>&1; then return 1; fi
  printf 'ARRAY_STORE_END\nreceived "6" command from terminated worker: 32\nreceived "6" command from terminated worker: 31\n' >"$WORK/pthread-duplicate.log"
  if check_late_cmd_cleanup "$WORK/pthread-duplicate.log" '^ARRAY_STORE_END$' >/dev/null 2>&1; then return 1; fi
  printf 'ARRAY_STORE_END\nreceived "6" command from terminated worker: 0\n' >"$WORK/pthread-malformed.log"
  if check_late_cmd_cleanup "$WORK/pthread-malformed.log" '^ARRAY_STORE_END$' >/dev/null 2>&1; then return 1; fi
}
pthread_teardown_parser_self_test || reject "pthread teardown parser negative was accepted"

git_safe() { git -c core.fsmonitor=false -c gc.auto=0 -c maintenance.auto=false "$@"; }
[ "$(git_safe -C "$JDK" rev-parse HEAD)" = "$EXPECTED_HEAD" ] \
  || reject "prepared JDK HEAD drift"
[ "$(shasum -a 256 "$PATCH14" | awk '{print $1}')" = "$EXPECTED_PATCH14_SHA" ] \
  || reject "0014 patch hash drift"
[ "$(shasum -a 256 "$PATCH15" | awk '{print $1}')" = "$EXPECTED_PATCH15_SHA" ] \
  || reject "0015 patch hash drift"
[ "$(shasum -a 256 "$PATCH16" | awk '{print $1}')" = "$EXPECTED_PATCH16_SHA" ] \
  || reject "0016 patch hash drift"
[ "$(shasum -a 256 "$PATCH17" | awk '{print $1}')" = "$EXPECTED_PATCH17_SHA" ] \
  || reject "0017 patch hash drift"
[ "$(shasum -a 256 "$PATCH18" | awk '{print $1}')" = "$EXPECTED_PATCH18_SHA" ] \
  || reject "0018 patch hash drift"
[ "$(rg -c '^diff --git ' "$PATCH14")" -eq 3 ] || reject "0014 path count drift"
for path_name in \
  src/hotspot/cpu/zero/globals_zero.hpp \
  src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp \
  src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp; do
  rg -q "^diff --git a/$path_name b/$path_name$" "$PATCH14" \
    || reject "0014 path allowlist drift: $path_name"
done
check_0015_payload() {
  patch_path=$1
  [ "$(rg -c '^diff --git ' "$patch_path")" -eq 3 ] || return 1
  patch_paths="$WORK/0015-paths.$$.tmp"
  expected_paths="$WORK/0015-expected.$$.tmp"
  awk '/^diff --git / { print $4 }' "$patch_path" | sed 's#^b/##' | LC_ALL=C sort -u >"$patch_paths"
  printf '%s\n' \
    src/hotspot/cpu/zero/globals_zero.hpp \
    src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp \
    src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp \
    | LC_ALL=C sort -u >"$expected_paths"
  cmp -s "$patch_paths" "$expected_paths" || return 1
  ! rg -q '^(GIT binary patch|Binary files |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )' "$patch_path"
}
check_0015_payload "$PATCH15" || reject "0015 path/mode/binary payload drift"
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
check_0016_payload() { check_0015_payload "$1"; }
check_0016_payload "$PATCH16" || reject "0016 path/mode/binary payload drift"
EXTRA_0016="$WORK/0016-extra-path.patch"
cp "$PATCH16" "$EXTRA_0016"
printf '%s\n' 'diff --git a/tests/unowned.bin b/tests/unowned.bin' >>"$EXTRA_0016"
if check_0016_payload "$EXTRA_0016"; then reject "0016 extra-path negative accepted"; fi
BINARY_0016="$WORK/0016-binary-payload.patch"
cp "$PATCH16" "$BINARY_0016"
printf '%s\n' 'GIT binary patch' >>"$BINARY_0016"
if check_0016_payload "$BINARY_0016"; then reject "0016 binary-payload negative accepted"; fi
MODE_0016="$WORK/0016-mode-payload.patch"
cp "$PATCH16" "$MODE_0016"
printf '%s\n' 'new mode 100755' >>"$MODE_0016"
if check_0016_payload "$MODE_0016"; then reject "0016 mode-change negative accepted"; fi

awk '
  /git apply.*0014-zero-wasm-linked-int-array-load\.patch/ { fourteen = NR }
  /git apply.*0015-zero-wasm-linked-int-array-store\.patch/ { fifteen = NR }
  /git apply.*0016-zero-wasm-linked-ref-array-load\.patch/ { sixteen = NR }
  /git apply.*0017-zero-wasm-linked-ref-array-load-cache-integrity\.patch/ { seventeen = NR }
  /git apply.*0018-zero-wasm-linked-ref-array-store\.patch/ { eighteen = NR }
  END { exit !(fourteen && fifteen && sixteen && seventeen && eighteen && fifteen == fourteen + 1 && sixteen == fifteen + 1 && seventeen == sixteen + 1 && eighteen == seventeen + 1) }
' "$ROOT/setup.sh" || reject "setup 0014/0015/0016/0017/0018 patch order is not atomic"
[ "$(shasum -a 256 "$JDK/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_OVERLAY_GLOBALS_SHA" ] \
  || reject "overlay globals source drift"
[ "$(shasum -a 256 "$JDK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_OVERLAY_INTERPRETER_SHA" ] \
  || reject "overlay interpreter source drift"
[ "$(shasum -a 256 "$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_OVERLAY_BASELINE_SHA" ] \
  || reject "overlay baseline source drift"
[ "$(shasum -a 256 "$LOCK_HELPER" | awk '{print $1}')" = "$EXPECTED_LOCK_SHA" ] \
  || reject "runtime lock helper drift"
[ "$(shasum -a 256 "$LOG_CHECKER" | awk '{print $1}')" = "$EXPECTED_LOG_CHECKER_SHA" ] \
  || reject "store log checker drift"
[ "$(shasum -a 256 "$WAT_CHECKER" | awk '{print $1}')" = "$EXPECTED_WAT_CHECKER_SHA" ] \
  || reject "store WAT checker drift"
[ "$(shasum -a 256 "$RELOC_CHECKER" | awk '{print $1}')" = "$EXPECTED_RELOC_CHECKER_SHA" ] \
  || reject "array relocation checker drift"
[ "$(shasum -a 256 "$EXCEPTION_CLASS_CHECKER" | awk '{print $1}')" = "$EXPECTED_EXCEPTION_CLASS_CHECKER_SHA" ] \
  || reject "exception class structural checker drift"
rg -q 'UseZeroWasmLinkedIntArrayStore' "$JDK/src/hotspot/cpu/zero/globals_zero.hpp" \
  || reject "store flag missing from prepared source"
rg -q 'build_linked_array_store_module' "$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" \
  || reject "dedicated store module builder missing"
rg -q 'kArrayStoreMemoryLimitLocal' "$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" \
  || reject "store limit local separation missing"
! rg -q 'array_store \? "int-store"|array_store \? "intArrayStore"|array_store \? 5 : 3' \
  "$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" \
  || reject "shared linked module still carries array-store plumbing"

# Reconstruct the complete public patch stack from the pinned OpenJDK base,
# bind it byte-for-byte to the prepared runtime, then reverse newest-first.
PROVENANCE="$WORK/provenance"
mkdir -p "$PROVENANCE"
git_safe -C "$JDK" archive HEAD | tar -x -C "$PROVENANCE"
git_safe -C "$PROVENANCE" init -q
git_safe -C "$PROVENANCE" add -A
git_safe -C "$PROVENANCE" -c user.name=mcweb -c user.email=mcweb@example.invalid commit -qm base
for patch_name in 0001 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018; do
  set -- "$ROOT"/patches/"$patch_name"-*.patch
  [ "$#" -eq 1 ] || reject "missing or duplicate patch $patch_name"
  git_safe -C "$PROVENANCE" apply --check "$1" || reject "forward patch failed: $patch_name"
  git_safe -C "$PROVENANCE" apply "$1"
done
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0018_GLOBALS_SHA" ] \
  || reject "clean 0018 globals reconstruction drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0018_INTERPRETER_SHA" ] \
  || reject "clean 0018 interpreter reconstruction drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0018_BASELINE_SHA" ] \
  || reject "clean 0018 baseline reconstruction drift"
git_safe -C "$PROVENANCE" apply --reverse --check "$PATCH18" || reject "0018 reverse check failed"
git_safe -C "$PROVENANCE" apply --reverse "$PATCH18" || reject "0018 reverse application failed"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0017_GLOBALS_SHA" ] \
  || reject "0018 globals preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0017_INTERPRETER_SHA" ] \
  || reject "0018 interpreter preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0017_BASELINE_SHA" ] \
  || reject "0018 baseline preimage drift"
git_safe -C "$PROVENANCE" apply --reverse --check "$PATCH17" || reject "0017 reverse check failed"
git_safe -C "$PROVENANCE" apply --reverse "$PATCH17" || reject "0017 reverse application failed"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_GLOBALS_SHA" ] \
  || reject "0017 globals preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_INTERPRETER_SHA" ] \
  || reject "0017 interpreter preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_BASELINE_SHA" ] \
  || reject "0017 baseline preimage drift"
git_safe -C "$PROVENANCE" apply --reverse --check "$PATCH16" || reject "0016 reverse check failed"
git_safe -C "$PROVENANCE" apply --reverse "$PATCH16" || reject "0016 reverse application failed"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0015_GLOBALS_SHA" ] \
  || reject "0016 globals preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0015_INTERPRETER_SHA" ] \
  || reject "0016 interpreter preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0015_BASELINE_SHA" ] \
  || reject "0016 baseline preimage drift"
git_safe -C "$PROVENANCE" apply --reverse --check "$PATCH15" || reject "0015 reverse check failed"
git_safe -C "$PROVENANCE" apply --reverse "$PATCH15" || reject "0015 reverse application failed"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0014_GLOBALS_SHA" ] \
  || reject "0015 globals preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0014_INTERPRETER_SHA" ] \
  || reject "0015 interpreter preimage drift"
[ "$(shasum -a 256 "$PROVENANCE/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0014_BASELINE_SHA" ] \
  || reject "0015 baseline preimage drift"
for patch_name in 0014 0013 0012 0011 0010 0009 0008 0007 0006 0005 0004 0003 0001; do
  set -- "$ROOT"/patches/"$patch_name"-*.patch
  git_safe -C "$PROVENANCE" apply --reverse --check "$1" || reject "reverse stack failed: $patch_name"
  git_safe -C "$PROVENANCE" apply --reverse "$1"
done
git_safe -C "$PROVENANCE" diff --quiet HEAD || reject "reverse stack did not return to clean base"

mkdir -p "$WORK/classes"
"$JAVAC" -g:none -d "$WORK/classes" \
  "$ROOT/tests/ZeroBaselineFixture.java" "$ROOT/tests/ZeroExceptionStoreNearMiss.java"
for expected in \
  ZeroBaselineFixture.class ZeroBaselineFixture\$Base.class \
  ZeroBaselineFixture\$Box.class ZeroBaselineFixture\$Good.class \
  ZeroExceptionStoreNearMiss.class \
  ZeroBaselineFixture\$InitFail.class ZeroBaselineFixture\$InitOK.class \
  ZeroBaselineFixture\$Other.class ZeroBaselineFixture\$Shape.class \
  ZeroBaselineFixture\$SubGood.class ZeroBaselineFixture\$Trace.class; do
  [ -f "$WORK/classes/$expected" ] || reject "missing dependency class $expected"
done
[ "$(find "$WORK/classes" -type f -name '*.class' | wc -l | awk '{print $1}')" -eq 11 ] \
  || reject "fixture closure is not exactly eleven classes"
"$JAVAP" -classpath "$WORK/classes" -c -p -v ZeroExceptionStoreNearMiss \
  >"$WORK/exception-store.javap" || reject "exception-table near-miss javap failed"
rg -q '^  public static int intArrayStore\(int\[\], int, int\);$' \
  "$WORK/exception-store.javap" || reject "exception-table near-miss descriptor drift"
rg -q '^      Exception table:$' "$WORK/exception-store.javap" \
  || reject "exception-table near-miss has no exception table"
rg -q 'iaload|iastore' "$WORK/exception-store.javap" \
  || reject "exception-table near-miss has no array store body"

# Isolate the exception-table predicate from holder and bytecode shape.  This
# derived class keeps the binary name ZeroBaselineFixture and the exact
# 2a,1b,1c,4f,1c,ac method body, adding only one synthetic Code exception
# entry.  The entry's handler target deliberately requires -Xverify:none;
# this lane is a classifier oracle only and is disclosed in retained evidence.
EXCEPTION_CLASSES="$WORK/exception-predicate-classes"
mkdir -p "$EXCEPTION_CLASSES"
find "$WORK/classes" -type f -name '*.class' \
  ! -name 'ZeroExceptionStoreNearMiss.class' -exec cp '{}' "$EXCEPTION_CLASSES" ';'
EXCEPTION_CLASS_A="$WORK/ZeroBaselineFixture.exception-a.class"
EXCEPTION_CLASS_B="$WORK/ZeroBaselineFixture.exception-b.class"
"$NODE" "$EXCEPTION_CLASS_CHECKER" transform \
  "$WORK/classes/ZeroBaselineFixture.class" "$EXCEPTION_CLASS_A" \
  >"$WORK/exception-class-transform-a.log" 2>&1 \
  || reject "exception predicate class transform A failed"
"$NODE" "$EXCEPTION_CLASS_CHECKER" transform \
  "$WORK/classes/ZeroBaselineFixture.class" "$EXCEPTION_CLASS_B" \
  >"$WORK/exception-class-transform-b.log" 2>&1 \
  || reject "exception predicate class transform B failed"
cmp -s "$EXCEPTION_CLASS_A" "$EXCEPTION_CLASS_B" \
  || reject "exception predicate class transform is not deterministic"
cp "$EXCEPTION_CLASS_A" "$EXCEPTION_CLASSES/ZeroBaselineFixture.class"
"$NODE" "$EXCEPTION_CLASS_CHECKER" check \
  "$WORK/classes/ZeroBaselineFixture.class" \
  "$EXCEPTION_CLASSES/ZeroBaselineFixture.class" \
  >"$WORK/exception-class-structure.log" 2>&1 \
  || reject "exception predicate class structural check failed"
if "$NODE" "$EXCEPTION_CLASS_CHECKER" check \
    "$WORK/classes/ZeroBaselineFixture.class" \
    "$WORK/classes/ZeroBaselineFixture.class" >/dev/null 2>&1; then
  reject "exception structural checker accepted missing exception metadata"
fi
EXCEPTION_CLASS_TRUNCATED="$WORK/ZeroBaselineFixture.exception-truncated.class"
EXCEPTION_CLASS_SIZE=$(wc -c < "$EXCEPTION_CLASS_A" | awk '{print $1}')
head -c $((EXCEPTION_CLASS_SIZE - 1)) "$EXCEPTION_CLASS_A" \
  >"$EXCEPTION_CLASS_TRUNCATED"
if "$NODE" "$EXCEPTION_CLASS_CHECKER" check \
    "$WORK/classes/ZeroBaselineFixture.class" \
    "$EXCEPTION_CLASS_TRUNCATED" >/dev/null 2>&1; then
  reject "exception structural checker accepted truncated candidate"
fi
[ "$(find "$EXCEPTION_CLASSES" -type f -name '*.class' | wc -l | awk '{print $1}')" -eq 10 ] \
  || reject "exception predicate closure is not exactly ten classes"
EXCEPTION_JAR_A="$WORK/exception-fixture-a.jar"
EXCEPTION_JAR_B="$WORK/exception-fixture-b.jar"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$EXCEPTION_JAR_A" \
  -C "$EXCEPTION_CLASSES" .
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$EXCEPTION_JAR_B" \
  -C "$EXCEPTION_CLASSES" .
cmp -s "$EXCEPTION_JAR_A" "$EXCEPTION_JAR_B" \
  || reject "exception predicate fixture JAR is not deterministic"
EXCEPTION_JAR_SHA=$(shasum -a 256 "$EXCEPTION_JAR_A" | awk '{print $1}')
EXCEPTION_JAR_BYTES=$(stat -f '%z' "$EXCEPTION_JAR_A")
EXCEPTION_CLASS_SHA=$(shasum -a 256 \
  "$EXCEPTION_CLASSES/ZeroBaselineFixture.class" | awk '{print $1}')
EXCEPTION_DEPS=''
for class_file in $(find "$EXCEPTION_CLASSES" -type f -name '*.class' | LC_ALL=C sort); do
  class_name=${class_file#"$EXCEPTION_CLASSES/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  EXCEPTION_DEPS="${EXCEPTION_DEPS:+$EXCEPTION_DEPS,}${class_name}=sha256:${class_hash}"
done
[ -n "$EXCEPTION_DEPS" ] || reject "empty exception predicate dependency closure"
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
BUILT_JAVA="$JDK/build/wasm-zero/jdk/bin/java"
BUILT_LIBJVM="$JDK/build/wasm-zero/jdk/lib/zero/libjvm.so"
BUILT_RAW_JS="$JDK/build/wasm-zero/jdk/bin/java-raw.js"
BUILT_RAW_WASM="$JDK/build/wasm-zero/jdk/bin/java-raw.wasm"
[ -r "$BUILT_JAVA" ] || reject "built java unavailable"
[ -r "$BUILT_LIBJVM" ] || reject "built libjvm unavailable"
[ -r "$BUILT_RAW_JS" ] || reject "built java-raw.js unavailable"
[ -r "$BUILT_RAW_WASM" ] || reject "built java-raw.wasm unavailable"
BUILT_JAVA_SHA=$(shasum -a 256 "$BUILT_JAVA" | awk '{print $1}')
BUILT_LIBJVM_SHA=$(shasum -a 256 "$BUILT_LIBJVM" | awk '{print $1}')
BUILT_RAW_JS_SHA=$(shasum -a 256 "$BUILT_RAW_JS" | awk '{print $1}')
BUILT_RAW_WASM_SHA=$(shasum -a 256 "$BUILT_RAW_WASM" | awk '{print $1}')
LAUNCHER_SHA=$(shasum -a 256 "$RUN_JAVA" | awk '{print $1}')
LOCK_SHA=$(shasum -a 256 "$LOCK_HELPER" | awk '{print $1}')
LOG_CHECKER_SHA=$(shasum -a 256 "$LOG_CHECKER" | awk '{print $1}')
WAT_CHECKER_SHA=$(shasum -a 256 "$WAT_CHECKER" | awk '{print $1}')
GATE_SHA=$(shasum -a 256 "$0" | awk '{print $1}')
DEPS=''
for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
  class_name=${class_file#"$WORK/classes/"}
  class_hash=$(shasum -a 256 "$class_file" | awk '{print $1}')
  DEPS="${DEPS:+$DEPS,}${class_name}=sha256:${class_hash}"
done
[ -n "$DEPS" ] || reject "empty fixture dependency closure"
MANIFEST_ACTUAL="$WORK/companion-manifest.actual"
NODE_RESOLVED=$(realpath "$(command -v "$NODE")")
JAVAC_RESOLVED=$(realpath "$JAVAC")
JAR_RESOLVED=$(realpath "$JAR")
JAVAP_RESOLVED=$(realpath "$JAVAP")
WASM_DIS_RESOLVED=$(realpath "$WASM_DIS")
{
  printf '%s\n' 'whole-unit-array-store-companion-manifest-v1'
  printf 'asset tests/check-zero-linked-array-store-log.mjs %s\n' "$(shasum -a 256 "$LOG_CHECKER" | awk '{print $1}')"
  printf 'asset tests/check-zero-linked-array-store-wat.mjs %s\n' "$(shasum -a 256 "$WAT_CHECKER" | awk '{print $1}')"
  printf 'asset tests/check-zero-linked-array-relocation.mjs %s\n' "$(shasum -a 256 "$RELOC_CHECKER" | awk '{print $1}')"
  printf 'asset tests/check-zero-linked-array-store-exception-class.mjs %s\n' "$(shasum -a 256 "$EXCEPTION_CLASS_CHECKER" | awk '{print $1}')"
  for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
    class_name=${class_file#"$WORK/classes/"}
    printf 'class %s %s\n' "$class_name" "$(shasum -a 256 "$class_file" | awk '{print $1}')"
  done
  printf 'fixture-jar fixture.jar %s %s\n' "$JAR_SHA" "$JAR_BYTES"
  printf 'source tests/ZeroBaselineFixture.java %s\n' "$SOURCE_SHA"
  printf 'source tests/ZeroExceptionStoreNearMiss.java %s\n' "$(shasum -a 256 "$ROOT/tests/ZeroExceptionStoreNearMiss.java" | awk '{print $1}')"
  printf 'tool javac %s %s\n' "$JAVAC_RESOLVED" "$(shasum -a 256 "$JAVAC_RESOLVED" | awk '{print $1}')"
  printf 'tool jar %s %s\n' "$JAR_RESOLVED" "$(shasum -a 256 "$JAR_RESOLVED" | awk '{print $1}')"
  printf 'tool javap %s %s\n' "$JAVAP_RESOLVED" "$(shasum -a 256 "$JAVAP_RESOLVED" | awk '{print $1}')"
  printf 'tool node %s %s\n' "$NODE_RESOLVED" "$(shasum -a 256 "$NODE_RESOLVED" | awk '{print $1}')"
  printf 'tool wasm-dis %s %s\n' "$WASM_DIS_RESOLVED" "$(shasum -a 256 "$WASM_DIS_RESOLVED" | awk '{print $1}')"
  printf 'tool launcher run-java.sh %s\n' "$(shasum -a 256 "$RUN_JAVA" | awk '{print $1}')"
} >"$MANIFEST_ACTUAL"
cmp -s "$MANIFEST_ACTUAL" "$COMPANION_MANIFEST" || reject "store companion manifest drift"
MANIFEST_NEGATIVE="$WORK/companion-manifest-negative"
cp "$COMPANION_MANIFEST" "$MANIFEST_NEGATIVE"
printf '%s\n' 'unowned negative-entry sha256' >>"$MANIFEST_NEGATIVE"
if cmp -s "$MANIFEST_ACTUAL" "$MANIFEST_NEGATIVE"; then reject "manifest negative accepted"; fi

# Verify the independent M2-A ten-class closure without folding the M2-B
# exception-table near-miss into its manifest.  The store gate owns an
# eleven-class fixture closure, while this preflight preserves the M2-A
# class/JAR identity and manifest boundary.
M2A_CLASSES="$WORK/m2a-classes"
mkdir -p "$M2A_CLASSES"
find "$WORK/classes" -type f -name '*.class' \
  ! -name 'ZeroExceptionStoreNearMiss.class' -exec cp '{}' "$M2A_CLASSES" ';'
M2A_JAR="$WORK/m2a-fixture.jar"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$M2A_JAR" -C "$M2A_CLASSES" .
M2A_JAR_SHA=$(shasum -a 256 "$M2A_JAR" | awk '{print $1}')
M2A_JAR_BYTES=$(stat -f '%z' "$M2A_JAR")
M2A_MANIFEST_ACTUAL="$WORK/m2a-companion-manifest.actual"
{
  printf '%s\n' 'whole-unit-array-companion-manifest-v2'
  printf 'asset tests/check-zero-linked-array-log.mjs %s\n' \
    "$(shasum -a 256 "$ROOT/tests/check-zero-linked-array-log.mjs" | awk '{print $1}')"
  printf 'asset tests/check-zero-linked-array-wat.mjs %s\n' \
    "$(shasum -a 256 "$ROOT/tests/check-zero-linked-array-wat.mjs" | awk '{print $1}')"
  for class_file in $(find "$M2A_CLASSES" -type f -name '*.class' | LC_ALL=C sort); do
    class_name=${class_file#"$M2A_CLASSES/"}
    printf 'class %s %s\n' "$class_name" "$(shasum -a 256 "$class_file" | awk '{print $1}')"
  done
  printf 'fixture-jar fixture.jar %s %s\n' "$M2A_JAR_SHA" "$M2A_JAR_BYTES"
  printf 'source tests/ZeroBaselineFixture.java %s\n' "$SOURCE_SHA"
  printf 'tool javac %s %s\n' "$JAVAC_RESOLVED" "$(shasum -a 256 "$JAVAC_RESOLVED" | awk '{print $1}')"
  printf 'tool jar %s %s\n' "$JAR_RESOLVED" "$(shasum -a 256 "$JAR_RESOLVED" | awk '{print $1}')"
  printf 'tool javap %s %s\n' "$JAVAP_RESOLVED" "$(shasum -a 256 "$JAVAP_RESOLVED" | awk '{print $1}')"
  printf 'tool node %s %s\n' "$NODE_RESOLVED" "$(shasum -a 256 "$NODE_RESOLVED" | awk '{print $1}')"
  printf 'tool wasm-dis %s %s\n' "$WASM_DIS_RESOLVED" "$(shasum -a 256 "$WASM_DIS_RESOLVED" | awk '{print $1}')"
  printf 'tool launcher run-java.sh %s\n' "$(shasum -a 256 "$RUN_JAVA" | awk '{print $1}')"
} >"$M2A_MANIFEST_ACTUAL"
cmp -s "$M2A_MANIFEST_ACTUAL" "$M2A_COMPANION_MANIFEST" \
  || reject "M2-A companion manifest drift"
M2A_MANIFEST_NEGATIVE="$WORK/m2a-companion-manifest-negative"
cp "$M2A_COMPANION_MANIFEST" "$M2A_MANIFEST_NEGATIVE"
printf '%s\n' 'unowned M2-A negative-entry sha256' >>"$M2A_MANIFEST_NEGATIVE"
if cmp -s "$M2A_MANIFEST_ACTUAL" "$M2A_MANIFEST_NEGATIVE"; then
  reject "M2-A companion manifest negative accepted"
fi

IALOAD_BCI=$(
  "$JAVAP" -classpath "$WORK/classes" -c -p ZeroBaselineFixture |
    awk '/public static int intArrayStore\(/ { in_store=1; next }
      in_store && /^  public static int / { exit }
      in_store && /iastore/ { sub(":", "", $1); print $1; exit }'
)
RETURN_BCI=$(
  "$JAVAP" -classpath "$WORK/classes" -c -p ZeroBaselineFixture |
    awk '/public static int intArrayStore\(/ { in_store=1; next }
      in_store && /^  public static int / { exit }
      in_store && /ireturn/ { sub(":", "", $1); print $1; exit }'
)
[ "$IALOAD_BCI" = 3 ] && [ "$RETURN_BCI" = 5 ] \
  || reject "unexpected derived intArrayStore BCIs iastore=$IALOAD_BCI return=$RETURN_BCI"

BASE_ARGS="-XX:+UnlockExperimentalVMOptions -XX:+UseSerialGC -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS -XX:+ZeroWasmLinkedGroupVerbose"
ARGS="$BASE_ARGS -XX:+UseZeroWasmLinkedIntArrayStore"
FORCED_ARGS="$ARGS -XX:ZeroWasmLinkedArrayMemoryLimitForTest=1"
GROUP_STORE_ARGS="$BASE_ARGS -XX:+UseZeroWasmLinkedGroup -XX:+UseZeroWasmLinkedIntArrayStore"
GROUP_LOAD_STORE_ARGS="$BASE_ARGS -XX:+UseZeroWasmLinkedGroup -XX:+UseZeroWasmLinkedIntArray -XX:+UseZeroWasmLinkedIntArrayStore"
EXCEPTION_ARGS="-XX:+UnlockExperimentalVMOptions -XX:+UseSerialGC -XX:ZeroWasmBaselineJarHash=$EXCEPTION_JAR_SHA -XX:ZeroWasmBaselineClassHash=$EXCEPTION_CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$EXCEPTION_DEPS -XX:+ZeroWasmLinkedGroupVerbose -XX:+UseZeroWasmLinkedIntArrayStore"
run_java_supervised() {
  log_path=$1
  shift
  "$TIMEOUT" --signal=TERM --kill-after=10s 180 "$RUN_JAVA" "$@" >"$log_path" 2>&1 &
  RUN_PID=$!
  if wait "$RUN_PID"; then status=0; else status=$?; fi
  RUN_PID=
  [ "$status" -eq 0 ] || reject "Java probe failed or exceeded 180s: $log_path status=$status"
}

rm -f "$WASM_STORE" "$WASM_GROUP" "$WASM_BENCH"
run_java_supervised "$WORK/off.log" -Xmx256m -Xms16m -XX:+UseSerialGC \
  -cp "$WORK/classes" ZeroBaselineFixture array-store
# shellcheck disable=SC2086
run_java_supervised "$WORK/linked.log" -Xmx256m -Xms16m $ARGS \
  -cp "$WORK/classes" ZeroBaselineFixture array-store
# shellcheck disable=SC2086
run_java_supervised "$WORK/forced.log" -Xmx256m -Xms16m $FORCED_ARGS \
  -cp "$WORK/classes" ZeroBaselineFixture array-store
# shellcheck disable=SC2086
run_java_supervised "$WORK/negative.log" -Xmx256m -Xms16m $ARGS \
  -cp "$WORK/classes" ZeroBaselineFixture array-negatives
# The external holder remains a separate near miss; it proves the immutable
# fixture-name boundary but does not stand in for the exception predicate.
# shellcheck disable=SC2086
run_java_supervised "$WORK/array-exception.log" -Xmx256m -Xms16m $ARGS \
  -cp "$WORK/classes" ZeroExceptionStoreNearMiss
# The derived class has the accepted holder/name/descriptor/six-byte shape and
# differs only by exception metadata. Verification is disabled solely because
# the synthetic handler target is intentionally unreachable and has no added
# handler bytecode; the structural checker proves the production code bytes
# are unchanged.
# shellcheck disable=SC2086
run_java_supervised "$WORK/exception-predicate.log" -Xmx256m -Xms16m \
  -Xverify:none $EXCEPTION_ARGS -cp "$EXCEPTION_CLASSES" \
  ZeroBaselineFixture array-store
# Both flags fail closed before either array lane can consume a slot.
COMBINED_ARGS="$ARGS -XX:+UseZeroWasmLinkedIntArray"
# shellcheck disable=SC2086
run_java_supervised "$WORK/combined.log" -Xmx256m -Xms16m $COMBINED_ARGS \
  -cp "$WORK/classes" ZeroBaselineFixture array-store
# Group + store and group + load + store are both interpreter-only.  These
# probes ensure the four-function int[] ABI cannot consume a group slot or
# broaden into Box/card/general group metadata.
# shellcheck disable=SC2086
run_java_supervised "$WORK/group-store.log" -Xmx256m -Xms16m $GROUP_STORE_ARGS \
  -cp "$WORK/classes" ZeroBaselineFixture array-store
# shellcheck disable=SC2086
run_java_supervised "$WORK/group-load-store.log" -Xmx256m -Xms16m $GROUP_LOAD_STORE_ARGS \
  -cp "$WORK/classes" ZeroBaselineFixture array-store

expected='array-store first=-2147483648 middle=42 last=2147483647 values=-2147483648,42,2147483647 null-npe=1 negative-aioobe=1 length-aioobe=1 min-index-aioobe=1 empty-aioobe=1 neighbors-unchanged=1 invalid-neighbors-unchanged=1'
for mode in off linked forced combined group-store group-load-store exception-predicate; do
  [ "$(rg '^array-store ' "$WORK/$mode.log")" = "$expected" ] \
    || reject "$mode store transcript mismatch"
  rg -q '^array-store-values 0,1,42,MIN,MAX semantics=1$' "$WORK/$mode.log" \
    || reject "$mode value probe transcript mismatch"
  rg -q '^array-store-exceptions .*java\.lang\.NullPointerException\|' "$WORK/$mode.log" \
    || reject "$mode missing exact NullPointerException"
  rg -q '^array-store-exceptions .*java\.lang\.ArrayIndexOutOfBoundsException\|' "$WORK/$mode.log" \
    || reject "$mode missing exact ArrayIndexOutOfBoundsException"
done
exceptions=$(rg '^array-store-exceptions ' "$WORK/off.log")
[ "$(rg '^array-store-exceptions ' "$WORK/linked.log")" = "$exceptions" ] \
  || reject "linked exception transcript mismatch"
[ "$(rg '^array-store-exceptions ' "$WORK/forced.log")" = "$exceptions" ] \
  || reject "forced exception transcript mismatch"
[ "$(rg '^array-store-exceptions ' "$WORK/exception-predicate.log")" = "$exceptions" ] \
  || reject "exception predicate transcript mismatch"
check_late_cmd_cleanup "$WORK/off.log" '^array-store-exceptions ' >/dev/null \
  || reject "off pthread teardown diagnostic ordering/count"
check_late_cmd_cleanup "$WORK/linked.log" '^array-store-exceptions ' >/dev/null \
  || reject "linked pthread teardown diagnostic ordering/count"
check_late_cmd_cleanup "$WORK/forced.log" '^array-store-exceptions ' >/dev/null \
  || reject "forced pthread teardown diagnostic ordering/count"
check_late_cmd_cleanup "$WORK/combined.log" '^array-store-exceptions ' >/dev/null \
  || reject "combined pthread teardown diagnostic ordering/count"
check_late_cmd_cleanup "$WORK/group-store.log" '^array-store-exceptions ' >/dev/null \
  || reject "group+store pthread teardown diagnostic ordering/count"
check_late_cmd_cleanup "$WORK/group-load-store.log" '^array-store-exceptions ' >/dev/null \
  || reject "group+load+store pthread teardown diagnostic ordering/count"
check_late_cmd_cleanup "$WORK/negative.log" '^array-negatives ' >/dev/null \
  || reject "negative pthread teardown diagnostic ordering/count"
check_late_cmd_cleanup "$WORK/array-exception.log" '^array-exception ' >/dev/null \
  || reject "external-holder near-miss pthread teardown diagnostic ordering/count"
check_late_cmd_cleanup "$WORK/exception-predicate.log" '^array-store-exceptions ' >/dev/null \
  || reject "exception predicate pthread teardown diagnostic ordering/count"

"$NODE" "$LOG_CHECKER" "$WORK/linked.log" linked >/dev/null 2>&1 \
  || reject "linked store log sequence/order failed"
"$NODE" "$LOG_CHECKER" "$WORK/forced.log" forced >/dev/null 2>&1 \
  || reject "forced store log sequence/order failed"
"$NODE" "$LOG_CHECKER" "$WORK/negative.log" negative >/dev/null 2>&1 \
  || reject "near-miss store log sequence/order failed"
"$NODE" "$LOG_CHECKER" "$WORK/combined.log" combined >/dev/null 2>&1 \
  || reject "combined fail-closed store log check failed"
"$NODE" "$LOG_CHECKER" "$WORK/group-store.log" combined >/dev/null 2>&1 \
  || reject "group+store fail-closed store log check failed"
"$NODE" "$LOG_CHECKER" "$WORK/group-load-store.log" combined >/dev/null 2>&1 \
  || reject "group+load+store fail-closed store log check failed"
"$NODE" "$LOG_CHECKER" "$WORK/exception-predicate.log" combined >/dev/null 2>&1 \
  || reject "exception predicate fail-closed store log check failed"
! rg -q 'STORE_ENTER|STORE_TABLE_CALL|STORE_STATUS|STORE_EXIT|DIRECT_STORE|STORE_OPCODE_REEXECUTE|INTERPRETER_IASTORE' "$WORK/off.log" \
  || reject "off lane unexpectedly used linked store"
! rg -q 'STORE_ENTER|STORE_TABLE_CALL|STORE_STATUS|STORE_EXIT|DIRECT_STORE|STORE_OPCODE_REEXECUTE|INTERPRETER_IASTORE' "$WORK/negative.log" \
  || reject "near-miss lane unexpectedly used linked store"
rg -q '^array-exception valid=42 invalid=-1 neighbors-unchanged=1$' "$WORK/array-exception.log" \
  || reject "external-holder near-miss semantics mismatch"
! rg -q 'JS_INSTALL array-store|JS_CACHE_HIT array-store|ARRAY_STORE_MODULE_KEY|STORE_ENTER|STORE_ADAPTER|STORE_TABLE_CALL|STORE_STATUS|STORE_EXIT|DIRECT_STORE|STORE_OPCODE_REEXECUTE|INTERPRETER_IASTORE' "$WORK/array-exception.log" \
  || reject "external-holder near-miss unexpectedly used store fast path"
EXCEPTION_CLASSIFY_LINE='[zbg] STORE_CLASSIFY holder=ZeroBaselineFixture method=intArrayStore descriptor=([III)I static=1 params=3 code-size=6 code-shape=1 exception-table=1 accepted=0 reject=exception-table'
[ "$(rg -F -x -c -- "$EXCEPTION_CLASSIFY_LINE" "$WORK/exception-predicate.log" || printf '0\n')" -eq 1 ] \
  || reject "same-holder exception predicate classifier marker missing or duplicated"
[ "$(rg -c '^\[zbg\] STORE_CLASSIFY ' "$WORK/exception-predicate.log" || printf '0\n')" -eq 1 ] \
  || reject "same-holder exception predicate emitted noncanonical classifier markers"
rg -q 'Options -Xverify:none and -noverify were deprecated' \
  "$WORK/exception-predicate.log" \
  || reject "exception predicate verifier-disabled disclosure missing"
! rg -q 'JS_INSTALL array-store|JS_CACHE_HIT array-store|ARRAY_STORE_MODULE_KEY|STORE_ENTER|STORE_ADAPTER|STORE_TABLE_CALL|STORE_STATUS|STORE_EXIT|DIRECT_STORE|STORE_OPCODE_REEXECUTE' \
  "$WORK/exception-predicate.log" \
  || reject "same-holder exception predicate unexpectedly used store fast path"
[ "$(rg -c '^\[zbg\] INTERPRETER_IASTORE seq=0 bci=3$' "$WORK/exception-predicate.log" || printf '0\n')" -eq 13 ] \
  || reject "same-holder exception predicate did not remain interpreter-only"
! rg -q '^\[zbg\] JS_INSTALL array-store ' "$WORK/combined.log" \
  || reject "load+store collision installed store module"
! rg -q '^\[zbg\] STORE_(ENTER|ADAPTER|TABLE_CALL|STATUS|EXIT)|^\[zbg\] DIRECT_STORE|^\[zbg\] STORE_OPCODE_REEXECUTE' "$WORK/combined.log" \
  || reject "load+store collision entered linked store path"
[ "$(rg -c '^\[zbg\] INTERPRETER_IASTORE seq=0 bci=3$' "$WORK/combined.log" || printf '0\n')" -eq 13 ] \
  || reject "load+store collision did not remain interpreter-only"
for combination in group-store group-load-store; do
  ! rg -q '^\[zbg\] JS_INSTALL array-store ' "$WORK/$combination.log" \
    || reject "$combination installed store module"
  ! rg -q '^\[zbg\] STORE_(ENTER|ADAPTER|TABLE_CALL|STATUS|EXIT)|^\[zbg\] DIRECT_STORE|^\[zbg\] STORE_OPCODE_REEXECUTE' "$WORK/$combination.log" \
    || reject "$combination entered linked store path"
  [ "$(rg -c '^\[zbg\] INTERPRETER_IASTORE seq=0 bci=3$' "$WORK/$combination.log" || printf '0\n')" -eq 13 ] \
    || reject "$combination did not remain interpreter-only"
done

# Bind the one install, cache hit, and module-key records to the exact
# dedicated ABI. Each missing/duplicate mutation must be rejected.
STORE_INSTALL_LINE=$(rg '^\[zbg\] JS_INSTALL array-store exports=1 slot=9913 bytes=286$' \
  "$WORK/linked.log" | head -1)
STORE_CACHE_LINE=$(rg '^\[zbg\] JS_CACHE_HIT array-store id=[1-9][0-9]* slot=9913 instance-reused=1$' \
  "$WORK/linked.log" | head -1)
STORE_KEY_LINE=$(rg '^\[zbg\] ARRAY_STORE_MODULE_KEY abi=intArrayStore:\(\[III\)I->\(i32,i32,i32,i32\)->i64 exports=1 slot=9913 length-offset=8 base-offset=12 bytes=286$' \
  "$WORK/linked.log" | head -1)
[ -n "$STORE_INSTALL_LINE" ] && [ -n "$STORE_CACHE_LINE" ] && [ -n "$STORE_KEY_LINE" ] \
  || reject "dedicated install/cache/module-key identity missing"
STORE_INSTALL_CANONICAL=$STORE_INSTALL_LINE
STORE_CACHE_CANONICAL=$STORE_CACHE_LINE
STORE_KEY_CANONICAL=$STORE_KEY_LINE
validate_store_transcript() {
  transcript=$1
  install_count=$(rg -c '^\[zbg\] JS_INSTALL array-store ' "$transcript" || printf '0\n')
  cache_count=$(rg -c '^\[zbg\] JS_CACHE_HIT array-store ' "$transcript" || printf '0\n')
  key_count=$(rg -c '^\[zbg\] ARRAY_STORE_MODULE_KEY ' "$transcript" || printf '0\n')
  [ "$install_count" -eq 1 ] || return 1
  [ "$cache_count" -eq 1 ] || return 1
  [ "$key_count" -eq 1 ] || return 1
  install_line=$(rg '^\[zbg\] JS_INSTALL array-store ' "$transcript" || true)
  cache_line=$(rg '^\[zbg\] JS_CACHE_HIT array-store ' "$transcript" || true)
  key_line=$(rg '^\[zbg\] ARRAY_STORE_MODULE_KEY ' "$transcript" || true)
  [ "$install_line" = "$STORE_INSTALL_CANONICAL" ] || return 1
  [ "$cache_line" = "$STORE_CACHE_CANONICAL" ] || return 1
  [ "$key_line" = "$STORE_KEY_CANONICAL" ] || return 1
  [ "$(rg -F -x -c -- "$STORE_INSTALL_CANONICAL" "$transcript" || printf '0\n')" -eq 1 ] || return 1
  [ "$(rg -F -x -c -- "$STORE_CACHE_CANONICAL" "$transcript" || printf '0\n')" -eq 1 ] || return 1
  [ "$(rg -F -x -c -- "$STORE_KEY_CANONICAL" "$transcript" || printf '0\n')" -eq 1 ] || return 1
}
validate_store_transcript "$WORK/linked.log" \
  || reject "dedicated install/cache/module-key transcript is not canonical"
for identity in install cache key; do
  case "$identity" in
    install) prefix='^\[zbg\] JS_INSTALL array-store ' ;;
    cache) prefix='^\[zbg\] JS_CACHE_HIT array-store ' ;;
    key) prefix='^\[zbg\] ARRAY_STORE_MODULE_KEY ' ;;
  esac
  rg -v "$prefix" "$WORK/linked.log" >"$WORK/linked-$identity-missing.log" || true
  if validate_store_transcript "$WORK/linked-$identity-missing.log"; then
    reject "missing dedicated $identity marker accepted"
  fi
  cp "$WORK/linked.log" "$WORK/linked-$identity-duplicate.log"
  case "$identity" in
    install) printf '%s\n' "$STORE_INSTALL_CANONICAL" >>"$WORK/linked-$identity-duplicate.log" ;;
    cache) printf '%s\n' "$STORE_CACHE_CANONICAL" >>"$WORK/linked-$identity-duplicate.log" ;;
    key) printf '%s\n' "$STORE_KEY_CANONICAL" >>"$WORK/linked-$identity-duplicate.log" ;;
  esac
  if validate_store_transcript "$WORK/linked-$identity-duplicate.log"; then
    reject "duplicate dedicated $identity marker accepted"
  fi
done
sed 's/slot=9913/slot=9914/' "$WORK/linked.log" \
  >"$WORK/linked-noncanonical-identity.log"
if validate_store_transcript "$WORK/linked-noncanonical-identity.log"; then
  reject "noncanonical dedicated identity marker accepted"
fi

expect_log_reject() {
  label=$1
  path=$2
  if "$NODE" "$LOG_CHECKER" "$path" linked >/dev/null 2>&1; then
    reject "log checker accepted altered $label"
  fi
}
sed -E 's/(STORE_ADAPTER seq=1 [^ ]+ index=0 value=)-2147483648( length=3)/\1-2147483647\2/' \
  "$WORK/linked.log" >"$WORK/linked-altered-adapter.log"
expect_log_reject "adapter value" "$WORK/linked-altered-adapter.log"
sed 's/limit-pages=0$/limit-pages=9/' "$WORK/linked.log" \
  >"$WORK/linked-altered-limit.log"
expect_log_reject "table/status limit" "$WORK/linked-altered-limit.log"
sed 's/STORE_STATUS seq=1 status=0 bci=0 value=-2147483648/STORE_STATUS seq=1 status=0 bci=3 value=-2147483648/' \
  "$WORK/linked.log" >"$WORK/linked-wrong-bci.log"
expect_log_reject "return BCI" "$WORK/linked-wrong-bci.log"

# The exact sequence and result values are checked by the Node log checker;
# these independent counts make a missing marker or duplicate interpreter
# execution fail closed in the shell gate as well.
[ "$(rg -c '^\[zbg\] DIRECT_STORE intArrayStore runtime=1 seq=[0-9][0-9]* result=-?[0-9]' "$WORK/linked.log" || printf '0\n')" -eq 8 ] \
  || reject "linked direct store count is not eight"
[ "$(rg -c '^\[zbg\] STORE_OPCODE_REEXECUTE seq=[0-9][0-9]* reason=.* resume-bci=3 depth=3 pending=0$' "$WORK/linked.log" || printf '0\n')" -eq 5 ] \
  || reject "linked fallback count is not five"
[ "$(rg -c '^\[zbg\] INTERPRETER_IASTORE seq=[0-9][0-9]* bci=3$' "$WORK/linked.log" || printf '0\n')" -eq 5 ] \
  || reject "linked interpreter iastore count is not five"
[ "$(rg -c '^\[zbg\] DIRECT_STORE ' "$WORK/forced.log" || printf '0\n')" -eq 0 ] \
  || reject "forced-memory lane unexpectedly direct-stored"
[ "$(rg -c '^\[zbg\] STORE_OPCODE_REEXECUTE seq=[0-9][0-9]* reason=.* resume-bci=3 depth=3 pending=0$' "$WORK/forced.log" || printf '0\n')" -eq 13 ] \
  || reject "forced-memory lane did not reexecute all thirteen stores"
[ "$(rg -c '^\[zbg\] INTERPRETER_IASTORE seq=[0-9][0-9]* bci=3$' "$WORK/forced.log" || printf '0\n')" -eq 13 ] \
  || reject "forced-memory lane did not interpret all thirteen stores"
[ "$(rg -c '^\[zbg\] STORE_OPCODE_REEXECUTE seq=[0-9][0-9]* reason=memory ' "$WORK/forced.log" || printf '0\n')" -eq 8 ] \
  || reject "forced-memory valid stores missing eight memory refusals"
for marker in STORE_ENTER STORE_STATUS STORE_EXIT; do
  [ "$(rg -c "^\\[zbg\\] $marker seq=[0-9][0-9]* " "$WORK/linked.log" || printf '0\n')" -eq 13 ] \
    || reject "linked marker count $marker is not thirteen"
done
[ "$(rg -c '^\[zbg\] STORE_STATUS seq=[0-9][0-9]* status=0 bci=0 ' "$WORK/linked.log" || printf '0\n')" -eq 8 ] \
  || reject "linked return status count is not eight"
[ "$(rg -c '^\[zbg\] STORE_STATUS seq=[0-9][0-9]* status=3 bci=3 ' "$WORK/linked.log" || printf '0\n')" -eq 5 ] \
  || reject "linked reexecute status count is not five"
rg -q '^\[zbg\] STORE_ENTER seq=[0-9][0-9]* method=intArrayStore static=1 params=3 raw32=1 exact-klass=intArrayKlass length-offset=[0-9][0-9]* base-offset=[0-9][0-9]* limit-pages=0 slot=9913$' "$WORK/linked.log" \
  || reject "linked store ABI/layout marker incomplete"
rg -q '^\[zbg\] STORE_ENTER seq=[0-9][0-9]* method=intArrayStore static=1 params=3 raw32=1 exact-klass=intArrayKlass length-offset=[0-9][0-9]* base-offset=[0-9][0-9]* limit-pages=1 slot=9913$' "$WORK/forced.log" \
  || reject "forced store ABI/layout marker incomplete"
rg -q '^\[zbg\] JS_CACHE_HIT array-store id=[1-9][0-9]* slot=9913 instance-reused=1$' "$WORK/linked.log" \
  || reject "store cache hit did not reuse exact instance/slot"
! rg -q '^\[zbg\] ARRAY_STORE_CACHE_REJECT ' "$WORK/linked.log" \
  || reject "store cache hit identity check rejected"
! rg -q 'CALL MISMATCH|PUSH_REJECT|RESUME_REJECT|pending=1|install failed|wasm trap|unreachable|FATAL' "$WORK/linked.log" \
  || reject "linked runtime failure marker present"
! rg -q 'CALL MISMATCH|PUSH_REJECT|RESUME_REJECT|pending=1|install failed|wasm trap|unreachable|FATAL' "$WORK/forced.log" \
  || reject "forced runtime failure marker present"
if awk '/STORE_ENTER / { inside=1; next } /STORE_EXIT / { inside=0; next } inside && tolower($0) ~ /safepoint/ { bad=1 } END { exit bad ? 1 : 0 }' "$WORK/linked.log"; then :; else reject "safepoint observed inside linked store interval"; fi
if awk '/STORE_ENTER / { inside=1; next } /STORE_EXIT / { inside=0; next } inside && tolower($0) ~ /safepoint/ { bad=1 } END { exit bad ? 1 : 0 }' "$WORK/forced.log"; then :; else reject "safepoint observed inside forced store interval"; fi

NEGATIVE_EXPECTED='array-negatives descriptor 42 owner 42 baload 7 aaload 8 store-descriptor 9 store-owner 7 store-baload 7 store-aastore 8 store-altered 10'
[ "$(rg '^array-negatives ' "$WORK/negative.log")" = "$NEGATIVE_EXPECTED" ] \
  || reject "near-miss descriptor/owner/byte/object transcript mismatch"

[ -s "$WASM_STORE" ] || reject "dedicated store module dump missing"
STORE_SIZE=$(wc -c < "$WASM_STORE" | awk '{print $1}')
STORE_SHA=$(shasum -a 256 "$WASM_STORE" | awk '{print $1}')
[ "$STORE_SIZE" -eq "$EXPECTED_STORE_SIZE" ] && [ "$STORE_SHA" = "$EXPECTED_STORE_SHA" ] \
  || reject "dedicated store module changed sha=$STORE_SHA bytes=$STORE_SIZE"
"$WASM_DIS" "$WASM_STORE" -o "$WORK/store.wat" || reject "store wasm-dis failed"
"$NODE" "$WAT_CHECKER" "$WASM_STORE" "$WORK/store.wat" >"$WORK/store-shape.log" 2>&1 \
  || reject "store WAT/actual-byte checker failed"
head -c $((STORE_SIZE - 1)) "$WASM_STORE" >"$WORK/store-truncated.wasm"
if "$NODE" "$WAT_CHECKER" "$WORK/store-truncated.wasm" "$WORK/store.wat" >/dev/null 2>&1; then
  reject "truncated actual store bytes were accepted"
fi

# Fresh M2-A and P1 artifacts are regenerated in one process and pinned here
# to prove that adding the separate store module did not alter either module.
rm -f "$WASM_GROUP" "$WASM_BENCH"
# shellcheck disable=SC2086
run_java_supervised "$WORK/load-benchmark.log" -Xmx256m -Xms16m $BASE_ARGS \
  -XX:+UseZeroWasmLinkedIntArray -XX:+UseZeroWasmLinkedBenchmark \
  -cp "$WORK/classes" ZeroBaselineFixture array-benchmark
[ -s "$WASM_GROUP" ] || reject "M2-A load module dump missing"
[ -s "$WASM_BENCH" ] || reject "P1 benchmark module dump missing"
LOAD_SIZE=$(wc -c < "$WASM_GROUP" | awk '{print $1}')
LOAD_SHA=$(shasum -a 256 "$WASM_GROUP" | awk '{print $1}')
BENCH_SIZE=$(wc -c < "$WASM_BENCH" | awk '{print $1}')
BENCH_SHA=$(shasum -a 256 "$WASM_BENCH" | awk '{print $1}')
[ "$LOAD_SIZE" -eq "$EXPECTED_LOAD_SIZE" ] \
  || reject "M2-A load artifact changed bytes=$LOAD_SIZE expected=$EXPECTED_LOAD_SIZE"
[ "$BENCH_SIZE" -eq "$EXPECTED_BENCH_SIZE" ] \
  || reject "P1 benchmark artifact changed bytes=$BENCH_SIZE expected=$EXPECTED_BENCH_SIZE"
"$WASM_DIS" "$WASM_GROUP" -o "$WORK/load.wat" || reject "load wasm-dis failed"
"$WASM_DIS" "$WASM_BENCH" -o "$WORK/benchmark.wat" || reject "benchmark wasm-dis failed"
[ "$(rg -c '^[[:space:]]*\(export ' "$WORK/load.wat" || printf '0\n')" -eq 11 ] \
  || reject "M2-A load export count changed"
[ "$(rg -c '^[[:space:]]*\(func \$' "$WORK/load.wat" || printf '0\n')" -eq 11 ] \
  || reject "M2-A load function count changed"
[ "$(rg -c '^[[:space:]]*\(export ' "$WORK/benchmark.wat" || printf '0\n')" -eq 20 ] \
  || reject "P1 benchmark export count changed"
[ "$(rg -c '^[[:space:]]*\(func \$' "$WORK/benchmark.wat" || printf '0\n')" -eq 28 ] \
  || reject "P1 benchmark function count changed"
GROUP_CARD_LINE=$(rg '^\[zbg\] CARD_BASE live=[0-9]+ context=group-store-child expected-occurrences=1$' \
  "$WORK/load-benchmark.log" || true)
BENCH_CARD_LINE=$(rg '^\[zbp\] CARD_BASE live=[0-9]+ context=benchmark-store expected-occurrences=2$' \
  "$WORK/load-benchmark.log" || true)
[ "$(printf '%s\n' "$GROUP_CARD_LINE" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
  || reject "M2-A live card-base marker count is not one"
[ "$(printf '%s\n' "$BENCH_CARD_LINE" | sed '/^$/d' | wc -l | awk '{print $1}')" -eq 1 ] \
  || reject "P1 live card-base marker count is not one"
LOAD_CARD_BASE=$(printf '%s\n' "$GROUP_CARD_LINE" | sed -E 's/.*live=([0-9]+).*/\1/')
BENCH_CARD_BASE=$(printf '%s\n' "$BENCH_CARD_LINE" | sed -E 's/.*live=([0-9]+).*/\1/')
case "$LOAD_CARD_BASE:$BENCH_CARD_BASE" in
  ''|*[!0-9:]*) reject "live card-base marker is not unsigned decimal" ;;
esac
[ "$LOAD_CARD_BASE" = "$BENCH_CARD_BASE" ] \
  || reject "M2-A/P1 live card-base differs load=$LOAD_CARD_BASE benchmark=$BENCH_CARD_BASE"
"$NODE" "$RELOC_CHECKER" "$WASM_GROUP" "$WORK/load.wat" "$LOAD_CARD_BASE" 1 \
  "$EXPECTED_LOAD_SHA" "$WORK/load-canonical.wasm" load \
  >"$WORK/load-relocation.log" 2>&1 \
  || reject "M2-A live card-base relocation check failed"
"$NODE" "$RELOC_CHECKER" "$WASM_BENCH" "$WORK/benchmark.wat" "$BENCH_CARD_BASE" 2 \
  "$EXPECTED_BENCH_SHA" "$WORK/benchmark-canonical.wasm" benchmark \
  >"$WORK/benchmark-relocation.log" 2>&1 \
  || reject "P1 live card-base relocation check failed"
LOAD_CANONICAL_SHA=$(shasum -a 256 "$WORK/load-canonical.wasm" | awk '{print $1}')
BENCH_CANONICAL_SHA=$(shasum -a 256 "$WORK/benchmark-canonical.wasm" | awk '{print $1}')
[ "$LOAD_CANONICAL_SHA" = "$EXPECTED_LOAD_SHA" ] \
  || reject "M2-A canonical relocation hash changed sha=$LOAD_CANONICAL_SHA"
[ "$BENCH_CANONICAL_SHA" = "$EXPECTED_BENCH_SHA" ] \
  || reject "P1 canonical relocation hash changed sha=$BENCH_CANONICAL_SHA"
COMBINED_RESULT_LINE=$(rg '^COMBINED_RESULT array-and-benchmark [0-9]+$' \
  "$WORK/load-benchmark.log" || true)
[ "$COMBINED_RESULT_LINE" = 'COMBINED_RESULT array-and-benchmark 1411965408' ] \
  || reject "P1 combined result mismatch: $COMBINED_RESULT_LINE"
check_late_cmd_cleanup "$WORK/load-benchmark.log" '^COMBINED_RESULT array-and-benchmark ' >/dev/null \
  || reject "P1 pthread teardown diagnostic ordering/count"

{
  echo "derived-intArrayStore-iastore-bci=$IALOAD_BCI return-bci=$RETURN_BCI"
  echo "store-module-export-count=1 direct-stores=8 opcode-reexec=5 interpreter-iastore=5 forced-memory-reexec=13"
  echo "store-memory-size-guard=present call-free=present real-heap-mutation=present"
  echo "execution-input=class-directory"
  echo "fixture-jar=deterministic provenance/cache identity only; not JAR execution"
  echo "m2a-manifest=verified class-count=10 fixture-jar-sha=$M2A_JAR_SHA fixture-jar-bytes=$M2A_JAR_BYTES"
  echo "store-provenance source-sha=$SOURCE_SHA near-miss-source-sha=$(shasum -a 256 "$ROOT/tests/ZeroExceptionStoreNearMiss.java" | awk '{print $1}') fixture-jar-sha=$JAR_SHA class-sha=$CLASS_SHA wasm-sha=$STORE_SHA wasm-bytes=$STORE_SIZE"
  echo "external-holder-near-miss=verified holder=ZeroExceptionStoreNearMiss purpose=holder-boundary not-exception-predicate-proof"
  echo "same-holder-exception-predicate=verified holder=ZeroBaselineFixture descriptor=([III)I code=2a1b1c4f1cac verifier=-Xverify:none test-only-unreachable-synthetic-handler=1 class-sha=$EXCEPTION_CLASS_SHA fixture-jar-sha=$EXCEPTION_JAR_SHA fixture-jar-bytes=$EXCEPTION_JAR_BYTES interpreter-iastore=13"
  sed -n '1p' "$WORK/exception-class-structure.log"
  echo "$EXCEPTION_CLASSIFY_LINE"
  echo "patch-provenance base=$EXPECTED_HEAD patch0014=$EXPECTED_PATCH14_SHA patch0015=$EXPECTED_PATCH15_SHA patch0016=$EXPECTED_PATCH16_SHA patch0017=$EXPECTED_PATCH17_SHA patch0018=$EXPECTED_PATCH18_SHA forward-tail=0014,0015,0016,0017,0018 reverse-head=0018,0017,0016,0015,0014 paths-0018=3 mode-changes=0 binary-payloads=0"
  echo "runtime-provenance lane=$LEGACY_CONTEXT jdk-head=$EXPECTED_HEAD globals=$EXPECTED_OVERLAY_GLOBALS_SHA interpreter=$EXPECTED_OVERLAY_INTERPRETER_SHA baseline=$EXPECTED_OVERLAY_BASELINE_SHA clean-0017-globals=$EXPECTED_0017_GLOBALS_SHA clean-0017-interpreter=$EXPECTED_0017_INTERPRETER_SHA clean-0017-baseline=$EXPECTED_0017_BASELINE_SHA clean-0018-globals=$EXPECTED_0018_GLOBALS_SHA clean-0018-interpreter=$EXPECTED_0018_INTERPRETER_SHA clean-0018-baseline=$EXPECTED_0018_BASELINE_SHA built-java=$BUILT_JAVA_SHA built-libjvm=$BUILT_LIBJVM_SHA java-raw-js=$BUILT_RAW_JS_SHA java-raw-wasm=$BUILT_RAW_WASM_SHA launcher=$LAUNCHER_SHA lock=$LOCK_SHA log-checker=$LOG_CHECKER_SHA wat-checker=$WAT_CHECKER_SHA relocation-checker=$EXPECTED_RELOC_CHECKER_SHA exception-class-checker=$EXPECTED_EXCEPTION_CLASS_CHECKER_SHA gate=$GATE_SHA"
  echo "preserved-m2a-load-live-sha=$LOAD_SHA load-bytes=$LOAD_SIZE card-base=$LOAD_CARD_BASE canonical-sha=$LOAD_CANONICAL_SHA"
  echo "preserved-p1-benchmark-live-sha=$BENCH_SHA benchmark-bytes=$BENCH_SIZE card-base=$BENCH_CARD_BASE canonical-sha=$BENCH_CANONICAL_SHA"
  echo "$COMBINED_RESULT_LINE"
  sed -n '1p' "$WORK/load-relocation.log"
  sed -n '1p' "$WORK/benchmark-relocation.log"
  sed -n '1p' "$WORK/interrupt-cleanup.txt"
  echo "store-transcript-install=$STORE_INSTALL_CANONICAL"
  echo "store-transcript-cache=$STORE_CACHE_CANONICAL"
  echo "store-transcript-key=$STORE_KEY_CANONICAL"
  sed -n '1,10p' "$WORK/store-shape.log"
  echo "ACCEPT M2-B int[] store linked-success plus canonical fallback slice"
} >"$WORK/accept.evidence.tmp"
mv -f -- "$WORK/accept.evidence.tmp" "$ACCEPT_EVIDENCE"
cat "$ACCEPT_EVIDENCE"
EVIDENCE_SHA=$(shasum -a 256 "$ACCEPT_EVIDENCE" | awk '{print $1}')
EVIDENCE_BYTES=$(stat -f '%z' "$ACCEPT_EVIDENCE")
echo "accept-evidence=$ACCEPT_EVIDENCE sha=$EVIDENCE_SHA bytes=$EVIDENCE_BYTES"
