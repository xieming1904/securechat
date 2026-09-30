#!/usr/bin/env bash
# Restore drill: restore the newest backup into a throw-away copy, check it, and boot a temporary server on it
# with the current code + .env (proves backup and login key work together). Touches nothing live.
set -euo pipefail
. "$(dirname "$0")/common.sh"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }

SNAP=${1:-$(ls -1d "$BACKUP_DIR"/2*/ 2>/dev/null | sort | tail -1)}
if [ -z "$SNAP" ] || [ ! -f "$SNAP/app.db" ]; then echo "没有可用的备份"; exit 1; fi
log "演练恢复: $SNAP"

T=$(mktemp -d /tmp/securechat-drill.XXXXXX)
SP=""
cleanup() {
  [ -n "$SP" ] && kill "$SP" 2>/dev/null
  pkill -u "$RUN_USER" -f -- "--env-file=$APP_DIR/.env $APP_DIR/server/dist/src/index.js" 2>/dev/null
  safe_rmtree "$T"; return 0
}
trap cleanup EXIT
cp -a "$SNAP/app.db" "$T/app.db"
cp -al "$SNAP/blobs" "$T/blobs" 2>/dev/null || cp -a "$SNAP/blobs" "$T/blobs"
chown -R "$RUN_USER" "$T"

as_app node "$APP_DIR/server/dist/scripts/verify-backup.js" "$T"

# .env is read by Node as the app user (root never sources a file the web user can edit); the explicit settings win
as_app env NODE_ENV=production PORT=3999 HOST=127.0.0.1 DATA_DIR="$T" WEB_DIST="$APP_DIR/web/dist" \
  LOG_LEVEL=warn node --env-file="$APP_DIR/.env" "$APP_DIR/server/dist/src/index.js" >"$T/drill.log" 2>&1 &
SP=$!
ok=""
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:3999/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ -n "$ok" ]; then
  log "✔ 用这份备份启动临时服务成功（登录密钥与数据匹配），演练通过"
else
  log "✘ 用备份启动失败："
  tail -20 "$T/drill.log"
  exit 1
fi
