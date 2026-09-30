/**
 * Secret chats (v0.8): device prekeys and a store-and-forward queue for Double Ratchet envelopes.
 *
 * The server never sees message content, and nothing here becomes chat history:
 *  - every logged-in browser (session) may register one device: a certificate signed by the account key, a signed
 *    prekey and up to 200 one-time prekeys. Deleting the session (log out, remote kick, account deletion) deletes the
 *    device, its prekeys and everything queued for it;
 *  - one-time prekeys are handed out once and deleted;
 *  - envelopes wait only until the target device acknowledges them, 14 days at most;
 *  - attachments are ordinary encrypted blobs in the pair's direct chat, marked `secret:<expiry>` and deleted after 14 days.
 * Only two people who already share a direct chat, and haven't blocked each other, can use this.
 */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireUser } from './auth.js';
import { blockedEitherWay } from './social.js';
import { encodeFields, S } from './sodium.js';
import { Buckets, HttpError, bad, forbidden, newId, notFound, now } from './util.js';

export const ENVELOPE_TTL = 14 * 86_400_000;
const MAX_OPKS = 200;
const MAX_ENVELOPE = 100_000; // text only; attachments are blobs
const MAX_PAIR_QUEUE = 300; // per sender → target device
const MAX_QUEUE = 2000; // per target device
const B64 = /^[A-Za-z0-9_-]+$/;
const DEVICE_ID = /^d_[A-Za-z0-9_-]{22}$/;

const bundleBuckets = new Buckets(20, 20 / 3600); // per requester+target: 20 bundles an hour (each one uses up OPKs)
const sendBuckets = new Buckets(120, 2); // per sender

interface Cert {
  userId: string;
  deviceId: string;
  signPk: string;
  dhPk: string;
  sig: string;
}
const unb64 = (s: string) => Buffer.from(s, 'base64url');
function verifyCert(c: Cert, accountSignPk: string): boolean {
  try {
    if (!DEVICE_ID.test(c.deviceId) || unb64(c.signPk).length !== 32 || unb64(c.dhPk).length !== 32) return false;
    return S().crypto_sign_verify_detached(unb64(c.sig), encodeFields('sc-device-cert', [c.userId, c.deviceId, c.signPk, c.dhPk]), unb64(accountSignPk));
  } catch {
    return false;
  }
}
function verifySpk(c: Cert, id: number, pk: string, sig: string): boolean {
  try {
    const p = unb64(pk);
    if (p.length !== 32) return false;
    return S().crypto_sign_verify_detached(unb64(sig), Buffer.concat([encodeFields('sc-spk', [c.deviceId, id]), p]), unb64(c.signPk));
  } catch {
    return false;
  }
}
function parseCert(v: unknown): Cert {
  const c = v as Record<string, unknown>;
  for (const k of ['userId', 'deviceId', 'signPk', 'dhPk', 'sig']) if (typeof c?.[k] !== 'string' || (c[k] as string).length > 200) throw bad('invalid_input', '设备证书格式不正确');
  return { userId: c.userId as string, deviceId: c.deviceId as string, signPk: c.signPk as string, dhPk: c.dhPk as string, sig: c.sig as string };
}

/** The shared direct chat of two users, or null. */
function directChat(ctx: Ctx, a: string, b: string): string | null {
  const key = [a, b].sort().join('|');
  const r = ctx.db.prepare("SELECT id FROM chats WHERE type = 'direct' AND direct_key = ?").get(key) as { id: string } | undefined;
  return r?.id ?? null;
}
function requirePair(ctx: Ctx, me: string, peer: string) {
  if (me === peer) throw bad('invalid_input', '不能和自己开私密对话');
  const u = ctx.db.prepare('SELECT deleted_at, disabled_at FROM users WHERE id = ?').get(peer) as { deleted_at: number | null; disabled_at: number | null } | undefined;
  if (!u || u.deleted_at || u.disabled_at) throw notFound('user_not_found');
  if (!directChat(ctx, me, peer)) throw forbidden('需要先和对方有私聊');
  if (blockedEitherWay(ctx, me, peer)) throw forbidden('无法和对方开私密对话');
}
function myDevice(ctx: Ctx, sessionId: string, userId: string) {
  return ctx.db.prepare('SELECT id FROM devices WHERE session_id = ? AND user_id = ?').get(sessionId, userId) as { id: string } | undefined;
}

