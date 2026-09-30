#!/usr/bin/env bash
# Quick overview: service state, version, backups, disk.
. "$(dirname "$0")/common.sh"
echo "== 服务"
printf '   %s，自动重启过 %s 次，启动于 %s\n' "$(systemctl is-active "$SERVICE")" \
  "$(systemctl show -p NRestarts --value "$SERVICE")" "$(systemctl show -p ActiveEnterTimestamp --value "$SERVICE")"
echo "== 健康检查"
printf '   %s\n' "$(health || echo '✘ 无响应')"
echo "== 网页代码指纹（应与更新说明里的一致）"
FP_SCRIPT="$(dirname "$0")/fingerprint.mjs"; [ -f "$FP_SCRIPT" ] || FP_SCRIPT="$APP_DIR/ops/fingerprint.mjs"
if [ -f "$ROOT_OPS/release.pub" ] && [ -f "$ROOT_OPS/verify-release.mjs" ]; then
  printf '   %s\n' "$(node "$ROOT_OPS/verify-release.mjs" web "$ROOT_OPS/release.pub" "$APP_DIR/web/dist" 2>&1 || true)"
else
  printf '   %s\n' "$(node "$FP_SCRIPT" "$APP_DIR/web/dist" 2>&1 || true)"
fi
echo "== 最近备份"
ls -1d "$BACKUP_DIR"/2*/ 2>/dev/null | sort | tail -3 | sed 's/^/   /'
printf '   总占用 %s\n' "$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)"
echo "== 异地备份"
if [ -n "${OFFSITE_REMOTE:-}" ]; then
  if [ -f "$APP_DIR/data/.last-offsite" ]; then printf '   %s，最近上传于 %s\n' "$OFFSITE_REMOTE" "$(date -d @"$(cat "$APP_DIR/data/.last-offsite")" '+%F %T')"; else printf '   %s，还没有上传过\n' "$OFFSITE_REMOTE"; fi
else
  echo "   未配置（可选：bash $APP_DIR/ops/setup-offsite.sh）"
fi
echo "== 下次备份"
printf '   %s\n' "$(systemctl show -p NextElapseUSecRealtime --value "$SERVICE-backup.timer" 2>/dev/null)"
echo "== 磁盘"
df -h "$APP_DIR" | tail -1 | sed 's/^/   /'
