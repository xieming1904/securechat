/**
 * Security / health alerts for administrators: stored, pushed live to admins over the socket,
 * and as a content-free web push to admins who are offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context.js';
import { newId, now } from './util.js';
import { notifyAdminsAlert } from './push.js';
import { backupStatus } from './insights.js';

export type AlertKind = 'ip_banned' | 'ip_blocked' | 'gate_flood' | 'login_bruteforce' | 'disk_low' | 'backup_stale' | 'offsite_failed' | 'offsite_stale' | 'admin_change';

/** Store + broadcast an alert. Same `dedupeKey` within `dedupeMs` is ignored (no alert storms). */
export function raiseAlert(ctx: Ctx, kind: AlertKind, message: string, dedupeKey: string = kind, dedupeMs = 3_600_000) {
  const t = now();
  const dup = ctx.db.prepare('SELECT 1 FROM admin_alerts WHERE dedupe_key = ? AND created_at > ?').get(dedupeKey, t - dedupeMs);
  if (dup) return;
  const id = newId('al');
  ctx.db.prepare('INSERT INTO admin_alerts(id, kind, message, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?)').run(id, kind, message, dedupeKey, t);
  // keep the table small
  ctx.db.prepare('DELETE FROM admin_alerts WHERE created_at < ?').run(t - 90 * 86_400_000);
  ctx.emitAdmins('admin:alert', { id, kind, message, createdAt: t });
  notifyAdminsAlert(ctx);
}

const GATE_FLOOD = 30; // failed access-password attempts (all IPs) in 10 minutes

/** Periodic checks: disk space, gate brute force across IPs, backup freshness. */
export function runMonitors(ctx: Ctx) {
  const t = now();
  // disk
  try {
    const st = fs.statfsSync(ctx.config.dataDir);
    const free = st.bavail * st.bsize;
    const total = st.blocks * st.bsize;
    if (free < 2 * 1024 ** 3 || free / total < 0.1)
      raiseAlert(ctx, 'disk_low', `服务器磁盘空间不足：剩余 ${(free / 1024 ** 3).toFixed(1)} GB（${Math.round((free / total) * 100)}%）`, 'disk_low', 6 * 3_600_000);
  } catch {
    /* statfs unsupported */
  }
  // many failed access-password attempts overall (distributed guessing)
  const fails = (ctx.db.prepare('SELECT COUNT(*) AS n FROM gate_attempts WHERE success = 0 AND created_at > ?').get(t - 600_000) as { n: number }).n;
  if (fails >= GATE_FLOOD) raiseAlert(ctx, 'gate_flood', `过去 10 分钟有 ${fails} 次访问密码输错（来自多个 IP），可能有人在尝试猜密码`, 'gate_flood');
  // backups (only when the ops scripts are installed: they write data/.last-backup)
  try {
    const marker = path.join(ctx.config.dataDir, '.last-backup');
    if (fs.existsSync(marker)) {
      const last = Number(fs.readFileSync(marker, 'utf8').trim()) * 1000;
      if (last && t - last > 36 * 3_600_000)
        raiseAlert(ctx, 'backup_stale', `已经 ${Math.floor((t - last) / 3_600_000)} 小时没有成功备份了，请检查 securechat-backup 定时任务`, 'backup_stale', 12 * 3_600_000);
    }
    const b = backupStatus(ctx);
    if (b.offsite.failedAt)
      raiseAlert(ctx, 'offsite_failed', '异地备份上传失败（本地备份正常）。请在服务器上运行 journalctl -u securechat-backup 查看原因', 'offsite_failed', 12 * 3_600_000);
    else if (b.offsite.configured && b.offsite.last && t - b.offsite.last > 48 * 3_600_000)
      raiseAlert(ctx, 'offsite_stale', `已经 ${Math.floor((t - b.offsite.last) / 3_600_000)} 小时没有成功上传异地备份了`, 'offsite_stale', 12 * 3_600_000);
  } catch {
    /* ignore */
  }
}

/**
 * Log retention (v0.7): the access-check log and decided access requests hold IP addresses, so they are kept
 * for LOG_RETENTION_DAYS (default 90); the admin audit log for a year. Runs with the 10-minute monitors, cheap.
 */
export function pruneLogs(ctx: Ctx) {
  const t = now();
  const days = Math.max(7, Math.min(3650, Number(process.env.LOG_RETENTION_DAYS) || 90));
  const cut = t - days * 86_400_000;
  ctx.db.prepare('DELETE FROM gate_attempts WHERE created_at < ?').run(cut);
  ctx.db.prepare("DELETE FROM gate_requests WHERE status != 'pending' AND created_at < ?").run(cut);
  ctx.db.prepare('DELETE FROM admin_audit WHERE at < ?').run(t - 365 * 86_400_000);
  ctx.db.prepare('DELETE FROM client_errors WHERE last_at < ?').run(t - 90 * 86_400_000);
}
