/**
 * Anonymous front-end error reports (v0.7).
 *
 * The browser sends {message, stack, path, version, browser} when something breaks. Stored WITHOUT user id, session
 * or IP; identical errors are grouped (count + first/last time). The client already strips quoted strings and query
 * strings; the server re-checks lengths and keeps at most MAX_ROWS groups. Rate limited per IP in memory only.
 */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireAdmin } from './auth.js';
import { Buckets, HttpError, now, sha256, str } from './util.js';

const MAX_ROWS = 300;
const PER_IP_HOUR = 30;
const hits = new Map<string, { since: number; n: number }>();
const globalBucket = new Buckets(120, 1); // 120 at once, then 60 a minute

/** belt and braces: drop anything that looks like quoted data, URLs' query strings, long tokens */
export function scrub(s: string, max: number): string {
  return s
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, '"…"')
    .replace(/([?#])[^\s)]*/g, '$1…')
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, '…')
    .slice(0, max);
}

export function registerClientErrors(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.post('/api/client-errors', async (req) => {
    const t = now();
    const key = req.ipKey || req.ip;
    const h = hits.get(key);
    if (h && t - h.since < 3_600_000) {
      if (h.n >= PER_IP_HOUR) throw new HttpError(429, 'rate_limited', '请求太频繁');
      h.n++;
    } else {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { since: t, n: 1 });
    }
    // global cap as well, so many allow-listed addresses together can't flush the table
    if (!globalBucket.take('all')) throw new HttpError(429, 'rate_limited', '请求太频繁');
    const body = req.body as Record<string, unknown>;
    const message = scrub(str(body, 'message', { max: 2000 }), 300);
    const stack = scrub(str(body, 'stack', { max: 8000, optional: true }), 2000) || null;
    const path = str(body, 'path', { max: 300, optional: true }).replace(/[?#].*$/, '').replace(/\/i\/[^/]+/, '/i/…').slice(0, 100) || null;
    const version = str(body, 'version', { max: 20, optional: true, pattern: /^[0-9A-Za-z.+-]*$/ }) || null;
    const browser = str(body, 'browser', { max: 40, optional: true, pattern: /^[A-Za-z0-9 ./-]*$/ }) || null;
    const firstFrame = (stack ?? '').split('\n').find((l) => /\bat\b|@/.test(l)) ?? '';
    const sig = sha256(`${version}|${message}|${firstFrame.replace(/-[A-Za-z0-9_]{6,}\.js/, '.js').replace(/\.js[^\s)]*/, '.js')}`).slice(0, 32);
    db.prepare(
      `INSERT INTO client_errors(sig, message, stack, path, version, browser, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(sig) DO UPDATE SET count = count + 1, last_at = excluded.last_at, path = excluded.path, browser = excluded.browser`,
    ).run(sig, message, stack, path, version, browser, t, t);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM client_errors').get() as { n: number }).n;
    if (n > MAX_ROWS) db.prepare('DELETE FROM client_errors WHERE sig IN (SELECT sig FROM client_errors ORDER BY last_at ASC LIMIT ?)').run(n - MAX_ROWS);
    return { ok: true };
  });

  app.get('/api/admin/client-errors', async (req) => {
    requireAdmin(ctx, req);
    const rows = db.prepare('SELECT sig, message, stack, path, version, browser, count, first_at AS firstAt, last_at AS lastAt FROM client_errors ORDER BY last_at DESC LIMIT ?').all(MAX_ROWS);
    return { errors: rows };
  });

  app.post('/api/admin/client-errors/clear', async (req) => {
    requireAdmin(ctx, req);
    db.prepare('DELETE FROM client_errors').run();
    return { ok: true };
  });
}
