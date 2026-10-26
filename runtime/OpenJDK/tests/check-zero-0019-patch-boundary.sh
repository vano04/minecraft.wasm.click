#!/bin/sh
# Reconstruct the OSS Zero patch stack through 0019, prove the exact 0019
# three-file postimage, then reverse to the exact 0018 postimage and clean base.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JDK="$ROOT/work/jdk25"
PATCH_DIR="$ROOT/patches"
WORK=$(mktemp -d /private/tmp/mcweb-0019-patch-boundary.XXXXXX)
STACK="$WORK/stack"
SCRIPT_NAME=${MCWEB_PATCH_BOUNDARY_COMMAND:-OpenJDK/tests/check-zero-0019-patch-boundary.sh}
STARTED_EPOCH=$(date +%s)
SCRIPT_SHA=$(shasum -a 256 "$0" | awk '{print $1}')

cleanup() {
  status=$?
  trap - EXIT INT TERM
  case "$WORK" in
    /private/tmp/mcweb-0019-patch-boundary.??????)
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

validate_patch0019_payload() {
  candidate=$1
  # A byte scan is the ASCII authority. Reject before locale-sensitive text
  # tools inspect the candidate; iconv behavior differs across hosts.
  node -e 'const fs=require("fs");const b=fs.readFileSync(process.argv[1]);if(!b.every((byte)=>byte<=0x7f))process.exit(1)' "$candidate" \
    || return 1
  expected_paths='src/hotspot/cpu/zero/globals_zero.hpp
src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp
src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp'
  actual_old_paths=$(awk '/^diff --git / {print $3}' "$candidate" | sed 's#^a/##' | LC_ALL=C sort)
  actual_new_paths=$(awk '/^diff --git / {print $4}' "$candidate" | sed 's#^b/##' | LC_ALL=C sort)
  [ "$actual_old_paths" = "$expected_paths" ] || return 1
  [ "$actual_new_paths" = "$expected_paths" ] || return 1
  [ "$(grep -c '^diff --git ' "$candidate")" -eq 3 ] || return 1
  LC_ALL=C grep -Eq '^(GIT binary patch|Binary files |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )' "$candidate" && return 1
  return 0
}

[ -d "$JDK/.git" ] || reject "prepared JDK checkout unavailable"
BASE_HEAD=$(git_safe -C "$JDK" rev-parse HEAD)
[ "$BASE_HEAD" = 6c48f4ed707bf0b15f9b6098de30db8aae6fa40f ] || reject "base HEAD drift"
PATCH15=$(patch_for_name 0015) || reject "0015 patch unavailable"
PATCH16=$(patch_for_name 0016) || reject "0016 patch unavailable"
PATCH17=$(patch_for_name 0017) || reject "0017 patch unavailable"
PATCH18=$(patch_for_name 0018) || reject "0018 patch unavailable"
PATCH19=$(patch_for_name 0019) || reject "0019 patch unavailable"
PATCH15_SHA=$(shasum -a 256 "$PATCH15" | awk '{print $1}')
PATCH16_SHA=$(shasum -a 256 "$PATCH16" | awk '{print $1}')
PATCH17_SHA=$(shasum -a 256 "$PATCH17" | awk '{print $1}')
PATCH18_SHA=$(shasum -a 256 "$PATCH18" | awk '{print $1}')
PATCH19_SHA=$(shasum -a 256 "$PATCH19" | awk '{print $1}')
[ "$PATCH15_SHA" = 9d76abe0cd8818b37089ff96386203cb9f2de3d0f6591768119c1e8213ffe2d2 ] || reject "0015 hash drift"
[ "$PATCH16_SHA" = 0d7c204725b28cb1824f49cc2988f86ba07fea98098dbad126c98861ddb7c7ee ] || reject "0016 hash drift"
[ "$PATCH17_SHA" = ddb93941e71c293b6b20ca2810806301aaddf046f1f0cd24d2bb21366cac96a8 ] || reject "0017 hash drift"
[ "$PATCH18_SHA" = 53cf9d1332f70d3f83e101ec73b5f6d3ebde7e9bb059fd8456754a3e0bcc0024 ] || reject "0018 hash drift"
[ "$PATCH19_SHA" = 983ed617633fbf9b2635a3a175dfbf96850c72412388f3fb6474e9364e935905 ] || reject "0019 hash drift"
validate_patch0019_payload "$PATCH19" || reject "0019 path/payload/ascii policy"

EXPECTED_NUMSTAT='11	0	src/hotspot/cpu/zero/globals_zero.hpp
53	4	src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp
2178	47	src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp'
ACTUAL_NUMSTAT=$(git_safe apply --numstat "$PATCH19")
[ "$ACTUAL_NUMSTAT" = "$EXPECTED_NUMSTAT" ] || reject "0019 numstat drift"

