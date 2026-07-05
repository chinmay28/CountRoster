# @countroster/web

The CountRoster web client — a mobile-friendly, installable **PWA** that talks to
the [`@countroster/server`](../server) backend over a REST API. All data lives on
the server, so every device that points at the same server sees the same data.

- **Vite + React**, browser (history) routing. The server serves `index.html` for
  any non-API route (SPA fallback), so deep links and refreshes work.
- **API client** (`src/api/client.ts`): `createApiClient()` returns an object whose
  `trackers / entries / notes / groups / stats` services mirror the
  interfaces in `@countroster/core` — each method is a `fetch` against `/api`. The
  React pages call `core.trackers.list()` etc. and don't know they're hitting HTTP.
- **PWA** via [`vite-plugin-pwa`](https://vite-pwa-org.netlify.app): web app
  manifest + service worker for installability and an app-like standalone window.
  The service worker precaches the app shell but **never** caches `/api` — data is
  always live.
- **Charts** via [Observable Plot](https://observablehq.com/plot/): a `PlotFigure`
  wrapper renders Plot specs into React, sized to its container (ResizeObserver) so
  charts fit a phone. Plot is **code-split** — it loads only when you open a tracker
  detail or the Compare page, keeping the home screen's first paint light.
- **No local database.** The old sqlite-wasm/OPFS adapter is gone; the only state
  here is UI state.

## Commands

```bash
npm run dev        --workspace @countroster/web   # vite dev server, proxies /api → http://localhost:8787
npm run build      --workspace @countroster/web   # tsc --noEmit && vite build → dist/ (app shell + SW + manifest)
npm run preview    --workspace @countroster/web   # serve the production build (also proxies /api)
npm run test       --workspace @countroster/web   # vitest (jsdom)
npm run typecheck  --workspace @countroster/web
```

> `@countroster/core` must be built first (`npm run build --workspace @countroster/core`)
> so its `dist/` exists — the client imports the package's (type-only) compiled output.
>
> The dev server proxies `/api` to `http://localhost:8787` by default; override with
> `VITE_API_TARGET`. Start the backend (`npm run dev --workspace @countroster/server`)
> alongside it.

## Using it on a phone

Point your phone at the running web app (the dev server over your LAN/Tailscale, or
a deployed instance — see [DEPLOYMENT.md](../../DEPLOYMENT.md)) and use the browser's
**Add to Home Screen** / **Install** affordance. It launches in a standalone window
with no browser chrome, respects notch safe-areas, and behaves like a native app.
Because the data is on the server, there's nothing to migrate when you reinstall —
just open it again.

## Layout

```
src/
  main.tsx            # entry + browser router
  api/
    client.ts         # ApiCore HTTP client mirroring the core service interfaces + backup helpers
  app/
    CoreContext.tsx   # provides the API client; runs a /api/health check for the offline banner
    AppLayout.tsx     # chrome + connectivity banner
    useAsync.ts       # small async-loader hook (reload() after mutations)
  pages/              # Home, TrackerDetail, TrackerForm, Data (backup/restore), NotFound
  components/         # TrackerCard, EntryList, NotesSection
  lib/                # value/date formatting, today-range helpers
  test/               # MemoryAdapter-backed test core (interchangeable with the API client) + setup
```

## What's implemented

Tracker list / create / edit / archive, tap-to-log and custom/backdated logging,
entry edit & delete (paginated, searchable by an entry's note), and editable
journal notes with per-note edit history. A tracker's "Reset every" can also be
"Not applicable — snapshot stat" for point-in-time levels like net worth: the
latest reading is the headline, stats show the all-time high/low, and trends
draw a level line instead of bars.

Visualizations & organization:

- **Trends** — a bucketed chart (day/week/month/year) with axes and tooltips —
  bars of totals, or a level line for snapshot stats — plus a day-streak or
  all-time high/low card and a target-progress bar, on each tracker.
- **Compare** (`/compare`) — a multi-series line chart comparing several trackers
  over time, with a tracker picker and period toggle.
- **Groups** (`/groups`) — organize trackers into groups; the home screen renders
  them under group headings.
- **Data** (`/data`) — backup export (bundle / raw SQLite) and restore.

## License

`AGPL-3.0-only`, like the rest of CountRoster — see [`LICENSE`](../../LICENSE).
Contributions are taken under the [CLA](../../CLA.md); see
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).
