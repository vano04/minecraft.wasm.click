#!/bin/sh
# Start the private display test Chrome draws into (tools/test-display.mjs),
# unless it is already running: a headless Weston on its own Wayland socket.
# Nothing appears on the desktop, and the desktop's compositor is not involved.
#
#   tools/test-display.sh          # start (idempotent)
#   tools/test-display.sh stop     # stop it
#
# It has no pointer device: Chrome crashes if a page requests pointer lock
# here, so game drivers pass ?mcweb_fakePointerLock=1 (tools/test-display.mjs).
# WebGPU uses Vulkan on the real GPU. The desktop shell, not kiosk: kiosk-shell
# with the GL renderer segfaults when a second client connects after the first
# has gone (reproduced: every Chrome after the first killed it, exit 139).
set -eu
SOCKET=${MCWEB_WAYLAND:-mcweb-weston}
RUNTIME=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
LOG=${MCWEB_WESTON_LOG:-/tmp/mcweb-weston-$(id -u).log}
pid() { ps -eo pid,args | awk -v s="--socket=$SOCKET" '$2 ~ /weston$/ && index($0, s) { print $1 }'; }

if [ "${1:-}" = stop ]; then
  P=$(pid); [ -n "$P" ] && kill "$P" && echo "stopped weston $P"
  exit 0
fi
rm -f "$RUNTIME/mcweb-xw-probe" "$RUNTIME/mcweb-xw-probe.lock" 2>/dev/null || true
if [ -n "$(pid)" ] && [ -S "$RUNTIME/$SOCKET" ]; then
  if ps -eo args | grep -qE "^weston .*--socket=$SOCKET .*(--xwayland|--shell=kiosk)"; then
    kill "$(pid)"; sleep 1   # an older instance (Xwayland or kiosk shell): restart
  else
    echo "test display already up: weston $SOCKET (pid $(pid))"; exit 0
  fi
fi
# Appended, with a marker: if an instance dies, its last lines survive the restart.
echo "=== $(date -Is) starting weston on $SOCKET" >>"$LOG"
XDG_RUNTIME_DIR=$RUNTIME setsid -f weston --backend=headless --renderer=gl --socket="$SOCKET" \
  --width=1920 --height=1080 --idle-time=0 --shell=desktop >>"$LOG" 2>&1 </dev/null
i=0
while [ ! -S "$RUNTIME/$SOCKET" ] && [ $i -lt 50 ]; do i=$((i + 1)); sleep 0.1; done
[ -S "$RUNTIME/$SOCKET" ] || { echo "weston did not start; see $LOG" >&2; exit 1; }
echo "test display up: weston $SOCKET (pid $(pid)), log $LOG"
