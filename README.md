# CountRoster

An "anything tracker" — habits, medications, symptoms, spending, moods, anything
you want to count or log. Inspired by [Tally](https://apps.apple.com/us/app/tally-the-anything-tracker/id1090990601),
built as a **client-server** app so every device shares one dataset:

- **One shared source of truth.** A small backend owns a single SQLite database;
  desktop and mobile clients all read and write the same data.
- **Mobile-friendly PWA.** The web client is installable and behaves like an app
  on a phone — no app store, no native build.
- **Real data export.** Backups are documented open formats (a `.countroster.zip`
  bundle of JSON + per-table CSVs, plus a raw SQLite download).
- **Editable journal notes.** With an append-only edit log so history isn't lost.
- **No accounts, no auth.** Meant to run on a trusted network (your LAN, a
  Tailscale tailnet, a VPN). Anyone who can reach the server can use it.

## Layout

```
countroster/
├── DESIGN.md                 # architecture & design document
├── packages/
│   └── core/                 # @countroster/core — platform-agnostic TS domain (runs on the server)
└── apps/
    ├── server/               # @countroster/server — Express REST API + node:sqlite (the backend)
    └── web/                  # @countroster/web — installable PWA client (Vite + React)
```

## Getting started

```bash
npm install                                   # Node >= 20.10 (CI/dev uses Node 22)
npm run build --workspace @countroster/core   # the server & client import the compiled core

# Terminal 1 — the backend API:
npm run dev --workspace @countroster/server    # http://localhost:8787

# Terminal 2 — the web client (proxies /api → the server):
npm run dev --workspace @countroster/web       # http://localhost:5173
```

Open `http://localhost:5173`. To use it from your phone, reach the dev server (or
a deployed instance) over your LAN/Tailscale and "Add to Home Screen".

### Production (single process)

```bash
npm run build --workspace @countroster/core
npm run build --workspace @countroster/web     # → apps/web/dist
npm run build --workspace @countroster/server
COUNTROSTER_DB=./data/countroster.sqlite \
  node apps/server/dist/server.js              # serves the API *and* the built PWA on one origin
```

Server env vars: `PORT` (default 8787), `HOST` (default 0.0.0.0), `COUNTROSTER_DB`
(SQLite file path; default `./data/countroster.sqlite`), `WEB_DIST` (path to the
built client).

## Testing & checks

```bash
npm test          # vitest across core (domain), server (API integration), web (components)
npm run typecheck # tsc --noEmit everywhere
```

## Documentation

- [DESIGN.md](./DESIGN.md) — architecture, schema, `@countroster/core` API
- [apps/server/README.md](./apps/server/README.md) — the backend API
- [apps/web/README.md](./apps/web/README.md) — the PWA client
- [DEPLOYMENT.md](./DEPLOYMENT.md) — deploying the server + PWA
