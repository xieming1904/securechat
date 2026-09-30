#!/usr/bin/env bash
# 启动脚本（宝塔 Node 项目的启动命令指向本文件，或手动 bash start.sh）
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; set +a
export NODE_ENV=production DATA_DIR="${DATA_DIR:-$PWD/data}" WEB_DIST="$PWD/web/dist"
exec node server/dist/src/index.js
