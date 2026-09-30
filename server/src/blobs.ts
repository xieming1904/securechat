/**
 * Encrypted attachments. The browser encrypts every file (XChaCha20-Poly1305 secretstream) before upload;
 * the server only stores opaque bytes bound to one chat and only serves them to members of that chat.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from './context.js';
import { limits, userDailyQuota } from './settings.js';
import { requireUser } from './auth.js';
import { HttpError, newId, notFound, now } from './util.js';

export const MAX_BLOB = 100 * 1024 * 1024 + 64 * 1024; // 100 MB plaintext + encryption overhead
const UNREFERENCED_TTL = 24 * 3_600_000;

export const blobDir = (ctx: Ctx) => path.join(ctx.config.dataDir, 'blobs');
const blobFile = (ctx: Ctx, id: string) => path.join(blobDir(ctx), id);
export const uploadDir = (ctx: Ctx) => path.join(ctx.config.dataDir, 'uploads');
const uploadFile = (ctx: Ctx, id: string) => path.join(uploadDir(ctx), id);

export const PART_SIZE = 8 * 1024 * 1024; // client sends ciphertext in parts of this size (last one smaller)
const PART_MAX = PART_SIZE + 64 * 1024;
const UPLOAD_TTL = 24 * 3_600_000;
const MAX_ACTIVE_UPLOADS = 3;
/** secretstream overhead: 17 bytes per 64 KiB chunk */
const ctSizeFor = (plain: number) => plain + Math.max(1, Math.ceil(plain / 65_536)) * 17;

interface UploadRow {
  id: string;
  chat_id: string;
  owner_id: string;
  size: number;
  received: number;
  created_at: number;
  updated_at: number;
}

/** single-shot uploads currently streaming in (reserved before the first byte, so parallel uploads can't overrun the quota) */
const reserved = new Map<string, number>();

