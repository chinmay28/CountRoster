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

### Quick start on Linux (Ubuntu / Raspberry Pi)

Install CountRoster as a hardened **systemd service** with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/chinmay28/countroster/main/scripts/quickstart.sh | sudo bash
```

(or, from a checkout: `sudo ./scripts/quickstart.sh`)

It installs Node 22 if needed, creates a dedicated `countroster` system user, builds
the app, and runs it under systemd serving the API + PWA on `http://<host>:8787`.

**Re-run it any time to upgrade — installs and upgrades are non-disruptive and
never lose data:**

- The live SQLite database lives at a stable path **outside** the source tree
  (`/var/lib/countroster/`), so rebuilding/pulling can't clobber it.
- Each upgrade quiesces the service, **snapshots the database** (`+ WAL/SHM`) to a
  timestamped backup, then swaps code in. The new build compiles while the old
  version keeps serving, so a failed build leaves the running app untouched.
- After restart it polls `/api/health`; if the new version is unhealthy it **rolls
  back** to the previous commit and **restores the pre-upgrade snapshot**.
- Schema changes run through the core's append-only, idempotent migration runner.

Override defaults with env vars (`PORT`, `HOST`, `COUNTROSTER_REF`,
`COUNTROSTER_DATA_DIR`, `COUNTROSTER_PREFIX`, `COUNTROSTER_USER`, …). The generated
unit is documented at [`deploy/countroster.service`](./deploy/countroster.service).
Manage it with `systemctl status countroster` and `journalctl -u countroster -f`.

### Production (single process, manual)

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

## License

CountRoster is free software licensed under the **GNU Affero General Public
License v3.0 or later** (`AGPL-3.0-or-later`). See [LICENSE](./LICENSE) for the
full text.

The AGPL is a strong copyleft license: anyone who distributes CountRoster — or
**runs a modified version as a network service** — must make the complete
corresponding source available under the same license. Copyright in the project
is held by Chinmay Manjunath, who may also offer CountRoster under separate
commercial terms.

> **Note for operators (AGPL §13):** if you run a modified CountRoster server
> that other people interact with over a network, you must offer those users the
> corresponding source of your modified version.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). By
contributing you agree to the [Contributor License Agreement](./CLA.md), which
lets the project be offered under both the AGPL and possible future commercial
terms. Sign off your commits with `git commit -s`.
