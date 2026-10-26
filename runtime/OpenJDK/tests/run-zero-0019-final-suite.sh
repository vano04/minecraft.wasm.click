#!/bin/sh
# Serial OSS-only final 0019 producer. Child runtime gates own the shared lock;
# this parent acquires it only after every child exits, for atomic publication.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK_HELPER=$ROOT/tests/zero-runtime-gate-lock.sh
NESTED_CHECKER=$ROOT/tests/check-zero-nested-evidence.mjs
MODULE_PROVENANCE_CHECKER=$ROOT/tests/check-zero-0019-module-provenance.mjs
STARTED_EPOCH=$(date +%s)
RUN_ID=$STARTED_EPOCH.$$
WORK=$(mktemp -d /private/tmp/mcweb-zero-0019-final-suite.XXXXXX)
FINAL_EVIDENCE=/private/tmp/mcweb-zero-0019-final-accept.$RUN_ID
STAGE=$FINAL_EVIDENCE.tmp.$$
LEGACY_PRODUCER=$ROOT/tests/run-zero-0019-final-legacy-suite.sh
LEGACY_PROVENANCE18=$ROOT/tests/check-zero-0018-legacy-provenance.sh
SETUP_GATE=$ROOT/tests/run-zero-setup-transaction.sh
BOUNDARY_GATE=$ROOT/tests/check-zero-0019-patch-boundary.sh
M1_GROUP_GATE=$ROOT/tests/run-zero-linked-group.sh
M1_GC_GATE=$ROOT/tests/run-zero-linked-gc.sh
M1_ALLOC_GATE=$ROOT/tests/run-zero-linked-alloc-bail.sh
M1_CLASS_INIT_GATE=$ROOT/tests/run-zero-linked-class-init.sh
M1_VIRTUAL_GATE=$ROOT/tests/run-zero-linked-virtual.sh
M1_IDIV_GATE=$ROOT/tests/run-zero-linked-idiv.sh
M1_THROW_GATE=$ROOT/tests/run-zero-linked-throw.sh
M2A_GATE=$ROOT/tests/run-zero-linked-array.sh
M2B_GATE=$ROOT/tests/run-zero-linked-array-store.sh
P1_GATE=$ROOT/tests/run-zero-linked-performance.sh
C1_GATE=$ROOT/tests/run-zero-linked-ref-array-load.sh
C2_GATE=$ROOT/tests/run-zero-linked-ref-array-store-c2.sh
C3A_STATIC=$ROOT/tests/run-zero-reference-store-group-static.sh
C3A_COLD=$ROOT/tests/run-zero-reference-store-group-cold.sh
C3A_FOCUSED=$ROOT/tests/run-zero-reference-store-group-focused.sh
C3A_PUBLICATION=$ROOT/tests/run-zero-reference-store-group-perf-publication.sh
C3A_PERF=$ROOT/tests/run-zero-reference-store-group-perf.sh
C1_ROOT=/private/tmp/mcweb-zero-linked-ref-array-load-0019-accept.$RUN_ID
C2_COLD_ROOT=/private/tmp/mcweb-zero-linked-ref-array-store-c2-cold-0019-accept.$RUN_ID
C2_ROOT=/private/tmp/mcweb-zero-linked-ref-array-store-c2-0019-accept.$RUN_ID
C3A_COLD_ROOT=/private/tmp/mcweb-zero-reference-store-group-c3a-cold-accept.$RUN_ID
C3A_FOCUSED_ROOT=/private/tmp/mcweb-zero-reference-store-group-focused-accept.$RUN_ID
C3A_PUBLICATION_ROOT=/private/tmp/mcweb-zero-reference-store-group-perf-publication-accept.$RUN_ID
C3A_PERF_ROOT=/private/tmp/mcweb-zero-reference-store-group-perf-accept.$RUN_ID
LEGACY_FILES="\
/private/tmp/mcweb-0019-audit-setup.log \
/private/tmp/mcweb-0019-audit-patch-boundary.log \
/private/tmp/mcweb-0019-audit-m1-group.log \
/private/tmp/mcweb-0019-audit-m1-gc.log \
/private/tmp/mcweb-0019-audit-m1-alloc.log \
/private/tmp/mcweb-0019-audit-m1-class-init.log \
/private/tmp/mcweb-0019-audit-m1-virtual.log \
/private/tmp/mcweb-0019-audit-m1-idiv.log \
/private/tmp/mcweb-0019-audit-m1-throw.log \
/private/tmp/mcweb-0019-audit-m2a-array.log \
/private/tmp/mcweb-0019-audit-m2b-store.log \
/private/tmp/mcweb-0019-audit-p1-performance.log"
PATCH19=$ROOT/patches/0019-zero-wasm-reference-store-group.patch
GLOBALS=$ROOT/work/jdk25/src/hotspot/cpu/zero/globals_zero.hpp
INTERPRETER=$ROOT/work/jdk25/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp
BASELINE=$ROOT/work/jdk25/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp
LIBJVM=$ROOT/work/jdk25/build/wasm-zero/jdk/lib/zero/libjvm.so
EXPECTED_LEGACY_PROVENANCE18_SHA=98210162e613050c97e02d881be392b022e6cb04710d7c144698d9d32d70a310
EXPECTED_SETUP_GATE_SHA=8324b23ee5838b5b8ef7be643a1c3b5b747f7b649ef4cf7f46bd61aa631aec46
EXPECTED_BOUNDARY_GATE_SHA=2469f814f314fe7a90d7160879417a549c6599e46f19b012d78130ba9de95e73
EXPECTED_M1_GROUP_GATE_SHA=0bee34a019510190a5d63633996c214e6fcc6fc59aeaf95a520a556514a30998
EXPECTED_M1_GC_GATE_SHA=08fda4432ecd45870f87a87f31f06af712582e42be56a956ac717f02003c1cfd
EXPECTED_M1_ALLOC_GATE_SHA=a208b0ffe0ced68caa765aea94cd8f2d3daffab250ee9c1848c745d88b242a42
EXPECTED_M1_CLASS_INIT_GATE_SHA=169f24b2d8ae0b2945c8ca800c5e029d0face5874ce3739ce2112955e796c8a1
EXPECTED_M1_VIRTUAL_GATE_SHA=2ae7eed2eaa5c093b1b74293a4b8015f799622c96f88c6f00dd0d01ed5823e4e
EXPECTED_M1_IDIV_GATE_SHA=054a139860b093a41b0433e0714ac476c1f690ef76b72132905e41043ce5e0b9
EXPECTED_M1_THROW_GATE_SHA=72d232cc31700e856be550ceb4347595fc86e0bc68605c192c00f6f0b8084396
EXPECTED_M2A_GATE_SHA=b813e0af5dc645ab4d11aaa29b83ceceb68460bbbade802f719f8f750d38fe1c
EXPECTED_M2B_GATE_SHA=3106c47100cef41fbfeb8e0812993c4aff2a35eaff8c86741e788fc6de0471e0
EXPECTED_P1_GATE_SHA=5e878dcc641ea06eaf0b8bd801b57568cc9be26f5280f7cbd5b51a5adf26550d

