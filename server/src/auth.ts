import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from './context.js';
import { enforce2fa, verifySecondFactor } from './totp.js';
import { hasSecondFactor, passkeyAuthOptions, secondFactorMethods, verifyPasskey } from './passkey.js';
import { limits } from './settings.js';
import { noteActivity } from './insights.js';
import { blockedEitherWay, privacyOf } from './social.js';
import { raiseAlert } from './alerts.js';
import { findUsableInvite } from './gate.js';
import { opaque, serverPublicKey, serverSetup } from './sodium.js';
import { HttpError, b64, newId, now, randomToken, sha256, str } from './util.js';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  opaque_record: string | null;
  recovery_record: string | null;
  is_admin: number;
  invited_by: string | null;
  created_at: number;
  disabled_at: number | null;
  deleted_at?: number | null;
}

export interface AuthInfo {
  user: UserRow;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthInfo;
  }
}

export const COOKIE = 'sid';
export const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;

/** Resolve a session token (cookie value) into user + session. */
export function resolveSession(ctx: Ctx, token: string | undefined): AuthInfo | undefined {
  if (!token) return undefined;
  const row = ctx.db
    .prepare(
      `SELECT s.id AS sid, s.expires_at, s.last_seen_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as (UserRow & { sid: string; expires_at: number; last_seen_at: number }) | undefined;
  if (!row) return undefined;
  const t = now();
  if (row.expires_at < t || row.disabled_at) return undefined;
  if (t - row.last_seen_at > 60_000) {
    // sliding expiry
    ctx.db
      .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(t, t + ctx.config.sessionDays * 86_400_000, row.sid);
  }
  const { sid, expires_at: _e, last_seen_at: _l, ...user } = row;
  return { user: user as UserRow, sessionId: sid };
}

/** Sessions that proved the password recently (10 min): a fresh login counts too. */
const reauthed = new Map<string, number>();
function markReauthed(sessionId: string) {
  const t = now();
  if (reauthed.size > 10_000) for (const [k, v] of reauthed) if (v < t) reauthed.delete(k);
  reauthed.set(sessionId, t + 10 * 60_000);
}
export function requireRecentPassword(ctx: Ctx, auth: AuthInfo) {
  const until = reauthed.get(auth.sessionId) ?? 0;
  if (until > now()) return;
  // a sign-in with the password in the last 10 minutes counts too (not a QR-linked device: it never saw the password)
  const s = ctx.db.prepare('SELECT pw_at FROM sessions WHERE id = ?').get(auth.sessionId) as { pw_at: number | null } | undefined;
  if (s?.pw_at && now() - s.pw_at < 10 * 60_000) return;
  throw new HttpError(403, 'reauth_required', '为了安全，请先输入登录密码确认');
}

export function requireUser(ctx: Ctx, req: FastifyRequest): AuthInfo {
  if (req.auth) return req.auth;
  const a = resolveSession(ctx, req.cookies[COOKIE]);
  if (!a) throw new HttpError(401, 'unauthorized', '请先登录');
  enforce2fa(ctx, req, a.user.id);
  noteActivity(ctx, a.user.id);
  req.auth = a;
  return a;
}

export function requireAdmin(ctx: Ctx, req: FastifyRequest): AuthInfo {
  const a = requireUser(ctx, req);
  if (!a.user.is_admin) throw new HttpError(403, 'forbidden', '需要管理员权限');
  return a;
}

export function publicUser(u: Pick<UserRow, 'id' | 'username' | 'display_name' | 'bio'> & { deleted_at?: number | null }) {
  return { id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, ...(u.deleted_at ? { deleted: true } : {}) };
}

export function selfUser(u: UserRow) {
  return { ...publicUser(u), isAdmin: !!u.is_admin, createdAt: u.created_at, totp: !!(u as UserRow & { totp_secret?: string | null }).totp_secret };
}

/** Password (or recovery phrase) was right, but the account has two-step verification: park the result for 5 min. */
const secondFactorTickets = new Map<string, { userId: string; kind: 'login' | 'recover'; deviceName: string; expires: number; tries: number }>();
function newTicket(userId: string, kind: 'login' | 'recover', deviceName: string) {
  for (const [k, v] of secondFactorTickets) if (v.expires < now()) secondFactorTickets.delete(k);
  const ticket = randomToken(24);
  secondFactorTickets.set(ticket, { userId, kind, deviceName, expires: now() + 5 * 60_000, tries: 0 });
  return ticket;
}

/** `password`: this sign-in proved the password (or recovery words) — false for a device linked by QR code. */
export function startSession(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, userId: string, deviceName: string, password = true) {
  const token = randomToken(32);
  const t = now();
  const id = newId('ses');
  const others = (ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').get(userId, t) as { n: number }).n;
  ctx.db
    .prepare(
      'INSERT INTO sessions(id, token_hash, user_id, device_name, user_agent, ip, created_at, last_seen_at, expires_at, pw_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, sha256(token), userId, deviceName || null, String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip, t, t, t + ctx.config.sessionDays * 86_400_000, password ? t : null);
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.config.cookieSecure,
    maxAge: ctx.config.sessionDays * 86_400,
  });
  // tell the user's other devices right away, so an unexpected login can be kicked out
  if (others > 0)
    ctx.emitToUsers([userId], 'security:new-login', {
      sessionId: id,
      deviceName: deviceName || null,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      ip: req.ip,
      at: t,
    });
  return id;
}

function keyBackup(ctx: Ctx, userId: string) {
  const k = ctx.db.prepare('SELECT sign_pk, box_pk, backup_ct, backup_nonce, key_version FROM user_keys WHERE user_id = ?').get(userId) as
    | { sign_pk: string; box_pk: string; backup_ct: string; backup_nonce: string; key_version: number }
    | undefined;
  return k && { signPk: k.sign_pk, boxPk: k.box_pk, backupCt: k.backup_ct, backupNonce: k.backup_nonce, keyVersion: k.key_version };
}
// ---------------------------------------------------------------------------
// throttling: failures per username and per IP (in memory)
// ---------------------------------------------------------------------------
const fails = new Map<string, { n: number; since: number }>();
export function checkThrottle(...keys: string[]) {
  for (const k of keys) {
    const e = fails.get(k);
    if (e && now() - e.since < 3_600_000 && e.n >= (k.startsWith('ip:') ? 30 : 10)) throw new HttpError(429, 'too_many_attempts', '尝试次数过多，请一小时后再试');
  }
}
export function clearFails(...keys: string[]) {
  keys.forEach((k) => fails.delete(k));
}
export function noteFail(ctx: Ctx, ...keys: string[]) {
  for (const k of keys) {
    const e = fails.get(k);
    if (!e || now() - e.since > 3_600_000) fails.set(k, { n: 1, since: now() });
    else {
      e.n++;
      if (e.n === 10 && (k.startsWith('u:') || k.startsWith('r:')))
        raiseAlert(ctx, 'login_bruteforce', `账号 @${k.slice(2)} 1 小时内${k.startsWith('r:') ? '恢复词' : '密码'}错误 10 次`, `bf:${k}`);
      if (e.n === 10 && /^2fa:[^:]+$/.test(k)) {
        const u = ctx.db.prepare('SELECT username FROM users WHERE id = ?').get(k.slice(4)) as { username: string } | undefined;
        raiseAlert(ctx, 'login_bruteforce', `账号 @${u?.username ?? '?'} 密码正确，但两步验证 1 小时内失败 10 次——密码可能已经泄露`, `bf:${k}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// OPAQUE bookkeeping. The server login state lives only in memory, is single-use
// and expires after 2 minutes — a replayed finishLoginRequest finds nothing.
// ---------------------------------------------------------------------------
type LoginKind = 'login' | 'recovery' | 'reauth';
interface PendingLogin {
  kind: LoginKind;
  userId: string | null;
  serverLoginState: string;
  expires: number;
}
const pendingLogins = new Map<string, PendingLogin>();
const recoveryTokens = new Map<string, { userId: string; expires: number }>();
function sweep() {
  const t = now();
  for (const [k, v] of pendingLogins) if (v.expires < t) pendingLogins.delete(k);
  for (const [k, v] of recoveryTokens) if (v.expires < t) recoveryTokens.delete(k);
  if (pendingLogins.size > 20_000) pendingLogins.clear();
}

/** OPAQUE user identifiers: one for the password record, one for the recovery-words record. */
export const pwIdent = (username: string) => `pw:${username.toLowerCase()}`;
export const rcIdent = (username: string) => `rc:${username.toLowerCase()}`;

const OPAQUE_MSG = /^[A-Za-z0-9_-]{16,2048}$/;
const opaqueField = (body: Record<string, unknown>, key: string) => str(body, key, { pattern: OPAQUE_MSG, max: 2048 });

function startOpaqueLogin(kind: LoginKind, user: UserRow | undefined, username: string, startLoginRequest: string) {
  sweep();
  const record = kind === 'recovery' ? user?.recovery_record : user?.opaque_record;
  const ident = kind === 'recovery' ? rcIdent(username) : pwIdent(username);
  let r: { loginResponse: string; serverLoginState: string };
  try {
    // unknown users get a well-formed fake response (the library handles record = null)
    r = opaque.server.startLogin({ serverSetup: serverSetup(), userIdentifier: ident, registrationRecord: record ?? null, startLoginRequest });
  } catch {
    throw new HttpError(400, 'invalid_input', '登录请求格式错误');
  }
  const loginId = randomToken(18);
  pendingLogins.set(loginId, { kind, userId: record ? user!.id : null, serverLoginState: r.serverLoginState, expires: now() + 120_000 });
  return { loginId, loginResponse: r.loginResponse };
}

/** Returns the user id if the proof is valid, otherwise null. Always consumes the pending state. */
function finishOpaqueLogin(kind: LoginKind, loginId: string, finishLoginRequest: string): string | null {
  const p = pendingLogins.get(loginId);
  pendingLogins.delete(loginId);
  if (!p || p.kind !== kind || p.expires < now() || !p.userId) return null;
  try {
    opaque.server.finishLogin({ finishLoginRequest, serverLoginState: p.serverLoginState });
    return p.userId;
  } catch {
    return null;
  }
}

function registrationResponse(ident: string, registrationRequest: string) {
  try {
    return opaque.server.createRegistrationResponse({ serverSetup: serverSetup(), userIdentifier: ident, registrationRequest }).registrationResponse;
  } catch {
    throw new HttpError(400, 'invalid_input', '注册请求格式错误');
  }
}

export function registerAuth(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/auth/meta', async () => ({ serverPublicKey: serverPublicKey() }));

  /** Preview an invite (registration page / group join page). */
  app.get('/api/invites/:token', async (req) => {
    const { token } = req.params as { token: string };
    const inv = findUsableInvite(ctx, token);
    if (!inv) throw new HttpError(404, 'invalid_invite', '邀请无效或已过期');
    const inviter = inv.created_by
      ? (ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(inv.created_by) as { display_name: string } | undefined)
      : undefined;
    return { kind: inv.kind, inviter: inviter?.display_name ?? null, expiresAt: inv.expires_at, grantsAdmin: !!inv.grants_admin };
  });


  // ------------------------------------------------------------------ registration (invite only)
  app.post('/api/auth/register/start', async (req) => {
    const body = req.body as Record<string, unknown>;
    const invite = str(body, 'invite', { max: 128 });
    const username = str(body, 'username', { pattern: USERNAME_RE });
    const inv = findUsableInvite(ctx, invite);
    if (!inv || inv.kind !== 'register') throw new HttpError(400, 'invalid_invite', '注册邀请无效或已过期');
    if (ctx.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'username_taken', '用户名已被占用');
    return {
      registrationResponse: registrationResponse(pwIdent(username), opaqueField(body, 'registrationRequest')),
      recoveryRegistrationResponse: registrationResponse(rcIdent(username), opaqueField(body, 'recoveryRegistrationRequest')),
    };
  });

  app.post('/api/auth/register/finish', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const invite = str(body, 'invite', { max: 128 });
    const username = str(body, 'username', { pattern: USERNAME_RE });
    const displayName = str(body, 'displayName', { min: 1, max: 64 }).trim();
    const registrationRecord = opaqueField(body, 'registrationRecord');
    const recoveryRecord = opaqueField(body, 'recoveryRecord');
    const signPk = b64(body, 'signPk', 32);
    const boxPk = b64(body, 'boxPk', 32);
    const backupCt = b64(body, 'backupCt', undefined, 4096);
    const backupNonce = b64(body, 'backupNonce', 24);
    const recoveryBackupCt = b64(body, 'recoveryBackupCt', undefined, 4096);
    const recoveryBackupNonce = b64(body, 'recoveryBackupNonce', 24);
    const deviceName = str(body, 'deviceName', { max: 64, optional: true });

    const inv = findUsableInvite(ctx, invite);
    if (!inv || inv.kind !== 'register') throw new HttpError(400, 'invalid_invite', '注册邀请无效或已过期');
    if (ctx.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'username_taken', '用户名已被占用');

    const id = newId('u');
    const t = now();
    ctx.db.transaction(() => {
      ctx.db
        .prepare('INSERT INTO users(id, username, display_name, opaque_record, recovery_record, is_admin, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, username, displayName, registrationRecord, recoveryRecord, inv.grants_admin, inv.created_by, t);
      ctx.db
        .prepare(
          'INSERT INTO user_keys(user_id, sign_pk, box_pk, backup_ct, backup_nonce, recovery_backup_ct, recovery_backup_nonce, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, signPk, boxPk, backupCt, backupNonce, recoveryBackupCt, recoveryBackupNonce, t);
      ctx.db.prepare('UPDATE invites SET used_count = used_count + 1 WHERE id = ?').run(inv.id);
      ctx.db.prepare('INSERT INTO invite_uses(invite_id, user_id, ip, used_at) VALUES (?, ?, ?, ?)').run(inv.id, id, req.ip, t);
    })();
    startSession(ctx, req, reply, id, deviceName);
    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
    return { user: selfUser(user), keys: keyBackup(ctx, id) };
  });

  // ------------------------------------------------------------------ login (OPAQUE)
  app.post('/api/auth/login/start', async (req) => {
    const body = req.body as Record<string, unknown>;
    const username = str(body, 'username', { max: 64 });
    // Every start counts as an attempt: a wrong password never reaches /finish (the client can't build a proof),
    // so counting only failed finishes would allow unlimited online guessing. A successful login clears the counter.
    checkThrottle(`u:${username.toLowerCase()}`, `ip:${req.ipKey}`);
    noteFail(ctx, `u:${username.toLowerCase()}`, `ip:${req.ipKey}`);
    const user = ctx.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    return startOpaqueLogin('login', user, username, opaqueField(body, 'startLoginRequest'));
  });

  app.post('/api/auth/login/finish', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const username = str(body, 'username', { max: 64 });
    const loginId = str(body, 'loginId', { max: 64 });
    const deviceName = str(body, 'deviceName', { max: 64, optional: true });
    const userId = finishOpaqueLogin('login', loginId, opaqueField(body, 'finishLoginRequest'));
    const user = userId ? (ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow) : undefined;
    if (!user || user.username.toLowerCase() !== username.toLowerCase()) {
      noteFail(ctx, `u:${username.toLowerCase()}`, `ip:${req.ipKey}`);
      throw new HttpError(401, 'bad_credentials', '用户名或密码错误');
    }
    if (user.disabled_at) throw new HttpError(403, 'disabled', '账号已被停用');
    clearFails(`u:${username.toLowerCase()}`);
    // with two-step verification the session (and the encrypted key backup) is only released after the code
    if (hasSecondFactor(ctx, user.id)) return { totpRequired: true, methods: secondFactorMethods(ctx, user.id), ticket: newTicket(user.id, 'login', deviceName) };
    startSession(ctx, req, reply, user.id, deviceName);
    return { user: selfUser(user), keys: keyBackup(ctx, user.id) };
  });

  /** Passkey challenge for the second step of a login / recovery. */
  app.post('/api/auth/2fa/passkey-options', async (req) => {
    const ticket = str(req.body as Record<string, unknown>, 'ticket', { max: 64 });
    const e = secondFactorTickets.get(ticket);
    if (!e || e.expires < now()) throw new HttpError(401, 'ticket_expired', '验证已超时，请重新登录');
    return passkeyAuthOptions(ctx, req, e.userId, `login:${ticket}`);
  });

  /** Second step of a login / recovery: the 6-digit code from the authenticator app, a one-time recovery code, or a passkey. */
  app.post('/api/auth/2fa', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const ticket = str(body, 'ticket', { max: 64 });
    const e = secondFactorTickets.get(ticket);
    if (!e || e.expires < now()) throw new HttpError(401, 'ticket_expired', '验证已超时，请重新登录');
    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(e.userId) as UserRow;
    // per account AND network: someone who only knows the password can't lock the owner out from elsewhere
    const k2 = `2fa:${user.id}:${req.ipKey}`;
    // …plus an account-wide budget, so changing IPs doesn't allow unlimited code guessing (and it raises an alert)
    const kAcc = `2fa:${user.id}`;
    checkThrottle(k2, kAcc, `ip:${req.ipKey}`);
    const ok = body.passkey ? await verifyPasskey(ctx, user.id, body.passkey, `login:${ticket}`) : verifySecondFactor(ctx, user.id, str(body, 'code', { max: 20 }));
    if (!ok) {
      noteFail(ctx, k2, kAcc, `ip:${req.ipKey}`);
      if (++e.tries >= 5) secondFactorTickets.delete(ticket);
      throw new HttpError(401, 'bad_code', body.passkey ? '通行密钥验证失败' : '验证码不正确');
    }
    secondFactorTickets.delete(ticket);
    clearFails(k2);
    if (user.disabled_at) throw new HttpError(403, 'disabled', '账号已被停用');
    if (e.kind === 'login') {
      startSession(ctx, req, reply, user.id, e.deviceName);
      return { user: selfUser(user), keys: keyBackup(ctx, user.id) };
    }
    return recoveryGrant(user.id);
  });

  // ------------------------------------------------------------------ change password (re-authenticate with the old one)
  app.post('/api/auth/password/start', async (req) => {
    const { user } = requireUser(ctx, req);
    const body = req.body as Record<string, unknown>;
    checkThrottle(`u:${user.username.toLowerCase()}`);
    noteFail(ctx, `u:${user.username.toLowerCase()}`);
    const login = startOpaqueLogin('reauth', user, user.username, opaqueField(body, 'startLoginRequest'));
    return { ...login, registrationResponse: registrationResponse(pwIdent(user.username), opaqueField(body, 'registrationRequest')) };
  });

  app.post('/api/auth/password/finish', async (req) => {
    const { user, sessionId } = requireUser(ctx, req);
    const body = req.body as Record<string, unknown>;
    const userId = finishOpaqueLogin('reauth', str(body, 'loginId', { max: 64 }), opaqueField(body, 'finishLoginRequest'));
    if (userId !== user.id) {
      noteFail(ctx, `u:${user.username.toLowerCase()}`);
      throw new HttpError(401, 'bad_credentials', '原密码错误');
    }
    clearFails(`u:${user.username.toLowerCase()}`);
    const record = opaqueField(body, 'registrationRecord');
    const backupCt = b64(body, 'backupCt', undefined, 4096);
    const backupNonce = b64(body, 'backupNonce', 24);
    const others = ctx.db.prepare('SELECT id FROM sessions WHERE user_id = ? AND id != ?').all(user.id, sessionId) as { id: string }[];
    ctx.db.transaction(() => {
      ctx.db.prepare('UPDATE users SET opaque_record = ? WHERE id = ?').run(record, user.id);
      ctx.db.prepare('UPDATE user_keys SET backup_ct = ?, backup_nonce = ?, updated_at = ? WHERE user_id = ?').run(backupCt, backupNonce, now(), user.id);
      ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(user.id, sessionId);
    })();
    others.forEach((s) => ctx.disconnectSession(s.id));
    return { ok: true };
  });

  // ------------------------------------------------------------------ re-authenticate (password) before sensitive changes
  // e.g. adding the FIRST second factor: a stolen session cookie alone must not be able to lock the owner out
  app.post('/api/auth/reauth/start', async (req) => {
    const { user } = requireUser(ctx, req);
    checkThrottle(`u:${user.username.toLowerCase()}`);
    noteFail(ctx, `u:${user.username.toLowerCase()}`);
    return startOpaqueLogin('reauth', user, user.username, opaqueField(req.body as Record<string, unknown>, 'startLoginRequest'));
  });
  app.post('/api/auth/reauth/finish', async (req) => {
    const { user, sessionId } = requireUser(ctx, req);
    const body = req.body as Record<string, unknown>;
    const userId = finishOpaqueLogin('reauth', str(body, 'loginId', { max: 64 }), opaqueField(body, 'finishLoginRequest'));
    if (userId !== user.id) {
      noteFail(ctx, `u:${user.username.toLowerCase()}`);
      throw new HttpError(401, 'bad_credentials', '密码错误');
    }
    clearFails(`u:${user.username.toLowerCase()}`);
    markReauthed(sessionId);
    return { ok: true };
  });

  // ------------------------------------------------------------------ regenerate the recovery words (re-authenticate with the password)
  app.post('/api/auth/recovery/start', async (req) => {
    const { user } = requireUser(ctx, req);
    const body = req.body as Record<string, unknown>;
    checkThrottle(`u:${user.username.toLowerCase()}`);
    noteFail(ctx, `u:${user.username.toLowerCase()}`);
    const login = startOpaqueLogin('reauth', user, user.username, opaqueField(body, 'startLoginRequest'));
    return { ...login, registrationResponse: registrationResponse(rcIdent(user.username), opaqueField(body, 'registrationRequest')) };
  });

  app.post('/api/auth/recovery/finish', async (req) => {
    const { user } = requireUser(ctx, req);
    const body = req.body as Record<string, unknown>;
    const userId = finishOpaqueLogin('reauth', str(body, 'loginId', { max: 64 }), opaqueField(body, 'finishLoginRequest'));
    if (userId !== user.id) {
      noteFail(ctx, `u:${user.username.toLowerCase()}`);
      throw new HttpError(401, 'bad_credentials', '密码错误');
    }
    clearFails(`u:${user.username.toLowerCase()}`);
    const record = opaqueField(body, 'recoveryRecord');
    const ct = b64(body, 'recoveryBackupCt', undefined, 4096);
    const nonce = b64(body, 'recoveryBackupNonce', 24);
    ctx.db.transaction(() => {
      ctx.db.prepare('UPDATE users SET recovery_record = ? WHERE id = ?').run(record, user.id);
      ctx.db.prepare('UPDATE user_keys SET recovery_backup_ct = ?, recovery_backup_nonce = ?, updated_at = ? WHERE user_id = ?').run(ct, nonce, now(), user.id);
    })();
    return { ok: true };
  });

  // ------------------------------------------------------------------ recovery with the 24 words
  app.post('/api/auth/recover/start', async (req) => {
    const body = req.body as Record<string, unknown>;
    const username = str(body, 'username', { max: 64 });
    checkThrottle(`r:${username.toLowerCase()}`, `ip:${req.ipKey}`);
    noteFail(ctx, `r:${username.toLowerCase()}`, `ip:${req.ipKey}`);
    const user = ctx.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    return startOpaqueLogin('recovery', user, username, opaqueField(body, 'startLoginRequest'));
  });

  app.post('/api/auth/recover/finish', async (req) => {
    const body = req.body as Record<string, unknown>;
    const username = str(body, 'username', { max: 64 });
    const userId = finishOpaqueLogin('recovery', str(body, 'loginId', { max: 64 }), opaqueField(body, 'finishLoginRequest'));
    const user = userId ? (ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow) : undefined;
    if (!user || user.username.toLowerCase() !== username.toLowerCase()) {
      noteFail(ctx, `r:${username.toLowerCase()}`, `ip:${req.ipKey}`);
      throw new HttpError(401, 'bad_recovery', '用户名或恢复词错误');
    }
    if (user.disabled_at) throw new HttpError(403, 'disabled', '账号已被停用');
    if (hasSecondFactor(ctx, user.id)) return { totpRequired: true, methods: secondFactorMethods(ctx, user.id), ticket: newTicket(user.id, 'recover', '') };
    return recoveryGrant(user.id);
  });

  function recoveryGrant(userId: string) {
    const k = ctx.db.prepare('SELECT recovery_backup_ct, recovery_backup_nonce FROM user_keys WHERE user_id = ?').get(userId) as {
      recovery_backup_ct: string;
      recovery_backup_nonce: string;
    };
    const token = randomToken(24);
    recoveryTokens.set(token, { userId, expires: now() + 10 * 60_000 });
    return { recoveryToken: token, recoveryBackupCt: k.recovery_backup_ct, recoveryBackupNonce: k.recovery_backup_nonce };
  }

  function useRecoveryToken(body: Record<string, unknown>, consume: boolean) {
    sweep();
    const token = str(body, 'recoveryToken', { max: 64 });
    const e = recoveryTokens.get(token);
    if (!e || e.expires < now()) throw new HttpError(401, 'recovery_expired', '恢复会话已过期，请重新输入恢复词');
    if (consume) recoveryTokens.delete(token);
    return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(e.userId) as UserRow;
  }

  app.post('/api/auth/recover/reset/start', async (req) => {
    const body = req.body as Record<string, unknown>;
    const user = useRecoveryToken(body, false);
    return { registrationResponse: registrationResponse(pwIdent(user.username), opaqueField(body, 'registrationRequest')) };
  });

  /** New password after recovery: every existing session is revoked, then a fresh one starts. */
  app.post('/api/auth/recover/reset/finish', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const record = opaqueField(body, 'registrationRecord');
    const backupCt = b64(body, 'backupCt', undefined, 4096);
    const backupNonce = b64(body, 'backupNonce', 24);
    const deviceName = str(body, 'deviceName', { max: 64, optional: true });
    const user = useRecoveryToken(body, true);
    const old = ctx.db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(user.id) as { id: string }[];
    ctx.db.transaction(() => {
      ctx.db.prepare('UPDATE users SET opaque_record = ? WHERE id = ?').run(record, user.id);
      ctx.db.prepare('UPDATE user_keys SET backup_ct = ?, backup_nonce = ?, updated_at = ? WHERE user_id = ?').run(backupCt, backupNonce, now(), user.id);
      ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    })();
    old.forEach((s) => ctx.disconnectSession(s.id));
    startSession(ctx, req, reply, user.id, deviceName);
    return { user: selfUser(user), keys: keyBackup(ctx, user.id) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const a = resolveSession(ctx, req.cookies[COOKIE]);
    if (a) {
      ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(a.sessionId);
      ctx.disconnectSession(a.sessionId);
    }
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const { user } = requireUser(ctx, req);
    const u = selfUser(user);
    return { user: { ...u, needs2fa: !!limits(ctx).require2fa && !hasSecondFactor(ctx, user.id) }, keys: keyBackup(ctx, user.id) };
  });

  app.patch('/api/me', async (req) => {
    const { user } = requireUser(ctx, req);
    const body = req.body as Record<string, unknown>;
    const displayName = body.displayName !== undefined ? str(body, 'displayName', { min: 1, max: 64 }).trim() : user.display_name;
    const bio = body.bio !== undefined ? str(body, 'bio', { max: 200, optional: true }) : user.bio;
    ctx.db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(displayName, bio, user.id);
    const u = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow;
    return { user: selfUser(u) };
  });

  app.get('/api/auth/sessions', async (req) => {
    const { user, sessionId } = requireUser(ctx, req);
    const rows = ctx.db
      .prepare('SELECT id, device_name, user_agent, ip, created_at, last_seen_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC')
      .all(user.id) as { id: string; device_name: string | null; user_agent: string; ip: string; created_at: number; last_seen_at: number }[];
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        deviceName: r.device_name,
        userAgent: r.user_agent,
        ip: r.ip,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        current: r.id === sessionId,
      })),
    };
  });

  app.delete('/api/auth/sessions/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const { id } = req.params as { id: string };
    const r = ctx.db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, user.id);
    if (r.changes) ctx.disconnectSession(id);
    return { ok: r.changes > 0 };
  });

  // ---- public user directory (exact lookups only, no enumeration) ----
  app.get('/api/users/by-username/:username', async (req) => {
    requireUser(ctx, req);
    const { username } = req.params as { username: string };
    const u = ctx.db.prepare('SELECT id, username, display_name, bio FROM users WHERE username = ? AND disabled_at IS NULL').get(username) as
      | UserRow
      | undefined;
    if (!u) throw new HttpError(404, 'not_found', '找不到该用户');
    return { user: publicUser(u) };
  });

  app.get('/api/users/:id', async (req) => {
    const { user: me } = requireUser(ctx, req);
    const { id } = req.params as { id: string };
    const u = ctx.db.prepare('SELECT id, username, display_name, bio, deleted_at FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!u) throw new HttpError(404, 'not_found', '找不到该用户');
    const k = keyBackup(ctx, id);
    // online status only under the same rules as in chats: share a chat, neither hides it, no block either way
    const shares = !!ctx.db.prepare('SELECT 1 FROM chat_members a JOIN chat_members b ON a.chat_id = b.chat_id WHERE a.user_id = ? AND b.user_id = ?').get(me.id, id);
    const visible = id === me.id || (shares && !privacyOf(ctx, me.id).hideOnline && !privacyOf(ctx, id).hideOnline && !blockedEitherWay(ctx, me.id, id));
    return { user: publicUser(u), keys: k && { signPk: k.signPk, boxPk: k.boxPk, keyVersion: k.keyVersion }, online: visible && (ctx.online.get(id) ?? 0) > 0 };
  });
}
