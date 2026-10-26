#!/bin/sh
# Fetch and patch every input for the wasm OpenJDK lane. Every replacement is
# prepared in an owned transaction directory, validated, and published under a
# lock. A marker makes the three sequential renames recoverable after a crash
# or an interrupted command.
set -eu

HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
WORK=${MCWEB_SETUP_WORK:-"$HERE/work"}
mkdir -p "$WORK"
WORK=$(CDPATH= cd -- "$WORK" && pwd -P)
if [ "$WORK" = / ]; then
  echo "setup: refusing filesystem root as setup work directory" >&2
  exit 1
fi
EMSDK_FINAL="$WORK/emsdk"
# Pinned toolchain inputs. "latest" drifted under this tree twice: emsdk moved
# to 6.x, and libffi master started putting helper functions after an EM_JS
# body, which Emscripten's side-module loader (it wraps each body as an arrow
# function) cannot parse, so libjvm.so failed to load with "Unexpected token
# 'function'". These are the versions the current patch stack is built and
# tested with.
EMSDK_VERSION=${MCWEB_EMSDK_VERSION:-6.0.10}
LIBFFI_COMMIT=${MCWEB_LIBFFI_COMMIT:-c575818ce67cb471467c580a01ae8f7b6538a6e2}
JDK_FINAL="$WORK/jdk25"
LIBFFI_FINAL="$WORK/libffi-upstream"
LOCK_FILE="$WORK/.setup.lock"
LOCK_DIR="$WORK/.setup.lock.d"
MARKER="$WORK/.setup-transaction"

TXN_DIR=
TXN_DIR_OWNED=0
FALLBACK_LOCK_OWNED=0
FALLBACK_LOCK_TOKEN=

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

canonical_directory() {
  candidate=$1
  [ -d "$candidate" ] || return 1
  [ ! -L "$candidate" ] || return 1
  (CDPATH= cd -P -- "$candidate" 2>/dev/null && pwd -P)
}

canonical_existing_path() {
  candidate=$1
  [ -e "$candidate" ] || return 1
  [ ! -L "$candidate" ] || return 1
  parent=$(canonical_directory "$(dirname "$candidate")") || return 1
  printf '%s/%s\n' "$parent" "$(basename "$candidate")"
}

path_under_work() {
  case "$1" in
    "$WORK"|"$WORK"/*) return 0 ;;
    *) return 1 ;;
  esac
}

marker_path_is_safe() {
  [ "$MARKER" = "$WORK/.setup-transaction" ] || return 1
  [ ! -L "$MARKER" ] || return 1
  if path_exists "$MARKER"; then
    [ -f "$MARKER" ] || return 1
  fi
}

owned_transaction_path() {
  candidate=$1
  [ -d "$candidate" ] || return 1
  [ ! -L "$candidate" ] || return 1
  canonical=$(canonical_directory "$candidate") || return 1
  [ "$canonical" = "$candidate" ] || return 1
  path_under_work "$canonical" || return 1
  transaction_name=${canonical#"$WORK"/}
  case "$transaction_name" in
    .setup-txn.*) case "$transaction_name" in */*) return 1 ;; esac ;;
    *) return 1 ;;
  esac
}

transaction_child_is_safe() {
  child=$1
  case "$child" in
    "$TXN_DIR"/stage-emsdk|"$TXN_DIR"/stage-jdk|"$TXN_DIR"/stage-libffi|\
    "$TXN_DIR"/backup-emsdk|"$TXN_DIR"/backup-jdk|"$TXN_DIR"/backup-libffi) ;;
    *) return 1 ;;
  esac
  if path_exists "$child"; then
    [ ! -L "$child" ] || return 1
    case "$child" in
      "$TXN_DIR"/stage-*) [ -d "$child" ] || return 1 ;;
    esac
    canonical_child=$(canonical_existing_path "$child") || return 1
    [ "$canonical_child" = "$child" ] || return 1
    path_under_work "$canonical_child" || return 1
  fi
}

transaction_layout_is_safe() {
  marker_path_is_safe || return 1
  owned_transaction_path "$TXN_DIR" || return 1
  transaction_child_is_safe "$TXN_DIR/stage-emsdk" || return 1
  transaction_child_is_safe "$TXN_DIR/stage-jdk" || return 1
  transaction_child_is_safe "$TXN_DIR/stage-libffi" || return 1
  transaction_child_is_safe "$TXN_DIR/backup-emsdk" || return 1
  transaction_child_is_safe "$TXN_DIR/backup-jdk" || return 1
  transaction_child_is_safe "$TXN_DIR/backup-libffi" || return 1
}

