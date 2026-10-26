#!/bin/sh
# Reconstruct the accepted OSS Zero patch stack from a clean JDK base, then
# reverse it to that same clean base.  This is provenance evidence only; it
# does not build, package, or execute proprietary content.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JDK="$ROOT/work/jdk25"
PATCH_DIR="$ROOT/patches"
WORK=$(mktemp -d /private/tmp/mcweb-0015-patch-boundary.XXXXXX)
STACK="$WORK/stack"
SCRIPT_NAME=${MCWEB_PATCH_BOUNDARY_COMMAND:-OpenJDK/tests/check-zero-0015-patch-boundary.sh}
STARTED_EPOCH=$(date +%s)
SCRIPT_SHA=$(shasum -a 256 "$0" | awk '{print $1}')

cleanup() {
  status=$?
  trap - EXIT INT TERM
  case "$WORK" in
    /private/tmp/mcweb-0015-patch-boundary.??????)
      rm -rf -- "$WORK" || true
      ;;
  esac
  exit "$status"
}
trap cleanup EXIT INT TERM

reject() {
  printf 'REJECT patch-boundary %s\n' "$*"
  exit 1
}

git_safe() {
  git -c core.fsmonitor=false -c gc.auto=0 -c maintenance.auto=false "$@"
}

patch_for_name() {
  name=$1
  set -- "$PATCH_DIR/$name"-*.patch
  [ "$#" -eq 1 ] && [ -f "$1" ] || return 1
  printf '%s\n' "$1"
}

[ -d "$JDK/.git" ] || reject "prepared JDK checkout unavailable"
BASE_HEAD=$(git_safe -C "$JDK" rev-parse HEAD)
PATCH15=$(patch_for_name 0015) || reject "0015 patch unavailable"
PATCH15_SHA=$(shasum -a 256 "$PATCH15" | awk '{print $1}')
EXPECTED_PATCH15_SHA=9d76abe0cd8818b37089ff96386203cb9f2de3d0f6591768119c1e8213ffe2d2
[ "$PATCH15_SHA" = "$EXPECTED_PATCH15_SHA" ] || reject "0015 hash drift"

PATCH_NAMES="0001 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015"
REVERSE_NAMES="0015 0014 0013 0012 0011 0010 0009 0008 0007 0006 0005 0004 0003 0001"
mkdir -p "$STACK"
git_safe -C "$JDK" archive HEAD | tar -x -C "$STACK"
git_safe -C "$STACK" init -q
git_safe -C "$STACK" add -A
git_safe -C "$STACK" -c user.name=mcweb -c user.email=mcweb@example.invalid \
  commit -qm clean-base

printf '%s\n' 'audit=0015-final-patch-boundary'
printf 'command=%s\n' "$SCRIPT_NAME"
printf 'started-epoch=%s\n' "$STARTED_EPOCH"
printf 'script-sha256=%s\n' "$SCRIPT_SHA"
printf 'base-head-commit=%s\n' "$BASE_HEAD"
printf 'patch-stack=%s\n' "$PATCH_NAMES"
printf 'patch0015-sha256=%s\n' "$PATCH15_SHA"

for patch_name in $PATCH_NAMES; do
  patch=$(patch_for_name "$patch_name") || reject "missing patch $patch_name"
  patch_sha=$(shasum -a 256 "$patch" | awk '{print $1}')
  git_safe -C "$STACK" apply --check "$patch" \
    || reject "forward check failed $patch_name"
  git_safe -C "$STACK" apply "$patch" \
    || reject "forward apply failed $patch_name"
  printf 'forward patch=%s sha256=%s status=pass\n' "$patch_name" "$patch_sha"
done

EXPECTED_0015_GLOBALS_SHA=194c8187621a306f76a7db4fab54c54b5a164449e413d575120385aa11b0e692
EXPECTED_0015_INTERPRETER_SHA=cea189b172c8ed050912f4ea92e4caf08268445f45a6daf2c1ce905fb5496fb5
EXPECTED_0015_BASELINE_SHA=0207ad4a93fca8352fa24f64f520484306be969605239b7eca2ffa97cc0ffa37
globals_sha=$(shasum -a 256 "$STACK/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')
interpreter_sha=$(shasum -a 256 "$STACK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')
baseline_sha=$(shasum -a 256 "$STACK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')
[ "$globals_sha" = "$EXPECTED_0015_GLOBALS_SHA" ] || reject "0015 globals postimage drift"
[ "$interpreter_sha" = "$EXPECTED_0015_INTERPRETER_SHA" ] || reject "0015 interpreter postimage drift"
[ "$baseline_sha" = "$EXPECTED_0015_BASELINE_SHA" ] || reject "0015 baseline postimage drift"
printf 'postimage-0015 globals=%s interpreter=%s baseline=%s status=pass\n' \
  "$globals_sha" "$interpreter_sha" "$baseline_sha"

for patch_name in $REVERSE_NAMES; do
  patch=$(patch_for_name "$patch_name") || reject "missing reverse patch $patch_name"
  patch_sha=$(shasum -a 256 "$patch" | awk '{print $1}')
  git_safe -C "$STACK" apply --reverse --check "$patch" \
    || reject "reverse check failed $patch_name"
  git_safe -C "$STACK" apply --reverse "$patch" \
    || reject "reverse apply failed $patch_name"
  printf 'reverse patch=%s sha256=%s status=pass\n' "$patch_name" "$patch_sha"
done

git_safe -C "$STACK" diff --quiet HEAD \
  || reject "reverse stack did not return to clean base"
printf 'clean-base-return=pass\n'
printf 'ACCEPT patch-boundary clean-base-forward-0015-reverse-0015-exact-postimages\n'
printf 'exit=0\n'
printf 'finished-epoch=%s\n' "$(date +%s)"
