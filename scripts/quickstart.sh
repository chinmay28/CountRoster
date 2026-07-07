#!/usr/bin/env bash
#
# CountRoster — Linux quick-start installer (Ubuntu / Debian / Raspberry Pi OS).
#
# One command, run as root, installs CountRoster as a hardened systemd service:
#
#   curl -fsSL https://raw.githubusercontent.com/chinmay28/countroster/main/scripts/quickstart.sh | sudo bash
#
# It is deliberately *non-disruptive* and *data-safe* — re-run it any time to
# upgrade in place:
#
#   * Idempotent. Re-running only swaps in newer code; it never re-initialises data.
#   * The live SQLite database lives at a stable path OUTSIDE the source tree
#     ($DATA_DIR), so cloning, rebuilding, or pulling can never clobber it.
#   * Every upgrade STOPS the service, snapshots the database (+ WAL/SHM sidecars)
#     to a timestamped backup, THEN swaps code in — so a backup is always taken
#     against a quiesced database.
#   * The new build is compiled while the old version keeps serving. If the build
#     fails, the running service is left untouched.
#   * After restart we poll /api/health; if the new version is unhealthy we ROLL
#     BACK to the previous commit, restore the pre-upgrade database snapshot, and
#     restart — so a bad upgrade self-heals to the last good state with its data.
#   * Schema changes are applied by the server's append-only, idempotent migration
#     runner on startup (additive only; older data stays readable).
#
# The deployed artifact is a single static Go binary that embeds the built PWA.
# Node is only needed at BUILD time (to compile the web client with Vite);
# the running service has no Node, npm, or JS runtime dependency.
#
# Configure via environment variables (all optional):
#
#   COUNTROSTER_REPO      git URL to clone        (default: https://github.com/chinmay28/countroster.git)
#   COUNTROSTER_REF       branch/tag/commit       (default: main)
#   COUNTROSTER_USER      service system user     (default: countroster)
#   COUNTROSTER_PREFIX    install prefix          (default: /opt/countroster; source → $PREFIX/src)
#   COUNTROSTER_DATA_DIR  database + backups dir  (default: /var/lib/countroster)
#   PORT                  port to listen on       (default: 8787)
#   HOST                  bind address            (default: 0.0.0.0)
#   INSTALL_NODE          auto | never            install Node 22 if missing/old (default: auto; build-time only)
#   INSTALL_GO            auto | never            install Go if missing/old (default: auto; build-time only)
#   BACKUP_KEEP           pre-upgrade backups kept (default: 10)
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
  C_RED=$'\033[1;31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''; C_OFF=''
