#!/usr/bin/env bash
# Upload the newest local backup to off-site object storage (Aliyun OSS / any S3 / WebDAV … via rclone).
# The upload is ONE file: tar of the snapshot (+ .env) encrypted with GnuPG (AES-256, integrity-protected) using the
# key in /root/securechat-offsite.key — the storage provider only ever sees ciphertext and can't tamper undetected.
# Configure once with: bash ops/setup-offsite.sh
set -euo pipefail
. "$(dirname "$0")/common.sh"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
: "${OFFSITE_REMOTE:?未配置异地备份（运行 ops/setup-offsite.sh）}"
OFFSITE_KEEP_DAYS=${OFFSITE_KEEP_DAYS:-30}
[[ $OFFSITE_KEEP_DAYS =~ ^[1-9][0-9]{0,3}$ ]] || { echo "OFFSITE_KEEP_DAYS 必须是 1–9999 的整数"; exit 1; }
KEY=/root/securechat-offsite.key
[ -s "$KEY" ] || { echo "缺少加密密钥 $KEY（运行 ops/setup-offsite.sh）"; exit 1; }
command -v rclone >/dev/null || { echo "未安装 rclone（运行 ops/setup-offsite.sh）"; exit 1; }
command -v gpg >/dev/null || { echo "未安装 gpg（运行 ops/setup-offsite.sh）"; exit 1; }

SNAP=$(ls -1d "$BACKUP_DIR"/2*/ 2>/dev/null | sort | tail -1)
[ -n "$SNAP" ] || { echo "还没有本地备份"; exit 1; }
NAME="securechat-$(basename "$SNAP").tar.gpg"
TMP=$(mktemp -d /tmp/securechat-offsite.XXXXXX)
trap 'safe_rmtree "$TMP"' EXIT

as_app cat "$APP_DIR/.env" > "$TMP/env" 2>/dev/null || true
tar cf - -C "$SNAP" . -C "$TMP" env \
  | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 \
      --force-mdc --passphrase-file "$KEY" --pinentry-mode loopback -o "$TMP/$NAME"
rclone copyto --retries 3 --low-level-retries 10 "$TMP/$NAME" "$OFFSITE_REMOTE/$NAME"
# keep the last N days off-site
rclone delete --min-age "${OFFSITE_KEEP_DAYS}d" --include 'securechat-*.tar.gpg' "$OFFSITE_REMOTE" 2>/dev/null || true
write_marker .last-offsite "$(date +%s)"
log "✔ 异地备份已上传：$OFFSITE_REMOTE/$NAME（$(du -h "$TMP/$NAME" | cut -f1)）"
