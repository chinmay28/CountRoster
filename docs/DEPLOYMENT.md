# CountRoster — Deployment Guide

CountRoster is a **client-server** app. The deployable unit is **one Node
process** that serves both the REST API and the built PWA from the same origin.
There is no app store, no native build, and no per-device database — every client
talks to one shared backend.

> **History.** CountRoster began as a *local-first* app distributed as native
> iOS/Android binaries (Expo/EAS, App Store + Play Store) plus a static web
> shell. That model — and its Apple Developer / EAS / TestFlight / Play Console
> pipeline — has been retired. You no longer need a paid developer account, EAS,
> or a static-only web host. Deploy the server + PWA as described below.

## 1. What gets deployed

A single Node server that:

- exposes the REST API under `/api`, and
- serves the built PWA (`apps/web/dist`) from the same origin with an SPA
  fallback, so there's one process and no CORS.

| Concern | Answer |
|---|---|
| **Persistence** | A single SQLite file at `COUNTROSTER_DB`. Put it on a durable volume and back it up (or use the in-app Data page → bundle / raw SQLite export). |
| **Auth** | None, by design — run it on a **trusted network**. |
| **Secrets** | None. There are no API keys or credentials to manage. |
| **On-the-wire contract** | The REST API and the backup bundle, the latter versioned by `schema_version` in `manifest.json` (see [`DESIGN.md`](./DESIGN.md) §6.4, §8). |

## 2. Build & run (manual, single process)

```bash
npm ci
npm run build --workspace @countroster/core     # compiled core (server & web import it)
npm run build --workspace @countroster/web        # → apps/web/dist (the PWA)
npm run build --workspace @countroster/server     # → apps/server/dist

COUNTROSTER_DB=/var/lib/countroster/db.sqlite \
PORT=8787 \
  node apps/server/dist/server.js                 # API + PWA on one origin
```

Server environment variables:

| Var              | Default                      | Meaning                                            |
|------------------|------------------------------|----------------------------------------------------|
| `PORT`           | `8787`                       | Port to listen on.                                 |
| `HOST`           | `0.0.0.0`                    | Bind address.                                      |
| `COUNTROSTER_DB` | `./data/countroster.sqlite`  | SQLite file path. `:memory:` for an ephemeral DB.  |
| `WEB_DIST`       | `../web/dist` (relative to the built server) | Built PWA to serve. Point this at the built client if it isn't in the default location. |

The DB directory is created on boot and migrations run automatically (open adapter
→ `createApp` → `migrations.run()`).

## 3. Networking, HTTPS, and access control

- **No auth — keep it on a trusted network.** Expose it over **Tailscale** (a
  tailnet IP / MagicDNS `*.ts.net` name), a VPN, or a reverse proxy that adds its
  own access control. Do **not** put it on the open internet unauthenticated.
