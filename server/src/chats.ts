import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireUser } from './auth.js';
import { applyMembership, membershipMessage, type Action, type Member, type Role } from './membership.js';
import { verifySig } from './sodium.js';
import { claimBlobs, removeChatExtras, removeMessageExtras } from './blobs.js';
import { notifyOffline } from './push.js';
import { dropFromCall, endCall } from './groupcall.js';
import { assertNotBlockedBy, directPeer, isBlockedBy, privacyOf } from './social.js';
import { visibleOnline } from './presence.js';
import { Buckets, HttpError, b64, bad, forbidden, int, newId, notFound, now, str } from './util.js';

// v0.7: per-user message flood guard (a burst of 120, then 2 per second)
const sendBuckets = new Buckets(120, 2);

interface ChatRow {
  id: string;
  type: 'direct' | 'group';
  title_ct: string | null;
  direct_key: string | null;
  created_by: string;
  current_epoch: number;
  needs_rotation: number;
  membership_version: number;
  disappearing_seconds: number;
  post_policy: 'all' | 'admins';
  last_seq: number;
  last_msg_at: number | null;
  created_at: number;
}
interface MemberRow {
  chat_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: number;
  joined_epoch: number;
  cleared_before_seq: number;
  last_read_seq: number;
  hidden: number;
  muted_until: number | null;
  notify_off_until: number | null;
}
interface MessageRow {
  id: string;
  chat_id: string;
  seq: number;
  sender_id: string;
  epoch: number;
  client_msg_id: string;
  nonce: string;
  ciphertext: string;
  signature: string;
  edited_at: number | null;
  expires_at: number | null;
  created_at: number;
}

export const MAX_GROUP = 100; // v0.9 (was 50); group calls keep their own, smaller limits
export const ROTATE_AFTER_MS = 7 * 86_400_000;
export const ROTATE_AFTER_MESSAGES = 1000;
const MAX_CT = 200_000; // ~150KB encrypted payload (text or attachment metadata incl. thumbnail)

export const msgOut = (m: MessageRow) => ({
  id: m.id,
  chatId: m.chat_id,
  seq: m.seq,
  senderId: m.sender_id,
  epoch: m.epoch,
  clientMsgId: m.client_msg_id,
  nonce: m.nonce,
  ciphertext: m.ciphertext,
  signature: m.signature,
  editedAt: m.edited_at,
  expiresAt: m.expires_at,
  createdAt: m.created_at,
});