/** Bytes a user has used in the last 24 h: finished uploads (append-only log), chunked uploads in progress, and reservations. */
function usedToday(ctx: Ctx, userId: string) {
  const a = (ctx.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM upload_usage WHERE owner_id = ? AND at > ?').get(userId, now() - 86_400_000) as { n: number }).n;
  const b = (ctx.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM uploads WHERE owner_id = ?').get(userId) as { n: number }).n;
  return a + b + (reserved.get(userId) ?? 0);
}
const logUsage = (ctx: Ctx, userId: string, bytes: number) => ctx.db.prepare('INSERT INTO upload_usage(owner_id, bytes, at) VALUES (?, ?, ?)').run(userId, bytes, now());

function unlinkQuiet(p: string) {
  fs.promises.unlink(p).catch(() => undefined);
}

/** Remove blob rows + files, and reactions/pins, for deleted messages. */
export function removeMessageExtras(ctx: Ctx, messageIds: string[]) {
  if (!messageIds.length) return;
  const q = messageIds.map(() => '?').join(',');
  const blobs = ctx.db.prepare(`SELECT id FROM blobs WHERE message_id IN (${q})`).all(...messageIds) as { id: string }[];
  ctx.db.prepare(`DELETE FROM blobs WHERE message_id IN (${q})`).run(...messageIds);
  ctx.db.prepare(`DELETE FROM reactions WHERE message_id IN (${q})`).run(...messageIds);
  ctx.db.prepare(`DELETE FROM poll_votes WHERE message_id IN (${q})`).run(...messageIds);
  ctx.db.prepare(`DELETE FROM pins WHERE message_id IN (${q})`).run(...messageIds);
  blobs.forEach((b) => unlinkQuiet(blobFile(ctx, b.id)));
}

export function removeBlobsById(ctx: Ctx, ids: string[]) {
  const del = ctx.db.prepare('DELETE FROM blobs WHERE id = ?');
  for (const id of ids) {
    del.run(id);
    unlinkQuiet(blobFile(ctx, id));
  }
}

/** Remove every blob, reaction and pin of a chat (clear-for-everyone / chat deleted). */
export function removeChatExtras(ctx: Ctx, chatId: string, alsoUnreferenced = true) {
  // clearing the history keeps the group's avatar (it isn't a message); deleting the chat removes everything
  const which = alsoUnreferenced ? '' : " AND message_id IS NOT NULL AND message_id NOT LIKE 'gavatar:%' AND message_id NOT LIKE 'secret:%'";
  const blobs = ctx.db.prepare(`SELECT id FROM blobs WHERE chat_id = ?${which}`).all(chatId) as { id: string }[];
  ctx.db.prepare(`DELETE FROM blobs WHERE chat_id = ?${which}`).run(chatId);
  ctx.db.prepare('DELETE FROM reactions WHERE chat_id = ?').run(chatId);
  ctx.db.prepare('DELETE FROM poll_votes WHERE chat_id = ?').run(chatId);
  if (alsoUnreferenced) {
    ctx.db.prepare('DELETE FROM scheduled_messages WHERE chat_id = ?').run(chatId);
    ctx.db.prepare('DELETE FROM drafts WHERE chat_id = ?').run(chatId);
  }
  ctx.db.prepare('DELETE FROM pins WHERE chat_id = ?').run(chatId);
  blobs.forEach((b) => unlinkQuiet(blobFile(ctx, b.id)));
}

/** Attach uploaded blobs to a new message (inside the send transaction). */
export function claimBlobs(ctx: Ctx, chatId: string, userId: string, messageId: string, blobIds: string[]) {
  const upd = ctx.db.prepare('UPDATE blobs SET message_id = ? WHERE id = ? AND chat_id = ? AND owner_id = ? AND message_id IS NULL');
  for (const id of blobIds) {
    if (!upd.run(messageId, id, chatId, userId).changes) throw new HttpError(400, 'invalid_blob', '附件无效或已被使用');
  }
}

export function purgeStaleUploads(ctx: Ctx) {
  const old = ctx.db.prepare('SELECT id FROM uploads WHERE updated_at < ?').all(now() - UPLOAD_TTL) as { id: string }[];
  for (const u of old) {
    ctx.db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
    unlinkQuiet(uploadFile(ctx, u.id));
  }
}

export function purgeUnreferencedBlobs(ctx: Ctx) {
  purgeStaleUploads(ctx);
  ctx.db.prepare('DELETE FROM upload_usage WHERE at < ?').run(now() - 2 * 86_400_000);
  // partial upload files whose row is gone (deleted mid-write)
  const up = uploadDir(ctx);
  if (fs.existsSync(up)) {
    const hasUp = ctx.db.prepare('SELECT 1 FROM uploads WHERE id = ?');
    for (const f of fs.readdirSync(up)) if (!hasUp.get(f)) unlinkQuiet(path.join(up, f));
  }
  // secret-chat attachments (v0.8) carry their expiry: `secret:<ms>`
  const secret = (ctx.db.prepare("SELECT id, message_id FROM blobs WHERE message_id LIKE 'secret:%'").all() as { id: string; message_id: string }[]).filter(
    (b) => Number(b.message_id.slice(7)) < now(),
  );
  for (const b of secret) {
    ctx.db.prepare('DELETE FROM blobs WHERE id = ?').run(b.id);
    unlinkQuiet(blobFile(ctx, b.id));
  }
  const old = ctx.db.prepare('SELECT id FROM blobs WHERE message_id IS NULL AND created_at < ?').all(now() - UNREFERENCED_TTL) as { id: string }[];
  if (!old.length) return;
  ctx.db.prepare('DELETE FROM blobs WHERE message_id IS NULL AND created_at < ?').run(now() - UNREFERENCED_TTL);
  old.forEach((b) => unlinkQuiet(blobFile(ctx, b.id)));
}

/** On startup: delete files on disk that no row points to (e.g. after a crash mid-upload). */
export function removeOrphanFiles(ctx: Ctx) {
  const dir = blobDir(ctx);
  if (!fs.existsSync(dir)) return;
  const has = ctx.db.prepare('SELECT 1 FROM blobs WHERE id = ?');
  for (const f of fs.readdirSync(dir)) if (!has.get(f.replace(/\.part$/, '')) || f.endsWith('.part')) unlinkQuiet(path.join(dir, f));
  const up = uploadDir(ctx);
  if (!fs.existsSync(up)) return;
  const hasUp = ctx.db.prepare('SELECT 1 FROM uploads WHERE id = ?');
  for (const f of fs.readdirSync(up)) if (!hasUp.get(f)) unlinkQuiet(path.join(up, f));
}

/** Where an upload goes: a chat the user is a member of, or "self" (personal attachments of vault items). */
const PERSONAL_CAP = 2 * 1024 * 1024 * 1024; // saved messages + stickers per user

function uploadTarget(ctx: Ctx, chatId: string, userId: string) {
  if (chatId === 'self') {
    const used = (ctx.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE chat_id = ?').get(`self:${userId}`) as { n: number }).n;
    if (used > PERSONAL_CAP) throw new HttpError(413, 'personal_full', '收藏夹和贴纸的附件已满 2 GB，请先删除一些');
    return `self:${userId}`;
  }
  if (!ctx.db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId)) throw notFound('chat_not_found');
  return chatId;
}

export function registerBlobs(app: FastifyInstance, ctx: Ctx) {
  const sendBlob = (req: FastifyRequest, reply: FastifyReply, id: string, size: number) => {
    reply.type('application/octet-stream').header('Content-Disposition', 'attachment').header('Cache-Control', 'private, no-store').header('Accept-Ranges', 'bytes');
    // byte ranges: large attachments are downloaded and decrypted piece by piece
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
      if (start >= size || end < start) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', String(end - start + 1));
      return reply.send(fs.createReadStream(blobFile(ctx, id), { start, end }));
    }
    reply.header('Content-Length', String(size));
    return reply.send(fs.createReadStream(blobFile(ctx, id)));
  };
  const db = ctx.db;
  fs.mkdirSync(blobDir(ctx), { recursive: true, mode: 0o700 });

  // raw request body as a stream (only for this content type)
  app.addContentTypeParser('application/octet-stream', { bodyLimit: MAX_BLOB }, (_req, payload, done) => done(null, payload));

  app.post('/api/chats/:id/blobs', { bodyLimit: MAX_BLOB }, async (req) => {
    const { user } = requireUser(ctx, req);
    const chatId = uploadTarget(ctx, (req.params as { id: string }).id, user.id);
    if (req.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, 'bad_type', '需要 application/octet-stream');
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_BLOB) throw new HttpError(413, 'too_large', '文件不能超过 100 MB');
    const quota = userDailyQuota(ctx, user.id);
    if (usedToday(ctx, user.id) + declared > quota) throw new HttpError(429, 'quota', `今天的上传额度（${Math.round(quota / 1024 / 1024)} MB）已用完`);
    // reserve synchronously (before any await) so parallel uploads are counted against each other
    reserved.set(user.id, (reserved.get(user.id) ?? 0) + declared);

    const id = newId('b');
    const tmp = blobFile(ctx, id) + '.part';
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > declared) cb(new HttpError(413, 'too_large', '上传大小与声明不符'));
        else cb(null, chunk);
      },
    });
    try {
      try {
        await pipeline(req.body as NodeJS.ReadableStream, counter, fs.createWriteStream(tmp, { mode: 0o600 }));
      } catch (e) {
        unlinkQuiet(tmp);
        throw e instanceof HttpError ? e : new HttpError(400, 'upload_failed', '上传中断');
      }
      if (size === 0) {
        unlinkQuiet(tmp);
        throw new HttpError(400, 'empty', '空文件');
      }
      await fs.promises.rename(tmp, blobFile(ctx, id));
      db.transaction(() => {
        db.prepare('INSERT INTO blobs(id, chat_id, owner_id, size, created_at) VALUES (?, ?, ?, ?, ?)').run(id, chatId, user.id, size, now());
        logUsage(ctx, user.id, size);
      })();
      return { blobId: id, size };
    } finally {
      const left = (reserved.get(user.id) ?? 0) - declared;
      if (left > 0) reserved.set(user.id, left);
      else reserved.delete(user.id);
    }
  });

  app.get('/api/blobs/:id', async (req, reply) => {
    const { user } = requireUser(ctx, req);
    const { id } = req.params as { id: string };
    const b = db.prepare('SELECT * FROM blobs WHERE id = ?').get(id) as { chat_id: string; owner_id: string; size: number; message_id: string | null } | undefined;
    if (!b) throw notFound();
    if (b.chat_id.startsWith('avatar:')) {
      // encrypted avatar: the owner, and anyone who shares a chat with them (the key only reaches chat partners)
      const owner = b.chat_id.slice(7);
      const shares =
        owner === user.id ||
        !!db.prepare('SELECT 1 FROM chat_members a JOIN chat_members b ON a.chat_id = b.chat_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1').get(user.id, owner);
      if (!shares || b.message_id !== `avatar:${owner}`) throw notFound();
      return sendBlob(req, reply, id, b.size);
    }
    if (b.chat_id.startsWith('self:')) {
      // personal attachment (saved messages, stickers): only its owner
      if (b.owner_id !== user.id) throw notFound();
      return sendBlob(req, reply, id, b.size);
    }
    const member = db.prepare('SELECT cleared_before_seq FROM chat_members WHERE chat_id = ? AND user_id = ?').get(b.chat_id, user.id) as
      | { cleared_before_seq: number }
      | undefined;
    if (!member) throw notFound();
    if (!b.message_id && b.owner_id !== user.id) throw notFound(); // not yet sent: only the uploader
    if (b.message_id?.startsWith('gavatar:')) return sendBlob(req, reply, id, b.size); // group avatar: all members
    if (b.message_id?.startsWith('secret:')) return sendBlob(req, reply, id, b.size); // secret chat attachment: both people
    if (b.message_id) {
      // respect "cleared for me" / "deleted for me"
      const m = db.prepare('SELECT seq FROM messages WHERE id = ?').get(b.message_id) as { seq: number } | undefined;
      const hidden = db.prepare('SELECT 1 FROM message_hidden WHERE user_id = ? AND message_id = ?').get(user.id, b.message_id);
      if (!m || m.seq <= member.cleared_before_seq || hidden) throw notFound();
    }
    return sendBlob(req, reply, id, b.size);
  });

  // ------------------------------------------------------------ resumable chunked upload (large files, up to limits.maxFileMb)
  fs.mkdirSync(uploadDir(ctx), { recursive: true, mode: 0o700 });
  const busy = new Set<string>();
  const ownUpload = (id: string, userId: string) => {
    const u = db.prepare('SELECT * FROM uploads WHERE id = ? AND owner_id = ?').get(id, userId) as UploadRow | undefined;
    if (!u) throw notFound('upload_not_found');
    return u;
  };

  app.post('/api/chats/:id/uploads', async (req) => {
    const { user } = requireUser(ctx, req);
    const chatId = uploadTarget(ctx, (req.params as { id: string }).id, user.id);
    const size = Number((req.body as { size?: unknown })?.size);
    const maxMb = limits(ctx).maxFileMb;
    if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'invalid_input', '文件大小无效');
    if (size > ctSizeFor(maxMb * 1024 * 1024)) throw new HttpError(413, 'too_large', `文件不能超过 ${maxMb} MB`);
    const active = (db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE owner_id = ?').get(user.id) as { n: number }).n;
    if (active >= MAX_ACTIVE_UPLOADS) purgeStaleUploads(ctx);
    if ((db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE owner_id = ?').get(user.id) as { n: number }).n >= MAX_ACTIVE_UPLOADS)
      throw new HttpError(429, 'too_many_uploads', `同时最多上传 ${MAX_ACTIVE_UPLOADS} 个大文件`);
    const quota = userDailyQuota(ctx, user.id);
    if (usedToday(ctx, user.id) + size > quota) throw new HttpError(429, 'quota', `今天的上传额度（${Math.round(quota / 1024 / 1024)} MB）已用完`);
    const id = newId('u');
    fs.writeFileSync(uploadFile(ctx, id), Buffer.alloc(0), { mode: 0o600 });
    db.prepare('INSERT INTO uploads(id, chat_id, owner_id, size, received, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(id, chatId, user.id, size, now(), now());
    return { uploadId: id, partSize: PART_SIZE, received: 0 };
  });

  app.get('/api/uploads/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const u = ownUpload((req.params as { id: string }).id, user.id);
    return { uploadId: u.id, size: u.size, received: u.received, partSize: PART_SIZE };
  });

  /** Append one part. `offset` must be what the server already has (or less, to resend a part that was cut off). */
  app.put('/api/uploads/:id', { bodyLimit: PART_MAX }, async (req) => {
    const { user } = requireUser(ctx, req);
    const u = ownUpload((req.params as { id: string }).id, user.id);
    if (req.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, 'bad_type', '需要 application/octet-stream');
    const offset = Number((req.query as { offset?: string }).offset);
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > u.received) throw new HttpError(409, 'bad_offset', '上传位置不对', );
    if (!Number.isFinite(declared) || declared <= 0 || declared > PART_MAX || offset + declared > u.size) throw new HttpError(413, 'too_large', '分片大小不对');
    if (busy.has(u.id)) throw new HttpError(409, 'busy', '这个分片正在上传');
    busy.add(u.id);
    const file = uploadFile(ctx, u.id);
    try {
      await fs.promises.truncate(file, offset);
      let size = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > declared) cb(new HttpError(413, 'too_large', '分片大小不对'));
          else cb(null, chunk);
        },
      });
      try {
        // r+ never recreates a file that was removed meanwhile
        await pipeline(req.body as NodeJS.ReadableStream, counter, fs.createWriteStream(file, { flags: 'r+', start: offset }));
      } catch (e) {
        await fs.promises.truncate(file, offset).catch(() => undefined);
        db.prepare('UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?').run(offset, now(), u.id);
        throw e instanceof HttpError ? e : new HttpError(400, 'upload_failed', '上传中断');
      }
      if (size !== declared) {
        await fs.promises.truncate(file, offset);
        db.prepare('UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?').run(offset, now(), u.id);
        throw new HttpError(400, 'upload_failed', '分片不完整');
      }
      db.prepare('UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?').run(offset + size, now(), u.id);
      return { received: offset + size };
    } finally {
      busy.delete(u.id);
    }
  });

  app.post('/api/uploads/:id/finish', async (req) => {
    const { user } = requireUser(ctx, req);
    const u = ownUpload((req.params as { id: string }).id, user.id);
    if (busy.has(u.id)) throw new HttpError(409, 'busy', '还有分片正在上传');
    busy.add(u.id); // no part may be written between the size check and the rename
    try {
      if (u.received !== u.size) throw new HttpError(409, 'incomplete', '文件还没上传完');
      const st = await fs.promises.stat(uploadFile(ctx, u.id));
      if (st.size !== u.size) throw new HttpError(409, 'incomplete', '文件还没上传完');
      if (u.chat_id !== `self:${user.id}` && !db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(u.chat_id, user.id)) throw notFound('chat_not_found');
      const blobId = newId('b');
      await fs.promises.rename(uploadFile(ctx, u.id), blobFile(ctx, blobId));
      db.transaction(() => {
        db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
        db.prepare('INSERT INTO blobs(id, chat_id, owner_id, size, created_at) VALUES (?, ?, ?, ?, ?)').run(blobId, u.chat_id, user.id, u.size, now());
        logUsage(ctx, user.id, u.size);
      })();
      return { blobId, size: u.size };
    } finally {
      busy.delete(u.id);
    }
  });

  app.delete('/api/uploads/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const u = ownUpload((req.params as { id: string }).id, user.id);
    if (busy.has(u.id)) throw new HttpError(409, 'busy', '分片正在上传，请稍后再取消');
    db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
    unlinkQuiet(uploadFile(ctx, u.id));
    return { ok: true };
  });
}
