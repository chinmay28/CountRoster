#!/usr/bin/env bash
# Build the engine for Android x86_64 (linux/amd64, static) with modernc's
# syscall shim patched — see README.md. Usage:
#
#   build-amd64.sh <output binary> [extra go build flags…]
#
# Go won't overlay files in the module cache, so this builds against a
# temporary copy of modernc.org/libc with syscall_musl.go swapped, wired in
# through -modfile and a replace directive; the repository's go.mod is never
# touched. It refuses to build if the upstream file isn't the one the patch
# was derived from (BASE_SHA256), so a modernc upgrade can't silently drop or
# misapply the fix.
set -euo pipefail

out="${1:?usage: build-amd64.sh <output> [go build flags…]}"
shift
here="$(cd "$(dirname "$0")" && pwd)"
server="$(cd "$here/../../.." && pwd)"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac

cd "$server"
libc="$(go list -m -f '{{.Dir}}' modernc.org/libc)"
want="$(cut -d' ' -f1 "$here/BASE_SHA256")"
have="$(sha256sum "$libc/syscall_musl.go" | cut -d' ' -f1)"
if [ "$want" != "$have" ]; then
  echo "modernc.org/libc's syscall_musl.go changed ($libc)." >&2
  echo "Re-derive $here/syscall_musl.go.overlay from it, then update BASE_SHA256." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"' EXIT
cp -r "$libc" "$work/libc"
chmod -R u+w "$work/libc"
cp "$here/syscall_musl.go.overlay" "$work/libc/syscall_musl.go"

cp go.mod "$work/go.mod"
cp go.sum "$work/go.sum"
echo "replace modernc.org/libc => $work/libc" >> "$work/go.mod"

CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -modfile="$work/go.mod" -trimpath "$@" -o "$out" ./cmd/engine
