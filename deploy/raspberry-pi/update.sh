#!/usr/bin/env bash
#
# CountRoster — update an existing Raspberry Pi install to the latest version,
# seamlessly and without data loss.
#
#   sudo /opt/countroster/deploy/raspberry-pi/update.sh
#
# What it does:
#   1. Snapshots the live database (VACUUM INTO — a consistent single-file copy,
#      taken with zero downtime) into $DATA_DIR/backups/.
#   2. Pulls the latest code and rebuilds core → web → server.
#      The running server keeps serving the old build until the rebuild succeeds.
#   3. Restarts the service. Schema migrations run automatically on startup and
#      are append-only, so your existing data is migrated in place, never wiped.
#
# Your database lives in $DATA_DIR, OUTSIDE the app checkout, so pulling new code
# and reinstalling dependencies can never touch it. If a build or restart fails,
# the pre-update snapshot in $DATA_DIR/backups/ restores you exactly (see below).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/countroster}"
DATA_DIR="${DATA_DIR:-/var/lib/countroster}"
ENV_FILE="${ENV_FILE:-/etc/countroster/countroster.env}"
SERVICE_USER="${SERVICE_USER:-countroster}"
SERVICE_NAME="${SERVICE_NAME:-countroster}"
BRANCH="${BRANCH:-main}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (use sudo)."
[ -d "$APP_DIR/.git" ] || die "No checkout at $APP_DIR — run install.sh first."

# Resolve the database path from the same env file the service uses.
DB_PATH="$DATA_DIR/countroster.sqlite"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set +u; . "$ENV_FILE"; set -u
  [ -n "${COUNTROSTER_DB:-}" ] && DB_PATH="$COUNTROSTER_DB"
fi

# --- 1. Backup the live database (consistent, no downtime) ---------------------
BACKUP_DIR="$DATA_DIR/backups"
mkdir -p "$BACKUP_DIR"
if [ -f "$DB_PATH" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP="$BACKUP_DIR/countroster-$STAMP.sqlite"
  log "Backing up database → $BACKUP"
  node -e '
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const q = String.fromCharCode(39);                       // a single quote
    const db = new DatabaseSync(process.argv[1]);
    const dest = process.argv[2].split(q).join(q + q);       // escape for SQL literal
    db.exec("VACUUM INTO " + q + dest + q);
    db.close();
  ' "$DB_PATH" "$BACKUP" 2>/dev/null || die "Backup failed — aborting before any change."
  chown "$SERVICE_USER:$SERVICE_USER" "$BACKUP"
  # Prune all but the most recent $KEEP_BACKUPS snapshots.
  ls -1t "$BACKUP_DIR"/countroster-*.sqlite 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
else
  log "No database yet at $DB_PATH — nothing to back up."
fi

# --- 2. Pull + rebuild (service keeps running on the old build) ----------------
log "Fetching latest code ($BRANCH)…"
git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
OLD_REV="$(git -C "$APP_DIR" rev-parse --short HEAD)"
git -C "$APP_DIR" checkout -q "$BRANCH"
git -C "$APP_DIR" reset --hard "origin/$BRANCH"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
NEW_REV="$(git -C "$APP_DIR" rev-parse --short HEAD)"

if [ "$OLD_REV" = "$NEW_REV" ]; then
  log "Already up to date ($NEW_REV). Rebuilding anyway to be safe."
else
  log "Updating $OLD_REV → $NEW_REV."
fi

log "Building core → web → server…"
sudo -u "$SERVICE_USER" bash -euc "
  cd '$APP_DIR'
  npm ci
  npm run build --workspace @countroster/core
  npm run build --workspace @countroster/web
  npm run build --workspace @countroster/server
"
[ -f "$APP_DIR/apps/server/dist/server.js" ] || die "Build failed — service untouched, still on $OLD_REV."

# --- 3. Restart (migrations run automatically on boot) -------------------------
log "Restarting service…"
systemctl restart "$SERVICE_NAME"

PORT="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-8787}"
for _ in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    log "Update complete — running $NEW_REV. ✅"
    exit 0
  fi
  sleep 1
done

cat >&2 <<EOF
$(printf '\033[1;31mError:\033[0m') Service did not become healthy after the update.
  Logs:    sudo journalctl -u $SERVICE_NAME -n 80
  Restore: sudo systemctl stop $SERVICE_NAME
           sudo cp "$(ls -1t "$BACKUP_DIR"/countroster-*.sqlite 2>/dev/null | head -1)" "$DB_PATH"
           sudo rm -f "$DB_PATH-wal" "$DB_PATH-shm"
           # then 'git -C $APP_DIR reset --hard $OLD_REV', rebuild, and start.
EOF
exit 1
