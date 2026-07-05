---
name: verify
description: Build, launch, and drive CountRoster end-to-end to verify a change at its real surface (REST API + the served PWA in a browser).
---

# Verifying CountRoster changes

The runtime surface is one Node process: the Express server serves the REST
API under `/api` **and** the built PWA from the same origin. Verify by booting
that server against a throwaway DB and driving it with curl (API) and
Playwright (UI).

## Build & launch

```bash
npm install                                   # once per container
npm run build                                 # core (tsc) → server (tsc) → web (vite)
COUNTROSTER_DB=$SCRATCH/verify.sqlite PORT=8791 \
  node apps/server/dist/server.js &           # serves apps/web/dist too
curl -s http://127.0.0.1:8791/api/health      # {"ok":true,...}
```

- Migrations run automatically on boot; a fresh `COUNTROSTER_DB` file path
  exercises them for real. `:memory:` also works.
- The server only serves the PWA if `apps/web/dist` exists (build first).

## Drive the API

Endpoints map 1:1 to core services — `POST /api/trackers`,
`POST /api/trackers/:id/entries`, `POST /api/notes`,
`GET /api/trackers/:id/stats/{buckets,streak,target-progress}`. Seed data
this way; it's what the UI calls anyway.

## Drive the UI

Playwright is installed globally; Chromium is pre-provisioned:

```js
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
```

- Use a phone-ish viewport (~480×1000) — it's a mobile-first PWA.
- Useful anchors: `.tracker-card` (home), `.detail__total` / `.detail__stats`
  (tracker detail), `.entry-list .entry` (entries), Trends period buttons are
  `role=button` named Day/Week/Month/Year, charts are `role=img` with
  aria-labels like "<name> totals by day".
- Deep links (`/trackers/:id`) work via the SPA fallback.

## Gotchas

- `pkill -f "node apps/server/dist/server.js"` when done.
- Entries come back oldest-first from the API; the UI lists newest-first.
