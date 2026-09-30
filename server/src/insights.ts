/**
 * Admin insights (v0.4): audit log of admin actions, daily activity statistics, attachment retention.
 * Only counts and ids — never message content (the server can't read it anyway) and no IP history.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from './context.js';
import { requireAdmin } from './auth.js';
import { limits } from './settings.js';
import { APP_VERSION } from './config.js';
import { now } from './util.js';

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const SECRET_KEYS = /pass|secret|token|code|key/i;

function readMarker(ctx: Ctx, name: string): string | null {
  try {
    return fs.readFileSync(path.join(ctx.config.dataDir, name), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
const secs = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) * 1000 : null);

/**
 * Backup health for the admin page. The ops scripts write small marker files into data/:
 *   .last-backup (unix time) · .backup-info (JSON: size / count / total) · .offsite-remote (where to)
 *   .last-offsite (unix time of the last good upload) · .offsite-failed (unix time of the last failure, 0 = none)
 */
export function backupStatus(ctx: Ctx) {
  let info: { size?: string; count?: number; total?: string } = {};
  try {
    info = JSON.parse(readMarker(ctx, '.backup-info') ?? '{}');
  } catch {
    /* ignore */
  }
  const lastBackup = secs(readMarker(ctx, '.last-backup'));
  const remote = readMarker(ctx, '.offsite-remote');
  const lastOffsite = secs(readMarker(ctx, '.last-offsite'));
  const failedAt = secs(readMarker(ctx, '.offsite-failed'));
  return {
    installed: lastBackup !== null,
    local: { last: lastBackup, size: String(info.size ?? '').slice(0, 20) || null, count: Number(info.count) || null, total: String(info.total ?? '').slice(0, 20) || null },
    offsite: {
      configured: !!remote,
      remote: remote ? remote.slice(0, 200) : null,
      last: lastOffsite,
      failedAt: failedAt && (!lastOffsite || failedAt > lastOffsite) ? failedAt : null,
    },
  };
}

/** Remember "user X was active today" (once per user per day, cached in memory). */
const seen = new Set<string>();
export function noteActivity(ctx: Ctx, userId: string) {
  const k = `${dayOf(now())}|${userId}`;
  if (seen.has(k)) return;
  if (seen.size > 50_000) seen.clear();
  seen.add(k);
  ctx.db.prepare('INSERT OR IGNORE INTO daily_activity(day, user_id) VALUES (?, ?)').run(dayOf(now()), userId);
}

function sanitize(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const clean = JSON.stringify(body, (k, v) => (k && SECRET_KEYS.test(k) ? '***' : v));
  return clean.length > 600 ? clean.slice(0, 600) + '…' : clean;
}

/** Attachment retention: delete files older than N days (0 = keep forever). Personal saved items are kept. */
export function purgeOldAttachments(ctx: Ctx) {
  const days = limits(ctx).attachmentRetentionDays ?? 0;
  if (!days) return 0;
  const cutoff = now() - days * 86_400_000;
  const rows = ctx.db
    // personal files and avatars are not chat attachments: retention doesn't apply to them
    .prepare("SELECT id FROM blobs WHERE created_at < ? AND chat_id NOT LIKE 'self:%' AND chat_id NOT LIKE 'avatar:%' AND (message_id IS NULL OR (message_id NOT LIKE 'gavatar:%' AND message_id NOT LIKE 'secret:%')) LIMIT 5000")
    .all(cutoff) as { id: string }[];
  const del = ctx.db.prepare('DELETE FROM blobs WHERE id = ?');
  for (const r of rows) {
    del.run(r.id);
    fs.promises.unlink(path.join(ctx.config.dataDir, 'blobs', r.id)).catch(() => undefined);
  }
  return rows.length;
}

