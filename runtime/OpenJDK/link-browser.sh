#!/bin/sh
# Link the wasm JVM for a browser tab.
#
# Differences from the node build: no NODERAWFS (the JDK image is packaged into
# the virtual filesystem instead), MODULARIZE so the page can start a fresh VM
# per run, and web/worker only. The VM still runs on a Worker via
# PROXY_TO_PTHREAD, because HotSpot blocks and the browser's main thread cannot.
#
# The JVM's Worker hosts MC-Web's browser seams (web/webgpu-host.js and
# friends, which tools/build-wasmjvm.mjs packages next to javavm.js), and
# patch-javavm.mjs adds one awaited gate to the loader's CMD_RUN branch so the
# host's WebGPU device is open before Java starts. See browser/pre.js.
#
# javavm.data holds the JDK image and the @JS bridge, nothing else: no test
# classes, and nothing compiled against Minecraft (build-wasmjvm.mjs checks).
# Test fixtures belong to OpenJDK/browser-harness/link.sh.
#
# MCWEB_LINK_OUT=javavm-debug writes browser/javavm-debug.{js,wasm,data}
# instead and leaves runtime-manifest.json alone (link-debug.sh does that).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
WORK="$HERE/work"
BUILD="$WORK/jdk25/build/wasm-zero"
IMAGE="$WORK/jdk-min"
OUT_BASE="${MCWEB_LINK_OUT:-javavm}"
case "$OUT_BASE" in
  javavm|javavm-debug) ;;
  *) echo "MCWEB_LINK_OUT must be javavm or javavm-debug" >&2; exit 1 ;;
esac
OUT_NAME="$OUT_BASE.js"
LINK_TMP=$(mktemp -d "$WORK/link-browser.XXXXXX")
trap 'rm -rf "$LINK_TMP"' EXIT HUP INT TERM
OUT="$LINK_TMP/$OUT_NAME"
LINK_LOG="$LINK_TMP/link.log"

# emsdk_env.sh locates itself with bash-only means, so under a POSIX sh
# (Linux's dash) it leaves EMSDK and PATH unset. Name the tree explicitly.
EMSDK="$WORK/emsdk"
export EMSDK
. "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
command -v emcc >/dev/null 2>&1 || PATH="$EMSDK/upstream/emscripten:$EMSDK:$PATH"

[ -d "$IMAGE" ] || { echo "run ./make-image.sh first" >&2; exit 1; }

COMPAT_O="$BUILD/emscripten_posix_compat.o"
LAZY_MMAP_O="$BUILD/mcweb_lazy_mmap.o"
emcc -c -O2 -fPIC -pthread \
  -I"$EMSDK/upstream/emscripten/system/lib/libc" \
  -I"$EMSDK/upstream/emscripten/system/lib/libc/musl/src/internal" \
  -I"$EMSDK/upstream/emscripten/system/lib/libc/musl/arch/emscripten" \
  '-Dhidden=__attribute__((visibility("hidden")))' \
  "$HERE/patches/emscripten-compat/lazy_mmap.c" -o "$LAZY_MMAP_O"

emcc -c -O2 -fPIC -pthread \
  "$HERE/patches/emscripten-compat/emscripten_posix_compat.c" -o "$COMPAT_O"

# MCWEB_LINK_EXTRA: extra link flags, e.g. --profiling-funcs so a browser
# profile names the main module's functions (prof/browser-profile.mjs).
# shellcheck disable=SC2086
if ! EMCC_FORCE_STDLIBS=1 em++ -pthread ${MCWEB_LINK_EXTRA:-} \
  -L"$BUILD/support/modules_libs/java.base" \
  -o "$OUT" \
  "$BUILD/support/native/java.base/java/main.o" \
  "$COMPAT_O" \
  "$LAZY_MMAP_O" \
  -ljli \
  "$WORK/prefix/lib/libffi.a" \
  --pre-js "$HERE/browser/pre.js" \
  --pre-js "$HERE/mcweb/jsbridge.c.shims.js" \
  --preload-file "$IMAGE@/jdk" \
  --preload-file "$HERE/mcweb/libmcwebjs.so@/app/bridge/libmcwebjs.so" \
  -sMAIN_MODULE=1 \
  -Wl,--wrap=__syscall_mmap2 \
  -Wl,--wrap=__syscall_munmap \
  -Wl,--wrap=__syscall_msync \
  -sMODULARIZE=1 -sEXPORT_NAME=createJavaVM \
  -sENVIRONMENT=web,worker \
  -sFORCE_FILESYSTEM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=536870912 \
  -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=16777216 \
  -sDEFAULT_PTHREAD_STACK_SIZE=16777216 \
  -sPTHREAD_POOL_SIZE=32 \
  -sPROXY_TO_PTHREAD=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain \
  "$@" >"$LINK_LOG" 2>&1; then
  grep -vE "^(emcc|cache|system_libs):" "$LINK_LOG" >&2 || true
  exit 1
fi
grep -vE "^(emcc|cache|system_libs):" "$LINK_LOG" || true

# Patch and verify the freshly generated loader before publishing any member of
# the js/wasm/data set. An old or partially patched browser loader is never an
# input to this flow.
MCWEB_JAVAVM_DIR="$LINK_TMP" MCWEB_JAVAVM_FILE="$OUT_NAME" \
  node "$HERE/patch-javavm.mjs"
for artifact in "$LINK_TMP/$OUT_BASE.data" "$LINK_TMP/$OUT_BASE.wasm" "$OUT"; do
  [ -f "$artifact" ] || { echo "missing fresh link output: $artifact" >&2; exit 1; }
done
mv "$LINK_TMP/$OUT_BASE.data" "$HERE/browser/$OUT_BASE.data"
mv "$LINK_TMP/$OUT_BASE.wasm" "$HERE/browser/$OUT_BASE.wasm"
mv "$OUT" "$HERE/browser/$OUT_NAME"

# The main module's own NEEDED libraries are instantiated before the packaged
# filesystem is mounted, so Emscripten fetches them over HTTP. They have to sit
# next to javavm.js as well as inside javavm.data.
rm -f "$HERE/browser/"*.so   # never leave a stale library to be packaged
cp "$IMAGE"/lib/*.so "$HERE/browser/"   # two copies: GNU cp refuses a duplicate
cp "$IMAGE"/lib/zero/*.so "$HERE/browser/"   # destination (libjsig.so) in one call

# Record what was baked in. pre.js, the bridge shims and libmcwebjs.so are
# *inputs* to this link: they are inlined into javavm.js or packaged into
# javavm.data, so editing one afterwards changes nothing until this script runs
# again. Emscripten reformats the inlined JS, so the bytes cannot be recovered
# from the output -- hence a manifest. tools/build-wasmjvm.mjs refuses to
# package a runtime whose inputs have moved on. A debug link is never
# packaged, so it records nothing.
if [ "$OUT_BASE" = javavm ]; then
runtime_sha() { shasum -a 256 "$1" | awk '{print $1}'; }
cat >"$HERE/browser/runtime-manifest.json" <<EOF
{
  "schema": 1,
  "linkedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "inputs": {
    "pre.js": "$(runtime_sha "$HERE/browser/pre.js")",
    "jsbridge.c.shims.js": "$(runtime_sha "$HERE/mcweb/jsbridge.c.shims.js")",
    "libmcwebjs.so": "$(runtime_sha "$HERE/mcweb/libmcwebjs.so")"
  }
}
EOF
fi

ls -la "$HERE/browser/$OUT_BASE".*