- **HTTPS is needed for PWA install.** Browsers only allow "Add to Home Screen" /
  service workers on a secure context (`https://` or `http://localhost`).
  Tailscale Serve, a reverse proxy with a cert (Caddy / nginx + Let's Encrypt), or
  a tunnel gives you HTTPS.
- **Process management.** Run under systemd / pm2 / a container; restart on boot.
- **Containers.** A reasonable image runs the three builds above, then
  `CMD ["node","apps/server/dist/server.js"]`, with the SQLite file on a mounted
  volume.

## 4. Quick start on Linux (systemd)

For a bare-metal Raspberry Pi or a VM,
[`scripts/quickstart.sh`](../scripts/quickstart.sh) installs CountRoster as a
**systemd service** in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/chinmay28/countroster/main/scripts/quickstart.sh | sudo bash
```

(or, from a checkout: `sudo ./scripts/quickstart.sh`)

What it does (idempotent — re-run to upgrade):

- Installs Node 22 (via NodeSource) if a suitable one isn't already present, plus
  `git` / `curl`.
- Creates a dedicated unprivileged `countroster` system user (no login shell).
- Clones to `/opt/countroster/src`, builds core → web → server, and installs the
  unit at `/etc/systemd/system/countroster.service` (reference copy:
  [`deploy/countroster.service`](../deploy/countroster.service)). The unit is
  hardened (`ProtectSystem=strict`, `ProtectHome=true`, `NoNewPrivileges=true`,
  `ReadWritePaths=/var/lib/countroster`).
- Enables it for boot and starts it, serving the API + PWA on
  `http://<host>:8787`.

### Non-disruptive upgrades, no data loss — the design guarantee

| Concern | How the installer handles it |
|---|---|
| Data lives apart from code | DB at `/var/lib/countroster/countroster.sqlite`; the source tree at `/opt/countroster/src` can be rebuilt/replaced freely. |
| Consistent backup | On upgrade it **stops the service first**, then snapshots the DB (`+ -wal/-shm`) to `…/backups/countroster-<timestamp>.sqlite` (keeps the newest `BACKUP_KEEP`, default 10). |
| No downtime on a bad build | The new version is compiled while the old one keeps serving; a build failure never touches the running service. |
| Self-healing bad release | After restart it polls `/api/health`; if unhealthy it **rolls back** to the previous commit, **restores the pre-upgrade snapshot**, and restarts. |
| Schema changes | Applied by the core's append-only, idempotent migration runner on startup (additive; older data stays readable — see §6). |

Override defaults with env vars: `PORT`, `HOST`, `COUNTROSTER_REF`,
`COUNTROSTER_REPO`, `COUNTROSTER_DATA_DIR`, `COUNTROSTER_PREFIX`,
`COUNTROSTER_USER`, `INSTALL_NODE` (`auto`/`never`), `BACKUP_KEEP`. E.g. pin a tag
on port 9090:

```bash
curl -fsSL …/scripts/quickstart.sh | sudo PORT=9090 COUNTROSTER_REF=v0.2.0 bash
```

Manage it with the usual systemd verbs:

```bash
systemctl status  countroster
systemctl restart countroster
journalctl -u countroster -f
```

Still **no auth** — keep it on a trusted network. For HTTPS + "Add to Home
Screen", front it with Tailscale Serve or a reverse proxy (Caddy / nginx).

## 5. Installing the PWA on a device

Once the server is reachable over HTTPS (or `http://localhost`), open it in a
browser and use the browser's **Install app** / **Add to Home Screen** prompt. The
app then runs in its own window with no browser chrome — close enough to a native
app on both desktop and mobile. vite-plugin-pwa supplies the manifest and service
worker; the service worker must **not** cache `/api`.

## 6. Updates & schema migrations

Updating is just deploying new code: rebuild and restart the process (the systemd
quickstart does this for you, with a snapshot + health-checked rollback). On
startup the server runs the core's migration runner against the SQLite file.

The migration rules (see [`DESIGN.md`](./DESIGN.md) §6.4, §8):

- Migrations are **append-only** and applied **in order** on startup; skipping
  versions is fine — the runner catches up.
- A backup taken on an **older** schema restores fine onto a newer server —
  unknown-to-the-bundle columns fall back to their SQL defaults.
- A backup taken on a **newer** schema is **refused** by an older server with a
  clear error. This is by design — the older code doesn't know the newer schema.

Keep migrations strictly additive (`CREATE TABLE`, `ADD COLUMN`) until you've
shipped enough versions to be confident. Destructive migrations (`DROP COLUMN`,
type changes) are fine eventually, but the floor for safe reasoning is "older code
can still read newer data" — which only holds if you don't reuse column names.

## 7. CI/CD

A reasonable GitHub Actions setup:

- **On every PR:** `npm test`, `npm run typecheck`, `npm run build` across the
  monorepo.
- **On push to `main` / a release tag:** build the three workspaces and ship the
  server (e.g. SSH + `systemctl restart`, or rebuild and restart your container).
  On a systemd host, re-running [`scripts/quickstart.sh`](../scripts/quickstart.sh)
  *is* the deploy — it rebuilds, snapshots, and health-checks with rollback.

Because the deployable artifact is a single Node process plus a SQLite file, there
are no store-review queues or signing keys in the release path.

## 8. License obligation (AGPL §13)

CountRoster is `AGPL-3.0-only`. If you deploy a **modified** version that other
people use over a network, you must offer those users the complete corresponding
source of your modified version (for example, a "Source" link to your fork).
Running an *unmodified* build for yourself or your household carries no extra
obligation. See [`LICENSE`](../LICENSE) and [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## 9. Explicitly not covered here

- **Authentication / multi-tenant access control.** The server assumes a trusted
  network; put a reverse proxy with auth in front if you need more.
- **In-app purchases / subscriptions, analytics, crash reporting.** Out of scope
  (DESIGN §2 non-goals).
- **Native app store distribution.** Retired with the local-first model; the PWA
  covers mobile + desktop.
