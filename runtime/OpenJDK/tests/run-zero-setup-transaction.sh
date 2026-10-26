#!/bin/sh
# Network-free transaction tests for OpenJDK/setup.sh. The setup script's
# explicit mock provider exercises the same staging, marker, rename, retry,
# validation, and lock paths without cloning or compiling third-party inputs.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
SETUP="$ROOT/setup.sh"
PATCH17="$ROOT/patches/0017-zero-wasm-linked-ref-array-load-cache-integrity.patch"
EXPECTED_PATCH17_SHA=ddb93941e71c293b6b20ca2810806301aaddf046f1f0cd24d2bb21366cac96a8
PATCH18="$ROOT/patches/0018-zero-wasm-linked-ref-array-store.patch"
EXPECTED_PATCH18_SHA=53cf9d1332f70d3f83e101ec73b5f6d3ebde7e9bb059fd8456754a3e0bcc0024
PATCH19="$ROOT/patches/0019-zero-wasm-reference-store-group.patch"
EXPECTED_PATCH19_SHA=983ed617633fbf9b2635a3a175dfbf96850c72412388f3fb6474e9364e935905
PATCH20="$ROOT/patches/0020-zero-wasm-reference-store-group-relocation-scaffold.patch"
EXPECTED_PATCH20_SHA=9485c8785249162ba1d407423a52c62ef634188fcd31afe5a87dd04646cfa51e
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/mcweb-zero-setup.XXXXXX")

reject() {
  echo "REJECT setup transaction gate: $*" >&2
  exit 1
}

cleanup() {
  status=$?
  rm -rf "$TEST_ROOT"
  return "$status"
}
trap cleanup EXIT HUP INT TERM

sh -n "$SETUP" || reject "setup shell syntax"
[ -x "$SETUP" ] || reject "setup script is not executable"
[ -f "$PATCH17" ] || reject "0017 patch is unavailable"
[ -f "$PATCH18" ] || reject "0018 patch is unavailable"
[ -f "$PATCH19" ] || reject "0019 patch is unavailable"
[ -f "$PATCH20" ] || reject "0020 patch is unavailable"
[ "$(shasum -a 256 "$PATCH17" | awk '{print $1}')" = "$EXPECTED_PATCH17_SHA" ] \
  || reject "0017 patch hash drift"
check_0017_payload() {
  candidate=$1
  [ "$(rg -c '^diff --git ' "$candidate")" -eq 1 ] || return 1
  rg -q '^diff --git a/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp b/src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp$' \
    "$candidate" || return 1
  ! rg -q '^(GIT binary patch|Binary files |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )' \
    "$candidate"
}
check_0017_payload "$PATCH17" || reject "0017 path/mode/binary payload drift"
cp "$PATCH17" "$TEST_ROOT/0017-extra.patch"
printf '%s\n' 'diff --git a/tests/unowned.bin b/tests/unowned.bin' >>"$TEST_ROOT/0017-extra.patch"
if check_0017_payload "$TEST_ROOT/0017-extra.patch"; then
  reject "0017 extra-path negative accepted"
fi
cp "$PATCH17" "$TEST_ROOT/0017-binary.patch"
printf '%s\n' 'GIT binary patch' >>"$TEST_ROOT/0017-binary.patch"
if check_0017_payload "$TEST_ROOT/0017-binary.patch"; then
  reject "0017 binary negative accepted"
fi
cp "$PATCH17" "$TEST_ROOT/0017-mode.patch"
printf '%s\n' 'new mode 100755' >>"$TEST_ROOT/0017-mode.patch"
if check_0017_payload "$TEST_ROOT/0017-mode.patch"; then
  reject "0017 mode negative accepted"
