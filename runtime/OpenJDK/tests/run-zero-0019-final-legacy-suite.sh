#!/bin/sh
# Produce fresh, serial, atomic 0019-final envelopes for the retained OSS
# setup/M1/M2/P1 semantic gates. The C1 gate consumes and revalidates them.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK_HELPER="$ROOT/tests/zero-runtime-gate-lock.sh"
PROVENANCE19="$ROOT/tests/check-zero-0019-legacy-provenance.sh"
PROVENANCE18="$ROOT/tests/check-zero-0018-legacy-provenance.sh"
BOUNDARY19="$ROOT/tests/check-zero-0019-patch-boundary.sh"
PATCH15="$ROOT/patches/0015-zero-wasm-linked-int-array-store.patch"
PATCH16="$ROOT/patches/0016-zero-wasm-linked-ref-array-load.patch"
PATCH17="$ROOT/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch"
PATCH18="$ROOT/patches/0018-zero-wasm-linked-ref-array-store.patch"
PATCH19="$ROOT/patches/0019-zero-wasm-reference-store-group.patch"
TIMEOUT=${TIMEOUT:-/opt/homebrew/bin/timeout}
EXPECTED_PATCH15_SHA=9d76abe0cd8818b37089ff96386203cb9f2de3d0f6591768119c1e8213ffe2d2
EXPECTED_PATCH16_SHA=0d7c204725b28cb1824f49cc2988f86ba07fea98098dbad126c98861ddb7c7ee
EXPECTED_PATCH17_SHA=ddb93941e71c293b6b20ca2810806301aaddf046f1f0cd24d2bb21366cac96a8
EXPECTED_PATCH18_SHA=53cf9d1332f70d3f83e101ec73b5f6d3ebde7e9bb059fd8456754a3e0bcc0024
EXPECTED_PATCH19_SHA=983ed617633fbf9b2635a3a175dfbf96850c72412388f3fb6474e9364e935905
EXPECTED_PROVENANCE18_SHA=98210162e613050c97e02d881be392b022e6cb04710d7c144698d9d32d70a310
EXPECTED_OVERLAY_GLOBALS_SHA=bd76b9d3df38fc45892a45b9ebb5d54b1d5fb8fec5917a47929ef8e634082265
EXPECTED_OVERLAY_INTERPRETER_SHA=08e457e0a1551d8f3c3c16b0b4aa1f2608f630babe3ccd54f3e1fba316fc3676
EXPECTED_OVERLAY_BASELINE_SHA=d2276be03aa03375fa59e9ccae10fee21b65f63d30c509f9fdfcbac349573420
JDK="$ROOT/work/jdk25"
SOURCE_GLOBALS="$JDK/src/hotspot/cpu/zero/globals_zero.hpp"
SOURCE_INTERPRETER="$JDK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp"
SOURCE_BASELINE="$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp"
SUITE_COMMAND=OpenJDK/tests/run-zero-0019-final-legacy-suite.sh

reject() {
  printf 'REJECT 0019 final legacy suite: %s\n' "$*" >&2
  exit 1
}

[ -r "$LOCK_HELPER" ] || reject "runtime lock helper unavailable"
[ -x "$PROVENANCE19" ] || reject "0019 provenance helper unavailable"
[ -x "$PROVENANCE18" ] || reject "0018 provenance helper unavailable"
[ -x "$BOUNDARY19" ] || reject "0019 boundary checker unavailable"
[ -x "$TIMEOUT" ] || reject "timeout unavailable: $TIMEOUT"
. "$LOCK_HELPER"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  runtime_gate_lock_release 2>/dev/null || true
  if [ -n "${PROVENANCE_WORK:-}" ]; then
    case "$PROVENANCE_WORK" in
      /private/tmp/mcweb-zero-0019-suite-provenance.??????)
        rm -rf -- "$PROVENANCE_WORK" || true ;;
    esac
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

hash_of() { shasum -a 256 "$1" | awk '{print $1}'; }
verify_helper18_binding() {
  helper=$1
  envelope_line=$2
  [ "$(hash_of "$helper")" = "$EXPECTED_PROVENANCE18_SHA" ] \
    && [ "$envelope_line" = "legacy-provenance-helper18-sha256=$EXPECTED_PROVENANCE18_SHA" ]
}

