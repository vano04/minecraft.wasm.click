#!/bin/sh
# Run the wasm JVM under node.
#
# The cwd must be the bin directory: Emscripten resolves a side module's
# dependencies by basename against the current directory, and every JDK library
# is symlinked there for that reason. Because of that cd, relative classpath
# entries given on the command line are made absolute first.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
BIN="$HERE/work/jdk25/build/wasm-zero/jdk/bin"
CWD=$(pwd)

for f in "$BIN"/../lib/*.so; do ln -sf "$f" "$BIN/"; done
# MCWEB_LIBJVM swaps in another build of libjvm.so for this run, such as the
# named copy prof/profile.sh links. The next run without it puts the real one back.
ln -sf "${MCWEB_LIBJVM:-$BIN/../lib/zero/libjvm.so}" "$BIN/libjvm.so"

abspath() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *)  if [ -e "$CWD/$1" ]; then printf '%s' "$CWD/$1"; else printf '%s' "$1"; fi ;;
  esac
}

set -- "$@"
ARGS=""
EXPECT_CP=0
for a in "$@"; do
  if [ "$EXPECT_CP" = 1 ]; then
    OUT=""
    OLDIFS=$IFS; IFS=:
    for e in $a; do OUT="${OUT:+$OUT:}$(abspath "$e")"; done
    IFS=$OLDIFS
    a=$OUT
    EXPECT_CP=0
  elif [ "$a" = "-cp" ] || [ "$a" = "-classpath" ] || [ "$a" = "--class-path" ]; then
    EXPECT_CP=1
  elif [ "$a" = "-jar" ]; then
    EXPECT_CP=1
  fi
  ARGS="$ARGS
$a"
done

cd "$BIN"
# Re-split on newlines so arguments containing spaces survive.
OLDIFS=$IFS; IFS='
'
# shellcheck disable=SC2086
set -- $ARGS
IFS=$OLDIFS
# The node that runs it: $MCWEB_NODE, else the emsdk's own (Node 24), else the
# one on PATH. Node 24's V8 lets a module import the function table for free,
# as Chromium does; Node 22's copies it per instance, so the JIT leaves out
# what needs it there (see zwc_probe_table_import) and runs slower than the
# browser does.
NODE=${MCWEB_NODE:-}
if [ -z "$NODE" ]; then
  for n in "$HERE"/work/emsdk/node/*/bin/node; do [ -x "$n" ] && NODE=$n; done
fi
exec "${NODE:-node}" java-raw.js "$@"
