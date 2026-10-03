# CountRoster for Android — Design

> Status: **proposal, awaiting sign-off.** Nothing here is implemented yet.

## 1. What we're building

A native-installable Android app (`apps/android`) that is **local-first by
default** — the database lives on the phone, the app works forever with no
server and no network — with a **"Sync with a server"** option in settings.
Turning sync on makes the phone a client of a CountRoster server, which is
exactly today's PWA behaviour: one SQLite file on the server, every device
reading and writing it. **Synced Android apps and PWAs (in any browser) share
that one dataset** — they are peers of the same server (§7).

### Goals

- **Zero new domain logic.** The Go core (`server/internal/core`) runs *on the
  phone* in local mode. No Kotlin port, no Room schema, no third
  implementation to keep in lockstep.
- **Zero UI fork.** The app renders the existing React PWA bundle. The UI
  can't tell local mode from sync mode.
- **Frozen contracts stay frozen.** REST shapes, schema, backup format: no
  changes. The only additions are additive (§8.3).
- Small, independently tested Go components with narrow APIs; the Kotlin
  shell stays thin enough that there's little in it *to* test.

### Non-goals (v1)

- Offline writes while in sync mode (see §10 — a separate, later design).
- Merging two non-empty datasets when sync is turned on (§6.3).
- iOS. (The architecture would carry over, but it's not in scope.)
- Auth. Sync mode inherits the server's trusted-network model (LAN /
  Tailscale / VPN).

## 2. The core idea: a server in your pocket

```
┌──────────────────────── Android app (apps/android) ────────────────────────┐
│                                                                            │
│  Kotlin shell ─ MainActivity + WebView, file save/open, shortcuts,         │
│       │         lifecycle, timezone, WorkManager                           │
│       │                                                                    │
│       ▼  loads http://127.0.0.1:<random port>/                             │
│  WebView ──────► Go engine (gomobile AAR, in-process)                      │
│                   ├─ /            embedded PWA bundle (same as release)    │
│                   ├─ /_engine/*   mode + sync settings (never proxied)     │
│                   └─ /api/*  ──►  ┌ local mode: api.New(core) → SQLite      │
│                                   │             in the app's files dir     │
│                                   └ sync mode:  reverse proxy ────────────────► https://your-server/api/*
└────────────────────────────────────────────────────────────────────────────┘
```

The phone runs the **same `api.New(...)` handler** the server binary runs,
bound to loopback. "Sync" is nothing more than the engine swapping what sits
behind `/api`: the local core, or a reverse proxy to a remote server. Because
the WebView always talks to one origin (`127.0.0.1`), there is no CORS, no
client reconfiguration, and the UI code path is identical in both modes —
and identical to the PWA.

### 2.1 Why this and not…

| Alternative | Why not |
|---|---|
| Native Kotlin/Compose UI + Room | Rewrites every screen and the whole domain. We already pay for one mirror (the TS core); a third implementation of streaks/periods/derived trackers is the wrong direction. |
| Expo / React Native (the original plan) | Abandoned once already; would need the domain in TS again. |
| Capacitor | Works, but we need ~5 native touchpoints. A plain WebView + a small `@JavascriptInterface` is less machinery than a plugin framework. |
| Sync mode = WebView navigates to the remote origin | Skew-free, but the sync settings (and the way back to local) would live outside the UI, and the app would have two origins with two storage scopes. The proxy keeps one origin and one UI. |
| Exec the Go binary as a `lib*.so` child process | Works, but process supervision, crash handling, and IPC by port only. `gomobile bind` gives an in-process engine with a typed API and the app's lifecycle for free. |
| Route requests via `shouldInterceptRequest` (no socket) | It doesn't expose request bodies, so `POST`/`PATCH` can't work. A loopback socket is required — hence §5. |

**Verified:** the server already cross-compiles for the target today —
`CGO_ENABLED=0 GOOS=android GOARCH=arm64 go build ./cmd/countroster`
succeeds (17 MB). `modernc.org/sqlite` being pure Go is what makes this whole
design cheap.

## 3. Components

### 3.1 Go: `server/internal/engine` (new, the real work)

Pure Go, no gomobile types, fully testable with `httptest`. Split into small
pieces, each with one job:

