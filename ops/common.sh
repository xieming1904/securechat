# Shared settings for the ops scripts. Override any of these in /etc/securechat-ops.conf.
APP_DIR=${APP_DIR:-/www/wwwroot/securechat}
BACKUP_DIR=${BACKUP_DIR:-/www/backup/securechat}
RELEASE_DIR=${RELEASE_DIR:-/www/backup/securechat-releases}
KEEP_DAYS=${KEEP_DAYS:-7}
KEEP_RELEASES=${KEEP_RELEASES:-5}
SERVICE=${SERVICE:-securechat}
RUN_USER=${RUN_USER:-www}
PORT=${PORT:-3000}
# root-owned copy of these scripts (v0.7): root never runs scripts the web user could have edited
ROOT_OPS=${ROOT_OPS:-/usr/local/lib/securechat-ops}
[ -f /etc/securechat-ops.conf ] && . /etc/securechat-ops.conf

# Node.js: the one BaoTa installed (v22), the one doctor.sh installed, or whatever `node` is on PATH.
NODE_MAJOR=${NODE_MAJOR:-22}
OWN_NODE=${OWN_NODE:-/usr/local/lib/securechat-node}
node_major() { "$1/node" -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
# True if $1 (after resolving symlinks) and every directory above it belong to root and can't be changed by anyone
# else. Root runs this Node.js (signature checks, backups), so a copy the web user could edit must never be picked.
root_safe() {
  local p m
  p=$(readlink -f -- "$1" 2>/dev/null) || return 1
  case "$p" in "" | *[!A-Za-z0-9._/+-]*) return 1 ;; esac
  while :; do
    [ "$(stat -c '%u' -- "$p" 2>/dev/null)" = 0 ] || return 1
    m=$(stat -c '%a' -- "$p" 2>/dev/null) || return 1
    [ $(( 0$m & 022 )) = 0 ] || return 1
    [ "$p" = / ] && return 0
    p=$(dirname -- "$p")
  done
}
# a Node.js install is usable by root only if the whole install (bin, lib incl. npm) belongs to root and is read-only
# for everybody else
node_dir_ok() {
  local top
  [ -x "$1/node" ] && root_safe "$1" && root_safe "$1/node" || return 1
  top=$(readlink -f "$1/..") || return 1
  [ -z "$(find "$top" -xdev ! -type l \( ! -user root -o -perm /022 \) -print -quit 2>/dev/null)" ]
}
find_node_bin() {
  local n
  if [ -n "${NODE_BIN_OVERRIDE:-}" ] && node_dir_ok "$NODE_BIN_OVERRIDE"; then readlink -f "$NODE_BIN_OVERRIDE"; return 0; fi
  for n in $(ls -d /www/server/nodejs/v${NODE_MAJOR}.*/bin 2>/dev/null | sort -rV); do
    if node_dir_ok "$n"; then readlink -f "$n"; return 0; fi
  done
  if node_dir_ok "$OWN_NODE/bin" && [ "$(node_major "$OWN_NODE/bin")" = "$NODE_MAJOR" ]; then readlink -f "$OWN_NODE/bin"; return 0; fi
  if n=$(command -v node 2>/dev/null); then n=$(dirname "$(readlink -f "$n")"); node_dir_ok "$n" && { echo "$n"; return 0; }; fi
  return 1
}
# (no hard failure here: doctor.sh installs Node when it is missing; the other scripts fail on their first `node`)
NODE_BIN=$(find_node_bin || true)
if [ -n "$NODE_BIN" ]; then export PATH="$NODE_BIN:$PATH"
else
  # never fall back to some other `node` on PATH: it may be one the web user can change
  node() { echo "没有找到只有 root 能改的 Node.js ${NODE_MAJOR}：请运行 doctor.sh（会自动安装）" >&2; return 127; }
  npm() { node; }
fi
LOG_DIR=${LOG_DIR:-/var/log/securechat}

# Run a command as the app user, with a clean environment. Anything that executes code from the app directory
# (node_modules, npm install scripts, the app's own scripts) or writes into it runs this way — never as root,
# because that directory belongs to the web user.
# new session, no controlling terminal: code run as the app user can't type into root's terminal (TIOCSTI)
if setsid --help 2>&1 | grep -q -- '--wait'; then SETSID_W=(setsid -w); else SETSID_W=(); fi
as_app() {
  local v keep=()
  # network settings root was given (proxy, extra CA) are passed on; nothing else from root's environment is
  for v in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
    [ -n "${!v:-}" ] && keep+=("$v=${!v}")
  done
  if command -v runuser >/dev/null 2>&1; then ${SETSID_W[@]+"${SETSID_W[@]}"} runuser -u "$RUN_USER" -- env -i PATH="$PATH" HOME="$APP_DIR" ${keep[@]+"${keep[@]}"} "$@"
  else ${SETSID_W[@]+"${SETSID_W[@]}"} sudo -u "$RUN_USER" env -i PATH="$PATH" HOME="$APP_DIR" ${keep[@]+"${keep[@]}"} "$@"; fi
}

