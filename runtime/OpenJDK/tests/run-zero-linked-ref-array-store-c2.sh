#!/bin/sh
# OSS-only M2-C2 checked Object[] store gate. The fixture executes from a class
# directory; the deterministic JAR is provenance/cache input only.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JAVAC=/opt/homebrew/opt/openjdk@25/bin/javac
JAR=/opt/homebrew/opt/openjdk@25/bin/jar
WASM_DIS=/opt/homebrew/bin/wasm-dis
NODE=node
TIMEOUT=/opt/homebrew/bin/timeout
RUN_JAVA=$ROOT/run-java.sh
JDK=$ROOT/work/jdk25
GLOBALS=$JDK/src/hotspot/cpu/zero/globals_zero.hpp
INTERPRETER=$JDK/src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp
BASELINE=$JDK/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp
LIBJVM=$JDK/build/wasm-zero/jdk/lib/zero/libjvm.so
FIXTURE=$ROOT/tests/ZeroReferenceArrayStoreFixture.java
NEAR_MISS=$ROOT/tests/ZeroReferenceArrayStoreNearMiss.java
LOG_CHECKER=$ROOT/tests/check-zero-linked-ref-array-store-c2-log.mjs
WAT_CHECKER=$ROOT/tests/check-zero-linked-ref-array-store-wat.mjs
CLASS_CHECKER=$ROOT/tests/check-zero-reference-array-store-class.mjs
PATCH_BOUNDARY=$ROOT/tests/check-zero-0019-patch-boundary.sh
PROVENANCE19=$ROOT/tests/check-zero-0019-legacy-provenance.sh
PROVENANCE18=$ROOT/tests/check-zero-0018-legacy-provenance.sh
LEGACY_SUITE_PRODUCER=$ROOT/tests/run-zero-0019-final-legacy-suite.sh
PATCH15=$ROOT/patches/0015-zero-wasm-linked-int-array-store.patch
PATCH16=$ROOT/patches/0016-zero-wasm-linked-ref-array-load.patch
PATCH17=$ROOT/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch
PATCH18=$ROOT/patches/0018-zero-wasm-linked-ref-array-store.patch
PATCH19=$ROOT/patches/0019-zero-wasm-reference-store-group.patch
C1_GATE=$ROOT/tests/run-zero-linked-ref-array-load.sh
C1_EVIDENCE=${C1_EVIDENCE_ROOT:?explicit fresh C1_EVIDENCE_ROOT is required}
MANIFEST=$ROOT/tests/zero-linked-ref-array-store-c2-manifest.sha256
LOCK_HELPER=$ROOT/tests/zero-runtime-gate-lock.sh
WORK=$(mktemp -d /private/tmp/mcweb-zero-linked-ref-array-store-c2.XXXXXX)
EVIDENCE=${C2_EVIDENCE_ROOT:?explicit fresh C2_EVIDENCE_ROOT is required}
STAGE=$EVIDENCE.tmp.$$
COLD_EVIDENCE=${C2_COLD_EVIDENCE_ROOT:?explicit fresh C2_COLD_EVIDENCE_ROOT is required}
COLD_STAGE=$COLD_EVIDENCE.tmp.$$
WASM=
RUN_PID=
STARTED_EPOCH=$(date +%s)
LEGACY_EVIDENCE_FILES="\
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
CACHE_MUTATIONS="compiler digest bytes memory metadata slot card-layout poison"

terminate_owned() {
  root=$1
  [ -n "$root" ] || return 0
  kill -TERM "$root" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    kill -0 "$root" 2>/dev/null || return 0
    sleep 0.05
  done
  kill -KILL "$root" 2>/dev/null || true
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ -z "$RUN_PID" ] || terminate_owned "$RUN_PID"
  runtime_gate_lock_release 2>/dev/null || true
  case "$WORK" in /private/tmp/mcweb-zero-linked-ref-array-store-c2.??????) rm -rf -- "$WORK" || true ;; esac
  case "$STAGE" in /private/tmp/mcweb-zero-linked-ref-array-store-c2-0019-accept.*.tmp.[0-9]*) rm -rf -- "$STAGE" || true ;; esac
  case "$COLD_STAGE" in /private/tmp/mcweb-zero-linked-ref-array-store-c2-cold-0019-accept.*.tmp.[0-9]*) rm -rf -- "$COLD_STAGE" || true ;; esac
  exit "$status"
}
trap cleanup EXIT INT TERM
reject() { echo "REJECT M2-C2 checked reference-array store gate: $*" >&2; exit 1; }
[ -x "$JAVAC" ] && [ -x "$JAR" ] || reject "JDK tools unavailable"
[ -x "$WASM_DIS" ] && [ -x "$TIMEOUT" ] && [ -x "$RUN_JAVA" ] || reject "launcher/tools unavailable"
[ -n "$(command -v "$NODE" 2>/dev/null || true)" ] || reject "node unavailable"
[ -d "$JDK/.git" ] && [ -f "$FIXTURE" ] && [ -f "$NEAR_MISS" ] || reject "checkout/fixture missing"
[ -f "$LOG_CHECKER" ] && [ -f "$WAT_CHECKER" ] && [ -f "$CLASS_CHECKER" ] \
  && [ -f "$MANIFEST" ] \
  && [ -f "$PATCH_BOUNDARY" ] || reject "C2 checker missing"
[ -x "$PROVENANCE19" ] && [ -x "$PROVENANCE18" ] \
  && [ -x "$LEGACY_SUITE_PRODUCER" ] \
  && [ -x "$C1_GATE" ] || reject "final 0019 prerequisite producer missing"
[ -f "$PATCH15" ] && [ -f "$PATCH16" ] && [ -f "$PATCH17" ] \
  && [ -f "$PATCH18" ] && [ -f "$PATCH19" ] || reject "final patch stack missing"
. "$LOCK_HELPER"
runtime_gate_lock_acquire || reject "another Zero runtime gate owns the lock"
if [ "${MCWEB_C2_MANIFEST_ONLY:-0}" != 1 ] \
    && [ "${MCWEB_C2_COLD_ONLY:-0}" != 1 ]; then
  case "$EVIDENCE" in /private/tmp/mcweb-zero-linked-ref-array-store-c2-0019-accept.*) rm -rf -- "$EVIDENCE" ;; *) reject "unsafe evidence path" ;; esac
  case "$STAGE" in /private/tmp/mcweb-zero-linked-ref-array-store-c2-0019-accept.*.tmp.[0-9]*) rm -rf -- "$STAGE" ;; *) reject "unsafe stage path" ;; esac
fi
if [ "${MCWEB_C2_COLD_ONLY:-0}" = 1 ]; then
  case "$COLD_EVIDENCE" in /private/tmp/mcweb-zero-linked-ref-array-store-c2-cold-0019-accept.*) rm -rf -- "$COLD_EVIDENCE" ;; *) reject "unsafe cold evidence path" ;; esac
  case "$COLD_STAGE" in /private/tmp/mcweb-zero-linked-ref-array-store-c2-cold-0019-accept.*.tmp.[0-9]*) rm -rf -- "$COLD_STAGE" ;; *) reject "unsafe cold stage path" ;; esac
fi
sh -n "$0" || reject "gate shell syntax"

