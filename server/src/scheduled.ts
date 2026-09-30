/**
 * Scheduled messages and draft sync.
 *
 * Scheduled: the sender's browser encrypts + signs the message exactly like a normal send and hands it to the server
 * together with a send time. At that time the server inserts it unchanged. If the chat key rotated in the meantime
 * (members changed), the stored ciphertext is no longer for the current epoch: the row is marked stale and the
 * sender's client re-encrypts it with the new key the next time it is online. The server never sees the text.
 *
 * Drafts: encrypted with a key only the user's own devices can derive (from the identity key), so a half-written
 * message follows you between devices without the server being able to read it.
 */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireUser } from './auth.js';
import { assertCanPost, insertMessage } from './chats.js';
import { HttpError, b64, bad, int, newId, notFound, now, str } from './util.js';

const MAX_CT = 200_000;
const MAX_DRAFT_CT = 40_000;
const MAX_PENDING = 100;
const MIN_AHEAD = 5_000;
const MAX_AHEAD = 366 * 86_400_000;

interface ScheduledRow {
  id: string;
  chat_id: string;
  sender_id: string;
  epoch: number;
  client_msg_id: string;
  nonce: string;
  ciphertext: string;
  signature: string;
  send_at: number;
  stale: number;
  created_at: number;
}

const out = (r: ScheduledRow) => ({
  id: r.id,
  chatId: r.chat_id,
  epoch: r.epoch,
  clientMsgId: r.client_msg_id,
  nonce: r.nonce,
  ciphertext: r.ciphertext,
  signature: r.signature,
  sendAt: r.send_at,
  stale: !!r.stale,
  createdAt: r.created_at,
});

type Chat = { id: string; current_epoch: number; needs_rotation: number };
const chatFor = (ctx: Ctx, chatId: string, userId: string) =>
  ctx.db
    .prepare(
      'SELECT c.id, c.current_epoch, c.needs_rotation FROM chats c JOIN chat_members m ON m.chat_id = c.id JOIN users u ON u.id = m.user_id WHERE c.id = ? AND m.user_id = ? AND u.disabled_at IS NULL',
    )
    .get(chatId, userId) as Chat | undefined;

/** Deliver one scheduled row if its encryption is still valid. Returns true when it was sent (or dropped). */
function deliver(ctx: Ctx, r: ScheduledRow): boolean {
  const db = ctx.db;
  const chat = chatFor(ctx, r.chat_id, r.sender_id);
  if (!chat) {
    db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(r.id); // sender left / chat gone
    return true;
  }
  if (chat.needs_rotation || chat.current_epoch !== r.epoch) {
    if (!r.stale) {
      db.prepare('UPDATE scheduled_messages SET stale = 1 WHERE id = ?').run(r.id);
      ctx.emitToUsers([r.sender_id], 'scheduled:stale', out({ ...r, stale: 1 }));
    }
    return false;
  }
  try {
    assertCanPost(ctx, r.chat_id, r.sender_id);
  } catch {
    db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(r.id); // blocked / muted meanwhile: drop it
    ctx.emitToUsers([r.sender_id], 'scheduled:sent', { id: r.id, chatId: r.chat_id, cancelled: true });
    return true;
  }
  const dup = db.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND sender_id = ? AND client_msg_id = ?').get(r.chat_id, r.sender_id, r.client_msg_id);
  if (!dup) insertMessage(ctx, r.chat_id, r.sender_id, { epoch: r.epoch, clientMsgId: r.client_msg_id, nonce: r.nonce, ciphertext: r.ciphertext, signature: r.signature });
  db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(r.id);
  ctx.emitToUsers([r.sender_id], 'scheduled:sent', { id: r.id, chatId: r.chat_id });
  return true;
}

export function dispatchScheduled(ctx: Ctx) {
  const due = ctx.db.prepare('SELECT * FROM scheduled_messages WHERE send_at <= ? AND stale = 0 ORDER BY send_at LIMIT 200').all(now()) as ScheduledRow[];
  for (const r of due) {
    try {
      deliver(ctx, r);
    } catch (e) {
      // never let one bad row block the queue: park it as stale so the sender's client re-sends it
      ctx.db.prepare('UPDATE scheduled_messages SET stale = 1 WHERE id = ?').run(r.id);
      console.error('scheduled delivery failed', r.id, e);
    }
  }
}