die() {
  echo "setup: $*" >&2
  exit 1
}

remove_owned_transaction() {
  candidate=$1
  owned_transaction_path "$candidate" || die "refusing to remove non-owned transaction path: $candidate"
  rm -rf "$candidate"
}

cleanup_staging() {
  status=$?
  if [ "$TXN_DIR_OWNED" -eq 1 ] && [ -n "$TXN_DIR" ]; then
    preserve_transaction=0
    if ! transaction_layout_is_safe; then
      echo "setup: refusing cleanup of an unsafe transaction layout: $TXN_DIR" >&2
      preserve_transaction=1
      status=1
    elif path_exists "$MARKER"; then
      marker_txn=$(sed -n 's/^txndir=//p' "$MARKER" 2>/dev/null | sed -n '1p' || true)
      [ "$marker_txn" = "$TXN_DIR" ] && preserve_transaction=1
    fi
    if [ "$preserve_transaction" -eq 0 ]; then
      remove_owned_transaction "$TXN_DIR" || status=1
    fi
  fi
  if [ "$FALLBACK_LOCK_OWNED" -eq 1 ] && [ -n "$FALLBACK_LOCK_TOKEN" ]; then
    owner_file="$LOCK_DIR/owner"
    if [ -f "$owner_file" ] && [ "$(sed -n '1p' "$owner_file")" = "$FALLBACK_LOCK_TOKEN" ]; then
      rm -f "$owner_file" "$FALLBACK_LOCK_TOKEN"
      rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
  fi
  return "$status"
}

manifest_value() {
  key=$1
  sed -n "s/^${key}=//p" "$MARKER" | sed -n '1p'
}

write_manifest() {
  phase=$1
  transaction_layout_is_safe || die "refusing to write manifest for an unsafe transaction layout"
  tmp_manifest=$(mktemp "$WORK/.setup-transaction.tmp.XXXXXX")
  {
    printf '%s\n' 'version=1'
    printf 'txndir=%s\n' "$TXN_DIR"
    printf 'phase=%s\n' "$phase"
    printf 'replace_emsdk=%s\n' "$REPLACE_EMSDK"
    printf 'replace_jdk=%s\n' "$REPLACE_JDK"
    printf 'replace_libffi=%s\n' "$REPLACE_LIBFFI"
    printf 'done_emsdk=%s\n' "$DONE_EMSDK"
    printf 'done_jdk=%s\n' "$DONE_JDK"
    printf 'done_libffi=%s\n' "$DONE_LIBFFI"
  } > "$tmp_manifest"
  mv "$tmp_manifest" "$MARKER"
}

valid_boolean() {
  case "$1" in
    0|1) return 0 ;;
    *) return 1 ;;
  esac
}

validate_marker() {
  marker_path_is_safe || die "transaction marker path is unsafe: $MARKER"
  version=$(manifest_value version)
  [ "$version" = 1 ] || die "unsupported transaction marker version"
  TXN_DIR=$(manifest_value txndir)
  owned_transaction_path "$TXN_DIR" || die "transaction marker names a non-owned directory: $TXN_DIR"
  [ -d "$TXN_DIR" ] || die "transaction directory is missing: $TXN_DIR"
  transaction_layout_is_safe || die "transaction marker names unsafe stage or backup paths"
  phase=$(manifest_value phase)
  case "$phase" in
    prepared|committing|complete) ;;
    *) die "invalid transaction phase: $phase" ;;
  esac
  REPLACE_EMSDK=$(manifest_value replace_emsdk)
  REPLACE_JDK=$(manifest_value replace_jdk)
  REPLACE_LIBFFI=$(manifest_value replace_libffi)
  DONE_EMSDK=$(manifest_value done_emsdk)
  DONE_JDK=$(manifest_value done_jdk)
  DONE_LIBFFI=$(manifest_value done_libffi)
  valid_boolean "$REPLACE_EMSDK" || die "invalid emsdk replacement marker"
  valid_boolean "$REPLACE_JDK" || die "invalid JDK replacement marker"
  valid_boolean "$REPLACE_LIBFFI" || die "invalid libffi replacement marker"
  valid_boolean "$DONE_EMSDK" || die "invalid emsdk completion marker"
  valid_boolean "$DONE_JDK" || die "invalid JDK completion marker"
  valid_boolean "$DONE_LIBFFI" || die "invalid libffi completion marker"
}