fi
check_0018_payload() {
  candidate=$1
  [ "$(rg -c '^diff --git ' "$candidate")" -eq 3 ] || return 1
  awk '/^diff --git / { print $4 }' "$candidate" | sed 's#^b/##' \
    | LC_ALL=C sort >"$TEST_ROOT/0018-paths.actual"
  printf '%s\n' \
    src/hotspot/cpu/zero/globals_zero.hpp \
    src/hotspot/share/interpreter/zero/bytecodeInterpreter.cpp \
    src/hotspot/share/interpreter/zero/zeroWasmBaseline.cpp \
    >"$TEST_ROOT/0018-paths.expected"
  cmp -s "$TEST_ROOT/0018-paths.actual" "$TEST_ROOT/0018-paths.expected" \
    || return 1
  ! rg -q '^(GIT binary patch|Binary files |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )' \
    "$candidate"
}
[ "$(shasum -a 256 "$PATCH18" | awk '{print $1}')" = "$EXPECTED_PATCH18_SHA" ] \
  || reject "0018 patch hash drift"
check_0018_payload "$PATCH18" || reject "0018 path/mode/binary payload drift"
cp "$PATCH18" "$TEST_ROOT/0018-extra.patch"
printf '%s\n' 'diff --git a/tests/unowned.bin b/tests/unowned.bin' >>"$TEST_ROOT/0018-extra.patch"
if check_0018_payload "$TEST_ROOT/0018-extra.patch"; then
  reject "0018 extra-path negative accepted"
fi
cp "$PATCH18" "$TEST_ROOT/0018-binary.patch"
printf '%s\n' 'GIT binary patch' >>"$TEST_ROOT/0018-binary.patch"
if check_0018_payload "$TEST_ROOT/0018-binary.patch"; then
  reject "0018 binary negative accepted"
fi
cp "$PATCH18" "$TEST_ROOT/0018-mode.patch"
printf '%s\n' 'new mode 100755' >>"$TEST_ROOT/0018-mode.patch"
if check_0018_payload "$TEST_ROOT/0018-mode.patch"; then
  reject "0018 mode negative accepted"
fi
[ "$(shasum -a 256 "$PATCH19" | awk '{print $1}')" = "$EXPECTED_PATCH19_SHA" ] \
  || reject "0019 patch hash drift"
check_0018_payload "$PATCH19" || reject "0019 path/mode/binary payload drift"
cp "$PATCH19" "$TEST_ROOT/0019-extra.patch"
printf '%s\n' 'diff --git a/tests/unowned.bin b/tests/unowned.bin' >>"$TEST_ROOT/0019-extra.patch"
if check_0018_payload "$TEST_ROOT/0019-extra.patch"; then
  reject "0019 extra-path negative accepted"
fi
cp "$PATCH19" "$TEST_ROOT/0019-binary.patch"
printf '%s\n' 'GIT binary patch' >>"$TEST_ROOT/0019-binary.patch"
if check_0018_payload "$TEST_ROOT/0019-binary.patch"; then
  reject "0019 binary negative accepted"
fi
cp "$PATCH19" "$TEST_ROOT/0019-mode.patch"
printf '%s\n' 'new mode 100755' >>"$TEST_ROOT/0019-mode.patch"
if check_0018_payload "$TEST_ROOT/0019-mode.patch"; then
  reject "0019 mode negative accepted"
fi
[ "$(shasum -a 256 "$PATCH20" | awk '{print $1}')" = "$EXPECTED_PATCH20_SHA" ] \
  || reject "0020 patch hash drift"
check_0018_payload "$PATCH20" || reject "0020 path/mode/binary payload drift"
cp "$PATCH20" "$TEST_ROOT/0020-extra.patch"
printf '%s\n' 'diff --git a/tests/unowned.bin b/tests/unowned.bin' >>"$TEST_ROOT/0020-extra.patch"
if check_0018_payload "$TEST_ROOT/0020-extra.patch"; then
  reject "0020 extra-path negative accepted"
fi
cp "$PATCH20" "$TEST_ROOT/0020-binary.patch"
printf '%s\n' 'GIT binary patch' >>"$TEST_ROOT/0020-binary.patch"
if check_0018_payload "$TEST_ROOT/0020-binary.patch"; then
  reject "0020 binary negative accepted"
fi
cp "$PATCH20" "$TEST_ROOT/0020-mode.patch"
printf '%s\n' 'new mode 100755' >>"$TEST_ROOT/0020-mode.patch"
if check_0018_payload "$TEST_ROOT/0020-mode.patch"; then
  reject "0020 mode negative accepted"
