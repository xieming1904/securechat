import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireAdmin } from './auth.js';
import { setSetting } from './db.js';
import { allowIp } from './gate.js';
import { createInvite, inviteOut } from './invites.js';
import { hashPassword } from './sodium.js';
import { HttpError, bad, int, ipKey, notFound, now, str } from './util.js';
import net from 'node:net';
import { gateRules, limits, LIMIT_BOUNDS, setGateRules, setLimits, userDailyQuota } from './settings.js';
import { raiseAlert } from './alerts.js';
import { hasSecondFactor } from './passkey.js';

export function registerAdmin(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;

  app.get('/api/admin/overview', async (req) => {
    requireAdmin(ctx, req);
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      users: n('SELECT COUNT(*) AS n FROM users'),
      allowlist: n('SELECT COUNT(*) AS n FROM ip_allowlist'),
      pendingRequests: n("SELECT COUNT(*) AS n FROM gate_requests WHERE status = 'pending'"),
      blocked: n('SELECT COUNT(*) AS n FROM ip_blocklist WHERE permanent = 1 OR blocked_until > ' + now()),
      chats: n('SELECT COUNT(*) AS n FROM chats'),
      messages: n('SELECT COUNT(*) AS n FROM messages'),
      storageBytes: n('SELECT COALESCE(SUM(size), 0) AS n FROM blobs'),
      unreadAlerts: n('SELECT COUNT(*) AS n FROM admin_alerts WHERE read_at IS NULL'),
      yourIp: req.ip,
      yourIpKey: req.ipKey,
    };
  });

  // ------------------------------------------------ allowlist
  app.get('/api/admin/allowlist', async (req) => {
    requireAdmin(ctx, req);
    const rows = db.prepare('SELECT * FROM ip_allowlist ORDER BY last_seen_at DESC').all() as Record<string, unknown>[];
    return {
      entries: rows.map((r) => ({ id: r.id, ipKey: r.ip_key, source: r.source, note: r.note, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.ip_key === req.ipKey })),
    };
  });

  app.post('/api/admin/allowlist', async (req) => {
    requireAdmin(ctx, req);
    const body = req.body as Record<string, unknown>;
    const ip = str(body, 'ip', { max: 64 }).trim();
    if (!net.isIP(ip)) throw bad('invalid_ip', 'IP 地址格式不正确');
    const key = ipKey(ip, ctx.config.ipv6Prefix);
    allowIp(ctx, key, 'admin', str(body, 'note', { max: 100, optional: true }) || undefined);
    return { ok: true, ipKey: key };
  });

  app.patch('/api/admin/allowlist/:id', async (req) => {
    requireAdmin(ctx, req);
    const note = str(req.body as Record<string, unknown>, 'note', { max: 100, optional: true });
    db.prepare('UPDATE ip_allowlist SET note = ? WHERE id = ?').run(note || null, (req.params as { id: string }).id);
    return { ok: true };
  });

  app.delete('/api/admin/allowlist/:id', async (req) => {
    requireAdmin(ctx, req);
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT ip_key FROM ip_allowlist WHERE id = ?').get(id) as { ip_key: string } | undefined;
    if (!row) throw notFound();
    if (row.ip_key === req.ipKey) throw bad('self_lockout', '不能移除你当前正在使用的 IP');
    db.prepare('DELETE FROM ip_allowlist WHERE id = ?').run(id);
    return { ok: true };
  });

  // ------------------------------------------------ blocklist & attempts
  app.get('/api/admin/blocklist', async (req) => {
    requireAdmin(ctx, req);
    const rows = db.prepare('SELECT * FROM ip_blocklist WHERE permanent = 1 OR blocked_until > ? ORDER BY blocked_until DESC').all(now()) as Record<string, unknown>[];
    return { entries: rows.map((r) => ({ ipKey: r.ip_key, totalFails: r.total_fails, blockedUntil: r.blocked_until, permanent: !!r.permanent })) };
  });

  app.delete('/api/admin/blocklist/:ipKey', async (req) => {
    requireAdmin(ctx, req);
    db.prepare('DELETE FROM ip_blocklist WHERE ip_key = ?').run(decodeURIComponent((req.params as { ipKey: string }).ipKey));
    return { ok: true };
  });

  app.get('/api/admin/gate-attempts', async (req) => {
    requireAdmin(ctx, req);
    const limit = int(req.query as Record<string, unknown>, 'limit', { min: 1, max: 500, def: 100 });
    const rows = db.prepare('SELECT * FROM gate_attempts ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return { attempts: rows.map((r) => ({ id: r.id, ip: r.ip, method: r.method, success: !!r.success, userAgent: r.user_agent, createdAt: r.created_at })) };
  });

  // ------------------------------------------------ approval requests
  app.get('/api/admin/gate-requests', async (req) => {
    requireAdmin(ctx, req);
    const rows = db.prepare("SELECT * FROM gate_requests ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 200").all() as Record<string, unknown>[];
    return { requests: rows.map((r) => ({ id: r.id, ip: r.ip, ipKey: r.ip_key, message: r.message, userAgent: r.user_agent, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at })) };
  });

  app.post('/api/admin/gate-requests/:id/:action', async (req) => {
    requireAdmin(ctx, req);
    const { id, action } = req.params as { id: string; action: string };
    if (action !== 'approve' && action !== 'reject') throw notFound();
    const r = db.prepare("SELECT * FROM gate_requests WHERE id = ? AND status = 'pending'").get(id) as { ip_key: string; message: string } | undefined;
    if (!r) throw notFound();
    db.prepare('UPDATE gate_requests SET status = ?, decided_at = ? WHERE id = ?').run(action === 'approve' ? 'approved' : 'rejected', now(), id);
    if (action === 'approve') allowIp(ctx, r.ip_key, 'approval', r.message ? `申请留言：${r.message.slice(0, 80)}` : undefined);
    return { ok: true };
  });

  // ------------------------------------------------ settings
  app.put('/api/admin/gate-password', async (req) => {
    requireAdmin(ctx, req);
    const password = str(req.body as Record<string, unknown>, 'password', { min: 8, max: 256 });
    setSetting(db, 'gate_password_hash', hashPassword(password));
    return { ok: true };
  });

  /** Emergency: forget every IP except the caller's, and sign out everybody else. */
  app.post('/api/admin/lockdown', async (req) => {
    const { sessionId } = requireAdmin(ctx, req);
    const sessions = db.prepare('SELECT id FROM sessions WHERE id != ?').all(sessionId) as { id: string }[];
    db.transaction(() => {
      db.prepare('DELETE FROM ip_allowlist WHERE ip_key != ?').run(req.ipKey);
      db.prepare('DELETE FROM sessions WHERE id != ?').run(sessionId);
    })();
    sessions.forEach((s) => ctx.disconnectSession(s.id));
    return { ok: true, revokedSessions: sessions.length };
  });

  // ------------------------------------------------ users
  app.get('/api/admin/users', async (req) => {
    requireAdmin(ctx, req);
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at, u.disabled_at, u.deleted_at, u.upload_quota_mb, i.username AS invited_by_name,
           (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS session_count,
           (SELECT COALESCE(SUM(size), 0) FROM blobs b WHERE b.owner_id = u.id) AS storage,
           (SELECT COALESCE(SUM(bytes), 0) FROM upload_usage g WHERE g.owner_id = u.id AND g.at > ?) AS uploaded_today,
           (u.totp_secret IS NOT NULL OR EXISTS (SELECT 1 FROM webauthn_creds w WHERE w.user_id = u.id)) AS totp,
           (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS message_count
         FROM users u LEFT JOIN users i ON i.id = u.invited_by ORDER BY u.created_at`,
      )
      .all(now(), now() - 86_400_000) as Record<string, unknown>[];
    const defQuota = limits(ctx).dailyUploadMb;
    return {
      defaultQuotaMb: defQuota,
      users: rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        isAdmin: !!r.is_admin,
        createdAt: r.created_at,
        disabledAt: r.disabled_at,
        deletedAt: r.deleted_at,
        invitedBy: r.invited_by_name,
        lastSeenAt: r.last_seen,
        online: (ctx.online.get(r.id as string) ?? 0) > 0,
        sessions: r.session_count,
        storageBytes: r.storage,
        uploadedToday: r.uploaded_today,
        totp: !!r.totp,
        messages: r.message_count,
        quotaMb: r.upload_quota_mb ?? null,
      })),
    };
  });

  app.post('/api/admin/users/:id/:action', async (req) => {
    const { user } = requireAdmin(ctx, req);
    const { id, action } = req.params as { id: string; action: string };
    if (id === user.id) throw bad('self', '不能对自己执行此操作');
    const target = db.prepare('SELECT id, deleted_at FROM users WHERE id = ?').get(id) as { id: string; deleted_at: number | null } | undefined;
    if (!target) throw notFound();
    if (target.deleted_at) throw bad('deleted', '这个账号已注销');
    switch (action) {
      case 'disable':
        db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(now(), id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        // nothing queued by a disabled account may still go out
        db.prepare('DELETE FROM scheduled_messages WHERE sender_id = ?').run(id);
        db.prepare('UPDATE uploads SET updated_at = 0 WHERE owner_id = ?').run(id); // removed (with files) by the next purge
        ctx.disconnectUser(id);
        break;
      case 'enable':
        db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(id);
        break;
      case 'make-admin': {
        db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
        const t = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string };
        raiseAlert(ctx, 'admin_change', `@${user.username} 把 @${t.username} 设为了管理员`, `adm:${id}:${now()}`);
        break;
      }
      case 'revoke-admin':
        db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(id);
        break;
      default:
        throw notFound();
    }
    return { ok: true };
  });

  // ------------------------------------------------ registration invites
  app.get('/api/admin/invites', async (req) => {
    requireAdmin(ctx, req);
    const rows = db.prepare("SELECT * FROM invites WHERE kind = 'register' ORDER BY created_at DESC LIMIT 200").all() as Record<string, unknown>[];
    return { invites: rows.map(inviteOut) };
  });

  app.post('/api/admin/invites', async (req) => {
    const { user } = requireAdmin(ctx, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const maxUses = int(body, 'maxUses', { min: 0, max: 10_000, def: 1 });
    const expiresInHours = int(body, 'expiresInHours', { min: 0, max: 24 * 365, def: 72 });
    const grantsAdmin = body.grantsAdmin === true;
    if (grantsAdmin && maxUses !== 1) throw new HttpError(400, 'invalid_input', '管理员邀请只能使用一次');
    return createInvite(ctx, {
      kind: 'register',
      createdBy: user.id,
      maxUses: maxUses || null,
      expiresInHours: expiresInHours || null,
      grantsAdmin,
      note: str(body, 'note', { max: 100, optional: true }) || null,
    });
  });

  // ------------------------------------------------ per-user upload quota
  app.put('/api/admin/users/:id/quota', async (req) => {
    requireAdmin(ctx, req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound();
    const mb = body.quotaMb === null ? null : int(body, 'quotaMb', { min: LIMIT_BOUNDS.dailyUploadMb[0], max: LIMIT_BOUNDS.dailyUploadMb[1] });
    db.prepare('UPDATE users SET upload_quota_mb = ? WHERE id = ?').run(mb, id);
    return { ok: true, effectiveBytes: userDailyQuota(ctx, id) };
  });

  // ------------------------------------------------ tunable limits
  app.get('/api/admin/limits', async (req) => {
    requireAdmin(ctx, req);
    return { gate: gateRules(ctx), limits: limits(ctx) };
  });

  app.put('/api/admin/limits', async (req) => {
    const { user } = requireAdmin(ctx, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const g = (body.gate ?? {}) as Record<string, unknown>;
    const l = (body.limits ?? {}) as Record<string, unknown>;
    setGateRules(ctx, {
      maxFails: int(g, 'maxFails', { min: 1, max: 100 }),
      windowMin: int(g, 'windowMin', { min: 1, max: 24 * 60 }),
      blockMin: int(g, 'blockMin', { min: 1, max: 30 * 24 * 60 }),
      permanentAfter: int(g, 'permanentAfter', { min: 0, max: 10_000 }),
    });
    // you can't lock everyone (including yourself) out: turning the requirement on needs 2FA on your own account first
    if (l.require2fa === true && !limits(ctx).require2fa && !hasSecondFactor(ctx, user.id))
      throw new HttpError(400, 'need_own_2fa', '请先为自己的账号开启两步验证，再要求所有人开启');
    setLimits(ctx, {
      dailyUploadMb: int(l, 'dailyUploadMb', { min: LIMIT_BOUNDS.dailyUploadMb[0], max: LIMIT_BOUNDS.dailyUploadMb[1] }),
      maxFileMb: int(l, 'maxFileMb', { min: LIMIT_BOUNDS.maxFileMb[0], max: LIMIT_BOUNDS.maxFileMb[1] }),
      linkPreview: l.linkPreview === undefined ? limits(ctx).linkPreview : l.linkPreview === true,
      require2fa: l.require2fa === undefined ? limits(ctx).require2fa : l.require2fa === true,
      attachmentRetentionDays: l.attachmentRetentionDays === undefined ? limits(ctx).attachmentRetentionDays : int(l, 'attachmentRetentionDays', { min: 0, max: 3650 }),
    });
    // mandatory 2FA takes effect at once: live sockets of accounts without it are closed
    if (limits(ctx).require2fa)
      for (const u of db.prepare('SELECT id FROM users u WHERE totp_secret IS NULL AND NOT EXISTS (SELECT 1 FROM webauthn_creds w WHERE w.user_id = u.id)').all() as { id: string }[]) ctx.disconnectUser(u.id);
    return { gate: gateRules(ctx), limits: limits(ctx) };
  });

  // ------------------------------------------------ alerts
  app.get('/api/admin/alerts', async (req) => {
    requireAdmin(ctx, req);
    const rows = db.prepare('SELECT id, kind, message, created_at, read_at FROM admin_alerts ORDER BY created_at DESC LIMIT 200').all() as Record<
      string,
      unknown
    >[];
    return { alerts: rows.map((r) => ({ id: r.id, kind: r.kind, message: r.message, createdAt: r.created_at, readAt: r.read_at })) };
  });

  app.post('/api/admin/alerts/read-all', async (req) => {
    requireAdmin(ctx, req);
    db.prepare('UPDATE admin_alerts SET read_at = ? WHERE read_at IS NULL').run(now());
    return { ok: true };
  });
}
