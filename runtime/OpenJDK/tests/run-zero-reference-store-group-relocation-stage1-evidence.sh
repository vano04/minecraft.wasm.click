#!/bin/sh
# Durable, source-only C3b Stage-1 evidence. No rebuilt runtime, emitted
# module, cache mutation, continuation, relocation, or GC is admitted here.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
STATIC="$ROOT/OpenJDK/tests/run-zero-reference-store-group-relocation-static.sh"
BOUNDARY="$ROOT/OpenJDK/tests/check-zero-0020-patch-boundary.sh"
SETUP_GATE="$ROOT/OpenJDK/tests/run-zero-setup-transaction.sh"
MANIFEST="$ROOT/OpenJDK/tests/zero-reference-store-group-relocation-c3b-manifest.sha256"
MANIFEST_CHECKER="$ROOT/OpenJDK/tests/check-zero-reference-store-group-relocation-manifest.mjs"
NESTED_CHECKER="$ROOT/OpenJDK/tests/check-zero-nested-evidence.mjs"
LOCK_HELPER="$ROOT/OpenJDK/tests/zero-runtime-gate-lock.sh"
FINAL0019=/private/tmp/mcweb-zero-0019-final-accept.1787236507.83859
STARTED_EPOCH=$(date +%s)
RUN_ID=${MCWEB_C3B_STAGE1_RUN_ID:-$STARTED_EPOCH.$$}
FINAL=${MCWEB_C3B_STAGE1_EVIDENCE_ROOT:-/private/tmp/mcweb-zero-c3b-stage1-source-accept.$RUN_ID}
STAGE=$FINAL.tmp.$$
WORK=$(mktemp -d /private/tmp/mcweb-c3b-stage1-evidence-work.XXXXXX)
LOCK_HELD=0

. "$LOCK_HELPER"

reject() {
  printf 'REJECT c3b-stage1-evidence reason=%s work=%s stage=%s\n' "$1" "$WORK" "$STAGE" >&2
  exit 1
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$LOCK_HELD" -eq 1 ]; then runtime_gate_lock_release || true; fi
  if [ "$status" -eq 0 ]; then
    case "$WORK" in /private/tmp/mcweb-c3b-stage1-evidence-work.??????) rm -rf -- "$WORK" ;; esac
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

hash_of() { shasum -a 256 "$1" | awk '{print $1}'; }
bytes_of() { wc -c <"$1" | tr -d ' '; }
require_absent() { [ ! -e "$1" ]; }

generate_index() {
  closure=$1
  (cd "$closure" && find . -type f \
      ! -path './evidence.index' ! -path './evidence.index.sha256' \
      -print | LC_ALL=C sort | while IFS= read -r item; do
        printf '%s  %s  %s\n' "$(hash_of "$item")" "$(bytes_of "$item")" "${item#./}"
      done >evidence.index)
  (cd "$closure" && shasum -a 256 evidence.index >evidence.index.sha256)
}

verify_index() {
  closure=$1
  index=${2:-$closure/evidence.index}
  [ -s "$index" ] || return 1
  actual=$WORK/actual.$$.paths
  indexed=$WORK/indexed.$$.paths
  (cd "$closure" && find . -type f \
      ! -path './evidence.index' ! -path './evidence.index.sha256' \
      -print | sed 's#^\./##' | LC_ALL=C sort) >"$actual"
  awk '
    NF != 3 { exit 1 }
    $1 !~ /^[0-9a-f]{64}$/ || $2 !~ /^(0|[1-9][0-9]*)$/ { exit 1 }
    $3 == "" || $3 ~ /^\// || $3 ~ /(^|\/)\.\.($|\/)/ { exit 1 }
    { print $3 }
  ' "$index" >"$indexed" || return 1
  cmp -s "$actual" "$indexed" || return 1
  [ "$(LC_ALL=C sort "$indexed" | uniq -d | wc -l | tr -d ' ')" -eq 0 ] || return 1
  while IFS=' ' read -r expected_sha expected_bytes relative extra; do
    [ -z "${extra:-}" ] && [ -f "$closure/$relative" ] || return 1
    [ "$(hash_of "$closure/$relative")" = "$expected_sha" ] || return 1
    [ "$(bytes_of "$closure/$relative")" = "$expected_bytes" ] || return 1
  done <"$index"
  rows=$(wc -l <"$index" | tr -d ' ')
  total=$(find "$closure" -type f | wc -l | tr -d ' ')
  [ "$total" -eq $((rows + 2)) ] || return 1
}

