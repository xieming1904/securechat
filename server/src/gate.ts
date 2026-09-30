import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from './context.js';
import { getSetting } from './db.js';
import { verifyPassword } from './sodium.js';
import { ipKey, newId, now, sha256, str, HttpError } from './util.js';
import { gateRules } from './settings.js';
import { raiseAlert } from './alerts.js';

declare module 'fastify' {
  interface FastifyRequest {
    ipKey: string;
    ipAllowed: boolean;
  }
}

const GATE_PUBLIC_PATHS = new Set(['/__gate.js', '/__gate.css', '/healthz']);

// ---------------------------------------------------------------------------
// allow / block list primitives (also used by admin + invites + CLI)
// ---------------------------------------------------------------------------
export function isAllowed(ctx: Ctx, key: string): boolean {
  const row = ctx.db.prepare('SELECT id, last_seen_at, expires_at FROM ip_allowlist WHERE ip_key = ?').get(key) as
    | { id: string; last_seen_at: number; expires_at: number | null }
    | undefined;
  if (!row) return false;
  const t = now();
  const idleLimit = ctx.config.allowlistIdleDays * 86_400_000;
  if ((row.expires_at && row.expires_at < t) || (idleLimit > 0 && t - row.last_seen_at > idleLimit)) {
    ctx.db.prepare('DELETE FROM ip_allowlist WHERE id = ?').run(row.id);
    return false;
  }
  if (t - row.last_seen_at > 60_000) ctx.db.prepare('UPDATE ip_allowlist SET last_seen_at = ? WHERE id = ?').run(t, row.id);
  return true;
}