emsdk_is_valid() {
  candidate=$1
  [ -d "$candidate/.git" ] || return 1
  [ -x "$candidate/emsdk" ] || return 1
  [ -f "$candidate/emsdk.py" ] || return 1
  [ -f "$candidate/emsdk_env.sh" ] || return 1
  [ -f "$candidate/upstream/emscripten/emcc.py" ] || return 1
  [ -f "$candidate/upstream/bin/clang" ] || return 1
}

emsdk_environment_is_valid() {
  candidate=$1
  if [ "${MCWEB_SETUP_TEST_MODE:-0}" = 1 ]; then
    [ ! -L "$candidate/.mock-env-valid" ] && [ -f "$candidate/.mock-env-valid" ]
    return
  fi
  (
    cd "$candidate"
    unset EMSDK
    EMSDK_QUIET=1 . ./emsdk_env.sh >/dev/null 2>&1
    [ "${EMSDK:-}" = "$candidate" ]
  )
}

# Validate the complete applied stack without touching the user checkout. The
# temporary tree contains only files named by the patch stack, so this catches
# a failed earlier patch rather than checking only the last patch.
patch_stack_is_applied() {
  candidate=$1
  shift
  if [ "${MCWEB_SETUP_TEST_MODE:-0}" = 1 ]; then
    [ -f "$candidate/.mock-repository" ] || return 1
    for patch in "$@"; do
      [ -f "$candidate/.mock-patched.$(basename "$patch")" ] || return 1
    done
    return 0
  fi
  [ -d "$candidate/.git" ] || return 1
  check_dir=$(mktemp -d "$WORK/.patch-stack-check.XXXXXX") || return 1
  (
    trap 'case "$check_dir" in "$WORK"/.patch-stack-check.*) rm -rf "$check_dir" ;; esac' EXIT HUP INT TERM
    for patch in "$@"; do
      for file_path in $(awk '/^diff --git / { print $4 }' "$patch" | sed 's#^b/##' | LC_ALL=C sort -u); do
        [ -n "$file_path" ] || continue
        [ -f "$candidate/$file_path" ] || exit 1
        mkdir -p "$check_dir/$(dirname "$file_path")"
        cp "$candidate/$file_path" "$check_dir/$file_path"
      done
    done
    for patch in "$@"; do
      git -C "$check_dir" apply --reverse --check "$patch"
      git -C "$check_dir" apply --reverse "$patch"
    done
  )
}

mock_clone() {
  kind=$1
  destination=$2
  mkdir -p "$destination/.git"
  printf '%s\n' mock > "$destination/.mock-repository"
  case "$kind" in
    emsdk)
      mkdir -p "$destination/upstream/emscripten"
      printf '%s\n' mock-emsdk > "$destination/emsdk"
      printf '%s\n' mock-emsdk-python > "$destination/emsdk.py"
      chmod +x "$destination/emsdk"
      ;;
    jdk)
      printf '%s\n' mock-jdk > "$destination/.mock-jdk"
      ;;
    libffi)
      printf '%s\n' mock-libffi > "$destination/configure"
      ;;
    *) die "unknown mock repository kind: $kind" ;;
  esac
}

clone_repository() {
  kind=$1
  destination=$2
  url=$3
  branch=${4:-}
  if [ "${MCWEB_SETUP_TEST_MODE:-0}" = 1 ]; then
    mock_clone "$kind" "$destination"
  elif [ -n "$branch" ]; then
    git clone --depth 1 --branch "$branch" "$url" "$destination"
  else
    git clone --depth 1 "$url" "$destination"
  fi
}

prepare_stage_directory() {
  destination=$1
  transaction_layout_is_safe || die "transaction layout is unsafe before staging"
  if path_exists "$destination"; then
    die "staging destination already exists: $destination"
  fi
  mkdir "$destination"
  transaction_layout_is_safe || die "new staging destination is unsafe"
}

mock_emsdk_command() {
  destination=$1
  action=$2
  if [ "$action" = install ] && [ "${MCWEB_SETUP_MOCK_FAIL_EMSDK_INSTALL:-0}" = 1 ]; then
    echo "setup mock: failing emsdk install" >&2
    return 1
  fi
  if [ "$action" = activate ] && [ "${MCWEB_SETUP_MOCK_FAIL_EMSDK_ACTIVATE:-0}" = 1 ]; then
    echo "setup mock: failing emsdk activate" >&2
    return 1
  fi
  case "$action" in
    install)
      mkdir -p "$destination/upstream/bin" "$destination/upstream/emscripten"
      printf '%s\n' mock-clang > "$destination/upstream/bin/clang"
      printf '%s\n' mock-emcc > "$destination/upstream/emscripten/emcc.py"
      ;;
    activate)
      printf '%s\n' '# mock emsdk environment' > "$destination/emsdk_env.sh"
      printf '%s\n' env-valid > "$destination/.mock-env-valid"
      ;;
    *) die "unknown mock emsdk action: $action" ;;
  esac
}