# The validator itself must fail closed on every forbidden payload family.
for mutation in extra mode binary rename nonascii; do
  negative="$WORK/negative-$mutation.patch"
  cp "$PATCH19" "$negative"
  case "$mutation" in
    extra)
      printf '%s\n' 'diff --git a/src/hotspot/cpu/zero/forbidden.cpp b/src/hotspot/cpu/zero/forbidden.cpp' >> "$negative"
      ;;
    mode)
      printf '%s\n' 'old mode 100644' 'new mode 100755' >> "$negative"
      ;;
    binary)
      printf '%s\n' 'GIT binary patch' >> "$negative"
      ;;
    rename)
      printf '%s\n' 'rename from src/hotspot/cpu/zero/globals_zero.hpp' >> "$negative"
      ;;
    nonascii)
      node -e 'process.stdout.write(Buffer.from([0x80, 0x0a]))' >> "$negative"
      node -e 'const fs=require("fs");const b=fs.readFileSync(process.argv[1]);if(b.length<2||b[b.length-2]!==0x80||b[b.length-1]!==0x0a)process.exit(1)' "$negative" \
        || reject "nonascii negative bytes were not exact 80 0a"
      ;;
  esac
  if validate_patch0019_payload "$negative"; then
    reject "0019 validator accepted $mutation negative"
  fi
  printf 'payload-negative=%s status=pass\n' "$mutation"
done

PATCH_NAMES="0001 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0019"
REVERSE_NAMES="0019 0018 0017 0016 0015 0014 0013 0012 0011 0010 0009 0008 0007 0006 0005 0004 0003 0001"
mkdir -p "$STACK"
git_safe -C "$JDK" archive HEAD | tar -x -C "$STACK"
git_safe -C "$STACK" init -q
git_safe -C "$STACK" add -A
git_safe -C "$STACK" -c user.name=mcweb -c user.email=mcweb@example.invalid commit -qm clean-base

printf '%s\n' 'audit=0019-final-patch-boundary'
printf 'command=%s\n' "$SCRIPT_NAME"
printf 'started-epoch=%s\n' "$STARTED_EPOCH"
printf 'script-sha256=%s\n' "$SCRIPT_SHA"
printf 'base-head-commit=%s\n' "$BASE_HEAD"
printf 'patch-stack=%s\n' "$PATCH_NAMES"
printf 'patch0015-sha256=%s\n' "$PATCH15_SHA"
printf 'patch0016-sha256=%s\n' "$PATCH16_SHA"
printf 'patch0017-sha256=%s\n' "$PATCH17_SHA"
printf 'patch0018-sha256=%s\n' "$PATCH18_SHA"
printf 'patch0019-sha256=%s\n' "$PATCH19_SHA"
printf 'patch0019-numstat=%s\n' '11:0,53:4,2178:47'

EXPECTED_0016_GLOBALS_SHA=5858ac45c26e463689b779d1b3b0b3b2d6a9d454f45b550b1290f280e9f9a449
EXPECTED_0016_INTERPRETER_SHA=ce3ab6676d3133d2f98d765de3cd849a8e54caf5cbe7cf3d375c9f9622e91c10
EXPECTED_0016_BASELINE_SHA=a340329a2ce46d5313437302df8fa26512207086166f2552c90880d3d38710d3
EXPECTED_0017_GLOBALS_SHA=5858ac45c26e463689b779d1b3b0b3b2d6a9d454f45b550b1290f280e9f9a449
EXPECTED_0017_INTERPRETER_SHA=ce3ab6676d3133d2f98d765de3cd849a8e54caf5cbe7cf3d375c9f9622e91c10
EXPECTED_0017_BASELINE_SHA=c356dfa1a70f0f90e9e716870c8d8b809568130cd8e5a21709eec99aa978e47c
EXPECTED_0018_GLOBALS_SHA=6c8ac8a604881191755b876c9cfad596948dcf22642a6af1ea5d7c72e6fdbc27
EXPECTED_0018_INTERPRETER_SHA=e54f7456695ea2fab786a439da94d27ba94e41574f9fea15fb84def6a3ab04a1
EXPECTED_0018_BASELINE_SHA=892cb9d63b3909d8acb933cd8849c9b9caeef17353ad0d655d3822737abb4733
EXPECTED_0019_GLOBALS_SHA=bd76b9d3df38fc45892a45b9ebb5d54b1d5fb8fec5917a47929ef8e634082265
EXPECTED_0019_INTERPRETER_SHA=08e457e0a1551d8f3c3c16b0b4aa1f2608f630babe3ccd54f3e1fba316fc3676
EXPECTED_0019_BASELINE_SHA=d2276be03aa03375fa59e9ccae10fee21b65f63d30c509f9fdfcbac349573420

