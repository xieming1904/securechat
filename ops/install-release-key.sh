#!/usr/bin/env bash
# Pin the release public key that update.sh checks every update package against (v0.9).
#   bash /usr/local/lib/securechat-ops/install-release-key.sh <release.pub> "<密钥 ID，例如 3DCD B3B5 A9C3 3336>"
# The key id must be the one written in the release notes (which you got from the developer, not from this server).
# Replacing an already pinned key needs --replace (only when the developer announced a new key).
set -euo pipefail
. "$(dirname "$0")/common.sh"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
PUBSRC=${1:?用法: install-release-key.sh <release.pub> "<密钥 ID>" [--replace]}
WANT=$(printf '%s' "${2:?缺少密钥 ID（在更新说明里）}" | tr -d ' ' | tr 'a-f' 'A-F')
REPLACE=${3:-}
VERIFY="$ROOT_OPS/verify-release.mjs"
[ -f "$VERIFY" ] || { echo "✘ 找不到 $VERIFY，请先完成一次升级"; exit 1; }
if [ ! -f "$PUBSRC" ] || [ -L "$PUBSRC" ]; then echo "✘ 找不到 $PUBSRC"; exit 1; fi
TMP=$(mktemp /tmp/securechat-pub.XXXXXX)
install -m 600 -o root -g root "$PUBSRC" "$TMP"
GOT=$(node --input-type=module -e "import { keyId } from '$VERIFY'; import fs from 'node:fs'; console.log(keyId(fs.readFileSync('$TMP', 'utf8')).replace(/ /g, ''))" 2>/dev/null || echo "?")
if [ "$GOT" != "$WANT" ]; then
  rm -f -- "$TMP"
  echo "✘ 密钥 ID 不一致：文件里的是 $GOT，你输入的是 $WANT。没有安装。"
  exit 1
fi
if [ -f "$ROOT_OPS/release.pub" ] && [ "$REPLACE" != "--replace" ]; then
  rm -f -- "$TMP"
  echo "✘ 已经固定过发布公钥（$ROOT_OPS/release.pub）。只有开发者宣布更换密钥时，才加 --replace 再运行。"
  exit 1
fi
install -m 644 -o root -g root "$TMP" "$ROOT_OPS/release.pub"
rm -f -- "$TMP"
log "✔ 已固定发布公钥（密钥 ID ${WANT:0:4} ${WANT:4:4} ${WANT:8:4} ${WANT:12:4}）。以后每次升级都会检查签名。"
