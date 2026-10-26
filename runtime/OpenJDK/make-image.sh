#!/bin/sh
# Assemble the smallest runtime image the wasm JVM needs, at work/jdk-min.
#
# The exploded build image is 199 MB and includes modules this target cannot
# use. jlink cannot produce a wasm image (the host's jlink rejects the
# "linux-wasm32" platform string), so the set is assembled by hand.
#
# Libraries are placed in BOTH lib/ and bin/: libjli checks $home/lib/libjava.so
# to locate the JDK, while Emscripten's loader resolves a side module's
# dependencies by basename against the current directory.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/work/jdk25/build/wasm-zero/jdk"
OUT="$HERE/work/jdk-min"
# jdk.zipfs: Minecraft opens its own jars through the jar file system provider
# (version detection, pack metadata). The trimmed image must carry it.
MODULES=${MODULES:-"java.base jdk.zipfs java.logging java.management"}

rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib/zero" "$OUT/modules"

for m in $MODULES; do
  [ -d "$SRC/modules/$m" ] || { echo "no such module: $m" >&2; exit 1; }
  cp -R "$SRC/modules/$m" "$OUT/modules/"
done
# Build-only bookkeeping, not part of the runtime.
find "$OUT/modules" -name '_the.*' -delete

cp "$SRC"/lib/*.so       "$OUT/lib/"
cp "$SRC"/lib/zero/*.so  "$OUT/lib/zero/"
# MCWEB_IMAGE_LIBJVM=<path>: package another build of libjvm.so, such as the
# --profiling-funcs copy prof/browser-profile.mjs needs for named wasm frames.
[ -n "${MCWEB_IMAGE_LIBJVM:-}" ] && cp "$MCWEB_IMAGE_LIBJVM" "$OUT/lib/zero/libjvm.so"
cp "$SRC"/lib/jvm.cfg "$SRC"/lib/tzdb.dat "$OUT/lib/"
cp -RL "$SRC/lib/security" "$OUT/lib/"   # -L: the build leaves symlinks into conf/
cp -RL "$SRC/conf" "$OUT/"          # java.security and friends are read at startup
cp "$SRC/release" "$OUT/" 2>/dev/null || true

# Optimise the wasm before it is packaged. The JDK build links its shared
# objects with no -O flag at all, so emcc never runs Binaryen over them: the
# .o files are -O3 from clang but the module itself is unoptimised. Running
# wasm-opt here is worth ~5% on interpreter throughput (216ms -> 200ms on the
# Bench int loop) and 19% off libjvm.so's size, and it needs no reconfigure.
# OFF by default, and it must stay that way until someone finds the miscompile.
#
# It is worth ~5% on interpreter throughput and 19% off libjvm.so, and it is
# correct on every isolated probe -- Bench, MathCheck, and an 8-thread
# rendezvous stress all pass with it on. But Minecraft's world creation then
# hangs in managedBlock with the worldgen dispatchers asleep and no RPC in
# flight, and the identical build with this step skipped completes the same
# run. So: MCWEB_WASM_OPT=1 to opt in, knowing that.
WASM_OPT="$HERE/work/emsdk/upstream/bin/wasm-opt"
if [ -x "$WASM_OPT" ] && [ -n "${MCWEB_WASM_OPT:-}" ]; then
  for so in "$OUT"/lib/*.so "$OUT"/lib/zero/*.so; do
    # -all, not a hand-picked feature list: the JDK's libraries between them
    # use enough of the proposal surface that any explicit list leaves some
    # library failing validation and silently unoptimised.
    "$WASM_OPT" -O3 -all "$so" -o "$so.opt" \
      && mv "$so.opt" "$so" || rm -f "$so.opt"
  done
else
  echo "wasm-opt off (MCWEB_WASM_OPT=1 to opt in); shipping unoptimised libraries" >&2
fi

# Two copies, not one: libjsig.so is in both, and GNU cp refuses to write the
# same destination twice in a single call.
cp "$OUT"/lib/*.so "$OUT/bin/"
cp "$OUT"/lib/zero/*.so "$OUT/bin/"


du -sh "$OUT"