# The version in the app's package.json, read as data (a www-owned package.json is never require()d by root).
app_version() {
  local f="$APP_DIR/package.json"
  if [ ! -f "$f" ] || [ -L "$f" ]; then echo "?"; return 0; fi
  as_app cat "$f" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let v='?';try{v=JSON.parse(s).version}catch{};console.log(/^[0-9A-Za-z.+-]{1,40}$/.test(v)?v:'?')})" 2>/dev/null || echo "?"
}

# npm ci for the server, as the app user (npm runs the packages' install scripts). Uses root's registry setting.
# usage: app_npm_ci <log file>
app_npm_ci() {
  local logf=$1 cache reg rc=0
  reg=$(cd / && npm config get registry 2>/dev/null) || reg=""
  case "$reg" in https://*) ;; *) reg=https://registry.npmjs.org/ ;; esac
  cache=$(mktemp -d /tmp/securechat-npmcache.XXXXXX)
  chown "$RUN_USER" "$cache"
  install -d -m 700 "$(dirname "$logf")"
  # if a native module has to be compiled, use this Node's own headers instead of downloading them
  local nodedir=""; [ -f "$NODE_BIN/../include/node/node.h" ] && nodedir=$(cd "$NODE_BIN/.." && pwd -P)
  (cd "$APP_DIR" && as_app env HOME="$cache" npm_config_devdir="$cache/node-gyp" ${nodedir:+npm_config_nodedir="$nodedir"} npm ci --omit=dev -w server --no-audit --no-fund --cache "$cache" --registry "$reg" --userconfig /dev/null) >"$logf" 2>&1 || rc=$?
  safe_rmtree "$cache"
  return $rc
}

# Hash of the dependency tree in a package-lock.json (read as data), without the app's own version number — so a
# plain version bump doesn't trigger a reinstall. usage: lock_hash <file>
lock_hash() {
  [ -f "$1" ] && [ ! -L "$1" ] || { echo none; return 0; }
  as_app cat "$1" 2>/dev/null | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try { const j=JSON.parse(s); delete j.version; if (j.packages && j.packages['']) delete j.packages[''].version;
        console.log(require('crypto').createHash('sha256').update(JSON.stringify(j)).digest('hex')); }
      catch { console.log('bad'); } })" 2>/dev/null || echo bad
}

# Keep a root-only copy of .env (the OPAQUE login key is in it — without it nobody can log in after a restore).
# Read as the app user (no symlink tricks). A backup that has a key is never replaced by one without a key or with a
# different key; when the content changes, the previous backup is kept with a date.
backup_env() {
  local b=/root/securechat-env.backup cur old k1 k2
  cur=$(as_app cat "$APP_DIR/.env" 2>/dev/null) || { echo "backup_env: 读不到 .env" >&2; return 1; }
  k1=$(printf '%s\n' "$cur" | sed -n 's/^OPAQUE_SERVER_SETUP=//p' | tail -1)
  [ -n "$k1" ] || { echo "backup_env: .env 里没有登录密钥，没有覆盖原来的备份" >&2; return 2; }
  if [ -f "$b" ]; then
    old=$(cat "$b")
    [ "$old" = "$cur" ] && return 0
    k2=$(printf '%s\n' "$old" | sed -n 's/^OPAQUE_SERVER_SETUP=//p' | tail -1)
    if [ -n "$k2" ] && [ "$k2" != "$k1" ]; then echo "backup_env: .env 里的登录密钥和备份里的不一样，没有覆盖备份，请人工核对" >&2; return 3; fi
    install -m 600 -o root -g root "$b" "$b.$(date +%Y%m%d-%H%M%S)"
  fi
  (umask 077; printf '%s\n' "$cur" > "$b.tmp") && mv -f "$b.tmp" "$b"
}

log() { echo "[$(date '+%F %T')] $*"; }

health() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null; }

wait_healthy() {
  local i
  for i in $(seq 1 "${1:-30}"); do
    health >/dev/null && return 0
    sleep 1
  done
  return 1
}

# Wait until a *freshly started* process answers: uptime must be younger than the restart,
# and (if given) it must report the expected version. Guards against the old process still answering.
# usage: wait_new_process <restart-epoch> <expected-version|""> [timeout]
wait_new_process() {
  local since=$1 want=$2 i j up ver
  for i in $(seq 1 "${3:-30}"); do
    if j=$(health); then
      up=$(printf '%s' "$j" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log((o.uptime??1e9)+' '+(o.version??''))})" 2>/dev/null || echo "1000000000 ")
      ver=${up#* }; up=${up%% *}
      if [ "$up" -le $(( $(date +%s) - since + 2 )) ] && { [ -z "$want" ] || [ "$ver" = "$want" ]; }; then return 0; fi
    fi
    sleep 1
  done
  return 1
}

