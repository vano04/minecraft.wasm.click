#!/usr/bin/env bash
set -eu
HERE=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
EMSDK="$HERE/work/emsdk"
export EMSDK
. "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
TEST_DIR=$(mktemp -d "$HERE/work/lazy-mmap-check.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
"$EMSDK/upstream/emscripten/emcc" -c -O2 -fPIC -pthread \
  -I"$EMSDK/upstream/emscripten/system/lib/libc" \
  -I"$EMSDK/upstream/emscripten/system/lib/libc/musl/src/internal" \
  -I"$EMSDK/upstream/emscripten/system/lib/libc/musl/arch/emscripten" \
  '-Dhidden=__attribute__((visibility("hidden")))' \
  "$HERE/patches/emscripten-compat/lazy_mmap.c" -o "$TEST_DIR/mmap.o"
"$EMSDK/upstream/emscripten/emcc" -O2 -pthread "$HERE/tests/LazyMmapCheck.c" "$TEST_DIR/mmap.o" \
  -Wl,--wrap=__syscall_mmap2 -Wl,--wrap=__syscall_munmap -Wl,--wrap=__syscall_msync \
  -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 -o "$TEST_DIR/check.js"
node "$TEST_DIR/check.js"
