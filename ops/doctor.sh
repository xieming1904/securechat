#!/usr/bin/env bash
# Server self-check (v1.0). Checks everything 密聊 needs on this server and installs / repairs what is missing.
#   bash /usr/local/lib/securechat-ops/doctor.sh              全部检查并自动修复
#   bash /usr/local/lib/securechat-ops/doctor.sh --check      只检查，不改动任何东西
# update.sh runs it on every upgrade: --phase pre (before the backup), --phase post (after installing the new
# files, before the restart) and --phase final (after the new version is up).
# Exit code: 0 = all good (or repaired), 1 = something is still wrong and needs a person.
set -uo pipefail
ROOT_OPS_DIR=$( [ -f /etc/securechat-ops.conf ] && . /etc/securechat-ops.conf; echo "${ROOT_OPS:-/usr/local/lib/securechat-ops}" )
HERE=$(cd "$(dirname "$0")" && pwd -P)
# Run from the root-owned copy (or update.sh's private copy of it). The copy in the web user's folder could have been
# edited; it is only used on a server that has no root-owned copy yet (first installation).
if [ "$HERE" != "$ROOT_OPS_DIR" ] && [ "$HERE" != "${SECURECHAT_UPDATE_COPY:-}" ] && [ -d "$ROOT_OPS_DIR" ]; then
  if [ -f "$ROOT_OPS_DIR/doctor.sh" ] && grep -q '^as_app()' "$ROOT_OPS_DIR/common.sh" 2>/dev/null; then
    exec bash "$ROOT_OPS_DIR/doctor.sh" "$@"
  fi
  echo "✘ $ROOT_OPS_DIR 里还没有这个版本的自检脚本。请先用 $ROOT_OPS_DIR/update.sh 安装最新的更新包，它会把自检脚本装进去。"
  exit 1
fi
. "$HERE/common.sh"
# a common.sh from before v1.0 next to this script (a rollback by an old update.sh can leave that behind)
type as_app >/dev/null 2>&1 || { echo "✘ $HERE 里的 common.sh 是旧版本，和 doctor.sh 不配套：请用 update.sh 重新安装最新的更新包。"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }

FIX=1
PHASE=all
while [ $# -gt 0 ]; do
  case "$1" in
    --check) FIX=0 ;;
    --phase)
      PHASE=${2:-}
      case "$PHASE" in pre | post | final | all) ;; *) echo "--phase 只能是 pre、post、final 或 all"; exit 2 ;; esac
      shift ;;
    *) echo "用法：doctor.sh [--check] [--phase pre|post|final]"; exit 2 ;;
  esac
  shift
done
MIN_FREE_MB=${MIN_FREE_MB:-1024}

OK=0; FIXED=0; WARN=0; BAD=0
ok()    { OK=$((OK + 1));       printf '  ✔ %s\n' "$*"; }
fixed() { FIXED=$((FIXED + 1)); printf '  ➜ %s\n' "$*"; }
warn()  { WARN=$((WARN + 1));   printf '  ⚠ %s\n' "$*"; }
bad()   { BAD=$((BAD + 1));     printf '  ✘ %s\n' "$*"; }
want() { [ "$PHASE" = all ] || [ "$PHASE" = "$1" ]; }
env_get() { as_app cat "$APP_DIR/.env" 2>/dev/null | sed -n "s/^$1=//p" | tail -1 | tr -d '"'"'"; }

# ------------------------------------------------------------------ package manager
PM=""
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
fi
APT_UPDATED=0
pkg_install() { # pkg_install <package>...
  case "$PM" in
    apt)
      if [ $APT_UPDATED = 0 ]; then DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true; APT_UPDATED=1; fi
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null 2>&1 ;;
    dnf) dnf install -y -q "$@" >/dev/null 2>&1 ;;
    yum) yum install -y -q "$@" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}
# package names that differ between Debian/Ubuntu and RHEL/CentOS/Alibaba Cloud Linux
pkgname() {
  case "$PM:$1" in
    dnf:iproute2|yum:iproute2) echo iproute ;;
    dnf:gnupg|yum:gnupg) echo gnupg2 ;;
    *) echo "$1" ;;
  esac
}
# need_tool <command> <package> <why> [required=1]
need_tool() {
  local cmd=$1 pkg=$2 why=$3 required=${4:-1}
  if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd（$why）"; return 0; fi
  if [ $FIX = 1 ] && pkg_install "$pkg" && command -v "$cmd" >/dev/null 2>&1; then fixed "已安装 $cmd（$why）"; return 0; fi
  if [ "$required" = 1 ]; then bad "缺少 $cmd（$why），自动安装失败：请手动安装软件包 $pkg"
  else warn "缺少 $cmd（$why），自动安装失败：请手动安装软件包 $pkg"; fi
  return 1
}