prepare_emsdk() {
  destination=$1
  prepare_stage_directory "$destination"
  clone_repository emsdk "$destination" https://github.com/emscripten-core/emsdk.git
  transaction_layout_is_safe || die "staged emsdk path is unsafe"
  if [ "${MCWEB_SETUP_TEST_MODE:-0}" = 1 ]; then
    mock_emsdk_command "$destination" install
    mock_emsdk_command "$destination" activate
  else
    python_bin=$(command -v python3.13 || command -v python3 || true)
    [ -n "$python_bin" ] || die "python3.13 or python3 is required by emsdk"
    (cd "$destination" && EMSDK="$destination" EM_CONFIG="$destination/.emscripten" EMSDK_PYTHON="$python_bin" ./emsdk install "$EMSDK_VERSION")
    (cd "$destination" && EMSDK="$destination" EM_CONFIG="$destination/.emscripten" EMSDK_PYTHON="$python_bin" ./emsdk activate "$EMSDK_VERSION")
  fi
  emsdk_is_valid "$destination" || die "staged emsdk is incomplete or invalid"
  emsdk_environment_is_valid "$destination" || die "staged emsdk environment is invalid"
}

apply_jdk_patches() {
  candidate=$1
  if [ "${MCWEB_SETUP_TEST_MODE:-0}" = 1 ]; then
    for patch in \
      "$HERE/patches/0001-openjdk25-wasm32-emscripten-zero.patch" \
      "$HERE/patches/0003-zero-switch-dispatch-on-wasm.patch" \
      "$HERE/patches/0004-zero-wasm-jit.patch" \
      "$HERE/patches/0005-zero-wasm-baseline.patch" \
      "$HERE/patches/0006-zero-wasm-linked-group.patch" \
      "$HERE/patches/0007-zero-wasm-linked-oop-store.patch" \
      "$HERE/patches/0008-zero-wasm-linked-alloc-bail.patch" \
      "$HERE/patches/0009-zero-wasm-linked-class-init-bail.patch" \
      "$HERE/patches/0010-zero-wasm-linked-virtual-guard.patch" \
      "$HERE/patches/0011-zero-wasm-linked-idiv-resume.patch" \
      "$HERE/patches/0012-zero-wasm-linked-invoke-throw-resume.patch" \
      "$HERE/patches/0013-zero-wasm-linked-benchmark.patch" \
      "$HERE/patches/0014-zero-wasm-linked-int-array-load.patch" \
      "$HERE/patches/0015-zero-wasm-linked-int-array-store.patch" \
      "$HERE/patches/0016-zero-wasm-linked-ref-array-load.patch" \
      "$HERE/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch" \
      "$HERE/patches/0018-zero-wasm-linked-ref-array-store.patch" \
      "$HERE/patches/0019-zero-wasm-reference-store-group.patch" \
      "$HERE/patches/0020-zero-wasm-reference-store-group-relocation-scaffold.patch" \
      "$HERE/patches/0021-zero-wasm-host-and-interpreter-fixes.patch" \
      "$HERE/patches/0022-zero-wasm-jit-direct-entry-typed-inline.patch" \
      "$HERE/patches/0023-zero-wasm-jit-reuse-retired-slots.patch" \
      "$HERE/patches/0024-zero-wasm-jit-filter-list.patch" \
      "$HERE/patches/0025-zero-wasm-jit-residence-stats.patch" \
      "$HERE/patches/0026-zero-wasm-jit-no-replayed-volatile-stores.patch"; do
      patch_name=$(basename "$patch")
      if [ "${MCWEB_SETUP_FAIL_PATCH:-}" = "$patch_name" ]; then
        echo "setup mock: failing JDK patch $patch_name" >&2
        return 1
      fi
      printf '%s\n' applied > "$candidate/.mock-patched.$patch_name"
    done
  else
    (
      cd "$candidate"
      git apply "$HERE/patches/0001-openjdk25-wasm32-emscripten-zero.patch"
      # Zero's computed-goto dispatch is a pessimisation on wasm; see the patch.
      git apply "$HERE/patches/0003-zero-switch-dispatch-on-wasm.patch"
      # Runtime bytecode -> wasm compiler for Zero (-XX:+UseZeroWasmJIT).
      git apply "$HERE/patches/0004-zero-wasm-jit.patch"
      # Narrow, opt-in method/group/oop lanes for generated OSS fixtures; these
      # apply commands intentionally remain adjacent for the transactional
      # patch-order check.
      git apply "$HERE/patches/0005-zero-wasm-baseline.patch"
      git apply "$HERE/patches/0006-zero-wasm-linked-group.patch"
      git apply "$HERE/patches/0007-zero-wasm-linked-oop-store.patch"
      git apply "$HERE/patches/0008-zero-wasm-linked-alloc-bail.patch"
      git apply "$HERE/patches/0009-zero-wasm-linked-class-init-bail.patch"
      git apply "$HERE/patches/0010-zero-wasm-linked-virtual-guard.patch"
      git apply "$HERE/patches/0011-zero-wasm-linked-idiv-resume.patch"
      git apply "$HERE/patches/0012-zero-wasm-linked-invoke-throw-resume.patch"
      git apply "$HERE/patches/0013-zero-wasm-linked-benchmark.patch"
      git apply "$HERE/patches/0014-zero-wasm-linked-int-array-load.patch"
      git apply "$HERE/patches/0015-zero-wasm-linked-int-array-store.patch"
      git apply "$HERE/patches/0016-zero-wasm-linked-ref-array-load.patch"
      git apply "$HERE/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch"
      git apply "$HERE/patches/0018-zero-wasm-linked-ref-array-store.patch"
      git apply "$HERE/patches/0019-zero-wasm-reference-store-group.patch"
      git apply "$HERE/patches/0020-zero-wasm-reference-store-group-relocation-scaffold.patch"
      # Linux host launcher lookup and the ldiv case 0011 dropped.
      git apply "$HERE/patches/0021-zero-wasm-host-and-interpreter-fixes.patch"
      # JIT: slot entry, direct entry, typed inlining, intrinsics.
      git apply "$HERE/patches/0022-zero-wasm-jit-direct-entry-typed-inline.patch"
      git apply "$HERE/patches/0023-zero-wasm-jit-reuse-retired-slots.patch"
      git apply "$HERE/patches/0024-zero-wasm-jit-filter-list.patch"
      git apply "$HERE/patches/0025-zero-wasm-jit-residence-stats.patch"
      git apply "$HERE/patches/0026-zero-wasm-jit-no-replayed-volatile-stores.patch"
    )
  fi
}

