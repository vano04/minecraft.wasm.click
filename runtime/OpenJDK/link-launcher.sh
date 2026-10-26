#!/bin/sh
# Relink the `java` launcher as an Emscripten MAIN_MODULE.
#
# The JDK build produces the launcher as a plain executable, which cannot
# dlopen the side modules it needs (libjli/libjvm/libjava/...). This rebuilds
# it with dynamic linking, a Worker-hosted main thread, a large linear stack
# for the Zero interpreter, and the POSIX shims the JDK expects.
#
#   NODERAWFS=1  -> node-only: the emscripten FS is the real filesystem.
#   For the browser target this is replaced by a packaged/OPFS filesystem.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
WORK="$HERE/work"
JDK="$WORK/jdk25"
CONF=wasm-zero
BUILD="$JDK/build/$CONF"

# emsdk_env.sh locates itself with bash-only means, so under a POSIX sh
# (Linux's dash) it leaves EMSDK and PATH unset. Name the tree explicitly.
EMSDK="$WORK/emsdk"
export EMSDK
. "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
command -v emcc >/dev/null 2>&1 || PATH="$EMSDK/upstream/emscripten:$EMSDK:$PATH"

OUT=${1:-"$BUILD/jdk/bin/java-raw.js"}
COMPAT_O="$BUILD/emscripten_posix_compat.o"

# Compile the shims as C: em++ would mangle the names and the side modules
# import them unmangled.
LAZY_MMAP_O="$BUILD/mcweb_lazy_mmap.o"
emcc -c -O2 -fPIC -pthread \
  -I"$EMSDK/upstream/emscripten/system/lib/libc" \
  -I"$EMSDK/upstream/emscripten/system/lib/libc/musl/src/internal" \
  -I"$EMSDK/upstream/emscripten/system/lib/libc/musl/arch/emscripten" \
  '-Dhidden=__attribute__((visibility("hidden")))' \
  "$HERE/patches/emscripten-compat/lazy_mmap.c" -o "$LAZY_MMAP_O"

emcc -c -O2 -fPIC -pthread \
  "$HERE/patches/emscripten-compat/emscripten_posix_compat.c" -o "$COMPAT_O"

EMCC_FORCE_STDLIBS=1 em++ -pthread \
  -L"$BUILD/support/modules_libs/java.base" \
  -o "$OUT" \
  "$BUILD/support/native/java.base/java/main.o" \
  "$COMPAT_O" \
  "$LAZY_MMAP_O" \
  -ljli \
  "$WORK/prefix/lib/libffi.a" \
  --pre-js "$HERE/browser/pre.js" \
  --pre-js "$HERE/mcweb/jsbridge.c.shims.js" \
  -sMAIN_MODULE=1 \
  -Wl,--wrap=__syscall_mmap2 \
  -Wl,--wrap=__syscall_munmap \
  -Wl,--wrap=__syscall_msync \
  -sNODERAWFS=1 \
  -sENVIRONMENT=node,worker \
  -sEXIT_RUNTIME=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=536870912 \
  -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=134217728 \
  -sDEFAULT_PTHREAD_STACK_SIZE=16777216 \
  -sPTHREAD_POOL_SIZE=32 \
  -sPROXY_TO_PTHREAD=1 \
  "$@" 2>&1 | grep -vE "^(emcc|cache|system_libs):" || true

# MCWEB_STACK_MB=<n> gives node's pthread Workers an n MB engine stack
# (default: node's own 4). Chrome gives a Worker about 1 MB, so
# MCWEB_STACK_MB=1 reproduces under node the stack overflows a deep
# recursion hits there (docs/JIT-DESIGN.md, "The engine's stack").
sed 's|"workerData": "em-pthread",|"workerData": "em-pthread", resourceLimits: { stackSizeMb: Number(process.env.MCWEB_STACK_MB \|\| 4) },|' \
  "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
grep -q MCWEB_STACK_MB "$OUT" || echo "link-launcher: MCWEB_STACK_MB hook not applied (Emscripten changed?)" >&2

chmod +x "$OUT"
ls -la "$OUT" "${OUT%.js}.wasm"