boundary_checker_fields_exact() {
  log=$1
  checker_sha=$2
  [ "$(rg -c -x -F 'audit=0019-final-patch-boundary' "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F 'command=OpenJDK/tests/check-zero-0019-patch-boundary.sh' "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c '^started-epoch=[0-9][0-9]*$' "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "script-sha256=$checker_sha" "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "patch0015-sha256=$EXPECTED_PATCH15_SHA" "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "patch0016-sha256=$EXPECTED_PATCH16_SHA" "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "patch0017-sha256=$EXPECTED_PATCH17_SHA" "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "patch0018-sha256=$EXPECTED_PATCH18_SHA" "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "patch0019-sha256=$EXPECTED_PATCH19_SHA" "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F 'ACCEPT patch-boundary clean-base-forward-0019-reverse-0019-exact-0018-postimages' "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F 'exit=0' "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c '^finished-epoch=[0-9][0-9]*$' "$log" || printf 0)" -eq 1 ] \
    || return 1
  started=$(sed -n 's/^started-epoch=\([0-9][0-9]*\)$/\1/p' "$log")
  finished=$(sed -n 's/^finished-epoch=\([0-9][0-9]*\)$/\1/p' "$log")
  [ "$finished" -gt "$started" ] \
    && [ "$(tail -n 2 "$log" | sed -n '1p')" = 'exit=0' ] \
    && [ "$(tail -n 1 "$log")" = "finished-epoch=$finished" ]
}
PATCH15_SHA=$(hash_of "$PATCH15")
PATCH16_SHA=$(hash_of "$PATCH16")
PATCH17_SHA=$(hash_of "$PATCH17")
PATCH18_SHA=$(hash_of "$PATCH18")
PATCH19_SHA=$(hash_of "$PATCH19")
[ "$PATCH15_SHA" = "$EXPECTED_PATCH15_SHA" ] || reject "0015 patch hash drift"
[ "$PATCH16_SHA" = "$EXPECTED_PATCH16_SHA" ] || reject "0016 patch hash drift"
[ "$PATCH17_SHA" = "$EXPECTED_PATCH17_SHA" ] || reject "0017 patch hash drift"
[ "$PATCH18_SHA" = "$EXPECTED_PATCH18_SHA" ] || reject "0018 patch hash drift"
[ "$PATCH19_SHA" = "$EXPECTED_PATCH19_SHA" ] || reject "0019 patch hash drift"
PROVENANCE18_SHA=$(hash_of "$PROVENANCE18")
[ "$PROVENANCE18_SHA" = "$EXPECTED_PROVENANCE18_SHA" ] \
  || reject "0018 provenance helper drift"
[ "$(hash_of "$SOURCE_GLOBALS")" = "$EXPECTED_OVERLAY_GLOBALS_SHA" ] \
  || reject "executing globals overlay drift"
[ "$(hash_of "$SOURCE_INTERPRETER")" = "$EXPECTED_OVERLAY_INTERPRETER_SHA" ] \
  || reject "executing interpreter overlay drift"
[ "$(hash_of "$SOURCE_BASELINE")" = "$EXPECTED_OVERLAY_BASELINE_SHA" ] \
  || reject "executing baseline overlay drift"

if [ "${MCWEB_ZERO_0019_LEGACY_ENVELOPE_SELF_TEST:-0}" = 1 ]; then
  PROVENANCE_WORK=$(mktemp -d /private/tmp/mcweb-zero-0019-suite-provenance.XXXXXX)
  cp "$PROVENANCE18" "$PROVENANCE_WORK/helper18-mutated.sh"
  printf '\n' >>"$PROVENANCE_WORK/helper18-mutated.sh"
  if verify_helper18_binding "$PROVENANCE_WORK/helper18-mutated.sh" \
      "legacy-provenance-helper18-sha256=$EXPECTED_PROVENANCE18_SHA"; then
    reject "helper18 drift self-negative accepted"
  fi
  if verify_helper18_binding "$PROVENANCE18" \
      'legacy-provenance-helper18-sha256=0000000000000000000000000000000000000000000000000000000000000000'; then
    reject "helper18 envelope mismatch self-negative accepted"
  fi
  verify_helper18_binding "$PROVENANCE18" \
    "legacy-provenance-helper18-sha256=$EXPECTED_PROVENANCE18_SHA" \
    || reject "helper18 positive binding failed"
  checker_sha=$(hash_of "$BOUNDARY19")
  boundary_sample="$PROVENANCE_WORK/boundary-envelope.log"
  {
    printf '%s\n' 'audit=0019-final-patch-boundary' \
      'command=OpenJDK/tests/check-zero-0019-patch-boundary.sh' \
      'started-epoch=1'
    printf 'script-sha256=%s\n' "$checker_sha"
    printf 'patch0015-sha256=%s\n' "$EXPECTED_PATCH15_SHA"
    printf 'patch0016-sha256=%s\n' "$EXPECTED_PATCH16_SHA"
    printf 'patch0017-sha256=%s\n' "$EXPECTED_PATCH17_SHA"
    printf 'patch0018-sha256=%s\n' "$EXPECTED_PATCH18_SHA"
    printf 'patch0019-sha256=%s\n' "$EXPECTED_PATCH19_SHA"
    printf '%s\n' \
      'ACCEPT patch-boundary clean-base-forward-0019-reverse-0019-exact-0018-postimages' \
      'exit=0' 'finished-epoch=2'
  } >"$boundary_sample"
  boundary_checker_fields_exact "$boundary_sample" "$checker_sha" \
    || reject "boundary exact-one positive failed"
  for duplicate in command script patch terminal; do
    candidate="$PROVENANCE_WORK/boundary-envelope-$duplicate.log"
    cp "$boundary_sample" "$candidate"
    case "$duplicate" in
      command) printf '%s\n' 'command=OpenJDK/tests/check-zero-0019-patch-boundary.sh' >>"$candidate" ;;
      script) printf 'script-sha256=%s\n' "$checker_sha" >>"$candidate" ;;
      patch) printf 'patch0019-sha256=%s\n' "$EXPECTED_PATCH19_SHA" >>"$candidate" ;;
      terminal) printf '%s\n' 'exit=0' 'finished-epoch=2' >>"$candidate" ;;
    esac
    if boundary_checker_fields_exact "$candidate" "$checker_sha"; then
      reject "boundary duplicate-$duplicate self-negative accepted"
    fi
  done
  printf '%s\n' '0019-legacy-envelope-self-negatives=pass helper18-drift=reject helper18-envelope-mismatch=reject boundary-exact-one=pass boundary-duplicates=command,script,patch,terminal:reject count=6'
  exit 0
