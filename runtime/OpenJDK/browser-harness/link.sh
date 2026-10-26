#!/bin/sh
# Minimal browser link of the wasm JVM for headless-Chromium checks:
# link-browser.sh's flags without the MC-Web bridge preloads and loader patch,
# so it needs nothing but the JDK build (run ../make-image.sh first). Output
# goes to build/wasmjvm-harness/ with the harness pages next to it. Extra
# preload directories come in as arguments (host@/vfs).
set -eu
SRC=$(cd "$(dirname "$0")" && pwd)
OJ=$(cd "$SRC/.." && pwd)
HERE=$(cd "$OJ/.." && pwd)/build/wasmjvm-harness
mkdir -p "$HERE"
WORK="$OJ/work"; BUILD="$WORK/jdk25/build/wasm-zero"
EMSDK="$WORK/emsdk"; export EMSDK
. "$EMSDK/emsdk_env.sh" >/dev/null 2>&1 || true
command -v emcc >/dev/null 2>&1 || PATH="$EMSDK/upstream/emscripten:$EMSDK:$PATH"
COMPAT_O="$BUILD/emscripten_posix_compat.o"
emcc -c -O2 -fPIC -pthread "$OJ/patches/emscripten-compat/emscripten_posix_compat.c" -o "$COMPAT_O"
EXTRA=""
for p in "$@"; do EXTRA="$EXTRA --preload-file $p"; done
# shellcheck disable=SC2086
EMCC_FORCE_STDLIBS=1 em++ -pthread \
  -L"$BUILD/support/modules_libs/java.base" \
  -o "$HERE/javavm.js" \
  "$BUILD/support/native/java.base/java/main.o" "$COMPAT_O" -ljli \
  "$WORK/prefix/lib/libffi.a" \
  --pre-js "$SRC/pre.js" \
  --preload-file "$WORK/jdk-min@/jdk" \
  --preload-file "$OJ/tests/classes@/app/classes" $EXTRA \
  -sMAIN_MODULE=1 -sMODULARIZE=1 -sEXPORT_NAME=createJavaVM \
  -sENVIRONMENT=web,worker -sFORCE_FILESYSTEM=1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=536870912 -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=134217728 -sDEFAULT_PTHREAD_STACK_SIZE=16777216 \
  -sPTHREAD_POOL_SIZE=32 -sPROXY_TO_PTHREAD=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain 2>&1 | grep -vE "^(emcc|cache|system_libs):|warning: " || true
# The loader fetches startup dylibs (libjli.so) next to javavm.js, as the
# real bundle serves them; the VFS copies are what dlopen uses later.
cp "$WORK/jdk-min"/lib/*.so "$HERE/"
cp "$WORK/jdk-min"/lib/zero/libjvm.so "$HERE/"
cp "$SRC"/run.html "$HERE/"
ls -la "$HERE"/javavm.*
