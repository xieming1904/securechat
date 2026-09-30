/**
 * Passkeys (WebAuthn) as a second factor — Face ID / fingerprint / Windows Hello / a security key instead of typing a
 * 6-digit code. They sit next to TOTP: an account "has two-step verification" when it has either.
 * The passkey never replaces the password: the password still unlocks the (OPAQUE-protected) key backup.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Ctx } from './context.js';
import { checkThrottle, noteFail, requireRecentPassword, requireUser } from './auth.js';
import { limits } from './settings.js';
import { HttpError, bad, now, str } from './util.js';
import { newRecoveryCodes, totpEnabled, verifySecondFactor } from './totp.js';

const MAX_PASSKEYS = 10;

interface CredRow {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export function passkeyCount(ctx: Ctx, userId: string) {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM webauthn_creds WHERE user_id = ?').get(userId) as { n: number }).n;
}
/** TOTP or at least one passkey. */
export function hasSecondFactor(ctx: Ctx, userId: string) {
  return totpEnabled(ctx, userId) || passkeyCount(ctx, userId) > 0;
}
export function secondFactorMethods(ctx: Ctx, userId: string) {
  const m: string[] = [];
  if (totpEnabled(ctx, userId)) m.push('totp');
  if (passkeyCount(ctx, userId) > 0) m.push('passkey');
  return m;
}

// ------------------------------------------------------------------ challenges (single use, 5 min)
const challenges = new Map<string, { challenge: string; rpID: string; origin: string; expires: number }>();
function remember(key: string, challenge: string, rp: { rpID: string; origin: string }) {
  const t = now();
  if (challenges.size > 5000) for (const [k, v] of challenges) if (v.expires < t) challenges.delete(k);
  if (challenges.size > 10000) throw new HttpError(503, 'busy', '服务器繁忙，请稍后再试');
  challenges.set(key, { challenge, ...rp, expires: t + 5 * 60_000 });
}
function take(key: string) {
  const c = challenges.get(key);
  challenges.delete(key);
  return c && c.expires > now() ? c : null;
}

/** The relying party is this site as the browser sees it (the CSRF check already ties Origin to Host). */
function rpOf(req: FastifyRequest) {
  // PUBLIC_ORIGIN (e.g. https://chat.example.com) pins the site passkeys are bound to; without it, the Origin the
  // browser sent is used (the CSRF check already ties it to the Host header)
  const pinned = process.env.PUBLIC_ORIGIN?.replace(/\/$/, '');
  const sent = req.headers.origin ? String(req.headers.origin) : '';
  if (pinned && sent && sent !== pinned) throw new HttpError(400, 'bad_origin', '请通过正式网址打开再使用通行密钥');
  try {
    const u = new URL(pinned || sent);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new Error('insecure');
    return { rpID: u.hostname, origin: u.origin };
  } catch {
    throw new HttpError(400, 'bad_origin', '无法确定网站地址，请从浏览器打开');
  }
}

export async function passkeyAuthOptions(ctx: Ctx, req: FastifyRequest, userId: string, key: string) {
  const creds = ctx.db.prepare('SELECT id, transports FROM webauthn_creds WHERE user_id = ?').all(userId) as Pick<CredRow, 'id' | 'transports'>[];
  if (!creds.length) throw new HttpError(404, 'no_passkey', '这个账号没有通行密钥');
  const rp = rpOf(req);
  const opts = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'preferred',
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports ? (JSON.parse(c.transports) as never) : undefined })),
  });
  remember(key, opts.challenge, rp);
  return opts;
}

