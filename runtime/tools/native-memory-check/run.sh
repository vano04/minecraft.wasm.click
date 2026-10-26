#!/usr/bin/env bash
# Semantics check for org.lwjgl.system.BrowserNativeMemory, on the host JVM.
#
# That class is the port's synthetic native address space, and its lookup was
# rewritten from "scan every live block" to an ordered floorEntry after the scan
# turned Minecraft's asset reload quadratic (set/copy resolved once per *byte*,
# and a copy between two blocks missed the one-entry cache on every one). The
# rewrite has to preserve some behaviour that is easy to get wrong and invisible
# until the browser stalls: interior addresses resolving into the containing
# block, cross-block and overlapping copies, freeing and reallocating at an
# interior address, and lazily scratch-mapping an unmapped probe.
#
# Two tiny stubs stand in for the classes the allocation reporter touches; the
# check itself uses only small allocations, which never reach that path.
#
# Usage: tools/native-memory-check/run.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$repo_root/tools/native-memory-check"
: "${GRAALVM_HOME:?set GRAALVM_HOME to the Oracle GraalVM used for the image build}"

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

"$GRAALVM_HOME/bin/javac" -nowarn -d "$out" \
    "$repo_root/src/graal/java/org/lwjgl/system/BrowserNativeMemory.java" \
    "$here/NativeMemoryCheck.java" \
    "$here/stub/dev/mcweb/graal/MinecraftInitProgress.java" \
    "$here/stub/dev/mcweb/graal/webgpu/BrowserGpu.java"

"$GRAALVM_HOME/bin/java" -cp "$out" NativeMemoryCheck
