#!/bin/sh
# Build the GLSL->WGSL translator the GPU worker loads (docs/SHADERS-PLAN.md):
# naga, pinned in Cargo.lock, behind a C ABI, for wasm32-unknown-unknown.
#   tools/naga-wasm/build.sh   ->   build/naga/nagamin.wasm
# Needs cargo with the wasm32-unknown-unknown target. A project-local rustup
# in build/toolchains/rust is used when present; to create one:
#   export RUSTUP_HOME=$PWD/build/toolchains/rust/rustup CARGO_HOME=$PWD/build/toolchains/rust/cargo
#   curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --target wasm32-unknown-unknown
# glsl-in alone fails to build in naga 30.0.1; wgsl-in is enabled only to work
# around that.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
TOOLS="$ROOT/build/toolchains/rust"
if [ -x "$TOOLS/cargo/bin/cargo" ]; then
  export RUSTUP_HOME="$TOOLS/rustup" CARGO_HOME="$TOOLS/cargo" PATH="$TOOLS/cargo/bin:$PATH"
fi
OUT="$ROOT/build/naga"
mkdir -p "$OUT"
cargo build --manifest-path "$HERE/Cargo.toml" --release --locked \
  --target wasm32-unknown-unknown --target-dir "$ROOT/build/naga/target"
cp "$ROOT/build/naga/target/wasm32-unknown-unknown/release/nagamin.wasm" "$OUT/nagamin.wasm"
ls -l "$OUT/nagamin.wasm"

# The crates compiled into the wasm, with their licences, for the bundle's
# THIRD-PARTY.json (tools/build-wasmjvm.mjs merges this file).
cargo metadata --manifest-path "$HERE/Cargo.toml" --locked --format-version 1 \
  --filter-platform wasm32-unknown-unknown \
  | node -e '
    let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
      const m = JSON.parse(s);
      const used = new Set(m.resolve.nodes.map((n) => n.id));
      const crates = m.packages.filter((p) => used.has(p.id) && p.name !== "nagamin")
        .map((p) => ({ crate: p.name, version: p.version, license: p.license, repository: p.repository }))
        .sort((a, b) => a.crate.localeCompare(b.crate));
      process.stdout.write(JSON.stringify({ artifact: "nagamin.wasm", crates }, null, 2) + "\n");
    });' > "$OUT/THIRD-PARTY.json"
echo "$(node -e 'console.log(require(process.argv[1]).crates.length)' "$OUT/THIRD-PARTY.json") crates -> $OUT/THIRD-PARTY.json"