# ------------------------------------------------------------------ Node.js
install_node() {
  # Official build, checked against the SHA-256 list from nodejs.org, installed into $OWN_NODE.
  # The tarball may come from a mirror (faster from mainland China / HK), but the checksum list always comes
  # from nodejs.org itself, so a mirror can't hand us a modified binary.
  local arch sums file tmp base
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "    不支持的 CPU 架构 $(uname -m)"; return 1 ;; esac
  if ! sums=$(curl -fsSL --max-time 60 "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt"); then
    echo "    连不上 nodejs.org，拿不到官方校验和，不自动安装"; return 1
  fi
  file=$(printf '%s\n' "$sums" | awk '{print $2}' | grep -E "^node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.gz\$" | head -1)
  [ -n "$file" ] || { echo "    官方列表里没有找到 linux-${arch} 的安装包"; return 1; }
  tmp=$(mktemp -d /tmp/securechat-node.XXXXXX)
  for base in "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" "https://npmmirror.com/mirrors/node/${file%%-linux-*}"; do
    base=${base/\/node\/node-v/\/node\/v}
    rm -f "$tmp/$file"
    curl -fsSL --max-time 300 -o "$tmp/$file" "$base/$file" || continue
    if (cd "$tmp" && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c --status); then break; fi
    echo "    从 $base 下载的文件校验和不对，已丢弃"
    rm -f "$tmp/$file"
  done
  if [ ! -f "$tmp/$file" ]; then rmdir "$tmp"; return 1; fi
  mkdir -p "$tmp/x"
  if ! tar xzf "$tmp/$file" -C "$tmp/x" --strip-components=1 --no-same-owner; then rm -f "$tmp/$file"; safe_rmtree "$tmp"; return 1; fi
  rm -f "$tmp/$file"
  chown -R root:root "$tmp/x"
  chmod -R go-w "$tmp/x"
  "$tmp/x/bin/node" -v >/dev/null 2>&1 || { echo "    下载的 Node.js 在这台服务器上运行不了"; safe_rmtree "$tmp"; return 1; }
  install -d -m 755 -o root -g root "$(dirname "$OWN_NODE")"
  local old=""
  if [ -d "$OWN_NODE" ]; then old="$OWN_NODE.old-$(date +%s)"; mv "$OWN_NODE" "$old"; fi
  if ! mv "$tmp/x" "$OWN_NODE"; then [ -n "$old" ] && mv "$old" "$OWN_NODE"; safe_rmtree "$tmp"; return 1; fi
  rmdir "$tmp"
  node_dir_ok "$OWN_NODE/bin"
}
check_node() {
  local major=""
  [ -n "$NODE_BIN" ] && major=$(node_major "$NODE_BIN")
  if [ "$major" = "$NODE_MAJOR" ]; then ok "Node.js $("$NODE_BIN/node" -v)（$NODE_BIN）"; return 0; fi
  local d
  for d in /www/server/nodejs/v${NODE_MAJOR}.*/bin; do
    [ -x "$d/node" ] && ! node_dir_ok "$d" && warn "忽略了 $d：它不是只有 root 能改（root 不能运行别人能改的程序）"
  done
  if [ $FIX = 1 ]; then
    echo "    正在下载 Node.js ${NODE_MAJOR}（约 30 MB）…"
    if install_node; then
      NODE_BIN="$OWN_NODE/bin"
      export PATH="$NODE_BIN:$PATH"
      NODE_CHANGED=1
      fixed "已安装 Node.js $("$NODE_BIN/node" -v) 到 $OWN_NODE"
      return 0
    fi
  fi
  bad "需要 Node.js ${NODE_MAJOR}（现在：${major:-没有}）。自动安装失败：请在宝塔「软件商店 → Node.js 版本管理器」安装 v${NODE_MAJOR}.x"
  return 1
}
NODE_CHANGED=0

