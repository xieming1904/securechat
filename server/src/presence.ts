/**
 * What others see of someone's online status (v0.9).
 * Normally: online while a connection is open. With `coarseOnline`, the visible state follows the real one only
 * after random delays (1–5 min to appear, 20–40 min to disappear), so contacts can't read exact come/go times.
 */
import type { Ctx } from './context.js';
import { privacyOf } from './social.js';

const shown = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** set by realtime.ts: tell a user's peers their (visible) status */
let broadcaster: ((ctx: Ctx, userId: string, online: boolean) => void) | null = null;
export function setPresenceBroadcaster(fn: typeof broadcaster) {
  broadcaster = fn;
}

/** The user changed their privacy settings: settle the visible state right away (no stale "online"). */
export function privacyChanged(ctx: Ctx, userId: string) {
  const old = timers.get(userId);
  if (old) clearTimeout(old), timers.delete(userId);
  const online = (ctx.online.get(userId) ?? 0) > 0;
  if (privacyOf(ctx, userId).coarseOnline) {
    // keep showing what peers see now; the fuzzy timers take over from the next come/go
    if (online) shown.add(userId);
    else shown.delete(userId);
  } else {
    shown.delete(userId);
    broadcaster?.(ctx, userId, online);
  }
}

export function visibleOnline(ctx: Ctx, userId: string): boolean {
  return privacyOf(ctx, userId).coarseOnline ? shown.has(userId) : (ctx.online.get(userId) ?? 0) > 0;
}

function later(userId: string, ms: number, fn: () => void) {
  const old = timers.get(userId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    timers.delete(userId);
    fn();
  }, ms);
  t.unref?.();
  timers.set(userId, t);
}

/** Call when the user's first connection opens (`online`) or the last one closes (`!online`). */
export function presenceChanged(ctx: Ctx, userId: string, online: boolean, broadcast: (online: boolean) => void) {
  const p = privacyOf(ctx, userId);
  if (!p.coarseOnline) {
    shown.delete(userId);
    return broadcast(online);
  }
  const isOnline = () => (ctx.online.get(userId) ?? 0) > 0;
  if (online) {
    if (shown.has(userId)) {
      const old = timers.get(userId);
      if (old) clearTimeout(old), timers.delete(userId); // back before the "offline" showed: nothing changes
      return;
    }
    later(userId, rand(60_000, 300_000), () => {
      if (!isOnline() || shown.has(userId)) return;
      shown.add(userId);
      broadcast(true);
    });
  } else {
    if (!shown.has(userId)) {
      const old = timers.get(userId);
      if (old) clearTimeout(old), timers.delete(userId);
      return;
    }
    later(userId, rand(20 * 60_000, 40 * 60_000), () => {
      if (isOnline() || !shown.has(userId)) return;
      shown.delete(userId);
      broadcast(false);
    });
  }
}