fi
prepare_reverse=$(sed -n '/^prepare_jdk()/,/^prepare_libffi()/p' "$SETUP" |
  sed -n 's#.*"\$HERE/patches/\([^"]*\)".*#\1#p' | paste -sd, -)
[ "$prepare_reverse" = "0026-zero-wasm-jit-no-replayed-volatile-stores.patch,0025-zero-wasm-jit-residence-stats.patch,0024-zero-wasm-jit-filter-list.patch,0023-zero-wasm-jit-reuse-retired-slots.patch,0022-zero-wasm-jit-direct-entry-typed-inline.patch,0021-zero-wasm-host-and-interpreter-fixes.patch,0020-zero-wasm-reference-store-group-relocation-scaffold.patch,0019-zero-wasm-reference-store-group.patch,0018-zero-wasm-linked-ref-array-store.patch,0017-zero-wasm-linked-ref-array-load-cache-integrity.patch,0016-zero-wasm-linked-ref-array-load.patch,0015-zero-wasm-linked-int-array-store.patch,0014-zero-wasm-linked-int-array-load.patch,0013-zero-wasm-linked-benchmark.patch,0012-zero-wasm-linked-invoke-throw-resume.patch,0011-zero-wasm-linked-idiv-resume.patch,0010-zero-wasm-linked-virtual-guard.patch,0009-zero-wasm-linked-class-init-bail.patch,0008-zero-wasm-linked-alloc-bail.patch,0007-zero-wasm-linked-oop-store.patch,0006-zero-wasm-linked-group.patch,0005-zero-wasm-baseline.patch,0004-zero-wasm-jit.patch,0003-zero-switch-dispatch-on-wasm.patch,0001-openjdk25-wasm32-emscripten-zero.patch" ] \
  || reject "prepare_jdk reverse patch order is not newest-first"
component_reverse=$(sed -n '/^    jdk)/,/^      ;;/p' "$SETUP" |
  sed -n 's#.*"\$HERE/patches/\([^"]*\)".*#\1#p' | paste -sd, -)
[ "$component_reverse" = "$prepare_reverse" ] \
  || reject "component_is_valid reverse patch order differs from prepare_jdk"
rg -q 'lockf -s -t 0 9' "$SETUP" || reject "kernel-backed setup lock missing"
rg -q 'MARKER=.*\.setup-transaction' "$SETUP" || reject "transaction marker missing"
rg -q 'recover_transaction' "$SETUP" || reject "transaction recovery missing"
rg -q 'canonical_directory' "$SETUP" || reject "canonical transaction path validation missing"
rg -q 'transaction_layout_is_safe' "$SETUP" || reject "transaction layout validation missing"
rg -q 'MCWEB_SETUP_TEST_MODE' "$SETUP" || reject "local mock provider missing"
! rg -q 'git clone.*[[:space:]]emsdk$' "$SETUP" || reject "emsdk clone writes directly to final"
! rg -q 'git clone.*[[:space:]]jdk25$' "$SETUP" || reject "JDK clone writes directly to final"
! rg -q 'git clone.*[[:space:]]libffi-upstream$' "$SETUP" || reject "libffi clone writes directly to final"
! rg -q 'rm -rf "\$EMSDK_FINAL"|rm -rf "\$JDK_FINAL"|rm -rf "\$LIBFFI_FINAL"' "$SETUP" \
  || reject "existing final tree is destructively removed"
rg -q 'component_backup|backup-\$1' "$SETUP" \
  || reject "transaction backups are not named"

expect_failure() {
  if "$@" >/dev/null 2>&1; then
    reject "expected failure succeeded: $*"
  fi
}

