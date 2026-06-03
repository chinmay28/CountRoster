#!/usr/bin/env bash
#
# CountRoster — one-shot installer for Raspberry Pi 4 (64-bit Raspberry Pi OS /
# Debian) as a systemd service.
#
#   curl -fsSL https://raw.githubusercontent.com/chinmay28/countroster/main/deploy/raspberry-pi/install.sh | sudo bash
#
# or, from a checkout:
#
#   sudo ./deploy/raspberry-pi/install.sh
#
# Idempotent: safe to re-run. To update an existing install to a new version,
# use update.sh instead (it backs up your data first).
#
# Override any default by exporting the matching env var before running, e.g.
#   sudo PORT=9000 BRANCH=main ./deploy/raspberry-pi/install.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/countroster}"
DATA_DIR="${DATA_DIR:-/var/lib/countroster}"
ENV_DIR="${ENV_DIR:-/etc/countroster}"
ENV_FILE="${ENV_FILE:-$ENV_DIR/countroster.env}"
SERVICE_USER="${SERVICE_USER:-countroster}"
SERVICE_NAME="${SERVICE_NAME:-countroster}"
REPO_URL="${REPO_URL:-https://github.com/chinmay28/countroster.git}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
DB_PATH="${COUNTROSTER_DB:-$DATA_DIR/countroster.sqlite}"
NODE_MAJOR="${NODE_MAJOR:-22}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (use sudo)."

# --- 1. System packages --------------------------------------------------------
log "Installing prerequisites (git, curl, ca-certificates)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null

# --- 2. Node.js (>= $NODE_MAJOR, for the built-in node:sqlite) ------------------
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
else
  log "Node.js $(node -v) already present — skipping."
fi
[ "$(node_major)" -ge "$NODE_MAJOR" ] || die "Node >= $NODE_MAJOR is required for node:sqlite."

# --- 3. Service user -----------------------------------------------------------
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user '$SERVICE_USER'…"
  useradd --system --create-home --home-dir "/home/$SERVICE_USER" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# --- 4. Source checkout --------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing checkout at $APP_DIR…"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout -q "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "Cloning $REPO_URL ($BRANCH) into $APP_DIR…"
  mkdir -p "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# --- 5. Build (core → web → server) as the service user ------------------------
log "Installing dependencies and building (this takes a few minutes on a Pi)…"
sudo -u "$SERVICE_USER" bash -euc "
  cd '$APP_DIR'
  npm ci
  npm run build --workspace @countroster/core
  npm run build --workspace @countroster/web
  npm run build --workspace @countroster/server
"
[ -f "$APP_DIR/apps/server/dist/server.js" ] || die "Build did not produce apps/server/dist/server.js."

# --- 6. Data directory ---------------------------------------------------------
log "Creating data directory $DATA_DIR…"
mkdir -p "$DATA_DIR" "$DATA_DIR/backups"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# --- 7. Config (never clobber an existing env file) ----------------------------
mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  log "Writing $ENV_FILE…"
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
HOST=$HOST
COUNTROSTER_DB=$DB_PATH
EOF
else
  log "Keeping existing $ENV_FILE."
fi

# --- 8. systemd unit -----------------------------------------------------------
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
log "Installing systemd unit $UNIT…"
cat > "$UNIT" <<EOF
[Unit]
Description=CountRoster server (API + PWA)
Documentation=https://github.com/chinmay28/countroster
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node apps/server/dist/server.js
Restart=on-failure
RestartSec=3
ReadWritePaths=$DATA_DIR
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

# --- 9. Health check -----------------------------------------------------------
log "Waiting for the service to come up…"
for _ in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    log "CountRoster is running 🎉"
    echo
    echo "  Local:   http://127.0.0.1:$PORT"
    [ -n "${IP:-}" ] && echo "  Network: http://$IP:$PORT"
    echo
    echo "  Logs:    sudo journalctl -u $SERVICE_NAME -f"
    echo "  Update:  sudo $APP_DIR/deploy/raspberry-pi/update.sh"
    echo "  Data:    $DB_PATH"
    exit 0
  fi
  sleep 1
done

die "Service did not become healthy. Check: sudo journalctl -u $SERVICE_NAME -n 50"
