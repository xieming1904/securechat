#!/usr/bin/env bash
# Daily backup: consistent DB snapshot + attachments (hard-linked, so unchanged files cost no space).
# Keeps the last $KEEP_DAYS snapshots. The .env (login key) is kept separately in /root.
set -euo pipefail
. "$(dirname "$0")/common.sh"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }

TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
SNAP="$BACKUP_DIR/$TS"
WORK="$BACKUP_DIR/.partial-$TS"
PREV=$(ls -1d "$BACKUP_DIR"/2*/ 2>/dev/null | sort | tail -1 || true)
TMP=$(mktemp -d /tmp/securechat-bk.XXXXXX)
chown "$RUN_USER" "$TMP"
cleanup() { safe_rmtree "$TMP"; [ -d "$WORK" ] && safe_rmtree "$WORK"; return 0; }
trap cleanup EXIT

# 1) database: online snapshot taken as the app user (so no root-owned -wal/-shm files appear)
[ ! -L "$APP_DIR/data" ] && [ ! -L "$APP_DIR/data/blobs" ] || { echo "✘ data 或 data/blobs 是符号链接，可能被人动过手脚，已停止备份"; exit 1; }
as_app env DATA_DIR="$APP_DIR/data" node "$APP_DIR/server/dist/scripts/backup-db.js" "$TMP/app.db" >/dev/null
mkdir -p "$WORK"
mv "$TMP/app.db" "$WORK/app.db"

# 2) attachments: start from the previous snapshot's hard links, then sync changes
if [ -n "$PREV" ] && [ -d "$PREV/blobs" ]; then cp -al "$PREV/blobs" "$WORK/blobs"; fi
mkdir -p "$WORK/blobs"
as_app mkdir -p "$APP_DIR/data/blobs"
rsync -a --delete "$APP_DIR/data/blobs/" "$WORK/blobs/"
app_version > "$WORK/app-version"
mv "$WORK" "$SNAP"

# 3) .env holds the OPAQUE login key — without it nobody can log in after a restore. Keep a copy outside the data backups.
backup_env || log "⚠ .env 没有备份（原因见上一行）"

# marker for the app's "backup is stale" admin alert
write_marker .last-backup "$(date +%s)"

# 4) rotate
ls -1d "$BACKUP_DIR"/2*/ 2>/dev/null | sort | head -n -"$KEEP_DAYS" | while read -r old; do safe_rmtree "$old"; done

# markers for the admin page ("备份" tab): size / count / total of the local backups, off-site target
write_marker .backup-info "{\"size\":\"$(du -sh "$SNAP" | cut -f1)\",\"count\":$(ls -1d "$BACKUP_DIR"/2*/ | wc -l),\"total\":\"$(du -sh "$BACKUP_DIR" | cut -f1)\"}"
write_marker .offsite-remote "${OFFSITE_REMOTE:-}"

# 5) off-site copy (optional, see ops/setup-offsite.sh)
if [ -n "${OFFSITE_REMOTE:-}" ]; then
  if bash "$(dirname "$0")/offsite.sh"; then
    write_marker .offsite-failed 0
  else
    write_marker .offsite-failed "$(date +%s)"
    log "⚠ 异地备份上传失败（本地备份不受影响），查看: journalctl -u securechat-backup"
  fi
fi

log "✔ 备份完成: $SNAP（$(du -sh "$SNAP" | cut -f1)），共 $(ls -1d "$BACKUP_DIR"/2*/ | wc -l) 份，总占用 $(du -sh "$BACKUP_DIR" | cut -f1)"
