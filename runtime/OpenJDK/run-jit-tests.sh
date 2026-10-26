#!/bin/sh
# Correctness gate for the wasm JIT (-XX:+UseZeroWasmJIT).
#
# A JIT that is merely fast is worthless: the only thing that matters is that
# compiled code computes what the interpreter computes. Every case in
# tests/JitDiff.java is run both ways and the output must be byte-identical.
# Run this after ANY change to zeroWasmCompiler.cpp.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# A host javac 25: $JAVAC, else the JDK jdk-home.sh picks.
if [ -z "${JAVAC:-}" ]; then
  . "$HERE/jdk-home.sh"
  JAVAC=$BOOT_JDK/bin/javac
fi

"$JAVAC" -d tests/classes tests/JitDiff.java tests/JitBench.java tests/JitWide.java \
    tests/JitInline.java tests/JitBranch.java tests/JitMerge.java tests/DirectCodeProbe.java \
    tests/JitTypes.java tests/NativeCalls.java tests/JitCold.java tests/JitPoly.java tests/JitFrameless.java tests/JitFramelessAlloc.java tests/JitFramelessStores.java tests/JitForcedVirtual.java tests/JitVtableHash.java \
    tests/JitIndy.java tests/JitProfiled.java tests/JitInlineStores.java tests/JitVolatile.java tests/JitClassCast.java tests/JitDirect.java tests/JitUnsafe.java tests/JitFramed.java tests/JitThreadLocal.java tests/JitNested.java tests/JitColdCall.java tests/JitHash.java tests/JitAlloc.java tests/JitArrays.java tests/JitLateClass.java tests/JitExactThis.java tests/JitInlineAlloc.java tests/JitColdJoin.java tests/RecordBench.java tests/JitFusedLoads.java tests/JitInlineArrayStores.java tests/JitRem.java tests/JitRecordGc.java tests/JitRecordShape.java tests/JitVarHandle.java tests/JitLambdaAlloc.java tests/JitEnumSwitch.java tests/JitClock.java \
    tests/JitTyped.java tests/JitIntrinsics.java tests/JitUnaligned.java tests/JitStringHash.java tests/LambdaStress.java tests/ThreadStress.java \
    tests/JitVolatileReplay.java tests/JitStaticStoreReplay.java tests/QueueSignalStress.java

echo "== differential: interpreter vs JIT"
./run-java.sh -Xmx256m -cp tests/classes JitDiff 2>/dev/null | grep -E '^x=|^npe|^aioobe|^array-npe' > "$TMP/off"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitDiff 2>/dev/null | grep -E '^x=|^npe|^aioobe|^array-npe' > "$TMP/on"
if ! diff -u "$TMP/off" "$TMP/on"; then
  echo "FAIL: JIT output differs from the interpreter" >&2
  exit 1
fi
echo "   identical on $(wc -l < "$TMP/off" | tr -d ' ') case lines"

echo "== wide types: long and double"
./run-java.sh -Xmx256m -cp tests/classes JitWide 2>/dev/null | grep '^wide' > "$TMP/woff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitWide 2>/dev/null | grep '^wide' > "$TMP/won"
diff -u "$TMP/woff" "$TMP/won" || { echo "FAIL: wide-type output differs" >&2; exit 1; }
echo "   $(cat "$TMP/woff")"

echo "== type checks and fused field loads"
./run-java.sh -Xmx256m -cp tests/classes JitTypes 2>/dev/null | grep '^types' > "$TMP/toff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitTypes 2>/dev/null | grep '^types' > "$TMP/ton"
diff -u "$TMP/toff" "$TMP/ton" || { echo "FAIL: type-check output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/ton" | tr -d ' ')" = 18 ] || { echo "FAIL: JitTypes did not finish" >&2; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly='JitTypes' \
    -cp tests/classes JitTypes > "$TMP/types.verbose" 2>&1
for m in JitTypes.classify JitTypes.tagOf JitTypes.lambdas JitTypes.boxOne JitTypes.sgetSafe 'JitTypes$Holder.scaled'; do
  grep -F "[zwc] compiled $m" "$TMP/types.verbose" >/dev/null \
    || { echo "FAIL: $m was not compiled" >&2; exit 1; }
done
echo "   $(tail -1 "$TMP/ton")"

echo "== cold throw paths in inlined callees"
./run-java.sh -Xmx256m -cp tests/classes JitCold 2>/dev/null | grep '^cold' > "$TMP/coff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly=JitCold -cp tests/classes JitCold > "$TMP/con.verbose" 2>&1
grep '^cold' "$TMP/con.verbose" > "$TMP/con"
diff -u "$TMP/coff" "$TMP/con" || { echo "FAIL: cold-path output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/con" | tr -d ' ')" = 3 ] || { echo "FAIL: JitCold did not finish" >&2; exit 1; }
grep -F '[zwc] compiled JitCold.one' "$TMP/con.verbose" >/dev/null \
    || { echo "FAIL: JitCold.one was not compiled" >&2; exit 1; }
! grep -E 'no-inline .*JitCold\.(at|getD|checked|twoThrows)' "$TMP/con.verbose" >/dev/null \
    || { echo "FAIL: a helper with a cold throw path was not inlined" >&2; exit 1; }
echo "   $(tail -1 "$TMP/con")"

echo "== polymorphic inline cache"
./run-java.sh -Xmx256m -cp tests/classes JitPoly 2>/dev/null | grep '^poly' > "$TMP/poff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly=JitPoly -cp tests/classes JitPoly > "$TMP/pon.verbose" 2>&1
grep '^poly' "$TMP/pon.verbose" > "$TMP/pon"
diff -u "$TMP/poff" "$TMP/pon" || { echo "FAIL: polymorphic-cache output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/pon" | tr -d ' ')" = 4 ] || { echo "FAIL: JitPoly did not finish" >&2; exit 1; }
grep -F 'poly-inline' "$TMP/pon.verbose" >/dev/null \
    || { echo "FAIL: no polymorphic inline cache was built" >&2; exit 1; }
