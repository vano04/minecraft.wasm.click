#!/bin/sh
# Shared provenance preflight for retained OSS semantic gates. Clean 0018 is
# always reconstructed and proved. The executing overlay defaults to final
# 0018; the final 0019 producer must opt its children into final 0019 exactly.
set -eu

ROOT=${1:?usage: check-zero-0018-legacy-provenance.sh ROOT JDK [OUTPUT]}
JDK=${2:?usage: check-zero-0018-legacy-provenance.sh ROOT JDK [OUTPUT]}
OUTPUT=${3:-}
PATCH18="$ROOT/patches/0018-zero-wasm-linked-ref-array-store.patch"
PATCH19="$ROOT/patches/0019-zero-wasm-reference-store-group.patch"
LEGACY_CONTEXT=${MCWEB_ZERO_LEGACY_PROVENANCE_CONTEXT:-final-0018}
EXPECTED_HEAD=6c48f4ed707bf0b15f9b6098de30db8aae6fa40f
EXPECTED_PATCH18_SHA=53cf9d1332f70d3f83e101ec73b5f6d3ebde7e9bb059fd8456754a3e0bcc0024
EXPECTED_PATCH19_SHA=983ed617633fbf9b2635a3a175dfbf96850c72412388f3fb6474e9364e935905
EXPECTED_0018_GLOBALS_SHA=6c8ac8a604881191755b876c9cfad596948dcf22642a6af1ea5d7c72e6fdbc27
EXPECTED_0018_INTERPRETER_SHA=e54f7456695ea2fab786a439da94d27ba94e41574f9fea15fb84def6a3ab04a1
EXPECTED_0018_BASELINE_SHA=892cb9d63b3909d8acb933cd8849c9b9caeef17353ad0d655d3822737abb4733
EXPECTED_0019_GLOBALS_SHA=bd76b9d3df38fc45892a45b9ebb5d54b1d5fb8fec5917a47929ef8e634082265
EXPECTED_0019_INTERPRETER_SHA=08e457e0a1551d8f3c3c16b0b4aa1f2608f630babe3ccd54f3e1fba316fc3676
EXPECTED_0019_BASELINE_SHA=d2276be03aa03375fa59e9ccae10fee21b65f63d30c509f9fdfcbac349573420
PATCH_NAMES="0001 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018"

reject() {
  echo "REJECT 0018 legacy provenance: $*" >&2
  exit 1
}

select_context() {
  case "$1" in
    final-0018)
      OVERLAY_GLOBALS_SHA=$EXPECTED_0018_GLOBALS_SHA
      OVERLAY_INTERPRETER_SHA=$EXPECTED_0018_INTERPRETER_SHA
      OVERLAY_BASELINE_SHA=$EXPECTED_0018_BASELINE_SHA
      OVERLAY_PATCH=$PATCH18
      ;;
    final-0019)
      OVERLAY_GLOBALS_SHA=$EXPECTED_0019_GLOBALS_SHA
      OVERLAY_INTERPRETER_SHA=$EXPECTED_0019_INTERPRETER_SHA
      OVERLAY_BASELINE_SHA=$EXPECTED_0019_BASELINE_SHA
      OVERLAY_PATCH=$PATCH19
      ;;
    *) return 1 ;;
  esac
}

