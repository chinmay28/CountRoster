---
name: verify
description: Build, launch, and drive CountRoster end-to-end to verify a change at its real surface (REST API + the served PWA in a browser).
---

# Verifying CountRoster changes

The runtime surface is one **static Go binary**: it serves the REST API under
`/api` **and** the built PWA from the same origin. Verify by booting that
binary against a throwaway DB and driving it with curl (API) and Playwright
(UI). `node scripts/verify.mjs` automates the whole flow (launch → seed over
REST → screenshots to /tmp/shots).

## Build & launch

```bash
npm install                                   # once per container
npm run build                                 # core (tsc) → web (vite) → server (go build)
COUNTROSTER_DB=$SCRATCH/verify.sqlite PORT=8791 WEB_DIST=apps/web/dist \
  ./server/bin/countroster &                  # serves apps/web/dist too
curl -s http://127.0.0.1:8791/api/health      # {"ok":true,...}
```

- Migrations run automatically on boot; a fresh `COUNTROSTER_DB` file path
  exercises them for real. `:memory:` also works.
- The binary serves the PWA from (in order): `WEB_DIST`, assets embedded at
  build time, or `apps/web/dist` relative to the working directory. In a dev
  checkout the embed is empty, so build the web workspace first.
- Go-only iteration: `cd server && go test ./...` runs the domain + API suites
  in milliseconds; `go build ./...` type-checks.

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

- `pkill -f server/bin/countroster` when done.
- Entries come back oldest-first from the API; the UI lists newest-first.
- The wire contract (JSON field names, 0/1 flags, status codes) is pinned by
  `server/internal/api/api_test.go` — if a UI change needs an API change,
  update that suite in the same commit.
