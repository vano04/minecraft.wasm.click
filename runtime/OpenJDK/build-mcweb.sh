#!/bin/sh
# Build MC-Web's browser port for this JVM:
#
#   1. stub annotations, so the port's sources compile without GraalVM
#   2. the port itself (src/graal/java), against Mojang's jar as the tab
#      patches it (build/massaged/..., written by tools/build-wasmjvm.mjs)
#   3. the @JS -> JNI/EM_JS bridge, generated from those same sources
#
# Mojang's code is only the compile classpath here; none of it is compiled or
# packed. Any javac error fails the build: the port must link against exactly
# what the browser runs.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
. "$HERE/jdk-home.sh"
JH=$BOOT_JDK/bin
JAR=${MCWEB_COMPILE_JAR:-"$ROOT/build/massaged/minecraft-26.3-massaged.jar"}
LIBS=${MCWEB_LIBRARIES_DIR:-"$ROOT/build/wasmjvm-libraries-26.3"}

[ -f "$JAR" ] || { echo "missing $JAR (run node tools/build-wasmjvm.mjs; it massages Mojang's jar)" >&2; exit 1; }
[ -d "$LIBS" ] || { echo "missing library set $LIBS" >&2; exit 1; }

CP="$JAR:$(find "$LIBS" -name '*.jar' | grep -v natives | LC_ALL=C sort | tr '\n' ':')"

# Start clean: a class whose source was deleted must not survive into the jar.
rm -rf "$HERE/mcweb/classes" "$HERE/mcweb/shim-classes"

"$JH/javac" -nowarn -d "$HERE/mcweb/shim-classes" \
  $(find "$HERE/mcweb/shim-src" -name '*.java' | LC_ALL=C sort)

"$JH/javac" -nowarn -proc:none -d "$HERE/mcweb/classes" \
  -cp "$HERE/mcweb/shim-classes:$CP" \
  $(find "$ROOT/src/graal/java" -name '*.java' | LC_ALL=C sort)

"$JH/javac" -nowarn -d "$HERE/mcweb/classes" -cp "$HERE/mcweb/classes:$CP" \
  "$HERE/mcweb/boot-src/dev/mcweb/wasm/Boot.java"

node "$HERE/mcweb/gen-jsbridge.mjs" "$ROOT/src/graal/java" \
  "$HERE/mcweb/jsbridge.c" "$HERE/mcweb/jsbridge-report.txt"

# emsdk_env.sh locates itself with bash-only means, so under a POSIX sh
# (Linux's dash) it leaves EMSDK and PATH unset. Name the tree explicitly.
EMSDK="$HERE/work/emsdk"
export EMSDK
. "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
command -v emcc >/dev/null 2>&1 || PATH="$EMSDK/upstream/emscripten:$EMSDK:$PATH"
INC="$HERE/work/jdk25/build/wasm-zero/jdk/include"
# A failed emcc must fail the build: the old bridge would otherwise ship with
# new port classes and pass every later check.
rm -f "$HERE/mcweb/libmcwebjs.so"
EMCC_LOG=$(mktemp)
if ! emcc -O2 -fPIC -pthread -sSIDE_MODULE=1 -I"$INC" -I"$INC/linux" \
    "$HERE/mcweb/jsbridge.c" -o "$HERE/mcweb/libmcwebjs.so" >"$EMCC_LOG" 2>&1; then
  cat "$EMCC_LOG" >&2; rm -f "$EMCC_LOG"; exit 1
fi
grep -vE "^(cache|system_libs):|Winvalid-pp-token|^ *[0-9]+ \||^ *\||^ *\^" "$EMCC_LOG" || true
rm -f "$EMCC_LOG"

# Package the port as a jar so the browser payload is jars only. The one
# resource is the SLF4J provider registration; --date and --no-manifest make
# the jar's bytes depend on the class files alone.
"$JH/jar" --create --date=1980-01-01T00:00:02Z --no-manifest \
  --file "$HERE/mcweb/mcweb-port.jar" \
  -C "$HERE/mcweb/classes" . -C "$HERE/mcweb/shim-classes" . \
  -C "$ROOT/src/graal/resources" META-INF/services

echo "mcweb classes + libmcwebjs.so built"
head -2 "$HERE/mcweb/jsbridge-report.txt"
