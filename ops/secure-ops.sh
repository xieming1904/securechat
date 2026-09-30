#!/usr/bin/env bash
# One-time (v0.7): copy the ops scripts into a root-owned directory (/usr/local/lib/securechat-ops), point the daily
# backup at that copy, and set the log limits. Later upgrades keep the copy up to date automatically.
# Usage (root): bash /www/wwwroot/securechat/ops/secure-ops.sh
set -euo pipefail
. "$(dirname "$0")/common.sh"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
if [ -f "$ROOT_OPS/update.sh" ] && [ "${1:-}" != --force ]; then
  echo "$ROOT_OPS 里已经有运维脚本了，以后由 update.sh 自动更新，不用再执行这一步。"
  echo "（网站目录里的脚本可能被改过，所以不从那里覆盖。确实要覆盖请加 --force。）"
  exit 0
fi
install_root_ops "$(dirname "$0")"
log "✔ 运维脚本已复制到 $ROOT_OPS（仅 root 可改），每日备份改为从这里运行"
bash "$ROOT_OPS/log-limits.sh" || true
log "以后以 root 执行运维命令时，请用 $ROOT_OPS/ 下的脚本，例如：bash $ROOT_OPS/status.sh"