reject() {
  printf 'REJECT 0019 final suite: %s work=%s stage=%s\n' "$*" "$WORK" "$STAGE" >&2
  exit 1
}

cleanup() {
  rc=$?
  trap - EXIT INT TERM
  runtime_gate_lock_release 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT INT TERM

hash_of() { shasum -a 256 "$1" | awk '{print $1}'; }

for input in "$LOCK_HELPER" "$NESTED_CHECKER" "$MODULE_PROVENANCE_CHECKER" \
    "$LEGACY_PROVENANCE18" "$SETUP_GATE" "$BOUNDARY_GATE" \
    "$M1_GROUP_GATE" "$M1_GC_GATE" "$M1_ALLOC_GATE" "$M1_CLASS_INIT_GATE" \
    "$M1_VIRTUAL_GATE" "$M1_IDIV_GATE" "$M1_THROW_GATE" \
    "$M2A_GATE" "$M2B_GATE" "$P1_GATE" \
    "$LEGACY_PRODUCER" "$C1_GATE" \
    "$C2_GATE" "$C3A_STATIC" "$C3A_COLD" "$C3A_FOCUSED" \
    "$C3A_PUBLICATION" "$C3A_PERF" "$PATCH19" "$GLOBALS" "$INTERPRETER" \
    "$BASELINE" "$LIBJVM"; do
  [ -f "$input" ] || reject "input missing: $input"
done
[ "$(hash_of "$PATCH19")" = 983ed617633fbf9b2635a3a175dfbf96850c72412388f3fb6474e9364e935905 ] \
  || reject "0019 patch drift"
[ "$(hash_of "$GLOBALS")" = bd76b9d3df38fc45892a45b9ebb5d54b1d5fb8fec5917a47929ef8e634082265 ] \
  || reject "globals postimage drift"
[ "$(hash_of "$INTERPRETER")" = 08e457e0a1551d8f3c3c16b0b4aa1f2608f630babe3ccd54f3e1fba316fc3676 ] \
  || reject "interpreter postimage drift"
[ "$(hash_of "$BASELINE")" = d2276be03aa03375fa59e9ccae10fee21b65f63d30c509f9fdfcbac349573420 ] \
  || reject "baseline postimage drift"
[ "$(hash_of "$LIBJVM")" = ab1f8ae6fc79d5e376f755f2196191078bbd347e73663a92d6ef530819496a6a ] \
  || reject "runtime drift"
[ "$(hash_of "$LEGACY_PROVENANCE18")" = "$EXPECTED_LEGACY_PROVENANCE18_SHA" ] \
  || reject "legacy provenance helper18 drift"
[ "$(hash_of "$SETUP_GATE")" = "$EXPECTED_SETUP_GATE_SHA" ] || reject "setup gate drift"
[ "$(hash_of "$BOUNDARY_GATE")" = "$EXPECTED_BOUNDARY_GATE_SHA" ] || reject "boundary gate drift"
[ "$(hash_of "$M1_GROUP_GATE")" = "$EXPECTED_M1_GROUP_GATE_SHA" ] || reject "M1 group gate drift"
[ "$(hash_of "$M1_GC_GATE")" = "$EXPECTED_M1_GC_GATE_SHA" ] || reject "M1 GC gate drift"
[ "$(hash_of "$M1_ALLOC_GATE")" = "$EXPECTED_M1_ALLOC_GATE_SHA" ] || reject "M1 alloc gate drift"
[ "$(hash_of "$M1_CLASS_INIT_GATE")" = "$EXPECTED_M1_CLASS_INIT_GATE_SHA" ] || reject "M1 class-init gate drift"
[ "$(hash_of "$M1_VIRTUAL_GATE")" = "$EXPECTED_M1_VIRTUAL_GATE_SHA" ] || reject "M1 virtual gate drift"
[ "$(hash_of "$M1_IDIV_GATE")" = "$EXPECTED_M1_IDIV_GATE_SHA" ] || reject "M1 idiv gate drift"
[ "$(hash_of "$M1_THROW_GATE")" = "$EXPECTED_M1_THROW_GATE_SHA" ] || reject "M1 throw gate drift"
[ "$(hash_of "$M2A_GATE")" = "$EXPECTED_M2A_GATE_SHA" ] || reject "M2A gate drift"
[ "$(hash_of "$M2B_GATE")" = "$EXPECTED_M2B_GATE_SHA" ] || reject "M2B gate drift"
[ "$(hash_of "$P1_GATE")" = "$EXPECTED_P1_GATE_SHA" ] || reject "P1 gate drift"
[ ! -e "$FINAL_EVIDENCE" ] && [ ! -e "$STAGE" ] || reject "final evidence collision"
. "$LOCK_HELPER"
[ "${RUNTIME_GATE_LOCK_HELD:-0}" -eq 0 ] || reject "parent entered with runtime lock held"
mkdir -p "$WORK/logs"
node "$MODULE_PROVENANCE_CHECKER" --self-test \
  >"$WORK/module-provenance-self-test.log" 2>&1 \
  || reject "module provenance self-test"

legacy_asset_set_exact() {
  [ "$#" -eq 12 ] \
    && [ "$1" = "$SETUP_GATE" ] && [ "$2" = "$BOUNDARY_GATE" ] \
    && [ "$3" = "$M1_GROUP_GATE" ] && [ "$4" = "$M1_GC_GATE" ] \
    && [ "$5" = "$M1_ALLOC_GATE" ] && [ "$6" = "$M1_CLASS_INIT_GATE" ] \
    && [ "$7" = "$M1_VIRTUAL_GATE" ] && [ "$8" = "$M1_IDIV_GATE" ] \
    && [ "$9" = "$M1_THROW_GATE" ] && [ "${10}" = "$M2A_GATE" ] \
    && [ "${11}" = "$M2B_GATE" ] && [ "${12}" = "$P1_GATE" ]
}

legacy_record_asset_matches() {
  record=$1
  command=$2
  asset=$3
  asset_sha=$(hash_of "$asset")
  [ "$(rg -c -x -F "command=$command" "$record" || printf 0)" -eq 1 ] \
    && [ "$(rg -c -x -F "script-sha256=$asset_sha" "$record" || printf 0)" -eq 1 ]
}

legacy_asset_set_exact "$SETUP_GATE" "$BOUNDARY_GATE" "$M1_GROUP_GATE" \
  "$M1_GC_GATE" "$M1_ALLOC_GATE" "$M1_CLASS_INIT_GATE" "$M1_VIRTUAL_GATE" \
  "$M1_IDIV_GATE" "$M1_THROW_GATE" "$M2A_GATE" "$M2B_GATE" "$P1_GATE" \
  || reject "legacy producer asset closure"
if legacy_asset_set_exact "$SETUP_GATE" "$BOUNDARY_GATE" "$M1_GROUP_GATE" \
    "$M1_GC_GATE" "$M1_ALLOC_GATE" "$M1_CLASS_INIT_GATE" "$M1_VIRTUAL_GATE" \
    "$M1_IDIV_GATE" "$M1_THROW_GATE" "$M2A_GATE" "$M2B_GATE"; then
  reject "legacy producer omission self-negative accepted"
fi
{
  for asset in "$SETUP_GATE" "$BOUNDARY_GATE" "$M1_GROUP_GATE" "$M1_GC_GATE" \
      "$M1_ALLOC_GATE" "$M1_CLASS_INIT_GATE" "$M1_VIRTUAL_GATE" "$M1_IDIV_GATE" \
      "$M1_THROW_GATE" "$M2A_GATE" "$M2B_GATE" "$P1_GATE"; do
    printf 'legacy-producer path=%s sha256=%s bytes=%s\n' "${asset#$ROOT/}" \
      "$(hash_of "$asset")" "$(wc -c <"$asset" | tr -d ' ')"
  done
} >"$WORK/legacy-producer-assets.log"
legacy_record_sample=$WORK/legacy-record-asset-sample.log
{
  printf '%s\n' 'command=OpenJDK/tests/run-zero-setup-transaction.sh'
  printf 'script-sha256=%s\n' "$(hash_of "$SETUP_GATE")"
} >"$legacy_record_sample"
legacy_record_asset_matches "$legacy_record_sample" \
  OpenJDK/tests/run-zero-setup-transaction.sh "$SETUP_GATE" \
  || reject "legacy producer asset positive self-test"
cp "$SETUP_GATE" "$WORK/setup-gate-mutated.sh"
printf '\n' >>"$WORK/setup-gate-mutated.sh"
if legacy_record_asset_matches "$legacy_record_sample" \
    OpenJDK/tests/run-zero-setup-transaction.sh "$WORK/setup-gate-mutated.sh"; then
  reject "legacy producer drift self-negative accepted"
fi
printf '%s\n' 'legacy-producer-assets-self-negatives=pass exact12=1 omission=reject drift=reject' \
  >"$WORK/legacy-producer-assets-self-test.log"

child_diagnostics_clean() {
  body=$1
  allow=$2
  bad=$WORK/child-diagnostics.$$.log
  : >"$bad"
  rg -i '(^|[^[:alnum:]_])(REJECT|ERROR|FATAL|FAILURE|PANIC)([^[:alnum:]_]|$)|broken[- ]pipe|SIGPIPE|uncaught|UnhandledPromiseRejection|Pthread[^[:cntrl:]]*error|hs_err|wasm trap|pending[=:]' \
    "$body" >"$bad" || true
  if [ "$allow" = none ]; then
    [ ! -s "$bad" ]
    return
  fi
  [ -s "$bad" ] || return 1
  while IFS= read -r diagnostic; do
    printf '%s\n' "$diagnostic" | rg -qx "$allow" || return 1
  done <"$bad"
}

child_log_valid() {
  log=$1
  expected_header=$2
  expected_footer=$3
  marker=$4
  allow=$5
  body=$WORK/child-body.$$.log
  [ "$(head -n 1 "$log")" = "$(cat "$expected_header")" ] \
    && [ "$(tail -n 1 "$log")" = "$(cat "$expected_footer")" ] \
    && [ "$(rg -c '^lane=[^ ]+ started-epoch=[0-9]+ command=.+ $' "$log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c '^lane=[^ ]+ exit=[0-9]+ finished-epoch=[0-9]+$' "$log" || printf 0)" -eq 1 ] \
    || return 1
  sed '1d;$d' "$log" >"$body"
  [ "$(rg -c -x "$marker" "$body" || printf 0)" -eq 1 ] \
    && [ "$(rg -c '(^|[= ])ACCEPT([ =]|$)' "$body" || printf 0)" -eq 1 ] \
    && child_diagnostics_clean "$body" "$allow"
}

generate_top_index() {
  closure_root=$1
  (cd "$closure_root" && find . -type f \
      ! -path './evidence.index' ! -path './evidence.index.sha256' \
      -print | LC_ALL=C sort | while IFS= read -r closure_path; do
        printf '%s  %s  %s\n' "$(shasum -a 256 "$closure_path" | awk '{print $1}')" \
          "$(wc -c <"$closure_path" | tr -d ' ')" "${closure_path#./}"
      done >evidence.index)
  (cd "$closure_root" && shasum -a 256 evidence.index >evidence.index.sha256)
}

verify_top_closure() {
  closure_root=$1
  [ -s "$closure_root/evidence.index" ] \
    && [ -s "$closure_root/evidence.index.sha256" ] || return 1
  (cd "$closure_root" && shasum -a 256 -c evidence.index.sha256 >/dev/null) \
    || return 1
  rows=$(wc -l <"$closure_root/evidence.index" | tr -d ' ')
  total=$(find "$closure_root" -type f | wc -l | tr -d ' ')
  [ "$total" -eq $((rows + 2)) ] || return 1
  actual_paths=$WORK/top-closure-actual.$$.paths
  indexed_paths=$WORK/top-closure-indexed.$$.paths
  (cd "$closure_root" && find . -type f \
      ! -path './evidence.index' ! -path './evidence.index.sha256' \
      -print | sed 's#^\./##' | LC_ALL=C sort) >"$actual_paths"
  awk '
    NF != 3 { exit 1 }
    length($1) != 64 || $1 !~ /^[0-9a-f]+$/ { exit 1 }
    $2 !~ /^[0-9]+$/ { exit 1 }
    $3 == "" || $3 ~ /^\// || $3 ~ /(^|\/)\.\.($|\/)/ { exit 1 }
    { print $3 }
  ' "$closure_root/evidence.index" >"$indexed_paths" || return 1
  cmp -s "$actual_paths" "$indexed_paths" || return 1
  [ "$(LC_ALL=C sort "$indexed_paths" | uniq -d | wc -l | tr -d ' ')" -eq 0 ] \
    || return 1
  while IFS=' ' read -r expected_sha expected_bytes relative extra; do
    [ -z "${extra:-}" ] && [ -f "$closure_root/$relative" ] || return 1
    [ "$(hash_of "$closure_root/$relative")" = "$expected_sha" ] || return 1
    [ "$(wc -c <"$closure_root/$relative" | tr -d ' ')" = "$expected_bytes" ] \
      || return 1
  done <"$closure_root/evidence.index"
  nested_indexes=$(find "$closure_root/nested" -type f -name evidence.index 2>/dev/null \
    | LC_ALL=C sort)
  nested_sidecars=$(find "$closure_root/nested" -type f -name evidence.index.sha256 2>/dev/null \
    | LC_ALL=C sort)
  [ -n "$nested_indexes" ] && [ -n "$nested_sidecars" ] || return 1
  [ "$(printf '%s\n' "$nested_indexes" | wc -l | tr -d ' ')" \
      -eq "$(printf '%s\n' "$nested_sidecars" | wc -l | tr -d ' ')" ] || return 1
  printf '%s\n' "$nested_indexes" | while IFS= read -r nested_index; do
    nested_dir=$(dirname "$nested_index")
    [ -s "$nested_dir/evidence.index.sha256" ] \
      && (cd "$nested_dir" && shasum -a 256 -c evidence.index.sha256 >/dev/null) \
      || exit 1
  done || return 1
  printf '%s\n' "$nested_sidecars" | while IFS= read -r nested_sidecar; do
    [ -s "$(dirname "$nested_sidecar")/evidence.index" ] || exit 1
  done
}

child_sample=$WORK/child-admission-sample.log
child_header=$WORK/child-admission-header.log
child_footer=$WORK/child-admission-footer.log
printf '%s\n' 'lane=self started-epoch=1 command=self-test ' >"$child_header"
printf '%s\n' 'lane=self exit=0 finished-epoch=2' >"$child_footer"
{
  cat "$child_header"
  printf '%s\n' 'intentional-negative: REJECT expected' 'SELF=ACCEPT exact'
  cat "$child_footer"
} >"$child_sample"
child_log_valid "$child_sample" "$child_header" "$child_footer" \
  '^SELF=ACCEPT exact$' '^intentional-negative: REJECT expected$' \
  || reject "child admission allowlist positive"
for mutation in duplicate-accept unrelated-reject pending wrong-footer; do
  candidate=$WORK/child-admission-$mutation.log
  cp "$child_sample" "$candidate"
  case "$mutation" in
    duplicate-accept)
      { head -n 1 "$candidate"; printf '%s\n' 'SELF=ACCEPT exact'; tail -n +2 "$candidate"; } \
        >"$candidate.tmp" && mv "$candidate.tmp" "$candidate" ;;
    unrelated-reject)
      { head -n 1 "$candidate"; printf '%s\n' 'REJECT unrelated'; tail -n +2 "$candidate"; } \
        >"$candidate.tmp" && mv "$candidate.tmp" "$candidate" ;;
    pending)
      { head -n 1 "$candidate"; printf '%s\n' 'state pending=fresh-runtime'; tail -n +2 "$candidate"; } \
        >"$candidate.tmp" && mv "$candidate.tmp" "$candidate" ;;
    wrong-footer) printf '%s\n' 'lane=self exit=0 finished-epoch=3' >>"$candidate" ;;
  esac
  if child_log_valid "$candidate" "$child_header" "$child_footer" \
      '^SELF=ACCEPT exact$' '^intentional-negative: REJECT expected$'; then
    reject "child admission $mutation self-negative accepted"
  fi