fi

PROVENANCE_WORK=$(mktemp -d /private/tmp/mcweb-zero-0019-suite-provenance.XXXXXX)
"$PROVENANCE19" "$ROOT" "$JDK" "$PROVENANCE_WORK" >/dev/null \
  || reject "0019 provenance preflight failed"
rm -rf -- "$PROVENANCE_WORK"
PROVENANCE_WORK=

SUITE_SHA=$(hash_of "$0")
PROVENANCE_SHA=$(hash_of "$PROVENANCE19")

publish_record() {
  temp_log=$1
  final_log=$2
  if [ "$RUNTIME_GATE_LOCK_HELD" -eq 0 ]; then
    runtime_gate_lock_acquire || reject "cannot acquire lock to publish $final_log"
  fi
  mv -f -- "$temp_log" "$final_log"
  runtime_gate_lock_release || reject "cannot release lock after publishing $final_log"
}

run_record() {
  name=$1
  script_rel=$2
  accept_marker=$3
  lock_mode=$4
  script="$ROOT/../$script_rel"
  final_log="/private/tmp/mcweb-0019-audit-$name.log"
  started=$(date +%s)
  temp_log="/private/tmp/.mcweb-0019-audit-$name.$started.$$.tmp"
  failure_log="/private/tmp/mcweb-0019-audit-$name.failure.$started.$$.log"
  [ -x "$script" ] || reject "gate is not executable: $script_rel"

  if [ "$lock_mode" = outer ]; then
    runtime_gate_lock_acquire || reject "another Zero runtime gate owns the lock: $name"
  fi
  {
    printf '%s\n' 'audit=0019-final'
    if [ "$name" != patch-boundary ]; then
      printf 'command=%s\n' "$script_rel"
      printf 'started-epoch=%s\n' "$started"
      printf 'script-sha256=%s\n' "$(hash_of "$script")"
    fi
    printf 'record-producer=%s\n' "$SUITE_COMMAND"
    printf 'record-producer-sha256=%s\n' "$SUITE_SHA"
    printf 'provenance-helper-sha256=%s\n' "$PROVENANCE_SHA"
    printf 'legacy-provenance-helper18-sha256=%s\n' "$PROVENANCE18_SHA"
    if [ "$name" != patch-boundary ]; then
      printf 'patch0015-sha256=%s\n' "$PATCH15_SHA"
      printf 'patch0016-sha256=%s\n' "$PATCH16_SHA"
      printf 'patch0017-sha256=%s\n' "$PATCH17_SHA"
      printf 'patch0018-sha256=%s\n' "$PATCH18_SHA"
      printf 'patch0019-sha256=%s\n' "$PATCH19_SHA"
    fi
    printf 'legacy-provenance-context=final-0019\n'
    printf 'runtime-source-final-0019 globals=%s interpreter=%s baseline=%s\n' \
      "$EXPECTED_OVERLAY_GLOBALS_SHA" "$EXPECTED_OVERLAY_INTERPRETER_SHA" \
      "$EXPECTED_OVERLAY_BASELINE_SHA"
  } >"$temp_log"

  set +e
  TIMEOUT="$TIMEOUT" MCWEB_ZERO_LEGACY_PROVENANCE_CONTEXT=final-0019 \
    "$script" >>"$temp_log" 2>&1
  status=$?
  set -e
  finished=$(date +%s)
  if [ "$finished" -le "$started" ]; then
    sleep 1
    finished=$(date +%s)
  fi
  if [ "$status" -ne 0 ]; then
    printf 'exit=%s\nfinished-epoch=%s\n' "$status" "$finished" >>"$temp_log"
    mv -f -- "$temp_log" "$failure_log"
    runtime_gate_lock_release 2>/dev/null || true
    reject "gate failed name=$name status=$status log=$failure_log"
  fi
  [ "$(rg -c -x -F "$accept_marker" "$temp_log" || printf 0)" -eq 1 ] \
    || {
      printf 'exit=97\nfinished-epoch=%s\n' "$finished" >>"$temp_log"
      mv -f -- "$temp_log" "$failure_log"
      runtime_gate_lock_release 2>/dev/null || true
      reject "terminal ACCEPT mismatch name=$name log=$failure_log"
    }
  [ "$(rg -c '^ACCEPT ' "$temp_log" || printf 0)" -eq 1 ] \
    || {
      printf 'exit=98\nfinished-epoch=%s\n' "$finished" >>"$temp_log"
      mv -f -- "$temp_log" "$failure_log"
      runtime_gate_lock_release 2>/dev/null || true
      reject "generic ACCEPT mismatch name=$name log=$failure_log"
    }
  if [ "$name" = patch-boundary ]; then
    boundary_checker_fields_exact "$temp_log" "$(hash_of "$script")" \
      || reject "boundary checker-owned envelope duplication"
  else
    printf 'exit=0\nfinished-epoch=%s\n' "$finished" >>"$temp_log"
  fi
  publish_record "$temp_log" "$final_log"
  printf 'suite-lane=%s status=pass log=%s\n' "$name" "$final_log"
}