grep -F '(nested)' "$TMP/pon.verbose" >/dev/null \
    || { echo "FAIL: no polymorphic inline cache inside a splice" >&2; exit 1; }
grep -E 'the cache @[0-9]+ met [0-9]+ new class' "$TMP/pon.verbose" >/dev/null \
    || { echo "FAIL: a cache that met a late class was not compiled again" >&2; exit 1; }
echo "   $(grep -c poly-inline "$TMP/pon.verbose") caches, $(tail -1 "$TMP/pon")"

echo "== frameless calls"
./run-java.sh -Xmx256m -cp tests/classes JitFrameless 2>/dev/null | grep '^frameless' > "$TMP/foff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly=JitFrameless -cp tests/classes JitFrameless > "$TMP/fon.verbose" 2>&1
grep '^frameless' "$TMP/fon.verbose" > "$TMP/fon"
diff -u "$TMP/foff" "$TMP/fon" || { echo "FAIL: frameless output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/fon" | tr -d ' ')" = 9 ] || { echo "FAIL: JitFrameless did not finish" >&2; exit 1; }
for m in 'JitFrameless$A.i(I)I' 'JitFrameless$A.j(I)J' 'JitFrameless$A.c(I)C' 'JitFrameless$B.i(I)I' 'JitFrameless.mixD(FDJ)D'; do
  grep -F "[zwc] frameless $m" "$TMP/fon.verbose" >/dev/null \
    || { echo "FAIL: no frameless body for $m" >&2; exit 1; }
done
echo "   $(grep -c '\[zwc\] frameless' "$TMP/fon.verbose") frameless bodies, $(tail -1 "$TMP/fon" | cut -c1-60)"

echo "== frameless bodies that store"
./run-java.sh -Xmx24m -cp tests/classes JitFramelessStores 2>/dev/null | grep '^flstores' > "$TMP/soff"
./run-java.sh -Xmx24m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly=JitFramelessStores -cp tests/classes JitFramelessStores > "$TMP/son.verbose" 2>&1
grep '^flstores' "$TMP/son.verbose" > "$TMP/son"
./run-java.sh -Xmx24m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:-ZeroWasmJITFramelessStores \
    -cp tests/classes JitFramelessStores 2>/dev/null | grep '^flstores' > "$TMP/snost"
diff -u "$TMP/soff" "$TMP/son" || { echo "FAIL: frameless-store output differs" >&2; exit 1; }
diff -u "$TMP/soff" "$TMP/snost" || { echo "FAIL: output differs with frameless stores off" >&2; exit 1; }
[ "$(wc -l < "$TMP/son" | tr -d ' ')" = 4 ] || { echo "FAIL: JitFramelessStores did not finish" >&2; exit 1; }
for m in 'JitFramelessStores$Pos.setY(I)LJitFramelessStores$Pos;' 'JitFramelessStores$Vec.setX(I)LJitFramelessStores$Vec;'; do
  grep -F "[zwc] frameless $m" "$TMP/son.verbose" >/dev/null \
    || { echo "FAIL: no frameless body for $m" >&2; exit 1; }
done
echo "   $(grep -c '\[zwc\] frameless' "$TMP/son.verbose") frameless bodies, $(tail -1 "$TMP/son" | cut -c1-60)"

echo "== frameless bodies that allocate from the TLAB"
./run-java.sh -Xmx64m -cp tests/classes JitFramelessAlloc 2>/dev/null | grep '^flalloc' > "$TMP/aoff"
./run-java.sh -Xmx64m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly=JitFramelessAlloc -cp tests/classes JitFramelessAlloc > "$TMP/aon.verbose" 2>&1
grep '^flalloc' "$TMP/aon.verbose" > "$TMP/aon"
./run-java.sh -Xmx64m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:ZeroWasmJITDisable=536870912 \
    -cp tests/classes JitFramelessAlloc 2>/dev/null | grep '^flalloc' > "$TMP/anost"
diff -u "$TMP/aoff" "$TMP/aon" || { echo "FAIL: frameless-alloc output differs" >&2; exit 1; }
diff -u "$TMP/aoff" "$TMP/anost" || { echo "FAIL: output differs with frameless allocation off" >&2; exit 1; }
[ "$(wc -l < "$TMP/aon" | tr -d ' ')" = 1 ] || { echo "FAIL: JitFramelessAlloc did not finish" >&2; exit 1; }
for m in 'JitFramelessAlloc.allocThenBail([II)I' 'JitFramelessAlloc.bailThenAlloc([II)I' 'JitFramelessAlloc.allocMany(II)I' 'JitFramelessAlloc.allocThenCall(I)I'; do
  grep -F "[zwc] frameless $m" "$TMP/aon.verbose" >/dev/null \
    || { echo "FAIL: no frameless body for $m" >&2; exit 1; }
done
grep -a "\[zwc\] frameless dropped" "$TMP/aon.verbose" >/dev/null \
  || { echo "FAIL: expected the always-retrying bodies to be dropped" >&2; exit 1; }
echo "   $(grep -c '\[zwc\] frameless' "$TMP/aon.verbose") frameless bodies, $(tail -1 "$TMP/aon" | cut -c1-60)"

