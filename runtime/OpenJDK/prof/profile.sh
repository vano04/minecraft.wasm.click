#!/bin/sh
# CPU-profile one wasm JVM run with function names for libjvm.
#
#   OpenJDK/prof/profile.sh <outdir> <java args...>
#   node OpenJDK/prof/proftail.mjs <outdir> 8      # self time, last 8 s
#   node OpenJDK/prof/profstack.mjs <outdir> 8 '^zwc_invoke$' 6
#
# libjvm is relinked with --profiling-funcs from the current objects (same
# code, plus a name section) into build/libjvm-named.so and used for this run
# (run-java.sh's MCWEB_LIBJVM). Do not start another run on this JDK
# meanwhile: both share the bin directory's libjvm.so symlink.
set -eu
HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
OJ=$(CDPATH= cd -- "$HERE/.." && pwd -P)
ROOT=$(CDPATH= cd -- "$OJ/.." && pwd -P)
B="$OJ/work/jdk25/build/wasm-zero"
BIN="$B/jdk/bin"
NAMED="$ROOT/build/libjvm-named.so"
out=$1; shift
export EMSDK="$OJ/work/emsdk"
command -v emcc >/dev/null 2>&1 || PATH="$EMSDK/upstream/emscripten:$EMSDK:$PATH"
if [ ! -f "$NAMED" ] || [ "$B/jdk/lib/zero/libjvm.so" -nt "$NAMED" ]; then
  mkdir -p "$(dirname "$NAMED")"
  CMD=$(sed "s# -o [^ ]*libjvm.so # -o $NAMED --profiling-funcs #" \
        "$B/hotspot/variant-zero/libjvm/objs/BUILD_LIBJVM_run_ld.cmdline")
  (cd "$B/hotspot/variant-zero/libjvm/objs" && eval "$CMD") 2>&1 | grep -v warning | tail -3 || true
fi
rm -rf "$out"; mkdir -p "$out"
out=$(CDPATH= cd -- "$out" && pwd -P)
unset JAVA_TOOL_OPTIONS
trap 'ln -sf "$BIN/../lib/zero/libjvm.so" "$BIN/libjvm.so"' EXIT
# One profile per thread: node applies NODE_OPTIONS to every worker.
MCWEB_LIBJVM="$NAMED" NODE_OPTIONS="--cpu-prof --cpu-prof-dir=$out" \
  "$OJ/run-java.sh" "$@" 2>&1 | grep -v "unsupported syscall" || true
