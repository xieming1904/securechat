/**
 * "Scan to log in" (device linking). The NEW device creates an ephemeral X25519 key pair and shows it as a QR code;
 * an already logged-in device scans it, seals the user's identity keys to that ephemeral key (libsodium sealed box)
 * and approves. The server only relays the sealed box — it never sees the keys — and hands the new device a session.
 * The QR goes straight from one screen to the other camera, so the server can't swap in its own key.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireUser, selfUser, startSession, type UserRow } from './auth.js';
import { HttpError, b64, notFound, now, str } from './util.js';

interface Link {
  pk: string;
  pollHash: string;
  ua: string;
  ip: string;
  created: number;
  approved?: { userId: string; sealed: string };
}
const TTL = 3 * 60_000;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function registerLink(app: FastifyInstance, ctx: Ctx) {
  const links = new Map<string, Link>();
  const perIp = new Map<string, number[]>();
  const approvals = new Map<string, number[]>();
  const sweep = () => {
    for (const [k, v] of links) if (now() - v.created > TTL) links.delete(k);
    for (const [k, v] of perIp) if (!v.some((x) => x > now() - 10 * 60_000)) perIp.delete(k);
    for (const [k, v] of approvals) if (!v.some((x) => x > now() - 3_600_000)) approvals.delete(k);
  };
  const get = (id: string) => {
    sweep();
    const l = links.get(id);
    if (!l) throw notFound('link_expired');
    return l;
  };

  app.post('/api/link/start', async (req) => {
    sweep();
    const t = now();
    const recent = (perIp.get(req.ipKey) ?? []).filter((x) => x > t - 10 * 60_000);
    if (recent.length >= 10) throw new HttpError(429, 'rate_limited', '请求太频繁，请稍后再试');
    perIp.set(req.ipKey, [...recent, t]);
    if (links.size >= 5000) throw new HttpError(503, 'busy', '服务器繁忙，请稍后再试');
    const pk = b64(req.body as Record<string, unknown>, 'pk', 32);
    const linkId = crypto.randomBytes(12).toString('base64url');
    const pollToken = crypto.randomBytes(24).toString('base64url');
    links.set(linkId, { pk, pollHash: sha(pollToken), ua: String(req.headers['user-agent'] ?? '').slice(0, 300), ip: req.ip, created: t });
    return { linkId, pollToken, expiresAt: t + TTL };
  });

  /** For the approving device: what is asking to be logged in? */
  app.get('/api/link/:id', async (req) => {
    requireUser(ctx, req);
    const l = get((req.params as { id: string }).id);
    if (l.approved) throw new HttpError(409, 'used', '这个二维码已经用过了');
    return { pk: l.pk, userAgent: l.ua, ip: l.ip, createdAt: l.created };
  });

  app.post('/api/link/:id/approve', async (req) => {
    const { user } = requireUser(ctx, req);
    const l = get((req.params as { id: string }).id);
    if (l.approved) throw new HttpError(409, 'used', '这个二维码已经用过了');
    const recentApprovals = (approvals.get(user.id) ?? []).filter((x) => x > now() - 3_600_000);
    if (recentApprovals.length >= 5) throw new HttpError(429, 'rate_limited', '1 小时内最多扫码登录 5 台设备');
    approvals.set(user.id, [...recentApprovals, now()]);
    const sealed = b64(req.body as Record<string, unknown>, 'sealed', undefined, 4096);
    l.approved = { userId: user.id, sealed };
    return { ok: true };
  });

  /** The new device polls; once approved it gets its session cookie and the sealed keys (one time). */
  app.post('/api/link/:id/poll', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const l = get(id);
    const body = req.body as Record<string, unknown>;
    const token = str(body, 'pollToken', { max: 64 });
    if (!crypto.timingSafeEqual(Buffer.from(sha(token)), Buffer.from(l.pollHash))) throw notFound('link_expired');
    if (!l.approved) return { pending: true };
    links.delete(id);
    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(l.approved.userId) as UserRow | undefined;
    if (!user || user.disabled_at) throw new HttpError(403, 'disabled', '账号已被停用');
    startSession(ctx, req, reply, user.id, str(body, 'deviceName', { max: 64, optional: true }) ?? '', false);
    return { user: selfUser(user), sealed: l.approved.sealed };
  });
}
