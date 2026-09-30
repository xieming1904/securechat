/**
 * Group calls (v0.5): a small mesh — every participant connects directly to every other one (WebRTC, DTLS-SRTP),
 * so media stays end-to-end encrypted with no media server. This module only keeps the in-memory "room"
 * (who is in the call, per group chat) and relays the encrypted, signed signalling between participants.
 * The server learns who joined a call and when; never what was said.
 */
import type { Server as IOServer, Socket } from 'socket.io';
import crypto from 'node:crypto';
import type { Ctx } from './context.js';
import { memberIds } from './chats.js';

export const MAX_AUDIO = 8;
export const MAX_VIDEO = 6;

interface Room {
  callId: string;
  chatId: string;
  video: boolean;
  startedAt: number;
  startedBy: string;
  /** userId → socket id of the one device that is in the call */
  members: Map<string, string>;
}
const rooms = new Map<string, Room>();

export function roomState(chatId: string) {
  const r = rooms.get(chatId);
  return r ? { chatId, callId: r.callId, video: r.video, startedAt: r.startedAt, startedBy: r.startedBy, participants: [...r.members.keys()] } : { chatId, callId: null, participants: [] };
}
/** tests */
export const _rooms = rooms;

function isGroupMember(ctx: Ctx, chatId: string, userId: string) {
  const chat = ctx.db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId) as { type: string } | undefined;
  return chat?.type === 'group' && memberIds(ctx, chatId).includes(userId);
}

function broadcast(ctx: Ctx, chatId: string) {
  ctx.emitToUsers(memberIds(ctx, chatId), 'gcall:state', roomState(chatId));
}

function leave(ctx: Ctx, chatId: string, userId: string, socketId?: string) {
  const r = rooms.get(chatId);
  if (!r || !r.members.has(userId)) return;
  if (socketId && r.members.get(userId) !== socketId) return; // another device of mine is the one in the call
  r.members.delete(userId);
  if (r.members.size === 0) rooms.delete(chatId);
  broadcast(ctx, chatId);
}

/** The group was dissolved: the call ends for everyone. */
export function endCall(ctx: Ctx, chatId: string, formerMembers: string[]) {
  if (!rooms.delete(chatId)) return;
  ctx.emitToUsers(formerMembers, 'gcall:state', { chatId, callId: null, participants: [] });
}

/** Someone was removed from a group (or left it): drop them from its call. */
export function dropFromCall(ctx: Ctx, chatId: string, userId: string) {
  leave(ctx, chatId, userId);
}

export function attachGroupCalls(io: IOServer, ctx: Ctx) {
  return (socket: Socket) => {
    const userId: string = socket.data.userId;
    // calls going on in my groups right now
    for (const r of rooms.values()) if (memberIds(ctx, r.chatId).includes(userId)) socket.emit('gcall:state', roomState(r.chatId));

    // join/leave each broadcast to the whole group: 30 per minute per connection is plenty for people
    let joins = 0;
    const joinReset = setInterval(() => (joins = 0), 60_000);
    socket.on('gcall:join', (data: { chatId?: unknown; video?: unknown }, ack?: (r: unknown) => void) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      if (++joins > 30) return reply({ error: 'rate_limited' });
      if (typeof data?.chatId !== 'string' || !isGroupMember(ctx, data.chatId, userId)) return reply({ error: 'not_member' });
      let r = rooms.get(data.chatId);
      if (!r) {
        r = { callId: crypto.randomBytes(12).toString('base64url'), chatId: data.chatId, video: data.video === true, startedAt: Date.now(), startedBy: userId, members: new Map() };
        rooms.set(data.chatId, r);
      }
      const cap = r.video ? MAX_VIDEO : MAX_AUDIO;
      if (!r.members.has(userId) && r.members.size >= cap) return reply({ error: 'full', max: cap });
      // one device per person: joining from here takes over from my other device
      const prev = r.members.get(userId);
      if (prev && prev !== socket.id) io.to(prev).emit('gcall:replaced', { chatId: r.chatId, callId: r.callId });
      const others = [...r.members.keys()].filter((u) => u !== userId);
      r.members.set(userId, socket.id);
      reply({ callId: r.callId, video: r.video, startedAt: r.startedAt, others });
      broadcast(ctx, r.chatId);
    });

    socket.on('gcall:leave', (data: { chatId?: unknown }) => {
      if (++joins > 30) return;
      if (typeof data?.chatId === 'string') leave(ctx, data.chatId, userId, socket.id);
    });

    let signals = 0;
    const reset = setInterval(() => (signals = 0), 60_000);
    socket.on('gcall:signal', (data: { chatId?: unknown; to?: unknown; env?: unknown }) => {
      if (++signals > 600) return;
      if (typeof data?.chatId !== 'string' || typeof data.to !== 'string' || !data.env || typeof data.env !== 'object') return;
      if (JSON.stringify(data.env).length > 64 * 1024) return;
      const r = rooms.get(data.chatId);
      // only between two people who are both in this call right now (and still members of the group)
      if (!r || r.members.get(userId) !== socket.id || !r.members.has(data.to) || data.to === userId) return;
      if (!isGroupMember(ctx, data.chatId, userId) || !isGroupMember(ctx, data.chatId, data.to)) return;
      io.to(r.members.get(data.to)!).emit('gcall:signal', { chatId: data.chatId, from: userId, env: data.env });
    });

    socket.on('disconnect', () => {
      clearInterval(reset);
      clearInterval(joinReset);
      for (const r of [...rooms.values()]) if (r.members.get(userId) === socket.id) leave(ctx, r.chatId, userId, socket.id);
    });
  };
}