export function registerScheduled(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;

  const readBody = (body: Record<string, unknown>) => ({
    epoch: int(body, 'epoch', { min: 1 }),
    nonce: b64(body, 'nonce', 24),
    ciphertext: b64(body, 'ciphertext', undefined, MAX_CT),
    signature: b64(body, 'signature', 64),
    sendAt: int(body, 'sendAt', { min: 0 }),
  });
  const checkTime = (sendAt: number) => {
    if (sendAt < now() + MIN_AHEAD || sendAt > now() + MAX_AHEAD) throw bad('invalid_time', '定时时间需要在未来 1 年以内');
  };
  const checkEpoch = (chat: Chat, epoch: number) => {
    if (chat.needs_rotation) throw new HttpError(409, 'rotation_required', '成员已变化，需要先轮换密钥');
    if (epoch !== chat.current_epoch) throw new HttpError(409, 'epoch_stale', '密钥纪元已变化，请刷新');
  };
  const own = (id: string, userId: string) => {
    const r = db.prepare('SELECT * FROM scheduled_messages WHERE id = ? AND sender_id = ?').get(id, userId) as ScheduledRow | undefined;
    if (!r) throw notFound();
    return r;
  };

  app.get('/api/scheduled', async (req) => {
    const { user } = requireUser(ctx, req);
    const rows = db.prepare('SELECT * FROM scheduled_messages WHERE sender_id = ? ORDER BY send_at').all(user.id) as ScheduledRow[];
    return { scheduled: rows.map(out) };
  });

  app.post('/api/chats/:id/scheduled', async (req) => {
    const { user } = requireUser(ctx, req);
    const chat = chatFor(ctx, (req.params as { id: string }).id, user.id);
    if (!chat) throw notFound('chat_not_found');
    const body = req.body as Record<string, unknown>;
    const clientMsgId = str(body, 'clientMsgId', { pattern: /^[A-Za-z0-9_-]{22}$/ });
    const b = readBody(body);
    checkTime(b.sendAt);
    checkEpoch(chat, b.epoch);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM scheduled_messages WHERE sender_id = ?').get(user.id) as { n: number }).n;
    if (n >= MAX_PENDING) throw new HttpError(429, 'too_many', `最多 ${MAX_PENDING} 条待发送的定时消息`);
    if (db.prepare('SELECT 1 FROM scheduled_messages WHERE chat_id = ? AND sender_id = ? AND client_msg_id = ?').get(chat.id, user.id, clientMsgId))
      throw new HttpError(409, 'duplicate', '重复的定时消息');
    const id = newId('s');
    db.prepare(
      `INSERT INTO scheduled_messages(id, chat_id, sender_id, epoch, client_msg_id, nonce, ciphertext, signature, send_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, chat.id, user.id, b.epoch, clientMsgId, b.nonce, b.ciphertext, b.signature, b.sendAt, now());
    const row = out(own(id, user.id));
    ctx.emitToUsers([user.id], 'scheduled:changed', row);
    return { scheduled: row };
  });

  /** Re-encrypt (after a key rotation) and/or change the time. clientMsgId stays the same — it is bound into the signature. */
  app.put('/api/scheduled/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const r = own((req.params as { id: string }).id, user.id);
    const chat = chatFor(ctx, r.chat_id, user.id);
    if (!chat) throw notFound();
    const b = readBody(req.body as Record<string, unknown>);
    // a stale message whose time has passed is re-encrypted with an old send time → it goes out on the next tick
    if (b.sendAt > now() + MAX_AHEAD) throw bad('invalid_time', '定时时间需要在未来 1 年以内');
    checkEpoch(chat, b.epoch);
    db.prepare('UPDATE scheduled_messages SET epoch = ?, nonce = ?, ciphertext = ?, signature = ?, send_at = ?, stale = 0 WHERE id = ?').run(
      b.epoch,
      b.nonce,
      b.ciphertext,
      b.signature,
      b.sendAt,
      r.id,
    );
    const row = out(own(r.id, user.id));
    ctx.emitToUsers([user.id], 'scheduled:changed', row);
    return { scheduled: row };
  });

  app.post('/api/scheduled/:id/send-now', async (req) => {
    const { user } = requireUser(ctx, req);
    const r = own((req.params as { id: string }).id, user.id);
    if (!deliver(ctx, { ...r, stale: 1 })) throw new HttpError(409, 'epoch_stale', '密钥已轮换，请稍后重试');
    return { ok: true };
  });

  app.delete('/api/scheduled/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const r = own((req.params as { id: string }).id, user.id);
    db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(r.id);
    ctx.emitToUsers([user.id], 'scheduled:sent', { id: r.id, chatId: r.chat_id, cancelled: true });
    return { ok: true };
  });

  // ------------------------------------------------------------------ drafts
  app.get('/api/drafts', async (req) => {
    const { user } = requireUser(ctx, req);
    const rows = db.prepare('SELECT chat_id, nonce, ciphertext, updated_at FROM drafts WHERE user_id = ?').all(user.id) as {
      chat_id: string;
      nonce: string;
      ciphertext: string;
      updated_at: number;
    }[];
    return { drafts: rows.map((d) => ({ chatId: d.chat_id, nonce: d.nonce, ciphertext: d.ciphertext, updatedAt: d.updated_at })) };
  });

  app.put('/api/drafts/:chatId', async (req) => {
    const { user } = requireUser(ctx, req);
    const chatId = (req.params as { chatId: string }).chatId;
    if (!chatFor(ctx, chatId, user.id)) throw notFound('chat_not_found');
    const body = req.body as Record<string, unknown>;
    const nonce = b64(body, 'nonce', 24);
    const ciphertext = b64(body, 'ciphertext', undefined, MAX_DRAFT_CT);
    const t = now();
    db.prepare(
      `INSERT INTO drafts(user_id, chat_id, nonce, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, chat_id) DO UPDATE SET nonce = excluded.nonce, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
    ).run(user.id, chatId, nonce, ciphertext, t);
    ctx.emitToUsers([user.id], 'draft', { chatId, draft: { chatId, nonce, ciphertext, updatedAt: t } });
    return { updatedAt: t };
  });

  app.delete('/api/drafts/:chatId', async (req) => {
    const { user } = requireUser(ctx, req);
    const chatId = (req.params as { chatId: string }).chatId;
    db.prepare('DELETE FROM drafts WHERE user_id = ? AND chat_id = ?').run(user.id, chatId);
    ctx.emitToUsers([user.id], 'draft', { chatId, draft: null });
    return { ok: true };
  });
}