[ "$RUN_ID" != "" ] || reject run-id
case "$FINAL" in /private/tmp/mcweb-zero-c3b-stage1-source-accept.*) ;; *) reject final-path ;; esac
require_absent "$FINAL" || reject final-collision
require_absent "$STAGE" || reject stage-collision
[ -d "$FINAL0019" ] || reject final0019-missing
node "$NESTED_CHECKER" "$FINAL0019" >"$WORK/final0019-before.log" 2>&1 \
  || reject final0019-before
FINAL0019_INDEX_BEFORE=$(hash_of "$FINAL0019/evidence.index")
FINAL0019_SIDECAR_BEFORE=$(hash_of "$FINAL0019/evidence.index.sha256")

# Executing collision self-negative: an already-owned stage target must never
# be admitted or replaced.
mkdir "$WORK/stage-collision"
if require_absent "$WORK/stage-collision"; then reject stage-collision-negative; fi
printf '%s\n' 'stage-collision-negative=pass' >"$WORK/publication-self-negatives.log"

runtime_gate_lock_acquire || reject shared-lock
LOCK_HELD=1
"$STATIC" >"$WORK/static.log" 2>&1 || reject static
"$SETUP_GATE" >"$WORK/setup-transaction.log" 2>&1 || reject setup-transaction
MCWEB_PATCH_BOUNDARY_COMMAND=OpenJDK/tests/check-zero-0020-patch-boundary.sh \
  "$BOUNDARY" >"$WORK/patch-boundary.log" 2>&1 || reject patch-boundary

source_snapshot=$WORK/source.before
for path in \
  OpenJDK/work/jdk25/src/hotspot/cpu/zero/globals_zero.hpp \
  OpenJDK/work/jdk25/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp \
  OpenJDK/work/jdk25/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp; do
  printf '%s  %s  %s\n' "$(hash_of "$ROOT/$path")" "$(bytes_of "$ROOT/$path")" "$path"
done >"$source_snapshot"

# Replay the generated compile commands into an owned temporary directory.
# Objects are hashed and then excluded from the source-only evidence payload.
. "$ROOT/OpenJDK/work/emsdk/emsdk_env.sh" >/dev/null
[ "$EMSDK_PYTHON" = "$ROOT/OpenJDK/work/emsdk/python/3.13.3_64bit/bin/python3" ] \
  || reject emsdk-python
mkdir -p "$WORK/compile"
for stem in zeroWasmBaseline bytecodeInterpreter; do
  command_file="$ROOT/OpenJDK/work/jdk25/build/wasm-zero/hotspot/variant-zero/libjvm/objs/$stem.o.cmdline"
  [ -s "$command_file" ] || reject compile-command
  command=$(<"$command_file")
  old_dep="$ROOT/OpenJDK/work/jdk25/build/wasm-zero/hotspot/variant-zero/libjvm/objs/$stem.d.tmp"
  old_obj="$ROOT/OpenJDK/work/jdk25/build/wasm-zero/hotspot/variant-zero/libjvm/objs/$stem.o"
  command=${command/"$old_dep"/"$WORK/compile/$stem.d"}
  command=${command/"$old_obj"/"$WORK/compile/$stem.o"}
  printf '%s\n' "$command" >"$WORK/compile/$stem.command.txt"
  eval "$command" >"$WORK/compile/$stem.log" 2>&1 || reject compile-$stem
  printf 'object=%s sha256=%s bytes=%s source-only-excluded=1\n' \
    "$stem.o" "$(hash_of "$WORK/compile/$stem.o")" \
    "$(bytes_of "$WORK/compile/$stem.o")" >>"$WORK/compile/objects.meta"
done

cmp -s "$source_snapshot" "$WORK/source.before" || reject source-snapshot-internal
for path in \
  OpenJDK/work/jdk25/src/hotspot/cpu/zero/globals_zero.hpp \
  OpenJDK/work/jdk25/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp \
  OpenJDK/work/jdk25/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp; do
  printf '%s  %s  %s\n' "$(hash_of "$ROOT/$path")" "$(bytes_of "$ROOT/$path")" "$path"
done >"$WORK/source.after"
cmp -s "$source_snapshot" "$WORK/source.after" || reject source-drift

mkdir -p "$STAGE/logs" "$STAGE/assets" "$STAGE/source" "$STAGE/prerequisite"
cp "$WORK/static.log" "$WORK/setup-transaction.log" "$WORK/patch-boundary.log" \
  "$WORK/final0019-before.log" "$WORK/publication-self-negatives.log" \
  "$WORK/compile/zeroWasmBaseline.command.txt" \
  "$WORK/compile/zeroWasmBaseline.log" \
  "$WORK/compile/bytecodeInterpreter.command.txt" \
  "$WORK/compile/bytecodeInterpreter.log" "$WORK/compile/objects.meta" \
  "$STAGE/logs/"
