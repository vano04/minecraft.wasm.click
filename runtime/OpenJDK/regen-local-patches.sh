#!/bin/sh
# Regenerate patches 0021 and 0022 from the working tree in work/jdk25.
#
# Both are deltas over the exact 0020 postimage, so a clean setup.sh applies
# 0001..0022 in order. The postimage is rebuilt from scratch here, from the
# pristine jdk-25-ga files plus 0001..0020, rather than trusted from anywhere.
#
#   0021  Host and interpreter fixes: the launcher's /proc/self/exe lookup
#         under NODERAWFS; the ldiv case 0011 dropped; acquire/release as wasm
#         atomics instead of a full fence each; the return barrier only where
#         final fields can have been written; record_dependency's handle scan
#         replaced by a hash set (linking lambdas was quadratic); the
#         Java clocks read emscripten_get_now/date_now directly instead of
#         through clock_gettime.
#   0022  JIT: entry slots instead of a JS crossing, recycled when they run
#         out; direct entry into compiled callees with a lean frame; per-site
#         inline caches with a megamorphic table and a getter fast path; typed
#         inlining; Math/Float/Double intrinsics; calls to plain virtual
#         methods; full subtype checks; modules that import their helpers as
#         functions rather than the function table; native calls through
#         per-signature wasm trampolines instead of libffi's JavaScript;
#         recompiling code that keeps bailing; every loop header an OSR entry;
#         a wider inliner (rewritten ops, 320 bytecodes, cold throw paths as
#         guards); a lean zwc_invoke for cached compiled targets; and
#         frameless bodies for pure methods, calls out and loops included;
#         linked invokedynamic/invokehandle sites; method-handle targets
#         through the direct entry; a profiled recompile that inlines
#         monomorphic virtual calls behind a class guard; field stores in
#         inlined callees with an undo log; volatile fields as wasm atomics;
#         retrying refusals that were only unresolved sites; frameless
#         bodies that store fields (undo-logged, entered only from framed
#         code; -XX:-ZeroWasmJITFramelessStores turns it off) and read an
#         identity hash from the header; call-site profiles that survive
#         recompiles and a profiled recompile for OSR-entered methods
#         (ZeroWasmJITCallFix); invokeinterface calls to Object's methods
#         dispatched through the vtable; identity hashCode through Object's
#         vtable slot read from the header; reads through a VarHandle over a
#         reference array (AtomicReferenceArray.get), volatile long
#         fields, lambda captures and enum switches as code
#         (ZeroWasmJITIndyFast); System.nanoTime and currentTimeMillis
#         as a call to zwc_clock; and the diagnostics (JIT module names,
#         refusal and hand-back logging).
set -eu
HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
W="$HERE/work/jdk25"
P="$HERE/patches"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

FILES21="src/java.base/unix/native/libjli/java_md.c
src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp
src/hotspot/os_cpu/linux_zero/atomic_linux_zero.hpp
src/hotspot/share/classfile/classLoaderData.cpp
src/hotspot/share/classfile/classLoaderData.hpp
src/hotspot/os/posix/os_posix.cpp"
FILES22="src/hotspot/cpu/zero/globals_zero.hpp
src/hotspot/cpu/zero/methodHandles_zero.cpp
src/hotspot/cpu/zero/zeroInterpreter_zero.cpp
src/hotspot/cpu/zero/interpreterFrame_zero.hpp
src/hotspot/share/interpreter/zero/zeroWasmCompiler.cpp
src/hotspot/share/interpreter/zero/zeroWasmCompiler.hpp"

cd "$W"
for f in $FILES21 $FILES22; do
  if git cat-file -e "HEAD:$f" 2>/dev/null; then
    mkdir -p "$T/$(dirname "$f")"
    git show "HEAD:$f" > "$T/$f"
  fi
done

cd "$T"
git init -q
git -c user.name=regen -c user.email=regen@localhost commit -q --allow-empty -m empty
git add -A
git -c user.name=regen -c user.email=regen@localhost commit -q -m base
INCLUDE=""
for f in $FILES21 $FILES22; do INCLUDE="$INCLUDE --include=$f"; done
for p in "$P"/00*.patch; do
  case "$p" in
    *0002-libffi*|*0021-*|*0022-*) continue ;;
  esac
  # shellcheck disable=SC2086
  git apply $INCLUDE "$p"
done
git add -A
git -c user.name=regen -c user.email=regen@localhost commit -q -m post-0020

for f in $FILES21; do cp "$W/$f" "$T/$f"; done
git add -A
git diff --cached > "$P/0021-zero-wasm-host-and-interpreter-fixes.patch"
git -c user.name=regen -c user.email=regen@localhost commit -q -m 0021

for f in $FILES22; do cp "$W/$f" "$T/$f"; done
git add -A
git diff --cached > "$P/0022-zero-wasm-jit-direct-entry-typed-inline.patch"

for n in 0021-zero-wasm-host-and-interpreter-fixes 0022-zero-wasm-jit-direct-entry-typed-inline; do
  printf '%s  %s\n' "$(wc -l < "$P/$n.patch" | tr -d ' ') lines" "$P/$n.patch"
done
