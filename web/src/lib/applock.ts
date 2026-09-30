import { tr } from './i18n';
/**
 * App lock (this device only).
 *
 * When enabled, the app starts in a locked state and decrypts nothing until the PIN is entered;
 * "lock" therefore simply reloads the page, which drops every decrypted message from memory.
 *
 * Honest scope: this stops someone who picks up an unlocked computer from reading chats. It is not a
 * cryptographic barrier against someone who can run code in this browser profile — the device keys are
 * protected by the browser, not by the PIN.
 *
 * Wrong PINs: from the 5th failure on there is a growing wait; after 10 failures the local keys and
 * cache on this device are wiped and the user must log in again with their password.
 */
const KEY = 'securechat.applock.v1';
const ITER = 310_000;
export const MAX_FAILS = 10;

interface Cfg {
  v: 1;
  salt: string;
  hash: string;
  iter: number;
  idleMin: number;
  fails: number;
  waitUntil: number;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function read(): Cfg | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Cfg) : null;
  } catch {
    return null;
  }
}
function write(c: Cfg | null) {
  try {
    if (c) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

async function derive(pin: string, salt: Uint8Array, iter: number) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iter }, base, 256);
  return b64(new Uint8Array(bits));
}

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function lockEnabled() {
  return !!read();
}
export function lockIdleMinutes() {
  return read()?.idleMin ?? 0;
}

export function validatePin(pin: string): string | null {
  if (pin.length < 4) return tr('PIN 至少 4 位');
  if (pin.length > 64) return tr('PIN 太长');
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) return tr('PIN 太简单，换一个');
  return null;
}

export async function enableLock(pin: string, idleMin: number) {
  const err = validatePin(pin);
  if (err) throw new Error(err);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  write({ v: 1, salt: b64(salt), hash: await derive(pin, salt, ITER), iter: ITER, idleMin, fails: 0, waitUntil: 0 });
}

export function setIdleMinutes(idleMin: number) {
  const c = read();
  if (c) write({ ...c, idleMin });
}

export function disableLockUnsafe() {
  write(null);
}

export type VerifyResult = { ok: true } | { ok: false; left: number; waitMs: number; wipe: boolean };

export function waitRemaining() {
  const c = read();
  return c ? Math.max(0, c.waitUntil - Date.now()) : 0;
}

export async function verifyPin(pin: string): Promise<VerifyResult> {
  const c = read();
  if (!c) return { ok: true };
  const wait = c.waitUntil - Date.now();
  if (wait > 0) return { ok: false, left: MAX_FAILS - c.fails, waitMs: wait, wipe: false };
  const h = await derive(pin, unb64(c.salt), c.iter);
  if (sameString(h, c.hash)) {
    write({ ...c, fails: 0, waitUntil: 0 });
    return { ok: true };
  }
  const fails = c.fails + 1;
  if (fails >= MAX_FAILS) {
    write(null);
    return { ok: false, left: 0, waitMs: 0, wipe: true };
  }
  const waitMs = fails >= 5 ? Math.min(10 * 60_000, 30_000 * 2 ** (fails - 5)) : 0;
  write({ ...c, fails, waitUntil: Date.now() + waitMs });
  return { ok: false, left: MAX_FAILS - fails, waitMs, wipe: false };
}

/** Lock right now: reload so nothing decrypted stays in memory; the app starts locked. */
export function lockNow() {
  location.reload();
}

/** Auto-lock after `idleMin` minutes without input, or when coming back to a tab hidden for longer than that. */
export function startIdleWatch(): () => void {
  const min = lockIdleMinutes();
  if (!lockEnabled() || !min) return () => undefined;
  const limit = min * 60_000;
  let last = Date.now();
  const bump = () => (last = Date.now());
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;
  events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
  const check = () => {
    if (Date.now() - last > limit) lockNow();
  };
  const t = setInterval(check, 15_000);
  const vis = () => document.visibilityState === 'visible' && check();
  document.addEventListener('visibilitychange', vis);
  return () => {
    clearInterval(t);
    document.removeEventListener('visibilitychange', vis);
    events.forEach((e) => window.removeEventListener(e, bump));
  };
}