export function registerInsights(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;

  // every successful admin change is written to the audit log
  app.addHook('onResponse', async (req: FastifyRequest, reply) => {
    if (req.method === 'GET' || !req.url.startsWith('/api/admin/') || reply.statusCode >= 400 || !req.auth) return;
    if (req.url.startsWith('/api/admin/alerts/read-all')) return;
    const route = (req.routeOptions?.url ?? req.url).replace(/^\/api\/admin\//, '');
    const params = req.params as Record<string, string> | undefined;
    db.prepare('INSERT INTO admin_audit(at, admin_id, action, target, detail) VALUES (?, ?, ?, ?, ?)').run(
      now(),
      req.auth.user.id,
      `${req.method} ${route}`,
      params && Object.keys(params).length ? JSON.stringify(params) : null,
      route.includes('password') ? null : sanitize(req.body),
    );
  });

  app.get('/api/admin/audit', async (req) => {
    requireAdmin(ctx, req);
    const rows = db
      .prepare('SELECT a.id, a.at, a.action, a.target, a.detail, u.username FROM admin_audit a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT 300')
      .all() as { id: number; at: number; action: string; target: string | null; detail: string | null; username: string | null }[];
    return { entries: rows };
  });

  /**
   * Update check: if UPDATE_FEED_URL points at a JSON file ({"version":"0.4.1","notes":"…","url":"…"}), compare it with
   * the running version. Nothing is sent to that URL but a plain GET. Upgrading stays a deliberate command (ops/update.sh).
   */
  let cache: { at: number; data: unknown } | null = null;
  app.get('/api/admin/update-check', async (req) => {
    requireAdmin(ctx, req);
    const feed = process.env.UPDATE_FEED_URL;
    if (!feed) return { configured: false, current: APP_VERSION };
    if (cache && now() - cache.at < 3_600_000) return cache.data;
    let data: unknown;
    try {
      const r = await fetch(feed, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
      const j = (await r.json()) as { version?: string; notes?: string; url?: string };
      const newer = typeof j.version === 'string' && cmpVer(j.version, APP_VERSION) > 0;
      data = { configured: true, current: APP_VERSION, latest: String(j.version ?? ''), newer, notes: String(j.notes ?? '').slice(0, 4000), url: String(j.url ?? '').slice(0, 500) };
    } catch {
      data = { configured: true, current: APP_VERSION, error: '无法获取更新信息' };
    }
    cache = { at: now(), data };
    return data;
  });

  /** Backup health, from the marker files the ops scripts leave in data/ (the backup folders themselves are root-only). */
  app.get('/api/admin/backup-status', async (req) => {
    requireAdmin(ctx, req);
    return backupStatus(ctx);
  });

  app.get('/api/admin/stats', async (req) => {
    requireAdmin(ctx, req);
    const since = now() - 30 * 86_400_000;
    const days: string[] = [];
    for (let i = 29; i >= 0; i--) days.push(dayOf(now() - i * 86_400_000));
    const act = new Map(
      (db.prepare('SELECT day, COUNT(*) AS n FROM daily_activity WHERE day >= ? GROUP BY day').all(days[0]) as { day: string; n: number }[]).map((r) => [r.day, r.n]),
    );
    const msgs = new Map(
      (
        db
          .prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY day")
          .all(since) as { day: string; n: number }[]
      ).map((r) => [r.day, r.n]),
    );
    const up = new Map(
      (
        db
          .prepare("SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, SUM(bytes) AS n FROM upload_usage WHERE at >= ? GROUP BY day")
          .all(since) as { day: string; n: number }[]
      ).map((r) => [r.day, r.n]),
    );
    const one = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
    return {
      version: APP_VERSION,
      days: days.map((d) => ({ day: d, active: act.get(d) ?? 0, messages: msgs.get(d) ?? 0, uploaded: up.get(d) ?? 0 })),
      totals: {
        users: one('SELECT COUNT(*) AS n FROM users'),
        active7: one('SELECT COUNT(DISTINCT user_id) AS n FROM daily_activity WHERE day >= ?', dayOf(now() - 6 * 86_400_000)),
        active30: one('SELECT COUNT(DISTINCT user_id) AS n FROM daily_activity WHERE day >= ?', days[0]),
        chats: one('SELECT COUNT(*) AS n FROM chats'),
        groups: one("SELECT COUNT(*) AS n FROM chats WHERE type = 'group'"),
        messages: one('SELECT COUNT(*) AS n FROM messages'),
        storageBytes: one('SELECT COALESCE(SUM(size), 0) AS n FROM blobs'),
        twoFactor: one('SELECT COUNT(*) AS n FROM users WHERE totp_secret IS NOT NULL'),
      },
    };
  });
}

export function cmpVer(a: string, b: string) {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
