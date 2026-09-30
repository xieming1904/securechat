#!/usr/bin/env bash
# Turn off two-step verification (authenticator app AND passkeys) for one account whose owner lost them and the recovery codes.
# Deliberately root-only (not in the admin web console): a stolen admin session must not be able to strip 2FA.
# Usage: bash ops/reset-2fa.sh <username>
set -euo pipefail
. "$(dirname "$0")/common.sh"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
NAME=${1:-}
[[ $NAME =~ ^[A-Za-z0-9_]{3,32}$ ]] || { echo "用法：bash $0 <用户名>"; exit 1; }
read -r -p "确认关闭用户 $NAME 的两步验证？请先当面或电话核实是本人。输入 yes 继续：" ans
[ "$ans" = yes ] || { echo "已取消"; exit 1; }
cd "$APP_DIR"
# as the app user: better-sqlite3 is loaded from the web user's node_modules
as_app env DB="$APP_DIR/data/app.db" U="$NAME" node -e '
const D = require("better-sqlite3");
const db = new D(process.env.DB);
db.pragma("busy_timeout = 5000");
const u = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(process.env.U);
if (!u) { console.error("找不到这个用户"); process.exit(1); }
db.transaction(() => {
  db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL WHERE id = ?").run(u.id);
  db.prepare("DELETE FROM totp_recovery WHERE user_id = ?").run(u.id);
  try { db.prepare("DELETE FROM webauthn_creds WHERE user_id = ?").run(u.id); } catch {} // passkeys (v0.5+)
})();
console.log("已关闭。请提醒对方登录后重新开启两步验证。");
'
log "reset-2fa: $NAME"