# ------------------------------------------------------------------ npm dependencies (server)
deps_load() {
  # every runtime dependency must resolve, and the native SQLite module must actually load with this Node
  # run as the app user: this loads code from the web user's node_modules
  (cd "$APP_DIR/server" && as_app "$NODE_BIN/node" -e "
    const deps = Object.keys(require('./package.json').dependencies || {});
    for (const d of deps) require.resolve(d, { paths: [process.cwd()] });
    const D = require('better-sqlite3'); new D(':memory:').prepare('select 1').get();
  ") >/dev/null 2>&1
}
check_deps() {
  if [ -z "$NODE_BIN" ]; then bad "没有 Node.js，无法检查依赖"; return 1; fi
  if [ ! -f "$APP_DIR/package-lock.json" ]; then bad "找不到 $APP_DIR/package-lock.json"; return 1; fi
  if [ $NODE_CHANGED = 0 ] && deps_load; then ok "服务器依赖齐全（原生模块和当前 Node 匹配）"; return 0; fi
  if [ $FIX = 1 ]; then
    echo "    正在安装服务器依赖（npm ci，约 1 分钟）…"
    chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
    if app_npm_ci "$LOG_DIR/npm.log" && deps_load; then
      fixed "已重新安装服务器依赖"
      return 0
    fi
    bad "安装服务器依赖失败，见 $LOG_DIR/npm.log（常见原因：服务器连不上 npm 源）"
    return 1
  fi
  bad "服务器依赖不完整，或原生模块和 Node 版本不匹配（修复：去掉 --check 再运行）"
  return 1
}

# ------------------------------------------------------------------ files, permissions, config
check_files() {
  # $APP_DIR belongs to the web user. Root only ever changes the owner of these paths (chown -h, never following a
  # symlink); reading and editing is done as the app user.
  local e="$APP_DIR/.env" d="$APP_DIR/data" h rc
  if [ -L "$APP_DIR" ] || [ -L "$e" ] || [ -L "$d" ]; then bad "$APP_DIR、.env 或 data 是符号链接，可能被人动过手脚，请人工检查"; return; fi
  if [ ! -f "$e" ]; then bad "找不到 $e（登录密钥在里面，不能自动生成）"; return; fi
  if [ "$(stat -c '%U' "$e")" != "$RUN_USER" ]; then
    if [ $FIX = 1 ]; then chown -h "$RUN_USER:$RUN_USER" "$e"; fixed ".env 属主改为 $RUN_USER"; else bad ".env 属主应为 $RUN_USER"; fi
  fi
  if [ -z "$(env_get OPAQUE_SERVER_SETUP)" ]; then bad ".env 里没有 OPAQUE_SERVER_SETUP（不能自动生成：生成新的会让所有人都无法登录），请从 /root/securechat-env.backup 恢复"
  else ok ".env 里有登录密钥（OPAQUE_SERVER_SETUP）"; fi
  if [ "$(stat -c '%a' "$e")" != 600 ]; then
    if [ $FIX = 1 ] && as_app chmod 600 "$e"; then fixed ".env 权限改为 600"; else bad ".env 权限应为 600"; fi
  else ok ".env 权限 600"; fi
  # HOST must be 127.0.0.1 (or absent: the app then defaults to 127.0.0.1)
  h=$(as_app cat "$e" 2>/dev/null | grep -E '^[[:space:]]*(export[[:space:]]+)?HOST=' | grep -vxE 'HOST=("|'"'"')?127\.0\.0\.1("|'"'"')?' | head -1)
  if [ -n "$h" ]; then
    if [ $FIX = 1 ] && as_app sed -i -E '/^[[:space:]]*(export[[:space:]]+)?HOST=/d' "$e" && as_app sh -c 'printf "HOST=127.0.0.1\n" >> "$1"' _ "$e"; then
      fixed ".env 里的「$h」改为 HOST=127.0.0.1（端口 $PORT 只能本机访问）"; NEED_RESTART=1
    else bad ".env 里是「$h」，应为 HOST=127.0.0.1"; fi
  else ok "只监听本机（HOST=127.0.0.1）"; fi
  if [ $FIX = 1 ]; then
    rc=0; backup_env 2>/dev/null || rc=$?
    case $rc in
      0) ok ".env 已备份到 /root/securechat-env.backup（旧的备份带日期保留）" ;;
      2) bad ".env 里没有登录密钥，没有覆盖原来的备份 /root/securechat-env.backup" ;;
      3) bad ".env 里的登录密钥和 /root/securechat-env.backup 里的不一样，没有覆盖备份：请人工核对哪一个是对的" ;;
      *) warn "没能备份 .env" ;;
    esac
  elif ! as_app cat "$e" 2>/dev/null | cmp -s - /root/securechat-env.backup; then warn ".env 的备份 /root/securechat-env.backup 不存在或不是最新"
  else ok ".env 已备份到 /root/securechat-env.backup"; fi
  if [ -d "$d" ]; then
    if [ "$(stat -c '%U' "$d")" != "$RUN_USER" ]; then
      if [ $FIX = 1 ]; then chown -h "$RUN_USER:$RUN_USER" "$d"; fixed "data 目录属主改为 $RUN_USER"; else bad "data 目录属主应为 $RUN_USER"; fi
    fi
    if [ "$(stat -c '%a' "$d")" != 700 ]; then
      if [ $FIX = 1 ] && as_app chmod 700 "$d"; then fixed "data 目录权限改为 700"; else bad "data 目录权限应为 700"; fi
    else ok "data 目录权限 700"; fi
  else bad "找不到数据目录 $d"; fi
  if [ "$(sysctl -n fs.protected_hardlinks 2>/dev/null)" = 1 ] && [ "$(sysctl -n fs.protected_symlinks 2>/dev/null)" = 1 ]; then ok "系统的硬链接、符号链接保护已开启"
  else warn "系统的 fs.protected_hardlinks / fs.protected_symlinks 没有开启（大多数系统默认开启），建议开启"; fi
}