prepare_jdk() {
  destination=$1
  prepare_stage_directory "$destination"
  clone_repository jdk "$destination" https://github.com/openjdk/jdk.git jdk-25-ga
  transaction_layout_is_safe || die "staged JDK path is unsafe"
  apply_jdk_patches "$destination"
  patch_stack_is_applied "$destination" \
    "$HERE/patches/0026-zero-wasm-jit-no-replayed-volatile-stores.patch" \
    "$HERE/patches/0025-zero-wasm-jit-residence-stats.patch" \
    "$HERE/patches/0024-zero-wasm-jit-filter-list.patch" \
    "$HERE/patches/0023-zero-wasm-jit-reuse-retired-slots.patch" \
    "$HERE/patches/0022-zero-wasm-jit-direct-entry-typed-inline.patch" \
    "$HERE/patches/0021-zero-wasm-host-and-interpreter-fixes.patch" \
    "$HERE/patches/0020-zero-wasm-reference-store-group-relocation-scaffold.patch" \
    "$HERE/patches/0019-zero-wasm-reference-store-group.patch" \
    "$HERE/patches/0018-zero-wasm-linked-ref-array-store.patch" \
    "$HERE/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch" \
    "$HERE/patches/0016-zero-wasm-linked-ref-array-load.patch" \
    "$HERE/patches/0015-zero-wasm-linked-int-array-store.patch" \
    "$HERE/patches/0014-zero-wasm-linked-int-array-load.patch" \
    "$HERE/patches/0013-zero-wasm-linked-benchmark.patch" \
    "$HERE/patches/0012-zero-wasm-linked-invoke-throw-resume.patch" \
    "$HERE/patches/0011-zero-wasm-linked-idiv-resume.patch" \
    "$HERE/patches/0010-zero-wasm-linked-virtual-guard.patch" \
    "$HERE/patches/0009-zero-wasm-linked-class-init-bail.patch" \
    "$HERE/patches/0008-zero-wasm-linked-alloc-bail.patch" \
    "$HERE/patches/0007-zero-wasm-linked-oop-store.patch" \
    "$HERE/patches/0006-zero-wasm-linked-group.patch" \
    "$HERE/patches/0005-zero-wasm-baseline.patch" \
    "$HERE/patches/0004-zero-wasm-jit.patch" \
    "$HERE/patches/0003-zero-switch-dispatch-on-wasm.patch" \
    "$HERE/patches/0001-openjdk25-wasm32-emscripten-zero.patch" \
    || die "staged OpenJDK patch stack is incomplete or invalid"
}

