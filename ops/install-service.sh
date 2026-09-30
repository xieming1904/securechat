#!/usr/bin/env bash
# One-time: run 密聊 as a systemd service (auto-restart on crash, start on boot) + daily backup timer.
# Usage (root): bash /www/wwwroot/securechat/ops/install-service.sh
set -euo pipefail
# once the root-owned copy exists, use that one (the web user can edit the scripts in its folder)
_ro=$( [ -f /etc/securechat-ops.conf ] && . /etc/securechat-ops.conf; echo "${ROOT_OPS:-/usr/local/lib/securechat-ops}" )
if [ -f "$_ro/install-service.sh" ] && [ "$(cd "$(dirname "$0")" && pwd -P)" != "$_ro" ]; then
  echo "（改用 root 专有目录里的脚本：$_ro/install-service.sh）"
  exec bash "$_ro/install-service.sh" "$@"
fi
. "$(dirname "$0")/common.sh"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }

log "Node: ${NODE_BIN:-（未找到）}/node ($("${NODE_BIN:-/nonexistent}/node" -v 2>/dev/null || echo 未安装))"
if ! command -v rsync >/dev/null; then
  log "安装 rsync"
  (apt-get install -y rsync || yum install -y rsync) >/dev/null
fi

[ -n "$NODE_BIN" ] || { echo "找不到 Node.js $NODE_MAJOR，请先执行 doctor.sh（会自动安装）"; exit 1; }
install_root_ops "$(dirname "$0")"
write_units >/dev/null
systemctl daemon-reload
bash "$ROOT_OPS/log-limits.sh" || true

# Hand over from the BaoTa-managed process (if any) to systemd.
if ! systemctl is-active --quiet "$SERVICE"; then
  OLD=$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  if [ -n "$OLD" ]; then
    log "停止面板启动的旧进程: $OLD"
    kill $OLD 2>/dev/null || true
    for _ in $(seq 1 10); do ss -ltnH "sport = :$PORT" | grep -q . || break; sleep 1; done
    kill -9 $OLD 2>/dev/null || true
  fi
fi
# leftover processes of this app that no longer listen (shutdown bug fixed in v0.2.0)
for p in $(pgrep -u "$RUN_USER" -f "node server/dist/src/index.js" || true); do
  if [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$APP_DIR" ] && ! systemctl show -p MainPID --value "$SERVICE" | grep -qx "$p"; then
    kill -9 "$p" 2>/dev/null || true
  fi
done

systemctl enable --now "$SERVICE"
systemctl enable --now "$SERVICE-backup.timer"

if wait_healthy 30; then
  log "✔ 服务已启动: $(health)"
else
  log "✘ 服务没有在 30 秒内就绪，最近日志："
  journalctl -u "$SERVICE" -n 30 --no-pager
  exit 1
fi
log "✔ 每日备份已启用，下次: $(systemctl show -p NextElapseUSecRealtime --value "$SERVICE-backup.timer")"