run_record setup OpenJDK/tests/run-zero-setup-transaction.sh \
  'ACCEPT setup transaction mock gate' outer
run_record patch-boundary OpenJDK/tests/check-zero-0019-patch-boundary.sh \
  'ACCEPT patch-boundary clean-base-forward-0019-reverse-0019-exact-0018-postimages' internal
if [ "${MCWEB_ZERO_0019_LEGACY_SETUP_BOUNDARY_ONLY:-0}" = 1 ]; then
  boundary_log=/private/tmp/mcweb-0019-audit-patch-boundary.log
  [ "$(rg -c -x -F 'audit=0019-final' "$boundary_log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "record-producer=$SUITE_COMMAND" "$boundary_log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "record-producer-sha256=$SUITE_SHA" "$boundary_log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "provenance-helper-sha256=$PROVENANCE_SHA" "$boundary_log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "legacy-provenance-helper18-sha256=$PROVENANCE18_SHA" "$boundary_log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F 'legacy-provenance-context=final-0019' "$boundary_log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "runtime-source-final-0019 globals=$EXPECTED_OVERLAY_GLOBALS_SHA interpreter=$EXPECTED_OVERLAY_INTERPRETER_SHA baseline=$EXPECTED_OVERLAY_BASELINE_SHA" "$boundary_log" || printf 0)" -eq 1 ] \
    || reject "focused boundary producer-owned envelope drift"
  printf '%s\n' 'ACCEPT 0019 final legacy setup+boundary only'
  exit 0
fi
run_record m1-group OpenJDK/tests/run-zero-linked-group.sh \
  'ACCEPT M1-A direct+guard slice' outer
run_record m1-gc OpenJDK/tests/run-zero-linked-gc.sh \
  'ACCEPT M1-B1 linked oop store slice' outer
run_record m1-alloc OpenJDK/tests/run-zero-linked-alloc-bail.sh \
  'ACCEPT M1-B2 allocation-bail/root-liveness slice' outer
run_record m1-class-init OpenJDK/tests/run-zero-linked-class-init.sh \
  'ACCEPT M1-C class-init fallback slice (second successful access interpreter-only)' outer
run_record m1-virtual OpenJDK/tests/run-zero-linked-virtual.sh \
  'ACCEPT M1-D1 exact-class invokevirtual guard slice' outer
run_record m1-idiv OpenJDK/tests/run-zero-linked-idiv.sh \
  'ACCEPT M1-E1 same-frame idiv re-execution slice' outer
run_record m1-throw OpenJDK/tests/run-zero-linked-throw.sh \
  'ACCEPT M1-E2 direct-callee throw/invoke-resume slice' outer
run_record m2a-array OpenJDK/tests/run-zero-linked-array.sh \
  'ACCEPT M2-A int[] load linked-success plus canonical fallback slice' internal
run_record m2b-store OpenJDK/tests/run-zero-linked-array-store.sh \
  'ACCEPT M2-B int[] store linked-success plus canonical fallback slice' internal
run_record p1-performance OpenJDK/tests/run-zero-linked-performance.sh \
  'ACCEPT M1-P1b synthetic emitter hot-path benchmark evidence' internal

printf '%s\n' 'ACCEPT 0019 final legacy suite'
