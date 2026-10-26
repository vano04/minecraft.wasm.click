#!/bin/sh
# Shared fail-fast lock for Zero/Wasm gates that use Java, Emscripten, or the
# fixed shared module dumps.  The exact path is intentionally outside the repo.
RUNTIME_GATE_LOCK_DIR=/private/tmp/mcweb-zero-runtime-gate.lock
RUNTIME_GATE_LOCK_HELD=0

runtime_gate_lock_acquire() {
  [ "$RUNTIME_GATE_LOCK_HELD" -eq 0 ] || return 0
  if mkdir "$RUNTIME_GATE_LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" >"$RUNTIME_GATE_LOCK_DIR/pid"
    printf '%s\n' "$(date +%s)" >"$RUNTIME_GATE_LOCK_DIR/created"
    RUNTIME_GATE_LOCK_HELD=1
    return 0
  fi
  [ -d "$RUNTIME_GATE_LOCK_DIR" ] || return 1
  [ -f "$RUNTIME_GATE_LOCK_DIR/pid" ] || return 1
  owner=$(sed -n '1p' "$RUNTIME_GATE_LOCK_DIR/pid")
  case "$owner" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if kill -0 "$owner" 2>/dev/null; then
    echo "runtime gate lock busy: pid=$owner path=$RUNTIME_GATE_LOCK_DIR" >&2
    return 1
  fi
  rm -rf -- "$RUNTIME_GATE_LOCK_DIR"
  mkdir "$RUNTIME_GATE_LOCK_DIR" 2>/dev/null || return 1
  printf '%s\n' "$$" >"$RUNTIME_GATE_LOCK_DIR/pid"
  printf '%s\n' "$(date +%s)" >"$RUNTIME_GATE_LOCK_DIR/created"
  RUNTIME_GATE_LOCK_HELD=1
}

runtime_gate_lock_release() {
  [ "$RUNTIME_GATE_LOCK_HELD" -eq 1 ] || return 0
  owner=$(sed -n '1p' "$RUNTIME_GATE_LOCK_DIR/pid" 2>/dev/null || true)
  [ "$owner" = "$$" ] || return 1
  rm -rf -- "$RUNTIME_GATE_LOCK_DIR"
  RUNTIME_GATE_LOCK_HELD=0
}

runtime_gate_lock_stat() {
  path=$1
  if [ -e "$path" ]; then
    stat -f '%m:%z' "$path"
  else
    printf '%s\n' missing
  fi
}

# The caller holds the lock. A second invocation must fail before it can
# remove or write a shared dump. Arguments after the script are dump paths.
runtime_gate_lock_self_test() {
  script=$1
  shift
  before_file=$(mktemp /private/tmp/mcweb-zero-runtime-lock-before.XXXXXX)
  after_file=$(mktemp /private/tmp/mcweb-zero-runtime-lock-after.XXXXXX)
  : >"$before_file"
  for dump in "$@"; do
    printf '%s\t%s\n' "$dump" "$(runtime_gate_lock_stat "$dump")" >>"$before_file"
  done
  if MCWEB_RUNTIME_GATE_LOCK_PROBE=1 "$script" >"$after_file" 2>&1; then
    rm -f -- "$before_file" "$after_file"
    return 1
  fi
  : >"$after_file"
  for dump in "$@"; do
    printf '%s\t%s\n' "$dump" "$(runtime_gate_lock_stat "$dump")" >>"$after_file"
  done
  cmp -s "$before_file" "$after_file"
  status=$?
  rm -f -- "$before_file" "$after_file"
  return "$status"
}