prepare_libffi() {
  destination=$1
  prepare_stage_directory "$destination"
  clone_repository libffi "$destination" https://github.com/libffi/libffi.git
  if [ "${MCWEB_SETUP_TEST_MODE:-0}" != 1 ]; then
    (cd "$destination" && git fetch -q --depth 1 origin "$LIBFFI_COMMIT" \
      && git checkout -q FETCH_HEAD)
  fi
  transaction_layout_is_safe || die "staged libffi path is unsafe"
  if [ "${MCWEB_SETUP_TEST_MODE:-0}" = 1 ]; then
    patch_name=0002-libffi-wasm32-unaligned-64bit.patch
    if [ "${MCWEB_SETUP_FAIL_PATCH:-}" = "$patch_name" ]; then
      echo "setup mock: failing libffi patch $patch_name" >&2
      return 1
    fi
    printf '%s\n' applied > "$destination/.mock-patched.$patch_name"
  else
    (cd "$destination" && git apply "$HERE/patches/0002-libffi-wasm32-unaligned-64bit.patch")
  fi
  patch_stack_is_applied "$destination" \
    "$HERE/patches/0002-libffi-wasm32-unaligned-64bit.patch" \
    || die "staged libffi patch is incomplete or invalid"
}

component_is_valid() {
  component=$1
  candidate=$2
  case "$component" in
    emsdk)
      emsdk_is_valid "$candidate" && emsdk_environment_is_valid "$candidate"
      ;;
    jdk)
      patch_stack_is_applied "$candidate" \
        "$HERE/patches/0026-zero-wasm-jit-no-replayed-volatile-stores.patch" \
        "$HERE/patches/0025-zero-wasm-jit-residence-stats.patch" \
        "$HERE/patches/0024-zero-wasm-jit-filter-list.patch" \
        "$HERE/patches/0023-zero-wasm-jit-reuse-retired-slots.patch" \
        "$HERE/patches/0022-zero-wasm-jit-direct-entry-typed-inline.patch" \
        "$HERE/patches/0021-zero-wasm-host-and-interpreter-fixes.patch" \
        "$HERE/patches/0020-zero-wasm-reference-store-group-relocation-scaffold.patch" \
        "$HERE/patches/0019-zero-wasm-reference-store-group.patch" \
        "$HERE/patches/0018-zero-wasm-linked-ref-array-store.patch" \
        "$HERE/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch" \
        "$HERE/patches/0016-zero-wasm-linked-ref-array-load.patch" \
        "$HERE/patches/0015-zero-wasm-linked-int-array-store.patch" \
        "$HERE/patches/0014-zero-wasm-linked-int-array-load.patch" \
        "$HERE/patches/0013-zero-wasm-linked-benchmark.patch" \
        "$HERE/patches/0012-zero-wasm-linked-invoke-throw-resume.patch" \
        "$HERE/patches/0011-zero-wasm-linked-idiv-resume.patch" \
        "$HERE/patches/0010-zero-wasm-linked-virtual-guard.patch" \
        "$HERE/patches/0009-zero-wasm-linked-class-init-bail.patch" \
        "$HERE/patches/0008-zero-wasm-linked-alloc-bail.patch" \
        "$HERE/patches/0007-zero-wasm-linked-oop-store.patch" \
        "$HERE/patches/0006-zero-wasm-linked-group.patch" \
        "$HERE/patches/0005-zero-wasm-baseline.patch" \
        "$HERE/patches/0004-zero-wasm-jit.patch" \
        "$HERE/patches/0003-zero-switch-dispatch-on-wasm.patch" \
        "$HERE/patches/0001-openjdk25-wasm32-emscripten-zero.patch"
      ;;
    libffi)
      patch_stack_is_applied "$candidate" \
        "$HERE/patches/0002-libffi-wasm32-unaligned-64bit.patch"
      ;;
    *) die "unknown transaction component: $component" ;;
  esac
}

