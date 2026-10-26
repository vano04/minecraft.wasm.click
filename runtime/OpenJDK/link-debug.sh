#!/bin/sh
# Link the wasm JVM for a browser tab with DWARF debug info (-g), as
# browser/javavm-debug.{js,wasm,data}. Otherwise identical to link-browser.sh,
# which does the work; MCWEB_LINK_EXTRA still adds flags.
MCWEB_LINK_OUT=javavm-debug MCWEB_LINK_EXTRA="-g ${MCWEB_LINK_EXTRA:-}" \
  exec "$(dirname "$0")/link-browser.sh" "$@"