assert_complete() {
  work=$1
  [ -f "$work/emsdk/upstream/bin/clang" ] || reject "emsdk was not fully published"
  [ -f "$work/emsdk/emsdk_env.sh" ] || reject "emsdk environment was not published"
  [ -f "$work/emsdk/.mock-env-valid" ] || reject "emsdk environment validity was not published"
  [ -f "$work/jdk25/.mock-patched.0006-zero-wasm-linked-group.patch" ] \
    || reject "JDK patch stack was not published"
  [ -f "$work/jdk25/.mock-patched.0007-zero-wasm-linked-oop-store.patch" ] \
    || reject "JDK oop-store patch was not published"
  [ -f "$work/jdk25/.mock-patched.0008-zero-wasm-linked-alloc-bail.patch" ] \
    || reject "JDK allocation-bail patch was not published"
  [ -f "$work/jdk25/.mock-patched.0009-zero-wasm-linked-class-init-bail.patch" ] \
    || reject "JDK class-init patch was not published"
  [ -f "$work/jdk25/.mock-patched.0010-zero-wasm-linked-virtual-guard.patch" ] \
    || reject "JDK virtual-guard patch was not published"
  [ -f "$work/jdk25/.mock-patched.0011-zero-wasm-linked-idiv-resume.patch" ] \
    || reject "JDK idiv-resume patch was not published"
  [ -f "$work/jdk25/.mock-patched.0012-zero-wasm-linked-invoke-throw-resume.patch" ] \
    || reject "JDK invoke-throw-resume patch was not published"
  [ -f "$work/jdk25/.mock-patched.0013-zero-wasm-linked-benchmark.patch" ] \
    || reject "JDK benchmark patch was not published"
  [ -f "$work/jdk25/.mock-patched.0014-zero-wasm-linked-int-array-load.patch" ] \
    || reject "JDK int-array patch was not published"
  [ -f "$work/jdk25/.mock-patched.0015-zero-wasm-linked-int-array-store.patch" ] \
    || reject "JDK int-array-store patch was not published"
  [ -f "$work/jdk25/.mock-patched.0016-zero-wasm-linked-ref-array-load.patch" ] \
    || reject "JDK reference-array-load patch was not published"
  [ -f "$work/jdk25/.mock-patched.0017-zero-wasm-linked-ref-array-load-cache-integrity.patch" ] \
    || reject "JDK reference-array-load cache-integrity patch was not published"
  [ -f "$work/jdk25/.mock-patched.0018-zero-wasm-linked-ref-array-store.patch" ] \
    || reject "JDK reference-array-store patch was not published"
  [ -f "$work/jdk25/.mock-patched.0019-zero-wasm-reference-store-group.patch" ] \
    || reject "JDK reference-store-group patch was not published"
  [ -f "$work/jdk25/.mock-patched.0020-zero-wasm-reference-store-group-relocation-scaffold.patch" ] \
    || reject "JDK relocation scaffold patch was not published"
  [ -f "$work/libffi-upstream/.mock-patched.0002-libffi-wasm32-unaligned-64bit.patch" ] \
    || reject "libffi patch was not published"
  [ ! -e "$work/.setup-transaction" ] || reject "transaction marker remains after commit"
}

# A failed emsdk install leaves no final and no recoverable half-install. A
# later invocation retries from a new owned stage and completes.
before_commit="$TEST_ROOT/before-commit"
mkdir -p "$before_commit"
expect_failure env MCWEB_SETUP_WORK="$before_commit" MCWEB_SETUP_TEST_MODE=1 \
  MCWEB_SETUP_MOCK_FAIL_EMSDK_INSTALL=1 "$SETUP"
[ ! -e "$before_commit/emsdk" ] || reject "failed emsdk stage leaked into final"
[ ! -e "$before_commit/jdk25" ] || reject "JDK published before emsdk preparation completed"
[ ! -e "$before_commit/.setup-transaction" ] || reject "pre-commit failure left an unsafe marker"
env MCWEB_SETUP_WORK="$before_commit" MCWEB_SETUP_TEST_MODE=1 "$SETUP" >/dev/null
assert_complete "$before_commit"

