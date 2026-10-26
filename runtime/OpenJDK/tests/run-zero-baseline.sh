#!/bin/sh
# OSS-only smoke/gate runner for the experimental ZeroWasmBaseline lane.
# It creates all classes/JARs and logs under a fresh /private/tmp directory;
# no Minecraft or player-supplied input is read.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JAVAC=${JAVAC:-/opt/homebrew/opt/openjdk@25/bin/javac}
JAR=${JAR:-/opt/homebrew/opt/openjdk@25/bin/jar}
RUN_JAVA="$ROOT/run-java.sh"
WORK=$(mktemp -d /private/tmp/mcweb-zero-baseline.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM
mkdir -p "$WORK/classes"

"$JAVAC" -g:none -d "$WORK/classes" "$ROOT/tests/ZeroBaselineFixture.java"
"$JAR" --create --date=2026-01-01T00:00:00+00:00 --file "$WORK/fixture.jar" -C "$WORK/classes" .
JAR_SHA=$(shasum -a 256 "$WORK/fixture.jar" | awk '{print $1}')
CLASS_SHA=$(shasum -a 256 "$WORK/classes/ZeroBaselineFixture.class" | awk '{print $1}')
DEPS="sha256:$CLASS_SHA"

BASELINE_ARGS="-XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmBaseline -XX:ZeroWasmBaselineJarHash=$JAR_SHA -XX:ZeroWasmBaselineClassHash=$CLASS_SHA -XX:ZeroWasmBaselineDependencyHashes=$DEPS"

"$RUN_JAVA" -Xmx256m -cp "$WORK/classes" ZeroBaselineFixture 1000 > "$WORK/off.log" 2>&1
# shellcheck disable=SC2086
"$RUN_JAVA" -Xmx256m $BASELINE_ARGS -XX:+ZeroWasmBaselineVerbose -cp "$WORK/classes" ZeroBaselineFixture 1000 > "$WORK/on.log" 2>&1

OFF_RESULT=$(rg '^baseline-fixture ' "$WORK/off.log")
ON_RESULT=$(rg '^baseline-fixture ' "$WORK/on.log")
[ "$OFF_RESULT" = "$ON_RESULT" ] || {
  echo "REJECT: interpreter/baseline result mismatch" >&2
  printf '%s\n' "$OFF_RESULT" > "$WORK/off.result"
  printf '%s\n' "$ON_RESULT" > "$WORK/on.result"
  diff -u "$WORK/off.result" "$WORK/on.result" >&2 || true
  exit 1
}

rg -q '\[zbb\] module direct-call caller->leaf wasm-call=0 bytes=' "$WORK/on.log"
rg -q '\[zbb\] JS_INSTALL table-slots=[0-9]+,[0-9]+,[0-9]+,[0-9]+ bytes=' "$WORK/on.log"
rg -q '\[zbb\] TABLE_CALL hot=main-wasm slot=[0-9]+ signature=(ii|iii)' "$WORK/on.log"
rg -q '\[zbb\] DEOPT virtualValue @2 .*resume-bci=2' "$WORK/on.log"
rg -q '\[zbb\] EXCEPTION_RESUME safeDiv @2 .*resume-bci=2' "$WORK/on.log"
! rg -q 'CALL MISMATCH' "$WORK/on.log"

echo "ACCEPT semantic/direct/fallback smoke"
echo "$OFF_RESULT"
rg '^baseline-caller-ns |^baseline-virtual|^baseline-div' "$WORK/on.log"
rg -m1 '^\[zbb\] module direct-call' "$WORK/on.log"
echo "cacheMetadata jar=$JAR_SHA class=$CLASS_SHA dependencies=$DEPS wasm=wasm32-i32-pure-functions"