/** Verify a passkey assertion against the challenge stored under `key` (single use). */
export async function verifyPasskey(ctx: Ctx, userId: string, response: unknown, key: string): Promise<boolean> {
  const ch = take(key);
  const r = response as AuthenticationResponseJSON | null;
  if (!ch || !r || typeof r !== 'object' || typeof r.id !== 'string' || r.id.length > 1400) return false;
  const row = ctx.db.prepare('SELECT * FROM webauthn_creds WHERE id = ? AND user_id = ?').get(r.id, userId) as CredRow | undefined;
  if (!row) return false;
  try {
    const v = await verifyAuthenticationResponse({
      response: r,
      expectedChallenge: ch.challenge,
      expectedOrigin: ch.origin,
      expectedRPID: ch.rpID,
      requireUserVerification: false,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: row.transports ? JSON.parse(row.transports) : undefined },
    });
    if (!v.verified) return false;
    ctx.db.prepare('UPDATE webauthn_creds SET counter = ?, last_used_at = ? WHERE id = ?').run(v.authenticationInfo.newCounter, now(), row.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-confirm the second factor for a sensitive change (turning 2FA off, new recovery codes, adding / removing a
 * passkey). Accepts `{code}` (TOTP or recovery code) or `{passkey}` (an assertion for /api/me/2fa/stepup-options).
 * A stolen session must not be able to guess its way through: 10 tries per hour.
 */
export async function guardedProof(ctx: Ctx, userId: string, body: unknown, sessionId = '') {
  const b = (body ?? {}) as Record<string, unknown>;
  // per session (10/h): a stolen session can't use up the owner's attempts (and changing a factor needs a session anyway)
  checkThrottle(`2fam:${sessionId || userId}`);
  const ok = b.passkey ? await verifyPasskey(ctx, userId, b.passkey, `step:${userId}`) : typeof b.code === 'string' && verifySecondFactor(ctx, userId, b.code.slice(0, 20));
  if (!ok) {
    noteFail(ctx, `2fam:${sessionId || userId}`);
    throw new HttpError(400, 'bad_code', b.passkey ? '通行密钥验证失败' : '验证码不正确');
  }
}

/** Tell the account's other devices that its sign-in protection changed (shown like a new-login warning). */
export function factorChanged(ctx: Ctx, userId: string, bySession: string, what: string, name?: string) {
  const others = ctx.db.prepare('SELECT id FROM sessions WHERE user_id = ? AND id != ?').all(userId, bySession) as { id: string }[];
  for (const s of others) ctx.io?.to(`s:${s.id}`).emit('security:factor', { what, name: name ?? null, at: now() });
}

export function registerPasskeys(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;

  app.get('/api/me/passkeys', async (req) => {
    const { user } = requireUser(ctx, req);
    const rows = db.prepare('SELECT id, name, created_at, last_used_at FROM webauthn_creds WHERE user_id = ? ORDER BY created_at').all(user.id) as CredRow[];
    return { passkeys: rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })) };
  });

  /** Challenge for proving "it's still me" with one of my passkeys (see guardedProof). */
  app.post('/api/me/2fa/stepup-options', async (req) => {
    const { user } = requireUser(ctx, req);
    return passkeyAuthOptions(ctx, req, user.id, `step:${user.id}`);
  });

  app.post('/api/me/passkeys/options', async (req) => {
    const auth = requireUser(ctx, req);
    const { user } = auth;
    // checked up front too, so the browser doesn't create a passkey the server would then refuse
    if (!hasSecondFactor(ctx, user.id)) requireRecentPassword(ctx, auth);
    if (passkeyCount(ctx, user.id) >= MAX_PASSKEYS) throw new HttpError(429, 'too_many', `最多添加 ${MAX_PASSKEYS} 个通行密钥`);
    const rp = rpOf(req);
    const existing = db.prepare('SELECT id, transports FROM webauthn_creds WHERE user_id = ?').all(user.id) as Pick<CredRow, 'id' | 'transports'>[];
    const opts = await generateRegistrationOptions({
      rpName: '密聊',
      rpID: rp.rpID,
      userName: user.username,
      userDisplayName: user.username,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    remember(`reg:${user.id}`, opts.challenge, rp);
    return opts;
  });

  app.post('/api/me/passkeys', async (req) => {
    const auth = requireUser(ctx, req);
    const { user } = auth;
    const body = req.body as Record<string, unknown>;
    const name = str(body, 'name', { max: 40, optional: true })?.trim() || '通行密钥';
    // adding a factor to an account that already has one needs that factor; the first one needs the password
    // (else a stolen session could plant its own factor and lock the owner out)
    if (hasSecondFactor(ctx, user.id)) await guardedProof(ctx, user.id, body.proof, auth.sessionId);
    else requireRecentPassword(ctx, auth);
    const ch = take(`reg:${user.id}`);
    if (!ch) throw new HttpError(400, 'expired', '操作超时，请重试');
    if (passkeyCount(ctx, user.id) >= MAX_PASSKEYS) throw new HttpError(429, 'too_many', `最多添加 ${MAX_PASSKEYS} 个通行密钥`);
    let v;
    try {
      v = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: ch.challenge,
        expectedOrigin: ch.origin,
        expectedRPID: ch.rpID,
        requireUserVerification: false,
      });
    } catch {
      throw bad('invalid_passkey', '通行密钥无效');
    }
    if (!v.verified) throw bad('invalid_passkey', '通行密钥无效');
    const c = v.registrationInfo.credential;
    if (db.prepare('SELECT 1 FROM webauthn_creds WHERE id = ?').get(c.id)) throw new HttpError(409, 'exists', '这个通行密钥已经添加过了');
    db.prepare('INSERT INTO webauthn_creds(id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      c.id,
      user.id,
      Buffer.from(c.publicKey),
      c.counter,
      c.transports ? JSON.stringify(c.transports) : null,
      name,
      now(),
    );
    // the first factor of an account comes with recovery codes (for a lost phone / key)
    const haveCodes = (db.prepare('SELECT COUNT(*) AS n FROM totp_recovery WHERE user_id = ?').get(user.id) as { n: number }).n > 0;
    factorChanged(ctx, user.id, auth.sessionId, 'passkey_added', name);
    return { ok: true, recoveryCodes: haveCodes ? undefined : newRecoveryCodes(ctx, user.id) };
  });

  app.post('/api/me/passkeys/:id/delete', async (req) => {
    const auth = requireUser(ctx, req);
    const { user } = auth;
    const id = (req.params as { id: string }).id;
    const row = db.prepare('SELECT id FROM webauthn_creds WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!row) throw new HttpError(404, 'not_found', '找不到这个通行密钥');
    const last = !totpEnabled(ctx, user.id) && passkeyCount(ctx, user.id) === 1;
    if (last && limits(ctx).require2fa) throw new HttpError(403, 'required', '管理员要求开启两步验证，不能删除最后一种验证方式');
    await guardedProof(ctx, user.id, req.body, auth.sessionId);
    db.prepare('DELETE FROM webauthn_creds WHERE id = ? AND user_id = ?').run(id, user.id);
    if (last) db.prepare('DELETE FROM totp_recovery WHERE user_id = ?').run(user.id);
    factorChanged(ctx, user.id, auth.sessionId, 'passkey_removed');
    return { ok: true };
  });
}