done
printf '%s\n' 'child-admission-self-negatives=pass exact-accept=1 exact-order=1 diagnostics=reject pending=reject allowlist=exact count=4' \
  >"$WORK/child-admission-self-test.log"

closure_pristine=$WORK/top-closure-pristine
mkdir -p "$closure_pristine/nested/demo"
printf '%s\n' 'root-payload' >"$closure_pristine/root.txt"
printf '%s\n' 'nested-payload' >"$closure_pristine/nested/demo/payload.txt"
(
  cd "$closure_pristine/nested/demo"
  printf '%s  %s  %s\n' "$(shasum -a 256 payload.txt | awk '{print $1}')" \
    "$(wc -c <payload.txt | tr -d ' ')" payload.txt >evidence.index
  shasum -a 256 evidence.index >evidence.index.sha256
)
generate_top_index "$closure_pristine"
verify_top_closure "$closure_pristine" || reject "top closure positive self-test"
closure_global=$WORK/top-closure-global-basename
cp -R "$closure_pristine" "$closure_global"
(
  cd "$closure_global"
  find . -type f ! -name evidence.index ! -name evidence.index.sha256 \
    -print | LC_ALL=C sort | while IFS= read -r closure_path; do
      printf '%s  %s  %s\n' "$(shasum -a 256 "$closure_path" | awk '{print $1}')" \
        "$(wc -c <"$closure_path" | tr -d ' ')" "${closure_path#./}"
    done >evidence.index
  shasum -a 256 evidence.index >evidence.index.sha256
)
if verify_top_closure "$closure_global"; then
  reject "global-basename exclusion self-negative accepted"
