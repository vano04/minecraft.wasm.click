#!/bin/sh
# Run a Minecraft benchmark from tests/mc on the wasm JVM, against Mojang's
# own jar. Nothing of Mojang's is kept in the repository: the jar and its
# libraries are fetched from Mojang into build/mojang-cache on first use.
#
#   OpenJDK/prof/mc-bench.sh McWorldgenBench 8 8            # JIT
#   MCBENCH_JAVA=/opt/jdk25/bin/java OpenJDK/prof/mc-bench.sh McWorldgenBench 8 8
#   MCBENCH_JIT=0 OpenJDK/prof/mc-bench.sh McNoiseBench 4 8  # interpreter
#   MCBENCH_PROFILE=build/prof-wg OpenJDK/prof/mc-bench.sh McWorldgenBench 40 8
#
# Extra JVM flags go in MCBENCH_FLAGS (for example -XX:+ZeroWasmJITVerbose).
set -eu
HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd -P)
CACHE="$ROOT/build/mojang-cache"
OUT="$ROOT/build/mcbench"
# A host javac 25: $JAVAC, else the JDK OpenJDK/jdk-home.sh picks (in a
# subshell: it needs HERE to be OpenJDK/).
if [ -z "${JAVAC:-}" ]; then
  JAVAC=$(HERE="$ROOT/OpenJDK"; . "$ROOT/OpenJDK/jdk-home.sh"; echo "$BOOT_JDK/bin/javac")
fi
unset JAVA_TOOL_OPTIONS
# The Minecraft version the branch targets (tools/mc-version.mjs).
V=$(cd "$ROOT" && node -e 'import("./tools/mc-version.mjs").then(m => console.log(m.MC_VERSION))')

if [ ! -f "$CACHE/versions/$V/$V.json" ]; then
  (cd "$ROOT" && NODE_USE_ENV_PROXY=1 node tools/build-wasmjvm.mjs --download --dry-run \
      --cache-dir build/mojang-cache)
fi
CP=$(cd "$ROOT" && node -e '
  const j = require(process.argv[1]);
  const ok = l => !l.rules || l.rules.every(r => {
    const m = !r.os || r.os.name === "linux"; return r.action === "allow" ? m : !m; });
  const libs = j.libraries.filter(ok).filter(l => l.downloads && l.downloads.artifact
      && !/natives/.test(l.name)).map(l => process.argv[2] + "/libraries/" + l.downloads.artifact.path);
  console.log([process.argv[2] + "/versions/" + process.argv[3] + "/" + process.argv[3] + ".jar", ...libs].join(":"));
' "$CACHE/versions/$V/$V.json" "$CACHE" "$V")

mkdir -p "$OUT"
"$JAVAC" -nowarn -cp "$CP" -d "$OUT" "$ROOT"/OpenJDK/tests/mc/*.java 2>/dev/null

# MCBENCH_PORT=1: run against what the game lane actually loads - MC-Web's
# port jar (its LWJGL/Mojang shadows) ahead of the massaged client jar -
# with the JS bridge stubbed out (tests/mc/headless). McVertexBench needs
# this: vanilla LWJGL cannot load its natives on the wasm VM. Needs
# tools/build-wasmjvm.mjs to have built the port and the massaged jar.
if [ -n "${MCBENCH_PORT:-}" ]; then
  PORT_JAR="$ROOT/OpenJDK/mcweb/mcweb-port.jar"
  TJAR="$ROOT/build/massaged/minecraft-$V-massaged.jar"
  for f in "$PORT_JAR" "$TJAR"; do
    [ -f "$f" ] || { echo "mc-bench: MCBENCH_PORT needs $f (run tools/build-wasmjvm.mjs)" >&2; exit 1; }
  done
  "$JAVAC" -nowarn -d "$OUT-headless" $(find "$ROOT/OpenJDK/tests/mc/headless" -name '*.java')
  CP="$OUT-headless:$PORT_JAR:$(printf '%s' "$CP" | sed "s#[^:]*/versions/$V/$V.jar#$TJAR#")"
fi

# MCBENCH_PREPARE=1: fetch and compile only, and print the classpath (the
# browser harness's bench.sh packages the same files).
if [ -n "${MCBENCH_PREPARE:-}" ]; then echo "$CP:$OUT"; exit 0; fi

L=-Dlog4j2.loggerContextFactory=org.apache.logging.log4j.simple.SimpleLoggerContextFactory
if [ -n "${MCBENCH_JAVA:-}" ]; then
  # shellcheck disable=SC2086
  exec "$MCBENCH_JAVA" -Xmx1g $L ${MCBENCH_FLAGS:-} -cp "$CP:$OUT" "$@"
fi
J="-XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT"
[ "${MCBENCH_JIT:-1}" = 0 ] && J=""
RUN="$ROOT/OpenJDK/run-java.sh"
# MCBENCH_PROFILE=<dir>: the same run under prof/profile.sh.
[ -n "${MCBENCH_PROFILE:-}" ] && RUN="$HERE/profile.sh $MCBENCH_PROFILE"
# shellcheck disable=SC2086
exec $RUN -Xmx1g -XX:+UseSerialGC $L $J ${MCBENCH_FLAGS:-} -cp "$CP:$OUT" "$@"
