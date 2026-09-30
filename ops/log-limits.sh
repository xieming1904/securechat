#!/usr/bin/env bash
# Keep system logs bounded (v0.7). The service logs to journald (journalctl -u securechat); by default journald may
# use up to 10% of the disk. This adds a drop-in that caps it at 500 MB and 30 days, unless the admin already set
# their own limits. Safe to run repeatedly. Usage (root): bash /www/wwwroot/securechat/ops/log-limits.sh
set -euo pipefail
. "$(dirname "$0")/common.sh"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
command -v journalctl >/dev/null || { log "没有 journald，跳过"; exit 0; }

DROP=/etc/systemd/journald.conf.d/securechat.conf
if [ -f "$DROP" ]; then
  log "系统日志上限已设置过（$DROP），不再改动"
elif grep -Eqs '^\s*(SystemMaxUse|MaxRetentionSec)=' /etc/systemd/journald.conf /etc/systemd/journald.conf.d/*.conf 2>/dev/null; then
  log "journald 已有管理员自己的日志上限设置，不做修改"
else
  mkdir -p /etc/systemd/journald.conf.d
  printf '%s\n' '# 由密聊 ops/log-limits.sh 写入：系统日志最多 500 MB、保留 30 天。删除本文件即可取消。' '[Journal]' 'SystemMaxUse=500M' 'MaxRetentionSec=30day' > "$DROP.tmp"
  mv -f "$DROP.tmp" "$DROP"
  # old systemd (< 230, e.g. CentOS 7) can cut running services' log streams on a journald restart:
  # there the new limit applies from the next reboot instead
  SDV=$(systemctl --version 2>/dev/null | awk 'NR==1{print $2+0}')
  if [ "${SDV:-0}" -ge 230 ]; then
    systemctl restart systemd-journald || true
    journalctl --vacuum-size=500M >/dev/null 2>&1 || true
    log "✔ 系统日志上限：500 MB / 30 天"
  else
    log "✔ 系统日志上限已写入（500 MB / 30 天），服务器下次重启后生效"
  fi
fi
log "当前系统日志占用：$(journalctl --disk-usage 2>/dev/null | grep -o '[0-9.]*[KMGT]' | head -1 || echo ?)"
