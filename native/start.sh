#!/bin/sh
set -eu
relay_base=https://minecraft.wasm.click/relay/cli
case "$(uname -s)" in Darwin) relay_os=darwin;; Linux) relay_os=linux;; *) echo 'Use start.ps1 on Windows.' >&2; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) relay_arch=amd64;; arm64|aarch64) relay_arch=arm64;; *) echo 'Unsupported CPU. See the relay source for build instructions.' >&2; exit 1;; esac
relay_name=mcwc-relay-$relay_os-$relay_arch
relay_temp=$(mktemp -d)
trap 'rm -rf -- "$relay_temp"' EXIT
trap 'exit 130' HUP INT TERM
relay_download() {
 if command -v curl >/dev/null 2>&1; then
  curl --fail --location --silent --show-error --proto '=https' "$1" -o "$2"
 elif command -v wget >/dev/null 2>&1; then
  wget --https-only -q "$1" -O "$2"
 else
  echo 'curl or wget is needed to download the CLI.' >&2; exit 1
 fi
}
relay_download "$relay_base/SHA256SUMS" "$relay_temp/SHA256SUMS"
relay_expected=$(awk -v name="$relay_name" '$2 == name {print $1}' "$relay_temp/SHA256SUMS")
case "$relay_expected" in *[!0-9a-f]*|'') echo 'Invalid relay checksum.' >&2; exit 1;; esac
[ "$(printf %s "$relay_expected" | wc -c | tr -d ' ')" -eq 64 ] || { echo 'Invalid relay checksum length.' >&2; exit 1; }
echo 'Downloading the self-contained minecraft.wasm.click CLI (about 12 MB). No helper page or runtime installation.'
relay_download "$relay_base/$relay_name" "$relay_temp/mcwc-relay"
if command -v sha256sum >/dev/null 2>&1; then
 relay_actual=$(sha256sum "$relay_temp/mcwc-relay" | awk '{print $1}')
else
 relay_actual=$(shasum -a 256 "$relay_temp/mcwc-relay" | awk '{print $1}')
fi
[ "$relay_actual" = "$relay_expected" ] || { echo 'Relay checksum mismatch. Nothing was run.' >&2; exit 1; }
chmod 700 "$relay_temp/mcwc-relay"
# The script may be piped to sh; approval must read the terminal, not the pipe.
if [ ! -r /dev/tty ]; then echo 'Run this command in an interactive terminal to approve pairing.' >&2; exit 1; fi
"$relay_temp/mcwc-relay" </dev/tty