rg -q 'UseZeroWasmLinkedRefArrayStore' "$GLOBALS" || reject "store flag missing"
rg -q 'ZeroWasmLinkedRefArrayStoreMemoryLimitForTest' "$GLOBALS" || reject "memory limit flag missing"
rg -q 'ZeroWasmLinkedRefArrayStoreCacheMutationForTest' "$GLOBALS" || reject "cache mutation flag missing"
rg -q 'ZeroWasmLinkedRefArrayStoreCardProbeForTest' "$GLOBALS" || reject "card probe flag missing"
rg -q 'reference_array_store_fixture_class\(method\)' "$BASELINE" || reject "holder classifier missing"
rg -q 'verifier_max_stack\(\) != 3' "$BASELINE" || reject "verifier max-stack binding missing"
rg -q 'Bytecodes::_aload_2' "$BASELINE" || reject "third Object parameter is not aload_2"
rg -q 'for \(int bci = \*aastore_bci \+ 1; bci < method->code_size\(\); bci\+\+\)' "$BASELINE" \
  || reject "post-aastore value reload binding missing"
rg -q '\*aastore_bci == 3 && \*load_value_bci == 4 && \*return_bci == 5' "$BASELINE" \
  || reject "BCI shape binding missing"
rg -q 'addFunction\(exportedStore, "jiiiiii"\)' "$BASELINE" || reject "six-i32 ABI missing"
rg -q 'getWasmTableEntry\(cached\.ownedSlot\) === cached\.export' "$BASELINE" || reject "cache export check missing"
rg -q 'getWasmTableEntry\(newSlot\) === fresh\.export' "$BASELINE" || reject "fresh export identity check missing"
rg -q 'freshCleanupProven|JS_CACHE_FRESH_REJECT' "$BASELINE" || reject "fresh cache cleanup missing"
rg -q 'expectedDigest|expectedMemoryPages|freshValidationMode' "$BASELINE" \
  || reject "wrapper-owned fresh validation inputs missing"
rg -q 'selftest-fresh-false|selftest-fresh-throw' "$BASELINE" \
  || reject "fresh validation false/throw self-test modes missing"
rg -q 'cachedExportMatches.*cached\.export|Object\.defineProperty\(cache\[metadata\], "export"' \
  "$BASELINE" || reject "immutable cache export identity missing"
! rg -q '/private/tmp/mcweb-zero-linked-ref-array-store\.wasm' "$BASELINE" \
  || reject "fixed global Wasm dump path survived"
rg -q 'MCWEB_ZERO_REF_ARRAY_STORE_WASM_DUMP|flag: "wx"' "$BASELINE" \
  || reject "unique Wasm dump path contract missing"
rg -q 'wasmTable\.set|poisonCallable|poisonRemoved' "$BASELINE" || reject "poison mutation missing"
rg -q 'i32.store8|linked_publish_ref_store_.*infallible|NoSafepointVerifier' "$BASELINE" || reject "card/publication path missing"
! rg -q 'card_probe_(cleaned|old_card)' "$BASELINE" \
  || reject "raw card probe TLS state survived redesign"
rg -q 'linked_ref_array_card_span_proven|card_probe_transaction_card_bits' "$BASELINE" \
  || reject "exact card span transaction proof missing"
if sed -n '/^static ZeroWasmBaseline::Result run_linked_ref_array_store(/,/^static ZeroWasmBaseline::Result run_linked_group(/p' "$BASELINE" \
    | rg -q '\*[[:alnum:]_]*[[:space:]]*=[^;]*clean_card'; then
  reject "ordinary direct-store runner performs pre-store card cleaning"
fi
rg -q 'name === "direct" \? 6' "$LOG_CHECKER" || reject "direct matrix count drift"
rg -q 'interpreter-aastore=14' "$LOG_CHECKER" || reject "14-call matrix drift"
rg -q 'forced reason counts|memory !== 13|nullCount !== 1' "$LOG_CHECKER" \
  || reject "forced reason precedence/count gate missing"
EXPECTED_CACHE_MUTATIONS="compiler digest bytes memory metadata slot card-layout poison"
[ "$CACHE_MUTATIONS" = "$EXPECTED_CACHE_MUTATIONS" ] \
  || reject "cache mutation names drift"
[ "$(printf '%s\n' $CACHE_MUTATIONS | wc -l | awk '{print $1}')" -eq 8 ] \
  || reject "cache mutation total drift"
rg -q 'LOG_CHECKER.*linked.*\$mutation|linked "\$mutation"' "$0" \
  || reject "cache checker mutation binding missing"
rg -q 'expectedLabels = \[' "$WAT_CHECKER" || reject "exact binary negative labels missing"
rg -q 'mutations\.length !== expectedLabels\.length' "$WAT_CHECKER" \
  || reject "binary negative total is not exact"
rg -q '"memory-maximum", "export-name"' "$WAT_CHECKER" \
  || reject "19-label binary negative tail missing"
rg -q 'prepareReferenceArrayStoreCardProbe' "$CLASS_CHECKER" \
  || reject "card-probe helper class checker missing"
rg -q 'UseZeroWasmLinkedRefArrayLoad && UseZeroWasmLinkedRefArrayStore' "$INTERPRETER" "$BASELINE" || reject "C1+C2 collision pair missing"
rg -q 'ref-load=%d ref-store=%d' "$INTERPRETER" || reject "single collision marker missing"
rg -q 'UseZeroWasmJIT && !zero_ref_array_collision' "$INTERPRETER" || reject "OSR collision guard missing"
rg -q 'ref-load=%d ref-store=%d' "$INTERPRETER" || reject "C1-load/C2-store collision fields missing"

