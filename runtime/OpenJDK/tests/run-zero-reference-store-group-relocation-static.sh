#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
JAVAC=${JAVAC:-/opt/homebrew/opt/openjdk@25/bin/javac}
JAVA=${JAVA:-/opt/homebrew/opt/openjdk@25/bin/java}
NODE=${NODE:-node}
WORK=$(mktemp -d /private/tmp/mcweb-zero-reference-store-group-relocation-static.XXXXXX)
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

FIXTURE="$ROOT/OpenJDK/tests/ZeroReferenceStoreGroupRelocationFixture.java"
NEAR="$ROOT/OpenJDK/tests/ZeroReferenceStoreGroupRelocationNearMiss.java"
PROBE="$ROOT/OpenJDK/tests/ZeroReferenceStoreGroupRelocationProbe.java"
CLASS_CHECKER="$ROOT/OpenJDK/tests/check-zero-reference-store-group-relocation-class.mjs"
SOURCE_CHECKER="$ROOT/OpenJDK/tests/check-zero-reference-store-group-relocation-source.mjs"
WAT_CHECKER="$ROOT/OpenJDK/tests/check-zero-reference-store-group-relocation-wat.mjs"
LOG_CHECKER="$ROOT/OpenJDK/tests/check-zero-reference-store-group-relocation-log.mjs"
MANIFEST_CHECKER="$ROOT/OpenJDK/tests/check-zero-reference-store-group-relocation-manifest.mjs"
MANIFEST="$ROOT/OpenJDK/tests/zero-reference-store-group-relocation-c3b-manifest.sha256"

reject() {
  echo "REJECT c3b-stage1-static reason=$1" >&2
  exit 1
}

[ -x "$JAVAC" ] || reject javac
[ -x "$JAVA" ] || reject java
command -v "$NODE" >/dev/null 2>&1 || reject node

# The exact source closure is part of the contract. CARD/C3a helpers are not
# dependencies of this isolated Stage-1 JVM fixture.
set -- "$FIXTURE" "$NEAR" "$PROBE"
[ "$#" -eq 3 ] || reject java-source-count
for source in "$@"; do [ -f "$source" ] || reject java-source-missing; done
"$JAVAC" -g:none -d "$WORK/classes" "$@" >"$WORK/javac.log" 2>&1 \
  || reject javac

"$NODE" "$CLASS_CHECKER" \
  "$WORK/classes/ZeroReferenceStoreGroupRelocationFixture.class" \
  >"$WORK/class.log" 2>&1 || reject class-fixture
"$NODE" "$CLASS_CHECKER" --self-test \
  "$WORK/classes/ZeroReferenceStoreGroupRelocationFixture.class" \
  >"$WORK/class-self.log" 2>&1 || reject class-self-test
if "$NODE" "$CLASS_CHECKER" \
    "$WORK/classes/ZeroReferenceStoreGroupRelocationNearMiss.class" \
    >"$WORK/near.log" 2>&1; then
  reject near-miss-accepted
fi

# Well-formed compiler attributes are also rejected, rather than proving only
# malformed/truncated attribute handling.
mkdir -p "$WORK/parameters" "$WORK/source-attribute" "$WORK/omission"
"$JAVAC" -parameters -g:none -d "$WORK/parameters" "$@" \
  >"$WORK/javac-parameters.log" 2>&1 || reject javac-parameters
if "$NODE" "$CLASS_CHECKER" \
    "$WORK/parameters/ZeroReferenceStoreGroupRelocationFixture.class" \
    >"$WORK/parameters.log" 2>&1; then
  reject method-attribute-accepted
fi
"$JAVAC" -g:source -d "$WORK/source-attribute" "$@" \
  >"$WORK/javac-source-attribute.log" 2>&1 || reject javac-source-attribute
if "$NODE" "$CLASS_CHECKER" \
    "$WORK/source-attribute/ZeroReferenceStoreGroupRelocationFixture.class" \
    >"$WORK/source-attribute.log" 2>&1; then
  reject class-attribute-accepted
fi
if "$JAVAC" -g:none -d "$WORK/omission" "$FIXTURE" "$NEAR" \
    >"$WORK/source-omission.log" 2>&1; then
  reject probe-source-omission-accepted
fi

