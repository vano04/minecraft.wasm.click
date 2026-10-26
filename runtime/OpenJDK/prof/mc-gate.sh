#!/bin/sh
# The JIT's correctness gate on Minecraft's own code: every benchmark in
# tests/mc run on native HotSpot and on the wasm JVM with the JIT, and every
# checksum must match. run-jit-tests.sh proves the JIT on small differentials;
# this proves it on the code the game spends its time in.
#
#   OpenJDK/prof/mc-gate.sh
#
# McWorldgenBench: the overworld noise router (vanilla jar).
# McChunkBench:    biomes, noise fill and surface on real ProtoChunks (vanilla
#                  jar): the server's serial worldgen steps.
# McVertexBench:   BufferBuilder writing BLOCK and ENTITY vertices through
#                  the port's MemoryUtil (MCBENCH_PORT=1; needs a built port).
# McImageBench:    NativeImage decoding the jar's HUD sprites, read back per
#                  pixel and as the bulk copy texture uploads use.
# Mojang's files are fetched into build/mojang-cache by mc-bench.sh on first
# use. Host java: $MCGATE_JAVA, else the JDK OpenJDK/jdk-home.sh picks.
set -eu
HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd -P)
JAVA=${MCGATE_JAVA:-}
if [ -z "$JAVA" ]; then
  JAVA=$(HERE="$ROOT/OpenJDK"; . "$ROOT/OpenJDK/jdk-home.sh"; echo "$BOOT_JDK/bin/java")
fi
# The Minecraft version the branch targets (tools/mc-version.mjs).
V=$(cd "$ROOT" && node -e 'import("./tools/mc-version.mjs").then(m => console.log(m.MC_VERSION))')
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail=0

gate() {  # name, pattern, env, class, args...
  name=$1; pat=$2; envs=$3; shift 3
  # Timings differ; everything else on a result line must not.
  env $envs MCBENCH_JAVA="$JAVA" "$HERE/mc-bench.sh" "$@" 2>&1 | grep -a "$pat" \
      | sed 's/ms=[0-9.]* //; s/us\/point=[0-9.]* //' > "$TMP/$name.native"
  env $envs "$HERE/mc-bench.sh" "$@" 2>&1 | grep -a "$pat" \
      | sed 's/ms=[0-9.]* //; s/us\/point=[0-9.]* //' > "$TMP/$name.jit"
  if [ -s "$TMP/$name.native" ] && cmp -s "$TMP/$name.native" "$TMP/$name.jit"; then
    echo "ok   $name ($(wc -l < "$TMP/$name.native" | tr -d ' ') lines identical to HotSpot)"
  else
    echo "FAIL $name"; diff "$TMP/$name.native" "$TMP/$name.jit" | head -8; fail=1
  fi
}

gate worldgen 'BENCH round' '' McWorldgenBench 6 4
gate chunks 'CHUNKS round' '' McChunkBench 3 3
gate vertex 'VERTEX' 'MCBENCH_PORT=1' McVertexBench 8 1024
gate image 'IMAGES round' 'MCBENCH_PORT=1' McImageBench "$ROOT/build/massaged/minecraft-$V-massaged.jar" 6
exit $fail