fi
log()  { printf '%s==>%s %s\n' "$C_BLUE" "$C_OFF" "$*"; }
ok()   { printf '%s ok %s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die()  { printf '%serr %s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
step() { printf '\n%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }

# ---------------------------------------------------------------------------
# Must be root (system-wide service + dedicated user, à la HomeAPI)
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  die "Run as root: curl -fsSL .../quickstart.sh | sudo bash   (or: sudo ./scripts/quickstart.sh)"
fi
command -v systemctl >/dev/null 2>&1 || die "systemd is required (no systemctl found)."

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
COUNTROSTER_REPO="${COUNTROSTER_REPO:-https://github.com/chinmay28/countroster.git}"
COUNTROSTER_REF="${COUNTROSTER_REF:-main}"
SVC_USER="${COUNTROSTER_USER:-countroster}"
PREFIX="${COUNTROSTER_PREFIX:-/opt/countroster}"
DATA_DIR="${COUNTROSTER_DATA_DIR:-/var/lib/countroster}"
PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
INSTALL_NODE="${INSTALL_NODE:-auto}"
INSTALL_GO="${INSTALL_GO:-auto}"
BACKUP_KEEP="${BACKUP_KEEP:-10}"

SRC_DIR="$PREFIX/src"
DB_PATH="$DATA_DIR/countroster.sqlite"
BACKUP_DIR="$DATA_DIR/backups"
SERVICE_NAME="countroster"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
# Minimum Go release that can bootstrap the build; the go directive in
# server/go.mod pins the real toolchain, which Go fetches automatically.
GO_MIN_MINOR=21
GO_INSTALL_VERSION="1.25.0"

# If this script is being run from inside an existing checkout (sudo ./scripts/
# quickstart.sh) rather than piped from curl, build that checkout in place.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
LOCAL_CHECKOUT=""
if git -C "$SELF_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
  top="$(git -C "$SELF_DIR" rev-parse --show-toplevel)"
  if [ -f "$top/package.json" ] && grep -q '"name": *"countroster"' "$top/package.json" 2>/dev/null; then
    LOCAL_CHECKOUT="$top"
    SRC_DIR="$top"   # build & serve from where the user already cloned
  fi
fi

SERVER_BIN="$SRC_DIR/server/bin/countroster"
WEBDIST_DIR="$SRC_DIR/server/cmd/countroster/webdist"

log "CountRoster quick start"
printf '  %-10s %s\n' "source"   "$SRC_DIR"
printf '  %-10s %s\n' "data"     "$DATA_DIR"
printf '  %-10s %s\n' "database" "$DB_PATH"
printf '  %-10s %s\n' "service"  "${SERVICE_NAME}.service (user: $SVC_USER)"
printf '  %-10s %s\n' "listen"   "http://$HOST:$PORT"

# Run npm/git/go as the service user so the tree stays owned by them, and so the
# build matches the runtime account. Falls back to plain exec before the user exists.
as_svc() {
  if id -u "$SVC_USER" >/dev/null 2>&1; then
    # Build needs devDependencies → make sure NODE_ENV isn't 'production'.
    sudo -u "$SVC_USER" --preserve-env=PATH env -u NODE_ENV "$@"
  else
    env -u NODE_ENV "$@"
  fi
}

# ---------------------------------------------------------------------------
# 1. Prerequisites: git, curl, Node >= 20 (web build) and Go >= 1.21 (server)
# ---------------------------------------------------------------------------
step "[1/7] Prerequisites"

APT=0; command -v apt-get >/dev/null 2>&1 && APT=1
ensure_pkg() {
  command -v "$1" >/dev/null 2>&1 && return 0
  [ "$APT" -eq 1 ] || die "'$1' missing and no apt-get to install it. Install it and re-run."
  log "installing $1…"; apt-get update -y >/dev/null; apt-get install -y "$1" >/dev/null
}
ensure_pkg git
ensure_pkg curl
ok "git $(git --version | awk '{print $3}'), curl present"

node_ok=0
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 20 ] && node_ok=1
fi
if [ "$node_ok" -eq 1 ]; then
  ok "node $(node --version) (build-time only — the PWA compiles with Vite)"
else
  command -v node >/dev/null 2>&1 \
    && warn "node $(node --version) is too old; the web build needs Node >= 20." \
    || warn "Node.js not found (needed only to build the web client)."
  [ "$INSTALL_NODE" = never ] && die "Install Node >= 20 (https://github.com/nodesource/distributions) and re-run, or set INSTALL_NODE=auto."
  [ "$APT" -eq 1 ] || die "Automatic Node install needs apt. Install Node >= 20 manually and re-run."
  log "installing Node 22 via NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs >/dev/null
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "${major:-0}" -ge 20 ] || die "Node install did not yield >= 20 (got $(node --version))."
  ok "node $(node --version) installed"
fi

go_ok=0
GO_BIN="$(command -v go || true)"
[ -z "$GO_BIN" ] && [ -x /usr/local/go/bin/go ] && GO_BIN=/usr/local/go/bin/go
if [ -n "$GO_BIN" ]; then
  go_minor="$("$GO_BIN" env GOVERSION 2>/dev/null | sed -E 's/^go1\.([0-9]+).*/\1/' || echo 0)"
  [ "${go_minor:-0}" -ge "$GO_MIN_MINOR" ] && go_ok=1
fi
if [ "$go_ok" -eq 1 ]; then
  ok "$("$GO_BIN" version | awk '{print $3}') (newer toolchains fetch automatically per go.mod)"
else
  [ -n "$GO_BIN" ] \
    && warn "$("$GO_BIN" version 2>/dev/null | awk '{print $3}') is too old; CountRoster needs Go >= 1.$GO_MIN_MINOR." \
    || warn "Go not found (needed to build the server binary)."
  [ "$INSTALL_GO" = never ] && die "Install Go >= 1.$GO_MIN_MINOR (https://go.dev/dl) and re-run, or set INSTALL_GO=auto."
  case "$(uname -m)" in
    x86_64)          go_arch=amd64 ;;
    aarch64 | arm64) go_arch=arm64 ;;
    armv6l | armv7l) go_arch=armv6l ;;
    *) die "Unsupported architecture $(uname -m) for automatic Go install; install Go manually and re-run." ;;
  esac
  log "installing Go $GO_INSTALL_VERSION ($go_arch) to /usr/local/go…"
  curl -fsSL "https://go.dev/dl/go${GO_INSTALL_VERSION}.linux-${go_arch}.tar.gz" -o /tmp/countroster-go.tgz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/countroster-go.tgz
  rm -f /tmp/countroster-go.tgz
  GO_BIN=/usr/local/go/bin/go
  ok "$("$GO_BIN" version | awk '{print $3}') installed"
fi
GO_DIR="$(dirname "$GO_BIN")"

