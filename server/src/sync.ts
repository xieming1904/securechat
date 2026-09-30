/**
 * Lets a client keep its local (encrypted) search cache honest: everything removed since `since`
 * — deleted for everyone, disappeared, or hidden "for me" — is reported so the cache drops it too.
 */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireUser } from './auth.js';
import { int, now } from './util.js';

export function registerSync(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/sync/removed', async (req) => {
    const { user } = requireUser(ctx, req);
    const since = int(req.query as Record<string, unknown>, 'since', { min: 0, def: 0 });
    const t = now();
    const tomb = ctx.db
      .prepare(
        `SELECT t.id, t.chat_id FROM message_tombstones t JOIN chat_members m ON m.chat_id = t.chat_id AND m.user_id = ?
         WHERE t.deleted_at >= ? LIMIT 20000`,
      )
      .all(user.id, since) as { id: string; chat_id: string }[];
    const hidden = ctx.db
      .prepare('SELECT message_id AS id, chat_id FROM message_hidden WHERE user_id = ? AND hidden_at >= ? LIMIT 20000')
      .all(user.id, since) as { id: string; chat_id: string }[];
    return { now: t, removed: [...tomb, ...hidden].map((r) => ({ chatId: r.chat_id, id: r.id })) };
  });
}