| Piece | Contract |
|---|---|
| `Router` | An `http.Handler` holding an `atomic.Pointer[http.Handler]` for `/api`. `SetLocal(h)` / `SetRemote(url)` swap it; in-flight requests finish on the old delegate. `/_engine/*` and the static PWA are served directly, never proxied. |
| `Proxy` | `httputil.ReverseProxy` to `<remote>/api`. Maps transport failures to `503 {"error":"server unreachable"}` (the existing error-body shape, so `ApiError` in the client handles it unchanged). Strips the engine's session cookie before forwarding. Timeouts: 10 s connect, 60 s overall (bundle import can be large). |
| `Gate` | Loopback session auth (§5). Middleware; knows nothing about modes. |
| `Config` | Persists `{mode, remote_url, remote_version}` as `engine.json` in the app's files dir — atomic write-rename. Deliberately **not** in SQLite: it must not travel in a backup bundle, and it must survive replacing the local DB. |
| `Probe` | `Probe(ctx, url) → ServerInfo{version, api_level, empty bool}` via `GET /api/health` + `GET /api/backup/manifest`. Pure function of an HTTP client; returns typed errors (`ErrUnreachable`, `ErrNotCountRoster`, `ErrTooOld`). |
| `Handoff` | The data moves when the mode changes (§6). Each strategy is a function over two `api.Core`-shaped endpoints (local `backup.Service` and a remote client), so tests run both sides as in-memory apps. |
| `Engine` | Composition: open storage → migrate → `core.New` → `api.New` (reusing the extracted composition, §3.3) → `Router`. Owns the cloud `Scheduler` goroutine in local mode. `Start/Stop/SetTimezone`. |

### 3.2 Go: `server/mobile` (new, gomobile-bindable façade)

gomobile only exports a restricted type set, so this package is a thin,
string/int-typed wrapper over `engine` and contains no logic:

```go
package mobile

type Engine struct{ /* wraps *engine.Engine */ }

func NewEngine(filesDir string) *Engine
func (e *Engine) Start(tzID string) (port int, err error) // idempotent
func (e *Engine) Stop() error
func (e *Engine) BootstrapURL() string                     // one-time URL for the WebView (§5)
func (e *Engine) SetTimezone(tzID string) error            // see §9.1
func (e *Engine) RunDueCloudBackup() error                 // WorkManager entrypoint
```

Mode switching is **not** in this API — it goes through `/_engine/*` so the
React UI owns it (§4). The Kotlin side never needs to know which mode is on.

### 3.3 Go: extract the composition root

`cmd/countroster/main.go`'s `run` currently does open → migrate → wire →
`withWebClient` inline. Extract that wiring (storage + migrate + core +
backup + cloud + the SPA/quick-log web handler) into `internal/server` (or
similar) so the binary and the engine build the *same* handler. Pure
refactor, covered by the existing `main_test.go` + `api_test.go`.

### 3.4 Kotlin: `apps/android` (thin shell)

One `Activity`, one `WebView`, one `Application`. Responsibilities, and
nothing else:

1. **Lifecycle.** `Application.onCreate` → `Engine.Start(TimeZone.getDefault().id)`;
   the engine lives for the process. Loads `BootstrapURL()`.
2. **Back button** → `WebView.goBack()`; at root, finish.
3. **File open** (backup import, CSV transaction import): `onShowFileChooser`
   → SAF `ACTION_OPEN_DOCUMENT`. Works with the existing `<input type=file>`.
4. **File save** (backup export): a `@JavascriptInterface` `saveFile(name, mime, base64)`
   → SAF `ACTION_CREATE_DOCUMENT`. The WebView can't do blob-anchor downloads.
5. **Quick-log shortcuts**: `requestPinShortcut(trackerId, name, color)` →
   `ShortcutManagerCompat` with an intent that opens `/trackers/<id>/quick`.
   Replaces the PWA's per-tracker manifest + "Add to Home Screen".
6. **Timezone** changes: `ACTION_TIMEZONE_CHANGED` → `Engine.SetTimezone`.
7. **Background cloud backup** (local mode): a periodic `WorkManager` job →
   `RunDueCloudBackup()`. `next_run_at` already lives in the DB, so a missed
   deadline is picked up on the next run — the existing design fits.

The bridge is exposed as `window.CountRosterAndroid`; its absence means
"plain browser", so the PWA is unaffected.

## 4. Web client changes (small, UI-only)

No business logic moves into `apps/web`. Changes:

- **`src/lib/platform.ts`** — one adapter: `saveFile`, `canPinShortcut`,
  `pinShortcut`. Browser impl = today's code (blob download / share sheet);
  Android impl = the bridge. `client.ts`'s download path calls it.
- **Sync section on the Data page** — rendered only if `GET /_engine/status`
  answers (404 in the PWA → hidden). Shows mode, server URL + version, and the
  enable/disable flows of §6.
- **"Add to home screen"** on the tracker page uses `pinShortcut` when
  available, else today's instructions.