export function memberIds(ctx: Ctx, chatId: string): string[] {
  return (ctx.db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY join_order').all(chatId) as { user_id: string }[]).map((r) => r.user_id);
}

/** Every user that shares at least one chat with `userId` (for presence fan-out). */
export function peersOf(ctx: Ctx, userId: string): string[] {
  return (
    ctx.db
      .prepare(
        'SELECT DISTINCT b.user_id FROM chat_members a JOIN chat_members b ON a.chat_id = b.chat_id WHERE a.user_id = ? AND b.user_id != ?',
      )
      .all(userId, userId) as { user_id: string }[]
  ).map((r) => r.user_id);
}

export function registerChats(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;

  const getChat = (id: string) => db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
  const getMember = (chatId: string, userId: string) =>
    db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId) as MemberRow | undefined;

  function requireMember(chatId: string, userId: string) {
    const chat = getChat(chatId);
    const member = chat && getMember(chatId, userId);
    if (!chat || !member) throw notFound('chat_not_found');
    return { chat, member };
  }

  /** Periodic re-keying (limits how much one leaked key can decrypt): the current key is > 7 days or > 1000 messages old. */
  function epochIsOld(chat: ChatRow) {
    const k = db.prepare('SELECT MIN(created_at) AS t FROM chat_keys WHERE chat_id = ? AND epoch = ?').get(chat.id, chat.current_epoch) as { t: number | null };
    if (k.t !== null && now() - k.t > ROTATE_AFTER_MS) return true;
    const n = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND epoch = ?').get(chat.id, chat.current_epoch) as { n: number }).n;
    return n >= ROTATE_AFTER_MESSAGES;
  }

  function chatView(chat: ChatRow, me: MemberRow, userId: string) {
    const myPrivacy = privacyOf(ctx, userId);
    const members = db
      .prepare(
        `SELECT m.user_id, m.role, m.last_read_seq, m.muted_until, u.username, u.display_name, u.deleted_at,
                CASE WHEN u.avatar_blob IS NULL THEN 0 ELSE u.avatar_v END AS avatar_v
         FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = ? ORDER BY m.join_order`,
      )
      .all(chat.id) as { user_id: string; role: string; last_read_seq: number; muted_until: number | null; username: string; display_name: string; deleted_at: number | null; avatar_v: number }[];
    const last = db
      .prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND seq > ?
           AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ? AND chat_id = ?)
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(chat.id, me.cleared_before_seq, userId, chat.id) as MessageRow | undefined;
    const unread = db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND seq > ? AND sender_id != ?
           AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ? AND chat_id = ?)`,
      )
      .get(chat.id, Math.max(me.last_read_seq, me.cleared_before_seq), userId, userId, chat.id) as { n: number };
    return {
      id: chat.id,
      type: chat.type,
      titleCt: chat.title_ct,
      currentEpoch: chat.current_epoch,
      needsRotation: !!chat.needs_rotation,
      rotateSoon: epochIsOld(chat),
      membershipVersion: chat.membership_version,
      pins: (db.prepare('SELECT message_id FROM pins WHERE chat_id = ? ORDER BY created_at DESC').all(chat.id) as { message_id: string }[]).map((p) => p.message_id),
      pendingJoins:
        me.role === 'member'
          ? 0
          : (db.prepare('SELECT COUNT(*) AS n FROM join_requests WHERE chat_id = ?').get(chat.id) as { n: number }).n,
      disappearingSeconds: chat.disappearing_seconds,
      postPolicy: chat.post_policy ?? 'all',
      lastSeq: chat.last_seq,
      lastMessageAt: chat.last_msg_at,
      createdAt: chat.created_at,
      myRole: me.role,
      myLastReadSeq: me.last_read_seq,
      clearedBeforeSeq: me.cleared_before_seq,
      notifyOffUntil: me.notify_off_until && (me.notify_off_until === -1 || me.notify_off_until > now()) ? me.notify_off_until : null,
      unread: unread.n,
      lastMessage: last ? msgOut(last) : null,
      members: members.map((m) => ({
        id: m.user_id,
        username: m.username,
        displayName: m.display_name,
        role: m.role,
        ...(m.deleted_at ? { deleted: true } : {}),
        ...(m.avatar_v ? { avatarV: m.avatar_v } : {}),
        // read receipts and online status are reciprocal privacy settings
        lastReadSeq: m.user_id === userId || (!myPrivacy.noReceipts && !privacyOf(ctx, m.user_id).noReceipts) ? m.last_read_seq : 0,
        mutedUntil: m.muted_until && m.muted_until > now() ? m.muted_until : null,
        online: m.user_id === userId ? (ctx.online.get(m.user_id) ?? 0) > 0 : !myPrivacy.hideOnline && !privacyOf(ctx, m.user_id).hideOnline && visibleOnline(ctx, m.user_id),
      })),
    };
  }

  function parseKeys(body: Record<string, unknown>, expectRecipients: string[]) {
    const raw = body.keys;
    if (!Array.isArray(raw)) throw bad('invalid_input', '缺少 keys');
    const keys = raw.map((k) => ({
      recipientId: str(k as Record<string, unknown>, 'recipientId', { max: 64 }),
      sealedKey: b64(k as Record<string, unknown>, 'sealedKey', 80), // 32B key + 48B seal overhead
      signature: b64(k as Record<string, unknown>, 'signature', 64),
    }));
    const got = new Set(keys.map((k) => k.recipientId));
    if (got.size !== keys.length || got.size !== expectRecipients.length || !expectRecipients.every((id) => got.has(id)))
      throw bad('keys_mismatch', '密钥分发包必须恰好覆盖所有成员');
    return keys;
  }

  function insertKeys(chatId: string, epoch: number, membershipVersion: number, distributorId: string, keys: ReturnType<typeof parseKeys>) {
    const ins = db.prepare(
      'INSERT INTO chat_keys(chat_id, epoch, recipient_id, membership_version, sealed_key, distributor_id, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const t = now();
    for (const k of keys) ins.run(chatId, epoch, k.recipientId, membershipVersion, k.sealedKey, distributorId, k.signature, t);
  }

  const signPkOf = (userId: string) => (db.prepare('SELECT sign_pk FROM user_keys WHERE user_id = ?').get(userId) as { sign_pk: string } | undefined)?.sign_pk;

  function membersOf(chatId: string): Member[] {
    return (db.prepare('SELECT user_id, role FROM chat_members WHERE chat_id = ? ORDER BY join_order').all(chatId) as { user_id: string; role: Role }[]).map((r) => ({
      id: r.user_id,
      role: r.role,
    }));
  }

  /** Validate a signed membership change against the server's view; returns the resulting member list. */
  function checkMembership(chatId: string, version: number, action: Action, actorId: string, targets: string[], role: string | null, signature: string, prev: Member[]) {
    const result = applyMembership(prev, action, actorId, targets, role);
    if (result.length > MAX_GROUP) throw bad('too_many_members', `群成员不能超过 ${MAX_GROUP} 人`);
    const pk = signPkOf(actorId);
    if (!pk || !verifySig(signature, membershipMessage(chatId, version, action, actorId, targets, role, result), pk))
      throw bad('bad_signature', '成员变更签名无效');
    return result;
  }

  function logMembership(chatId: string, version: number, action: Action, actorId: string, targets: string[], role: string | null, signature: string) {
    db.prepare('INSERT INTO membership_log(chat_id, version, action, actor_id, targets, role, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      chatId,
      version,
      action,
      actorId,
      JSON.stringify(targets),
      role,
      signature,
      now(),
    );
  }

  // ------------------------------------------------------------------ list
  app.get('/api/chats', async (req) => {
    const { user } = requireUser(ctx, req);
    const rows = db
      .prepare(
        `SELECT c.* FROM chats c JOIN chat_members m ON m.chat_id = c.id
         WHERE m.user_id = ? AND m.hidden = 0 ORDER BY COALESCE(c.last_msg_at, c.created_at) DESC`,
      )
      .all(user.id) as ChatRow[];
    return { chats: rows.map((c) => chatView(c, getMember(c.id, user.id)!, user.id)) };
  });

  app.get('/api/chats/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat, member } = requireMember((req.params as { id: string }).id, user.id);
    return { chat: chatView(chat, member, user.id) };
  });

  app.get('/api/chats/:id/membership', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat } = requireMember((req.params as { id: string }).id, user.id);
    const rows = db.prepare('SELECT * FROM membership_log WHERE chat_id = ? ORDER BY version').all(chat.id) as Record<string, unknown>[];
    return {
      log: rows.map((r) => ({
        version: r.version,
        action: r.action,
        actorId: r.actor_id,
        targets: JSON.parse(r.targets as string),
        role: r.role,
        signature: r.signature,
        createdAt: r.created_at,
      })),
    };
  });

  // ------------------------------------------------------------------ create
  /**
   * body: { id, type, peerId | memberIds, titleCt?, keys[], membershipSignature }
   * The creator signs membership version 1 and seals epoch 1 to every member.
   */
  app.post('/api/chats', async (req) => {
    const { user } = requireUser(ctx, req);
    const body = req.body as Record<string, unknown>;
    const type = str(body, 'type', { pattern: /^(direct|group)$/ }) as 'direct' | 'group';
    // The client picks the chat id so the initial key distribution can be signed over it.
    const id = str(body, 'id', { pattern: /^c_[A-Za-z0-9_-]{16,40}$/ });
    const t = now();

    let targets: string[];
    let directKey: string | null = null;
    if (type === 'direct') {
      const peerId = str(body, 'peerId', { max: 64 });
      if (peerId === user.id) throw bad('invalid_peer', '不能和自己发起私聊');
      directKey = [user.id, peerId].sort().join('|');
      const existing = db.prepare('SELECT * FROM chats WHERE direct_key = ?').get(directKey) as ChatRow | undefined;
      if (existing) {
        db.prepare('UPDATE chat_members SET hidden = 0 WHERE chat_id = ? AND user_id = ?').run(existing.id, user.id);
        return { chat: chatView(existing, getMember(existing.id, user.id)!, user.id), existing: true };
      }
      targets = [peerId];
    } else {
      const raw = body.memberIds;
      if (!Array.isArray(raw)) throw bad('invalid_input', '缺少 memberIds');
      targets = [...new Set(raw.map(String))].filter((x) => x !== user.id);
    }
    for (const uid of targets) if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL').get(uid)) throw notFound('user_not_found');
    assertNotBlockedBy(ctx, user.id, targets);
    const signature = b64(body, 'membershipSignature', 64);
    const members = checkMembership(id, 1, 'create', user.id, targets, type, signature, []);
    const keys = parseKeys(body, members.map((m) => m.id));
    const titleCt = type === 'group' ? str(body, 'titleCt', { max: 4000 }) : null;
    if (getChat(id)) throw new HttpError(409, 'id_taken');

    db.transaction(() => {
      db.prepare('INSERT INTO chats(id, type, title_ct, direct_key, created_by, created_at, last_msg_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id,
        type,
        titleCt,
        directKey,
        user.id,
        t,
        type === 'group' ? t : null,
      );
      const insM = db.prepare('INSERT INTO chat_members(chat_id, user_id, role, joined_at, join_order, hidden) VALUES (?, ?, ?, ?, ?, ?)');
      // a new direct chat appears for the peer once the first message arrives
      members.forEach((m, i) => insM.run(id, m.id, m.role, t, i, type === 'direct' && m.id !== user.id ? 1 : 0));
      logMembership(id, 1, 'create', user.id, targets, type, signature);
      insertKeys(id, 1, 1, user.id, keys);
    })();
    if (type === 'group') ctx.emitToUsers(targets, 'chat:new', { chatId: id });
    return { chat: chatView(getChat(id)!, getMember(id, user.id)!, user.id), existing: false };
  });

  // ------------------------------------------------------------------ update settings
  app.patch('/api/chats/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat, member } = requireMember((req.params as { id: string }).id, user.id);
    const body = req.body as Record<string, unknown>;
    const isAdmin = member.role === 'owner' || member.role === 'admin';
    if (chat.type === 'group' && !isAdmin && body.disappearingSeconds !== undefined) throw forbidden();
    assertNotBlockedInDirect(ctx, chat.id, user.id);
    if (body.disappearingSeconds !== undefined) {
      const s = int(body, 'disappearingSeconds', { min: 0, max: 7 * 86_400 });
      db.prepare('UPDATE chats SET disappearing_seconds = ? WHERE id = ?').run(s, chat.id);
    }
    if (body.postPolicy !== undefined) {
      if (chat.type !== 'group' || !isAdmin) throw forbidden();
      const p = str(body, 'postPolicy', { pattern: /^(all|admins)$/ });
      db.prepare('UPDATE chats SET post_policy = ? WHERE id = ?').run(p, chat.id);
    }
    if (body.titleCt !== undefined) {
      // the encrypted, admin-SIGNED settings record. Any member may re-encrypt the same record under a new epoch after a
      // rotation; only an admin can make a new valid one (clients verify the signature against the membership chain)
      db.prepare('UPDATE chats SET title_ct = ? WHERE id = ?').run(str(body, 'titleCt', { max: 4000 }), chat.id);
    }
    ctx.emitToUsers(memberIds(ctx, chat.id), 'chat:updated', { chatId: chat.id });
    return { chat: chatView(getChat(chat.id)!, member, user.id) };
  });

  /** Mute a group member (admins only; owners/admins can't be muted). until = 0 lifts it; -1 = until lifted. */
  app.put('/api/chats/:id/members/:uid/mute', async (req) => {
    const { user } = requireUser(ctx, req);
    const { id, uid } = req.params as { id: string; uid: string };
    const { chat, member } = requireMember(id, user.id);
    if (chat.type !== 'group' || member.role === 'member') throw forbidden();
    const target = getMember(chat.id, uid);
    if (!target) throw notFound();
    if (target.role !== 'member') throw bad('invalid_target', '不能禁言管理员');
    const until = int(req.body as Record<string, unknown>, 'until', { min: -1 });
    const value = until === 0 ? null : until === -1 ? 8_640_000_000_000_000 : until;
    if (value !== null && value <= now()) throw bad('invalid_time');
    db.prepare('UPDATE chat_members SET muted_until = ? WHERE chat_id = ? AND user_id = ?').run(value, chat.id, uid);
    ctx.emitToUsers(memberIds(ctx, chat.id), 'chat:updated', { chatId: chat.id });
    return { ok: true };
  });

  /** My own notification mute for a chat. until = 0 turns notifications back on; -1 = until turned back on. */
  app.put('/api/chats/:id/notify', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat } = requireMember((req.params as { id: string }).id, user.id);
    const until = int(req.body as Record<string, unknown>, 'until', { min: -1 });
    if (until > 0 && (until <= now() || until > now() + 400 * 86_400_000)) throw bad('invalid_time');
    db.prepare('UPDATE chat_members SET notify_off_until = ? WHERE chat_id = ? AND user_id = ?').run(until === 0 ? null : until, chat.id, user.id);
    ctx.emitToUsers([user.id], 'chat:updated', { chatId: chat.id });
    return { ok: true };
  });

  // ------------------------------------------------------------------ keys
  app.get('/api/chats/:id/keys', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat } = requireMember((req.params as { id: string }).id, user.id);
    const rows = db
      .prepare('SELECT epoch, membership_version, sealed_key, distributor_id, signature FROM chat_keys WHERE chat_id = ? AND recipient_id = ? ORDER BY epoch')
      .all(chat.id, user.id) as { epoch: number; membership_version: number; sealed_key: string; distributor_id: string; signature: string }[];
    return {
      keys: rows.map((r) => ({ epoch: r.epoch, membershipVersion: r.membership_version, sealedKey: r.sealed_key, distributorId: r.distributor_id, signature: r.signature })),
    };
  });

  /** Rotate to a new epoch without a membership change (after someone left, or periodic refresh). */
  app.post('/api/chats/:id/keys', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat } = requireMember((req.params as { id: string }).id, user.id);
    const body = req.body as Record<string, unknown>;
    const epoch = int(body, 'epoch', { min: 2 });
    const mv = int(body, 'membershipVersion', { min: 1 });
    if (epoch !== chat.current_epoch + 1 || mv !== chat.membership_version) throw new HttpError(409, 'epoch_conflict', '密钥纪元或成员版本已变化，请刷新');
    const members = memberIds(ctx, chat.id);
    const keys = parseKeys(body, members);
    const r = db.transaction(() => {
      const upd = db
        .prepare('UPDATE chats SET current_epoch = ?, needs_rotation = 0 WHERE id = ? AND current_epoch = ? AND membership_version = ?')
        .run(epoch, chat.id, chat.current_epoch, mv);
      if (!upd.changes) return false;
      insertKeys(chat.id, epoch, mv, user.id, keys);
      return true;
    })();
    if (!r) throw new HttpError(409, 'epoch_conflict', '密钥纪元已变化，请刷新');
    ctx.emitToUsers(members, 'key:rotated', { chatId: chat.id, epoch });
    return { ok: true, epoch };
  });

  // ------------------------------------------------------------------ membership changes (groups)
  /**
   * body: { version, action: add|remove|leave|role, targets[], role?, signature, epoch?, keys? }
   *  add / remove  → must include the rotation (epoch = current+1, keys for the resulting members): atomic
   *  leave         → no rotation (the leaver must not know the next key); chat waits for a remaining member to rotate
   *  role          → no rotation
   */
  app.post('/api/chats/:id/membership', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat } = requireMember((req.params as { id: string }).id, user.id);
    if (chat.type !== 'group') throw bad('not_group', '私聊的成员不能变更');
    const body = req.body as Record<string, unknown>;
    const version = int(body, 'version', { min: 2 });
    const action = str(body, 'action', { pattern: /^(add|remove|leave|role)$/ }) as Action;
    const rawTargets = body.targets;
    if (!Array.isArray(rawTargets) || rawTargets.length === 0 || rawTargets.length > MAX_GROUP) throw bad('invalid_input', '缺少 targets');
    const targets = rawTargets.map(String);
    const role = action === 'role' ? str(body, 'role', { pattern: /^(admin|member)$/ }) : null;
    const signature = b64(body, 'signature', 64);
    if (version !== chat.membership_version + 1) throw new HttpError(409, 'membership_conflict', '成员列表已变化，请刷新');
    if (action === 'add') {
      for (const uid of targets) if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL').get(uid)) throw notFound('user_not_found');
      assertNotBlockedBy(ctx, user.id, targets);
    }

    const prev = membersOf(chat.id);
    const result = checkMembership(chat.id, version, action, user.id, targets, role, signature, prev);
    const rotates = action === 'add' || action === 'remove';
    let keys: ReturnType<typeof parseKeys> = [];
    let epoch = chat.current_epoch;
    if (rotates) {
      epoch = int(body, 'epoch', { min: 2 });
      if (epoch !== chat.current_epoch + 1) throw new HttpError(409, 'epoch_conflict', '密钥纪元已变化，请刷新');
      keys = parseKeys(body, result.map((m) => m.id));
    }

    const t = now();
    const ok = db.transaction(() => {
      const upd = db
        .prepare(
          `UPDATE chats SET membership_version = ?, current_epoch = ?, needs_rotation = ? WHERE id = ? AND membership_version = ? AND current_epoch = ?`,
        )
        .run(version, epoch, action === 'leave' ? 1 : rotates ? 0 : chat.needs_rotation, chat.id, chat.membership_version, chat.current_epoch);
      if (!upd.changes) return false;
      const prevIds = new Set(prev.map((m) => m.id));
      const resIds = new Set(result.map((m) => m.id));
      const maxOrder = (db.prepare('SELECT COALESCE(MAX(join_order), 0) AS n FROM chat_members WHERE chat_id = ?').get(chat.id) as { n: number }).n;
      let order = maxOrder;
      for (const m of result) {
        if (!prevIds.has(m.id)) {
          // new members start with an empty history
          db.prepare(
            'INSERT INTO chat_members(chat_id, user_id, role, joined_at, joined_epoch, join_order, cleared_before_seq, last_read_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(chat.id, m.id, m.role, t, epoch, ++order, chat.last_seq, chat.last_seq);
        } else db.prepare('UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ?').run(m.role, chat.id, m.id);
      }
      for (const m of prev)
        if (!resIds.has(m.id)) {
          db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chat.id, m.id);
          db.prepare('DELETE FROM message_hidden WHERE chat_id = ? AND user_id = ?').run(chat.id, m.id);
          db.prepare('DELETE FROM scheduled_messages WHERE chat_id = ? AND sender_id = ?').run(chat.id, m.id);
          db.prepare('DELETE FROM drafts WHERE chat_id = ? AND user_id = ?').run(chat.id, m.id);
        }
      db.prepare(`DELETE FROM join_requests WHERE chat_id = ? AND user_id IN (${targets.map(() => '?').join(',')})`).run(chat.id, ...targets);
      logMembership(chat.id, version, action, user.id, targets, role, signature);
      if (rotates) insertKeys(chat.id, epoch, version, user.id, keys);
      return true;
    })();
    if (!ok) throw new HttpError(409, 'membership_conflict', '成员列表已变化，请刷新');

    const removed = prev.filter((m) => !result.some((r) => r.id === m.id)).map((m) => m.id);
    for (const u of removed) dropFromCall(ctx, chat.id, u);
    const added = result.filter((m) => !prev.some((p) => p.id === m.id)).map((m) => m.id);
    const now_ = result.map((m) => m.id);
    ctx.emitToUsers(removed, 'chat:deleted', { chatId: chat.id });
    ctx.emitToUsers(added, 'chat:new', { chatId: chat.id });
    ctx.emitToUsers(now_, 'chat:updated', { chatId: chat.id });
    if (rotates) ctx.emitToUsers(now_, 'key:rotated', { chatId: chat.id, epoch });
    if (action === 'leave') {
      if (result.length === 0) {
        removeChatExtras(ctx, chat.id);
        db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
      }
      else ctx.emitToUsers(now_, 'key:needed', { chatId: chat.id });
    }
    return { ok: true, version, epoch };
  });

  // ------------------------------------------------------------------ join requests (from group invite links)
  app.get('/api/chats/:id/join-requests', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat, member } = requireMember((req.params as { id: string }).id, user.id);
    if (member.role === 'member') throw forbidden();
    const rows = db
      .prepare(
        `SELECT j.user_id, j.auto_approve, j.created_at, u.username, u.display_name FROM join_requests j JOIN users u ON u.id = j.user_id
         WHERE j.chat_id = ? AND u.disabled_at IS NULL ORDER BY j.created_at`,
      )
      .all(chat.id) as { user_id: string; auto_approve: number; created_at: number; username: string; display_name: string }[];
    return {
      requests: rows.map((r) => ({ userId: r.user_id, username: r.username, displayName: r.display_name, autoApprove: !!r.auto_approve, createdAt: r.created_at })),
    };
  });

  app.delete('/api/chats/:id/join-requests/:uid', async (req) => {
    const { user } = requireUser(ctx, req);
    const { id, uid } = req.params as { id: string; uid: string };
    const { member } = requireMember(id, user.id);
    if (member.role === 'member' && uid !== user.id) throw forbidden();
    db.prepare('DELETE FROM join_requests WHERE chat_id = ? AND user_id = ?').run(id, uid);
    ctx.emitToUsers([uid], 'join:rejected', { chatId: id });
    return { ok: true };
  });

  // ------------------------------------------------------------------ messages
  app.get('/api/chats/:id/messages', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat, member } = requireMember((req.params as { id: string }).id, user.id);
    const q = req.query as Record<string, unknown>;
    const before = int(q, 'before', { min: 1, optional: true }) || chat.last_seq + 1;
    const limit = int(q, 'limit', { min: 1, max: 100, def: 50 });
    // media=1: only messages that carry attachments (the "shared media" page) — the server knows *that* a message has
    // a file, never what it is
    const mediaOnly = q.media === '1' ? 'AND EXISTS (SELECT 1 FROM blobs b WHERE b.message_id = messages.id)' : '';
    const rows = db
      .prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND seq > ? AND seq < ? ${mediaOnly}
           AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ? AND chat_id = ?)
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(chat.id, member.cleared_before_seq, before, user.id, chat.id, limit) as MessageRow[];
    return { messages: withReactions(rows.reverse()), hasMore: rows.length === limit };
  });

  app.post('/api/chats/:id/messages', async (req) => {
    const { user } = requireUser(ctx, req);
    if (!sendBuckets.take(user.id)) throw new HttpError(429, 'slow_down', '发送太频繁，请稍后再试');
    const { chat } = requireMember((req.params as { id: string }).id, user.id);
    const body = req.body as Record<string, unknown>;
    const clientMsgId = str(body, 'clientMsgId', { pattern: /^[A-Za-z0-9_-]{22}$/ }); // 128-bit random
    const epoch = int(body, 'epoch', { min: 1 });
    const nonce = b64(body, 'nonce', 24);
    const ciphertext = b64(body, 'ciphertext', undefined, MAX_CT);
    const signature = b64(body, 'signature', 64);
    const rawBlobs = body.blobIds ?? [];
    if (!Array.isArray(rawBlobs) || rawBlobs.length > 10) throw bad('invalid_input', '附件最多 10 个');
    const blobIds = rawBlobs.map((b) => String(b));
    // v0.9: this one message deletes itself after `ttl` seconds (the shorter of this and the chat's timer wins)
    const ttl = body.ttl === undefined || body.ttl === null ? 0 : int(body, 'ttl', { min: 30, max: 7 * 86_400 });

    const dup = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND sender_id = ? AND client_msg_id = ?').get(chat.id, user.id, clientMsgId) as
      | MessageRow
      | undefined;
    if (dup) return { message: msgOut(dup) };
    if (chat.needs_rotation) throw new HttpError(409, 'rotation_required', '成员已变化，需要先轮换密钥');
    if (epoch !== chat.current_epoch) throw new HttpError(409, 'epoch_stale', '密钥纪元已变化，请刷新');
    assertCanPost(ctx, chat.id, user.id);

    const msg = insertMessage(ctx, chat.id, user.id, { epoch, clientMsgId, nonce, ciphertext, signature, blobIds, ttl });
    return { message: msgOut(msg) };
  });

  app.patch('/api/messages/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get((req.params as { id: string }).id) as MessageRow | undefined;
    if (!m || !getMember(m.chat_id, user.id)) throw notFound();
    if (m.sender_id !== user.id) throw forbidden('not_sender');
    assertCanPost(ctx, m.chat_id, user.id); // an edit is new content: blocked / muted / admins-only apply
    const body = req.body as Record<string, unknown>;
    const nonce = b64(body, 'nonce', 24);
    const ciphertext = b64(body, 'ciphertext', undefined, MAX_CT);
    const signature = b64(body, 'signature', 64);
    db.prepare('UPDATE messages SET nonce = ?, ciphertext = ?, signature = ?, edited_at = ? WHERE id = ?').run(nonce, ciphertext, signature, now(), m.id);
    const updated = msgOut(db.prepare('SELECT * FROM messages WHERE id = ?').get(m.id) as MessageRow);
    ctx.emitToUsers(memberIds(ctx, m.chat_id), 'msg:edited', updated);
    return { message: updated };
  });

  /**
   * Delete messages.
   *  scope=me       → hidden only for the caller (the other side still sees them)
   *  scope=everyone → physically removed for all members.
   *                   direct chat: either side may remove ANY message (unilateral, no time limit)
   *                   group: own messages, or any message if caller is owner/admin
   */
  app.post('/api/messages/delete', async (req) => {
    const { user } = requireUser(ctx, req);
    const body = req.body as Record<string, unknown>;
    const scope = str(body, 'scope', { pattern: /^(me|everyone)$/ });
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) throw bad('invalid_input');
    const rows = ids
      .map((id) => db.prepare('SELECT * FROM messages WHERE id = ?').get(String(id)) as MessageRow | undefined)
      .filter((m): m is MessageRow => !!m);
    const byChat = new Map<string, MessageRow[]>();
    for (const m of rows) byChat.set(m.chat_id, [...(byChat.get(m.chat_id) ?? []), m]);

    for (const [chatId, msgs] of byChat) {
      const { chat, member } = requireMember(chatId, user.id);
      if (scope === 'me') {
        const ins = db.prepare('INSERT OR IGNORE INTO message_hidden(user_id, message_id, chat_id, hidden_at) VALUES (?, ?, ?, ?)');
        const t = now();
        db.transaction(() => msgs.forEach((m) => ins.run(user.id, m.id, chatId, t)))();
        ctx.emitToUsers([user.id], 'msg:deleted', { chatId, ids: msgs.map((m) => m.id) });
        continue;
      }
      const isAdmin = member.role === 'owner' || member.role === 'admin';
      if (chat.type === 'group' && !isAdmin && msgs.some((m) => m.sender_id !== user.id)) throw forbidden('not_allowed');
      deleteMessagesForEveryone(ctx, chatId, msgs);
    }
    return { ok: true, deleted: rows.length };
  });

  app.post('/api/chats/:id/read', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat, member } = requireMember((req.params as { id: string }).id, user.id);
    const seq = Math.min(int(req.body as Record<string, unknown>, 'seq', { min: 0 }), chat.last_seq);
    if (seq > member.last_read_seq) {
      db.prepare('UPDATE chat_members SET last_read_seq = ? WHERE chat_id = ? AND user_id = ?').run(seq, chat.id, user.id);
      const members = memberIds(ctx, chat.id);
      const share = !privacyOf(ctx, user.id).noReceipts;
      ctx.emitToUsers(
        members.filter((m) => m === user.id || (share && !privacyOf(ctx, m).noReceipts)),
        'receipt',
        { chatId: chat.id, userId: user.id, seq },
      );
    }
    return { ok: true };
  });

  /** Clear history: scope=me (only my side) or scope=everyone (both sides, physically deleted). */
  app.post('/api/chats/:id/clear', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat, member } = requireMember((req.params as { id: string }).id, user.id);
    const scope = str(req.body as Record<string, unknown>, 'scope', { pattern: /^(me|everyone)$/ });
    if (scope === 'me') {
      db.prepare('UPDATE chat_members SET cleared_before_seq = ?, last_read_seq = MAX(last_read_seq, ?) WHERE chat_id = ? AND user_id = ?').run(
        chat.last_seq,
        chat.last_seq,
        chat.id,
        user.id,
      );
      ctx.emitToUsers([user.id], 'chat:cleared', { chatId: chat.id, beforeSeq: chat.last_seq });
      return { ok: true };
    }
    if (chat.type === 'group' && member.role === 'member') throw forbidden();
    clearForEveryone(ctx, chat.id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ single message, reactions, pins
  function withReactions(rows: MessageRow[]) {
    if (!rows.length) return [];
    const q = rows.map(() => '?').join(',');
    const group = (table: 'reactions' | 'poll_votes') => {
      const rs = db.prepare(`SELECT * FROM ${table} WHERE message_id IN (${q})`).all(...rows.map((r) => r.id)) as Record<string, unknown>[];
      const by = new Map<string, unknown[]>();
      for (const r of rs)
        by.set(r.message_id as string, [
          ...(by.get(r.message_id as string) ?? []),
          { userId: r.user_id, epoch: r.epoch, nonce: r.nonce, ciphertext: r.ciphertext, signature: r.signature },
        ]);
      return by;
    };
    const reactions = group('reactions');
    const votes = group('poll_votes');
    return rows.map((m) => ({ ...msgOut(m), reactions: reactions.get(m.id) ?? [], votes: votes.get(m.id) ?? [] }));
  }

  /** A message the caller may see (used for pinned messages and reply previews that aren't loaded). */
  function visibleMessage(messageId: string, userId: string) {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined;
    const member = m && getMember(m.chat_id, userId);
    if (!m || !member || m.seq <= member.cleared_before_seq) throw notFound();
    if (db.prepare('SELECT 1 FROM message_hidden WHERE user_id = ? AND message_id = ?').get(userId, m.id)) throw notFound();
    return { m, member };
  }

  app.get('/api/messages/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const { m } = visibleMessage((req.params as { id: string }).id, user.id);
    return { message: withReactions([m])[0] };
  });

  app.put('/api/messages/:id/reaction', async (req) => {
    const { user } = requireUser(ctx, req);
    const { m } = visibleMessage((req.params as { id: string }).id, user.id);
    assertNotBlockedInDirect(ctx, m.chat_id, user.id);
    const body = req.body as Record<string, unknown>;
    const epoch = int(body, 'epoch', { min: 1 });
    const nonce = b64(body, 'nonce', 24);
    const ciphertext = b64(body, 'ciphertext', undefined, 600);
    const signature = b64(body, 'signature', 64);
    db.prepare(
      `INSERT INTO reactions(message_id, chat_id, user_id, epoch, nonce, ciphertext, signature, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, user_id) DO UPDATE SET epoch = excluded.epoch, nonce = excluded.nonce, ciphertext = excluded.ciphertext,
         signature = excluded.signature, updated_at = excluded.updated_at`,
    ).run(m.id, m.chat_id, user.id, epoch, nonce, ciphertext, signature, now());
    const reaction = { userId: user.id, epoch, nonce, ciphertext, signature };
    ctx.emitToUsers(memberIds(ctx, m.chat_id), 'reaction', { chatId: m.chat_id, messageId: m.id, userId: user.id, reaction });
    return { ok: true };
  });

  app.delete('/api/messages/:id/reaction', async (req) => {
    const { user } = requireUser(ctx, req);
    const { m } = visibleMessage((req.params as { id: string }).id, user.id);
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ?').run(m.id, user.id);
    ctx.emitToUsers(memberIds(ctx, m.chat_id), 'reaction', { chatId: m.chat_id, messageId: m.id, userId: user.id, reaction: null });
    return { ok: true };
  });

  // poll votes: same shape as reactions (encrypted + signed by the voter; the server can't read them)
  app.put('/api/messages/:id/vote', async (req) => {
    const { user } = requireUser(ctx, req);
    const { m } = visibleMessage((req.params as { id: string }).id, user.id);
    assertNotBlockedInDirect(ctx, m.chat_id, user.id);
    const body = req.body as Record<string, unknown>;
    const epoch = int(body, 'epoch', { min: 1 });
    const nonce = b64(body, 'nonce', 24);
    const ciphertext = b64(body, 'ciphertext', undefined, 600);
    const signature = b64(body, 'signature', 64);
    db.prepare(
      `INSERT INTO poll_votes(message_id, chat_id, user_id, epoch, nonce, ciphertext, signature, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, user_id) DO UPDATE SET epoch = excluded.epoch, nonce = excluded.nonce, ciphertext = excluded.ciphertext,
         signature = excluded.signature, updated_at = excluded.updated_at`,
    ).run(m.id, m.chat_id, user.id, epoch, nonce, ciphertext, signature, now());
    const vote = { userId: user.id, epoch, nonce, ciphertext, signature };
    ctx.emitToUsers(memberIds(ctx, m.chat_id), 'vote', { chatId: m.chat_id, messageId: m.id, userId: user.id, vote });
    return { ok: true };
  });

  app.delete('/api/messages/:id/vote', async (req) => {
    const { user } = requireUser(ctx, req);
    const { m } = visibleMessage((req.params as { id: string }).id, user.id);
    db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(m.id, user.id);
    ctx.emitToUsers(memberIds(ctx, m.chat_id), 'vote', { chatId: m.chat_id, messageId: m.id, userId: user.id, vote: null });
    return { ok: true };
  });

  /** Pin / unpin. Direct chats: either side. Groups: owner/admin. */
  app.post('/api/chats/:id/pins', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat, member } = requireMember((req.params as { id: string }).id, user.id);
    if (chat.type === 'group' && member.role === 'member') throw forbidden();
    const messageId = str(req.body as Record<string, unknown>, 'messageId', { max: 64 });
    const { m } = visibleMessage(messageId, user.id);
    if (m.chat_id !== chat.id) throw notFound();
    db.prepare('INSERT OR IGNORE INTO pins(chat_id, message_id, pinned_by, created_at) VALUES (?, ?, ?, ?)').run(chat.id, m.id, user.id, now());
    ctx.emitToUsers(memberIds(ctx, chat.id), 'chat:updated', { chatId: chat.id });
    return { ok: true };
  });

  app.delete('/api/chats/:id/pins/:mid', async (req) => {
    const { user } = requireUser(ctx, req);
    const { id, mid } = req.params as { id: string; mid: string };
    const { chat, member } = requireMember(id, user.id);
    if (chat.type === 'group' && member.role === 'member') throw forbidden();
    db.prepare('DELETE FROM pins WHERE chat_id = ? AND message_id = ?').run(chat.id, mid);
    ctx.emitToUsers(memberIds(ctx, chat.id), 'chat:updated', { chatId: chat.id });
    return { ok: true };
  });

  /** Delete a chat. forEveryone=1: direct → either side; group → owner only (dissolves the group). */
  app.delete('/api/chats/:id', async (req) => {
    const { user } = requireUser(ctx, req);
    const { chat, member } = requireMember((req.params as { id: string }).id, user.id);
    const forEveryone = String((req.query as Record<string, unknown>).forEveryone ?? '') === '1';
    const members = memberIds(ctx, chat.id);
    if (forEveryone) {
      if (chat.type === 'group' && member.role !== 'owner') throw forbidden();
      db.prepare('DELETE FROM message_hidden WHERE chat_id = ?').run(chat.id);
      removeChatExtras(ctx, chat.id);
      db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id); // cascades members, keys, messages
      db.prepare('DELETE FROM invites WHERE chat_id = ?').run(chat.id);
      ctx.emitToUsers(members, 'chat:deleted', { chatId: chat.id });
      endCall(ctx, chat.id, members);
      return { ok: true };
    }
    if (chat.type === 'group') {
      throw bad('use_membership', '退出群组需要签名的退出记录：POST /api/chats/:id/membership');
    } else {
      db.prepare('UPDATE chat_members SET cleared_before_seq = ?, last_read_seq = ?, hidden = 1 WHERE chat_id = ? AND user_id = ?').run(
        chat.last_seq,
        chat.last_seq,
        chat.id,
        user.id,
      );
      ctx.emitToUsers([user.id], 'chat:deleted', { chatId: chat.id });
    }
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// shared helpers (also used by invites + expiry job)
// ---------------------------------------------------------------------------
export function deleteMessagesForEveryone(ctx: Ctx, chatId: string, msgs: { id: string; seq: number }[]) {
  if (msgs.length === 0) return;
  const t = now();
  ctx.db.transaction(() => {
    const tomb = ctx.db.prepare('INSERT OR IGNORE INTO message_tombstones(id, chat_id, seq, deleted_at) VALUES (?, ?, ?, ?)');
    const del = ctx.db.prepare('DELETE FROM messages WHERE id = ?');
    const unhide = ctx.db.prepare('DELETE FROM message_hidden WHERE message_id = ?');
    for (const m of msgs) {
      tomb.run(m.id, chatId, m.seq, t);
      del.run(m.id);
      unhide.run(m.id);
    }
    removeMessageExtras(ctx, msgs.map((m) => m.id));
  })();
  ctx.emitToUsers(memberIds(ctx, chatId), 'msg:deleted', { chatId, ids: msgs.map((m) => m.id) });
}

export function clearForEveryone(ctx: Ctx, chatId: string) {
  const t = now();
  ctx.db.transaction(() => {
    ctx.db.prepare('INSERT OR IGNORE INTO message_tombstones(id, chat_id, seq, deleted_at) SELECT id, chat_id, seq, ? FROM messages WHERE chat_id = ?').run(t, chatId);
    ctx.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
    ctx.db.prepare('DELETE FROM message_hidden WHERE chat_id = ?').run(chatId);
    removeChatExtras(ctx, chatId, false);
  })();
  const c = ctx.db.prepare('SELECT last_seq FROM chats WHERE id = ?').get(chatId) as { last_seq: number };
  ctx.emitToUsers(memberIds(ctx, chatId), 'chat:cleared', { chatId, beforeSeq: c.last_seq });
}

/** Blocked by the other side of a direct chat, muted, or an admins-only group → the message can't be posted. */
export function assertNotBlockedInDirect(ctx: Ctx, chatId: string, userId: string) {
  const peer = directPeer(ctx, chatId, userId);
  if (peer && isBlockedBy(ctx, userId, peer)) throw new HttpError(403, 'blocked', '对方已拒收你的消息');
}

export function assertCanPost(ctx: Ctx, chatId: string, userId: string) {
  const peer = directPeer(ctx, chatId, userId);
  if (peer && isBlockedBy(ctx, userId, peer)) throw new HttpError(403, 'blocked', '消息无法送达：对方已拒收你的消息');
  if (peer && (ctx.db.prepare('SELECT deleted_at FROM users WHERE id = ?').get(peer) as { deleted_at: number | null } | undefined)?.deleted_at)
    throw new HttpError(403, 'peer_deleted', '对方已注销账号，无法再发送消息');
  const m = ctx.db
    .prepare('SELECT m.role, m.muted_until, c.type, c.post_policy FROM chat_members m JOIN chats c ON c.id = m.chat_id WHERE m.chat_id = ? AND m.user_id = ?')
    .get(chatId, userId) as { role: string; muted_until: number | null; type: string; post_policy: string } | undefined;
  if (!m || m.type !== 'group' || m.role !== 'member') return;
  if (m.post_policy === 'admins') throw new HttpError(403, 'admins_only', '本群只有管理员可以发言');
  if (m.muted_until && m.muted_until > now()) throw new HttpError(403, 'muted', '你已被管理员禁言');
}

/** Insert a (client-encrypted) message, fan it out and push-notify offline members. */
export function insertMessage(
  ctx: Ctx,
  chatId: string,
  senderId: string,
  m: { epoch: number; clientMsgId: string; nonce: string; ciphertext: string; signature: string; blobIds?: string[]; ttl?: number },
): MessageRow {
  const db = ctx.db;
  const members = memberIds(ctx, chatId);
  const msg = db.transaction(() => {
    const c = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as ChatRow;
    const seq = c.last_seq + 1;
    const t = now();
    const id = newId('m');
    const timers = [c.disappearing_seconds, m.ttl ?? 0].filter((x) => x > 0);
    const expiresAt = timers.length ? t + Math.min(...timers) * 1000 : null;
    db.prepare(
      `INSERT INTO messages(id, chat_id, seq, sender_id, epoch, client_msg_id, nonce, ciphertext, signature, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, chatId, seq, senderId, m.epoch, m.clientMsgId, m.nonce, m.ciphertext, m.signature, expiresAt, t);
    if (m.blobIds?.length) claimBlobs(ctx, chatId, senderId, id, m.blobIds);
    db.prepare('UPDATE chats SET last_seq = ?, last_msg_at = ? WHERE id = ?').run(seq, t, chatId);
    db.prepare('UPDATE chat_members SET hidden = 0 WHERE chat_id = ?').run(chatId);
    db.prepare('UPDATE chat_members SET last_read_seq = ? WHERE chat_id = ? AND user_id = ?').run(seq, chatId, senderId);
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow;
  })();
  ctx.emitToUsers(members, 'msg:new', msgOut(msg));
  const t2 = now();
  const quiet = new Set(
    (ctx.db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND (notify_off_until = -1 OR notify_off_until > ?)').all(chatId, t2) as { user_id: string }[]).map((r) => r.user_id),
  );
  notifyOffline(ctx, members.filter((u) => u !== senderId && !quiet.has(u)));
  return msg;
}

/** Disappearing messages: physically delete everything past its expiry. */
export function purgeExpired(ctx: Ctx) {
  const rows = ctx.db.prepare('SELECT id, chat_id, seq FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?').all(now()) as {
    id: string;
    chat_id: string;
    seq: number;
  }[];
  const byChat = new Map<string, { id: string; seq: number }[]>();
  for (const r of rows) byChat.set(r.chat_id, [...(byChat.get(r.chat_id) ?? []), r]);
  for (const [chatId, msgs] of byChat) deleteMessagesForEveryone(ctx, chatId, msgs);
}