component_final() {
  case "$1" in
    emsdk) printf '%s\n' "$EMSDK_FINAL" ;;
    jdk) printf '%s\n' "$JDK_FINAL" ;;
    libffi) printf '%s\n' "$LIBFFI_FINAL" ;;
    *) die "unknown transaction component: $1" ;;
  esac
}

component_stage() {
  printf '%s\n' "$TXN_DIR/stage-$1"
}

component_backup() {
  printf '%s\n' "$TXN_DIR/backup-$1"
}

rollback_published_component() {
  component=$1
  final=$(component_final "$component")
  stage=$(component_stage "$component")
  backup=$(component_backup "$component")
  transaction_layout_is_safe || die "transaction layout became unsafe during $component rollback"
  path_exists "$stage" && die "staged $component path unexpectedly reappeared during rollback"
  mv "$final" "$stage"
  if path_exists "$backup"; then
    path_exists "$final" && die "final $component path unexpectedly reappeared during rollback"
    mv "$backup" "$final"
  fi
}

maybe_fail_commit() {
  if [ "${MCWEB_SETUP_FAIL_COMMIT_AT:-}" = "$1" ]; then
    echo "setup mock: failing commit at $1" >&2
    return 1
  fi
  return 0
}

set_component_done() {
  component=$1
  case "$component" in
    emsdk) DONE_EMSDK=1 ;;
    jdk) DONE_JDK=1 ;;
    libffi) DONE_LIBFFI=1 ;;
    *) die "unknown transaction component: $component" ;;
  esac
  write_manifest committing
}

commit_component() {
  component=$1
  transaction_layout_is_safe || die "transaction layout became unsafe before $component publication"
  final=$(component_final "$component")
  stage=$(component_stage "$component")
  backup=$(component_backup "$component")
  case "$component" in
    emsdk) replace=$REPLACE_EMSDK; done=$DONE_EMSDK ;;
    jdk) replace=$REPLACE_JDK; done=$DONE_JDK ;;
    libffi) replace=$REPLACE_LIBFFI; done=$DONE_LIBFFI ;;
    *) die "unknown transaction component: $component" ;;
  esac
  [ "$replace" -eq 1 ] || return 0
  if [ "$done" -eq 1 ]; then
    component_is_valid "$component" "$final" || die "published $component is no longer valid"
    return 0
  fi

  maybe_fail_commit "before-$component"
  if component_is_valid "$component" "$final"; then
    path_exists "$stage" && die "valid $component and staged replacement are both present"
    set_component_done "$component"
    return 0
  fi
  if path_exists "$final"; then
    [ ! -L "$final" ] || die "refusing to replace symlinked final $component path"
    path_exists "$backup" && die "ambiguous $component backup in transaction"
    mv "$final" "$backup"
    maybe_fail_commit "after-$component-backup"
  fi
  path_exists "$stage" || die "staged $component is missing during recovery"
  component_is_valid "$component" "$stage" || die "staged $component failed validation before publication"
  mv "$stage" "$final"
  maybe_fail_commit "after-$component-install"
  if ! component_is_valid "$component" "$final"; then
    rollback_published_component "$component"
    die "published $component failed validation"
  fi
  set_component_done "$component"
}

validate_all_final() {
  emsdk_is_valid "$EMSDK_FINAL" || return 1
  emsdk_environment_is_valid "$EMSDK_FINAL" || return 1
  component_is_valid jdk "$JDK_FINAL" || return 1
  component_is_valid libffi "$LIBFFI_FINAL" || return 1
}

commit_transaction() {
  transaction_layout_is_safe || die "refusing to commit an unsafe transaction layout"
  write_manifest committing
  commit_component emsdk
  commit_component jdk
  commit_component libffi
  validate_all_final || die "published setup inputs failed validation while lock was held"
  emsdk_environment_is_valid "$EMSDK_FINAL" || die "published emsdk environment failed validation while lock was held"
  DONE_EMSDK=1
  DONE_JDK=1
  DONE_LIBFFI=1
  write_manifest complete
  rm -f "$MARKER"
}

recover_transaction() {
  if ! path_exists "$MARKER"; then
    return 0
  fi
  validate_marker
  # The marker owns this transaction directory. Do not clean it on a failed
  # retry: staged trees and backups are the recovery record.
  TXN_DIR_OWNED=0
  commit_transaction
}

