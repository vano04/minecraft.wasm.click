#!/bin/sh
# Shared 0017 provenance preflight for retained OSS semantic gates.  It binds
# the immutable numbered patch and setup order while allowing the executing
# runtime source to carry a separately-labelled post-0017 development overlay.
set -eu

ROOT=${1:?usage: check-zero-0017-legacy-provenance.sh ROOT JDK [OUTPUT]}
JDK=${2:?usage: check-zero-0017-legacy-provenance.sh ROOT JDK [OUTPUT]}
OUTPUT=${3:-}
PATCH17="$ROOT/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch"
EXPECTED_HEAD=6c48f4ed707bf0b15f9b6098de30db8aae6fa40f
EXPECTED_PATCH17_SHA=ddb93941e71c293b6b20ca2810806301aaddf046f1f0cd24d2bb21366cac96a8
EXPECTED_0017_GLOBALS_SHA=5858ac45c26e463689b779d1b3b0b3b2d6a9d454f45b550b1290f280e9f9a449
EXPECTED_0017_INTERPRETER_SHA=ce3ab6676d3133d2f98d765de3cd849a8e54caf5cbe7cf3d375c9f9622e91c10
EXPECTED_0017_BASELINE_SHA=c356dfa1a70f0f90e9e716870c8d8b809568130cd8e5a21709eec99aa978e47c
PATCH_NAMES="0001 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017"

reject() {
  echo "REJECT 0017 legacy provenance: $*" >&2
  exit 1
}

check_0017_payload() {
  candidate=$1
  [ "$(rg -c '^diff --git ' "$candidate")" -eq 1 ] || return 1
  rg -q '^diff --git a/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp b/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp$' \
    "$candidate" || return 1
  ! rg -q '^(GIT binary patch|Binary files |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )' \
    "$candidate"
}

[ -d "$JDK/.git" ] || reject "prepared OpenJDK checkout unavailable"
[ -f "$PATCH17" ] || reject "0017 patch unavailable"
[ "$(git -c core.fsmonitor=false -C "$JDK" rev-parse HEAD)" = "$EXPECTED_HEAD" ] \
  || reject "OpenJDK base HEAD drift"
[ "$(shasum -a 256 "$PATCH17" | awk '{print $1}')" = "$EXPECTED_PATCH17_SHA" ] \
  || reject "0017 patch hash drift"
check_0017_payload "$PATCH17" || reject "0017 path/mode/binary payload drift"
PAYLOAD_WORK=$(mktemp -d "${TMPDIR:-/tmp}/mcweb-zero-0017-payload.XXXXXX")
trap 'rm -rf -- "$PAYLOAD_WORK"' EXIT HUP INT TERM
cp "$PATCH17" "$PAYLOAD_WORK/extra.patch"
printf '%s\n' 'diff --git a/tests/unowned.bin b/tests/unowned.bin' >>"$PAYLOAD_WORK/extra.patch"
if check_0017_payload "$PAYLOAD_WORK/extra.patch"; then reject "0017 extra-path negative accepted"; fi
cp "$PATCH17" "$PAYLOAD_WORK/binary.patch"
printf '%s\n' 'GIT binary patch' >>"$PAYLOAD_WORK/binary.patch"
if check_0017_payload "$PAYLOAD_WORK/binary.patch"; then reject "0017 binary negative accepted"; fi
cp "$PATCH17" "$PAYLOAD_WORK/mode.patch"
printf '%s\n' 'new mode 100755' >>"$PAYLOAD_WORK/mode.patch"
if check_0017_payload "$PAYLOAD_WORK/mode.patch"; then reject "0017 mode negative accepted"; fi
awk '
  /git apply.*0016-zero-wasm-linked-ref-array-load\.patch/ { sixteen = NR; sixteen_count++ }
  /git apply.*0017-zero-wasm-linked-ref-array-load-cache-integrity\.patch/ { seventeen = NR; seventeen_count++ }
  END { exit !(sixteen_count == 1 && seventeen_count == 1 && seventeen == sixteen + 1) }
' "$ROOT/setup.sh" || reject "setup 0016/0017 order drift"
git -c core.fsmonitor=false -C "$JDK" apply --reverse --check "$PATCH17" \
  || reject "executing overlay does not contain exact 0017 cache-integrity hunk"

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
  [ "$(shasum -a 256 "$OUTPUT/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')" = "$EXPECTED_0017_GLOBALS_SHA" ] \
    || reject "0017 clean globals postimage drift"
  [ "$(shasum -a 256 "$OUTPUT/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')" = "$EXPECTED_0017_INTERPRETER_SHA" ] \
    || reject "0017 clean interpreter postimage drift"
  [ "$(shasum -a 256 "$OUTPUT/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')" = "$EXPECTED_0017_BASELINE_SHA" ] \
    || reject "0017 clean baseline postimage drift"
fi

printf 'provenance0017=pass patch-sha=%s paths=1 mode-changes=0 binary-payloads=0 setup-order=0016,0017 overlay-label=post-0017-wip\n' \
  "$EXPECTED_PATCH17_SHA"
