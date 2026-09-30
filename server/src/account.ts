/**
 * v0.6 self-service account deletion.
 * What goes: sessions, the password / recovery-word records (so nobody can ever log in again), the encrypted key
 * backups, two-step verification, passkeys, the personal vault (contacts, saved, stickers, settings) and its files,
 * drafts, scheduled messages, push subscriptions, block lists, avatar.
 * What stays: the user row as a tombstone ("已注销账号") with the PUBLIC keys, so messages already sent keep a
 * verifiable sender for the people who received them. The username stays reserved (no impersonation later).
 * Leaving groups is done by the client first (membership changes must be signed by the member).
 */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireRecentPassword, requireUser } from './auth.js';
import { guardedProof, hasSecondFactor } from './passkey.js';
import { removeBlobsById, removeMessageExtras } from './blobs.js';
import { peersOf } from './chats.js';
import { selfChat } from './social.js';
import { HttpError, now, randomToken } from './util.js';

const tokens = new Map<string, { sessionId: string; userId: string; expires: number }>();

export function registerAccount(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;
  /**
   * Step 1: check everything (username typed, password re-entered, second factor) and hand out a short-lived token.
   * The client then leaves its groups (signed by itself) and calls step 2 — so nothing is left half-done when a
   * check fails.
   */
  app.post('/api/me/delete/prepare', async (req) => {
    const auth = requireUser(ctx, req);
    const { user } = auth;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.confirm !== 'string' || body.confirm.toLowerCase() !== user.username.toLowerCase()) throw new HttpError(400, 'confirm', '请输入你的用户名以确认');
    requireRecentPassword(ctx, auth);
    if (hasSecondFactor(ctx, user.id)) await guardedProof(ctx, user.id, body.proof, auth.sessionId);
    lastAdminCheck(user.id, !!user.is_admin);
    const token = randomToken(24);
    for (const [k, v] of tokens) if (v.expires < now()) tokens.delete(k);
    tokens.set(token, { sessionId: auth.sessionId, userId: user.id, expires: now() + 5 * 60_000 });
    return { token };
  });

  const lastAdminCheck = (userId: string, isAdmin: boolean) => {
    if (!isAdmin) return;
    const others = (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled_at IS NULL AND deleted_at IS NULL AND id != ?').get(userId) as { n: number }).n;
    if (others === 0) throw new HttpError(409, 'last_admin', '你是唯一的管理员，请先把另一位用户设为管理员再注销');
  };

  app.post('/api/me/delete', async (req) => {
    const auth = requireUser(ctx, req);
    const { user } = auth;
    const token = String(((req.body ?? {}) as Record<string, unknown>).token ?? '');
    const t = tokens.get(token);
    tokens.delete(token);
    if (!t || t.expires < now() || t.sessionId !== auth.sessionId || t.userId !== user.id) throw new HttpError(401, 'expired', '确认已过期，请重新操作');
    lastAdminCheck(user.id, !!user.is_admin);
    // groups must be left first (signed by the member): a dead account in a member list would keep receiving keys
    const groups = db.prepare("SELECT c.id FROM chat_members m JOIN chats c ON c.id = m.chat_id WHERE m.user_id = ? AND c.type = 'group'").all(user.id) as { id: string }[];
    if (groups.length) throw new HttpError(409, 'still_in_groups', `还在 ${groups.length} 个群组里，请先退出这些群组再注销`);
    const peers = peersOf(ctx, user.id);
    // personal files (vault attachments, avatar) — collect before the rows go
    const vaultRefs = (db.prepare('SELECT kind, item_id FROM user_vault WHERE user_id = ?').all(user.id) as { kind: string; item_id: string }[]).map(
      (r) => `v:${user.id}:${r.kind}:${r.item_id}`,
    );
    db.transaction(() => {
      const t = now();
      db.prepare(
        `UPDATE users SET deleted_at = ?, disabled_at = COALESCE(disabled_at, ?), display_name = '已注销账号', bio = '', opaque_record = NULL,
           recovery_record = NULL, avatar_blob = NULL, totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, privacy = NULL, is_admin = 0 WHERE id = ?`,
      ).run(t, t, user.id);
      db.prepare("UPDATE user_keys SET backup_ct = '', backup_nonce = '', recovery_backup_ct = NULL, recovery_backup_nonce = NULL, updated_at = ? WHERE user_id = ?").run(t, user.id);
      for (const sql of [
        'DELETE FROM sessions WHERE user_id = ?',
        'DELETE FROM totp_recovery WHERE user_id = ?',
        'DELETE FROM webauthn_creds WHERE user_id = ?',
        'DELETE FROM user_vault WHERE user_id = ?',
        'DELETE FROM drafts WHERE user_id = ?',
        'DELETE FROM scheduled_messages WHERE sender_id = ?',
        'DELETE FROM push_subscriptions WHERE user_id = ?',
        'DELETE FROM blocks WHERE user_id = ? OR blocked_id = ?',
        'DELETE FROM avatar_keys WHERE user_id = ?',
        'DELETE FROM join_requests WHERE user_id = ?',
      ])
        db.prepare(sql).run(...(sql.includes('OR') ? [user.id, user.id] : [user.id]));
      db.prepare('UPDATE uploads SET updated_at = 0 WHERE owner_id = ?').run(user.id); // removed with their files by the next purge
      // invites (registration and group links) created by this account stop working
      db.prepare('UPDATE invites SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL').run(t, user.id);
    })();
    removeMessageExtras(ctx, vaultRefs);
    // anything else in my personal space (e.g. an avatar)
    const left = (db.prepare('SELECT id FROM blobs WHERE chat_id IN (?, ?)').all(selfChat(user.id), `avatar:${user.id}`) as { id: string }[]).map((b) => b.id);
    if (left.length) removeBlobsById(ctx, left);
    ctx.disconnectUser(user.id);
    // chat partners: show "deleted account" and drop the avatar right away
    ctx.emitToUsers(peers, 'avatar:changed', { userId: user.id, v: 0 });
    for (const c of db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(user.id) as { chat_id: string }[])
      ctx.emitToUsers(peers, 'chat:updated', { chatId: c.chat_id });
    return { ok: true };
  });
}
