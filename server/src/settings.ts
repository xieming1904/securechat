/**
 * Admin-tunable limits, stored in the settings table and falling back to the built-in defaults
 * (which tests override through AppConfig).
 */
import type { Ctx } from './context.js';
import { getSetting, setSetting } from './db.js';

export interface GateRules {
  maxFails: number; // wrong passwords before a temporary block
  windowMin: number; // …within this many minutes
  blockMin: number; // temporary block length
  permanentAfter: number; // total failures before a permanent block (0 = never)
}
export interface Limits {
  dailyUploadMb: number; // default per-user upload quota per 24 h
  maxFileMb: number; // largest single attachment
  linkPreview: boolean; // allow the opt-in server-side link preview fetcher
  require2fa: boolean; // every account must turn on two-step verification
  attachmentRetentionDays: number; // delete attachments older than this (0 = keep)
}

export const LIMIT_BOUNDS = { dailyUploadMb: [10, 100_000], maxFileMb: [1, 2048] } as const;

export function gateRules(ctx: Ctx): GateRules {
  const d: GateRules = {
    maxFails: ctx.config.gateMaxFails,
    windowMin: Math.round(ctx.config.gateWindowMs / 60_000),
    blockMin: Math.round(ctx.config.gateBlockMs / 60_000),
    permanentAfter: ctx.config.gatePermanentAfter,
  };
  try {
    return { ...d, ...JSON.parse(getSetting(ctx.db, 'gate_rules') ?? '{}') };
  } catch {
    return d;
  }
}

export function setGateRules(ctx: Ctx, r: GateRules) {
  setSetting(ctx.db, 'gate_rules', JSON.stringify(r));
}

export function limits(ctx: Ctx): Limits {
  const d: Limits = { dailyUploadMb: 1024, maxFileMb: 2048, linkPreview: true, require2fa: false, attachmentRetentionDays: 0 };
  try {
    return { ...d, ...JSON.parse(getSetting(ctx.db, 'limits') ?? '{}') };
  } catch {
    return d;
  }
}

export function setLimits(ctx: Ctx, l: Limits) {
  setSetting(ctx.db, 'limits', JSON.stringify(l));
}

/** Effective daily upload quota (bytes) for a user: their override or the default. */
export function userDailyQuota(ctx: Ctx, userId: string) {
  const row = ctx.db.prepare('SELECT upload_quota_mb FROM users WHERE id = ?').get(userId) as { upload_quota_mb: number | null } | undefined;
  return (row?.upload_quota_mb ?? limits(ctx).dailyUploadMb) * 1024 * 1024;
}
