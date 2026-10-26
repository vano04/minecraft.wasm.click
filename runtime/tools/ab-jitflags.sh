#!/bin/zsh
# Fixed-seed A/B of the wasmjvm lane under different ?jitflags= values: 60 s in
# a world, then inventory and block-break interactions (compare-lanes
# --interact), with the JIT's slow installs counted (stdoutconsole=1).
#
#   tools/ab-jitflags.sh "-XX:ZeroWasmJITUnitSize=0" "-XX:ZeroWasmJITUnitSize=16"
# Several flags in one variant: comma-separated, `+` written %2B.
cd "$(dirname "$0")/.."
for v in "$@"; do
  tag=$(echo "$v" | tr -c 'A-Za-z0-9=' '_')
  timeout 1200 node tools/compare-lanes.mjs wasmjvm --measure 60 --interact 4 \
    --query "noblur=1&stdoutconsole=1&jitflags=$v" --out build/compare/ab-$tag > build/compare/ab-$tag.log 2>&1
  echo "== $v"
  grep -E "inWorld:|world hitches|interaction hitches|ERROR" build/compare/ab-$tag.log
  node -e 'const r=require(process.argv[1]); console.log("fps", r.samples?.map(s=>s.fps).join(" "), "steady", r.steadyFps)' "$PWD/build/compare/ab-$tag/result.json"
done
