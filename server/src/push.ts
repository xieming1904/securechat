/**
 * Web Push. The payload never contains anything about the message — only "you have something new".
 * (The push service — Google/Mozilla/Apple — would otherwise learn metadata; even the chat id is withheld.)
 */
import webpush from 'web-push';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireUser } from './auth.js';
import { getSetting, setSetting } from './db.js';
import { privacyOf } from './social.js';
import { HttpError, bad, newId, now, str } from './util.js';

export interface PushSub {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}
export type PushSender = (sub: PushSub, payload: string) => Promise<void>;

let vapid: { publicKey: string; privateKey: string } | null = null;
const lastPush = new Map<string, number>();
const PUSH_GAP_MS = 20_000; // at most one push per user per 20s (they all say the same thing anyway)
/** tests only */
export const resetPushThrottle = () => lastPush.clear();

export function initPush(ctx: Ctx) {
  const pub = process.env.VAPID_PUBLIC_KEY || getSetting(ctx.db, 'vapid_public');
  const priv = process.env.VAPID_PRIVATE_KEY || getSetting(ctx.db, 'vapid_private');
  if (pub && priv) vapid = { publicKey: pub, privateKey: priv };
  else {
    vapid = webpush.generateVAPIDKeys();
    setSetting(ctx.db, 'vapid_public', vapid.publicKey);
    setSetting(ctx.db, 'vapid_private', vapid.privateKey);
  }
  const origin = process.env.PUBLIC_ORIGIN;
  const subject = process.env.VAPID_SUBJECT || (origin?.startsWith('https://') ? origin : 'mailto:admin@example.invalid');
  if (!ctx.sendPush) {
    ctx.sendPush = async (sub, payload) => {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
        vapidDetails: { subject, publicKey: vapid!.publicKey, privateKey: vapid!.privateKey },
        TTL: 3600,
        topic: 'new-messages', // the push service keeps only the latest undelivered one
        urgency: 'normal',
      });
    };
  }
}

const delayed = new Map<string, ReturnType<typeof setTimeout>>();
/** tests only */
export const pendingDelayedPushes = () => delayed.size;

/** Notify members who have no open connection. */
export function notifyOffline(ctx: Ctx, userIds: string[]) {
  const t = now();
  for (const uid of userIds) {
    if ((ctx.online.get(uid) ?? 0) > 0) continue;
    if (privacyOf(ctx, uid).pushDelay) {
      // one push 2–8 minutes later for everything that arrives in between
      if (delayed.has(uid)) continue;
      const timer = setTimeout(() => {
        delayed.delete(uid);
        lastPush.delete(uid);
        pushNow(ctx, uid);
      }, 120_000 + Math.random() * 360_000);
      timer.unref?.();
      delayed.set(uid, timer);
      continue;
    }
    if (t - (lastPush.get(uid) ?? 0) < PUSH_GAP_MS) continue;
    pushNow(ctx, uid);
  }
}
function pushNow(ctx: Ctx, uid: string) {
  const t = now();
  {
    if ((ctx.online.get(uid) ?? 0) > 0) return;
    if (t - (lastPush.get(uid) ?? 0) < PUSH_GAP_MS) return;
    const subs = ctx.db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(uid) as PushSub[];
    if (!subs.length) return;
    lastPush.set(uid, t);
    for (const sub of subs) {
      ctx.sendPush!(sub, JSON.stringify({ t: 'msg' })).catch((e: { statusCode?: number }) => {
        // subscription expired or revoked by the browser
        if (e?.statusCode === 404 || e?.statusCode === 410) ctx.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      });
    }
  }
}

/** Content-free "incoming call" push to an offline user (no caller name, nothing else). */
export function notifyCall(ctx: Ctx, userId: string) {
  if (!ctx.sendPush) return;
  const subs = ctx.db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId) as PushSub[];
  for (const sub of subs)
    ctx.sendPush(sub, JSON.stringify({ t: 'call' })).catch((e: { statusCode?: number }) => {
      if (e?.statusCode === 404 || e?.statusCode === 410) ctx.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
    });
}

/** Content-free push to offline admins: "there is a new security alert". */
export function notifyAdminsAlert(ctx: Ctx) {
  if (!ctx.sendPush) return;
  const admins = ctx.db.prepare('SELECT id FROM users WHERE is_admin = 1 AND disabled_at IS NULL').all() as { id: string }[];
  for (const { id } of admins) {
    if ((ctx.online.get(id) ?? 0) > 0) continue;
    const subs = ctx.db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(id) as PushSub[];
    for (const sub of subs)
      ctx.sendPush(sub, JSON.stringify({ t: 'alert' })).catch((e: { statusCode?: number }) => {
        if (e?.statusCode === 404 || e?.statusCode === 410) ctx.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      });
  }
}

export function registerPush(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/push/key', async (req) => {
    requireUser(ctx, req);
    return { publicKey: vapid!.publicKey };
  });

  app.post('/api/push/subscribe', async (req) => {
    const { user, sessionId } = requireUser(ctx, req);
    const body = req.body as Record<string, unknown>;
    const endpoint = str(body, 'endpoint', { max: 1000 });
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw bad('invalid_endpoint');
    }
    if (url.protocol !== 'https:') throw bad('invalid_endpoint', '推送地址必须是 https');
    const keys = (body.keys ?? {}) as Record<string, unknown>;
    const p256dh = str(keys, 'p256dh', { max: 200, pattern: /^[A-Za-z0-9_-]+=*$/ });
    const auth = str(keys, 'auth', { max: 100, pattern: /^[A-Za-z0-9_-]+=*$/ });
    const count = (ctx.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(user.id) as { n: number }).n;
    if (count >= 10) throw new HttpError(400, 'too_many', '推送设备太多');
    ctx.db
      .prepare(
        `INSERT INTO push_subscriptions(id, user_id, session_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(newId('ps'), user.id, sessionId, endpoint, p256dh, auth, now());
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const { user } = requireUser(ctx, req);
    const endpoint = str(req.body as Record<string, unknown>, 'endpoint', { max: 1000 });
    ctx.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(user.id, endpoint);
    return { ok: true };
  });
}