# The newest runtime patch is also transactional: a failure while applying it
# publishes no partial JDK, and a clean retry applies the complete stack.
latest_patch_failure="$TEST_ROOT/fail-0020"
mkdir -p "$latest_patch_failure"
expect_failure env MCWEB_SETUP_WORK="$latest_patch_failure" MCWEB_SETUP_TEST_MODE=1 \
  MCWEB_SETUP_FAIL_PATCH=0020-zero-wasm-reference-store-group-relocation-scaffold.patch "$SETUP"
[ ! -e "$latest_patch_failure/jdk25" ] || reject "0020 failure published a partial JDK"
env MCWEB_SETUP_WORK="$latest_patch_failure" MCWEB_SETUP_TEST_MODE=1 "$SETUP" >/dev/null
assert_complete "$latest_patch_failure"

# A structurally complete but environment-invalid emsdk is not preserved as
# valid. Failed activation leaves it untouched; retry stages a valid emsdk and
# retains the old tree as a backup.
env_invalid="$TEST_ROOT/env-invalid"
mkdir -p "$env_invalid"
env MCWEB_SETUP_WORK="$env_invalid" MCWEB_SETUP_TEST_MODE=1 "$SETUP" >/dev/null
rm -f "$env_invalid/emsdk/.mock-env-valid"
printf '%s\n' old-environment-invalid > "$env_invalid/emsdk/.old-environment-invalid"
expect_failure env MCWEB_SETUP_WORK="$env_invalid" MCWEB_SETUP_TEST_MODE=1 \
  MCWEB_SETUP_MOCK_FAIL_EMSDK_ACTIVATE=1 "$SETUP"
[ -f "$env_invalid/emsdk/.old-environment-invalid" ] \
  || reject "environment-invalid emsdk was not preserved after failed activation"
[ ! -e "$env_invalid/.setup-transaction" ] || reject "failed activation left an unsafe marker"
env MCWEB_SETUP_WORK="$env_invalid" MCWEB_SETUP_TEST_MODE=1 "$SETUP" >/dev/null
assert_complete "$env_invalid"
old_emsdk_backup=$(find "$env_invalid" -type f -path '*/backup-emsdk/.old-environment-invalid' -print -quit)
[ -n "$old_emsdk_backup" ] || reject "environment-invalid emsdk was not backed up on retry"

# If interruption happens immediately after the marker is atomically written,
# cleanup must preserve that marker and its owned stages for recovery.
prepared_marker="$TEST_ROOT/prepared-marker"
mkdir -p "$prepared_marker"
expect_failure env MCWEB_SETUP_WORK="$prepared_marker" MCWEB_SETUP_TEST_MODE=1 \
  MCWEB_SETUP_FAIL_COMMIT_AT=after-prepared-marker "$SETUP"
[ -f "$prepared_marker/.setup-transaction" ] || reject "prepared marker was discarded"
txn_dir=$(sed -n 's/^txndir=//p' "$prepared_marker/.setup-transaction")
[ -f "$txn_dir/stage-emsdk/emsdk" ] || reject "prepared emsdk stage was discarded"
env MCWEB_SETUP_WORK="$prepared_marker" MCWEB_SETUP_TEST_MODE=1 "$SETUP" >/dev/null
assert_complete "$prepared_marker"

# Fail after the first two sequential renames. The marker and the remaining
# stage must survive; retry completes it without recloning or losing state.
among_commits="$TEST_ROOT/among-commits"
mkdir -p "$among_commits"
expect_failure env MCWEB_SETUP_WORK="$among_commits" MCWEB_SETUP_TEST_MODE=1 \
  MCWEB_SETUP_FAIL_COMMIT_AT=after-jdk-install "$SETUP"
[ -f "$among_commits/.setup-transaction" ] || reject "commit interruption lost marker"
[ -f "$among_commits/emsdk/upstream/bin/clang" ] || reject "first published component missing"
[ -f "$among_commits/jdk25/.mock-patched.0008-zero-wasm-linked-alloc-bail.patch" ] \
  || reject "second published component missing"
[ -f "$among_commits/jdk25/.mock-patched.0009-zero-wasm-linked-class-init-bail.patch" ] \
  || reject "class-init patch was not published"
