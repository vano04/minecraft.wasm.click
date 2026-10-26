#!/bin/sh
# Shared 0019 provenance preflight for retained OSS semantic gates. It binds
# the immutable numbered patch and setup order while allowing the executing
# runtime source to match the final OSS 0019 postimage exactly.
set -eu

ROOT=${1:?usage: check-zero-0019-legacy-provenance.sh ROOT JDK [OUTPUT]}
JDK=${2:?usage: check-zero-0019-legacy-provenance.sh ROOT JDK [OUTPUT]}
OUTPUT=${3:-}
PATCH19="$ROOT/patches/0019-zero-wasm-reference-store-group.patch"
EXPECTED_HEAD=6c48f4ed707bf0b15f9b6098de30db8aae6fa40f
EXPECTED_PATCH19_SHA=983ed617633fbf9b2635a3a175dfbf96850c72412388f3fb6474e9364e935905
EXPECTED_0019_GLOBALS_SHA=bd76b9d3df38fc45892a45b9ebb5d54b1d5fb8fec5917a47929ef8e634082265
EXPECTED_0019_INTERPRETER_SHA=08e457e0a1551d8f3c3c16b0b4aa1f2608f630babe3ccd54f3e1fba316fc3676
EXPECTED_0019_BASELINE_SHA=d2276be03aa03375fa59e9ccae10fee21b65f63d30c509f9fdfcbac349573420
PATCH_NAMES="0001 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0019"

reject() {
  echo "REJECT 0019 legacy provenance: $*" >&2
  exit 1
}

check_0019_payload() {
  candidate=$1
  node -e 'const fs=require("fs");const b=fs.readFileSync(process.argv[1]);if(!b.every((byte)=>byte<=0x7f))process.exit(1)' "$candidate" \
    || return 1
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
[ -f "$PATCH19" ] || reject "0019 patch unavailable"
[ "$(git -c core.fsmonitor=false -C "$JDK" rev-parse HEAD)" = "$EXPECTED_HEAD" ] \
  || reject "OpenJDK base HEAD drift"
PAYLOAD_WORK=$(mktemp -d "${TMPDIR:-/tmp}/mcweb-zero-0019-payload.XXXXXX")
trap 'rm -rf -- "$PAYLOAD_WORK"' EXIT HUP INT TERM
[ "$(shasum -a 256 "$PATCH19" | awk '{print $1}')" = "$EXPECTED_PATCH19_SHA" ] \
  || reject "0019 patch hash drift"
check_0019_payload "$PATCH19" || reject "0019 path/mode/binary payload drift"
cp "$PATCH19" "$PAYLOAD_WORK/extra.patch"
printf '%s\n' 'diff --git a/tests/unowned.bin b/tests/unowned.bin' >>"$PAYLOAD_WORK/extra.patch"
if check_0019_payload "$PAYLOAD_WORK/extra.patch"; then reject "0019 extra-path negative accepted"; fi
cp "$PATCH19" "$PAYLOAD_WORK/binary.patch"
printf '%s\n' 'GIT binary patch' >>"$PAYLOAD_WORK/binary.patch"
if check_0019_payload "$PAYLOAD_WORK/binary.patch"; then reject "0019 binary negative accepted"; fi
cp "$PATCH19" "$PAYLOAD_WORK/mode.patch"
printf '%s\n' 'new mode 100755' >>"$PAYLOAD_WORK/mode.patch"
if check_0019_payload "$PAYLOAD_WORK/mode.patch"; then reject "0019 mode negative accepted"; fi
cp "$PATCH19" "$PAYLOAD_WORK/nonascii.patch"
node -e 'process.stdout.write(Buffer.from([0x80,0x0a]))' >>"$PAYLOAD_WORK/nonascii.patch"
if check_0019_payload "$PAYLOAD_WORK/nonascii.patch"; then reject "0019 nonascii negative accepted"; fi
awk '
  /git apply.*0018-zero-wasm-linked-ref-array-store\.patch/ { eighteen = NR; eighteen_count++ }
  /git apply.*0019-zero-wasm-reference-store-group\.patch/ { nineteen = NR; nineteen_count++ }
  END { exit !(eighteen_count == 1 && nineteen_count == 1 && nineteen == eighteen + 1) }
' "$ROOT/setup.sh" || reject "setup 0018/0019 order drift"
git -c core.fsmonitor=false -C "$JDK" apply --reverse --check "$PATCH19" \
  || reject "executing source does not contain exact 0019 hunk"

if [ -n "$OUTPUT" ]; then
  mkdir -p "$OUTPUT"
  [ -z "$(find "$OUTPUT" -mindepth 1 -print -quit)" ] \
    || reject "materialization output is not empty"
  UNION="$OUTPUT/.patch-union"
  : >"$UNION"
  for patch_name in $PATCH_NAMES; do
    set -- "$ROOT"/patches/"$patch_name"-*.patch
    [ "$#" -eq 1 ] && [ -f "$1" ] || reject "missing or duplicate patch $patch_name"
    awk '/^diff --git / { print $4 }' "$1" | sed 's#^b/##' >>"$UNION"
  done
  LC_ALL=C sort -u "$UNION" -o "$UNION"
  while IFS= read -r file_path; do
    if git -c core.fsmonitor=false -C "$JDK" cat-file -e "HEAD:$file_path" 2>/dev/null; then
      mkdir -p "$OUTPUT/$(dirname "$file_path")"
      git -c core.fsmonitor=false -C "$JDK" show "HEAD:$file_path" >"$OUTPUT/$file_path"
    fi
  done <"$UNION"
  rm -f -- "$UNION"
  git -C "$OUTPUT" init -q
  for patch_name in $PATCH_NAMES; do
    set -- "$ROOT"/patches/"$patch_name"-*.patch
    git -c core.fsmonitor=false -C "$OUTPUT" apply --check "$1" \
      || reject "clean forward patch failed: $patch_name"
    git -c core.fsmonitor=false -C "$OUTPUT" apply "$1"
  done
  [ "$(shasum -a 256 "$OUTPUT/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0019_GLOBALS_SHA" ] \
    || reject "0019 clean globals postimage drift"
  [ "$(shasum -a 256 "$OUTPUT/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0019_INTERPRETER_SHA" ] \
    || reject "0019 clean interpreter postimage drift"
  [ "$(shasum -a 256 "$OUTPUT/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0019_BASELINE_SHA" ] \
    || reject "0019 clean baseline postimage drift"
fi

printf 'provenance0019=pass patch-sha=%s paths=3 mode-changes=0 binary-payloads=0 setup-order=0018,0019 source-label=final-0019\n' \
  "$EXPECTED_PATCH19_SHA"