validate_companion_manifest() {
  # The first pass runs before this invocation has generated its ephemeral
  # class-directory/JAR inputs.  Defer only a missing generated row there;
  # hashes for rows that already exist still have to match, and the second
  # pass below is strict about every generated file.
  validate_generated=${1:-0}
  manifest_issue=0
  manifest_placeholders=0
  manifest_stale=0
  manifest_deferred=0
  resolve_manifest_path() {
    candidate=$1
    case "$candidate" in
      /*) printf '%s\n' "$candidate" ;;
      *)
        if [ -f "$ROOT/$candidate" ]; then
          printf '%s\n' "$ROOT/$candidate"
        else
          printf '%s\n' "$ROOT/../$candidate"
        fi
        ;;
    esac
  }
  while IFS=' ' read -r kind a b c d; do
    [ -n "$kind" ] || continue
    manifest_path=
    manifest_expected=
    manifest_generated_row=0
    case "$kind" in
      asset|source|runtime-artifact)
        manifest_path=$(resolve_manifest_path "$a")
        manifest_expected="$b"
        ;;
      runtime-source)
        manifest_path="$JDK/$a"
        manifest_expected="$b"
        ;;
      tool)
        manifest_path=$(resolve_manifest_path "$b")
        manifest_expected="$c"
        ;;
      provenance)
        case "$b" in
          patch-0015) manifest_path="$ROOT/patches/0015-zero-wasm-linked-int-array-store.patch" ;;
          patch-0016) manifest_path="$ROOT/patches/0016-zero-wasm-linked-ref-array-load.patch" ;;
          patch-0017) manifest_path="$ROOT/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch" ;;
          patch-0018) manifest_path="$ROOT/patches/0018-zero-wasm-linked-ref-array-store.patch" ;;
          patch-0019) manifest_path="$ROOT/patches/0019-zero-wasm-reference-store-group.patch" ;;
          *) continue ;;
        esac
        manifest_expected="$c"
        ;;
      class|fixture-jar)
        [ "$kind" = fixture-jar ] && [ "$a" = provenance/cache-identity-only ] && continue
        manifest_path="$WORK/classes/$a"
        if [ "$kind" = fixture-jar ]; then
          manifest_path="$WORK/$a"
        fi
        manifest_expected="$b"
        manifest_generated_row=1
        ;;
      runtime-artifact-status)
        case "$a $b $c $d" in *stale-unbuilt*) manifest_stale=1 ;; esac
        continue
        ;;
      *) continue ;;
    esac
    case "$manifest_expected" in
      sha256:generated-*|sha256:pending-*|generated-*|pending-*)
        manifest_placeholders=1
        continue
        ;;
    esac
    case "$manifest_expected" in sha256:*) ;; *)
      echo "manifest row lacks sha256: $kind $a" >&2
      manifest_issue=1
      continue
      ;;
    esac
    manifest_hash=${manifest_expected#sha256:}
    if [ ! -f "$manifest_path" ]; then
      if [ "$validate_generated" -eq 0 ] && [ "$manifest_generated_row" -eq 1 ]; then
        manifest_deferred=1
        continue
      fi
      echo "manifest file missing: $manifest_path" >&2
      manifest_issue=1
      continue
    fi
    manifest_actual=$(shasum -a 256 "$manifest_path" | awk '{print $1}')
    if [ "$manifest_actual" != "$manifest_hash" ]; then
      echo "manifest hash mismatch: $manifest_path expected=$manifest_hash actual=$manifest_actual" >&2
      manifest_issue=1
    fi
  done < "$MANIFEST"
  [ "$manifest_issue" -eq 0 ]
}

validate_companion_manifest 0 || reject "companion manifest static row mismatch"
if [ "$manifest_placeholders" -ne 0 ] || [ "$manifest_stale" -ne 0 ] \
    || [ ! -f "$LIBJVM" ] || [ "$LIBJVM" -ot "$BASELINE" ]; then
  [ "${MCWEB_C2_MANIFEST_ONLY:-0}" = 1 ] \
    || reject "final manifest/runtime is not executable placeholders=$manifest_placeholders stale=$manifest_stale"
fi
mkdir -p "$WORK/classes"
"$JAVAC" -g:none -d "$WORK/classes" "$FIXTURE" "$NEAR_MISS" || reject "fixture javac"
"$NODE" "$CLASS_CHECKER" "$WORK/classes/ZeroReferenceArrayStoreFixture.class" \
  >"$WORK/class-shape.log" 2>&1 || reject "exact class-file shape"
rg -q '^reference-array-store-class=pass .* code=2a1b2c532cb0$' "$WORK/class-shape.log" \
  || reject "exact class-file evidence"
rg -q '^reference-array-store-card-probe-helper=pass .* code=2ab0$' "$WORK/class-shape.log" \
  || reject "exact card-probe helper evidence"

"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$WORK/fixture.jar" -C "$WORK/classes" . || reject "fixture JAR"
JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceArrayStoreFixture.class" | awk '{print $1}')
NEAR_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceArrayStoreNearMiss.class" | awk '{print $1}')
SOURCE_SHA=$(shasum -a 256 "$FIXTURE" | awk '{print $1}')
DEPS=ZeroReferenceArrayStoreNearMiss.class=sha256:$NEAR_SHA
printf 'c2-provenance-v1 execution-input=class-directory fixture-jar=provenance/cache-identity-only source=%s class=%s near=%s jar=%s dependencies=%s\n' \
  "$SOURCE_SHA" "$CLASS_SHA" "$NEAR_SHA" "$JAR_SHA" "$DEPS" >"$WORK/provenance.manifest"
validate_companion_manifest 1 || reject "companion manifest generated row mismatch"
[ "$manifest_placeholders" -eq 0 ] && [ "$manifest_stale" -eq 0 ] \
  || reject "companion manifest still contains pre-build placeholders/status"
if [ "${MCWEB_C2_MANIFEST_ONLY:-0}" = 1 ]; then
  runtime_fresh=1
  [ -f "$LIBJVM" ] && [ ! "$LIBJVM" -ot "$BASELINE" ] || runtime_fresh=0
  printf 'WIP m2-c2-manifest=PASS static-rows=all generated-rows=all runtime-fresh=%s no-acceptance-evidence=1\n' \
    "$runtime_fresh"
  exit 0
fi

run_java() {
  log=$1; marker=$2; shift 2
  run_name=${log##*/}
  run_name=${run_name%.log}
  dump_path="$WORK/dumps/$run_name.wasm"
  [ ! -e "$dump_path" ] || reject "stale per-run Wasm dump path=$dump_path"
  MCWEB_ZERO_REF_ARRAY_STORE_WASM_DUMP="$dump_path" \
    "$TIMEOUT" --signal=TERM --kill-after=5s 180 "$RUN_JAVA" "$@" >"$log" 2>&1 &
  RUN_PID=$!
  if wait "$RUN_PID"; then status=0; else status=$?; fi
  RUN_PID=
  if rg -qi 'ReferenceError|TypeError|RangeError|SyntaxError|captured an uncaught exception|^worker: .*uncaught|^Pthread .* sent an error!' "$log"; then
    reject "uncaught JS runtime diagnostic log=$log"
  fi
  [ "$status" -eq 0 ] || reject "runtime status=$status log=$log"
  rg -q "$marker" "$log" || reject "final marker missing $log"
  case "$run_name" in
    cache-selftest-*) ;;
    cache-*)
      expected_mutation=${run_name#cache-}
      [ "$(rg -c '^\[zbg\] JS_CACHE_MUTATION_PASS ref-array-store ' "$log" || printf 0)" -eq 1 ] \
        || reject "cache mutation pass count drift=$expected_mutation"
      rg -q "^\[zbg\] JS_CACHE_MUTATION_PASS ref-array-store mutation=$expected_mutation " "$log" \
        || reject "cache mutation launch binding=$expected_mutation"
      ;;
  esac
  ! rg -qi 'broken pipe|fatal(?: error)?|wasm trap|unreachable|call mismatch|push reject|resume reject' \
    "$log" || reject "fatal/broken-pipe runtime diagnostic log=$log"
  awk -v marker="$marker" '
    BEGIN { markers=0; late=0; bad=0; after=0 }
    $0 ~ marker { markers++; after=1; next }
    tolower($0) ~ /terminated worker/ {
      if (!after || $0 !~ /^received "6" command from terminated worker: [1-9][0-9]*$/) bad=1
      else late++
    }
    END { if (markers != 1 || bad || late > 2) exit 1 }
  ' "$log" || reject "late-CMD6 teardown ordering log=$log"
  if [ -e "$dump_path" ]; then
    [ -s "$dump_path" ] || reject "empty per-run Wasm dump path=$dump_path"
    dump_mtime=$(stat -f '%m' "$dump_path" 2>/dev/null || printf '0')
    [ "$dump_mtime" -ge "$STARTED_EPOCH" ] \
      || reject "stale per-run Wasm dump mtime path=$dump_path"
  fi
  if [ "$run_name" = linked ]; then
    [ -s "$dump_path" ] || reject "linked Wasm dump missing path=$dump_path"
    WASM=$dump_path
  fi
}
BASE_ARGS="-Xmx256m -Xms16m -XX:+UnlockExperimentalVMOptions -XX:+UseSerialGC -XX:+UseZeroWasmLinkedRefArrayStore -XX:+ZeroWasmLinkedGroupVerbose -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS"
mkdir -p "$WORK/dumps"
# The first linked launch exists only to create a fresh per-run module. Verify
# that exact binary/WAT pair before trusting any semantic transcript.
run_java "$WORK/linked.log" '^ref-array-store direct-first=' $BASE_ARGS -cp "$WORK/classes" ZeroReferenceArrayStoreFixture ref-array-store
[ -s "$WASM" ] || reject "cold module dump missing"
cp "$WASM" "$WORK/module.wasm"
"$WASM_DIS" "$WORK/module.wasm" -o "$WORK/module.wat" || reject "cold wasm-dis"
"$NODE" "$WAT_CHECKER" "$WORK/module.wasm" "$WORK/module.wat" >"$WORK/check-wat.log" 2>&1 || reject "cold WAT/byte checker"
rg -q '^ref-array-store-body-binary-self-negatives=19 valid-same-length rejected$' "$WORK/check-wat.log" || reject "exact 19 same-length mutations"
rg -q '^ref-array-store-body-binary-invalid-negatives=1 ' "$WORK/check-wat.log" || reject "truncation accounting"
rg -q '^ref-array-store-wat-stale-pairing-negative=1 rejected$' "$WORK/check-wat.log" || reject "stale WAT accounting"
"$NODE" "$LOG_CHECKER" "$WORK/linked.log" linked >"$WORK/check-linked.log" 2>&1 || reject "cold linked transcript"
if [ "${MCWEB_C2_COLD_ONLY:-0}" = 1 ]; then
  module_sha=$(shasum -a 256 "$WORK/module.wasm" | awk '{print $1}')
  module_bytes=$(wc -c < "$WORK/module.wasm" | awk '{print $1}')
  mkdir -p "$COLD_STAGE/checks" "$COLD_STAGE/logs"
  cp "$WORK/module.wasm" "$WORK/module.wat" "$WORK/check-wat.log" \
    "$WORK/class-shape.log" "$WORK/provenance.manifest" "$COLD_STAGE/checks/"
  cp "$WORK/linked.log" "$WORK/check-linked.log" "$COLD_STAGE/logs/"
  {
    printf '%s\n' 'm2-c2-cold-atomic-evidence-v1' 'accept=m2-c2-cold exit=0'
    printf 'started-epoch=%s finished-epoch=%s\n' "$STARTED_EPOCH" "$(date +%s)"
    printf 'module-sha=%s module-bytes=%s wat-mutations=19\n' "$module_sha" "$module_bytes"
    printf 'gate=%s gate-sha=%s manifest=%s manifest-sha=%s libjvm-sha=%s\n' \
      "$0" "$(shasum -a 256 "$0" | awk '{print $1}')" "$MANIFEST" \
      "$(shasum -a 256 "$MANIFEST" | awk '{print $1}')" \
      "$(shasum -a 256 "$LIBJVM" | awk '{print $1}')"
    find "$COLD_STAGE/checks" "$COLD_STAGE/logs" -type f -print \
      | LC_ALL=C sort | while IFS= read -r cold_file; do
          cold_path=${cold_file#"$COLD_STAGE/"}
          printf 'bundle-file path=%s sha256=%s bytes=%s\n' "$cold_path" \
            "$(shasum -a 256 "$cold_file" | awk '{print $1}')" \
            "$(wc -c < "$cold_file" | awk '{print $1}')"
        done
  } >"$COLD_STAGE/evidence.index"
  shasum -a 256 "$COLD_STAGE/evidence.index" | awk '{print $1 "  evidence.index"}' \
    >"$COLD_STAGE/evidence.index.sha256"
  sync
  mv -f -- "$COLD_STAGE" "$COLD_EVIDENCE"
  printf 'm2-c2-cold=ACCEPT module-sha=%s module-bytes=%s wat-mutations=19 evidence-root=%s\n' \
    "$module_sha" "$module_bytes" "$COLD_EVIDENCE"
  exit 0
fi
run_java "$WORK/off.log" '^ref-array-store direct-first=' -Xmx256m -Xms16m -XX:+UnlockExperimentalVMOptions -XX:+UseSerialGC -XX:+ZeroWasmLinkedGroupVerbose -cp "$WORK/classes" ZeroReferenceArrayStoreFixture ref-array-store
for mutation in $CACHE_MUTATIONS; do
  # shellcheck disable=SC2086
  run_java "$WORK/cache-$mutation.log" '^ref-array-store direct-first=' $BASE_ARGS -XX:ZeroWasmLinkedRefArrayStoreCacheMutationForTest="$mutation" -cp "$WORK/classes" ZeroReferenceArrayStoreFixture ref-array-store
done
# The bounded replacement-validation diagnostics are not cache matrix lanes.
# Both must detach the fresh owned callable and fall back to the interpreter.
for selftest in selftest-fresh-false selftest-fresh-throw; do
  # shellcheck disable=SC2086
  run_java "$WORK/cache-$selftest.log" '^ref-array-store direct-first=' $BASE_ARGS -XX:ZeroWasmLinkedRefArrayStoreCacheMutationForTest="$selftest" -cp "$WORK/classes" ZeroReferenceArrayStoreFixture ref-array-store
done
# shellcheck disable=SC2086
run_java "$WORK/forced.log" '^ref-array-store direct-first=' $BASE_ARGS -XX:ZeroWasmLinkedRefArrayStoreMemoryLimitForTest=1 -cp "$WORK/classes" ZeroReferenceArrayStoreFixture ref-array-store
# shellcheck disable=SC2086
run_java "$WORK/root.log" '^ref-array-store-root identity=1 array-identity=1 weak=1$' $BASE_ARGS -XX:+ZeroWasmLinkedRefArrayStoreCardProbeForTest -Xlog:gc=info -cp "$WORK/classes" ZeroReferenceArrayStoreFixture ref-array-store-root
# shellcheck disable=SC2086
run_java "$WORK/negative.log" '^ref-array-store-negatives descriptor=1 owner=1 static=1 body=1 instance=1' $BASE_ARGS -cp "$WORK/classes" ZeroReferenceArrayStoreFixture ref-array-store-negatives
for spec in 'group UseZeroWasmLinkedGroup' 'int-load UseZeroWasmLinkedIntArray' 'int-store UseZeroWasmLinkedIntArrayStore' 'benchmark UseZeroWasmLinkedBenchmark' 'baseline UseZeroWasmBaseline' 'jit UseZeroWasmJIT' 'ref-load UseZeroWasmLinkedRefArrayLoad'; do
  set -- $spec; name=$1; flag=$2
  # shellcheck disable=SC2086
  run_java "$WORK/collision-$name.log" '^ref-array-store direct-first=' $BASE_ARGS -XX:+"$flag" -cp "$WORK/classes" ZeroReferenceArrayStoreFixture ref-array-store
done
# Explicit C1 load + C2 store collision pair, then a hot OSR collision.
# shellcheck disable=SC2086
run_java "$WORK/collision-pair.log" '^ref-array-store direct-first=' $BASE_ARGS -XX:+UseZeroWasmLinkedRefArrayLoad -cp "$WORK/classes" ZeroReferenceArrayStoreFixture ref-array-store
# Aggregate legacy opt-ins must fail closed as one bounded C1-load/C2-store
# collision, preserving the prior lane's fail-closed envelope.
# shellcheck disable=SC2086
run_java "$WORK/collision-legacy.log" '^ref-array-store direct-first=' $BASE_ARGS \
  -XX:+UseZeroWasmLinkedRefArrayLoad -XX:+UseZeroWasmLinkedGroup \
  -XX:+UseZeroWasmLinkedIntArray -XX:+UseZeroWasmLinkedIntArrayStore \
  -XX:+UseZeroWasmLinkedBenchmark -XX:+UseZeroWasmBaseline -XX:+UseZeroWasmJIT \
  -cp "$WORK/classes" ZeroReferenceArrayStoreFixture ref-array-store
# shellcheck disable=SC2086
run_java "$WORK/osr-collision.log" '^ref-array-store-osr-collision checksum=512' $BASE_ARGS -XX:+UseZeroWasmJIT -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITThreshold=1 -XX:ZeroWasmJITOnly=runOsrCollisionCase -cp "$WORK/classes" ZeroReferenceArrayStoreFixture ref-array-store-osr-collision
# Aggregate legacy opt-ins, including the C1/C2 pair, must also remain
# interpreter-owned at a hot OSR site.
# shellcheck disable=SC2086
run_java "$WORK/osr-aggregate.log" '^ref-array-store-osr-collision checksum=512' $BASE_ARGS \
  -XX:+UseZeroWasmLinkedRefArrayLoad -XX:+UseZeroWasmLinkedGroup \
  -XX:+UseZeroWasmLinkedIntArray -XX:+UseZeroWasmLinkedIntArrayStore \
  -XX:+UseZeroWasmLinkedBenchmark -XX:+UseZeroWasmBaseline -XX:+UseZeroWasmJIT \
  -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITThreshold=1 \
  -XX:ZeroWasmJITOnly=runOsrCollisionCase -cp "$WORK/classes" \
  ZeroReferenceArrayStoreFixture ref-array-store-osr-collision

"$NODE" "$LOG_CHECKER" "$WORK/off.log" off >"$WORK/check-off.log" 2>&1 || reject "off transcript"
for mutation in $CACHE_MUTATIONS; do
  "$NODE" "$LOG_CHECKER" "$WORK/cache-$mutation.log" linked "$mutation" \
    >"$WORK/check-cache-$mutation.log" 2>&1 || reject "cache transcript $mutation"
done
for selftest in selftest-fresh-false selftest-fresh-throw; do
  "$NODE" "$LOG_CHECKER" "$WORK/cache-$selftest.log" fresh-reject "$selftest" \
    >"$WORK/check-cache-$selftest.log" 2>&1 || reject "fresh rollback transcript $selftest"
done
printf '%s\n' $CACHE_MUTATIONS | LC_ALL=C sort -u >"$WORK/cache-mutations.expected"
for mutation in $CACHE_MUTATIONS; do
  printf '%s\n' "$mutation"
done | LC_ALL=C sort -u >"$WORK/cache-mutations.seen"
cmp -s "$WORK/cache-mutations.expected" "$WORK/cache-mutations.seen" \
  || reject "cache mutation names are not exactly eight distinct entries"
"$NODE" "$LOG_CHECKER" "$WORK/forced.log" forced >"$WORK/check-forced.log" 2>&1 || reject "forced transcript"
"$NODE" "$LOG_CHECKER" "$WORK/root.log" root >"$WORK/check-root.log" 2>&1 || reject "root transcript"
rg -q '^ROOT_PRE_STORE_GC_BEGIN$' "$WORK/root.log" || reject "root pre-store aging marker missing"
rg -q '^ROOT_PRE_STORE_GC_END$' "$WORK/root.log" || reject "root pre-store aging completion missing"
rg -q '^ROOT_POST_STORE_YOUNG_BEGIN$' "$WORK/root.log" || reject "root post-store Young marker missing"
rg -q '^ROOT_POST_STORE_YOUNG_END$' "$WORK/root.log" || reject "root post-store Young completion missing"
rg -q 'Pause Young ' "$WORK/root.log" || reject "root post-store Young event missing"
if sed -n '/^ROOT_POST_STORE_YOUNG_BEGIN$/,/^ROOT_POST_STORE_YOUNG_END$/p' "$WORK/root.log" | rg -q 'Pause Full '; then
  reject "post-store GC window contains Full collection"
fi
if sed -n '/ROOT_POST_STORE_YOUNG_BEGIN/,/ROOT_POST_STORE_YOUNG_END/p' "$FIXTURE" | rg -q 'System\.gc'; then
  reject "root fixture performs explicit post-store System.gc"
fi
"$NODE" "$LOG_CHECKER" "$WORK/negative.log" negative >"$WORK/check-negative.log" 2>&1 || reject "negative transcript"
for name in group int-load int-store benchmark baseline jit ref-load; do
  "$NODE" "$LOG_CHECKER" "$WORK/collision-$name.log" collision >"$WORK/check-collision-$name.log" 2>&1 || reject "collision transcript $name"
done
"$NODE" "$LOG_CHECKER" "$WORK/collision-pair.log" collision-pair >"$WORK/check-collision-pair.log" 2>&1 || reject "C1/C2 collision transcript"
"$NODE" "$LOG_CHECKER" "$WORK/collision-legacy.log" collision-legacy >"$WORK/check-collision-legacy.log" 2>&1 || reject "aggregate legacy collision transcript"
"$NODE" "$LOG_CHECKER" "$WORK/osr-collision.log" osr-collision >"$WORK/check-osr.log" 2>&1 || reject "OSR transcript"
"$NODE" "$LOG_CHECKER" "$WORK/osr-aggregate.log" osr-aggregate >"$WORK/check-osr-aggregate.log" 2>&1 || reject "aggregate OSR transcript"

MCWEB_PATCH_BOUNDARY_COMMAND=OpenJDK/tests/check-zero-0019-patch-boundary.sh "$PATCH_BOUNDARY" >"$WORK/patch-boundary.log" 2>&1 || reject "0019 preservation"

# Preserve the fresh 0019 setup/boundary/M1/M2-A/P1/M2-B records as independently
# independently hashed inputs. A missing or interrupted predecessor is a
# hard stop; this gate never fabricates legacy evidence.
for legacy_log in $LEGACY_EVIDENCE_FILES; do
  [ -s "$legacy_log" ] || reject "legacy evidence missing: $legacy_log"
  rg -q '^audit=0019-final$' "$legacy_log" || reject "legacy audit envelope drift: $legacy_log"
  rg -q '^exit=0$' "$legacy_log" || reject "legacy exit envelope drift: $legacy_log"
  rg -q '^finished-epoch=[1-9][0-9]*$' "$legacy_log" \
    || reject "legacy finish envelope drift: $legacy_log"
  rg -q '^record-producer=OpenJDK/tests/run-zero-0019-final-legacy-suite.sh$' "$legacy_log" \
    || reject "legacy producer path drift: $legacy_log"
  legacy_suite_sha=$(shasum -a 256 "$LEGACY_SUITE_PRODUCER" | awk '{print $1}')
  rg -q "^record-producer-sha256=$legacy_suite_sha$" "$legacy_log" \
    || reject "legacy producer hash drift: $legacy_log"
  rg -q '^legacy-provenance-context=final-0019$' "$legacy_log" \
    || reject "legacy provenance context drift: $legacy_log"
  legacy_provenance18_sha=$(shasum -a 256 "$PROVENANCE18" | awk '{print $1}')
  rg -q "^legacy-provenance-helper18-sha256=$legacy_provenance18_sha$" "$legacy_log" \
    || reject "legacy provenance helper18 drift: $legacy_log"
  rg -q '^patch0018-sha256=53cf9d1332f70d3f83e101ec73b5f6d3ebde7e9bb059fd8456754a3e0bcc0024$' "$legacy_log" \
    || reject "legacy 0018 patch drift: $legacy_log"
  rg -q '^patch0019-sha256=983ed617633fbf9b2635a3a175dfbf96850c72412388f3fb6474e9364e935905$' "$legacy_log" \
    || reject "legacy 0019 patch drift: $legacy_log"
  rg -q '^runtime-source-final-0019 globals=bd76b9d3df38fc45892a45b9ebb5d54b1d5fb8fec5917a47929ef8e634082265 interpreter=08e457e0a1551d8f3c3c16b0b4aa1f2608f630babe3ccd54f3e1fba316fc3676 baseline=d2276be03aa03375fa59e9ccae10fee21b65f63d30c509f9fdfcbac349573420$' "$legacy_log" \
    || reject "legacy source postimage drift: $legacy_log"
  case "$(basename "$legacy_log")" in
    mcweb-0019-audit-setup.log) legacy_rel=OpenJDK/tests/run-zero-setup-transaction.sh; legacy_accept='ACCEPT setup transaction mock gate' ;;
    mcweb-0019-audit-patch-boundary.log) legacy_rel=OpenJDK/tests/check-zero-0019-patch-boundary.sh; legacy_accept='ACCEPT patch-boundary clean-base-forward-0019-reverse-0019-exact-0018-postimages' ;;
    mcweb-0019-audit-m1-group.log) legacy_rel=OpenJDK/tests/run-zero-linked-group.sh; legacy_accept='ACCEPT M1-A direct+guard slice' ;;
    mcweb-0019-audit-m1-gc.log) legacy_rel=OpenJDK/tests/run-zero-linked-gc.sh; legacy_accept='ACCEPT M1-B1 linked oop store slice' ;;
    mcweb-0019-audit-m1-alloc.log) legacy_rel=OpenJDK/tests/run-zero-linked-alloc-bail.sh; legacy_accept='ACCEPT M1-B2 allocation-bail/root-liveness slice' ;;
    mcweb-0019-audit-m1-class-init.log) legacy_rel=OpenJDK/tests/run-zero-linked-class-init.sh; legacy_accept='ACCEPT M1-C class-init fallback slice (second successful access interpreter-only)' ;;
    mcweb-0019-audit-m1-virtual.log) legacy_rel=OpenJDK/tests/run-zero-linked-virtual.sh; legacy_accept='ACCEPT M1-D1 exact-class invokevirtual guard slice' ;;
    mcweb-0019-audit-m1-idiv.log) legacy_rel=OpenJDK/tests/run-zero-linked-idiv.sh; legacy_accept='ACCEPT M1-E1 same-frame idiv re-execution slice' ;;
    mcweb-0019-audit-m1-throw.log) legacy_rel=OpenJDK/tests/run-zero-linked-throw.sh; legacy_accept='ACCEPT M1-E2 direct-callee throw/invoke-resume slice' ;;
    mcweb-0019-audit-m2a-array.log) legacy_rel=OpenJDK/tests/run-zero-linked-array.sh; legacy_accept='ACCEPT M2-A int[] load linked-success plus canonical fallback slice' ;;
    mcweb-0019-audit-m2b-store.log) legacy_rel=OpenJDK/tests/run-zero-linked-array-store.sh; legacy_accept='ACCEPT M2-B int[] store linked-success plus canonical fallback slice' ;;
    mcweb-0019-audit-p1-performance.log) legacy_rel=OpenJDK/tests/run-zero-linked-performance.sh; legacy_accept='ACCEPT M1-P1b synthetic emitter hot-path benchmark evidence' ;;
    *) reject "unknown legacy evidence path: $legacy_log" ;;
  esac
  legacy_script="$ROOT/../$legacy_rel"
  rg -q -x -F "command=$legacy_rel" "$legacy_log" \
    && rg -q -x -F "script-sha256=$(shasum -a 256 "$legacy_script" | awk '{print $1}')" "$legacy_log" \
    && [ "$(rg -c -x -F "$legacy_accept" "$legacy_log" || printf 0)" -eq 1 ] \
    && [ "$(rg -c '^ACCEPT ' "$legacy_log" || printf 0)" -eq 1 ] \
    || reject "legacy command/script/terminal drift: $legacy_log"