/** Envelopes nobody picked up within 14 days (their attachments are purged in blobs.ts). */
export function purgeSecret(ctx: Ctx) {
  ctx.db.prepare('DELETE FROM secret_envelopes WHERE created_at < ?').run(now() - ENVELOPE_TTL);
  // devices of sessions that expired without logging out (their queues go with them)
  ctx.db.prepare('DELETE FROM devices WHERE session_id IN (SELECT id FROM sessions WHERE expires_at < ?)').run(now());
}

export function registerSecret(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // ---- this device
  app.put('/api/devices/me', async (req) => {
    const { user, sessionId } = requireUser(ctx, req);
    const body = req.body as Record<string, unknown>;
    const cert = parseCert(body?.cert);
    const spkId = Number(body?.spkId);
    const spkPk = String(body?.spkPk ?? '');
    const spkSig = String(body?.spkSig ?? '');
    if (!Number.isInteger(spkId) || spkId < 1 || spkId > 2 ** 31 || !B64.test(spkPk) || !B64.test(spkSig)) throw bad('invalid_input', '预密钥格式不正确');
    const keys = db.prepare('SELECT sign_pk FROM user_keys WHERE user_id = ?').get(user.id) as { sign_pk: string } | undefined;
    if (!keys || cert.userId !== user.id || !verifyCert(cert, keys.sign_pk)) throw bad('bad_signature', '设备证书签名无效');
    if (!verifySpk(cert, spkId, spkPk, spkSig)) throw bad('bad_signature', '预密钥签名无效');
    // proof that this session holds the device's private key (certificates are public: without it, another session of
    // the same account could move the device's queue to itself)
    const bindAt = Number(body?.bindAt);
    const bindSig = String(body?.bindSig ?? '');
    let bound = false;
    try {
      bound =
        Math.abs(now() - bindAt) < 10 * 60_000 &&
        S().crypto_sign_verify_detached(unb64(bindSig), encodeFields('sc-device-bind', [cert.userId, cert.deviceId, bindAt]), unb64(cert.signPk));
    } catch {
      bound = false;
    }
    if (!bound) throw bad('bad_signature', '设备绑定签名无效');
    const existing = db.prepare('SELECT user_id, session_id, cert FROM devices WHERE id = ?').get(cert.deviceId) as { user_id: string; session_id: string; cert: string } | undefined;
    if (existing && existing.user_id !== user.id) throw forbidden('设备编号冲突');
    db.transaction(() => {
      // one device per session: a re-registration from this session with new keys replaces the old device
      const old = myDevice(ctx, sessionId, user.id);
      if (old && old.id !== cert.deviceId) db.prepare('DELETE FROM devices WHERE id = ?').run(old.id);
      if (existing) {
        // same device id, new session (logged in again in the same browser): identity keys must not change
        if (JSON.parse(existing.cert).dhPk !== cert.dhPk || JSON.parse(existing.cert).signPk !== cert.signPk) {
          db.prepare('DELETE FROM devices WHERE id = ?').run(cert.deviceId);
        }
      }
      db.prepare(
        `INSERT INTO devices(id, user_id, session_id, cert, spk_id, spk_pk, spk_sig, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, cert = excluded.cert, spk_id = excluded.spk_id, spk_pk = excluded.spk_pk, spk_sig = excluded.spk_sig, updated_at = excluded.updated_at`,
      ).run(cert.deviceId, user.id, sessionId, JSON.stringify(cert), spkId, spkPk, spkSig, now(), now());
    })();
    return { ok: true, opkCount: opkCount(cert.deviceId) };
  });

  const opkCount = (deviceId: string) => (db.prepare('SELECT COUNT(*) AS n FROM device_opks WHERE device_id = ?').get(deviceId) as { n: number }).n;

  app.get('/api/devices/me', async (req) => {
    const { user, sessionId } = requireUser(ctx, req);
    const d = db.prepare('SELECT id, spk_id FROM devices WHERE session_id = ? AND user_id = ?').get(sessionId, user.id) as { id: string; spk_id: number } | undefined;
    if (!d) return { device: null };
    const ids = (db.prepare('SELECT key_id FROM device_opks WHERE device_id = ? ORDER BY key_id').all(d.id) as { key_id: number }[]).map((x) => x.key_id);
    return { device: { id: d.id, spkId: d.spk_id, opkCount: ids.length, opkIds: ids } };
  });

  app.post('/api/devices/me/opks', async (req) => {
    const { user, sessionId } = requireUser(ctx, req);
    const d = myDevice(ctx, sessionId, user.id);
    if (!d) throw notFound();
    const keys = (req.body as { keys?: unknown })?.keys;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 100) throw bad('invalid_input');
    const clean = keys.map((k) => {
      const id = Number((k as { id?: unknown })?.id);
      const pk = String((k as { pk?: unknown })?.pk ?? '');
      if (!Number.isInteger(id) || id < 1 || id > 2 ** 31 || !B64.test(pk) || unb64(pk).length !== 32) throw bad('invalid_input', '一次性预密钥格式不正确');
      return { id, pk };
    });
    if (opkCount(d.id) + clean.length > MAX_OPKS) throw bad('too_many', `一次性预密钥最多 ${MAX_OPKS} 个`);
    const ins = db.prepare('INSERT OR IGNORE INTO device_opks(device_id, key_id, pk) VALUES (?, ?, ?)');
    db.transaction(() => clean.forEach((k) => ins.run(d.id, k.id, k.pk)))();
    return { ok: true, opkCount: opkCount(d.id) };
  });

  // ---- someone else's devices (each bundle uses up one of their one-time prekeys)
  app.get('/api/users/:id/prekeys', async (req) => {
    const { user, sessionId } = requireUser(ctx, req);
    const peer = (req.params as { id: string }).id;
    requirePair(ctx, user.id, peer);
    if (!myDevice(ctx, sessionId, user.id)) throw bad('no_device', '这台设备还没有准备好私密对话密钥，请刷新后再试');
    if (!bundleBuckets.take(`${user.id}>${peer}`)) throw new HttpError(429, 'slow_down', '请求太频繁，请稍后再试');
    const devs = db.prepare('SELECT id, cert, spk_id, spk_pk, spk_sig FROM devices WHERE user_id = ? ORDER BY updated_at DESC LIMIT 10').all(peer) as {
      id: string;
      cert: string;
      spk_id: number;
      spk_pk: string;
      spk_sig: string;
    }[];
    const pop = db.prepare('DELETE FROM device_opks WHERE rowid = (SELECT rowid FROM device_opks WHERE device_id = ? ORDER BY key_id LIMIT 1) RETURNING key_id, pk');
    const bundles = db.transaction(() =>
      devs.map((d) => {
        const opk = pop.get(d.id) as { key_id: number; pk: string } | undefined;
        return { cert: JSON.parse(d.cert), spkId: d.spk_id, spkPk: d.spk_pk, spkSig: d.spk_sig, ...(opk ? { opkId: opk.key_id, opkPk: opk.pk } : {}) };
      }),
    )();
    return { bundles };
  });

  // ---- envelopes
  app.post('/api/secret/send', async (req) => {
    const { user, sessionId } = requireUser(ctx, req);
    const me = myDevice(ctx, sessionId, user.id);
    if (!me) throw bad('no_device', '这台设备还没有准备好私密对话密钥');
    const body = req.body as Record<string, unknown>;
    const to = String(body?.toDevice ?? '');
    const ct = body?.envelope;
    if (!DEVICE_ID.test(to) || typeof ct !== 'string' || ct.length === 0 || ct.length > MAX_ENVELOPE) throw bad('invalid_input');
    const target = db.prepare('SELECT user_id, session_id FROM devices WHERE id = ?').get(to) as { user_id: string; session_id: string } | undefined;
    if (!target) throw notFound('device_gone');
    requirePair(ctx, user.id, target.user_id);
    if (!sendBuckets.take(user.id)) throw new HttpError(429, 'slow_down', '发送太频繁，请稍后再试');
    const queued = (db.prepare('SELECT COUNT(*) AS n FROM secret_envelopes WHERE to_device = ?').get(to) as { n: number }).n;
    if (queued >= MAX_QUEUE) throw new HttpError(429, 'queue_full', '对方设备长时间没有上线，暂时无法再发送');
    const mine = (db.prepare('SELECT COUNT(*) AS n FROM secret_envelopes WHERE to_device = ? AND from_device = ?').get(to, me.id) as { n: number }).n;
    if (mine >= MAX_PAIR_QUEUE) throw new HttpError(429, 'queue_full', '对方设备长时间没有上线，暂时无法再发送');
    const id = newId('se');
    const t = now();
    db.prepare('INSERT INTO secret_envelopes(id, to_device, from_device, from_user, ct, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, to, me.id, user.id, ct, t);
    ctx.io?.to(`s:${target.session_id}`).emit('secret:new', { id });
    return { id, createdAt: t };
  });

  /** Does a device of someone I share a direct chat with still exist? (no prekeys are used up) */
  app.get('/api/secret/devices/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    // only about someone I share a direct chat with and haven't blocked / been blocked by (403 otherwise)
    const peer = String((req.query as { user?: unknown }).user ?? '');
    requirePair(ctx, user.id, peer);
    const d = db.prepare('SELECT 1 FROM devices WHERE id = ? AND user_id = ?').get((req.params as { id: string }).id, peer);
    return { alive: !!d };
  });

  app.get('/api/secret/inbox', async (req) => {
    const { user, sessionId } = requireUser(ctx, req);
    const me = myDevice(ctx, sessionId, user.id);
    if (!me) return { envelopes: [] };
    const rows = db
      .prepare('SELECT id, from_device AS fromDevice, from_user AS fromUser, ct AS envelope, created_at AS createdAt FROM secret_envelopes WHERE to_device = ? ORDER BY created_at, rowid LIMIT 100')
      .all(me.id);
    return { envelopes: rows };
  });

  app.post('/api/secret/ack', async (req) => {
    const { user, sessionId } = requireUser(ctx, req);
    const me = myDevice(ctx, sessionId, user.id);
    const ids = (req.body as { ids?: unknown })?.ids;
    if (!me || !Array.isArray(ids) || ids.length > 200 || !ids.every((x) => typeof x === 'string')) throw bad('invalid_input');
    const del = db.prepare('DELETE FROM secret_envelopes WHERE id = ? AND to_device = ?');
    db.transaction(() => ids.forEach((id) => del.run(id, me.id)))();
    return { ok: true };
  });

  /** Attachments of secret messages: uploaded to the pair's direct chat, kept 14 days, never part of the history. */
  app.post('/api/secret/blobs', async (req) => {
    const { user } = requireUser(ctx, req);
    const ids = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || !ids.every((x) => typeof x === 'string')) throw bad('invalid_input');
    const mark = db.prepare("UPDATE blobs SET message_id = ? WHERE id = ? AND owner_id = ? AND message_id IS NULL AND chat_id IN (SELECT id FROM chats WHERE type = 'direct')");
    const tag = `secret:${now() + ENVELOPE_TTL}`;
    let n = 0;
    db.transaction(() => ids.forEach((id) => (n += mark.run(tag, id, user.id).changes)))();
    if (n !== ids.length) throw bad('invalid_input', '附件不存在或已被使用');
    return { ok: true };
  });
}
