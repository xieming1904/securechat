import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION, loadConfig, type AppConfig } from './config.js';
import { createCtx } from './context.js';
import { openDb } from './db.js';
import { initOpaqueSetup, initSodium } from './sodium.js';
import { registerGate } from './gate.js';
import { registerAuth } from './auth.js';
import { registerChats, purgeExpired } from './chats.js';
import { registerScheduled, dispatchScheduled } from './scheduled.js';
import { registerPreview } from './preview.js';
import { registerCalls } from './calls.js';
import { registerSocial } from './social.js';
import { registerTotp } from './totp.js';
import { registerPasskeys } from './passkey.js';
import { registerAccount } from './account.js';
import { registerAvatars } from './avatars.js';
import { registerLink } from './link.js';
import { registerInsights, purgeOldAttachments } from './insights.js';
import { registerInvites } from './invites.js';
import { registerAdmin } from './admin.js';
import { registerClientErrors } from './clienterrors.js';
import { purgeSecret, registerSecret } from './secret.js';
import { runMonitors, pruneLogs } from './alerts.js';
import { purgeUnreferencedBlobs, registerBlobs, removeOrphanFiles } from './blobs.js';
import { attachRealtime } from './realtime.js';
import { initPush, registerPush } from './push.js';
import { registerSync } from './sync.js';
import { Buckets, HttpError, sha256 } from './util.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ');

export async function buildApp(overrides: Partial<AppConfig> = {}) {
  await initSodium();
  const config = loadConfig(overrides);
  const db = openDb(config.dataDir);
  initOpaqueSetup(db);
  const ctx = createCtx(db, config);

  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 512 * 1024,
    // on shutdown, drop idle keep-alive / long-poll connections instead of waiting for them forever
    forceCloseConnections: true,
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie'] },
    // v0.7: no per-request lines (they held every visitor's IP and URL and made up almost all of the log volume);
    // errors are still logged. LOG_REQUESTS=1 turns them back on for troubleshooting.
    logController: new LogController({ disableRequestLogging: process.env.LOG_REQUESTS !== '1' }),
  });

  await app.register(cookie);

  // security headers on every response
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Permissions-Policy',
      'camera=(self), microphone=(self), display-capture=(self), publickey-credentials-get=(self), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), browsing-topics=()',
    );
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // v0.7 flood guard for the API: per session (or per IP before login). Normal use never gets near it.
  // Two budgets: per session, and a larger one per IP (several people may share a network) so that made-up
  // session cookies can't be used to get fresh buckets.
  const apiBurst = Number(process.env.API_BURST) || 600;
  const apiRate = Number(process.env.API_PER_SEC) || 20;
  const apiBuckets = new Buckets(apiBurst, apiRate);
  const ipBuckets = new Buckets(apiBurst * 3, apiRate * 3);
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const sid = (req.cookies as Record<string, string | undefined>)?.sid;
    const okIp = ipBuckets.take('i:' + req.ipKey);
    const okSession = sid ? apiBuckets.take('s:' + sha256(sid).slice(0, 24)) : true;
    if (!okIp || !okSession) {
      reply.header('Retry-After', '2');
      throw new HttpError(429, 'slow_down', '请求太频繁，请稍后再试');
    }
  });

  // CSRF: reject cross-origin state-changing requests
  app.addHook('preHandler', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host; // URL already drops the scheme's default port
      } catch {
        /* ignore */
      }
      // Reverse proxies (e.g. BaoTa's default `Host $host:$server_port`) may add the default port to Host.
      const reqHost = String(req.headers.host ?? '').toLowerCase().replace(/:(443|80)$/, '');
      if (!host || host.toLowerCase() !== reqHost) throw new HttpError(403, 'bad_origin', '跨站请求被拒绝');
    }
  });

  // Liveness probe for the process supervisor / update script. Reachable without IP approval; the version is
  // only shown to local callers so strangers can't fingerprint the build.
  app.get('/healthz', async (req) => {
    ctx.db.prepare('SELECT 1').get();
    const local = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
    return local ? { ok: true, version: APP_VERSION, uptime: Math.round(process.uptime()) } : { ok: true };
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: '服务器错误' });
  });

  registerGate(app, ctx); // must be first: blocks everything for unknown IPs
  registerAuth(app, ctx);
  registerChats(app, ctx);
  registerScheduled(app, ctx);
  registerPreview(app, ctx);
  registerCalls(app, ctx);
  registerSocial(app, ctx);
  registerTotp(app, ctx);
  registerPasskeys(app, ctx);
  registerAccount(app, ctx);
  registerAvatars(app, ctx);
  registerLink(app, ctx);
  registerInsights(app, ctx);
  registerInvites(app, ctx);
  registerAdmin(app, ctx);
  registerClientErrors(app, ctx);
  registerSecret(app, ctx);
  registerBlobs(app, ctx);
  initPush(ctx);
  registerPush(app, ctx);
  registerSync(app, ctx);
  removeOrphanFiles(ctx);

  // Built web client (only reachable by allow-listed IPs thanks to the gate hook)
  const hasWeb = fs.existsSync(path.join(config.webDist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: false });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && hasWeb) {
      return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  attachRealtime(app.server, ctx);

  const timer = setInterval(() => {
    try {
      purgeExpired(ctx);
      dispatchScheduled(ctx);
    } catch (e) {
      app.log.error(e);
    }
  }, 5_000);
  const monitorTimer = setInterval(() => {
    try {
      runMonitors(ctx);
      pruneLogs(ctx);
    } catch (e) {
      app.log.error(e);
    }
  }, 10 * 60_000);
  monitorTimer.unref();
  const blobTimer = setInterval(() => {
    try {
      purgeUnreferencedBlobs(ctx);
      purgeSecret(ctx);
      purgeOldAttachments(ctx);
    } catch (e) {
      app.log.error(e);
    }
  }, 10 * 60_000);
  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearInterval(blobTimer);
    clearInterval(monitorTimer);
    ctx.io?.close();
    db.close();
  });

  return { app, ctx };
}
