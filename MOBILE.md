# CountRoster on mobile — design

> Status: **Android implemented** (`apps/android`). iOS: designed for (§10),
> not built. This document describes the design as built; where the original
> proposal changed during implementation, the change and its reason are noted.

## 1. What it is

A native Android app that is **local-first by default**: the database lives
on the phone, and the app works forever with no server and no network. A
**Sync** section on the Data page points the app at a CountRoster server
instead. That is exactly the PWA's behaviour: one SQLite file on the server,
read and written by every synced phone and every browser using it.

Goals, all met:

- **No new domain logic.** The Go core runs *on the phone*. No Kotlin port,
  no Room schema, no third implementation to keep in lockstep.
- **No UI fork.** The app renders the same React client. It can't tell local
  mode from sync mode.
- **Frozen contracts stay frozen.** REST shapes, schema and backup format are
  unchanged. The one server change is additive (`api_level`, §8.3).
- Small, tested Go components; a Kotlin shell thin enough to have little in it.

Non-goals for v1: offline writes while synced (§11), merging two non-empty
datasets (§6.3), auth (sync inherits the server's trusted-network model).

## 2. A server in your pocket

```
┌──────────────────────────── Android app ─────────────────────────────┐
│  Kotlin shell: MainActivity (WebView) · EngineHost · DnsWatcher ·    │
│                bridge · CloudBackupWorker                            │
│        │ exec + stdin pipe              │ http://127.0.0.1:<port>    │
│        ▼                                ▼                            │
│  engine process (Go, libcountroster_engine.so) ◄── WebView           │
│     ├─ /            embedded web client (vite --mode native)         │
│     ├─ /_engine/*   mode, sync, network, cloud tick                  │
│     └─ /api/*  ──►  local: core → SQLite in the app's files dir      │
│                     sync:  reverse proxy ──────────────────────────────► https://server/api
└──────────────────────────────────────────────────────────────────────┘
```

The phone runs the **same `api.New(...)` handler** the server binary does
(both build it through `internal/stack`). "Sync" only means the engine swaps
what sits behind `/api`: the local core, or a reverse proxy. The WebView
always talks to one origin, so there's no CORS and no client configuration.

### 2.1 Packaging: a child process, not gomobile (changed in implementation)

The proposal used `gomobile bind` to link the engine into the app process.
The implementation instead ships it as a **separate executable**, a
`CGO_ENABLED=0` Go binary packaged as `jniLibs/<abi>/libcountroster_engine.so`
and exec'd from the app's native library directory. That directory is the one
place Android lets an app execute a binary it ships, and Syncthing-Android
runs its Go binary the same way.

Why:

- **The build stays `go build`.** No NDK and no gomobile toolchain. It is
  reproducible, works in any container, and keeps the static-binary rule.
- **The contract is small and testable on a laptop:** flags, a secret in the
  environment, a READY line on stdout, and exit on stdin EOF
  (`server/cmd/engine/main.go`). JVM tests drive the real engine through the
  real Kotlin launcher (`RealEngineTest`).
- **Lifetime is tied to the app for free.** The engine exits when its stdin
  pipe closes, so it can't outlive the app process however that dies.

The ABIs are `arm64-v8a` (a real `android/arm64` build) and `x86_64` for
emulators. Go can only build `android/amd64` with cgo, so the x86_64 engine is
a static `linux/amd64` binary, which Android's kernel runs the same way.

The cost of a cgo-free binary on Android is two OS gaps, both closed (§9).

## 3. Components

### 3.1 Go

| Package | Role |
|---|---|
| `internal/stack` | The composition root (storage → migrate → core → backup → cloud → `/api`), shared by the server binary and the engine. |
| `internal/web` | The SPA/quick-log handler, moved out of `package main`. |
| `internal/engine` | The on-device server, as small pieces: `ConfigStore` (mode in `engine.json`, never in SQLite), `Gate` (§5), `DNS` (§9.2), `NewProxy`, `Remote` (probe/export/import against a server), `SafetyStore` (§6), and `Engine`, which composes them and serves `/_engine/*`. |
| `cmd/engine` | The executable and its launcher contract; sets `time.Local` from `--tz` and embeds tzdata. |

### 3.2 Kotlin (`apps/android`)

| Class | Role |
|---|---|
| `engine/EngineCommand`, `ReadyLine`, `EngineProcess`, `EngineClient` | The launcher contract, plus the shell's own bearer-authenticated calls. Pure JVM, unit tested. |
| `EngineHost` | Owns the engine process. It starts it on first use, restarts it on a timezone change or after a crash, and notifies the UI of each new port and secret. |
| `MainActivity` | The WebView, kept on the engine's origin (other links open in the browser). Also handles file picking, edge-to-edge insets and back. |
| `bridge/*` | `window.CountRosterNative` (§4) and the quick-log shortcuts. |
| `DnsWatcher` | Pushes the default network's DNS servers to the engine. |
| `CloudBackupWorker` | An hourly WorkManager tick, so scheduled cloud backups run with the app closed. |

### 3.3 Web client

- **`lib/platform.ts`**, the native bridge (§4).
- **`components/SyncSettings`** on the Data page, rendered only when
  `/_engine/status` answers (the PWA gets nothing, so it shows nothing).
- **`EngineContext`**, which supplies the footer that says where the data
  lives, and the restore copy, which says "this device" in local mode.
- **`PinShortcutButton`**: "Add to home screen" for a tracker's quick-log
  screen.
- **`useAsync` refresh on focus** (§7.2) and a connectivity re-check on focus.
- **`vite build --mode native`**: the embedded bundle, without the service
  worker or manifest.

## 4. The native bridge (platform-neutral by design)

There is one global, `window.CountRosterNative`, with two methods:

- `capabilities(): string` returns a synchronous JSON array, so the first
  paint knows what to render.
- `postMessage(json)` sends `{"id","method","args"}`. The host answers with
  `window.__countrosterNativeReply(id, ok, value)`.

Requests are Promise-based even though Android's `@JavascriptInterface` could
answer synchronously. iOS message handlers are async, so an async contract
lets one client serve both hosts. Methods: `saveUrl(path, suggestedName)`
(the shell downloads from the engine and writes through the system file
picker; a WebView can't save blobs) and `pinShortcut(id, name, color)`.

## 5. Loopback security

A loopback port is reachable by **every app on the phone**. The shell mints a
256-bit secret per engine launch and passes it in the engine's environment.
It plants the secret as an `HttpOnly; SameSite=Strict` cookie in its own
WebView's cookie jar and uses it as a bearer token for its own calls. The
engine's `Gate` refuses anything else with 403. The engine binds `127.0.0.1`
only, and the proxy strips the cookie and `Authorization` header, so a server
never sees the secret.

*(Changed in implementation: the proposal's one-time boot URL became a cookie
set directly through `CookieManager`. It's simpler and survives activity
recreation.)*

## 6. Mode switching and data handoff

The local database is **never deleted** by a switch; it goes dormant. Every
step that overwrites data takes a **safety bundle** first (`SafetyStore`, the
last 5 are kept). They are listed on the Data page and can be downloaded.
Every data step runs *before* the mode flips, so a failure leaves the device
as it was.

### 6.1 Turning sync on (`POST /_engine/sync/enable`)

The engine probes the server first: is it CountRoster, at what `api_level`,
and is it empty (no trackers, the backup import's own test)?

| Phone | Server | Choices (default first) |
|---|---|---|
| empty | any | just connect (`use_server`) |
| has data | empty | `move_to_server` (upload; the server's own import refuses to overwrite) · `use_server` (start fresh; the phone's data is backed up and set aside) |
| has data | has data | `use_server` · `replace_server` (the server is backed up onto the phone first; the UI makes you confirm) |

### 6.2 Turning sync off (`POST /_engine/sync/disable`)

The choices are `copy_from_server` (the default: the phone carries on with
the server's data, offline) and `use_local` (back to the dormant data, which
also works when the server is gone).

### 6.3 No merge in v1

IDs are UUIDv7, so a union merge is technically cheap. But a phone "Water"
tracker and a server "Water" tracker would become two trackers, and the
unique keys (`category_rules.merchant`, `card_transactions.dedupe_key`) need
conflict rules. That's a product decision plus an additive endpoint; it's a
clean follow-up.

## 7. Sync across PWA and Android

```
 PWA (any browser)   ─┐
 Android app (synced) ─┼──HTTP /api──► CountRoster server ──► one SQLite file
 Android app (synced) ─┘
```

### 7.1 Why it holds without extra machinery

- All durable state is in the database; the web client keeps nothing in
  browser storage. So order, fields, groups, transactions and cloud backup
  settings are all shared.
- The proxy forwards `/api` verbatim: one wire contract.
- In sync mode, bucketing uses the server's timezone, as it does for the PWA.
  In local mode it uses the phone's.
- Quick-log shortcuts and PWA home-screen icons both point at tracker ids.

### 7.2 Freshness

Clients don't subscribe to changes, so `useAsync` reloads when the page
becomes visible again (at most every 5 s). That reload is **silent**: the
current data stays on screen until the new data arrives, a failed refresh
keeps it, and a half-typed form is never blanked. In the app,
`WebView.onPause/onResume` drive the page's `visibilityState`. Live push
(SSE) is a possible later addition.

### 7.3 Version skew

The PWA is always its server's version. The app carries its own UI, so it
gates on `api_level` (§8.3). **Upgrade the server first.**

### 7.4 Tested

`TestSyncAcrossDevicesAndThePWA` runs two engines and a direct `/api` client
against one real server, and each client reads every other client's writes. A
browser-driven run of the built engine against a built server covered the
whole flow: local data, move to the server, a PWA write appearing in the app,
then turning sync off with a copy.

### 7.5 Not supported: a phone as the hub

Sync needs the server binary running somewhere. Exposing a phone's engine to
the network would undo §5.

## 8. Contracts

### 8.1 Unchanged

REST shapes, SQL schema, migrations, the backup bundle and its checksums. A
phone's database is the same file a server keeps.

### 8.2 Engine-only routes (never on a server, never proxied)

```
GET  /_engine/status          → {mode, remote_url, remote_version, remote_api_level,
                                 remote_compatible, local_empty, version, api_level, safety_bundles}
POST /_engine/sync/probe      {url}           → {url, version, api_level, empty, compatible, local_empty}
POST /_engine/sync/enable     {url, strategy} → status   (400 · 409 · 502)
POST /_engine/sync/disable    {strategy}      → status   (400 · 409 · 502)
GET  /_engine/safety/{name}   → the bundle
PUT  /_engine/network         {dns_servers}   → 204      (the shell)
POST /_engine/cloud/tick      → 204                      (the background job)
```

These follow the `/api` conventions and are pinned by `internal/engine` tests.

### 8.3 `api_level`

`GET /api/health` gains `api_level` (additive; a server without it is level
0). The engine refuses to enable sync with a server below its own level. If a
synced server is later found to be older, reads keep working and **writes are
refused with 409**. Validators ignore unknown keys, so an older server would
otherwise silently drop fields it doesn't know. Bump `api.APILevel` whenever
the API gains something a client may send or depend on.

## 9. Android-specific gaps a cgo-free Go binary needs closed

### 9.1 Timezone

On Android, Go's `initLocal` sets **UTC** and ignores `TZ`, which would bucket
every day in UTC and stamp `+00:00`. The shell passes
`TimeZone.getDefault().id` as `--tz`. The engine sets `time.Local` before
serving and embeds `time/tzdata`, because newer Android keeps its zone data
in an APEX path Go doesn't search. A zone change restarts the engine, rather
than swapping `time.Local` under running requests.

### 9.2 DNS

Without cgo, Go's resolver reads `/etc/resolv.conf`, which Android doesn't
have, and falls back to `127.0.0.1:53` (golang/go#10714). `DnsWatcher` reports
the default network's DNS servers, including a VPN's, such as Tailscale's
`100.100.100.100`. They reach the engine as `--dns` at launch and through
`PUT /_engine/network` on change, and `engine.DNS` becomes Go's default
resolver for the whole process, cloud backup included.

### 9.3 TLS and cleartext

Go reads Android's system CA directory. User-installed CAs aren't trusted,
which suits a tailnet's Let's Encrypt certificates. The WebView has a
cleartext exception for `127.0.0.1` only. The *engine* talks to the server
outside Android's network security policy, so a plain-http LAN server works
without weakening the app's policy.

## 10. iOS

The design carries over. The engine, the UI, the bridge contract, sync and
`api_level` are all reused unchanged. What differs:

| Concern | iOS |
|---|---|
| Packaging | iOS can't spawn processes, so `gomobile bind -target=ios` links `internal/engine` in-process through a thin façade. Only the launcher differs, and the HTTP contract with the shell is the same. |
| WebView | `WKWebView`. Its ATS rules only see `127.0.0.1` (one `NSAllowsLocalNetworking` key); the Go proxy reaches the server outside ATS. |
| Suspension | iOS can reclaim a suspended app's sockets. On resume, re-check the listener and restart on a new port if needed; the UI holds no origin-bound state. |
| Bridge | A document-start `WKUserScript` defines the same `window.CountRosterNative` over a message handler. |
| Shortcuts | iOS has no pinned shortcuts, so `capabilities()` omits `pinShortcut`. Home-screen quick actions, App Intents and widgets are later options; widgets need the DB in an App Group. |
| Background | `BGTaskScheduler` → the same cloud tick. |
| Distribution | The App Store's terms vs. the AGPL. The maintainer can ship under the CLA's relicensing rights; forks can't. App Review rule 4.2 (wrapper apps) should pass, because the app runs offline on its own engine. |

## 11. Later: true offline sync

Writing while synced but offline needs replication. That means tombstones (entries,
notes and groups are hard-deleted), per-row clocks (an HLC, not `updated_at`),
conflict rules for the unique keys, and handling for multi-row operations.
That is a schema migration, a TS mirror and a backup-format question. The
engine's mode switch is where a "local DB + background sync" delegate would
slot in.

## 12. Decisions taken

These were open in the proposal. Implementation went with the
recommendations; any can be revisited.

1. Sync is "connect to a server" (online-only while synced).
2. No merge when both sides have data.
3. Distribution: a debug APK from CI for now. Release signing reads keystore
   secrets (`apps/android/README.md`). Store listings are not done yet.
4. Sync settings live on the React Data page.
5. minSdk 26, targetSdk 36.
6. A server is required for sync; a phone can't act as the hub.
7. *(New)* `allowBackup="false"`: the data is health-adjacent and the
   database is a live SQLite file. The app's own backups are the way out.
