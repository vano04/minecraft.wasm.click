#!/bin/bash
# One-frame flicker in a directory of consecutive frames (all0000.png ...,
# from tools/capture-break.mjs): a frame that differs from both neighbours
# while the neighbours match each other. Prints the worst few as
#   frame  score  d(prev,this)  d(this,next)  d(prev,next)
# score = min(d(prev,this), d(this,next)) - d(prev,next), RMSE over the game
# area (CROP=WxH+X+Y, default the left half: the arm swings in from the
# right and would score as flicker), downscaled. Higher = more flicker-like.
dir=${1:?dir}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
n=0
for f in "$dir"/all*.png; do
  convert "$f" -crop ${CROP:-600x500+20+140} -resize 50% "$tmp/$(printf %04d $n).png"; n=$((n+1))
done
d() { compare -metric RMSE "$tmp/$1.png" "$tmp/$2.png" null: 2>&1 | sed 's/.*(\(.*\)).*/\1/'; }
for ((i=1; i<n-1; i++)); do
  p=$(printf %04d $((i-1))); c=$(printf %04d $i); x=$(printf %04d $((i+1)))
  a=$(d $p $c); b=$(d $c $x); e=$(d $p $x)
  awk -v i=$i -v a=$a -v b=$b -v e=$e 'BEGIN{m=a<b?a:b; printf "%d %.4f %.4f %.4f %.4f\n", i, m-e, a, b, e}'
done | sort -k2 -gr | head -${2:-6}