[ -f "$among_commits/jdk25/.mock-patched.0010-zero-wasm-linked-virtual-guard.patch" ] \
  || reject "virtual-guard patch was not published"
  [ -f "$among_commits/jdk25/.mock-patched.0011-zero-wasm-linked-idiv-resume.patch" ] \
    || reject "idiv-resume patch was not published"
  [ -f "$among_commits/jdk25/.mock-patched.0012-zero-wasm-linked-invoke-throw-resume.patch" ] \
    || reject "invoke-throw-resume patch was not published"
  [ -f "$among_commits/jdk25/.mock-patched.0013-zero-wasm-linked-benchmark.patch" ] \
    || reject "benchmark patch was not published"
  [ -f "$among_commits/jdk25/.mock-patched.0014-zero-wasm-linked-int-array-load.patch" ] \
    || reject "int-array patch was not published"
  [ -f "$among_commits/jdk25/.mock-patched.0015-zero-wasm-linked-int-array-store.patch" ] \
    || reject "int-array-store patch was not published"
  [ -f "$among_commits/jdk25/.mock-patched.0016-zero-wasm-linked-ref-array-load.patch" ] \
    || reject "reference-array-load patch was not published"
  [ -f "$among_commits/jdk25/.mock-patched.0017-zero-wasm-linked-ref-array-load-cache-integrity.patch" ] \
    || reject "reference-array-load cache-integrity patch was not published"
  [ -f "$among_commits/jdk25/.mock-patched.0018-zero-wasm-linked-ref-array-store.patch" ] \
    || reject "reference-array-store patch was not published"
  [ -f "$among_commits/jdk25/.mock-patched.0019-zero-wasm-reference-store-group.patch" ] \
    || reject "reference-store-group patch was not published"
  [ -f "$among_commits/jdk25/.mock-patched.0020-zero-wasm-reference-store-group-relocation-scaffold.patch" ] \
    || reject "relocation scaffold patch was not published"
[ ! -e "$among_commits/libffi-upstream" ] || reject "third component published past injected failure"
txn_dir=$(sed -n 's/^txndir=//p' "$among_commits/.setup-transaction")
[ -f "$txn_dir/stage-libffi/configure" ] || reject "remaining staged component was lost"
env MCWEB_SETUP_WORK="$among_commits" MCWEB_SETUP_TEST_MODE=1 "$SETUP" >/dev/null
assert_complete "$among_commits"

# Invalid user trees are moved to transaction-local backups, never removed.
# The backup remains available after a successful retry.
backups="$TEST_ROOT/backups"
mkdir -p "$backups/emsdk" "$backups/jdk25" "$backups/libffi-upstream"
printf '%s\n' old-emsdk > "$backups/emsdk/old"
printf '%s\n' old-jdk > "$backups/jdk25/old"
printf '%s\n' old-libffi > "$backups/libffi-upstream/old"
expect_failure env MCWEB_SETUP_WORK="$backups" MCWEB_SETUP_TEST_MODE=1 \
  MCWEB_SETUP_FAIL_COMMIT_AT=after-emsdk-backup "$SETUP"
txn_dir=$(sed -n 's/^txndir=//p' "$backups/.setup-transaction")
[ -f "$txn_dir/backup-emsdk/old" ] || reject "invalid emsdk tree was not backed up"
[ -f "$backups/emsdk/old" ] && reject "invalid emsdk tree remained at final path"
env MCWEB_SETUP_WORK="$backups" MCWEB_SETUP_TEST_MODE=1 "$SETUP" >/dev/null
assert_complete "$backups"
[ -f "$txn_dir/backup-emsdk/old" ] || reject "emsdk backup was discarded"
[ -f "$txn_dir/backup-jdk/old" ] || reject "JDK backup was discarded"
[ -f "$txn_dir/backup-libffi/old" ] || reject "libffi backup was discarded"

file_backup="$TEST_ROOT/file-backup"
mkdir -p "$file_backup"
printf '%s\n' old-file-final > "$file_backup/emsdk"
env MCWEB_SETUP_WORK="$file_backup" MCWEB_SETUP_TEST_MODE=1 "$SETUP" >/dev/null
assert_complete "$file_backup"
old_file_backup=$(find "$file_backup" -type f -path '*/backup-emsdk' -print -quit)
[ -n "$old_file_backup" ] || reject "regular invalid final was not preserved as a backup"