# Compiler-produced structural variants. Each is a well-formed class file that
# javac itself emits, so the rejection proves the pinned structure rather than
# only proving that hand-mutated bytes are malformed.
variant() {
  name=$1
  match=$2
  replacement=$3
  mkdir -p "$WORK/variant-$name"
  sed "s|$match|$replacement|" "$FIXTURE" \
    >"$WORK/variant-$name/ZeroReferenceStoreGroupRelocationFixture.java"
  "$JAVAC" -g:none -d "$WORK/variant-$name/classes" \
    "$WORK/variant-$name/ZeroReferenceStoreGroupRelocationFixture.java" \
    "$NEAR" "$PROBE" >"$WORK/variant-$name/javac.log" 2>&1 \
    || reject "variant-javac-$name"
  if "$NODE" "$CLASS_CHECKER" \
      "$WORK/variant-$name/classes/ZeroReferenceStoreGroupRelocationFixture.class" \
      >"$WORK/variant-$name/check.log" 2>&1; then
    reject "variant-accepted-$name"
  fi
}
CLASS_LINE='public final class ZeroReferenceStoreGroupRelocationFixture {'
variant field "$CLASS_LINE" \
  "$CLASS_LINE\\n    private static Object leaked;"
variant clinit "$CLASS_LINE" \
  "$CLASS_LINE\\n    static { java.util.Objects.requireNonNull(\"c3b\"); }"
variant extra-method "$CLASS_LINE" \
  "$CLASS_LINE\\n    private static void extra() { }"
variant superclass "$CLASS_LINE" \
  'public final class ZeroReferenceStoreGroupRelocationFixture extends java.util.concurrent.atomic.AtomicInteger {'
variant exception-operand 'throw new IllegalStateException();' \
  'throw new IllegalArgumentException();'

# Retarget the exact probe Methodref name without changing class-file length.
cp "$WORK/classes/ZeroReferenceStoreGroupRelocationFixture.class" \
  "$WORK/probe-mutated.class"
"$NODE" -e '
  const fs = require("fs");
  const p = process.argv[1];
  const b = fs.readFileSync(p);
  const from = Buffer.from("forceYoungRelocation");
  const at = b.indexOf(from);
  if (at < 0 || b.indexOf(from, at + 1) >= 0) process.exit(2);
  b[at + from.length - 1] ^= 1;
  fs.writeFileSync(p, b);
' "$WORK/probe-mutated.class" || reject class-negative-setup
if "$NODE" "$CLASS_CHECKER" "$WORK/probe-mutated.class" \
    >"$WORK/probe-mutated.log" 2>&1; then
  reject altered-probe-accepted
fi

"$JAVA" -cp "$WORK/classes" ZeroReferenceStoreGroupRelocationProbe stage1 \
  >"$WORK/jvm.log" 2>&1 || reject jvm
"$NODE" "$LOG_CHECKER" "$WORK/jvm.log" >"$WORK/log-check.log" 2>&1 \
  || reject log

for checker in "$CLASS_CHECKER" "$SOURCE_CHECKER" "$WAT_CHECKER" \
    "$LOG_CHECKER" "$MANIFEST_CHECKER"; do
  "$NODE" --check "$checker" >/dev/null 2>&1 || reject node-syntax
done
"$NODE" "$SOURCE_CHECKER" --self-test >"$WORK/source.log" 2>&1 \
  || reject source-self-test
"$NODE" "$WAT_CHECKER" --self-test >"$WORK/wat.log" 2>&1 \
  || reject wat-self-test
"$NODE" "$LOG_CHECKER" --self-test >"$WORK/log-self.log" 2>&1 \
  || reject log-self-test
"$NODE" "$MANIFEST_CHECKER" "$MANIFEST" >"$WORK/manifest.log" 2>&1 \
  || reject manifest
"$NODE" "$MANIFEST_CHECKER" --self-test "$MANIFEST" \
  >"$WORK/manifest-self.log" 2>&1 || reject manifest-self-test

cat "$WORK/class.log" "$WORK/class-self.log" "$WORK/jvm.log" "$WORK/log-check.log" \
  "$WORK/source.log" "$WORK/wat.log" "$WORK/log-self.log" \
  "$WORK/manifest.log" "$WORK/manifest-self.log"
echo "C3B_STAGE1_STATIC_PASS fixture=exact root-map=exact module=synthetic-oracle cache=isolated variants=5"
echo "WIP c3b-stage1 acceptance=NOT_EXECUTED continuation=UNARMED gc=NOT_EXECUTED runtime=NOT_REBUILT module=NOT_DUMPED"
