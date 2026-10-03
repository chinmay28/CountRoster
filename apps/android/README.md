# CountRoster for Android

The Android app: the CountRoster web client in a WebView, served by an
**on-device engine** — the Go server's own code, running on the phone. Data
stays on the device by default; **Data → Sync** points the app at a
CountRoster server instead, sharing one dataset with every other synced
phone and every browser using that server. Design: [`MOBILE.md`](../../MOBILE.md).

```
MainActivity (WebView) ──http://127.0.0.1:<port>──> engine process ──> SQLite on the device
                                                       └── sync mode ──> https://your-server/api
```

## Build

```bash
scripts/build-android.sh                 # → app/build/outputs/apk/debug/app-debug.apk
scripts/build-android.sh assembleRelease testDebugUnitTest
```

Needs Node, Go, JDK 17+ and the Android SDK (`ANDROID_HOME`). No NDK — the
engine is pure Go. The script builds the web client with `--mode native`,
cross-compiles the engine into `app/src/main/jniLibs/<abi>/libcountroster_engine.so`
(arm64-v8a for phones; x86_64 for emulators and ChromeOS, plus a host-native
copy for the JVM tests), then runs Gradle with the calendar version. The
x86_64 engine is built with a patched SQLite syscall shim
([`server/cmd/engine/androidlibc`](../../server/cmd/engine/androidlibc/README.md)),
because Android's seccomp filter kills the legacy x86_64 syscalls the stock
one makes.
Gradle refuses to build if those binaries are missing.

Release signing reads `COUNTROSTER_KEYSTORE`, `COUNTROSTER_KEYSTORE_PASSWORD`,
`COUNTROSTER_KEY_ALIAS` and `COUNTROSTER_KEY_PASSWORD`; without them a release
build is unsigned.

## How the pieces fit

| Piece | Role |
|---|---|
| `engine/EngineCommand`, `ReadyLine`, `EngineProcess` | The launcher contract with `server/cmd/engine`: flags, the secret in the environment, the READY line, exit on stdin EOF. |
| `EngineHost` | Owns the engine process: starts it, restarts it on a timezone change, tells the UI when a new one is up. |
| `DnsWatcher` | Hands the engine the network's DNS servers — a cgo-free Go binary can't find them on Android. |
| `MainActivity` | The WebView, kept on the engine's origin; file picking, edge-to-edge insets, back navigation. |
| `bridge/*` | `window.CountRosterNative` (see `apps/web/src/lib/platform.ts`): saving files, pinning quick-log shortcuts. |
| `CloudBackupWorker` | An hourly WorkManager tick so scheduled cloud backups run while the app is closed. |

## Tests

- `app/src/test` — JVM unit tests, including `RealEngineTest`, which drives
  the real engine (a host-native build) through the Kotlin launcher.
- `app/src/androidTest` — on a device or emulator: the engine starts from
  the native library directory, stamps the device's timezone, resolves
  hostnames, and the WebView renders the app.

CI runs both (`.github/workflows/android.yml`).