fi
for mutation in omit-index omit-sidecar tamper-index tamper-sidecar; do
  candidate=$WORK/top-closure-$mutation
  cp -R "$closure_pristine" "$candidate"
  case "$mutation" in
    omit-index)
      rg -v 'nested/demo/evidence\.index$' "$candidate/evidence.index" \
        >"$candidate/evidence.index.tmp"
      mv "$candidate/evidence.index.tmp" "$candidate/evidence.index"
      (cd "$candidate" && shasum -a 256 evidence.index >evidence.index.sha256) ;;
    omit-sidecar)
      rg -v 'nested/demo/evidence\.index\.sha256$' "$candidate/evidence.index" \
        >"$candidate/evidence.index.tmp"
      mv "$candidate/evidence.index.tmp" "$candidate/evidence.index"
      (cd "$candidate" && shasum -a 256 evidence.index >evidence.index.sha256) ;;
    tamper-index) printf '\n' >>"$candidate/nested/demo/evidence.index" ;;
    tamper-sidecar) printf '\n' >>"$candidate/nested/demo/evidence.index.sha256" ;;
  esac
  if verify_top_closure "$candidate"; then
    reject "top closure $mutation self-negative accepted"
  fi
done
printf '%s\n' 'top-closure-self-negatives=pass exact-root-exclusion=1 global-basename=reject omit-index=reject omit-sidecar=reject tamper-index=reject tamper-sidecar=reject count=5' \
  >"$WORK/top-closure-self-test.log"

