#!/bin/sh
# Build the browser-native policy/OSHI seam without touching the player JAR or
# MC-Web's full port payload.  The only non-JDK compile dependency is the pinned
# OSS oshi-core API needed by the classpath-first oshi.SystemInfo shadow.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
. "$HERE/jdk-home.sh"
JDK_HOME=$BOOT_JDK
JAVAC="$JDK_HOME/bin/javac"
JAR="$JDK_HOME/bin/jar"
# Overridable for a staged library set; the pinned SHA-256 below is the real
# gate, so pointing this elsewhere cannot change which bytes are accepted.
OSHI=${MCWEB_OSHI_JAR:-"$ROOT/build/mojang-cache/libraries/com/github/oshi/oshi-core/6.9.0/oshi-core-6.9.0.jar"}
OSHI_SHA256="b29ba9bce041e6ea822203d5b5a692660c87551241510ebc76eedffe684844c7"
OUT_DIR="$HERE/native-policy/dist"
POINTER="$HERE/native-policy/current.json"
CLASSPATH_POINTER="$HERE/native-policy/classpath.txt"

[ -x "$JAVAC" ] || { echo "missing JDK 25 javac: $JAVAC" >&2; exit 1; }
[ -x "$JAR" ] || { echo "missing JDK 25 jar: $JAR" >&2; exit 1; }
[ -f "$OSHI" ] || { echo "missing OSS oshi-core 6.9.0 jar: $OSHI" >&2; exit 1; }
ACTUAL_OSHI_SHA256=$(shasum -a 256 "$OSHI" | awk '{print $1}')
[ "$ACTUAL_OSHI_SHA256" = "$OSHI_SHA256" ] || {
  echo "oshi-core 6.9.0 SHA-256 mismatch: $ACTUAL_OSHI_SHA256" >&2
  exit 1
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/mcweb-native-policy.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
CLASSES="$TMP/classes"
STAGE="$TMP/stage"
mkdir -p "$CLASSES" "$STAGE/META-INF" "$OUT_DIR"

# Deliberately enumerate every source.  Do not add the transformed Minecraft
# JAR, src/graal/resources, the full port output, or shim classes here.
"$JAVAC" --release 25 -g:none -nowarn -proc:none \
  -classpath "$OSHI" \
  -d "$CLASSES" \
  "$ROOT/src/graal/java/dev/mcweb/graal/BrowserNativePolicy.java" \
  "$ROOT/src/graal/java/oshi/SystemInfo.java" \
  "$HERE/mcweb/boot-src/dev/mcweb/wasm/Boot.java"

cp "$HERE/native-policy/MANIFEST.MF" "$STAGE/META-INF/MANIFEST.MF"
RAW="$TMP/mcweb-native-policy.jar"
"$JAR" --create --file "$RAW" --date=2000-01-01T00:00:00Z --no-manifest \
  -C "$STAGE" META-INF/MANIFEST.MF \
  -C "$CLASSES" dev/mcweb/graal/BrowserNativePolicy.class \
  -C "$CLASSES" dev/mcweb/wasm/Boot.class \
  -C "$CLASSES" oshi/SystemInfo.class

ENTRIES=$("$JAR" --list --file "$RAW")
EXPECTED='META-INF/MANIFEST.MF
dev/mcweb/graal/BrowserNativePolicy.class
dev/mcweb/wasm/Boot.class
oshi/SystemInfo.class'
[ "$ENTRIES" = "$EXPECTED" ] || {
  echo "native-policy jar entry allowlist mismatch" >&2
  printf '%s\n' "$ENTRIES" >&2
  exit 1
}
case "$ENTRIES" in
  *net/minecraft/*|*assets/*)
    echo "native-policy jar contains forbidden Minecraft/assets content" >&2
    exit 1
    ;;
esac

SHA256=$(shasum -a 256 "$RAW" | awk '{print $1}')
BYTES=$(wc -c < "$RAW" | tr -d ' ')
NAME="mcweb-native-policy-$SHA256.jar"
ARTIFACT="$OUT_DIR/$NAME"
mv "$RAW" "$ARTIFACT"

# Publish both pointers last so readers never observe a name before its
# content-addressed artifact is complete.
POINTER_TMP="$TMP/current.json"
printf '{"schema":1,"name":"%s","sha256":"%s","bytes":%s}\n' \
  "$NAME" "$SHA256" "$BYTES" > "$POINTER_TMP"
mv "$POINTER_TMP" "$POINTER"
CLASSPATH_TMP="$TMP/classpath.txt"
printf '%s\n' "$ARTIFACT" > "$CLASSPATH_TMP"
mv "$CLASSPATH_TMP" "$CLASSPATH_POINTER"

printf 'native-policy support jar: %s\n' "$ARTIFACT"
printf 'sha256=%s bytes=%s\n' "$SHA256" "$BYTES"
printf '%s\n' "$ENTRIES"