done

# Bind the entire fresh C1 prerequisite payload, not just its envelope/index.
[ -s "$C1_EVIDENCE/evidence.index" ] && [ -s "$C1_EVIDENCE/evidence.index.sha256" ] \
  || reject "C1 prerequisite evidence missing"
(cd "$C1_EVIDENCE" && shasum -a 256 -c evidence.index.sha256 >/dev/null) \
  || reject "C1 prerequisite sidecar mismatch"
rg -q '^accept m2-c1 exit=0$' "$C1_EVIDENCE/evidence.index" \
  || reject "C1 prerequisite acceptance missing"
rg -q '^runtime-lane=c1-on-final-0019 final-0019-source-match=1$' "$C1_EVIDENCE/evidence.index" \
  || reject "C1 prerequisite runtime lane drift"
C1_GATE_SHA=$(shasum -a 256 "$C1_GATE" | awk '{print $1}')
rg -q "^gate-artifacts gate-sha=$C1_GATE_SHA " "$C1_EVIDENCE/evidence.index" \
  || reject "C1 prerequisite producer hash drift"
C1_INDEX_ROWS=$(rg -c '^bundle-file path=' "$C1_EVIDENCE/evidence.index" || printf 0)
C1_ACTUAL_ROWS=$(find "$C1_EVIDENCE/checks" "$C1_EVIDENCE/logs" "$C1_EVIDENCE/legacy" -type f | wc -l | awk '{print $1}')
[ "$C1_INDEX_ROWS" -eq "$C1_ACTUAL_ROWS" ] || reject "C1 prerequisite closure count drift"
rg '^bundle-file path=' "$C1_EVIDENCE/evidence.index" >"$WORK/c1-bundle-rows.list"
while IFS= read -r c1_row; do
  c1_path=$(printf '%s\n' "$c1_row" | sed -n 's/^bundle-file path=\([^ ]*\) sha256=.*/\1/p')
  c1_sha=$(printf '%s\n' "$c1_row" | sed -n 's/.* sha256=\([0-9a-f][0-9a-f]*\) bytes=.*/\1/p')
  c1_bytes=$(printf '%s\n' "$c1_row" | sed -n 's/.* bytes=\([0-9][0-9]*\)$/\1/p')
  [ -n "$c1_path" ] && [ -f "$C1_EVIDENCE/$c1_path" ] \
    && [ "$(shasum -a 256 "$C1_EVIDENCE/$c1_path" | awk '{print $1}')" = "$c1_sha" ] \
    && [ "$(wc -c < "$C1_EVIDENCE/$c1_path" | awk '{print $1}')" = "$c1_bytes" ] \
    || reject "C1 prerequisite payload mismatch: $c1_path"