# Tampered transaction paths fail closed before any source, rename, or cleanup.
# The external directory and staged payload must remain untouched.
symlink_txn="$TEST_ROOT/symlink-txn"
mkdir -p "$symlink_txn"
expect_failure env MCWEB_SETUP_WORK="$symlink_txn" MCWEB_SETUP_TEST_MODE=1 \
  MCWEB_SETUP_FAIL_COMMIT_AT=after-prepared-marker "$SETUP"
txn_dir=$(sed -n 's/^txndir=//p' "$symlink_txn/.setup-transaction")
external_txn=$(mktemp -d "$TEST_ROOT/external-txn.XXXXXX")
mv "$txn_dir" "$external_txn/real-txn"
ln -s "$external_txn/real-txn" "$txn_dir"
expect_failure env MCWEB_SETUP_WORK="$symlink_txn" MCWEB_SETUP_TEST_MODE=1 "$SETUP"
[ -L "$txn_dir" ] || reject "symlinked transaction directory was followed"
[ -f "$external_txn/real-txn/stage-emsdk/emsdk" ] \
  || reject "external transaction payload was mutated"
[ -f "$symlink_txn/.setup-transaction" ] || reject "tampered transaction marker was removed"
[ ! -e "$symlink_txn/emsdk" ] || reject "tampered transaction published a final tree"

symlink_stage="$TEST_ROOT/symlink-stage"
mkdir -p "$symlink_stage"
expect_failure env MCWEB_SETUP_WORK="$symlink_stage" MCWEB_SETUP_TEST_MODE=1 \
  MCWEB_SETUP_FAIL_COMMIT_AT=after-prepared-marker "$SETUP"
txn_dir=$(sed -n 's/^txndir=//p' "$symlink_stage/.setup-transaction")
external_stage=$(mktemp -d "$TEST_ROOT/external-stage.XXXXXX")
mv "$txn_dir/stage-emsdk" "$external_stage/real-stage"
ln -s "$external_stage/real-stage" "$txn_dir/stage-emsdk"
expect_failure env MCWEB_SETUP_WORK="$symlink_stage" MCWEB_SETUP_TEST_MODE=1 "$SETUP"
[ -L "$txn_dir/stage-emsdk" ] || reject "symlinked stage directory was followed"
[ -f "$external_stage/real-stage/emsdk" ] || reject "external stage payload was mutated"
[ -f "$symlink_stage/.setup-transaction" ] || reject "stage-tampered marker was removed"

symlink_backup="$TEST_ROOT/symlink-backup"
mkdir -p "$symlink_backup"
expect_failure env MCWEB_SETUP_WORK="$symlink_backup" MCWEB_SETUP_TEST_MODE=1 \
  MCWEB_SETUP_FAIL_COMMIT_AT=after-prepared-marker "$SETUP"
txn_dir=$(sed -n 's/^txndir=//p' "$symlink_backup/.setup-transaction")
external_backup=$(mktemp -d "$TEST_ROOT/external-backup.XXXXXX")
printf '%s\n' untouched > "$external_backup/payload"
ln -s "$external_backup" "$txn_dir/backup-emsdk"
expect_failure env MCWEB_SETUP_WORK="$symlink_backup" MCWEB_SETUP_TEST_MODE=1 "$SETUP"
[ -L "$txn_dir/backup-emsdk" ] || reject "symlinked backup directory was followed"
[ "$(sed -n '1p' "$external_backup/payload")" = untouched ] \
  || reject "external backup payload was mutated"
[ -f "$symlink_backup/.setup-transaction" ] || reject "backup-tampered marker was removed"