if [ "${MCWEB_ZERO_0019_FINAL_STATIC_SELF_TEST:-0}" = 1 ]; then
  cat "$WORK/legacy-producer-assets-self-test.log"
  cat "$WORK/child-admission-self-test.log"
  cat "$WORK/top-closure-self-test.log"
  printf '%s\n' '0019-final-suite-static-self-test=pass runtime-executed=0 evidence-published=0'
  exit 0
fi

run_child() {
  lane=$1
  marker=$2
  allow=$3
  shift 3
  log=$WORK/logs/$lane.log
  header=$WORK/logs/$lane.header
  footer=$WORK/logs/$lane.footer
  started=$(date +%s)
  printf 'lane=%s started-epoch=%s command=' "$lane" "$started" >"$header"
  printf '%s ' "$@" >>"$header"
  printf '\n' >>"$header"
  cp "$header" "$log"
  set +e
  "$@" >>"$log" 2>&1
  rc=$?
  set -e
  finished=$(date +%s)
  printf 'lane=%s exit=%s finished-epoch=%s\n' "$lane" "$rc" "$finished" >"$footer"
  cat "$footer" >>"$log"
  [ "$rc" -eq 0 ] || reject "child failed lane=$lane log=$log"
  [ "${RUNTIME_GATE_LOCK_HELD:-0}" -eq 0 ] || reject "parent retained child lock lane=$lane"
  [ "$finished" -ge "$started" ] || reject "child epoch order lane=$lane"
  child_log_valid "$log" "$header" "$footer" "$marker" "$allow" \
    || reject "child admission failed lane=$lane log=$log"
  printf 'final-suite-lane=%s status=pass log=%s\n' "$lane" "$log"
}

