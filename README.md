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
├── server/                   # the Go backend — REST API + SQLite, compiles to ONE static binary
│   ├── cmd/countroster/      #   entrypoint; embeds the built PWA at release time
│   └── internal/             #   domain services, migrations, stats, backup, HTTP layer
├── packages/
│   └── core/                 # @countroster/core — TS domain types + in-memory test double for the web client
└── apps/
    └── web/                  # @countroster/web — installable PWA client (Vite + React)
```

The deployable artifact is a **single static Go binary** (`server/bin/countroster`)
that serves the REST API and the PWA from one origin, with zero runtime
dependencies — Node is only needed at build time to compile the web client.

## Getting started

```bash
npm install                                   # Node >= 20.10 (build/dev tooling)
npm run build --workspace @countroster/core   # the web client imports the core's types

# Terminal 1 — the backend API (Go >= 1.21; newer toolchains fetch automatically):
cd server && go run ./cmd/countroster          # http://localhost:8787

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

It installs Node 22 and Go if needed (both build-time only), creates a dedicated
`countroster` system user, compiles the PWA and the static server binary, and runs
it under systemd serving the API + PWA on `http://<host>:8787`.

**Re-run it any time to upgrade — installs and upgrades are non-disruptive and
never lose data:**

- The live SQLite database lives at a stable path **outside** the source tree
  (`/var/lib/countroster/`), so rebuilding/pulling can't clobber it.
- Each upgrade quiesces the service, **snapshots the database** (`+ WAL/SHM`) to a
  timestamped backup, then swaps code in. The new build compiles while the old
  version keeps serving, so a failed build leaves the running app untouched.
- After restart it polls `/api/health`; if the new version is unhealthy it **rolls
  back** to the previous commit and **restores the pre-upgrade snapshot**.
- Schema changes run through the server's append-only, idempotent migration runner.

Override defaults with env vars (`PORT`, `HOST`, `COUNTROSTER_REF`,
`COUNTROSTER_DATA_DIR`, `COUNTROSTER_PREFIX`, `COUNTROSTER_USER`, …). The generated
unit is documented at [`deploy/countroster.service`](./deploy/countroster.service).
Manage it with `systemctl status countroster` and `journalctl -u countroster -f`.

### Production (single binary, manual)

```bash
npm run build                                  # core (types) → web (vite) → server (go build)
COUNTROSTER_DB=./data/countroster.sqlite \
  ./server/bin/countroster                     # serves the API *and* the built PWA on one origin
```

To bake the PWA *into* the binary (a truly single-file deploy — this is what
the quick-start does), copy `apps/web/dist/` into `server/cmd/countroster/webdist/`
before `go build`. Otherwise the server falls back to serving `WEB_DIST` from disk.

Server env vars: `PORT` (default 8787), `HOST` (default 0.0.0.0), `COUNTROSTER_DB`
(SQLite file path; default `./data/countroster.sqlite`), `WEB_DIST` (path to the
built client; overrides embedded assets).

## Testing & checks

```bash
npm test          # vitest (core test double + web components) + `go test ./...` (domain, API)
npm run typecheck # tsc --noEmit for the TS workspaces + `go vet` for the server
```

The Go suites in `server/internal/` are the authority on domain behavior and
the REST contract; the golden fixtures under `server/internal/backup/testdata/`
pin backup-bundle compatibility with the original TypeScript implementation.

## Documentation

- [DESIGN.md](./DESIGN.md) — architecture, schema, domain API
- [server/README.md](./server/README.md) — the Go backend
- [apps/web/README.md](./apps/web/README.md) — the PWA client
- [DEPLOYMENT.md](./DEPLOYMENT.md) — deploying the server + PWA

## License

CountRoster is free software licensed under the **GNU Affero General Public
License v3.0** (`AGPL-3.0-only`). See [LICENSE](./LICENSE) for the
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
