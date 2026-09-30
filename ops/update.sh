#!/usr/bin/env bash
# One-command update with automatic rollback. Run it as root from the ROOT-OWNED copy of the scripts:
#   bash /usr/local/lib/securechat-ops/update.sh /www/wwwroot/securechat-update-vX.tar.gz
# v0.9+:
#  - the package must come with its signature (<package>.sig next to it). It is checked against the release public
#    key pinned once (with install-release-key.sh) in the root-owned /usr/local/lib/securechat-ops/release.pub.
#    No key installed or a bad signature = no update (emergency override: ALLOW_UNSIGNED=1).
#  - the package and the signature are first copied into a private root-only directory; only those copies are
#    checked and used, so nobody can swap the file between the check and the install.
#  - no downgrades (the installed version is kept in a root-owned file); override: ALLOW_DOWNGRADE=1.
# 1 check package · 2 back up data · 3 save current code · 4 install · 5 restart + health check
# If the new version isn't healthy within 30 s, the previous code is restored automatically.
set -euo pipefail
ROOT_OPS_DIR=${ROOT_OPS:-/usr/local/lib/securechat-ops}
# This script replaces ops/ (including itself) during the update — run from a private copy instead.
if [ -z "${SECURECHAT_UPDATE_COPY:-}" ]; then
  HERE=$(cd "$(dirname "$0")" && pwd -P)
  # started from the web user's folder while a root-owned copy exists: use that one (the web user can edit these)
  if [ -f "$ROOT_OPS_DIR/update.sh" ] && [ "$HERE" != "$ROOT_OPS_DIR" ] && [ "${ALLOW_APPDIR_OPS:-}" != 1 ]; then
    echo "（改用 root 专有目录里的升级脚本：$ROOT_OPS_DIR/update.sh）"
    exec bash "$ROOT_OPS_DIR/update.sh" "$@"
  fi
  SELF=$(mktemp -d /tmp/securechat-ops.XXXXXX)
  chmod 700 "$SELF"
  cp "$HERE"/*.sh "$SELF"/
  cp "$HERE"/*.mjs "$SELF"/ 2>/dev/null || true
  [ -f "$HERE/release.pub" ] && cp "$HERE/release.pub" "$SELF"/
  SECURECHAT_UPDATE_COPY="$SELF" exec bash "$SELF/update.sh" "$@"
fi
. "$(dirname "$0")/common.sh"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
STG=""
RB=""
cleanup() { [ -n "$STG" ] && safe_rmtree "$STG"; [ -n "$RB" ] && safe_rmtree "$RB"; safe_rmtree "$SECURECHAT_UPDATE_COPY"; return 0; }
trap cleanup EXIT
[ ! -L "$APP_DIR" ] || { echo "✘ $APP_DIR 是符号链接，已停止（请人工检查）"; exit 1; }
# v1.0: before anything else, make sure the server has what the update needs (tools, Node.js, disk space) —
# missing pieces are installed; if that fails, nothing has been touched yet
if [ -f "$(dirname "$0")/doctor.sh" ] && type as_app >/dev/null 2>&1; then
  log "0/5 服务器自检（缺什么装什么）"
  bash "$(dirname "$0")/doctor.sh" --phase pre || { echo "✘ 自检没有通过（原因见上面的 ✘），升级没有开始，程序和数据都没有动。"; exit 1; }
  . "$(dirname "$0")/common.sh" # pick up a Node.js that was just installed
fi
SRC_PKG=${1:?用法: update.sh <更新包.tar.gz>}
[ -f "$SRC_PKG" ] && [ ! -L "$SRC_PKG" ] || { echo "找不到 $SRC_PKG（或它是符号链接）"; exit 1; }

# private copies first; everything below uses only these
PKG="$SECURECHAT_UPDATE_COPY/package.tar.gz"
install -m 600 -o root -g root "$SRC_PKG" "$PKG"
if [ -f "$SRC_PKG.sig" ] && [ ! -L "$SRC_PKG.sig" ]; then install -m 600 -o root -g root "$SRC_PKG.sig" "$PKG.sig"; fi

# release signature — before anything reads the package
PUB="$ROOT_OPS/release.pub"
VERIFY="$ROOT_OPS/verify-release.mjs"
if [ -f "$PUB" ] && [ -f "$VERIFY" ]; then
  if ! node "$VERIFY" pkg "$PUB" "$PKG"; then
    if [ "${ALLOW_UNSIGNED:-}" = 1 ]; then log "⚠ ALLOW_UNSIGNED=1：跳过签名检查（只在确认更新包来源可靠时使用）"
    else echo "✘ 签名检查没有通过，已停止更新。"; exit 1; fi
  fi
elif [ "${ALLOW_UNSIGNED:-}" = 1 ]; then
  log "⚠ 服务器上还没有固定发布公钥，ALLOW_UNSIGNED=1：这次不检查签名"
else
  echo "✘ 服务器上还没有固定发布公钥（$PUB），无法检查签名，已停止。"
  echo "  请先按更新说明执行 install-release-key.sh；或者确认更新包来源可靠后，用 ALLOW_UNSIGNED=1 再运行一次。"
  exit 1
fi

# (no `grep -q` here: with pipefail an early grep exit would SIGPIPE tar and look like a failure)
if ! tar tzf "$PKG" 2>/dev/null | grep -x 'securechat/server/dist/src/index.js' >/dev/null; then
  echo "✘ 这不是密聊的更新包（或文件已损坏）"; exit 1
fi
# the installed version: from the root-owned record if there is one (package.json belongs to the web user)
OLD_VER=$(cat "$ROOT_OPS/installed-version" 2>/dev/null || app_version)
NEW_VER=$(tar xzf "$PKG" -O securechat/package.json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))" 2>/dev/null || echo "?")
log "更新 $OLD_VER → $NEW_VER"
# no silent downgrades: an old (validly signed) package could bring back fixed bugs
if [ "${ALLOW_DOWNGRADE:-}" != 1 ]; then
  if ! node -e "
    const p = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v); if (!m) process.exit(2); return m.slice(1).map(Number); };
    const [a, b] = process.argv.slice(1).map(p);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) process.exit(b[i] > a[i] ? 0 : 1);
    process.exit(0);" "$OLD_VER" "$NEW_VER"; then
    echo "✘ 新包版本 $NEW_VER 不比当前 $OLD_VER 新（或版本号无法识别），已停止。确实要降级请加 ALLOW_DOWNGRADE=1。"; exit 1
  fi
fi

log "1/5 备份数据"
bash "$(dirname "$0")/backup.sh" || { echo "✘ 备份失败（原因见上面），升级没有开始。"; exit 1; }

log "2/5 保存当前代码（用于回滚）"
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$RELEASE_DIR"
chmod 700 "$RELEASE_DIR"
SAVED="$RELEASE_DIR/code-$OLD_VER-$TS.tar.gz"
tar czf "$SAVED" -C "$(dirname "$APP_DIR")" --exclude='securechat/node_modules' --exclude='securechat/data' --exclude='securechat/.env' securechat

STG=$(mktemp -d /tmp/securechat-upd.XXXXXX)
tar xzf "$PKG" -C "$STG" --no-same-owner
chmod -R a+rX,ug-s "$STG"   # the signed package's files: the web user copies them into its folder
# the root-owned scripts as they are now: a rollback restores these (never scripts from the web user's folder)
ROOTOPS_BAK="$SECURECHAT_UPDATE_COPY/rootops-before"
mkdir -m 700 "$ROOTOPS_BAK"
for f in "$ROOT_OPS"/*.sh "$ROOT_OPS"/*.mjs; do
  if [ -f "$f" ]; then cp -p "$f" "$ROOTOPS_BAK/" || { echo "✘ 保存 root 专有脚本失败（磁盘满了？），升级没有开始。"; exit 1; }; fi
done
OLD_LOCK=$(lock_hash "$APP_DIR/package-lock.json")

# Copy a release into the app folder. The folder belongs to the web user, so the copying is done AS that user:
# a symlink planted there can't make root write or delete anything outside it.
install_from() { # $1 = dir that contains securechat/, readable by the web user
  chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
  (cd "$APP_DIR" && as_app bash -c '
    set -e
    S=$1/securechat A=$2
    rsync -rlptD --delete "$S/server/dist/" "$A/server/dist/"
    rsync -rlptD --delete "$S/web/dist/" "$A/web/dist/"
    if [ -d "$S/ops" ]; then rsync -rlptD --delete "$S/ops/" "$A/ops/"; fi
    if [ -d "$S/docs" ]; then mkdir -p "$A/docs" && rsync -rlptD "$S/docs/" "$A/docs/"; fi
    for f in package.json package-lock.json start.sh server/package.json web/package.json CHANGELOG.md; do
      if [ -f "$S/$f" ] && [ ! -L "$S/$f" ]; then install -D -m 644 "$S/$f" "$A/$f"; fi
    done
    chmod 755 "$A/start.sh"' _ "$1" "$APP_DIR")
}

log "3/5 安装新版本"
FAILED=""
if ! install_from "$STG"; then log "✘ 复制新版本文件失败"; FAILED=1; fi
install_root_ops "$STG/securechat/ops"
NEW_LOCK=$(lock_hash "$STG/securechat/package-lock.json")
if [ "$OLD_LOCK" != "$NEW_LOCK" ]; then
  log "    依赖有变化，重新安装（npm ci）"
  if ! app_npm_ci "$LOG_DIR/npm.log"; then
    log "✘ npm ci 失败，见 $LOG_DIR/npm.log"
    FAILED=1
  fi
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
# v1.0: the NEW version's self-check: dependencies load with this Node, config, services, root scripts, log limits
# (skipped when an older package without the self-check was installed on purpose: ALLOW_DOWNGRADE)
if [ -z "$FAILED" ] && [ -f "$ROOT_OPS/doctor.sh" ] && grep -q '^as_app()' "$ROOT_OPS/common.sh"; then
  log "    新版本自检（缺什么装什么）"
  bash "$ROOT_OPS/doctor.sh" --phase post || { log "✘ 新版本自检没有通过"; FAILED=1; }
  chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
fi

log "4/5 重启服务"
RESTART_AT=$(date +%s)
systemctl restart "$SERVICE"

log "5/5 健康检查（必须是刚启动的 $NEW_VER）"
WANT=$NEW_VER; [ "$WANT" = "?" ] && WANT=""
if [ -z "$FAILED" ] && wait_new_process "$RESTART_AT" "$WANT" 30; then
  log "✔ 更新成功: $(health)"
  [ "$NEW_VER" != "?" ] && printf '%s\n' "$NEW_VER" > "$ROOT_OPS/installed-version.tmp" && mv -f "$ROOT_OPS/installed-version.tmp" "$ROOT_OPS/installed-version"
  [ -f "$ROOT_OPS/log-limits.sh" ] && bash "$ROOT_OPS/log-limits.sh" >/dev/null || true
  if [ -f "$ROOT_OPS/doctor.sh" ] && grep -q '^as_app()' "$ROOT_OPS/common.sh"; then
    bash "$ROOT_OPS/doctor.sh" --phase final || log "⚠ 运行状态自检发现问题（见上面的 ✘），新版本已经在运行"
  fi
  ls -1t "$RELEASE_DIR"/code-*.tar.gz 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r f; do rm -f -- "$f"; done
  exit 0
fi

if [ -n "$FAILED" ]; then log "✘ 新版本安装或自检没有通过，自动回滚到 $OLD_VER"; else log "✘ 新版本没有正常启动，自动回滚到 $OLD_VER"; fi
journalctl -u "$SERVICE" -n 20 --no-pager || true
# the saved code came from the web user's folder: unpacked AS the web user (root would keep set-uid bits etc.)
RB=$(mktemp -d /tmp/securechat-rb.XXXXXX)
chmod 711 "$RB"
install -d -m 700 -o "$RUN_USER" -g "$RUN_USER" "$RB/x"
as_app tar xzf - -C "$RB/x" < "$SAVED" || log "✘ 解开保存的旧版本时出错"
install_from "$RB/x" || log "✘ 恢复旧版本文件时出错"
install_root_ops "$ROOTOPS_BAK"   # the root copies go back to what they were (saved from the root-owned folder)
for f in "$ROOT_OPS"/*.sh "$ROOT_OPS"/*.mjs; do   # and scripts the new version added are taken out again
  if [ -f "$f" ] && [ ! -e "$ROOTOPS_BAK/$(basename "$f")" ] && [ -n "$(ls -A "$ROOTOPS_BAK")" ]; then rm -f -- "$f"; fi
done
if [ "$OLD_LOCK" != "$NEW_LOCK" ]; then app_npm_ci "$LOG_DIR/npm-rollback.log" || true; fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
RESTART_AT=$(date +%s)
systemctl restart "$SERVICE"
if wait_new_process "$RESTART_AT" "" 30; then
  log "已回滚，服务恢复正常: $(health)"
  log "（自检已经补装的系统工具、Node.js 和改正的配置不会撤销，它们对旧版本同样适用）"
else
  log "✘ 回滚后仍未恢复，请查看: journalctl -u $SERVICE -n 100"
fi
exit 1