# The legacy producer emits setup, then the 0019 boundary, then the ten
# retained M1/M2/P1 runtime lanes. It locks only around each owned operation.
run_child legacy '^ACCEPT 0019 final legacy suite$' none "$LEGACY_PRODUCER"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-setup.log \
  OpenJDK/tests/run-zero-setup-transaction.sh "$SETUP_GATE" || reject "setup record asset mismatch"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-patch-boundary.log \
  OpenJDK/tests/check-zero-0019-patch-boundary.sh "$BOUNDARY_GATE" || reject "boundary record asset mismatch"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-m1-group.log \
  OpenJDK/tests/run-zero-linked-group.sh "$M1_GROUP_GATE" || reject "M1 group record asset mismatch"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-m1-gc.log \
  OpenJDK/tests/run-zero-linked-gc.sh "$M1_GC_GATE" || reject "M1 GC record asset mismatch"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-m1-alloc.log \
  OpenJDK/tests/run-zero-linked-alloc-bail.sh "$M1_ALLOC_GATE" || reject "M1 alloc record asset mismatch"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-m1-class-init.log \
  OpenJDK/tests/run-zero-linked-class-init.sh "$M1_CLASS_INIT_GATE" || reject "M1 class-init record asset mismatch"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-m1-virtual.log \
  OpenJDK/tests/run-zero-linked-virtual.sh "$M1_VIRTUAL_GATE" || reject "M1 virtual record asset mismatch"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-m1-idiv.log \
  OpenJDK/tests/run-zero-linked-idiv.sh "$M1_IDIV_GATE" || reject "M1 idiv record asset mismatch"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-m1-throw.log \
  OpenJDK/tests/run-zero-linked-throw.sh "$M1_THROW_GATE" || reject "M1 throw record asset mismatch"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-m2a-array.log \
  OpenJDK/tests/run-zero-linked-array.sh "$M2A_GATE" || reject "M2A record asset mismatch"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-m2b-store.log \
  OpenJDK/tests/run-zero-linked-array-store.sh "$M2B_GATE" || reject "M2B record asset mismatch"
legacy_record_asset_matches /private/tmp/mcweb-0019-audit-p1-performance.log \
  OpenJDK/tests/run-zero-linked-performance.sh "$P1_GATE" || reject "P1 record asset mismatch"
run_child c1 '^m2-c1=ACCEPT fixture-source-sha=[0-9a-f]{64} fixture-jar-sha=[0-9a-f]{64} fixture-jar-bytes=[0-9]+$' \
  '^c1-manifest-self-negatives=pass helper18-omission=reject helper18-drift=reject count=2$' \
  env C1_EVIDENCE_ROOT="$C1_ROOT" "$C1_GATE"
run_child c2-cold '^m2-c2-cold=ACCEPT module-sha=9fee3317bc0061cc17d6968a839b4b15d2dd36cae6cc01d413d3fbe340db2a39 module-bytes=482 wat-mutations=19 evidence-root=/private/tmp/mcweb-zero-linked-ref-array-store-c2-cold-0019-accept\.[0-9]+\.[0-9]+$' none \
  env MCWEB_C2_COLD_ONLY=1 \
  C1_EVIDENCE_ROOT="$C1_ROOT" C2_COLD_EVIDENCE_ROOT="$C2_COLD_ROOT" \
  C2_EVIDENCE_ROOT="$C2_ROOT" "$C2_GATE"
run_child c2 '^m2-c2=ACCEPT module-sha=9fee3317bc0061cc17d6968a839b4b15d2dd36cae6cc01d413d3fbe340db2a39 module-bytes=482$' none env C1_EVIDENCE_ROOT="$C1_ROOT" \
  C2_COLD_EVIDENCE_ROOT="$C2_COLD_ROOT" C2_EVIDENCE_ROOT="$C2_ROOT" "$C2_GATE"
run_child c3a-static '^ACCEPT C3a static final-0019-fresh-run-ready runtime=fresh-built module=fresh-dumped work=/private/tmp/mcweb-zero-reference-store-group-static\.[A-Za-z0-9]{6}$' none "$C3A_STATIC"
run_child c3a-cold '^m2-c3a-cold=ACCEPT module-sha=9b9ab39a8cef7afc616dadc42881ab7ef4d4390ef0f7506a705daeebf0259107 module-bytes=533 wat-mutations=20 evidence-root=/private/tmp/mcweb-zero-reference-store-group-c3a-cold-accept\.[0-9]+\.[0-9]+$' none env \
  C3A_COLD_OUTPUT="$C3A_COLD_ROOT" "$C3A_COLD"
run_child c3a-focused '^m2-c3a-focused=ACCEPT module-sha=9b9ab39a8cef7afc616dadc42881ab7ef4d4390ef0f7506a705daeebf0259107 evidence-root=/private/tmp/mcweb-zero-reference-store-group-focused-accept\.[0-9]+\.[0-9]+$' none env \
  C3A_COLD_EVIDENCE="$C3A_COLD_ROOT" C3A_FOCUSED_OUTPUT="$C3A_FOCUSED_ROOT" \
  "$C3A_FOCUSED"
