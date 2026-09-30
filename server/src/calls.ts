/**
 * ICE servers for WebRTC calls. With coturn configured (ops/install-coturn.sh) we hand out short-lived TURN
 * credentials (coturn "use-auth-secret" REST scheme). Media is always end-to-end encrypted (DTLS-SRTP) between the
 * two browsers; TURN only relays encrypted packets.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireUser } from './auth.js';

const TTL_S = 12 * 3600;

export function registerCalls(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/calls/ice', async (req) => {
    const { user } = requireUser(ctx, req);
    const urls = ctx.config.turnUrls;
    if (!urls.length) return { iceServers: [], relay: false };
    const stun = urls.filter((u) => u.startsWith('stun:'));
    const turn = urls.filter((u) => u.startsWith('turn:') || u.startsWith('turns:'));
    const iceServers: { urls: string[]; username?: string; credential?: string }[] = [];
    if (stun.length) iceServers.push({ urls: stun });
    if (turn.length && ctx.config.turnSecret) {
      const username = `${Math.floor(Date.now() / 1000) + TTL_S}:${user.id}`;
      const credential = crypto.createHmac('sha1', ctx.config.turnSecret).update(username).digest('base64');
      iceServers.push({ urls: turn, username, credential });
    }
    return { iceServers, relay: turn.length > 0 && !!ctx.config.turnSecret };
  });
}