start_transaction() {
  REPLACE_EMSDK=0
  REPLACE_JDK=0
  REPLACE_LIBFFI=0
  if ! emsdk_is_valid "$EMSDK_FINAL" || ! emsdk_environment_is_valid "$EMSDK_FINAL"; then REPLACE_EMSDK=1; fi
  if ! component_is_valid jdk "$JDK_FINAL"; then REPLACE_JDK=1; fi
  if ! component_is_valid libffi "$LIBFFI_FINAL"; then REPLACE_LIBFFI=1; fi
  if [ "$REPLACE_EMSDK$REPLACE_JDK$REPLACE_LIBFFI" = 000 ]; then
    echo "setup: preserving valid OpenJDK, libffi, and emsdk trees"
    return 0
  fi

  TXN_DIR=$(mktemp -d "$WORK/.setup-txn.XXXXXX")
  TXN_DIR_OWNED=1
  owned_transaction_path "$TXN_DIR" || die "new transaction directory is unsafe"
  if [ "$REPLACE_EMSDK" -eq 1 ]; then prepare_emsdk "$TXN_DIR/stage-emsdk"; fi
  if [ "$REPLACE_JDK" -eq 1 ]; then prepare_jdk "$TXN_DIR/stage-jdk"; fi
  if [ "$REPLACE_LIBFFI" -eq 1 ]; then prepare_libffi "$TXN_DIR/stage-libffi"; fi
  DONE_EMSDK=$((1 - REPLACE_EMSDK))
  DONE_JDK=$((1 - REPLACE_JDK))
  DONE_LIBFFI=$((1 - REPLACE_LIBFFI))
  write_manifest prepared
  maybe_fail_commit after-prepared-marker
  TXN_DIR_OWNED=0
  commit_transaction
}

setup_locked() {
  trap cleanup_staging EXIT
  trap 'exit 1' HUP INT TERM
  cd "$WORK"
  [ -f package.json ] || printf '%s\n' '{"type":"commonjs"}' > package.json
  if [ "${MCWEB_SETUP_TEST_MODE:-0}" = 1 ] && [ -n "${MCWEB_SETUP_MOCK_SLEEP:-}" ]; then
    sleep "$MCWEB_SETUP_MOCK_SLEEP"
  fi
  recover_transaction
  start_transaction
  validate_all_final || die "setup inputs are not valid after transaction recovery"
  cd "$EMSDK_FINAL"
  . ./emsdk_env.sh >/dev/null 2>&1
  if [ "${MCWEB_SETUP_TEST_MODE:-0}" != 1 ]; then
    [ "${EMSDK:-}" = "$EMSDK_FINAL" ] || die "published emsdk environment points at the wrong tree"
  fi
  cd "$WORK"

  if [ "${MCWEB_SETUP_TEST_MODE:-0}" = 1 ]; then
    echo "setup mock complete"
    return 0
  fi

  # libffi must be -fPIC: the JDK links it into Emscripten SIDE_MODULEs.
  PATH="/opt/homebrew/opt/libtool/libexec/gnubin:/opt/homebrew/bin:$PATH"
  export PATH
  cd "$LIBFFI_FINAL"
  [ -f configure ] || ./autogen.sh
  mkdir -p build && cd build
  emconfigure ../configure --host=wasm32-unknown-emscripten \
    --prefix="$WORK/prefix" --enable-static --disable-shared \
    --disable-dependency-tracking --disable-multi-os-directory --disable-docs \
    CFLAGS="-O3 -fPIC -pthread"
  emmake make -j8 install

  echo "setup complete: now run ./configure-wasm.sh"
}

acquire_fallback_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    FALLBACK_LOCK_TOKEN=$(mktemp "$LOCK_DIR/token.XXXXXX")
    printf '%s\n' "$FALLBACK_LOCK_TOKEN" > "$LOCK_DIR/owner"
    FALLBACK_LOCK_OWNED=1
    return 0
  fi
  # A directory lock has no safe stale-PID test. Refuse it and leave it for
  # explicit operator recovery; never guess based on a reused PID or delete a
  # possibly live owner's directory.
  die "setup lock is already present and lockf is unavailable: $LOCK_DIR"
}

run_with_lock() {
  if command -v lockf >/dev/null 2>&1; then
    (
      if ! lockf -s -t 0 9; then
        echo "setup: another setup invocation holds $LOCK_FILE" >&2
        exit 75
      fi
      setup_locked
    ) 9>"$LOCK_FILE"
  elif command -v flock >/dev/null 2>&1; then
    (
      if ! flock -n 9; then
        echo "setup: another setup invocation holds $LOCK_FILE" >&2
        exit 75
      fi
      setup_locked
    ) 9>"$LOCK_FILE"
  else
    acquire_fallback_lock
    setup_locked
  fi
}

run_with_lock