run_child c3a-publication '^ACCEPT C3a-perf-publication measurement-acceptance=0 evidence=/private/tmp/mcweb-zero-reference-store-group-perf-publication-accept\.[0-9]+\.[0-9]+ start=[0-9]+ finish=[0-9]+ exit=0$' none env \
  C3A_PUBLICATION_OUTPUT="$C3A_PUBLICATION_ROOT" "$C3A_PUBLICATION"
run_child c3a-perf '^ACCEPT C3a-perf measurement-only=1 diagnostic-result=pass evidence=/private/tmp/mcweb-zero-reference-store-group-perf-accept\.[0-9]+\.[0-9]+ start=[0-9]+ finish=[0-9]+ exit=0$' none env \
  C3A_FOCUSED_EVIDENCE="$C3A_FOCUSED_ROOT" \
  C3A_PUBLICATION_EVIDENCE="$C3A_PUBLICATION_ROOT" \
  C3A_PERF_OUTPUT="$C3A_PERF_ROOT" "$C3A_PERF"

for nested in "$C1_ROOT" "$C2_COLD_ROOT" "$C2_ROOT" "$C3A_COLD_ROOT" \
    "$C3A_FOCUSED_ROOT" "$C3A_PUBLICATION_ROOT" "$C3A_PERF_ROOT"; do
  [ -s "$nested/evidence.index" ] && [ -s "$nested/evidence.index.sha256" ] \
    || reject "nested evidence missing: $nested"
  (cd "$nested" && shasum -a 256 -c evidence.index.sha256 >/dev/null) \
    || reject "nested sidecar mismatch: $nested"
done
node "$NESTED_CHECKER" "$C3A_FOCUSED_ROOT" --self-test "$C3A_PUBLICATION_ROOT" \
  >"$WORK/nested-self-test.log" 2>&1 || reject "nested evidence format self-test"
node "$MODULE_PROVENANCE_CHECKER" "$C3A_COLD_ROOT" "$C3A_PERF_ROOT" \
  --run-id "$RUN_ID" >"$WORK/module-provenance.log" 2>&1 \
  || reject "module provenance"
rg -qx '0019-module-provenance production-sha256=9b9ab39a8cef7afc616dadc42881ab7ef4d4390ef0f7506a705daeebf0259107 production-bytes=533 production-index-sha256=[0-9a-f]{64} perf-sha256=13a5cff21e2c98eae7791eda3deca79794a509a5b468efee0ea60fc64494b49d perf-bytes=1096 perf-index-sha256=[0-9a-f]{64} result=pass' \
  "$WORK/module-provenance.log" || reject "module provenance transcript"
PRODUCTION_MODULE_SHA=$(awk '{for (i=1;i<=NF;i++) if ($i ~ /^production-sha256=/) {sub(/^production-sha256=/,"",$i); print $i}}' "$WORK/module-provenance.log")
PRODUCTION_MODULE_BYTES=$(awk '{for (i=1;i<=NF;i++) if ($i ~ /^production-bytes=/) {sub(/^production-bytes=/,"",$i); print $i}}' "$WORK/module-provenance.log")
PERF_MODULE_SHA=$(awk '{for (i=1;i<=NF;i++) if ($i ~ /^perf-sha256=/) {sub(/^perf-sha256=/,"",$i); print $i}}' "$WORK/module-provenance.log")
PERF_MODULE_BYTES=$(awk '{for (i=1;i<=NF;i++) if ($i ~ /^perf-bytes=/) {sub(/^perf-bytes=/,"",$i); print $i}}' "$WORK/module-provenance.log")