check_disk() {
  local free
  free=$(df -Pm "$APP_DIR" 2>/dev/null | awk 'NR==2{print $4}')
  if [ -n "$free" ] && [ "$free" -lt "$MIN_FREE_MB" ]; then bad "磁盘剩余 ${free} MB，少于 ${MIN_FREE_MB} MB，升级和备份可能失败"
  else ok "磁盘剩余 ${free:-?} MB"; fi
}

# ------------------------------------------------------------------ services and root-owned scripts
check_root_ops() {
  local f missing=""
  for f in update.sh common.sh backup.sh doctor.sh status.sh verify-release.mjs fingerprint.mjs install-release-key.sh log-limits.sh; do
    [ -f "$ROOT_OPS/$f" ] || missing="$missing $f"
  done
  if [ -z "$missing" ]; then ok "root 专有运维脚本齐全（$ROOT_OPS）"
  else warn "root 专有目录缺少：$missing（下一次升级会自动补齐；急用可执行 secure-ops.sh）"; fi
  if [ "$(stat -c '%U' "$ROOT_OPS" 2>/dev/null)" = root ] && [ -z "$(find "$ROOT_OPS" -maxdepth 1 \( ! -user root -o -perm /022 \) 2>/dev/null)" ]; then ok "root 专有目录只有 root 能改"
  elif [ -d "$ROOT_OPS" ]; then
    if [ $FIX = 1 ]; then chown -R root:root "$ROOT_OPS"; chmod -R go-w "$ROOT_OPS"; fixed "root 专有目录的属主改回 root"
    else bad "$ROOT_OPS 里有不属于 root 或别人能改的文件"; fi
  fi
  if [ -f "$ROOT_OPS/release.pub" ]; then ok "发布公钥已固定（每次升级都会验签）"
  else warn "还没有固定发布公钥：请按更新说明执行 install-release-key.sh（需要你核对密钥 ID，不能自动做）"; fi
}

check_units() {
  local changed
  if ! command -v systemctl >/dev/null 2>&1; then bad "没有 systemd"; return; fi
  if [ -z "$NODE_BIN" ]; then return; fi
  if [ $FIX = 1 ]; then
    changed=$(write_units)
    if [ -n "$changed" ]; then fixed "系统服务配置已更新：$changed"; case "$changed" in *"$SERVICE.service"*) NEED_RESTART=1 ;; esac
    else ok "系统服务配置是最新的"; fi
    systemctl is-enabled --quiet "$SERVICE" 2>/dev/null || { systemctl enable "$SERVICE" >/dev/null 2>&1 && fixed "已设置开机自动启动"; }
    systemctl is-enabled --quiet "$SERVICE-backup.timer" 2>/dev/null || { systemctl enable --now "$SERVICE-backup.timer" >/dev/null 2>&1 && fixed "已开启每日备份定时器"; }
  else
    [ -f "/etc/systemd/system/$SERVICE.service" ] && ok "系统服务已安装" || bad "系统服务没有安装"
    systemctl is-enabled --quiet "$SERVICE-backup.timer" 2>/dev/null && ok "每日备份定时器已开启" || bad "每日备份定时器没有开启"
  fi
}