# ---------------------------------------------------------------------------
# 2. Dedicated system user (home = data dir, no login shell)
# ---------------------------------------------------------------------------
step "[2/7] Service user '$SVC_USER'"
if id -u "$SVC_USER" >/dev/null 2>&1; then
  ok "user '$SVC_USER' already exists"
else
  nologin="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --home-dir "$DATA_DIR" --create-home --shell "$nologin" "$SVC_USER"
  ok "created system user '$SVC_USER'"
fi

# ---------------------------------------------------------------------------
# 3. Source: clone or update (data is elsewhere, never touched here)
# ---------------------------------------------------------------------------
step "[3/7] Source at $SRC_DIR"

# Detect upgrade BEFORE we change anything, so we know whether to back up / roll back.
UPGRADE=0
{ [ -f "$DB_PATH" ] || [ -f "$UNIT_PATH" ]; } && UPGRADE=1

PREV_SHA=""
if [ -n "$LOCAL_CHECKOUT" ]; then
  warn "building your existing checkout in place (no git fetch)."
  PREV_SHA="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)"
  ok "source at ${PREV_SHA:0:12}"
elif [ -d "$SRC_DIR/.git" ]; then
  PREV_SHA="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)"
  log "updating to $COUNTROSTER_REF…"
  as_svc git -C "$SRC_DIR" fetch --depth 1 origin "$COUNTROSTER_REF"
  as_svc git -C "$SRC_DIR" checkout -q -B deploy FETCH_HEAD
  ok "updated $( [ -n "$PREV_SHA" ] && echo "${PREV_SHA:0:12} → " )$(git -C "$SRC_DIR" rev-parse --short HEAD)"
else
  log "cloning $COUNTROSTER_REPO (ref: $COUNTROSTER_REF)…"
  mkdir -p "$PREFIX"
  git clone --depth 1 --branch "$COUNTROSTER_REF" "$COUNTROSTER_REPO" "$SRC_DIR" \
    || git clone --depth 1 "$COUNTROSTER_REPO" "$SRC_DIR"
  chown -R "$SVC_USER" "$PREFIX"
  ok "cloned to $SRC_DIR"
fi
chown -R "$SVC_USER" "$SRC_DIR" 2>/dev/null || true
[ -f "$SRC_DIR/package.json" ] || die "no package.json at $SRC_DIR — checkout failed?"

# ---------------------------------------------------------------------------
# 4. Build (server keeps running on the old binary while we compile)
# ---------------------------------------------------------------------------
step "[4/7] Build (core → web → static Go binary)"
# is_go_tree: the checkout carries the Go server (a rollback may land on an
# older, Node-based commit — build and unit generation adapt to either shape).
is_go_tree() { [ -d "$SRC_DIR/server/cmd/countroster" ]; }

build_src() {
  cd "$SRC_DIR"
  if [ -f package-lock.json ]; then as_svc npm ci; else as_svc npm install; fi
  as_svc npm run build --workspace @countroster/core
  as_svc npm run build --workspace @countroster/web
  if is_go_tree; then
    # Embed the built PWA into the server binary: one artifact, one process.
    find "$WEBDIST_DIR" -mindepth 1 ! -name README.txt -delete 2>/dev/null || true
    mkdir -p "$WEBDIST_DIR"
    cp -r "$SRC_DIR/apps/web/dist/." "$WEBDIST_DIR/"
    chown -R "$SVC_USER" "$WEBDIST_DIR" 2>/dev/null || true
    # CGO_ENABLED=0 → fully static binary (the SQLite driver is pure Go).
    as_svc env PATH="$GO_DIR:$PATH" CGO_ENABLED=0 \
      sh -c "cd '$SRC_DIR/server' && go build -trimpath -ldflags '-s -w' -o '$SERVER_BIN' ./cmd/countroster"
    [ -x "$SERVER_BIN" ] || die "build produced no server binary"
  else
    # Legacy (pre-Go) tree: the deployable unit is the compiled Node server.
    as_svc npm run build --workspace @countroster/server
    [ -f "$SRC_DIR/apps/server/dist/server.js" ] || die "build produced no server.js"
  fi
}
build_src
if is_go_tree; then ok "build complete → $SERVER_BIN"; else ok "build complete (legacy Node server)"; fi

# ---------------------------------------------------------------------------
# 5. Data dir + pre-upgrade database snapshot
# ---------------------------------------------------------------------------
step "[5/7] Data directory + backup"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 750 "$DATA_DIR" "$BACKUP_DIR"
ok "data dir ready ($DATA_DIR, owned by $SVC_USER)"

stop_service()  { systemctl stop  "${SERVICE_NAME}.service" 2>/dev/null || true; }
start_service() { systemctl start "${SERVICE_NAME}.service"; }