# No parent lock is held while a child runs. Acquire only for the final atomic
# publication so another producer cannot replace shared inputs mid-copy.
runtime_gate_lock_acquire || reject "cannot acquire final publication lock"
[ ! -e "$FINAL_EVIDENCE" ] && [ ! -e "$STAGE" ] || reject "final publication collision"
mkdir -p "$STAGE/logs" "$STAGE/legacy" "$STAGE/nested" "$STAGE/assets" "$STAGE/source"
cp "$WORK"/logs/*.log "$WORK/nested-self-test.log" \
  "$WORK/child-admission-self-test.log" "$WORK/legacy-producer-assets.log" \
  "$WORK/legacy-producer-assets-self-test.log" "$WORK/top-closure-self-test.log" \
  "$WORK/module-provenance-self-test.log" "$WORK/module-provenance.log" \
  "$STAGE/logs/"
for legacy_log in $LEGACY_FILES; do
  [ -f "$legacy_log" ] || reject "0019 legacy record closure missing"
  cp "$legacy_log" "$STAGE/legacy/$(basename "$legacy_log")"
done
cp -R "$C1_ROOT" "$STAGE/nested/c1"
cp -R "$C2_COLD_ROOT" "$STAGE/nested/c2-cold"
cp -R "$C2_ROOT" "$STAGE/nested/c2"
cp -R "$C3A_COLD_ROOT" "$STAGE/nested/c3a-cold"
cp -R "$C3A_FOCUSED_ROOT" "$STAGE/nested/c3a-focused"
cp -R "$C3A_PUBLICATION_ROOT" "$STAGE/nested/c3a-publication"
cp -R "$C3A_PERF_ROOT" "$STAGE/nested/c3a-perf"
cp "$PATCH19" "$ROOT/setup.sh" \
  "$ROOT/tests/check-zero-0019-legacy-provenance.sh" "$LEGACY_PRODUCER" \
  "$LEGACY_PROVENANCE18" "$SETUP_GATE" "$BOUNDARY_GATE" \
  "$M1_GROUP_GATE" "$M1_GC_GATE" "$M1_ALLOC_GATE" "$M1_CLASS_INIT_GATE" \
  "$M1_VIRTUAL_GATE" "$M1_IDIV_GATE" "$M1_THROW_GATE" \
  "$M2A_GATE" "$M2B_GATE" "$P1_GATE" \
  "$C1_GATE" "$C2_GATE" "$C3A_STATIC" "$C3A_COLD" "$C3A_FOCUSED" \
  "$C3A_PUBLICATION" "$C3A_PERF" "$0" "$LOCK_HELPER" "$NESTED_CHECKER" \
  "$MODULE_PROVENANCE_CHECKER" \
  "$ROOT/tests/zero-linked-ref-array-load-manifest.sha256" \
  "$ROOT/tests/zero-linked-ref-array-store-c2-manifest.sha256" \
  "$ROOT/tests/zero-reference-store-group-c3a-manifest.sha256" "$STAGE/assets/"
[ "$(hash_of "$STAGE/assets/check-zero-0018-legacy-provenance.sh")" = "$EXPECTED_LEGACY_PROVENANCE18_SHA" ] \
  || reject "copied legacy provenance helper18 drift"
[ "$(hash_of "$STAGE/assets/run-zero-setup-transaction.sh")" = "$EXPECTED_SETUP_GATE_SHA" ] \
  || reject "copied setup gate drift"
[ "$(hash_of "$STAGE/assets/check-zero-0019-patch-boundary.sh")" = "$EXPECTED_BOUNDARY_GATE_SHA" ] \
  || reject "copied boundary gate drift"
[ "$(hash_of "$STAGE/assets/run-zero-linked-group.sh")" = "$EXPECTED_M1_GROUP_GATE_SHA" ] \
  || reject "copied M1 group gate drift"
[ "$(hash_of "$STAGE/assets/run-zero-linked-gc.sh")" = "$EXPECTED_M1_GC_GATE_SHA" ] \
  || reject "copied M1 GC gate drift"
[ "$(hash_of "$STAGE/assets/run-zero-linked-alloc-bail.sh")" = "$EXPECTED_M1_ALLOC_GATE_SHA" ] \
  || reject "copied M1 alloc gate drift"
[ "$(hash_of "$STAGE/assets/run-zero-linked-class-init.sh")" = "$EXPECTED_M1_CLASS_INIT_GATE_SHA" ] \
  || reject "copied M1 class-init gate drift"
[ "$(hash_of "$STAGE/assets/run-zero-linked-virtual.sh")" = "$EXPECTED_M1_VIRTUAL_GATE_SHA" ] \
  || reject "copied M1 virtual gate drift"
[ "$(hash_of "$STAGE/assets/run-zero-linked-idiv.sh")" = "$EXPECTED_M1_IDIV_GATE_SHA" ] \
  || reject "copied M1 idiv gate drift"
[ "$(hash_of "$STAGE/assets/run-zero-linked-throw.sh")" = "$EXPECTED_M1_THROW_GATE_SHA" ] \
  || reject "copied M1 throw gate drift"
[ "$(hash_of "$STAGE/assets/run-zero-linked-array.sh")" = "$EXPECTED_M2A_GATE_SHA" ] \
  || reject "copied M2A gate drift"
[ "$(hash_of "$STAGE/assets/run-zero-linked-array-store.sh")" = "$EXPECTED_M2B_GATE_SHA" ] \
  || reject "copied M2B gate drift"
[ "$(hash_of "$STAGE/assets/run-zero-linked-performance.sh")" = "$EXPECTED_P1_GATE_SHA" ] \
  || reject "copied P1 gate drift"
cp "$GLOBALS" "$INTERPRETER" "$BASELINE" "$STAGE/source/"
FINISHED_EPOCH=$(date +%s)
{
  printf '%s\n' 'audit=0019-final' 'accept=0019-final exit=0'
  printf 'started-epoch=%s finished-epoch=%s\n' "$STARTED_EPOCH" "$FINISHED_EPOCH"
  printf 'serial-order=legacy12-records,c1,c2-cold,c2,c3a-static,c3a-cold,c3a-focused,c3a-publication,c3a-perf\n'
  printf 'patch0019-sha256=%s runtime-sha256=%s\n' "$(hash_of "$PATCH19")" "$(hash_of "$LIBJVM")"
  printf 'source globals=%s interpreter=%s baseline=%s\n' \
    "$(hash_of "$GLOBALS")" "$(hash_of "$INTERPRETER")" "$(hash_of "$BASELINE")"
  printf 'c3a-production-module-sha256=%s c3a-production-module-bytes=%s c3a-perf-module-sha256=%s c3a-perf-module-bytes=%s\n' \
    "$PRODUCTION_MODULE_SHA" "$PRODUCTION_MODULE_BYTES" \
    "$PERF_MODULE_SHA" "$PERF_MODULE_BYTES"
  printf 'claim-scope=synthetic-oss-serialgc-raw32 no-browser-gameplay-fps-chunk-or-moving-gc-claim=1\n'
} >"$STAGE/final.meta"
generate_top_index "$STAGE"
verify_top_closure "$STAGE" || reject "final exact top/nested evidence closure"
sync
mv -- "$STAGE" "$FINAL_EVIDENCE"
runtime_gate_lock_release || reject "cannot release final publication lock"
printf 'ACCEPT 0019 final suite evidence-root=%s evidence-index-sha=%s exit=0\n' \
  "$FINAL_EVIDENCE" "$(hash_of "$FINAL_EVIDENCE/evidence.index")"
