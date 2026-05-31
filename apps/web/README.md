# @countroster/web

The CountRoster web shell — a local-first SPA over [`@countroster/core`](../../packages/core).

- **Vite + React** (hash-routed SPA; no server, fitting the local-first model).
- **Storage:** `SQLiteWasmAdapter` (`src/db/adapter.ts`) implements core's `Storage`
  contract against [`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm). It persists
  via the **OPFS SAHPool VFS** (`installOpfsSAHPoolVfs`), falling back to an
  in-memory database when OPFS is unavailable (the UI shows a warning in that case).
- **iOS:** the same build runs on an iPhone via a [Capacitor](https://capacitorjs.com)
  WKWebView shell you open in Xcode — see
  [Run on an iPhone via Xcode](#run-on-an-iphone-via-xcode-no-apple-developer-account).

## Commands

```bash
npm run dev        --workspace @countroster/web   # vite dev server
npm run build      --workspace @countroster/web   # tsc --noEmit && vite build
npm run preview    --workspace @countroster/web   # serve the production build
npm run test       --workspace @countroster/web   # vitest (jsdom)
npm run typecheck  --workspace @countroster/web
```

> `@countroster/core` must be built first (`npm run build --workspace @countroster/core`)
> so its `dist/` exists — the web app imports the package's compiled output.

## Persistence (OPFS SAHPool)

The adapter uses sqlite-wasm's **OPFS SAHPool VFS**. Unlike the older `OpfsDb`
VFS, it does **not** require the page to be cross-origin isolated — no COOP/COEP
headers, no `SharedArrayBuffer`. That means persistence works on any plain static
host, over a LAN/Tailscale URL, and inside the iOS WKWebView shell (which serves
from a custom scheme that is never cross-origin isolated).

It only needs the Origin Private File System (`navigator.storage.getDirectory` +
synchronous access handles), available in Safari / iOS 15.2+ and all current
evergreen browsers. Where OPFS is missing (a private window, an old OS), the app
still boots on an in-memory database and shows a banner — data is then lost on
reload.

Persistence is **per origin**: `http://localhost:5173`, a `*.ts.net` URL, and the
native app each keep their own separate database.

## Run on an iPhone via Xcode (no Apple Developer account)

The web app is wrapped with [Capacitor](https://capacitorjs.com) into a native
iOS project you build and install from Xcode. Xcode's **free provisioning** signs
to your own device with a free Apple ID — no paid Developer Program needed. The
catch: the signing certificate expires after **7 days**, so you re-run from Xcode
to reinstall when it lapses.

**These steps require a Mac with Xcode** (CocoaPods + the iOS toolchain are
macOS-only). Everything else in this repo is cross-platform.

1. **Pick a unique bundle id.** Edit `appId` in `capacitor.config.ts` to your own
   reverse-domain string, e.g. `app.countroster.<yourname>`. Free provisioning
   refuses ids already used by another Apple ID.

2. **Generate the native project** (first time only):

   ```bash
   npm install
   npm run build      --workspace @countroster/core   # core dist/
   npm run ios:add    --workspace @countroster/web     # creates apps/web/ios/ (runs `pod install`)
   ```

3. **Build the web assets into the app** (re-run after any web change):

   ```bash
   npm run ios:sync   --workspace @countroster/web     # vite build + cap sync ios
   ```

4. **Open Xcode:**

   ```bash
   npm run ios:open   --workspace @countroster/web     # opens apps/web/ios/App/App.xcworkspace
   ```

5. **Configure signing** in Xcode → select the **App** target → **Signing &
   Capabilities**:
   - Tick **Automatically manage signing**.
   - **Team** → *Add an Account…* → sign in with your Apple ID → pick your
     **(Personal Team)**.
   - Confirm the **Bundle Identifier** matches step 1 (or just set a unique one
     here).

6. **Run on the phone:** plug in your iPhone (unlocked, "Trust This Computer"),
   pick it as the run destination, press **▶**. First launch fails to open until
   you trust the cert: on the phone, **Settings → General → VPN & Device
   Management → [your Apple ID] → Trust**. Press ▶ again.

7. **When it expires (~7 days)** or after web changes: `npm run ios:sync`, then ▶
   in Xcode again.

Free-provisioning limits to know: app stops launching after 7 days until
re-signed; max 3 sideloaded apps per device; up to 10 new app ids per 7 days.

> The generated `apps/web/ios/` project **is** meant to be committed (it's your
> native app). The heavy/generated parts — `Pods/`, copied web assets, Xcode
> build output — are gitignored.

This Capacitor shell is the pragmatic "the web app, on my phone, today" path. It
is independent of the Expo `apps/mobile` shell described in `DESIGN.md`, which
remains the plan for a fully native iOS/Android build later.

## Layout

```
src/
  main.tsx            # entry + hash router
  app/
    CoreContext.tsx   # boots the core, provides it via React context
    AppLayout.tsx     # chrome + non-persistence banner
    useAsync.ts       # small async-loader hook (the local DB has no subscriptions)
  db/
    adapter.ts        # SQLiteWasmAdapter (Storage impl, OPFS + in-memory fallback)
    bootstrap.ts      # open adapter → createApp → migrations.run()
  pages/              # Home, TrackerDetail, TrackerForm, NotFound
  components/         # TrackerCard, EntryList, NotesSection
  lib/                # value/date formatting, today-range helpers
  test/               # MemoryAdapter-backed test core + setup
```

## What's implemented

Mirrors the core services that exist today: tracker list / create / edit / archive,
tap-to-log and custom/backdated logging, entry edit & delete, and editable journal
notes with a per-note edit-history view. Charts, groups, reminders, and backup UI
are intentionally not built yet — they wait on the corresponding core services
(`stats`, `groups`, `reminders`, `backup`), which are still stubs.