SNAP=""
if [ "$UPGRADE" -eq 1 ] && [ -f "$DB_PATH" ]; then
  # Quiesce first so the snapshot is consistent (no live WAL writers).
  stop_service
  ts="$(date +%Y%m%d-%H%M%S)"
  SNAP="$BACKUP_DIR/countroster-$ts.sqlite"
  cp "$DB_PATH" "$SNAP"
  for ext in -wal -shm; do [ -f "${DB_PATH}${ext}" ] && cp "${DB_PATH}${ext}" "${SNAP}${ext}"; done
  chown "$SVC_USER":"$SVC_USER" "$SNAP"* 2>/dev/null || true
  ok "database backed up → $SNAP"
  # Prune, keeping the newest $BACKUP_KEEP.
  if [ "$BACKUP_KEEP" -gt 0 ]; then
    ls -1t "$BACKUP_DIR"/countroster-*.sqlite 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
      rm -f "$old" "${old}-wal" "${old}-shm"
    done
  fi
fi

# ---------------------------------------------------------------------------
# 6. systemd unit + (re)start
# ---------------------------------------------------------------------------
step "[6/7] systemd service"
write_unit() {
  if is_go_tree; then
    exec_start="$SERVER_BIN"
    env_extra=""
  else
    exec_start="$(command -v node) $SRC_DIR/apps/server/dist/server.js"
    env_extra="Environment=NODE_ENV=production"$'\n'
  fi
  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=CountRoster — anything tracker (REST API + PWA)
Documentation=https://github.com/chinmay28/countroster
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$SRC_DIR
ExecStart=$exec_start
${env_extra}Environment=COUNTROSTER_DB=$DB_PATH
Environment=PORT=$PORT
Environment=HOST=$HOST
Restart=on-failure
RestartSec=3

# Hardening — safe on a trusted LAN, defensive if exposure ever widens.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
}
write_unit
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
start_service
ok "service enabled and started"

# ---------------------------------------------------------------------------
# 7. Health check (with rollback on a failed upgrade)
# ---------------------------------------------------------------------------
step "[7/7] Health check"
health_url="http://127.0.0.1:$PORT/api/health"
check_health() {
  for _ in $(seq 1 30); do
    curl -fsS "$health_url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

if check_health; then
  ok "healthy ($health_url)"
else
  warn "new version failed its health check."
  if [ "$UPGRADE" -eq 1 ] && [ -n "$PREV_SHA" ] && [ -z "$LOCAL_CHECKOUT" ]; then
    warn "rolling back to ${PREV_SHA:0:12} and restoring the pre-upgrade database…"
    stop_service
    # Restore the snapshot taken before the new version ever started (so the older
    # code sees a schema it understands).
    if [ -n "$SNAP" ] && [ -f "$SNAP" ]; then
      cp "$SNAP" "$DB_PATH"
      for ext in -wal -shm; do
        [ -f "${SNAP}${ext}" ] && cp "${SNAP}${ext}" "${DB_PATH}${ext}" || rm -f "${DB_PATH}${ext}"
      done
      chown "$SVC_USER":"$SVC_USER" "$DB_PATH"* 2>/dev/null || true
    fi
    as_svc git -C "$SRC_DIR" checkout -q -B deploy "$PREV_SHA"
    build_src
    # The rolled-back commit may be the other implementation (Node ↔ Go);
    # regenerate the unit so ExecStart matches what was just built.
    write_unit
    systemctl daemon-reload
    start_service
    if check_health; then
      die "Upgrade failed health check — rolled back to ${PREV_SHA:0:12} with your data intact. Check: journalctl -u ${SERVICE_NAME} -n 80"
    fi
    die "Upgrade AND rollback both failed health checks. Data snapshot is safe at $SNAP. Inspect: journalctl -u ${SERVICE_NAME} -n 80"
  fi
  die "Service is not healthy. Inspect logs: journalctl -u ${SERVICE_NAME} -n 80 --no-pager"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; [ -n "$lan_ip" ] || lan_ip="<this-host>"
verb="installed"; [ "$UPGRADE" -eq 1 ] && verb="upgraded"

cat <<DONE

${C_GREEN}CountRoster $verb and running.${C_OFF}

  Open it:     http://$lan_ip:$PORT      (http://localhost:$PORT on this machine)
  Database:    $DB_PATH
  Backups:     $BACKUP_DIR
  Binary:      $SERVER_BIN (static; embeds the web client)
  Upgrade:     re-run this script — it swaps code in, backs up data, self-heals.

  Manage the service:
    systemctl status  ${SERVICE_NAME}
    systemctl restart ${SERVICE_NAME}
    journalctl -u ${SERVICE_NAME} -f
${C_DIM}
  No auth by design — keep this on a trusted network (LAN / Tailscale / VPN).
  For HTTPS + "Add to Home Screen", front it with Tailscale Serve or a reverse
  proxy (Caddy/nginx). See DEPLOYMENT.md.${C_OFF}
DONE