- **Unreachable banner** — a 503 with `server unreachable` shows "Can't reach
  your server" instead of a generic error.
- **Android build mode** (`vite build --mode android`): no service-worker
  registration (assets are local; a SW only adds staleness), no
  manifest/install prompts.

## 5. Loopback security

A loopback port is reachable by **every app on the phone**, not just ours.
"No auth, trusted network" is a fine posture for a LAN server; it is not fine
for the local mode of a phone app holding someone's meds and moods.

`Gate`:

1. At start the engine mints a random 256-bit session secret and a one-time
   bootstrap token.
2. Kotlin loads `http://127.0.0.1:<port>/_engine/boot?t=<token>`. The engine
   checks and **burns** the token, sets `cr_session=<secret>` (`HttpOnly`,
   `SameSite=Strict`, `Path=/`), and redirects to `/`.
3. Every other request without a valid cookie gets `403`. Bound to
   `127.0.0.1` only, never `0.0.0.0`.

Another app can find the port but has neither the token (passed in-process)
nor the cookie (inside our WebView's cookie jar). Secrets rotate per process
start. The cookie is stripped before proxying, so a remote server never sees
it.

## 6. Mode switching and data handoff

The phone's local DB file is **never deleted** by a mode switch — it goes
dormant. All destructive steps take an automatic safety bundle first (saved in
app storage, last 3 kept, listed on the Data page).

### 6.1 Enable sync

1. User enters a URL → `Probe`. Reject on unreachable / not CountRoster /
   too old (§8.3) with a specific message.
2. Pick a strategy from the two "is it empty?" facts:

| Phone | Server | Offered |
|---|---|---|
| empty | any | **Just connect.** |
| has data | empty | **Move my data to the server** (default): export local bundle → `POST /api/backup/import` on the server. Existing endpoint. |
| has data | has data | **Use the server's data** (default; phone data stays dormant + safety bundle), or **Replace the server with this phone's data** (downloads a server safety bundle first, then imports with `confirmOverwrite=1`; double confirm). |

3. `Router.SetRemote(url)`, persist `Config`, stop the local cloud scheduler
   (the server runs its own), UI reloads.

### 6.2 Disable sync

| Option | What happens |
|---|---|
| **Keep a copy of the server's data** (default) | Download the server bundle → import into the local DB (overwrite, safety bundle of the dormant DB first). The phone continues where it left off. |
| **Go back to this phone's old data** | Re-open the dormant DB as-is. |

If the server is unreachable, only the second option is offered.

### 6.3 Why no merge in v1

IDs are UUIDv7 and globally unique, so a *union* merge is technically
cheap — but a phone "Water" tracker and a server "Water" tracker become two
trackers, and the unique keys (`category_rules.merchant`,
`card_transactions.dedupe_key`) need conflict rules. That's a product
decision plus a new additive endpoint (`POST /api/backup/merge`); it's a clean
follow-up, not a v1 blocker.

## 7. Sync across PWA and Android

```
 PWA (desktop browser) ─┐
 PWA (phone browser)   ─┼──HTTP /api──►  CountRoster server  ──►  one SQLite file
 Android app (synced)  ─┤               (the existing binary)
 Android app (synced)  ─┘
```

Every client in sync mode hits the **same `/api` handler on the same file**.
An entry logged from the Android app is the entry the PWA reads, and the other
way round. Nothing about sync is Android-specific on the server side.

### 7.1 Why this holds without extra machinery

- **All durable state is in the database.** The web client keeps nothing in
  `localStorage`, `sessionStorage` or IndexedDB (checked). Hidden mode is
  in-memory per session. So tracker order, page section order, fields, groups,
  transactions and cloud backup settings are all shared, because they're
  all rows.
- **One wire contract.** The Android proxy forwards `/api` verbatim, so the
  server sees the same requests it already gets from the PWA.
- **One bucketing clock.** In sync mode every client's day/week/month boundaries
  come from the server's timezone, as with the PWA today. (In local mode the
  phone uses its own timezone. After "Move my data to the server", the same
  entries are bucketed in the server's timezone. These are identical whenever
  the phone and the server are in the same zone. Worth a line in the
  enable-sync dialog when they differ.)
- **Quick-log links are by tracker id**, so a PWA home-screen icon and an
  Android pinned shortcut for the same tracker open the same data.
- **The usual path just works:** start on the phone in local mode. Later,
  enable sync → "Move my data to the server" (§6.1). Then open the server in
  any browser and the PWA shows the phone's history.

### 7.2 The gap to close: freshness

