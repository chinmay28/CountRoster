# @countroster/web

The CountRoster web shell — a local-first SPA over [`@countroster/core`](../../packages/core).

- **Vite + React** (hash-routed SPA; no server, fitting the local-first model).
- **Storage:** `SQLiteWasmAdapter` (`src/db/adapter.ts`) implements core's `Storage`
  contract against [`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm). It persists
  to **OPFS** when the page is cross-origin isolated, and falls back to an
  in-memory database otherwise (the UI shows a warning in that case).

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

## Cross-origin isolation (OPFS persistence)

The OPFS-backed sqlite-wasm VFS needs `SharedArrayBuffer`, which requires the page
to be cross-origin isolated. Two response headers must be present on the document
and worker responses:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- **Dev / preview:** set by `vite.config.ts`.
- **Production:** the static host must send them. `public/_headers` covers
  Netlify / Cloudflare Pages; other hosts need equivalent config (see
  [`DEPLOYMENT.md`](../../DEPLOYMENT.md)).

Without isolation the app still boots, but data lives only in memory and is lost
on reload.

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
