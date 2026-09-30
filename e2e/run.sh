#!/usr/bin/env bash
# 浏览器端到端测试：多个浏览器（模拟不同 IP）完成
#   访问验证 → 注册 → 加密私聊 → 回复/编辑 → 单方面删除 → 群聊 → 安全码核对 → 刷新/新设备恢复密钥 → 手机布局 → 管理后台
# 用法（在项目根目录）：npm run build -w web && bash e2e/run.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$ROOT/e2e/.tmp"
rm -rf "$TMP" && mkdir -p "$TMP/shots"
export DATA_DIR="$TMP/data" TRUST_PROXY=loopback COOKIE_SECURE=0 PORT=3100 LOG_LEVEL=warn
(cd "$ROOT/server" && npx tsx scripts/init.ts --password gatepass123 --origin http://localhost:3100 > "$TMP/init.txt")
# Playwright adds the simulated client IP (X-Forwarded-For) to page requests but not to requests made by the
# service worker; allow the bare loopback address so the SW can be fetched. Fresh browser contexts (no SW)
# still go through the gate with their own simulated IP.
(cd "$ROOT/server" && npx tsx scripts/allow-ip.ts 127.0.0.1 "e2e service worker" > /dev/null)
node --import tsx "$ROOT/server/src/index.ts" > "$TMP/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 3
if [ ! -d "$ROOT/e2e/node_modules/playwright" ]; then
  (cd "$ROOT/e2e" && npm init -y >/dev/null 2>&1; npm install --no-save playwright >/dev/null && npx playwright install chromium)
fi
cd "$ROOT" && NODE_PATH="$ROOT/e2e/node_modules" node e2e/browser-e2e.mjs
echo "截图在 e2e/.tmp/shots/"
