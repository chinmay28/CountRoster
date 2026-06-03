# CountRoster on a Raspberry Pi 4 — Quick Start

Run CountRoster on a Raspberry Pi 4 as an always-on **systemd service**: one Node
process that serves both the REST API and the installable PWA on a single origin.
Your data is a single SQLite file kept **outside** the app, so upgrading to a new
version is a one-liner and never loses data.

> **Heads up — no auth by design.** CountRoster has no accounts. Anyone who can
> reach the port can read and write everything. Run it on a trusted network only
> (your LAN, a [Tailscale](https://tailscale.com) tailnet, or a VPN). Don't put
> it on the open internet.

## Requirements

- Raspberry Pi 4 (2 GB RAM is enough; 4 GB+ makes the build comfier).
- **64-bit Raspberry Pi OS** (Bookworm) or Debian/Ubuntu. The installer pulls
  **Node.js 22**, required for the built-in `node:sqlite`.
- Network reachability to the Pi from the devices you'll use it on.

## Install (one command)

From the Pi (SSH in first), either pipe the installer straight from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/chinmay28/countroster/main/deploy/raspberry-pi/install.sh | sudo bash
```

…or clone and run it locally:

```bash
git clone https://github.com/chinmay28/countroster.git
sudo ./countroster/deploy/raspberry-pi/install.sh
```

The installer is idempotent (safe to re-run) and:

1. Installs `git`, `curl`, and **Node.js 22** (via NodeSource) if missing.
2. Creates a locked-down system user `countroster`.
3. Checks out the repo to **`/opt/countroster`** and builds core → web → server.
4. Creates the data dir **`/var/lib/countroster`** (your database lives here).
5. Writes config to **`/etc/countroster/countroster.env`**.
6. Installs, enables, and starts the **`countroster`** systemd service.
7. Waits for `GET /api/health` and prints the URL.

When it finishes you'll see something like:

```
==> CountRoster is running 🎉

  Local:   http://127.0.0.1:8787
  Network: http://192.168.1.42:8787
```

Open the **Network** URL on your phone or laptop and use the browser's
**"Add to Home Screen" / "Install app"** to get the PWA.

> **Installable PWA needs HTTPS.** Browsers only offer "Install" / enable the
> service worker on a secure context (`https://` or `localhost`). Over plain
> `http://<pi-ip>` the app works fine in the browser but won't install. The
> easiest fix is **Tailscale Serve** (`tailscale serve --bg 8787`), which gives
> you an HTTPS `*.ts.net` URL with a real cert. A reverse proxy (Caddy/nginx +
> Let's Encrypt) also works.

## Update to a new version (no data loss)

```bash
sudo /opt/countroster/deploy/raspberry-pi/update.sh
```

This is the seamless upgrade path:

1. **Snapshots your database first** — a consistent single-file copy via SQLite
   `VACUUM INTO`, taken with zero downtime, into
   `/var/lib/countroster/backups/` (last 10 kept).
2. **Pulls the latest code and rebuilds.** The running server keeps serving the
   old build throughout — if the build fails, nothing is touched and you stay on
   the old version.
3. **Restarts the service.** [Schema migrations run automatically on
   startup](../../CLAUDE.md) and are **append-only**, so your existing data is
   migrated in place — never recreated, never wiped.

Because the database lives in `/var/lib/countroster`, **outside** the
`/opt/countroster` checkout, pulling new code and reinstalling dependencies
physically cannot touch your data.

Pin a branch or keep more backups via env vars:

```bash
sudo BRANCH=main KEEP_BACKUPS=30 /opt/countroster/deploy/raspberry-pi/update.sh
```

## Managing the service

```bash
sudo systemctl status countroster      # is it running?
sudo systemctl restart countroster     # restart (e.g. after editing the env file)
sudo systemctl stop countroster        # stop
sudo journalctl -u countroster -f      # live logs
```

## Configuration

Edit `/etc/countroster/countroster.env`, then `sudo systemctl restart countroster`:

| Var              | Default                                  | Meaning                                   |
|------------------|------------------------------------------|-------------------------------------------|
| `PORT`           | `8787`                                   | Port to listen on.                        |
| `HOST`           | `0.0.0.0`                                | Bind address (`0.0.0.0` = LAN-reachable). |
| `COUNTROSTER_DB` | `/var/lib/countroster/countroster.sqlite`| The SQLite database file.                 |
| `WEB_DIST`       | the app's own `apps/web/dist`            | Built PWA to serve (rarely changed).      |

See [`countroster.env.example`](./countroster.env.example) for an annotated copy.

The installer accepts the same names as env vars to change the layout, e.g.
`sudo PORT=9000 APP_DIR=/srv/countroster ./install.sh`.

## Backups & restore

Every `update.sh` run leaves a timestamped snapshot in
`/var/lib/countroster/backups/`. To take one on demand at any time:

```bash
sudo -u countroster node -e '
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync("/var/lib/countroster/countroster.sqlite");
  const dest = "/var/lib/countroster/backups/manual-" + Date.now() + ".sqlite";
  db.exec("VACUUM INTO " + String.fromCharCode(39) + dest + String.fromCharCode(39));
  db.close();
'
```

You can also use the in-app **Data** page (bundle or raw SQLite export), or the
API: `curl -O http://<pi>:8787/api/backup/sqlite`.

To restore a snapshot:

```bash
sudo systemctl stop countroster
sudo cp /var/lib/countroster/backups/countroster-YYYYMMDD-HHMMSS.sqlite \
        /var/lib/countroster/countroster.sqlite
sudo rm -f /var/lib/countroster/countroster.sqlite-wal \
           /var/lib/countroster/countroster.sqlite-shm
sudo chown countroster:countroster /var/lib/countroster/countroster.sqlite
sudo systemctl start countroster
```

> A snapshot taken on an **older** app version restores cleanly onto a **newer**
> one — migrations run on startup. A snapshot from a **newer** version is
> refused by an older app, by design (see [DEPLOYMENT.md](../../DEPLOYMENT.md)
> → "Schema migrations across versions").

## Uninstall

```bash
sudo systemctl disable --now countroster
sudo rm /etc/systemd/system/countroster.service && sudo systemctl daemon-reload
sudo rm -rf /opt/countroster /etc/countroster
# Keep /var/lib/countroster if you want your data; otherwise:
# sudo rm -rf /var/lib/countroster
sudo userdel countroster   # optional
```

## Troubleshooting

- **Service won't start / unhealthy:** `sudo journalctl -u countroster -n 80`.
- **Build runs out of memory on a 2 GB Pi:** add swap
  (`sudo dphys-swapfile swapoff; sudoedit /etc/dphys-swapfile` → `CONF_SWAPSIZE=1024`;
  `sudo dphys-swapfile setup; sudo dphys-swapfile swapon`) and re-run.
- **Can't install the PWA:** you're on plain `http://`. Use HTTPS via Tailscale
  Serve or a reverse proxy (see the install note above).
- **`node:sqlite` / Node too old:** confirm `node -v` is ≥ 22. Re-run `install.sh`
  to upgrade.
