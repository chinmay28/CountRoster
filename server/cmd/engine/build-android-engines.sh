#!/usr/bin/env bash
# Build the engine for every Android ABI the app ships, into an Android
# jniLibs layout:
#
#   build-android-engines.sh <jniLibs dir> [go -ldflags value]
#
#   <dir>/arm64-v8a/libcountroster_engine.so   phones
#   <dir>/x86_64/libcountroster_engine.so      emulators, ChromeOS
#
# Both are static linux binaries (CGO_ENABLED=0, no PT_INTERP): Android's
# kernel runs them directly from the app's native library directory, with no
# dependency on its dynamic linker. x86_64 is built with modernc's syscall
# shim patched (androidlibc/), because Android's seccomp filter kills the
# legacy syscalls the stock one makes there; arm64 has none to patch.
# scripts/build-android.sh and CI both build through here, so what CI tests
# under Android's seccomp policy is what ships.
set -euo pipefail

out="${1:?usage: build-android-engines.sh <jniLibs dir> [ldflags]}"
ldflags="${2:--s -w}"
here="$(cd "$(dirname "$0")" && pwd)"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac

mkdir -p "$out/arm64-v8a" "$out/x86_64"
echo "==> engine for arm64-v8a (static linux/arm64)"
(cd "$here/../.." && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath \
  -ldflags "$ldflags" -o "$out/arm64-v8a/libcountroster_engine.so" ./cmd/engine)
echo "==> engine for x86_64 (static linux/amd64, seccomp-safe)"
"$here/androidlibc/build-amd64.sh" "$out/x86_64/libcountroster_engine.so" -ldflags "$ldflags"