symlink_marker="$TEST_ROOT/symlink-marker"
mkdir -p "$symlink_marker"
external_marker=$(mktemp -d "$TEST_ROOT/external-marker.XXXXXX")
printf '%s\n' untouched > "$external_marker/marker"
ln -s "$external_marker/marker" "$symlink_marker/.setup-transaction"
expect_failure env MCWEB_SETUP_WORK="$symlink_marker" MCWEB_SETUP_TEST_MODE=1 "$SETUP"
[ -L "$symlink_marker/.setup-transaction" ] || reject "symlinked marker was followed"
[ "$(sed -n '1p' "$external_marker/marker")" = untouched ] \
  || reject "external marker payload was mutated"
[ ! -e "$symlink_marker/emsdk" ] || reject "symlinked marker allowed publication"

# A second clean run is idempotent: it does not create another transaction or
# replace valid trees. The persistent lock file itself is harmless; lockf uses
# the kernel lock, so an exited owner cannot leave a stale PID lock.
idempotent="$TEST_ROOT/idempotent"
mkdir -p "$idempotent"
env MCWEB_SETUP_WORK="$idempotent" MCWEB_SETUP_TEST_MODE=1 "$SETUP" >/dev/null
for component in emsdk jdk25 libffi-upstream; do
  sentinel="$idempotent/$component/.setup-idempotence-sentinel"
  printf 'stable-%s\n' "$component" > "$sentinel"
  stat -f '%i %m %z' "$sentinel" > "$TEST_ROOT/$component-idempotence-before"
done
find "$idempotent" -maxdepth 1 -type d -name '.setup-txn.*' -print | sort > "$TEST_ROOT/txn-before"
env MCWEB_SETUP_WORK="$idempotent" MCWEB_SETUP_TEST_MODE=1 "$SETUP" >/dev/null
find "$idempotent" -maxdepth 1 -type d -name '.setup-txn.*' -print | sort > "$TEST_ROOT/txn-after"
cmp -s "$TEST_ROOT/txn-before" "$TEST_ROOT/txn-after" || reject "idempotent run created a new transaction"
for component in emsdk jdk25 libffi-upstream; do
  sentinel="$idempotent/$component/.setup-idempotence-sentinel"
  [ -f "$sentinel" ] || reject "idempotent run replaced valid $component"
  expected="stable-$component"
  actual=$(sed -n '1p' "$sentinel")
  [ "$actual" = "$expected" ] || reject "idempotent run mutated $component content"
  stat -f '%i %m %z' "$sentinel" > "$TEST_ROOT/$component-idempotence-after"
  cmp -s "$TEST_ROOT/$component-idempotence-before" "$TEST_ROOT/$component-idempotence-after" \
    || reject "idempotent run changed $component identity or metadata"
done
assert_complete "$idempotent"

# Concurrent invocations serialize on the same lock. The second fails closed
# while the first holds it; the lock file remains but is not a PID authority.
concurrent="$TEST_ROOT/concurrent"
mkdir -p "$concurrent"
env MCWEB_SETUP_WORK="$concurrent" MCWEB_SETUP_TEST_MODE=1 MCWEB_SETUP_MOCK_SLEEP=2 \
  "$SETUP" > "$TEST_ROOT/concurrent-first.out" 2> "$TEST_ROOT/concurrent-first.err" &
first_pid=$!
sleep 1
set +e
env MCWEB_SETUP_WORK="$concurrent" MCWEB_SETUP_TEST_MODE=1 "$SETUP" \
  > "$TEST_ROOT/concurrent-second.out" 2> "$TEST_ROOT/concurrent-second.err"
second_rc=$?
set -e
[ "$second_rc" -ne 0 ] || reject "concurrent invocation was not rejected by lock"
wait "$first_pid" || reject "first concurrent setup failed"
assert_complete "$concurrent"

echo "ACCEPT setup transaction mock gate"
echo "staging=emsdk-install-activate-jdk-libffi"
echo "recovery=marker-backed-sequential-renames"
echo "emsdk-validity=structural-plus-environment"
echo "backups=transaction-local-preserved"
echo "symlink-safety=canonical-work-exact-transaction-dir"
echo "lock=kernel-lockf-no-pid-stale-break"
echo "failure-mocks=pre-commit,mid-commit,retry,idempotence,concurrency"