Neither client subscribes to changes. `useAsync` loads when a component mounts
and on explicit `reload()`. Today that's mostly invisible. With an Android app
that lives in the background for hours, it isn't: log on the desktop PWA,
switch to the phone, and you see the old count.

Fix, in the web client (so the PWA benefits too): `useAsync` re-runs its
loader when the page becomes visible again (`visibilitychange` → `visible`,
throttled to at most once every few seconds). The WebView fires the event when
the Activity resumes, so the Android app needs no native code for it.
Server unchanged. Covered by a vitest that flips `document.visibilityState`.

Live push (SSE from the server on write) would make open screens update
without switching away. That's out of scope for v1, and refresh-on-focus covers
the real case of one person moving between devices.

### 7.3 Version skew between clients

The PWA is always exactly the server's version, because the server serves it.
A synced Android app carries its own bundle, so it can be older or newer than
the server. `api_level` (§8.3) is the gate: an app newer than its server is
refused before it can write fields the server would drop. **Upgrading the server
first is always safe**, and the docs will say so.

### 7.4 Concurrent edits

There are no new semantics. Two clients writing at once is the same as two
browser tabs today: each request is its own transaction on the one SQLite
connection. The last write to a row wins, and the note edit log keeps every
overwritten body. Proxying adds no caching layer that could serve stale writes.

### 7.5 Not supported: a phone as the hub

Sync needs the server binary running somewhere (home box, Pi, VPS on a
tailnet). A PWA can't sync *to an Android app in local mode*: that would mean
exposing the phone's engine on the network, which contradicts §5, and phones
sleep. If that's wanted, it's a separate decision (see §13).

### 7.6 Tested

A cross-client test in `internal/engine` uses one real server (`api.New` on
`:memory:` in `httptest`). Two engines in sync mode plus a direct `/api` client
(standing in for the PWA) each write. Every client then reads every other
client's writes, through the proxy and directly. The `/verify` e2e drives the
real PWA in a browser against a server that an engine is also synced to.

## 8. Contracts

### 8.1 Untouched

REST shapes, SQL schema, migrations, backup bundle, `jsjson` checksums.
In local mode the phone produces the **same SQLite file** a server does, so a
phone DB can be copied onto a server (and vice versa) — a nice escape hatch.

### 8.2 New, engine-only (not part of the server's REST contract)

Served by the engine on the phone, never proxied, never present on a server:

```
GET  /_engine/boot?t=…          → 302 + session cookie
GET  /_engine/status            → {mode, remote_url, remote_version, local_empty, safety_bundles:[…]}
POST /_engine/sync/probe        {url}            → ServerInfo | 400 {"error"}
POST /_engine/sync/enable       {url, strategy}  → status | 400/409/502
POST /_engine/sync/disable      {strategy}       → status | 400/502
```

Same conventions as `/api` (snake_case, `{"error":…}` bodies) so the client
code reads the same. Pinned by `internal/engine` tests.

### 8.3 One additive server change: `api_level`

In sync mode the phone's bundled UI (version X) talks to a server built at
version Y. The contract is additive and validators **ignore unknown keys** —
which means a newer UI writing a new field to an older server would see it
*silently dropped*. That's data loss, so it needs a gate:

- `GET /api/health` gains `"api_level": <int>` (additive; absent = 0).
- `api_level` is a const in `internal/api`, bumped whenever the API gains
  something a client may rely on. The web bundle is built with the level it
  requires.
- `Probe` rejects a server whose level is below the app's (`ErrTooOld` →
  "Update your server to vYYYY.M.N or later"); the engine re-checks on every
  start and on reconnect, and falls back to a read-only warning if the server
  was downgraded under it. Newer servers are fine.

`api_test.go` pins the field; the TS `ApiCore` is unaffected.

## 9. Platform details

### 9.1 Timezone (a real trap)

