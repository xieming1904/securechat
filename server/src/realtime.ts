import type { Server as HttpServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import proxyaddr from 'proxy-addr';
import type { Ctx } from './context.js';
import { COOKIE, resolveSession } from './auth.js';
import { isAllowed } from './gate.js';
import { memberIds, peersOf } from './chats.js';
import { Buckets, ipKey } from './util.js';
import { presenceChanged, setPresenceBroadcaster } from './presence.js';
import { notifyCall } from './push.js';
import { blockedEitherWay, privacyOf } from './social.js';
import { limits } from './settings.js';
import { hasSecondFactor } from './passkey.js';
import { attachGroupCalls } from './groupcall.js';

/** Tell a user's peers whether they are online (respecting hidden status, blocks, and fuzzy status: no exact times). */
export function broadcastPresence(ctx: Ctx, userId: string, online: boolean) {
  const p = privacyOf(ctx, userId);
  if (p.hideOnline) return;
  ctx.emitToUsers(
    peersOf(ctx, userId).filter((x) => !privacyOf(ctx, x).hideOnline && !blockedEitherWay(ctx, userId, x)),
    'presence',
    { userId, online, ...(online || p.coarseOnline ? {} : { at: Date.now() }) },
  );
}
setPresenceBroadcaster(broadcastPresence);

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function attachRealtime(server: HttpServer, ctx: Ctx) {
  const trust = ctx.config.trustProxy;
  const trustFn =
    trust === true ? () => true : trust === false ? proxyaddr.compile([]) : proxyaddr.compile(String(trust).split(',').map((s) => s.trim()));

  const io = new IOServer(server, {
    serveClient: false,
    maxHttpBufferSize: 256 * 1024,
    cors: undefined, // same-origin only
  });
  ctx.io = io;

  io.use((socket, next) => {
    const req = socket.request;
    const ip = proxyaddr(req as Parameters<typeof proxyaddr>[0], trustFn);
    if (!isAllowed(ctx, ipKey(ip, ctx.config.ipv6Prefix))) return next(new Error('ip_not_allowed'));
    const auth = resolveSession(ctx, parseCookies(req.headers.cookie)[COOKIE]);
    if (!auth) return next(new Error('unauthorized'));
    if (limits(ctx).require2fa && !hasSecondFactor(ctx, auth.user.id)) return next(new Error('totp_required'));
    socket.data.userId = auth.user.id;
    socket.data.sessionId = auth.sessionId;
    socket.data.isAdmin = !!auth.user.is_admin;
    next();
  });

  // a call offer for someone who is offline: kept (still encrypted) for the ring time and handed to their first
  // device that connects — e.g. after they tapped the "incoming call" push notification
  const pendingRings = new Map<string, { chatId: string; from: string; env: unknown; at: number }>();
  const RING_MS = 45_000;

  const groupCalls = attachGroupCalls(io, ctx);
  const socketBuckets = new Buckets(300, 60); // per user, across all of their connections
  io.on('connection', (socket) => {
    const userId: string = socket.data.userId;
    // v0.7: drop events beyond a generous per-connection budget (typing, call signalling, ICE candidates)
    socket.use((_packet, next) => {
      if (socketBuckets.take(userId)) next();
    });
    groupCalls(socket);
    const ring = pendingRings.get(userId);
    if (ring) {
      pendingRings.delete(userId);
      if (Date.now() - ring.at < RING_MS) setTimeout(() => socket.emit('call:signal', { chatId: ring.chatId, from: ring.from, env: ring.env }), 1500);
    }
    socket.join([`u:${userId}`, `s:${socket.data.sessionId}`]);
    if (socket.data.isAdmin) socket.join('admins');

    const n = (ctx.online.get(userId) ?? 0) + 1;
    ctx.online.set(userId, n);
    const tellPeers = (online: boolean) => broadcastPresence(ctx, userId, online);
    if (n === 1) presenceChanged(ctx, userId, true, tellPeers);

    socket.on('typing', (data: { chatId?: unknown; typing?: unknown }) => {
      if (typeof data?.chatId !== 'string') return;
      const members = memberIds(ctx, data.chatId);
      if (!members.includes(userId)) return;
      ctx.emitToUsers(
        members.filter((m) => m !== userId && !blockedEitherWay(ctx, userId, m)),
        'typing',
        { chatId: data.chatId, userId, typing: !!data.typing },
      );
    });

    // 1:1 call signalling. The payload is encrypted with the chat key and signed with the sender's identity key by the
    // browsers (so the SDP — including the DTLS fingerprints that protect the media — can't be read or swapped here).
    // The server only checks both people are in the same direct chat and relays it.
    let signals = 0;
    const signalReset = setInterval(() => (signals = 0), 60_000);
    socket.on('call:signal', (data: { chatId?: unknown; to?: unknown; env?: unknown; ring?: unknown; end?: unknown }) => {
      if (++signals > 300) return;
      if (typeof data?.chatId !== 'string' || typeof data.to !== 'string' || !data.env || typeof data.env !== 'object') return;
      if (JSON.stringify(data.env).length > 64 * 1024) return;
      const chat = ctx.db.prepare('SELECT type FROM chats WHERE id = ?').get(data.chatId) as { type: string } | undefined;
      if (chat?.type !== 'direct') return;
      const members = memberIds(ctx, data.chatId);
      if (!members.includes(userId) || !members.includes(data.to)) return;
      if (data.to !== userId && blockedEitherWay(ctx, userId, data.to)) return;
      // to = myself → my other devices (e.g. "answered on another device")
      socket.to(`u:${data.to}`).emit('call:signal', { chatId: data.chatId, from: userId, env: data.env });
      if (data.to === userId) return;
      // plaintext hints from the caller's client (the server sees *that* a call is placed, never its content)
      if (data.ring === true && (ctx.online.get(data.to) ?? 0) === 0) {
        pendingRings.set(data.to, { chatId: data.chatId, from: userId, env: data.env, at: Date.now() });
        notifyCall(ctx, data.to);
      }
      if (data.end === true && pendingRings.get(data.to)?.from === userId) pendingRings.delete(data.to);
    });

    socket.on('disconnect', () => {
      clearInterval(signalReset);
      const left = (ctx.online.get(userId) ?? 1) - 1;
      if (left <= 0) {
        ctx.online.delete(userId);
        presenceChanged(ctx, userId, false, tellPeers);
      } else ctx.online.set(userId, left);
    });
  });

  return io;
}