export function allowIp(ctx: Ctx, key: string, source: string, note?: string) {
  const t = now();
  ctx.db
    .prepare(
      `INSERT INTO ip_allowlist(id, ip_key, source, note, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ip_key) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
    .run(newId('ip'), key, source, note ?? null, t, t);
  ctx.db.prepare('DELETE FROM ip_blocklist WHERE ip_key = ?').run(key);
}

function blockState(ctx: Ctx, key: string) {
  return ctx.db.prepare('SELECT * FROM ip_blocklist WHERE ip_key = ?').get(key) as
    | { fail_count: number; total_fails: number; window_start: number | null; blocked_until: number | null; permanent: number }
    | undefined;
}

export function isBlocked(ctx: Ctx, key: string): boolean {
  return !!activeBlock(ctx, key);
}

/** Current block for this IP: { until: null } = permanent, { until: ms } = temporary, undefined = not blocked. */
export function activeBlock(ctx: Ctx, key: string): { until: number | null } | undefined {
  const b = blockState(ctx, key);
  if (!b) return undefined;
  if (b.permanent === 1) return { until: null };
  if (b.blocked_until !== null && b.blocked_until > now()) return { until: b.blocked_until };
  return undefined;
}

/** If the failure just recorded tipped this IP into a block, answer with the block details right away. */
function blockedNow(ctx: Ctx, req: FastifyRequest, reply: FastifyReply) {
  const block = activeBlock(ctx, req.ipKey);
  if (block) reply.code(403).send({ error: 'ip_blocked', message: 'IP 已被封禁', ip: req.ip, until: block.until });
}

function escHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function blockedHtml(ip: string, until: number | null) {
  const when = until === null
    ? '<span data-en="has been blocked permanently. Please ask the administrator to unblock it.">已被永久封禁，请联系管理员解除。</span>'
    : `<span data-en="has been blocked temporarily. It will be unblocked at">已被暂时封禁，将于</span> <span id="u" data-t="${until}">${new Date(until).toISOString().replace('T', ' ').slice(0, 16)} UTC</span> <span data-en=".">自动解除。</span>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title data-en="Access denied">访问被拒绝</title><link rel="stylesheet" href="/__gate.css"></head>
<body><main class="card">
  <h1 data-en="Access denied">访问被拒绝</h1>
  <p data-en="Because of too many failed attempts, your IP address">由于验证失败次数过多，你的 IP 地址</p>
  <p class="ip">${escHtml(ip)}</p>
  <p class="muted">${when}</p>
  <p class="muted small" data-en="If this is a mistake, send the IP address above to the administrator — they can lift the block under Admin console → IP allowlist → Blocked IPs.">如果这是误封，把上面的 IP 地址告诉管理员，在「管理后台 → IP 白名单 → 封禁中的 IP」里解除即可。</p>
</main><script src="/__gate.js"></script></body></html>`;
}

function recordAttempt(ctx: Ctx, req: FastifyRequest, method: string, success: boolean) {
  ctx.db
    .prepare('INSERT INTO gate_attempts(ip, method, success, user_agent, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.ip, method, success ? 1 : 0, String(req.headers['user-agent'] ?? '').slice(0, 300), now());
}

function recordFailure(ctx: Ctx, key: string) {
  const r = gateRules(ctx);
  const gateMaxFails = r.maxFails;
  const gateWindowMs = r.windowMin * 60_000;
  const gateBlockMs = r.blockMin * 60_000;
  const gatePermanentAfter = r.permanentAfter > 0 ? r.permanentAfter : Infinity;
  const t = now();
  const b = blockState(ctx, key);
  let fail = 1;
  let total = 1;
  let windowStart = t;
  if (b) {
    total = b.total_fails + 1;
    if (b.window_start && t - b.window_start < gateWindowMs) {
      fail = b.fail_count + 1;
      windowStart = b.window_start;
    }
  }
  let blockedUntil: number | null = null;
  if (fail >= gateMaxFails) {
    blockedUntil = t + gateBlockMs;
    fail = 0;
  }
  const permanent = total >= gatePermanentAfter ? 1 : 0;
  ctx.db
    .prepare(
      `INSERT INTO ip_blocklist(ip_key, fail_count, total_fails, window_start, blocked_until, permanent) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ip_key) DO UPDATE SET fail_count = excluded.fail_count, total_fails = excluded.total_fails,
         window_start = excluded.window_start, blocked_until = COALESCE(excluded.blocked_until, blocked_until), permanent = excluded.permanent`,
    )
    .run(key, fail, total, windowStart, blockedUntil, permanent);
  if (permanent && !b?.permanent) raiseAlert(ctx, 'ip_banned', `IP ${key} 累计输错 ${total} 次，已被永久封禁`, `ban:${key}`, 30 * 86_400_000);
  else if (blockedUntil) raiseAlert(ctx, 'ip_blocked', `IP ${key} 连续输错访问密码，已暂时封禁 ${r.blockMin} 分钟`, `block:${key}`);
}

/** Find a usable invite by its link token or short code. */
export function findUsableInvite(ctx: Ctx, tokenOrCode: string) {
  const v = tokenOrCode.trim();
  const inv = ctx.db
    .prepare('SELECT * FROM invites WHERE token_hash = ? OR code_hash = ?')
    .get(sha256(v), sha256(v.toUpperCase())) as InviteRow | undefined;
  if (!inv) return undefined;
  if (inv.revoked_at) return undefined;
  if (inv.expires_at && inv.expires_at < now()) return undefined;
  if (inv.max_uses !== null && inv.used_count >= inv.max_uses) return undefined;
  return inv;
}

export interface InviteRow {
  id: string;
  token_hash: string;
  code_hash: string | null;
  kind: 'register' | 'group';
  chat_id: string | null;
  created_by: string | null;
  max_uses: number | null;
  used_count: number;
  gate_uses: number;
  grants_admin: number;
  needs_approval: number;
  note: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Fastify wiring
// ---------------------------------------------------------------------------
export function registerGate(app: FastifyInstance, ctx: Ctx) {
  app.decorateRequest('ipKey', '');
  app.decorateRequest('ipAllowed', false);

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    req.ipKey = ipKey(req.ip, ctx.config.ipv6Prefix);
    if (isAllowed(ctx, req.ipKey)) {
      req.ipAllowed = true;
      return;
    }
    const block = activeBlock(ctx, req.ipKey);
    if (block) {
      if (GATE_PUBLIC_PATHS.has(url)) return; // the blocked page still needs its stylesheet/script
      if (req.method === 'GET' && !url.startsWith('/api/') && !url.startsWith('/socket.io'))
        return reply.code(403).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(blockedHtml(req.ip, block.until));
      return reply.code(403).send({ error: 'ip_blocked', message: 'IP 已被封禁', ip: req.ip, until: block.until });
    }
    if (url.startsWith('/api/gate/') || GATE_PUBLIC_PATHS.has(url)) return;
    if (url.startsWith('/api/') || url.startsWith('/socket.io')) return reply.code(403).send({ error: 'ip_not_allowed' });
    if (req.method === 'GET')
      return reply.code(403).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(GATE_HTML.replace('${IP}', () => escHtml(req.ip)));
    return reply.code(403).send();
  });

  app.get('/__gate.js', async (_req, reply) => reply.type('application/javascript; charset=utf-8').send(GATE_JS));
  app.get('/__gate.css', async (_req, reply) => reply.type('text/css; charset=utf-8').send(GATE_CSS));

  app.get('/api/gate/status', async (req) => {
    const pending = ctx.db
      .prepare("SELECT 1 FROM gate_requests WHERE ip_key = ? AND status = 'pending'")
      .get(req.ipKey);
    return { allowed: req.ipAllowed, pending: !!pending, passwordEnabled: !!getSetting(ctx.db, 'gate_password_hash'), ip: req.ip };
  });

  /** Accepts either the site access password or an invite code. */
  app.post('/api/gate/password', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const secret = str(body, 'password', { max: 256 });
    const hash = getSetting(ctx.db, 'gate_password_hash');
    if (hash && verifyPassword(hash, secret)) {
      recordAttempt(ctx, req, 'password', true);
      allowIp(ctx, req.ipKey, 'password');
      return { ok: true, invite: false };
    }
    const inv = /^[A-Za-z0-9_-]{8,64}$/.test(secret.trim()) ? findUsableInvite(ctx, secret) : undefined;
    if (inv) {
      recordAttempt(ctx, req, 'invite', true);
      ctx.db.prepare('UPDATE invites SET gate_uses = gate_uses + 1 WHERE id = ?').run(inv.id);
      allowIp(ctx, req.ipKey, 'invite', `invite ${inv.id}`);
      return { ok: true, invite: true };
    }
    recordAttempt(ctx, req, 'password', false);
    recordFailure(ctx, req.ipKey);
    blockedNow(ctx, req, reply);
    if (reply.sent) return reply;
    throw new HttpError(401, 'wrong_password', '访问密码或邀请码错误');
  });

  app.post('/api/gate/invite', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const token = str(body, 'invite', { max: 128 });
    const inv = findUsableInvite(ctx, token);
    recordAttempt(ctx, req, 'invite', !!inv);
    if (!inv) {
      recordFailure(ctx, req.ipKey);
      blockedNow(ctx, req, reply);
      if (reply.sent) return reply;
      throw new HttpError(401, 'invalid_invite', '邀请无效或已过期');
    }
    ctx.db.prepare('UPDATE invites SET gate_uses = gate_uses + 1 WHERE id = ?').run(inv.id);
    allowIp(ctx, req.ipKey, 'invite', `invite ${inv.id}`);
    return { ok: true };
  });

  app.post('/api/gate/request', async (req) => {
    const body = req.body as Record<string, unknown>;
    const message = str(body, 'message', { max: 300, optional: true });
    const existing = ctx.db.prepare("SELECT id FROM gate_requests WHERE ip_key = ? AND status = 'pending'").get(req.ipKey);
    if (existing) return { ok: true, pending: true };
    const recent = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM gate_requests WHERE ip_key = ? AND created_at > ?')
      .get(req.ipKey, now() - 86_400_000) as { n: number };
    if (recent.n >= 3) throw new HttpError(429, 'too_many_requests', '今天的申请次数已用完');
    ctx.db
      .prepare('INSERT INTO gate_requests(id, ip_key, ip, message, user_agent, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId('gr'), req.ipKey, req.ip, message, String(req.headers['user-agent'] ?? '').slice(0, 300), 'pending', now());
    recordAttempt(ctx, req, 'request', true);
    ctx.emitAdmins('admin:gate-request', {});
    return { ok: true, pending: true };
  });
}

// ---------------------------------------------------------------------------
// Standalone gate page — deliberately contains no app code or branding.
// ---------------------------------------------------------------------------
const GATE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title data-en="Access check">访问验证</title><link rel="stylesheet" href="/__gate.css"></head>
<body><main class="card">
  <h1 data-en="Access check">访问验证</h1>
  <p class="muted" data-en="This network address isn't authorised yet. Enter the access password or an invite code.">此网络地址尚未获得授权。请输入访问密码或邀请码。</p>
  <form id="f"><input id="pw" type="password" autocomplete="current-password" placeholder="访问密码 / 邀请码" data-en-ph="Access password / invite code" required autofocus>
  <button type="submit" data-en="Enter">进入</button></form>
  <p class="muted small ipline"><span data-en="Your IP address:">你的 IP 地址：</span><span id="myip" class="ip-inline">${'${IP}'}</span></p>
  <p id="msg" class="msg" role="alert"></p>
  <details><summary data-en="No password? Ask an administrator to approve you">没有密码？申请管理员批准</summary>
    <form id="r"><input id="rm" maxlength="300" placeholder="留言（例如你是谁）" data-en-ph="Message (e.g. who you are)"><button type="submit" data-en="Send request">提交申请</button></form>
  </details>
  <p class="muted small" data-en="Once approved, this network address is remembered. You'll need to verify again on a different network (e.g. mobile data).">通过后本网络地址将被记住。更换网络（如手机流量）后需要重新验证。</p>
</main><script src="/__gate.js"></script></body></html>`;

const GATE_CSS = `:root{color-scheme:light dark;--bg:#f5f6fa;--card:#fff;--fg:#0f172a;--muted:#64748b;--faint:#94a3b8;--bd:#e6e8ef;--in:#fff;--acc:#4f6bff;--acc2:#7a5af8;--soft:#eef1ff;--err:#e5484d;--ok:#16a34a;--ring:0 0 0 3px rgba(79,107,255,.22)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0e14;--card:#11151e;--fg:#e7eaf0;--muted:#8b95a8;--faint:#5f697c;--bd:#1f2533;--in:#0b0e14;--acc:#6f86ff;--acc2:#9179ff;--soft:#1b2240;--err:#ff6369;--ok:#3dd68c;--ring:0 0 0 3px rgba(111,134,255,.3)}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;color:var(--fg);font:14.5px/1.55 -apple-system,BlinkMacSystemFont,"Inter","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;
background:radial-gradient(900px 500px at 10% -10%,color-mix(in srgb,var(--acc) 16%,transparent),transparent 60%),radial-gradient(800px 500px at 110% 110%,color-mix(in srgb,var(--acc2) 14%,transparent),transparent 60%),var(--bg)}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--bd);border-radius:22px;padding:32px 28px 26px;box-shadow:0 24px 60px -12px rgba(15,23,42,.28);animation:rise .35s cubic-bezier(.2,.8,.2,1)}
.card::before{content:"";display:block;width:52px;height:52px;margin:0 auto 16px;border-radius:16px;background:linear-gradient(135deg,var(--acc),var(--acc2)) center/100% no-repeat;box-shadow:0 10px 24px -8px color-mix(in srgb,var(--acc) 70%,transparent);}
.card::before{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='5' y='11' width='14' height='10' rx='2'/%3E%3Cpath d='M8 11V7a4 4 0 0 1 8 0v4'/%3E%3C/svg%3E"),linear-gradient(135deg,var(--acc),var(--acc2));background-size:26px 26px,100% 100%;background-position:center}
h1{margin:0 0 6px;font-size:22px;font-weight:700;text-align:center;letter-spacing:-.01em}.muted{color:var(--muted)}p.muted:first-of-type{text-align:center;margin:0 0 4px}.small{font-size:12.5px;margin-top:18px}
form{display:flex;gap:8px;margin-top:16px}input{flex:1;min-width:0;height:44px;padding:0 14px;border:1px solid var(--bd);border-radius:12px;background:var(--in);color:inherit;font:inherit;transition:border-color .15s,box-shadow .15s}input:focus{outline:none;border-color:var(--acc);box-shadow:var(--ring)}
button{height:44px;padding:0 18px;border:0;border-radius:12px;background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;font:inherit;font-weight:600;cursor:pointer;box-shadow:0 6px 16px -6px color-mix(in srgb,var(--acc) 70%,transparent)}button:hover{filter:brightness(1.07)}button:disabled{opacity:.6}
.msg{min-height:1.5em;color:var(--err);margin:10px 0 0;font-size:13.5px}.msg.ok{color:var(--ok)}details{margin-top:12px}summary{cursor:pointer;color:var(--muted);font-size:13px}summary:hover{color:var(--acc)}
.ip{font:700 22px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;margin:10px 0 12px;padding:10px;border-radius:12px;background:var(--soft);color:var(--acc);text-align:center;word-break:break-all;user-select:all}
.ip-inline{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);background:var(--soft);padding:1px 7px;border-radius:6px;user-select:all}.ipline{margin:12px 0 0;text-align:center}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`;

const GATE_JS = `(function(){
var EN=(function(){try{var p=JSON.parse(localStorage.getItem('securechat.prefs.v1')||'{}');if(p.lang)return p.lang==='en'}catch(e){}return !/^zh/i.test(navigator.language||'zh')})();
var D={'验证通过，正在进入…':'Verified, entering…','正在验证邀请链接…':'Checking the invite link…','邀请链接无效或已过期':'The invite link is invalid or has expired','密码或邀请码错误':'Wrong password or invite code','网络错误':'Network error','申请已提交，等待管理员批准。本页会自动刷新。':'Request sent. Waiting for an administrator — this page refreshes automatically.','申请已提交，等待管理员批准。':'Request sent. Waiting for an administrator.','提交失败':'Could not send the request'};
function L(s){return EN&&D[s]?D[s]:s}
if(EN){document.documentElement.lang='en';var n=document.querySelectorAll('[data-en]');for(var i=0;i<n.length;i++)n[i].textContent=n[i].getAttribute('data-en');var q=document.querySelectorAll('[data-en-ph]');for(var j=0;j<q.length;j++)q[j].setAttribute('placeholder',q[j].getAttribute('data-en-ph'));}
var msg=document.getElementById('msg');
function say(t,ok){if(!msg)return;msg.textContent=L(t);msg.className='msg'+(ok?' ok':'');}
function post(u,b){return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,status:r.status,body:j}})})}
var m=location.pathname.match(/^\\/i\\/([A-Za-z0-9_-]+)$/);
function go(){location.reload();}
function fmt(t){var d=new Date(t);function p(n){return(n<10?'0':'')+n}return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())}
function blocked(b){var ip=(b&&b.ip)||'';if(EN){say('Too many attempts. IP address '+ip+(b&&b.until?' is blocked until '+fmt(b.until):' is blocked — please contact the administrator'));return}say('尝试次数过多，IP 地址 '+ip+(b&&b.until?' 已被暂时封禁，'+fmt(b.until)+' 后自动解除':' 已被封禁，请联系管理员'))}
var u=document.getElementById('u');if(u)u.textContent=fmt(+u.getAttribute('data-t'));
if(!document.getElementById('f'))return;
function tryInvite(v){return post('/api/gate/invite',{invite:v}).then(function(r){if(r.ok){say('验证通过，正在进入…',true);go();return true}return false})}
if(m){say('正在验证邀请链接…',true);tryInvite(m[1]).then(function(ok){if(!ok)say('邀请链接无效或已过期')})}
document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();var v=document.getElementById('pw').value.trim();if(!v)return;
var btn=e.target.querySelector('button');btn.disabled=true;say('');
post('/api/gate/password',{password:v}).then(function(r){if(r.ok){say('验证通过，正在进入…',true);setTimeout(function(){if(r.body.invite)location.href='/i/'+encodeURIComponent(v);else go()},300);return}
if(r.status===403){blocked(r.body);return}
say('密码或邀请码错误')}).catch(function(){say('网络错误')}).then(function(){btn.disabled=false})});
document.getElementById('r').addEventListener('submit',function(e){e.preventDefault();post('/api/gate/request',{message:document.getElementById('rm').value}).then(function(r){
if(r.ok){say('申请已提交，等待管理员批准。本页会自动刷新。',true);poll()}else say((r.body&&r.body.message)||'提交失败')})});
function poll(){setInterval(function(){fetch('/api/gate/status').then(function(r){return r.json()}).then(function(j){if(j.allowed)go()})},5000)}
fetch('/api/gate/status').then(function(r){return r.json()}).then(function(j){if(j.pending){say('申请已提交，等待管理员批准。',true);poll()}});
})();`;
