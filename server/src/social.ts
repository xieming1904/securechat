/**
 * Contacts & privacy (v0.4):
 *  - block list: enforced here (a blocked person can't open a direct chat with you, message you, call you, show you
 *    typing, or add you to a group). The list is plaintext on the server — it has to be, to enforce it.
 *  - privacy settings: hide my online status / don't send read receipts (both reciprocal, like Telegram).
 *  - vault: small per-user items (contact notes, saved messages, stickers) encrypted with a key only the user's own
 *    devices can derive. Attachments of vault items are "personal" blobs (chat id `self:<user>`), only the owner can read.
 */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireUser } from './auth.js';
import { removeBlobsById, removeMessageExtras } from './blobs.js';
import { privacyChanged } from './presence.js';
import { HttpError, b64, bad, notFound, now } from './util.js';

export interface Privacy {
  hideOnline: boolean;
  noReceipts: boolean;
  /** v0.9: others see "online" only with random delays (no exact come/go times) */
  coarseOnline: boolean;
  /** v0.9: pushes are delayed a few minutes and merged (the push service can't line them up with messages) */
  pushDelay: boolean;
}
const DEFAULT_PRIVACY: Privacy = { hideOnline: false, noReceipts: false, coarseOnline: false, pushDelay: false };

export function privacyOf(ctx: Ctx, userId: string): Privacy {
  const row = ctx.db.prepare('SELECT privacy FROM users WHERE id = ?').get(userId) as { privacy: string | null } | undefined;
  try {
    return { ...DEFAULT_PRIVACY, ...(row?.privacy ? JSON.parse(row.privacy) : {}) };
  } catch {
    return DEFAULT_PRIVACY;
  }
}

/** Has `target` blocked `actor`? */
export function isBlockedBy(ctx: Ctx, actor: string, target: string): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(target, actor);
}
/** Either of the two blocked the other. */
export function blockedEitherWay(ctx: Ctx, a: string, b: string): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)').get(a, b, b, a);
}

/** The other member of a direct chat (or null for groups). */
export function directPeer(ctx: Ctx, chatId: string, userId: string): string | null {
  const c = ctx.db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId) as { type: string } | undefined;
  if (c?.type !== 'direct') return null;
  const r = ctx.db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').get(chatId, userId) as { user_id: string } | undefined;
  return r?.user_id ?? null;
}

/** Throw if someone in `targets` blocked `actor` (group adds, direct chat creation). */
export function assertNotBlockedBy(ctx: Ctx, actor: string, targets: string[]) {
  for (const t of targets) if (isBlockedBy(ctx, actor, t)) throw new HttpError(403, 'blocked', '对方拒绝了你的消息或邀请');
}

const VAULT_KINDS = /^(contact|saved|sticker|chatlist|pref)$/;
const VAULT_LIMIT = { contact: 2000, saved: 5000, sticker: 500, chatlist: 1, pref: 20 } as Record<string, number>;
const MAX_ITEM_CT = 300_000;
export const selfChat = (userId: string) => `self:${userId}`;
const vaultRef = (userId: string, kind: string, itemId: string) => `v:${userId}:${kind}:${itemId}`;