done <"$WORK/c1-bundle-rows.list"

# Bind the separately accepted structural-first cold run under this exact gate,
# manifest, and runtime. Its complete payload becomes part of the final bundle.
[ -s "$COLD_EVIDENCE/evidence.index" ] && [ -s "$COLD_EVIDENCE/evidence.index.sha256" ] \
  || reject "cold prerequisite evidence missing"
(cd "$COLD_EVIDENCE" && shasum -a 256 -c evidence.index.sha256 >/dev/null) \
  || reject "cold prerequisite sidecar mismatch"
rg -q '^accept=m2-c2-cold exit=0$' "$COLD_EVIDENCE/evidence.index" \
  || reject "cold prerequisite acceptance missing"
COLD_GATE_SHA=$(shasum -a 256 "$0" | awk '{print $1}')
COLD_MANIFEST_SHA=$(shasum -a 256 "$MANIFEST" | awk '{print $1}')
COLD_LIBJVM_SHA=$(shasum -a 256 "$LIBJVM" | awk '{print $1}')
rg -q "^gate=$0 gate-sha=$COLD_GATE_SHA manifest=$MANIFEST manifest-sha=$COLD_MANIFEST_SHA libjvm-sha=$COLD_LIBJVM_SHA$" \
  "$COLD_EVIDENCE/evidence.index" || reject "cold prerequisite producer/runtime drift"
