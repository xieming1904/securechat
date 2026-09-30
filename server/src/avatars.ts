/**
 * v0.6 end-to-end encrypted avatars.
 *  - User avatar: the picture is encrypted on the device with a fresh key and uploaded to the owner's personal space,
 *    then moved to "avatar:<uid>". The key reaches chat partners as one small envelope per chat, encrypted with that
 *    chat's key and signed with the owner's identity key — the server stores and relays it, but can neither read it
 *    nor swap in another picture. A new avatar gets a new version; old envelopes are dropped.
 *  - Group avatar: uploaded into the group; its key is part of the admin-signed group settings (see the client).
 */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireUser } from './auth.js';
import { memberIds, peersOf } from './chats.js';
import { removeBlobsById } from './blobs.js';
import { HttpError, b64, int, notFound, now, str } from './util.js';

const MAX_AVATAR = 1024 * 1024;

export function registerAvatars(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;

  /** Set (blobId) or remove (null) my avatar. The blob must be a fresh upload of mine to my personal space. */
  app.put('/api/me/avatar', async (req) => {
    const { user } = requireUser(ctx, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const old = db.prepare('SELECT avatar_blob, avatar_v FROM users WHERE id = ?').get(user.id) as { avatar_blob: string | null; avatar_v: number };
    let blobId: string | null = null;
    if (body.blobId !== null) {
      blobId = str(body, 'blobId', { max: 64 });
      const b = db.prepare('SELECT chat_id, owner_id, size, message_id FROM blobs WHERE id = ?').get(blobId) as
        | { chat_id: string; owner_id: string; size: number; message_id: string | null }
        | undefined;
      if (!b || b.owner_id !== user.id || b.chat_id !== `self:${user.id}` || b.message_id) throw new HttpError(400, 'invalid_blob', '图片无效');
      if (b.size > MAX_AVATAR) throw new HttpError(413, 'too_large', '头像不能超过 1 MB');
    }
    const v = old.avatar_v + 1;
    db.transaction(() => {
      if (blobId) db.prepare('UPDATE blobs SET chat_id = ?, message_id = ? WHERE id = ?').run(`avatar:${user.id}`, `avatar:${user.id}`, blobId);
      db.prepare('UPDATE users SET avatar_blob = ?, avatar_v = ? WHERE id = ?').run(blobId, v, user.id);
      db.prepare('DELETE FROM avatar_keys WHERE user_id = ?').run(user.id);
    })();
    if (old.avatar_blob) removeBlobsById(ctx, [old.avatar_blob]);
    ctx.emitToUsers([user.id, ...peersOf(ctx, user.id)], 'avatar:changed', { userId: user.id, v: blobId ? v : 0 });
    return { v: blobId ? v : 0 };
  });

  /** My avatar key for one chat (encrypted with that chat's key, signed by me). */
  app.put('/api/chats/:id/avatar-key', async (req) => {
    const { user } = requireUser(ctx, req);
    const chatId = (req.params as { id: string }).id;
    if (!memberIds(ctx, chatId).includes(user.id)) throw notFound('chat_not_found');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cur = db.prepare('SELECT avatar_v, avatar_blob FROM users WHERE id = ?').get(user.id) as { avatar_v: number; avatar_blob: string | null };
    const v = int(body, 'v', { min: 1 });
    if (!cur.avatar_blob || v !== cur.avatar_v) throw new HttpError(409, 'stale', '头像已更换');
    const epoch = int(body, 'epoch', { min: 1 });
    const nonce = b64(body, 'nonce', 24);
    const ciphertext = b64(body, 'ciphertext', undefined, 1024);
    const signature = b64(body, 'signature', 64);
    db.prepare(
      `INSERT INTO avatar_keys(user_id, chat_id, v, epoch, nonce, ciphertext, signature, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, chat_id) DO UPDATE SET v = excluded.v, epoch = excluded.epoch, nonce = excluded.nonce, ciphertext = excluded.ciphertext,
         signature = excluded.signature, updated_at = excluded.updated_at`,
    ).run(user.id, chatId, v, epoch, nonce, ciphertext, signature, now());
    ctx.emitToUsers(memberIds(ctx, chatId).filter((m) => m !== user.id), 'avatar:changed', { userId: user.id, v });
    return { ok: true };
  });

  /** All avatar envelopes in my chats (for members whose avatar is current), plus my own avatar state. */
  app.get('/api/avatars', async (req) => {
    const { user } = requireUser(ctx, req);
    const rows = db
      .prepare(
        `SELECT k.user_id, k.chat_id, k.v, k.epoch, k.nonce, k.ciphertext, k.signature, u.avatar_blob
         FROM avatar_keys k JOIN chat_members m ON m.chat_id = k.chat_id AND m.user_id = ?
         JOIN users u ON u.id = k.user_id AND u.avatar_v = k.v AND u.avatar_blob IS NOT NULL AND u.deleted_at IS NULL`,
      )
      .all(user.id) as { user_id: string; chat_id: string; v: number; epoch: number; nonce: string; ciphertext: string; signature: string; avatar_blob: string }[];
    const me = db.prepare('SELECT avatar_v, avatar_blob FROM users WHERE id = ?').get(user.id) as { avatar_v: number; avatar_blob: string | null };
    return {
      mine: { v: me.avatar_blob ? me.avatar_v : 0 },
      envelopes: rows.map((r) => ({ userId: r.user_id, chatId: r.chat_id, v: r.v, epoch: r.epoch, nonce: r.nonce, ciphertext: r.ciphertext, signature: r.signature, blobId: r.avatar_blob })),
    };
  });

  /** Group avatar: an admin claims a picture uploaded into the group (its key goes into the signed settings). */
  app.put('/api/chats/:id/avatar', async (req) => {
    const { user } = requireUser(ctx, req);
    const chatId = (req.params as { id: string }).id;
    const m = db.prepare("SELECT m.role, c.type, c.avatar_blob FROM chat_members m JOIN chats c ON c.id = m.chat_id WHERE m.chat_id = ? AND m.user_id = ?").get(chatId, user.id) as
      | { role: string; type: string; avatar_blob: string | null }
      | undefined;
    if (!m) throw notFound('chat_not_found');
    if (m.type !== 'group' || m.role === 'member') throw new HttpError(403, 'forbidden', '只有管理员可以设置群头像');
    const body = (req.body ?? {}) as Record<string, unknown>;
    let blobId: string | null = null;
    if (body.blobId !== null) {
      blobId = str(body, 'blobId', { max: 64 });
      const b = db.prepare('SELECT chat_id, owner_id, size, message_id FROM blobs WHERE id = ?').get(blobId) as
        | { chat_id: string; owner_id: string; size: number; message_id: string | null }
        | undefined;
      if (!b || b.chat_id !== chatId || b.owner_id !== user.id || b.message_id) throw new HttpError(400, 'invalid_blob', '图片无效');
      if (b.size > MAX_AVATAR) throw new HttpError(413, 'too_large', '头像不能超过 1 MB');
    }
    db.transaction(() => {
      if (blobId) db.prepare('UPDATE blobs SET message_id = ? WHERE id = ?').run(`gavatar:${chatId}`, blobId);
      db.prepare('UPDATE chats SET avatar_blob = ? WHERE id = ?').run(blobId, chatId);
    })();
    if (m.avatar_blob && m.avatar_blob !== blobId) removeBlobsById(ctx, [m.avatar_blob]);
    return { ok: true };
  });
}