echo "== interface calls to Object's methods"
./run-java.sh -Xmx256m -cp tests/classes JitForcedVirtual 2>/dev/null | grep '^forcedv' > "$TMP/voff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitForcedVirtual 2>/dev/null | grep '^forcedv' > "$TMP/von"
diff -u "$TMP/voff" "$TMP/von" || { echo "FAIL: forced-virtual output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/von" | tr -d ' ')" = 6 ] || { echo "FAIL: JitForcedVirtual did not finish" >&2; exit 1; }
echo "   $(tail -1 "$TMP/von" | cut -c1-60)"

echo "== hashCode() through Object's vtable slot"
./run-java.sh -Xmx64m -cp tests/classes JitVtableHash 2>/dev/null | grep '^vhash' > "$TMP/hoff"
./run-java.sh -Xmx64m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitVtableHash 2>/dev/null | grep '^vhash' > "$TMP/hon"
diff -u "$TMP/hoff" "$TMP/hon" || { echo "FAIL: vtable-hash output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/hon" | tr -d ' ')" = 3 ] || { echo "FAIL: JitVtableHash did not finish" >&2; exit 1; }
echo "   $(tail -1 "$TMP/hon" | cut -c1-60)"

echo "== cached String hash at polymorphic Object.hashCode sites"
./run-java.sh -Xmx256m -cp tests/classes JitStringHash 2>/dev/null | grep '^shash' > "$TMP/shoff"
[ "$(wc -l < "$TMP/shoff" | tr -d ' ')" = 2 ] || { echo "FAIL: JitStringHash did not finish" >&2; exit 1; }
for flags in '-XX:ZeroWasmJITCallFix=995' '-XX:ZeroWasmJITCallFix=483' '-XX:ZeroWasmJITDisable=2048'; do
  ./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT "$flags" \
      -cp tests/classes JitStringHash 2>/dev/null | grep '^shash' > "$TMP/shon"
  diff -u "$TMP/shoff" "$TMP/shon" || { echo "FAIL: String hash differs with $flags" >&2; exit 1; }
done
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly=JitStringHash \
    -cp tests/classes JitStringHash > "$TMP/shash.verbose" 2>&1
grep '^shash' "$TMP/shash.verbose" | diff -u "$TMP/shoff" - \
    || { echo "FAIL: compiled String hash output differs" >&2; exit 1; }
for m in JitStringHash.hashOf JitStringHash.framed; do
  grep -F "[zwc] compiled $m" "$TMP/shash.verbose" >/dev/null \
    || { echo "FAIL: $m was not compiled" >&2; exit 1; }
done
echo "   cached/fresh/zero hashes, both String encodings, other receivers and nulls match"

echo "== invokedynamic and invokehandle"
./run-java.sh -Xmx256m -cp tests/classes JitIndy 2>/dev/null | grep '^indy' > "$TMP/ioff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly=JitIndy -cp tests/classes JitIndy > "$TMP/ion.verbose" 2>&1
grep '^indy' "$TMP/ion.verbose" > "$TMP/ion"
diff -u "$TMP/ioff" "$TMP/ion" || { echo "FAIL: indy output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/ion" | tr -d ' ')" = 3 ] || { echo "FAIL: JitIndy did not finish" >&2; exit 1; }
for m in JitIndy.search JitIndy.concat JitIndy.area JitIndy.viaHandle JitIndy.thrower; do
  grep -F "[zwc] compiled $m" "$TMP/ion.verbose" >/dev/null \
    || { echo "FAIL: $m was not compiled" >&2; exit 1; }
done
echo "   $(tail -1 "$TMP/ion")"

echo "== profiled virtual calls: class-guarded inlining"
./run-java.sh -Xmx256m -cp tests/classes JitProfiled 2>/dev/null | grep '^profiled' > "$TMP/poff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:ZeroWasmJITProfileRecompile=200 -XX:+ZeroWasmJITVerbose \
    -cp tests/classes JitProfiled > "$TMP/pon.verbose" 2>&1
grep '^profiled' "$TMP/pon.verbose" > "$TMP/pon"
diff -u "$TMP/poff" "$TMP/pon" || { echo "FAIL: profiled-inline output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/pon" | tr -d ' ')" = 4 ] || { echo "FAIL: JitProfiled did not finish" >&2; exit 1; }
grep -F 'profiled-inline @25: JitProfiled$Sq.area()I' "$TMP/pon.verbose" >/dev/null \
    || { echo "FAIL: the monomorphic Shape.area site was not inlined" >&2; exit 1; }
echo "   $(grep -c 'profiled-inline @' "$TMP/pon.verbose") guarded inlines, output identical"

echo "== stores in inlined callees: the undo log"
./run-java.sh -Xmx256m -cp tests/classes JitInlineStores 2>/dev/null | grep '^stores' > "$TMP/soff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly=JitInlineStores \
    -cp tests/classes JitInlineStores > "$TMP/son.verbose" 2>&1
grep '^stores' "$TMP/son.verbose" > "$TMP/son"
diff -u "$TMP/soff" "$TMP/son" || { echo "FAIL: inlined-store output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/son" | tr -d ' ')" = 5 ] || { echo "FAIL: JitInlineStores did not finish" >&2; exit 1; }
for m in 'JitInlineStores$Cursor.next' 'JitInlineStores.mix' 'JitInlineStores.twice' 'JitInlineStores.bump'; do
  grep -F "inlined store" "$TMP/son.verbose" | grep -F "in $m" >/dev/null \
    || { echo "FAIL: no undo-logged store inlined from $m" >&2; exit 1; }
done
echo "   $(grep -c 'inlined store' "$TMP/son.verbose") undo-logged stores, output identical"