COLD_INDEX_ROWS=$(rg -c '^bundle-file path=' "$COLD_EVIDENCE/evidence.index" || printf 0)
COLD_ACTUAL_ROWS=$(find "$COLD_EVIDENCE/checks" "$COLD_EVIDENCE/logs" -type f | wc -l | awk '{print $1}')
[ "$COLD_INDEX_ROWS" -eq "$COLD_ACTUAL_ROWS" ] || reject "cold prerequisite closure count drift"
rg '^bundle-file path=' "$COLD_EVIDENCE/evidence.index" >"$WORK/cold-bundle-rows.list"
while IFS= read -r cold_row; do
  cold_path=$(printf '%s\n' "$cold_row" | sed -n 's/^bundle-file path=\([^ ]*\) sha256=.*/\1/p')
  cold_sha=$(printf '%s\n' "$cold_row" | sed -n 's/.* sha256=\([0-9a-f][0-9a-f]*\) bytes=.*/\1/p')
  cold_bytes=$(printf '%s\n' "$cold_row" | sed -n 's/.* bytes=\([0-9][0-9]*\)$/\1/p')
  [ -n "$cold_path" ] && [ -f "$COLD_EVIDENCE/$cold_path" ] \
    && [ "$(shasum -a 256 "$COLD_EVIDENCE/$cold_path" | awk '{print $1}')" = "$cold_sha" ] \
    && [ "$(wc -c < "$COLD_EVIDENCE/$cold_path" | awk '{print $1}')" = "$cold_bytes" ] \
    || reject "cold prerequisite payload mismatch: $cold_path"
