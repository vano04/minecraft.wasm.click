#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
: "${BOOT_JDK:?Set BOOT_JDK to the host JDK 25 compiler}"
TEST_WORK=${MCWEB_RETIREMENT_WORK:-"$HERE/../work/retirement-check"}
mkdir -p "$TEST_WORK/classes"
python3 "$HERE/generate-retirement-stress.py" "$TEST_WORK/RetirementStress.java"
"$BOOT_JDK/bin/javac" -d "$TEST_WORK/classes" "$TEST_WORK/RetirementStress.java"
"$BOOT_JDK/bin/java" -cp "$TEST_WORK/classes" RetirementStress > "$TEST_WORK/host.log"
"$HERE/../run-java.sh" -Xmx384m -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT -XX:ZeroWasmJITOnly=RetirementStress -XX:ZeroWasmJITThreshold=20 -XX:ZeroWasmJITProfileRecompile=40 -XX:ZeroWasmJITUnitDelay=1 -XX:ZeroWasmJITUnitCalls=100 -XX:+ZeroWasmJITPrintBails -XX:+UseSerialGC -Xrs -cp "$TEST_WORK/classes" RetirementStress > "$TEST_WORK/wasm.log" 2>&1
expected=$(sed -n '/^RETIREMENT-CHECKSUM /p' "$TEST_WORK/host.log")
actual=$(sed -n '/^RETIREMENT-CHECKSUM /p' "$TEST_WORK/wasm.log")
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { tail -30 "$TEST_WORK/wasm.log"; exit 1; }
printf '%s\n' "PASS retired-code calls, changing receiver classes and profile recompilation: $actual"
sed -n '/\[zwc\] compiles /p' "$TEST_WORK/wasm.log" | tail -5