echo "== volatile fields as wasm atomics"
./run-java.sh -Xmx256m -cp tests/classes JitVolatile 2>/dev/null | grep '^volatile' > "$TMP/voff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITPrintBails -cp tests/classes JitVolatile > "$TMP/von.log" 2>&1
grep '^volatile' "$TMP/von.log" > "$TMP/von"
diff -u "$TMP/voff" "$TMP/von" || { echo "FAIL: volatile output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/von" | tr -d ' ')" = 4 ] || { echo "FAIL: JitVolatile did not finish" >&2; exit 1; }
echo "   $(tail -1 "$TMP/von")"

echo "== static stores execute once across a later inline guard"
./run-java.sh -Xmx256m -cp tests/classes JitStaticStoreReplay > "$TMP/static-store-off" 2>&1 \
    || { cat "$TMP/static-store-off"; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:ZeroWasmJITOnly=JitStaticStoreReplay -cp tests/classes JitStaticStoreReplay > "$TMP/static-store-on" 2>&1 \
    || { cat "$TMP/static-store-on"; exit 1; }
grep '^PASS static-store-replay ' "$TMP/static-store-off" > "$TMP/static-store-off.result"
grep '^PASS static-store-replay ' "$TMP/static-store-on" > "$TMP/static-store-on.result"
diff -u "$TMP/static-store-off.result" "$TMP/static-store-on.result"
cat "$TMP/static-store-on.result"

echo "== concurrent volatile publication survives later inline guards"
for mode in null profile; do
  ./run-java.sh -Xmx256m -cp tests/classes JitVolatileReplay 1000000 90 "$mode" > "$TMP/replay-$mode-off.log" 2>&1 \
    || { cat "$TMP/replay-$mode-off.log"; exit 1; }
  grep '^PASS volatile-replay:' "$TMP/replay-$mode-off.log" \
    || { cat "$TMP/replay-$mode-off.log"; echo "FAIL: interpreter publication invariant" >&2; exit 1; }
  if [ "$mode" = null ]; then
    grep -E '^volatile-ack attempts=[1-9][0-9]* nullGuards=[1-9][0-9]* impossibleReturns=0 misses=[0-9]+ warmChecksum=280000$' \
        "$TMP/replay-$mode-off.log" \
      || { cat "$TMP/replay-$mode-off.log"; echo "FAIL: interpreter acknowledged-publication coverage" >&2; exit 1; }
  fi
  ./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
      '-XX:ZeroWasmJITOnly=JitVolatileReplay$Writer' \
      -cp tests/classes JitVolatileReplay 1000000 90 "$mode" > "$TMP/replay-$mode-on.log" 2>&1 \
    || { cat "$TMP/replay-$mode-on.log"; exit 1; }
  grep '^PASS volatile-replay:' "$TMP/replay-$mode-on.log" \
    || { cat "$TMP/replay-$mode-on.log"; echo "FAIL: JIT publication invariant" >&2; exit 1; }
  if [ "$mode" = null ]; then
    grep -E '^volatile-ack attempts=[1-9][0-9]* nullGuards=[1-9][0-9]* impossibleReturns=0 misses=[0-9]+ warmChecksum=280000$' \
        "$TMP/replay-$mode-on.log" \
      || { cat "$TMP/replay-$mode-on.log"; echo "FAIL: JIT acknowledged-publication coverage" >&2; exit 1; }
  fi
done

echo "== real queue and serial executor parked-consumer progression"
for mode in queue executor; do
  ./run-java.sh -Xmx256m \
      --add-opens=java.base/java.util.concurrent=ALL-UNNAMED \
      --add-opens=java.base/java.util.concurrent.locks=ALL-UNNAMED \
      -cp tests/classes QueueSignalStress "$mode" 8000 90 > "$TMP/queue-$mode-off.log" 2>&1 \
    || { cat "$TMP/queue-$mode-off.log"; exit 1; }
  grep "^PASS queue-signal mode=$mode " "$TMP/queue-$mode-off.log" \
    || { cat "$TMP/queue-$mode-off.log"; echo "FAIL: interpreter queue consumer invariant" >&2; exit 1; }
  ./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
      --add-opens=java.base/java.util.concurrent=ALL-UNNAMED \
      --add-opens=java.base/java.util.concurrent.locks=ALL-UNNAMED \
      -cp tests/classes QueueSignalStress "$mode" 8000 90 > "$TMP/queue-$mode-on.log" 2>&1 \
    || { cat "$TMP/queue-$mode-on.log"; exit 1; }
  grep "^PASS queue-signal mode=$mode " "$TMP/queue-$mode-on.log" \
    || { cat "$TMP/queue-$mode-on.log"; echo "FAIL: JIT queue consumer invariant" >&2; exit 1; }
done

echo "== VarHandle array reads and volatile longs as code (ZeroWasmJITIndyFast)"
./run-java.sh -Xmx256m -cp tests/classes JitVarHandle 2>/dev/null | grep '^vh' > "$TMP/vhoff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitVarHandle 2>/dev/null | grep '^vh' > "$TMP/vhon"
diff -u "$TMP/vhoff" "$TMP/vhon" || { echo "FAIL: VarHandle output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/vhon" | tr -d ' ')" = 24 ] || { echo "FAIL: JitVarHandle did not finish" >&2; exit 1; }
grep -F 'vh torn reads 0' "$TMP/vhon" >/dev/null || { echo "FAIL: a volatile long read was torn" >&2; exit 1; }
grep -F 'vh moving elements bad=0' "$TMP/vhon" >/dev/null || { echo "FAIL: an element read went stale" >&2; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:+ZeroWasmJITVerbose \
    -cp tests/classes JitVarHandle > "$TMP/vh.verbose" 2>&1
for p in 'VarHandle array atomic read @8 in java.util.concurrent.atomic.AtomicReferenceArray.get(I)Ljava/lang/Object;, guarded' \
         'VarHandle array read @10 in JitVarHandle.vhModes([Ljava/lang/Object;I)J' \
         'VarHandle array atomic read @5 in JitVarHandle.castSite([Ljava/lang/Object;I)I'; do
  grep -F "$p" "$TMP/vh.verbose" >/dev/null || { echo "FAIL: no fast path: $p" >&2; exit 1; }
done
! grep -E 'frameless stops @[1-9][0-9]* in JitVarHandle\.(readLong|tornReads)' "$TMP/vh.verbose" >/dev/null \
    || { echo "FAIL: a volatile long read still stops a frameless body" >&2; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:ZeroWasmJITIndyFast=0 \
    -cp tests/classes JitVarHandle 2>/dev/null | grep '^vh' | diff -u "$TMP/vhoff" - \
    || { echo "FAIL: VarHandle output differs with the fast paths off" >&2; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:ZeroWasmJITIndyFast=0 \
    -XX:+ZeroWasmJITVerbose -cp tests/classes JitVarHandle > "$TMP/vh0.verbose" 2>&1
! grep -F 'VarHandle array' "$TMP/vh0.verbose" >/dev/null \
    || { echo "FAIL: -XX:ZeroWasmJITIndyFast=0 left a fast path on" >&2; exit 1; }
echo "   $(grep -c 'VarHandle array' "$TMP/vh.verbose") element reads as code, $(sed -n 1p "$TMP/vhon" | cut -c1-40)..., output identical"

echo "== lambda capture as code (ZeroWasmJITIndyFast 2)"
./run-java.sh -Xmx256m -cp tests/classes JitLambdaAlloc 2>/dev/null | grep '^lam' > "$TMP/lamoff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:+ZeroWasmJITVerbose \
    -cp tests/classes JitLambdaAlloc > "$TMP/lam.verbose" 2>&1
grep '^lam' "$TMP/lam.verbose" > "$TMP/lamon"
diff -u "$TMP/lamoff" "$TMP/lamon" || { echo "FAIL: lambda output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/lamon" | tr -d ' ')" = 16 ] || { echo "FAIL: JitLambdaAlloc did not finish" >&2; exit 1; }
for p in 'lam kept bad=0' 'lam moving bad=0' 'lam constant same=40000/40000/40000' 'captures distinct=40000'; do
  grep -F "$p" "$TMP/lamon" >/dev/null || { echo "FAIL: $p" >&2; exit 1; }
done
for p in 'lambda capture of 10 @17 in JitLambdaAlloc.capTen(' \
         'lambda capture of 2 @2 in JitLambdaAlloc.framelessCap(II)I, guarded' \
         'lambda capture of 2 @2 in JitLambdaAlloc.make(ILJitLambdaAlloc$Cell;)Ljava/util/function/IntSupplier;, guarded' \
         'lambda constant @0 in JitLambdaAlloc.constant()Ljava/util/function/IntSupplier;'; do
  grep -F "$p" "$TMP/lam.verbose" >/dev/null || { echo "FAIL: no fast path: $p" >&2; exit 1; }
done
grep -F '[zwc] frameless JitLambdaAlloc.framelessCap(II)I' "$TMP/lam.verbose" >/dev/null \
    || { echo "FAIL: a capturing method did not get a frameless body" >&2; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:+UseParallelGC \
    -XX:TLABSize=2k -XX:MinTLABSize=2k -XX:-ResizeTLAB \
    -cp tests/classes JitLambdaAlloc 2>/dev/null | grep '^lam' | diff -u "$TMP/lamoff" - \
    || { echo "FAIL: lambda output differs with small TLABs" >&2; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:ZeroWasmJITIndyFast=1 \
    -XX:+ZeroWasmJITVerbose -cp tests/classes JitLambdaAlloc > "$TMP/lam1.verbose" 2>&1
grep '^lam' "$TMP/lam1.verbose" | diff -u "$TMP/lamoff" - \
    || { echo "FAIL: lambda output differs with the fast path off" >&2; exit 1; }
! grep -E 'lambda (capture of|constant) @' "$TMP/lam1.verbose" >/dev/null \
    || { echo "FAIL: -XX:ZeroWasmJITIndyFast=1 left the lambda fast path on" >&2; exit 1; }
echo "   $(grep -cE 'lambda (capture of|constant) @' "$TMP/lam.verbose") lambda sites as code, $(sed -n 1p "$TMP/lamon" | cut -c1-40)..., output identical"

echo "== enum switches as a table (ZeroWasmJITIndyFast 4)"
./run-java.sh -Xmx256m -cp tests/classes JitEnumSwitch 2>/dev/null | grep '^esw' > "$TMP/eswoff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:+ZeroWasmJITVerbose \
    -cp tests/classes JitEnumSwitch > "$TMP/esw.verbose" 2>&1
grep '^esw' "$TMP/esw.verbose" > "$TMP/eswon"
diff -u "$TMP/eswoff" "$TMP/eswon" || { echo "FAIL: enum switch output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/eswon" | tr -d ' ')" = 13 ] || { echo "FAIL: JitEnumSwitch did not finish" >&2; exit 1; }
for p in 'enum switch over 4 constants @6 in JitEnumSwitch\.full\(LJitEnumSwitch\$Color;\)I$' \
         'enum switch over 4 constants @6 in JitEnumSwitch\.full\(LJitEnumSwitch\$Color;\)I, guarded$' \
         'enum switch over 70 constants @6 in JitEnumSwitch\.partial\(LJitEnumSwitch\$Big;\)I' \
         'enum switch over 4 constants @8 in JitEnumSwitch\.body\(' \
         'enum switch over 4 constants @2 in JitEnumSwitchGen\.sw\(LJitEnumSwitch\$Color;I\)I'; do
  grep -E "$p" "$TMP/esw.verbose" >/dev/null || { echo "FAIL: no fast path: $p" >&2; exit 1; }
done
grep -F '[zwc] frameless JitEnumSwitch.full(LJitEnumSwitch$Color;)I' "$TMP/esw.verbose" >/dev/null \
    || { echo "FAIL: a method with an enum switch did not get a frameless body" >&2; exit 1; }
! grep -E 'enum switch over .* in JitEnumSwitch\.(guarded|noNull|shape)\(' "$TMP/esw.verbose" >/dev/null \
    || { echo "FAIL: a switch with a Class label (a typeSwitch) was taken as a table" >&2; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:ZeroWasmJITIndyFast=3 \
    -XX:+ZeroWasmJITVerbose -cp tests/classes JitEnumSwitch > "$TMP/esw3.verbose" 2>&1
grep '^esw' "$TMP/esw3.verbose" | diff -u "$TMP/eswoff" - \
    || { echo "FAIL: enum switch output differs with the fast path off" >&2; exit 1; }
! grep -F 'enum switch over' "$TMP/esw3.verbose" >/dev/null \
    || { echo "FAIL: -XX:ZeroWasmJITIndyFast=3 left the enum switch fast path on" >&2; exit 1; }
echo "   $(grep -c 'enum switch over' "$TMP/esw.verbose") enum switches as code, $(sed -n 4p "$TMP/eswon" | cut -c1-40)..., output identical"

echo "== System.nanoTime / currentTimeMillis intrinsic (zwc_clock)"
./run-java.sh -Xmx256m -cp tests/classes JitClock 2>/dev/null | grep '^clock' > "$TMP/clkoff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitClock 2>/dev/null | grep '^clock' > "$TMP/clkon"
diff -u "$TMP/clkoff" "$TMP/clkon" || { echo "FAIL: clock output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/clkon" | tr -d ' ')" = 6 ] || { echo "FAIL: JitClock did not finish" >&2; exit 1; }
! grep -q false "$TMP/clkon" || { echo "FAIL: clock check failed: $(grep false "$TMP/clkon" | tr '\n' ' ')" >&2; exit 1; }
echo "   compiled clocks agree with the natives"

echo "== Class.isInstance / Class.cast intrinsic"
./run-java.sh -Xmx256m -cp tests/classes JitClassCast 2>/dev/null | grep '^cast' > "$TMP/ccoff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitClassCast 2>/dev/null | grep '^cast' > "$TMP/ccon"
diff -u "$TMP/ccoff" "$TMP/ccon" || { echo "FAIL: isInstance output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/ccon" | tr -d ' ')" = 3 ] || { echo "FAIL: JitClassCast did not finish" >&2; exit 1; }
echo "   $(sed -n 2p "$TMP/ccon")"

echo "== direct calls into frameless bodies"
./run-java.sh -Xmx256m -cp tests/classes JitDirect 2>/dev/null | grep '^direct' > "$TMP/dcoff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:ZeroWasmJITProfileRecompile=200 -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly=JitDirect \
    -cp tests/classes JitDirect > "$TMP/dcon.verbose" 2>&1
grep '^direct' "$TMP/dcon.verbose" > "$TMP/dcon"
diff -u "$TMP/dcoff" "$TMP/dcon" || { echo "FAIL: direct-call output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/dcon" | tr -d ' ')" = 4 ] || { echo "FAIL: JitDirect did not finish" >&2; exit 1; }
grep -F 'JitDirect.widths(I)J: 0 virtual calls inlined, 8 direct call sites' "$TMP/dcon.verbose" >/dev/null \
    || { echo "FAIL: widths() did not call its eight callees directly" >&2; exit 1; }
echo "   $(grep -c 'direct call sites' "$TMP/dcon.verbose") methods with direct calls, output identical"

echo "== Unsafe accessors inline"
./run-java.sh -Xmx256m -cp tests/classes JitUnsafe 2>/dev/null | grep '^unsafe' > "$TMP/usoff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:+ZeroWasmJITCallStats \
    -cp tests/classes JitUnsafe 200000 > "$TMP/uson.stats" 2>&1
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitUnsafe 2>/dev/null | grep '^unsafe' > "$TMP/uson"
diff -u "$TMP/usoff" "$TMP/uson" || { echo "FAIL: Unsafe accessor output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/uson" | tr -d ' ')" = 3 ] || { echo "FAIL: JitUnsafe did not finish" >&2; exit 1; }
if grep -F 'native' "$TMP/uson.stats" | grep -q 'jdk.internal.misc.Unsafe\.\(get\|put\|compareAndSetInt\|compareAndSetReference\|compareAndExchangeInt\|compareAndExchangeReference\|compareAndSetLong\)'; then
  echo "FAIL: Unsafe accessors still called as natives" >&2; exit 1
fi
echo "   $(sed -n 1p "$TMP/uson" | cut -c1-60)..., no Unsafe natives left"

echo "== unaligned Unsafe buffers and byte-array views"
./run-java.sh -Xmx256m -cp tests/classes JitUnaligned 2>/dev/null | grep '^unaligned' > "$TMP/uaoff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitUnaligned 2>/dev/null | grep '^unaligned' > "$TMP/uaon"
diff -u "$TMP/uaoff" "$TMP/uaon" || { echo "FAIL: unaligned accessor output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/uaon" | tr -d ' ')" = 6 ] || { echo "FAIL: JitUnaligned did not finish" >&2; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:ZeroWasmJITDisable=2097152 \
    -cp tests/classes JitUnaligned 2>/dev/null | grep '^unaligned' | diff -u "$TMP/uaoff" - \
    || { echo "FAIL: unaligned accessor output differs with Unsafe intrinsics off" >&2; exit 1; }
echo "   heap/direct buffers, both byte orders and byte-array views match the interpreter"

echo "== framed calls that build the callee's frame in wasm"
./run-java.sh -Xmx256m -cp tests/classes JitFramed 2>/dev/null | grep '^framed' > "$TMP/froff"
# A Chrome-sized engine stack: deep recursion must still end in StackOverflowError.
MCWEB_STACK_MB=1 ./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITCallStats -cp tests/classes JitFramed > "$TMP/fron.stats" 2>&1
grep '^framed' "$TMP/fron.stats" > "$TMP/fron"
diff -u "$TMP/froff" "$TMP/fron" || { echo "FAIL: framed-call output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/fron" | tr -d ' ')" = 3 ] || { echo "FAIL: JitFramed did not finish" >&2; exit 1; }
# Needs an engine that imports the function table cheaply (Node 24, Chromium).
if ! grep -q 'framed in wasm [1-9]' "$TMP/fron.stats"; then
  echo "FAIL: no framed call built its frame in wasm (Node 22? see run-java.sh)" >&2; exit 1
fi
echo "   $(sed -n 1p "$TMP/fron" | cut -c1-50)..., $(grep -o 'framed in wasm [0-9.]*%' "$TMP/fron.stats" | tail -1)"

echo "== Thread.currentThread and Reference.refersTo0 inline"
./run-java.sh -Xmx256m -cp tests/classes JitThreadLocal 2>/dev/null | grep '^tl' > "$TMP/tloff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:+ZeroWasmJITCallStats \
    -cp tests/classes JitThreadLocal > "$TMP/tlon.stats" 2>&1
grep '^tl' "$TMP/tlon.stats" > "$TMP/tlon"
diff -u "$TMP/tloff" "$TMP/tlon" || { echo "FAIL: ThreadLocal/refersTo output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/tlon" | tr -d ' ')" = 4 ] || { echo "FAIL: JitThreadLocal did not finish" >&2; exit 1; }
if grep -F 'native' "$TMP/tlon.stats" | grep -q 'refersTo0\|Thread.currentThread\|Object.getClass'; then
  echo "FAIL: refersTo0, currentThread or getClass still called as natives" >&2; exit 1
fi
echo "   $(sed -n 2p "$TMP/tlon"), no refersTo0/currentThread/getClass natives left"

echo "== profiled inlining inside inlined callees"
./run-java.sh -Xmx256m -cp tests/classes JitNested 2>/dev/null | grep '^nested' > "$TMP/nsoff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:+ZeroWasmJITVerbose \
    -cp tests/classes JitNested > "$TMP/nson.verbose" 2>&1
grep '^nested' "$TMP/nson.verbose" > "$TMP/nson"
diff -u "$TMP/nsoff" "$TMP/nson" || { echo "FAIL: nested-inline output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/nson" | tr -d ' ')" = 3 ] || { echo "FAIL: JitNested did not finish" >&2; exit 1; }
grep -F 'profiled-inline @1: JitNested$Height.maxSection()I' "$TMP/nson.verbose" >/dev/null \
    || { echo "FAIL: the default method inside sections() was not inlined" >&2; exit 1; }
echo "   $(grep -c 'profiled-inline @.*JitNested' "$TMP/nson.verbose") guarded inlines in JitNested, output identical"

echo "== calls never taken as cold paths"
./run-java.sh -Xmx256m -cp tests/classes JitColdCall 2>/dev/null | grep '^coldcall' > "$TMP/ccoff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitColdCall 2>/dev/null | grep '^coldcall' > "$TMP/ccon"
diff -u "$TMP/ccoff" "$TMP/ccon" || { echo "FAIL: cold-call output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/ccon" | tr -d ' ')" = 2 ] || { echo "FAIL: JitColdCall did not finish" >&2; exit 1; }
echo "   $(sed -n 2p "$TMP/ccon" | cut -c1-60)..., output identical"

echo "== identity hash from the header, allocateInstance inline, calls on this bound by class"
for t in JitHash:hash JitAlloc:alloc JitArrays:arrays JitLateClass:late JitExactThis:exact JitInlineAlloc:ialloc JitColdJoin:coldjoin RecordBench:records JitFusedLoads:fused JitInlineArrayStores:astore JitRem:rem JitRecordGc:rgc JitRecordShape:shape; do
  c=${t%%:*}; pfx=${t#*:}
  ./run-java.sh -Xmx256m -cp tests/classes $c 2>/dev/null | grep "^$pfx" > "$TMP/$c.off"
  ./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:+ZeroWasmJITCallStats \
      -cp tests/classes $c > "$TMP/$c.stats" 2>&1
  grep "^$pfx" "$TMP/$c.stats" > "$TMP/$c.on"
  diff -u "$TMP/$c.off" "$TMP/$c.on" || { echo "FAIL: $c output differs" >&2; exit 1; }
  [ -s "$TMP/$c.on" ] || { echo "FAIL: $c did not finish" >&2; exit 1; }
done
if grep -F 'native' "$TMP/JitAlloc.stats" | grep -q 'allocateInstance'; then
  echo "FAIL: allocateInstance still called as a native" >&2; exit 1
fi
echo "   $(cat "$TMP/JitHash.on" | cut -c1-60)..., output identical"

echo "== native calls: wasm trampolines against libffi"
./run-java.sh -Xmx256m -cp tests/classes NativeCalls 2>/dev/null | grep '^native' > "$TMP/noff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -cp tests/classes NativeCalls > "$TMP/non.verbose" 2>&1
grep '^native' "$TMP/non.verbose" > "$TMP/non"
diff -u "$TMP/noff" "$TMP/non" || { echo "FAIL: native-call output differs" >&2; exit 1; }
[ "$(wc -l < "$TMP/non" | tr -d ' ')" = 6 ] || { echo "FAIL: NativeCalls did not finish" >&2; exit 1; }
grep -F '[zwc] native trampoline' "$TMP/non.verbose" >/dev/null \
    || { echo "FAIL: no native trampoline was built" >&2; exit 1; }
! grep -F 'keeps libffi' "$TMP/non.verbose" >/dev/null \
    || { echo "FAIL: a native fell back to libffi" >&2; exit 1; }
echo "   $(grep -c '\[zwc\] native trampoline' "$TMP/non.verbose") signatures, $(tail -1 "$TMP/non")"

echo "== inlining"
IOFF=$(./run-java.sh -Xmx256m -cp tests/classes JitInline 2>/dev/null | grep '^inline')
ION=$(./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
      -cp tests/classes JitInline 2>/dev/null | grep '^inline')
echo "   off: $IOFF"
echo "   on : $ION"
[ "${IOFF#*checksum }" = "${ION#*checksum }" ] || { echo "FAIL: inline checksum differs" >&2; exit 1; }

echo "== focused inline CFG, bail and merge proofs"
./run-java.sh -Xmx256m -cp tests/classes JitBranch 2>/dev/null | grep '^branch' > "$TMP/boff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitBranch 2>/dev/null | grep '^branch' > "$TMP/bon"
diff -u "$TMP/boff" "$TMP/bon" || { echo "FAIL: branch output differs" >&2; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly='JitBranch.hot' \
    -cp tests/classes JitBranch > "$TMP/branch.verbose" 2>&1
grep -F '[zwc] compiled JitBranch.hot' "$TMP/branch.verbose" >/dev/null
echo "   forward branch targets compiled: JitBranch.hot"

./run-java.sh -Xmx256m -cp tests/classes JitMerge 2>/dev/null | grep -E '^merge |^guard ' > "$TMP/moff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitMerge 2>/dev/null | grep -E '^merge |^guard ' > "$TMP/mon"
diff -u "$TMP/moff" "$TMP/mon" || { echo "FAIL: merge/guard output differs" >&2; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly='JitMerge.caller' \
    -cp tests/classes JitMerge > "$TMP/merge.verbose" 2>&1
grep -F '[zwc] compiled JitMerge.caller' "$TMP/merge.verbose" >/dev/null
grep -F 'guard thrown' "$TMP/merge.verbose" >/dev/null
echo "   value merge and guard bail compiled: JitMerge.caller"

./run-java.sh -Xmx256m -cp tests/classes JitDiff 2>/dev/null \
    | grep -E '^x=|^npe|^aioobe|^array-npe' > "$TMP/goff"
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -cp tests/classes JitDiff 2>/dev/null \
    | grep -E '^x=|^npe|^aioobe|^array-npe' > "$TMP/gon"
diff -u "$TMP/goff" "$TMP/gon" || { echo "FAIL: guard-bail output differs" >&2; exit 1; }
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly='JitDiff.nullField' \
    -cp tests/classes JitDiff > "$TMP/guard.verbose" 2>&1
grep -F '[zwc] compiled JitDiff.nullField' "$TMP/guard.verbose" >/dev/null
grep -F 'npe: thrown' "$TMP/guard.verbose" >/dev/null
echo "   guard bail compiled: JitDiff.nullField"

./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly='JitInline.hot' \
    -cp tests/classes JitInline 5000 4000 > "$TMP/nested.verbose" 2>&1
grep -F '[zwc] compiled JitInline.hot' "$TMP/nested.verbose" >/dev/null
NESTED=$(grep '^inline' "$TMP/nested.verbose")
echo "   nested inline compiled: $NESTED"

./run-java.sh -Xmx256m -cp tests/classes DirectCodeProbe > "$TMP/direct-interpreter" 2>&1
grep -F 'direct-code 466890' "$TMP/direct-interpreter" >/dev/null

./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly='DirectCodeBuilder$4.writeBody' \
    -XX:ZeroWasmJITStopAt=120 -cp tests/classes DirectCodeProbe > "$TMP/direct120" 2>&1
./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
    -XX:+ZeroWasmJITVerbose -XX:ZeroWasmJITOnly='DirectCodeBuilder$4.writeBody' \
    -XX:ZeroWasmJITStopAt=122 -cp tests/classes DirectCodeProbe > "$TMP/direct122" 2>&1
grep -F '[zwc] compiled jdk.internal.classfile.impl.DirectCodeBuilder$4.writeBody' "$TMP/direct120" >/dev/null
grep -F '[zwc] compiled jdk.internal.classfile.impl.DirectCodeBuilder$4.writeBody' "$TMP/direct122" >/dev/null
grep -F 'direct-code 466890' "$TMP/direct120" >/dev/null
grep -F 'direct-code 466890' "$TMP/direct122" >/dev/null
! grep -E 'ClassFormatError|Exception in thread|direct-code [^4]' "$TMP/direct122" >/dev/null
echo "   non-guard bail boundary compiled and matched: StopAt=120,122"

echo "== throughput"
OFF=$(./run-java.sh -Xmx256m -cp tests/classes JitBench 5000 4000 2>/dev/null | grep '^hot')
ON=$(./run-java.sh -Xmx256m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
     -cp tests/classes JitBench 5000 4000 2>/dev/null | grep '^hot')
echo "   off: $OFF"
echo "   on : $ON"
[ "${OFF#*checksum }" = "${ON#*checksum }" ] || { echo "FAIL: checksum differs" >&2; exit 1; }
echo "PASS"