cp -R "$FINAL0019" "$STAGE/prerequisite/final0019"
node "$NESTED_CHECKER" "$STAGE/prerequisite/final0019" \
  >"$STAGE/logs/final0019-copied.log" 2>&1 || reject final0019-copy

# Copy every manifest-bound Stage-1 asset by its repository-relative path.
awk '/^[0-9a-f]{64} [0-9]+ / {print $3}' "$MANIFEST" | while IFS= read -r relative; do
  destination="$STAGE/assets/$relative"
  mkdir -p "$(dirname "$destination")"
  cp "$ROOT/$relative" "$destination"
done
cp "$source_snapshot" "$WORK/source.after" "$STAGE/source/"

FINISHED_EPOCH=$(date +%s)
cat >"$STAGE/stage1.meta" <<EOF
audit=c3b-stage1-source-only
acceptance=NOT_EXECUTED
runtime=NOT_REBUILT
module=NOT_DUMPED
continuation=UNARMED
gc=NOT_EXECUTED
started-epoch=$STARTED_EPOCH
finished-epoch=$FINISHED_EPOCH
run-id=$RUN_ID
patch0020-sha256=$(hash_of "$ROOT/OpenJDK/patches/0020-zero-wasm-reference-store-group-relocation-scaffold.patch")
manifest-sha256=$(hash_of "$MANIFEST")
final0019-index-sha256=$FINAL0019_INDEX_BEFORE
final0019-sidecar-sha256=$FINAL0019_SIDECAR_BEFORE
terminal=ACCEPT C3b Stage1 source-only scaffold; runtime semantics NOT_EXECUTED
EOF

[ -z "$(find "$STAGE" -type l -print -quit)" ] || reject symlink
[ -z "$(find "$STAGE/assets" "$STAGE/source" -type f \
  \( -name '*.class' -o -name '*.jar' -o -name '*.wasm' -o -name '*.o' \
     -o -name '*.a' -o -name '*.dylib' -o -name '*.so' -o -name '*.zip' \) \
  -print -quit)" ] || reject source-only-payload

generate_index "$STAGE"
verify_index "$STAGE" || reject closure
(cd "$STAGE" && shasum -a 256 -c evidence.index.sha256 >/dev/null) \
  || reject sidecar

# Omission and tamper self-negatives operate on alternate index text and do
# not alter the accepted stage or immutable prerequisite.
sed '1d' "$STAGE/evidence.index" >"$WORK/omitted.index"
if verify_index "$STAGE" "$WORK/omitted.index"; then reject omission-negative; fi
cp "$STAGE/evidence.index" "$WORK/tampered.index"
node -e 'const fs=require("fs");const p=process.argv[1];const b=fs.readFileSync(p);b[0]=b[0]===0x30?0x31:0x30;fs.writeFileSync(p,b)' \
  "$WORK/tampered.index"
if verify_index "$STAGE" "$WORK/tampered.index"; then reject tamper-negative; fi
printf '%s\n' 'omission-negative=pass tamper-negative=pass stage-collision-negative=pass' \
  >>"$STAGE/logs/publication-self-negatives.log"
generate_index "$STAGE"
verify_index "$STAGE" || reject closure-after-negatives
(cd "$STAGE" && shasum -a 256 -c evidence.index.sha256 >/dev/null) \
  || reject sidecar-after-negatives

node "$NESTED_CHECKER" "$FINAL0019" >"$WORK/final0019-after.log" 2>&1 \
  || reject final0019-after
[ "$(hash_of "$FINAL0019/evidence.index")" = "$FINAL0019_INDEX_BEFORE" ] \
  || reject final0019-index-drift
[ "$(hash_of "$FINAL0019/evidence.index.sha256")" = "$FINAL0019_SIDECAR_BEFORE" ] \
  || reject final0019-sidecar-drift
require_absent "$FINAL" || reject final-race
mv "$STAGE" "$FINAL"
sync
runtime_gate_lock_release || reject lock-release
LOCK_HELD=0

ROWS=$(wc -l <"$FINAL/evidence.index" | tr -d ' ')
FILES=$(find "$FINAL" -type f | wc -l | tr -d ' ')
INDEX_SHA=$(hash_of "$FINAL/evidence.index")
SIDECAR_SHA=$(hash_of "$FINAL/evidence.index.sha256")
printf 'ACCEPT C3b Stage1 source-only scaffold evidence=%s rows=%s files=%s index-sha256=%s sidecar-sha256=%s acceptance=NOT_EXECUTED runtime=NOT_REBUILT module=NOT_DUMPED continuation=UNARMED gc=NOT_EXECUTED\n' \
  "$FINAL" "$ROWS" "$FILES" "$INDEX_SHA" "$SIDECAR_SHA"