done <"$WORK/cold-bundle-rows.list"
COLD_MODULE_SHA=$(shasum -a 256 "$COLD_EVIDENCE/checks/module.wasm" | awk '{print $1}')
[ "$COLD_MODULE_SHA" = "$(shasum -a 256 "$WORK/module.wasm" | awk '{print $1}')" ] \
  || reject "cold/full module identity drift"

MODULE_SHA=$(shasum -a 256 "$WORK/module.wasm" | awk '{print $1}')
MODULE_BYTES=$(wc -c < "$WORK/module.wasm" | awk '{print $1}')
MODULE_WAT_SHA=$(shasum -a 256 "$WORK/module.wat" | awk '{print $1}')
FINISHED_EPOCH=$(date +%s)
SOURCE_SHA=$(shasum -a 256 "$FIXTURE" | awk '{print $1}')
NEAR_SOURCE_SHA=$(shasum -a 256 "$NEAR_MISS" | awk '{print $1}')
FIXTURE_CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceArrayStoreFixture.class" | awk '{print $1}')
NEAR_CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroReferenceArrayStoreNearMiss.class" | awk '{print $1}')
JAR_BYTES=$(wc -c < "$WORK/fixture.jar" | awk '{print $1}')
LIBJVM_SHA=$(shasum -a 256 "$LIBJVM" | awk '{print $1}')
LAUNCHER_SHA=$(shasum -a 256 "$RUN_JAVA" | awk '{print $1}')
LOCK_SHA=$(shasum -a 256 "$LOCK_HELPER" | awk '{print $1}')
GATE_SHA=$(shasum -a 256 "$0" | awk '{print $1}')
LOG_CHECKER_SHA=$(shasum -a 256 "$LOG_CHECKER" | awk '{print $1}')
WAT_CHECKER_SHA=$(shasum -a 256 "$WAT_CHECKER" | awk '{print $1}')
CLASS_CHECKER_SHA=$(shasum -a 256 "$CLASS_CHECKER" | awk '{print $1}')
MANIFEST_SHA=$(shasum -a 256 "$MANIFEST" | awk '{print $1}')
GLOBALS_SHA=$(shasum -a 256 "$GLOBALS" | awk '{print $1}')
INTERPRETER_SHA=$(shasum -a 256 "$INTERPRETER" | awk '{print $1}')
BASELINE_SHA=$(shasum -a 256 "$BASELINE" | awk '{print $1}')
JAVAC_SHA=$(shasum -a 256 "$JAVAC" | awk '{print $1}')
JAR_TOOL_SHA=$(shasum -a 256 "$JAR" | awk '{print $1}')
NODE_PATH=$(command -v "$NODE")
NODE_SHA=$(shasum -a 256 "$NODE_PATH" | awk '{print $1}')
WASM_DIS_SHA=$(shasum -a 256 "$WASM_DIS" | awk '{print $1}')
PATCH_BOUNDARY_SHA=$(shasum -a 256 "$PATCH_BOUNDARY" | awk '{print $1}')
PATCH15_SHA=$(shasum -a 256 "$PATCH15" | awk '{print $1}')
PATCH16_SHA=$(shasum -a 256 "$PATCH16" | awk '{print $1}')
PATCH17_SHA=$(shasum -a 256 "$PATCH17" | awk '{print $1}')
PATCH18_SHA=$(shasum -a 256 "$PATCH18" | awk '{print $1}')
PATCH19_SHA=$(shasum -a 256 "$PATCH19" | awk '{print $1}')
PROVENANCE19_SHA=$(shasum -a 256 "$PROVENANCE19" | awk '{print $1}')
LEGACY_SUITE_SHA=$(shasum -a 256 "$LEGACY_SUITE_PRODUCER" | awk '{print $1}')
C1_INDEX_SHA=$(shasum -a 256 "$C1_EVIDENCE/evidence.index" | awk '{print $1}')
C1_INDEX_BYTES=$(wc -c < "$C1_EVIDENCE/evidence.index" | awk '{print $1}')
C1_SIDECAR_SHA=$(shasum -a 256 "$C1_EVIDENCE/evidence.index.sha256" | awk '{print $1}')
COLD_INDEX_SHA=$(shasum -a 256 "$COLD_EVIDENCE/evidence.index" | awk '{print $1}')
COLD_INDEX_BYTES=$(wc -c < "$COLD_EVIDENCE/evidence.index" | awk '{print $1}')
COLD_SIDECAR_SHA=$(shasum -a 256 "$COLD_EVIDENCE/evidence.index.sha256" | awk '{print $1}')
mkdir -p "$STAGE/logs" "$STAGE/checks" "$STAGE/legacy"
cp "$WORK"/*.log "$STAGE/logs/"
cp "$WORK/provenance.manifest" "$STAGE/checks/"
cp "$WORK/class-shape.log" "$STAGE/checks/"
cp "$FIXTURE" "$STAGE/checks/ZeroReferenceArrayStoreFixture.java"
cp "$NEAR_MISS" "$STAGE/checks/ZeroReferenceArrayStoreNearMiss.java"
cp "$WORK/fixture.jar" "$STAGE/checks/fixture.jar"
cp "$MANIFEST" "$STAGE/checks/c2-manifest.sha256"
for class_file in $(find "$WORK/classes" -type f -name '*.class' | LC_ALL=C sort); do
  cp "$class_file" "$STAGE/checks/$(basename "$class_file")"
done
cp "$WORK/module.wasm" "$STAGE/checks/"
cp "$WORK/module.wat" "$STAGE/checks/"
for legacy_log in $LEGACY_EVIDENCE_FILES; do
  cp "$legacy_log" "$STAGE/legacy/$(basename "$legacy_log")"
done
cp "$WORK/patch-boundary.log" "$STAGE/legacy/mcweb-0019-direct-patch-boundary.log"
cp -R "$C1_EVIDENCE" "$STAGE/c1"
cp -R "$COLD_EVIDENCE" "$STAGE/cold"
bundle_file_count=$(find "$STAGE/checks" "$STAGE/logs" "$STAGE/legacy" "$STAGE/c1" "$STAGE/cold" \
  -type f | wc -l | awk '{print $1}')
{
  echo m2-c2-atomic-accept-evidence-v1
  printf 'accept=m2-c2 exit=0\n'
  printf 'gate-envelope started-epoch=%s finished-epoch=%s exit=0\n' \
    "$STARTED_EPOCH" "$FINISHED_EPOCH"
  echo execution-input=class-directory fixture-jar=provenance/cache-identity-only
  echo cache-mutations=compiler,digest,bytes,memory,metadata,slot,card-layout,poison
  echo cache-rollback-self-negatives=selftest-fresh-false,selftest-fresh-throw
  echo structural-trust-order=cold-module-wat-binary-19-before-semantic-log
  echo semantic-matrix=direct-6 canonical-reexecute-8 forced-memory=13 forced-null=1 osr-calls=512
  echo collision-pair=c1-load+c2-store aggregate-legacy=1 aggregate-osr=1 legacy-preservation=0019-boundary-pass
  printf 'module-sha=%s module-wat-sha=%s module-bytes=%s\n' \
    "$MODULE_SHA" "$MODULE_WAT_SHA" "$MODULE_BYTES"
  printf 'fixture source-sha=%s near-source-sha=%s class-sha=%s near-class-sha=%s jar-sha=%s jar-bytes=%s\n' \
    "$SOURCE_SHA" "$NEAR_SOURCE_SHA" "$FIXTURE_CLASS_SHA" "$NEAR_CLASS_SHA" "$JAR_SHA" "$JAR_BYTES"
  printf 'runtime-source globals=%s interpreter=%s baseline=%s\n' \
    "$GLOBALS_SHA" "$INTERPRETER_SHA" "$BASELINE_SHA"
  printf 'runtime-artifact libjvm=%s libjvm-sha=%s\n' "$LIBJVM" "$LIBJVM_SHA"
  printf 'tool javac=%s sha256=%s jar=%s sha256=%s node=%s sha256=%s wasm-dis=%s sha256=%s\n' \
    "$JAVAC" "$JAVAC_SHA" "$JAR" "$JAR_TOOL_SHA" "$NODE_PATH" "$NODE_SHA" "$WASM_DIS" "$WASM_DIS_SHA"
  printf 'gate-artifact gate=%s sha256=%s launcher=%s sha256=%s lock=%s sha256=%s\n' \
    "$0" "$GATE_SHA" "$RUN_JAVA" "$LAUNCHER_SHA" "$LOCK_HELPER" "$LOCK_SHA"
  printf 'checker-artifact log=%s sha256=%s wat=%s sha256=%s class=%s sha256=%s manifest=%s sha256=%s boundary=%s sha256=%s\n' \
    "$LOG_CHECKER" "$LOG_CHECKER_SHA" "$WAT_CHECKER" "$WAT_CHECKER_SHA" \
    "$CLASS_CHECKER" "$CLASS_CHECKER_SHA" "$MANIFEST" "$MANIFEST_SHA" \
    "$PATCH_BOUNDARY" "$PATCH_BOUNDARY_SHA"
  printf 'provenance final-0019=bound patch-0015=%s patch-0016=%s patch-0017=%s patch-0018=%s patch-0019=%s helper=%s helper-sha=%s legacy-suite=%s suite-sha=%s\n' \
    "$PATCH15_SHA" "$PATCH16_SHA" "$PATCH17_SHA" "$PATCH18_SHA" "$PATCH19_SHA" \
    "$PROVENANCE19" "$PROVENANCE19_SHA" "$LEGACY_SUITE_PRODUCER" "$LEGACY_SUITE_SHA"
  printf 'c1-prerequisite gate=%s gate-sha=%s evidence-index-sha=%s evidence-index-bytes=%s evidence-sidecar-sha=%s payload-files=%s\n' \
    "$C1_GATE" "$C1_GATE_SHA" "$C1_INDEX_SHA" "$C1_INDEX_BYTES" \
    "$C1_SIDECAR_SHA" "$C1_ACTUAL_ROWS"
  printf 'cold-prerequisite gate-sha=%s manifest-sha=%s libjvm-sha=%s evidence-index-sha=%s evidence-index-bytes=%s evidence-sidecar-sha=%s payload-files=%s module-sha=%s\n' \
    "$COLD_GATE_SHA" "$COLD_MANIFEST_SHA" "$COLD_LIBJVM_SHA" "$COLD_INDEX_SHA" \
    "$COLD_INDEX_BYTES" "$COLD_SIDECAR_SHA" "$COLD_ACTUAL_ROWS" "$COLD_MODULE_SHA"
  printf 'bundle-file-count checks-logs-legacy-c1-cold=%s\n' "$bundle_file_count"
  find "$STAGE/checks" "$STAGE/logs" "$STAGE/legacy" "$STAGE/c1" "$STAGE/cold" -type f -print \
    | LC_ALL=C sort | while IFS= read -r bundle_file; do
        bundle_path=${bundle_file#"$STAGE/"}
        printf 'bundle-file path=%s sha256=%s bytes=%s\n' \
          "$bundle_path" \
          "$(shasum -a 256 "$bundle_file" | awk '{print $1}')" \
          "$(wc -c < "$bundle_file" | awk '{print $1}')"
      done
} >"$STAGE/evidence.index"
actual_bundle_file_count=$(find "$STAGE/checks" "$STAGE/logs" "$STAGE/legacy" "$STAGE/c1" "$STAGE/cold" \
  -type f | wc -l | awk '{print $1}')
indexed_bundle_file_count=$(rg -c '^bundle-file path=(checks|logs|legacy|c1|cold)/' \
  "$STAGE/evidence.index" || printf 0)
[ "$actual_bundle_file_count" -eq "$indexed_bundle_file_count" ] \
  || reject "atomic evidence bundle file index count drift"
for bundle_dir in checks logs legacy c1 cold; do
  for bundle_file in $(find "$STAGE/$bundle_dir" -type f | LC_ALL=C sort); do
    bundle_path=${bundle_file#"$STAGE/"}
    bundle_sha=$(shasum -a 256 "$bundle_file" | awk '{print $1}')
    bundle_bytes=$(wc -c < "$bundle_file" | awk '{print $1}')
    [ "$(rg -c -x -F "bundle-file path=$bundle_path sha256=$bundle_sha bytes=$bundle_bytes" \
      "$STAGE/evidence.index" || printf 0)" -eq 1 ] \
      || reject "atomic evidence bundle index binding drift: $bundle_path"
  done
done
shasum -a 256 "$STAGE/evidence.index" | awk '{print $1 "  evidence.index"}' >"$STAGE/evidence.index.sha256"
sync
mv -f -- "$STAGE" "$EVIDENCE"
printf '%s\n' "m2-c2=ACCEPT module-sha=$MODULE_SHA module-bytes=$MODULE_BYTES" "evidence-root=$EVIDENCE"
