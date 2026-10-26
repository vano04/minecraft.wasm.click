#!/bin/sh
# Compile the test classes and the fixture JAR used by the node and browser
# gates. Needs a host JDK 25 (the boot JDK is fine).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/jdk-home.sh"
JH=$BOOT_JDK/bin

"$JH/javac" -nowarn -d "$HERE/tests/classes" \
  "$HERE/tests/Hello.java" "$HERE/tests/JarLoad.java" \
  "$HERE/tests/Bench.java" "$HERE/tests/Bench2.java" "$HERE/tests/MathCheck.java"

"$JH/javac" -nowarn -d "$HERE/tests/jarclasses" "$HERE/tests/jarsrc/Plugin.java"
mkdir -p "$HERE/tests/jarclasses/data"
echo "resource loaded from jar" > "$HERE/tests/jarclasses/data/hello.txt"
"$JH/jar" --create --file "$HERE/tests/plugin.jar" --main-class Plugin -C "$HERE/tests/jarclasses" .

echo "test classes and tests/plugin.jar built"