check_offsite() {
  local remote
  remote=$(sed -n 's/^OFFSITE_REMOTE=//p' /etc/securechat-ops.conf 2>/dev/null | tail -1 | tr -d '"')
  if [ -z "$remote" ]; then ok "异地备份未开启（可选），不需要 rclone、gpg"; return; fi
  need_tool gpg "$(pkgname gnupg)" "异地备份加密" 0
  need_tool rclone rclone "异地备份上传" 0
  [ -f /root/securechat-offsite.key ] && ok "异地备份口令文件存在" || warn "找不到 /root/securechat-offsite.key，异地备份无法加密"
}

check_turn() {
  if [ -z "$(env_get TURN_URLS)" ]; then ok "未配置 TURN 中转（可选）"; return; fi
  if ! systemctl list-unit-files coturn.service >/dev/null 2>&1 || ! systemctl cat coturn >/dev/null 2>&1; then
    warn "配置了 TURN 中转，但没有安装 coturn：请执行 install-coturn.sh"
    return
  fi
  if systemctl is-active --quiet coturn; then ok "TURN 中转（coturn）运行中"
  elif [ $FIX = 1 ] && systemctl restart coturn >/dev/null 2>&1 && systemctl is-active --quiet coturn; then fixed "已重新启动 coturn"
  else warn "coturn 没有运行，通话可能接不通：journalctl -u coturn -n 30"; fi
}

check_running() {
  if systemctl is-active --quiet "$SERVICE"; then ok "服务运行中"
  else bad "服务没有运行：journalctl -u $SERVICE -n 50"; fi
  if ss -ltnH "sport = :$PORT" 2>/dev/null | awk '{print $4}' | grep -vqE "^(127\.0\.0\.1|\[::1\]):$PORT$"; then
    bad "端口 $PORT 对外开放了（应只监听 127.0.0.1）：检查 .env 的 HOST"
  else ok "端口 $PORT 只监听本机"; fi
  if health >/dev/null; then ok "健康检查通过：$(health)"; else bad "健康检查没有响应"; fi
}

# ------------------------------------------------------------------ run
NEED_RESTART=0
echo "== 密聊 服务器自检（$( [ $FIX = 1 ] && echo 检查并修复 || echo 只检查 )${PHASE:+，阶段 $PHASE}）"
if want pre; then
  echo "· 系统工具"
  need_tool curl curl "下载、健康检查"
  need_tool rsync rsync "安装新版本、备份"
  need_tool tar tar "解压更新包"
  need_tool sha256sum coreutils "校验文件"
  need_tool ss "$(pkgname iproute2)" "检查端口" 0 || true
  echo "· 磁盘"
  check_disk
  echo "· Node.js"
  check_node
  # the current version's dependencies too: the backup that starts every upgrade needs them
  if [ "$PHASE" = pre ]; then echo "· 服务器依赖（当前版本）"; check_deps; fi
fi
if want post; then
  echo "· 服务器依赖"
  check_deps
  echo "· 配置和权限"
  check_files
  echo "· 系统服务"
  check_units
  check_root_ops
  echo "· 可选组件"
  check_offsite
  check_turn
  [ -f "$ROOT_OPS/log-limits.sh" ] && [ $FIX = 1 ] && bash "$ROOT_OPS/log-limits.sh" >/dev/null 2>&1 || true
fi
if want final || [ "$PHASE" = all ]; then
  if [ "$PHASE" = all ] && [ $NEED_RESTART = 1 ] && [ $FIX = 1 ]; then
    systemctl restart "$SERVICE" && sleep 3 && fixed "配置有变化，已重启服务"
  fi
  echo "· 运行状态"
  check_running
fi
echo "== 结果：✔ $OK 项正常 · ➜ $FIXED 项已修复 · ⚠ $WARN 项提醒 · ✘ $BAD 项需要处理"
[ $BAD = 0 ]
