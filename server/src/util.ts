import crypto from 'node:crypto';
import net from 'node:net';

export const now = () => Date.now();

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function inviteCode(len = 8): string {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export const bad = (code: string, msg?: string) => new HttpError(400, code, msg);
export const forbidden = (code = 'forbidden') => new HttpError(403, code);
export const notFound = (code = 'not_found') => new HttpError(404, code);

/** Expand an IPv6 address to 8 groups of 4 hex digits. */
function expandIPv6(ip: string): string[] {
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  // Embedded IPv4 at the end (e.g. ::ffff:1.2.3.4) — convert into two groups
  const fixV4 = (arr: string[]) => {
    const last = arr[arr.length - 1];
    if (last && last.includes('.')) {
      const p = last.split('.').map(Number);
      arr.splice(arr.length - 1, 1, ((p[0] << 8) | p[1]).toString(16), ((p[2] << 8) | p[3]).toString(16));
    }
    return arr;
  };
  fixV4(h);
  fixV4(t);
  const missing = tail === undefined ? 0 : 8 - h.length - t.length;
  return [...h, ...Array(missing).fill('0'), ...t].map((g) => g.padStart(4, '0').toLowerCase());
}

/**
 * Normalise a client IP into the key used by the allow/block lists.
 * IPv4 (incl. IPv4-mapped IPv6) → exact address; IPv6 → /64 prefix.
 */
export function ipKey(rawIp: string, v6Prefix = 64): string {
  let ip = (rawIp || '').trim();
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) return ip;
  if (net.isIPv6(ip)) {
    const groups = expandIPv6(ip.split('%')[0]);
    const n = Math.max(1, Math.min(8, Math.ceil(v6Prefix / 16)));
    return n === 8 ? groups.join(':') : `${groups.slice(0, n).join(':')}::/${v6Prefix}`;
  }
  return ip;
}

// ---------- tiny input validation helpers ----------
type Body = Record<string, unknown> | undefined | null;

export function str(body: Body, key: string, opts: { min?: number; max?: number; pattern?: RegExp; optional?: boolean } = {}): string {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw bad('invalid_input', `缺少字段 ${key}`);
  }
  if (typeof v !== 'string') throw bad('invalid_input', `${key} 必须是字符串`);
  if (opts.min !== undefined && v.length < opts.min) throw bad('invalid_input', `${key} 太短`);
  if (v.length > (opts.max ?? 10_000)) throw bad('invalid_input', `${key} 太长`);
  if (opts.pattern && !opts.pattern.test(v)) throw bad('invalid_input', `${key} 格式不正确`);
  return v;
}

const B64URL = /^[A-Za-z0-9_-]*$/;
/** base64url (no padding) string, optionally with an exact decoded byte length */
export function b64(body: Body, key: string, bytes?: number, max = 200_000): string {
  const v = str(body, key, { max, pattern: B64URL });
  if (bytes !== undefined && Buffer.from(v, 'base64url').length !== bytes) throw bad('invalid_input', `${key} 长度不正确`);
  return v;
}

export function int(body: Body, key: string, opts: { min?: number; max?: number; optional?: boolean; def?: number } = {}): number {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional || opts.def !== undefined) return opts.def ?? 0;
    throw bad('invalid_input', `缺少字段 ${key}`);
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw bad('invalid_input', `${key} 必须是整数`);
  if (opts.min !== undefined && n < opts.min) throw bad('invalid_input', `${key} 太小`);
  if (opts.max !== undefined && n > opts.max) throw bad('invalid_input', `${key} 太大`);
  return n;
}

/**
 * In-memory token buckets (v0.7): `take(key)` spends one token; tokens refill at `perSec` up to `capacity`.
 * Generous on purpose: they stop floods and runaway scripts, not normal use (bursts such as an offline outbox
 * being flushed fit in the capacity). Memory is bounded by dropping full buckets when the map grows.
 */
export class Buckets {
  private m = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private perSec: number, private maxKeys = 20_000) {}
  take(key: string, cost = 1): boolean {
    const t = Date.now();
    let b = this.m.get(key);
    if (!b) {
      if (this.m.size >= this.maxKeys) this.sweep(t);
      b = { tokens: this.capacity, at: t };
      this.m.set(key, b);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.perSec);
      b.at = t;
    }
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }
  forget(key: string) {
    this.m.delete(key);
  }
  private sweep(t: number) {
    for (const [k, b] of this.m) if (b.tokens + ((t - b.at) / 1000) * this.perSec >= this.capacity) this.m.delete(k);
    if (this.m.size >= this.maxKeys) this.m.clear();
  }
}