Go on Android **defaults `time.Local` to UTC** — there's no `/etc/localtime`.
Since all period bucketing (`periods.go`) and `ToLocalISO` timestamps depend
on host-local time, an un-fixed engine would bucket every day in UTC and
stamp `+00:00` offsets. The shell passes `TimeZone.getDefault().id` at start
and on change; `engine.SetTimezone` does `time.LoadLocation` (Go reads
Android's system tzdata) and swaps `time.Local` before any request is served.
Test: an engine started with `America/Los_Angeles` stamps `-07:00`.

In sync mode bucketing is the server's timezone — unchanged from the PWA.

### 9.2 Cloud backup on the phone

Works in local mode through the existing `internal/cloud`. Paste mode only in
v1 — the redirect flow needs a registered https origin, which `127.0.0.1`
isn't (this is exactly the case paste mode was built for). Each user still
registers their own OAuth app, as on a server; a smoother phone-native story
(Android's SAF to write the bundle into a Drive/Dropbox *folder provider*,
no OAuth at all) is a good follow-up and arguably the better phone UX.

### 9.3 Build & packaging

- `apps/android/` — Gradle (Kotlin DSL), Kotlin, AndroidX WebKit. **minSdk 26**
  (Android 8, ~97% of devices; modern WebView + SAF), target latest.
- Build chain: `vite build --mode android` → copy into the engine's embed dir
  (the same `//go:embed` mechanism the release binary uses) → `gomobile bind
  -target=android/arm64,android/amd64 -androidapi 26 ./mobile` → `engine.aar`
  → Gradle. One `npm run build:android` drives it. `amd64` is for the
  emulator; release APKs/AABs split per ABI (~10 MB download for arm64).
- Version: `versionName` = the calendar version from `scripts/version.mjs`;
  `versionCode` = the commit count (monotonic — it's `rev-list --count`). The
  no-shallow-clone rule applies to the Android CI job too.
- CI: a job in `release.yml` builds a signed APK alongside the Linux binaries
  (keystore from secrets) with a `.sha256` beside it.
- Licensing: gomobile (BSD-3), AndroidX (Apache-2.0) — AGPL-compatible. Every
  new `package.json` keeps `"license": "AGPL-3.0-only"`. Distributing the APK
  is distributing the program: the About screen links the source (AGPL).

## 10. Later: true offline sync (out of scope, sketched for direction)

If "can't log on the train while in sync mode" turns out to matter, the next
step is replication: every device keeps its local DB and syncs with the
server. That needs, at minimum: a change log / tombstones (entries, notes,
groups, fields are hard-deleted today), a per-row LWW clock (HLC, not
wall-clock `updated_at`), conflict rules for the unique keys, and handling
for multi-row ops (reorders, field replacement). It's a schema migration plus
a mirrored TS migration plus a backup-format question — a real project, and
the v1 design doesn't paint us into a corner: the engine's `Router` is
exactly where a "local DB + background sync" delegate would slot in.

## 11. Testing

| Layer | How |
|---|---|
| `internal/engine` | Unit tests per piece. Handoff/Probe/Proxy tests run a **real remote** (`api.New` over `:memory:` in `httptest.Server`) against a real local engine — both sides genuine, no mocks. Gate: no cookie → 403, token single-use, cookie never forwarded. Router: swap under concurrent load (`-race`). |
| `server/mobile` | Smoke: start on a temp dir, bootstrap, `GET /api/trackers`, stop, restart, data persists. |
| Composition refactor | Existing `main_test.go` + `api_test.go` unchanged and green. |
| `apps/web` | vitest: Sync section against a fake `/_engine`, platform adapter both impls, section hidden when `/_engine/status` 404s. |
| `apps/android` | One instrumented test (emulator in CI): app launches, home renders, log an entry, relaunch, entry still there. The shell is thin enough that this covers it. |

## 12. Phases

1. **Engine, local only.** Extract composition; `internal/engine` (Router
   local-only, Gate, Config); `server/mobile`; timezone fix. *Done when:* Go
   tests green, engine runs on an emulator.
2. **Android shell.** Gradle project, WebView, back, file open/save, Android
   build mode. *Done when:* a fully working local-only APK — a shippable app
   on its own.
3. **Sync mode.** Proxy, Probe, `api_level`, Handoff, `/_engine/*`, Sync UI,
   unreachable banner, refresh-on-focus (§7.2), cross-client test (§7.6).
4. **Polish.** Pinned quick-log shortcuts, WorkManager cloud backup, safety
   bundle list, CI-signed release APK, docs (`README`, `DEPLOYMENT`, this
   file → `DESIGN.md` §0.6).

## 13. Decisions needed

1. **Sync semantics.** v1 = "connect to a server" (the PWA's behaviour,
   online-only while synced), with offline replication (§10) as a possible
   later project. OK?
2. **Both sides have data** when enabling sync: v1 offers "use server's" or
   "replace server", no merge (§6.3). OK?
3. **Distribution**: GitHub Releases APK only, or also F-Droid / Play Store?
   (Play affects target-SDK cadence and signing; F-Droid wants reproducible
   builds — gomobile is fine with that but it's work.)
4. **Sync settings in the React Data page** (recommended — one UI, vitest
   coverage) vs a native Android settings screen.
5. **minSdk 26** OK?
6. **Server required for sync** (§7.5). Synced devices, Android or PWA, all
   need the server binary running somewhere. No phone-as-hub. OK?
