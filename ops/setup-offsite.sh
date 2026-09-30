#!/usr/bin/env bash
# One-time setup of the off-site backup.
#   1) installs rclone (if missing)
#   2) you create a storage remote with `rclone config` — YOU type the AccessKey there, this script never sees it
#   3) generates the encryption key, saves the remote name in /etc/securechat-ops.conf, does a test upload
# Usage: bash ops/setup-offsite.sh <rclone-remote:bucket/path> [keep-days]
#   e.g. bash ops/setup-offsite.sh oss:my-bucket/securechat 30
set -euo pipefail
. "$(dirname "$0")/common.sh"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
REMOTE=${1:-}
KEEP=${2:-30}
[[ $KEEP =~ ^[1-9][0-9]{0,3}$ ]] || { echo "保留天数必须是 1–9999 的整数"; exit 1; }

if ! command -v gpg >/dev/null; then
  log "安装 gnupg…"
  if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y gnupg >/dev/null || true
  elif command -v dnf >/dev/null; then dnf install -y gnupg2 >/dev/null || true
  elif command -v yum >/dev/null; then yum install -y gnupg2 >/dev/null || true; fi
  command -v gpg >/dev/null || { echo "请先安装 gnupg"; exit 1; }
fi
if ! command -v rclone >/dev/null; then
  log "安装 rclone…"
  if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y rclone >/dev/null || true; fi
  if ! command -v rclone >/dev/null && command -v dnf >/dev/null; then dnf install -y rclone >/dev/null || true; fi
  if ! command -v rclone >/dev/null && command -v yum >/dev/null; then yum install -y rclone >/dev/null || true; fi
  command -v rclone >/dev/null || { echo "自动安装失败，请按 https://rclone.org/install/ 手动安装 rclone 后重试"; exit 1; }
fi

if [ -z "$REMOTE" ]; then
  cat <<TXT
用法：bash $0 <远端:存储桶/目录> [保留天数]

第一步，先创建远端（只需一次）：执行  rclone config
  n) 新建 → 名字填 oss → 类型选 "s3" → provider 选 "Alibaba" →
  填你的 AccessKey ID / Secret（建议在阿里云 RAM 里建一个只能写这个存储桶的子账号）→
  endpoint 选你的地域（如 oss-cn-hongkong.aliyuncs.com）→ 其余回车默认 → q 退出
第二步：bash $0 oss:你的存储桶名/securechat 30
TXT
  exit 1
fi
rclone lsd "${REMOTE%%:*}:" >/dev/null 2>&1 || { echo "rclone 远端 ${REMOTE%%:*} 不可用，请先运行 rclone config"; exit 1; }

KEY=/root/securechat-offsite.key
if [ ! -s "$KEY" ]; then
  umask 077
  head -c 48 /dev/urandom | base64 > "$KEY"
  chmod 600 "$KEY"
  NEWKEY=1
fi

CONF=/etc/securechat-ops.conf
touch "$CONF"
sed -i '/^OFFSITE_REMOTE=/d; /^OFFSITE_KEEP_DAYS=/d' "$CONF"
printf 'OFFSITE_REMOTE=%q\nOFFSITE_KEEP_DAYS=%q\n' "$REMOTE" "$KEEP" >> "$CONF"
chmod 600 "$CONF"

OFFSITE_REMOTE=$REMOTE OFFSITE_KEEP_DAYS=$KEEP bash "$(dirname "$0")/offsite.sh"
echo
log "✔ 异地备份已开启：每天本地备份完成后自动上传到 $REMOTE，保留 $KEEP 天。"
if [ "${NEWKEY:-}" = 1 ]; then
  echo
  echo "!!! 请把下面这行加密密钥抄下来，离线保存（纸上 / 密码管理器）。服务器整个丢失时，只有用它才能解开异地备份："
  echo
  cat "$KEY"
  echo
fi
echo "恢复方法：rclone copy $REMOTE/<文件名> . ，然后"
echo "  gpg --batch --pinentry-mode loopback --passphrase-file /root/securechat-offsite.key -d <文件名> | tar xf -"
echo "  得到 app.db、blobs/、env（即 .env），按部署文档放回 /www/wwwroot/securechat/ 即可。"
