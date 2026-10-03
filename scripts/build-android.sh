#!/usr/bin/env bash
# Build the CountRoster Android app.
#
#   scripts/build-android.sh [gradle tasks…]      (default: assembleDebug)
#
# Three stages, each feeding the next:
#
#   1. the web client, built with `--mode native` (no service worker), copied
#      into server/cmd/engine/webdist/ for embedding;
#   2. the Go engine, cross-compiled per ABI into the app's jniLibs/ as
#      libcountroster_engine.so — the app execs it from its native library
#      directory, the one place Android lets an app run a binary it ships;
#   3. Gradle, with the calendar version passed in (scripts/version.mjs).
#
# Needs Node, Go, a JDK 17+, and the Android SDK (ANDROID_HOME). No NDK: the
# engine is pure Go (CGO_ENABLED=0), like the server.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

tasks=("$@")
[ ${#tasks[@]} -gt 0 ] || tasks=(assembleDebug)

version="$(node scripts/version.mjs)"
patch="$(node scripts/version.mjs --patch)"
echo "==> CountRoster $version for Android"

echo "==> web client (--mode native)"
npm run build --workspace @countroster/core >/dev/null
(cd apps/web && npx tsc --noEmit && npx vite build --mode native --emptyOutDir --outDir dist-native >/dev/null)
find server/cmd/engine/webdist -mindepth 1 ! -name README.txt -exec rm -rf {} +
cp -r apps/web/dist-native/. server/cmd/engine/webdist/

# ABI → Go target. arm64 phones get a real android/arm64 build. Go can only
# build android/amd64 with cgo, so the emulator's x86_64 gets a static
# linux/amd64 binary instead, which Android's kernel runs just the same (the
# engine reads nothing from the OS that differs: zone data is embedded and
# DNS servers come from the app).
# (A plain list rather than an associative array: macOS still ships bash 3.)
jni="apps/android/app/src/main/jniLibs"
for target in arm64-v8a:android:arm64 x86_64:linux:amd64; do
  IFS=: read -r abi goos goarch <<<"$target"
  out="$jni/$abi/libcountroster_engine.so"
  echo "==> engine for $abi ($goos/$goarch)"
  mkdir -p "$jni/$abi"
  (cd server && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build \
    -trimpath \
    -ldflags "-s -w -X github.com/chinmay28/countroster/server/internal/version.Patch=$patch" \
    -o "../$out" ./cmd/engine)
done

echo "==> gradle ${tasks[*]}"
cd apps/android
./gradlew --no-daemon \
  -Pcountroster.versionName="${version#v}" \
  -Pcountroster.versionCode="$patch" \
  "${tasks[@]}"

find app/build/outputs -name '*.apk' -newer "$root/scripts/build-android.sh" -print 2>/dev/null | sed 's/^/==> built apps\/android\//' || true