# Delete a directory tree, but only if it really is inside one of the directories we own.
# Refuses empty paths, "/", and anything outside BACKUP_DIR / RELEASE_DIR / /tmp/securechat-*.
safe_rmtree() {
  local target d
  for d in "$BACKUP_DIR" "$RELEASE_DIR"; do
    case "$d" in /?*/?*) ;; *) echo "safe_rmtree: 备份目录配置异常（$d），已拒绝" >&2; return 1 ;; esac
  done
  for target in "$@"; do
    [ -n "$target" ] || { echo "safe_rmtree: 空路径，已拒绝" >&2; return 1; }
    target=$(readlink -m -- "$target")
    case "$target" in
      "$BACKUP_DIR"/?* | "$RELEASE_DIR"/?* | /tmp/securechat-?*) rm -rf -- "$target" ;;
      *) echo "safe_rmtree: 拒绝删除 $target（不在备份目录内）" >&2; return 1 ;;
    esac
  done
}

# Write a small status file into data/ for the app to read. data/ belongs to the app user, so this is done AS that
# user (never root): a symlink planted there can't make root overwrite or chown some other file.
# usage: write_marker <.name> <content>
write_marker() {
  case "$1" in .[a-z]*) ;; *) echo "write_marker: 名称无效" >&2; return 1 ;; esac
  as_app sh -c 'umask 077; t=$(mktemp "$1.XXXXXX") && printf "%s\n" "$2" > "$t" && mv -f "$t" "$1"' _ "$APP_DIR/data/$1" "$2"
}

# Copy the ops scripts from $1 into the root-owned $ROOT_OPS and point the root backup timer at that copy.
# $APP_DIR belongs to the web user (BaoTa), so scripts there could be changed by anything running as that user.
install_root_ops() {
  local src="$1" f unit="/etc/systemd/system/$SERVICE-backup.service"
  [ -d "$src" ] || return 0
  [ "$(cd "$src" && pwd -P)" = "$(cd "$ROOT_OPS" 2>/dev/null && pwd -P)" ] && return 0   # already the root copy
  install -d -m 755 -o root -g root "$ROOT_OPS"
  for f in "$src"/*.sh "$src"/*.mjs; do if [ -f "$f" ] && [ ! -L "$f" ]; then install -m 755 -o root -g root "$f" "$ROOT_OPS/"; fi; done
  # the release public key is never installed by an update: root pins it by hand with install-release-key.sh,
  # after comparing its key id with the one in the release notes
  if [ -f "$src/release.pub" ] && [ -f "$ROOT_OPS/release.pub" ] && ! cmp -s "$src/release.pub" "$ROOT_OPS/release.pub"; then
    log "⚠ 更新包里带的发布公钥和服务器上固定的不同，没有替换（更换密钥见运维手册）。"
  fi
  if [ -f "$unit" ] && ! grep -qx "ExecStart=/bin/bash $ROOT_OPS/backup.sh" "$unit"; then
    sed -i "s#^ExecStart=.*backup\.sh\$#ExecStart=/bin/bash $ROOT_OPS/backup.sh#" "$unit"
    systemctl daemon-reload
  fi
}

# The systemd units (v1.0: shared by install-service.sh and doctor.sh). Writes a unit only if its content changed;
# prints the names of the units it rewrote.
write_units() {
  local tmp changed=""
  tmp=$(mktemp -d /tmp/securechat-units.XXXXXX)
  cat > "$tmp/$SERVICE.service" <<UNIT
[Unit]
Description=密聊 encrypted chat
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash $APP_DIR/start.sh
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=15
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
  cat > "$tmp/$SERVICE-backup.service" <<UNIT
[Unit]
Description=密聊 daily backup

[Service]
Type=oneshot
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash $ROOT_OPS/backup.sh
UNIT
  cat > "$tmp/$SERVICE-backup.timer" <<UNIT
[Unit]
Description=密聊 daily backup (04:17)

[Timer]
OnCalendar=*-*-* 04:17:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  local u
  for u in "$SERVICE.service" "$SERVICE-backup.service" "$SERVICE-backup.timer"; do
    if ! cmp -s "$tmp/$u" "/etc/systemd/system/$u"; then
      install -m 644 -o root -g root "$tmp/$u" "/etc/systemd/system/$u"
      changed="$changed $u"
    fi
  done
  rm -f "$tmp"/*.service "$tmp"/*.timer && rmdir "$tmp"
  if [ -n "$changed" ]; then systemctl daemon-reload; fi
  printf '%s' "$changed"
}