check_overlay_hashes() {
  source_root=$1
  context=$2
  select_context "$context" || return 1
  [ "$(shasum -a 256 "$source_root/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$OVERLAY_GLOBALS_SHA" ] \
    && [ "$(shasum -a 256 "$source_root/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$OVERLAY_INTERPRETER_SHA" ] \
    && [ "$(shasum -a 256 "$source_root/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$OVERLAY_BASELINE_SHA" ]
}

check_clean_0018_hashes() {
  source_root=$1
  [ "$(shasum -a 256 "$source_root/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0018_GLOBALS_SHA" ] \
    && [ "$(shasum -a 256 "$source_root/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0018_INTERPRETER_SHA" ] \
    && [ "$(shasum -a 256 "$source_root/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0018_BASELINE_SHA" ]
}

check_0018_payload() {
  candidate=$1
  [ "$(rg -c '^diff --git ' "$candidate")" -eq 3 ] || return 1
  awk '/^diff --git / { print $4 }' "$candidate" | sed 's#^b/##' \
    | LC_ALL=C sort >"$PAYLOAD_WORK/paths.actual"
  printf '%s\n' \
    src/hotspot/cpu/zero/globals_zero.hpp \
    src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp \
    src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp \
    >"$PAYLOAD_WORK/paths.expected"
  cmp -s "$PAYLOAD_WORK/paths.actual" "$PAYLOAD_WORK/paths.expected" || return 1
  ! rg -q '^(GIT binary patch|Binary files |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )' \
    "$candidate"
}

[ -d "$JDK/.git" ] || reject "prepared OpenJDK checkout unavailable"
[ -f "$PATCH18" ] || reject "0018 patch unavailable"
select_context "$LEGACY_CONTEXT" || reject "unknown legacy context: $LEGACY_CONTEXT"
[ "$(git -c core.fsmonitor=false -C "$JDK" rev-parse HEAD)" = "$EXPECTED_HEAD" ] \
  || reject "OpenJDK base HEAD drift"
PAYLOAD_WORK=$(mktemp -d "${TMPDIR:-/tmp}/mcweb-zero-0018-payload.XXXXXX")
trap 'rm -rf -- "$PAYLOAD_WORK"' EXIT HUP INT TERM
[ "$(shasum -a 256 "$PATCH18" | awk '{print $1}')" = "$EXPECTED_PATCH18_SHA" ] \
  || reject "0018 patch hash drift"
check_0018_payload "$PATCH18" || reject "0018 path/mode/binary payload drift"
if [ "$LEGACY_CONTEXT" = final-0019 ]; then
  [ -f "$PATCH19" ] || reject "0019 overlay patch unavailable"
  [ "$(shasum -a 256 "$PATCH19" | awk '{print $1}')" = "$EXPECTED_PATCH19_SHA" ] \
    || reject "0019 overlay patch hash drift"
  check_0018_payload "$PATCH19" || reject "0019 overlay path/mode/binary payload drift"
fi
cp "$PATCH18" "$PAYLOAD_WORK/extra.patch"
printf '%s\n' 'diff --git a/tests/unowned.bin b/tests/unowned.bin' >>"$PAYLOAD_WORK/extra.patch"
if check_0018_payload "$PAYLOAD_WORK/extra.patch"; then reject "0018 extra-path negative accepted"; fi
cp "$PATCH18" "$PAYLOAD_WORK/binary.patch"
printf '%s\n' 'GIT binary patch' >>"$PAYLOAD_WORK/binary.patch"
if check_0018_payload "$PAYLOAD_WORK/binary.patch"; then reject "0018 binary negative accepted"; fi
cp "$PATCH18" "$PAYLOAD_WORK/mode.patch"
printf '%s\n' 'new mode 100755' >>"$PAYLOAD_WORK/mode.patch"
if check_0018_payload "$PAYLOAD_WORK/mode.patch"; then reject "0018 mode negative accepted"; fi
awk '
  /git apply.*0017-zero-wasm-linked-ref-array-load-cache-integrity\.patch/ { seventeen = NR; seventeen_count++ }
  /git apply.*0018-zero-wasm-linked-ref-array-store\.patch/ { eighteen = NR; eighteen_count++ }
  END { exit !(seventeen_count == 1 && eighteen_count == 1 && eighteen == seventeen + 1) }
' "$ROOT/setup.sh" || reject "setup 0017/0018 order drift"
if [ "$LEGACY_CONTEXT" = final-0019 ]; then
  awk '
    /git apply.*0018-zero-wasm-linked-ref-array-store\.patch/ { eighteen = NR; eighteen_count++ }
    /git apply.*0019-zero-wasm-reference-store-group\.patch/ { nineteen = NR; nineteen_count++ }
    END { exit !(eighteen_count == 1 && nineteen_count == 1 && nineteen == eighteen + 1) }
  ' "$ROOT/setup.sh" || reject "setup 0018/0019 order drift"
fi
check_overlay_hashes "$JDK" "$LEGACY_CONTEXT" \
  || reject "executing source hash drift for context $LEGACY_CONTEXT"
git -c core.fsmonitor=false -C "$JDK" apply --reverse --check "$OVERLAY_PATCH" \
  || reject "executing source does not contain exact $LEGACY_CONTEXT hunk"

if [ -n "$OUTPUT" ]; then
  mkdir -p "$OUTPUT"
  [ -z "$(find "$OUTPUT" -mindepth 1 -print -quit)" ] \
    || reject "materialization output is not empty"
  CLEAN_0018=$OUTPUT
else
  CLEAN_0018=$PAYLOAD_WORK/clean-0018
fi
mkdir -p "$CLEAN_0018"
  UNION="$CLEAN_0018/.patch-union"
  : >"$UNION"
  for patch_name in $PATCH_NAMES; do
    set -- "$ROOT"/patches/"$patch_name"-*.patch
    [ "$#" -eq 1 ] && [ -f "$1" ] || reject "missing or duplicate patch $patch_name"
    awk '/^diff --git / { print $4 }' "$1" | sed 's#^b/##' >>"$UNION"
  done
  LC_ALL=C sort -u "$UNION" -o "$UNION"
  while IFS= read -r file_path; do
    if git -c core.fsmonitor=false -C "$JDK" cat-file -e "HEAD:$file_path" 2>/dev/null; then
      mkdir -p "$CLEAN_0018/$(dirname "$file_path")"
      git -c core.fsmonitor=false -C "$JDK" show "HEAD:$file_path" >"$CLEAN_0018/$file_path"
    fi
  done <"$UNION"
  rm -f -- "$UNION"
  git -C "$CLEAN_0018" init -q
  for patch_name in $PATCH_NAMES; do
    set -- "$ROOT"/patches/"$patch_name"-*.patch
    git -c core.fsmonitor=false -C "$CLEAN_0018" apply --check "$1" \
      || reject "clean forward patch failed: $patch_name"
    git -c core.fsmonitor=false -C "$CLEAN_0018" apply "$1"
  done
  check_clean_0018_hashes "$CLEAN_0018" || reject "0018 clean postimage drift"

if [ "$LEGACY_CONTEXT" = final-0019 ]; then
  REVERSED_0019=$PAYLOAD_WORK/reversed-0019
  mkdir -p "$REVERSED_0019/src/hotspot/cpu/zero" \
    "$REVERSED_0019/src/hotspot/share/interpreter/zero"
  cp "$JDK/src/hotspot/cpu/zero/globals_zero.hpp" \
    "$REVERSED_0019/src/hotspot/cpu/zero/globals_zero.hpp"
  cp "$JDK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" \
    "$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" \
    "$REVERSED_0019/src/hotspot/share/interpreter/zero/"
  git -C "$REVERSED_0019" init -q
  git -c core.fsmonitor=false -C "$REVERSED_0019" apply --reverse "$PATCH19" \
    || reject "0019 reverse materialization failed"
  check_clean_0018_hashes "$REVERSED_0019" \
    || reject "0019 reverse did not restore exact clean 0018"
fi

if [ "${MCWEB_ZERO_LEGACY_PROVENANCE_SELF_TEST:-0}" = 1 ]; then
  if select_context unknown-context; then reject "unknown context negative accepted"; fi
  if check_overlay_hashes "$JDK" final-0018 >/dev/null 2>&1; then
    reject "0019 without opt-in negative accepted"
  fi
  if check_overlay_hashes "$CLEAN_0018" final-0019 >/dev/null 2>&1; then
    reject "0019 opt-in accepted 0018 overlay"
  fi
  MUTATED_0019=$PAYLOAD_WORK/mutated-0019
  mkdir -p "$MUTATED_0019/src/hotspot/cpu/zero" \
    "$MUTATED_0019/src/hotspot/share/interpreter/zero"
  cp "$JDK/src/hotspot/cpu/zero/globals_zero.hpp" \
    "$MUTATED_0019/src/hotspot/cpu/zero/globals_zero.hpp"
  cp "$JDK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" \
    "$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" \
    "$MUTATED_0019/src/hotspot/share/interpreter/zero/"
  printf '\n' >>"$MUTATED_0019/src/hotspot/cpu/zero/globals_zero.hpp"
  if check_overlay_hashes "$MUTATED_0019" final-0019 >/dev/null 2>&1; then
    reject "single 0019 hash mutation negative accepted"
  fi
  MUTATED_CLEAN=$PAYLOAD_WORK/mutated-clean-0018
  cp -R "$CLEAN_0018" "$MUTATED_CLEAN"
  printf '\n' >>"$MUTATED_CLEAN/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp"
  if check_clean_0018_hashes "$MUTATED_CLEAN" >/dev/null 2>&1; then
    reject "clean 0018 proof mutation negative accepted"
  fi
  printf '%s\n' 'provenance0018-context-self-negatives=pass unknown=reject no-opt-in-0019=reject opt-in-0018=reject mutated-0019=reject mutated-clean-0018=reject count=5'
fi

printf 'provenance0018=pass patch-sha=%s paths=3 mode-changes=0 binary-payloads=0 setup-order=0017,0018 source-label=%s clean-0018=proved\n' \
  "$EXPECTED_PATCH18_SHA" "$LEGACY_CONTEXT"