for patch_name in $PATCH_NAMES; do
  patch=$(patch_for_name "$patch_name") || reject "missing patch $patch_name"
  patch_sha=$(shasum -a 256 "$patch" | awk '{print $1}')
  git_safe -C "$STACK" apply --check "$patch" || reject "forward check failed $patch_name"
  git_safe -C "$STACK" apply "$patch" || reject "forward apply failed $patch_name"
  printf 'forward patch=%s sha256=%s status=pass\n' "$patch_name" "$patch_sha"
  case "$patch_name" in
    0016)
      expected_globals=$EXPECTED_0016_GLOBALS_SHA
      expected_interpreter=$EXPECTED_0016_INTERPRETER_SHA
      expected_baseline=$EXPECTED_0016_BASELINE_SHA
      ;;
    0017)
      expected_globals=$EXPECTED_0017_GLOBALS_SHA
      expected_interpreter=$EXPECTED_0017_INTERPRETER_SHA
      expected_baseline=$EXPECTED_0017_BASELINE_SHA
      ;;
    0018)
      expected_globals=$EXPECTED_0018_GLOBALS_SHA
      expected_interpreter=$EXPECTED_0018_INTERPRETER_SHA
      expected_baseline=$EXPECTED_0018_BASELINE_SHA
      ;;
    0019)
      expected_globals=$EXPECTED_0019_GLOBALS_SHA
      expected_interpreter=$EXPECTED_0019_INTERPRETER_SHA
      expected_baseline=$EXPECTED_0019_BASELINE_SHA
      ;;
    *) continue ;;
  esac
  globals_sha=$(shasum -a 256 "$STACK/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')
  interpreter_sha=$(shasum -a 256 "$STACK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')
  baseline_sha=$(shasum -a 256 "$STACK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')
  [ "$globals_sha" = "$expected_globals" ] || reject "$patch_name globals postimage drift"
  [ "$interpreter_sha" = "$expected_interpreter" ] || reject "$patch_name interpreter postimage drift"
  [ "$baseline_sha" = "$expected_baseline" ] || reject "$patch_name baseline postimage drift"
  printf 'postimage-%s globals=%s interpreter=%s baseline=%s status=pass\n' \
    "$patch_name" "$globals_sha" "$interpreter_sha" "$baseline_sha"
done

cmp -s "$STACK/src/hotspot/cpu/zero/globals_zero.hpp" "$JDK/src/hotspot/cpu/zero/globals_zero.hpp" || reject "0019 globals differs from current source"
cmp -s "$STACK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" "$JDK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" || reject "0019 interpreter differs from current source"
cmp -s "$STACK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" "$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" || reject "0019 baseline differs from current source"
printf '%s\n' 'current-source-postimage=pass'

for patch_name in $REVERSE_NAMES; do
  patch=$(patch_for_name "$patch_name") || reject "missing reverse patch $patch_name"
  patch_sha=$(shasum -a 256 "$patch" | awk '{print $1}')
  git_safe -C "$STACK" apply --reverse --check "$patch" || reject "reverse check failed $patch_name"
  git_safe -C "$STACK" apply --reverse "$patch" || reject "reverse apply failed $patch_name"
  printf 'reverse patch=%s sha256=%s status=pass\n' "$patch_name" "$patch_sha"
  case "$patch_name" in
    0019)
      expected_globals=$EXPECTED_0018_GLOBALS_SHA
      expected_interpreter=$EXPECTED_0018_INTERPRETER_SHA
      expected_baseline=$EXPECTED_0018_BASELINE_SHA
      restored_label=0018
      ;;
    0018)
      expected_globals=$EXPECTED_0017_GLOBALS_SHA
      expected_interpreter=$EXPECTED_0017_INTERPRETER_SHA
      expected_baseline=$EXPECTED_0017_BASELINE_SHA
      restored_label=0017
      ;;
    0017)
      expected_globals=$EXPECTED_0016_GLOBALS_SHA
      expected_interpreter=$EXPECTED_0016_INTERPRETER_SHA
      expected_baseline=$EXPECTED_0016_BASELINE_SHA
      restored_label=0016
      ;;
    *) continue ;;
  esac
  globals_sha=$(shasum -a 256 "$STACK/src/hotspot/cpu/zero/globals_zero.hpp" | awk '{print $1}')
  interpreter_sha=$(shasum -a 256 "$STACK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp" | awk '{print $1}')
  baseline_sha=$(shasum -a 256 "$STACK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp" | awk '{print $1}')
  [ "$globals_sha" = "$expected_globals" ] || reject "$patch_name reverse globals drift"
  [ "$interpreter_sha" = "$expected_interpreter" ] || reject "$patch_name reverse interpreter drift"
  [ "$baseline_sha" = "$expected_baseline" ] || reject "$patch_name reverse baseline drift"
  printf 'postimage-%s-restored globals=%s interpreter=%s baseline=%s status=pass\n' \
    "$restored_label" "$globals_sha" "$interpreter_sha" "$baseline_sha"
done

[ -z "$(git_safe -C "$STACK" status --porcelain)" ] || reject "reverse stack did not return to clean base"
printf '%s\n' 'clean-base-return=pass'
printf '%s\n' 'ACCEPT patch-boundary clean-base-forward-0019-reverse-0019-exact-0018-postimages'
printf 'exit=0\n'
printf 'finished-epoch=%s\n' "$(date +%s)"
