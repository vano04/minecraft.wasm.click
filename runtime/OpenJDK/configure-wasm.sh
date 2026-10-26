#!/bin/sh
# M1 probe: configure OpenJDK 25 / HotSpot Zero for wasm32-unknown-emscripten.
# Isolated lane — touches nothing in the MC-Web runtime.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
WORK="$HERE/work"
# emsdk_env.sh finds its own directory through bash-only means; under a POSIX
# sh (Linux's dash) it silently leaves EMSDK unset. Say where it is.
EMSDK="$WORK/emsdk"
export EMSDK
. "$WORK/emsdk/emsdk_env.sh" >/dev/null 2>&1
# Without a copyright year, COPYRIGHT_YEAR is empty on some hosts and
# CLDRConverter dies on its -year argument; the caller's "$@" still wins.
# The JDK build refuses to run under JAVA_TOOL_OPTIONS (proxied CI sets it).
unset JAVA_TOOL_OPTIONS

. "$HERE/jdk-home.sh"
BUILD_DIR="$WORK/build-wasm"

cd "$WORK/jdk25"
mkdir -p "$BUILD_DIR"

exec bash configure \
  --with-conf-name=wasm-zero \
  --with-toolchain-type=clang \
  --openjdk-target=wasm32-unknown-emscripten \
  --with-jvm-variants=zero \
  --with-copyright-year="${COPYRIGHT_YEAR:-$(date +%Y)}" \
  --with-boot-jdk="$BOOT_JDK" \
  --with-build-jdk="$BOOT_JDK" \
  --with-debug-level=release \
  --with-native-debug-symbols=none \
  --enable-headless-only \
  --disable-warnings-as-errors \
  --disable-precompiled-headers \
  --disable-dtrace \
  --with-freetype=bundled \
  --with-extra-cflags="-I$HERE/patches/emscripten-compat -pthread -D__linux__=1" \
  --with-extra-cxxflags="-I$HERE/patches/emscripten-compat -pthread" \
  --with-extra-ldflags="-pthread" \
  --with-libffi-include="$WORK/prefix/include" \
  --with-libffi-lib="$WORK/prefix/lib" \
  --with-jvm-features=-jvmti,-jfr,-management,-services,-cds,-compiler1,-compiler2,-jni-check,-vm-structs \
  BUILD_CC="${BUILD_CC:-clang}" \
  BUILD_CXX="${BUILD_CXX:-clang++}" \
  CC="$EMSDK/upstream/emscripten/emcc" \
  CXX="$EMSDK/upstream/emscripten/em++" \
  LD="$EMSDK/upstream/emscripten/em++" \
  AR="$EMSDK/upstream/emscripten/emar" \
  RANLIB="$EMSDK/upstream/emscripten/emranlib" \
  "$@"
