/**
 * Two-step verification with standard TOTP (RFC 6238: HMAC-SHA1, 30 s, 6 digits) — works with Google Authenticator,
 * Microsoft Authenticator, 1Password, Aegis, … No SMS, no third party.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from './context.js';
import { requireRecentPassword, requireUser } from './auth.js';
import { factorChanged, guardedProof, hasSecondFactor, passkeyCount, secondFactorMethods } from './passkey.js';
import { limits } from './settings.js';
import { HttpError, now, str } from './util.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string) {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secretB32: string, counter: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}
export const totpNow = (secret: string, t = Date.now()) => hotp(secret, Math.floor(t / 30_000));

/** Returns the matched time step (±1 step of clock drift), or null. */
function matchStep(secret: string, code: string, t = Date.now()): number | null {
  const step = Math.floor(t / 30_000);
  for (const d of [0, -1, 1]) {
    const c = hotp(secret, step + d);
    if (c.length === code.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(code))) return step + d;
  }
  return null;
}

const hashCode = (c: string) => crypto.createHash('sha256').update('sc-2fa-recovery|' + c.replace(/[\s-]/g, '').toLowerCase()).digest('hex');

interface TotpRow {
  totp_secret: string | null;
  totp_pending: string | null;
  totp_last_step: number | null;
}

export function totpEnabled(ctx: Ctx, userId: string) {
  return !!(ctx.db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as TotpRow | undefined)?.totp_secret;
}

/** Check a 6-digit code (each time step usable once) or a one-time recovery code. */
export function verifySecondFactor(ctx: Ctx, userId: string, input: string): boolean {
  const code = input.replace(/\s/g, '');
  const row = ctx.db.prepare('SELECT totp_secret, totp_pending, totp_last_step FROM users WHERE id = ?').get(userId) as TotpRow | undefined;
  if (!row) return false;
  if (/^\d{6}$/.test(code)) {
    if (!row.totp_secret) return false;
    const step = matchStep(row.totp_secret, code);
    if (step === null || (row.totp_last_step !== null && step <= row.totp_last_step)) return false; // no replay
    ctx.db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
    return true;
  }
  const r = ctx.db.prepare('UPDATE totp_recovery SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(now(), userId, hashCode(code));
  return r.changes === 1;
}

export function newRecoveryCodes(ctx: Ctx, userId: string) {
  const codes = Array.from({ length: 10 }, () => {
    const s = base32(crypto.randomBytes(8)).slice(0, 10).toLowerCase();
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM totp_recovery WHERE user_id = ?').run(userId);
    const ins = ctx.db.prepare('INSERT INTO totp_recovery(user_id, code_hash, used_at) VALUES (?, ?, NULL)');
    for (const c of codes) ins.run(userId, hashCode(c));
  })();
  return codes;
}

/** When the admin requires 2FA, accounts without it may only reach these (to set it up). */
const ALLOWED_WITHOUT_2FA = [/^\/api\/me(\?|$)/, /^\/api\/me\/2fa/, /^\/api\/me\/passkeys/, /^\/api\/auth\//, /^\/api\/push\//];
export function enforce2fa(ctx: Ctx, req: FastifyRequest, userId: string) {
  if (!limits(ctx).require2fa) return;
  if (hasSecondFactor(ctx, userId)) return;
  if (ALLOWED_WITHOUT_2FA.some((r) => r.test(req.url))) return;
  throw new HttpError(403, 'totp_required', '管理员要求开启两步验证，请先完成设置');
}

export function registerTotp(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;
  const code = (b: unknown) => str(b as Record<string, unknown>, 'code', { max: 20 });
  app.get('/api/me/2fa', async (req) => {
    const { user } = requireUser(ctx, req);
    const left = (db.prepare('SELECT COUNT(*) AS n FROM totp_recovery WHERE user_id = ? AND used_at IS NULL').get(user.id) as { n: number }).n;
    return { enabled: totpEnabled(ctx, user.id), methods: secondFactorMethods(ctx, user.id), passkeys: passkeyCount(ctx, user.id), required: !!limits(ctx).require2fa, recoveryLeft: left };
  });

  app.post('/api/me/2fa/setup', async (req) => {
    const { user } = requireUser(ctx, req);
    if (totpEnabled(ctx, user.id)) throw new HttpError(409, 'already', '已经开启了两步验证');
    const secret = base32(crypto.randomBytes(20));
    db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(secret, user.id);
    const issuer = encodeURIComponent('密聊');
    const label = encodeURIComponent(`密聊:${user.username}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` };
  });

  app.post('/api/me/2fa/enable', async (req) => {
    const auth = requireUser(ctx, req);
    const { user } = auth;
    const row = db.prepare('SELECT totp_pending FROM users WHERE id = ?').get(user.id) as TotpRow;
    if (!row.totp_pending) throw new HttpError(409, 'no_setup', '请先生成密钥');
    // another factor needs the existing one; the first factor needs the password (a stolen cookie can't lock the owner out)
    if (passkeyCount(ctx, user.id) > 0) await guardedProof(ctx, user.id, (req.body as Record<string, unknown>)?.proof, auth.sessionId);
    else requireRecentPassword(ctx, auth);
    const step = matchStep(row.totp_pending, code(req.body).replace(/\s/g, ''));
    if (step === null) throw new HttpError(400, 'bad_code', '验证码不正确，请检查手机时间是否准确');
    db.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ? WHERE id = ?').run(step, user.id);
    const haveCodes = (db.prepare('SELECT COUNT(*) AS n FROM totp_recovery WHERE user_id = ?').get(user.id) as { n: number }).n > 0;
    factorChanged(ctx, user.id, auth.sessionId, 'totp_added');
    return { recoveryCodes: haveCodes ? undefined : newRecoveryCodes(ctx, user.id) };
  });

  app.post('/api/me/2fa/disable', async (req) => {
    const auth = requireUser(ctx, req);
    const { user } = auth;
    if (!totpEnabled(ctx, user.id)) return { ok: true };
    const other = passkeyCount(ctx, user.id) > 0;
    if (limits(ctx).require2fa && !other) throw new HttpError(403, 'required', '管理员要求所有人开启两步验证，不能关闭');
    await guardedProof(ctx, user.id, req.body, auth.sessionId);
    db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL WHERE id = ?').run(user.id);
    if (!other) db.prepare('DELETE FROM totp_recovery WHERE user_id = ?').run(user.id); // passkeys keep the recovery codes
    factorChanged(ctx, user.id, auth.sessionId, 'totp_removed');
    return { ok: true };
  });

  app.post('/api/me/2fa/recovery-codes', async (req) => {
    const auth = requireUser(ctx, req);
    const { user } = auth;
    if (!hasSecondFactor(ctx, user.id)) throw new HttpError(409, 'no_2fa', '请先开启两步验证');
    await guardedProof(ctx, user.id, req.body, auth.sessionId);
    return { recoveryCodes: newRecoveryCodes(ctx, user.id) };
  });
}