export function registerSocial(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;

  // ---------------------------------------------------------------- blocks
  app.get('/api/blocks', async (req) => {
    const { user } = requireUser(ctx, req);
    const rows = db
      .prepare('SELECT b.blocked_id AS id, u.username, u.display_name, b.created_at FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY b.created_at DESC')
      .all(user.id) as { id: string; username: string; display_name: string; created_at: number }[];
    return { blocked: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, at: r.created_at })) };
  });
  app.put('/api/blocks/:userId', async (req) => {
    const { user } = requireUser(ctx, req);
    const target = (req.params as { userId: string }).userId;
    if (target === user.id) throw bad('self', '不能屏蔽自己');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(target)) throw notFound();
    db.prepare('INSERT OR IGNORE INTO blocks(user_id, blocked_id, created_at) VALUES (?, ?, ?)').run(user.id, target, now());
    ctx.emitToUsers([user.id], 'blocks:changed', {});
    return { ok: true };
  });
  app.delete('/api/blocks/:userId', async (req) => {
    const { user } = requireUser(ctx, req);
    db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(user.id, (req.params as { userId: string }).userId);
    ctx.emitToUsers([user.id], 'blocks:changed', {});
    return { ok: true };
  });

  // ---------------------------------------------------------------- privacy
  app.get('/api/me/privacy', async (req) => {
    const { user } = requireUser(ctx, req);
    return { privacy: privacyOf(ctx, user.id) };
  });
  app.put('/api/me/privacy', async (req) => {
    const { user } = requireUser(ctx, req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const p: Privacy = { hideOnline: b.hideOnline === true, noReceipts: b.noReceipts === true, coarseOnline: b.coarseOnline === true, pushDelay: b.pushDelay === true };
    db.prepare('UPDATE users SET privacy = ? WHERE id = ?').run(JSON.stringify(p), user.id);
    privacyChanged(ctx, user.id); // v0.9: settle what peers see right away
    return { privacy: p };
  });

  // ---------------------------------------------------------------- vault
  app.get('/api/vault/:kind', async (req) => {
    const { user } = requireUser(ctx, req);
    const kind = (req.params as { kind: string }).kind;
    if (!VAULT_KINDS.test(kind)) throw notFound();
    const rows = db.prepare('SELECT item_id, nonce, ciphertext, updated_at FROM user_vault WHERE user_id = ? AND kind = ? ORDER BY updated_at DESC').all(user.id, kind) as {
      item_id: string;
      nonce: string;
      ciphertext: string;
      updated_at: number;
    }[];
    return { items: rows.map((r) => ({ id: r.item_id, nonce: r.nonce, ciphertext: r.ciphertext, updatedAt: r.updated_at })) };
  });

  app.put('/api/vault/:kind/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const { kind, id } = req.params as { kind: string; id: string };
    if (!VAULT_KINDS.test(kind) || !/^[A-Za-z0-9_:-]{1,80}$/.test(id)) throw bad('invalid_input');
    const body = req.body as Record<string, unknown>;
    const nonce = b64(body, 'nonce', 24);
    const ciphertext = b64(body, 'ciphertext', undefined, MAX_ITEM_CT);
    const rawBlobs = body.blobIds ?? [];
    if (!Array.isArray(rawBlobs) || rawBlobs.length > 10) throw bad('invalid_input');
    const exists = db.prepare('SELECT 1 FROM user_vault WHERE user_id = ? AND kind = ? AND item_id = ?').get(user.id, kind, id);
    if (!exists) {
      const n = (db.prepare('SELECT COUNT(*) AS n FROM user_vault WHERE user_id = ? AND kind = ?').get(user.id, kind) as { n: number }).n;
      if (n >= VAULT_LIMIT[kind]) throw new HttpError(429, 'too_many', '数量已达上限');
    }
    const ref = vaultRef(user.id, kind, id);
    const t = now();
    const keep = rawBlobs.map(String);
    let dropped: string[] = [];
    db.transaction(() => {
      const claim = db.prepare('UPDATE blobs SET message_id = ? WHERE id = ? AND chat_id = ? AND owner_id = ? AND (message_id IS NULL OR message_id = ?)');
      for (const b of keep) if (!claim.run(ref, b, selfChat(user.id), user.id, ref).changes) throw new HttpError(400, 'invalid_blob', '附件无效');
      // attachments the new version no longer references are released
      dropped = (db.prepare('SELECT id FROM blobs WHERE message_id = ?').all(ref) as { id: string }[]).map((r) => r.id).filter((id) => !keep.includes(id));
      db.prepare(
        `INSERT INTO user_vault(user_id, kind, item_id, nonce, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, kind, item_id) DO UPDATE SET nonce = excluded.nonce, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      ).run(user.id, kind, id, nonce, ciphertext, t);
    })();
    if (dropped.length) removeBlobsById(ctx, dropped);
    ctx.emitToUsers([user.id], 'vault', { kind, id, item: { id, nonce, ciphertext, updatedAt: t } });
    return { updatedAt: t };
  });

  app.delete('/api/vault/:kind/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const { kind, id } = req.params as { kind: string; id: string };
    if (!VAULT_KINDS.test(kind)) throw notFound();
    removeMessageExtras(ctx, [vaultRef(user.id, kind, id)]); // its personal attachments
    db.prepare('DELETE FROM user_vault WHERE user_id = ? AND kind = ? AND item_id = ?').run(user.id, kind, id);
    ctx.emitToUsers([user.id], 'vault', { kind, id, item: null });
    return { ok: true };
  });
}
