import type { Server as IOServer } from 'socket.io';
import type { AppConfig } from './config.js';
import type { DB } from './db.js';
import type { PushSender } from './push.js';

export interface Ctx {
  db: DB;
  config: AppConfig;
  io?: IOServer;
  /** userId -> number of live sockets */
  online: Map<string, number>;
  emitToUsers(userIds: string[], event: string, data: unknown): void;
  emitAdmins(event: string, data: unknown): void;
  disconnectSession(sessionId: string): void;
  disconnectUser(userId: string): void;
  /** replaceable in tests */
  sendPush?: PushSender;
}

export function createCtx(db: DB, config: AppConfig): Ctx {
  const ctx: Ctx = {
    db,
    config,
    online: new Map(),
    emitToUsers(userIds, event, data) {
      if (!ctx.io || userIds.length === 0) return;
      ctx.io.to(userIds.map((id) => `u:${id}`)).emit(event, data);
    },
    emitAdmins(event, data) {
      ctx.io?.to('admins').emit(event, data);
    },
    disconnectSession(sessionId) {
      ctx.io?.in(`s:${sessionId}`).disconnectSockets(true);
    },
    disconnectUser(userId) {
      ctx.io?.in(`u:${userId}`).disconnectSockets(true);
    },
  };
  return ctx;
}
