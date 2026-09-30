import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireUser } from './auth.js';
import { findUsableInvite } from './gate.js';
import { MAX_GROUP } from './chats.js';
import { HttpError, forbidden, int, inviteCode, newId, notFound, now, randomToken, sha256, str } from './util.js';

export interface CreateInviteOpts {
  kind: 'register' | 'group';
  chatId?: string | null;
  createdBy?: string | null;
  maxUses?: number | null;
  expiresInHours?: number | null;
  grantsAdmin?: boolean;
  needsApproval?: boolean;
  note?: string | null;
}

export function createInvite(ctx: Ctx, o: CreateInviteOpts) {
  const id = newId('inv');
  const token = randomToken(24);
  const code = inviteCode(8);
  const t = now();
  ctx.db
    .prepare(
      `INSERT INTO invites(id, token_hash, code_hash, kind, chat_id, created_by, max_uses, grants_admin, needs_approval, note, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sha256(token),
      sha256(code),
      o.kind,
      o.chatId ?? null,
      o.createdBy ?? null,
      o.maxUses ?? null,
      o.grantsAdmin ? 1 : 0,
      o.needsApproval ? 1 : 0,
      o.note ?? null,
      o.expiresInHours ? t + o.expiresInHours * 3_600_000 : null,
      t,
    );
  return { id, token, code };
}

export function inviteOut(r: Record<string, unknown>) {
  return {
    id: r.id,
    kind: r.kind,
    chatId: r.chat_id,
    createdBy: r.created_by,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    gateUses: r.gate_uses,
    grantsAdmin: !!r.grants_admin,
    needsApproval: !!r.needs_approval,
    note: r.note,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
  };
}

export function registerInvites(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;

  function requireChatAdmin(chatId: string, userId: string) {
    const m = db
      .prepare('SELECT m.role, c.type FROM chat_members m JOIN chats c ON c.id = m.chat_id WHERE m.chat_id = ? AND m.user_id = ?')
      .get(chatId, userId) as { role: string; type: string } | undefined;
    if (!m) throw notFound('chat_not_found');
    if (m.type !== 'group') throw new HttpError(400, 'not_group');
    if (m.role === 'member') throw forbidden();
  }

  app.get('/api/chats/:id/invites', async (req) => {
    const { user } = requireUser(ctx, req);
    const { id } = req.params as { id: string };
    requireChatAdmin(id, user.id);
    const rows = db.prepare('SELECT * FROM invites WHERE chat_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(id) as Record<string, unknown>[];
    return { invites: rows.map(inviteOut) };
  });

  app.post('/api/chats/:id/invites', async (req) => {
    const { user } = requireUser(ctx, req);
    const { id } = req.params as { id: string };
    requireChatAdmin(id, user.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const inv = createInvite(ctx, {
      kind: 'group',
      chatId: id,
      createdBy: user.id,
      maxUses: int(body, 'maxUses', { min: 1, max: 10_000, optional: true }) || null,
      expiresInHours: int(body, 'expiresInHours', { min: 1, max: 24 * 365, optional: true }) || null,
      needsApproval: body.needsApproval === true,
      note: str(body, 'note', { max: 100, optional: true }) || null,
    });
    return inv;
  });

  app.delete('/api/invites/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const { id } = req.params as { id: string };
    const inv = db.prepare('SELECT * FROM invites WHERE id = ?').get(id) as { chat_id: string | null; created_by: string | null } | undefined;
    if (!inv) throw notFound();
    if (inv.chat_id) requireChatAdmin(inv.chat_id, user.id);
    else if (!user.is_admin && inv.created_by !== user.id) throw forbidden();
    db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ?').run(now(), id);
    return { ok: true };
  });

  /**
   * Accept a group invite. The user does NOT become a member here: a join request is queued and an
   * admin's client signs the membership change and rotates the key (automatically unless approval is required).
   */
  app.post('/api/invites/:token/accept', async (req) => {
    const { user } = requireUser(ctx, req);
    const { token } = req.params as { token: string };
    const inv = findUsableInvite(ctx, token);
    if (!inv || inv.kind !== 'group' || !inv.chat_id) throw new HttpError(404, 'invalid_invite', '邀请无效或已过期');
    const already = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(inv.chat_id, user.id);
    if (already) return { chatId: inv.chat_id, alreadyMember: true, pending: false };
    const count = (db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?').get(inv.chat_id) as { n: number }).n;
    if (count >= MAX_GROUP) throw new HttpError(400, 'group_full', '群已满');
    const t = now();
    const r = db
      .prepare('INSERT OR IGNORE INTO join_requests(chat_id, user_id, invite_id, auto_approve, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(inv.chat_id, user.id, inv.id, inv.needs_approval ? 0 : 1, t);
    if (r.changes) {
      db.prepare('UPDATE invites SET used_count = used_count + 1 WHERE id = ?').run(inv.id);
      db.prepare('INSERT INTO invite_uses(invite_id, user_id, ip, used_at) VALUES (?, ?, ?, ?)').run(inv.id, user.id, req.ip, t);
    }
    const admins = (db.prepare("SELECT user_id FROM chat_members WHERE chat_id = ? AND role != 'member'").all(inv.chat_id) as { user_id: string }[]).map(
      (a) => a.user_id,
    );
    ctx.emitToUsers(admins, 'join:pending', { chatId: inv.chat_id, userId: user.id, autoApprove: !inv.needs_approval });
    ctx.emitToUsers(admins, 'chat:updated', { chatId: inv.chat_id });
    return { chatId: inv.chat_id, alreadyMember: false, pending: true, needsApproval: !!inv.needs_approval };
  });
}
