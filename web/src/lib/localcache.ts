/**
 * Local, encrypted message cache — powers full-text search and read-only offline mode.
 *
 * Everything is stored in IndexedDB encrypted with the same NON-EXTRACTABLE AES-GCM key that wraps the
 * identity keys, so the cache on disk is not readable without this browser profile. Deletions are mirrored:
 * "delete for everyone", disappearing messages, "delete for me" and cleared histories are removed here too
 * (live via socket events, and on every start via /api/sync/removed).
 */
import type { Payload } from '../crypto/core';
import { getWrapKey, idbDel, idbGet, idbKeys, idbSet } from '../crypto/keystore';
import { isCacheDisabled } from './prefs';

export interface CachedMsg {
  id: string;
  chatId: string;
  seq: number;
  senderId: string;
  createdAt: number;
  editedAt: number | null;
  expiresAt: number | null;
  clientMsgId: string;
  payload: Payload;
}

const MAX_PER_CHAT = 5000;
let userId = '';
let key: CryptoKey | null = null;
let enabled = true;
const mem = new Map<string, Map<string, CachedMsg>>();
const dirty = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const cacheKey = (chatId: string) => `cache:${userId}:${chatId}`;

async function seal(obj: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key!, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv, ct };
}
async function open<T>(rec: { iv: Uint8Array; ct: ArrayBuffer } | undefined): Promise<T | null> {
  if (!rec || !key) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as Uint8Array<ArrayBuffer> }, key, rec.ct);
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null; // written with an older wrapping key — ignore
  }
}

export function cacheEnabled() {
  return enabled;
}

export async function initCache(uid: string) {
  userId = uid;
  key = await getWrapKey(uid);
  enabled = (await idbGet<boolean>('pref:cache').catch(() => undefined)) ?? true;
  mem.clear();
  if (!key || !enabled) return;
  const keys = (await idbKeys().catch(() => [])) as string[];
  for (const k of keys) {
    if (typeof k !== 'string' || !k.startsWith(`cache:${uid}:`)) continue;
    const data = await open<CachedMsg[]>(await idbGet<{ iv: Uint8Array; ct: ArrayBuffer }>(k));
    if (data) mem.set(k.slice(`cache:${uid}:`.length), new Map(data.map((m) => [m.id, m])));
  }
}

function scheduleFlush(chatId: string) {
  dirty.add(chatId);
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const ids = [...dirty];
    dirty.clear();
    for (const id of ids) {
      const m = mem.get(id);
      if (!m || m.size === 0) await idbDel(cacheKey(id)).catch(() => undefined);
      else await idbSet(cacheKey(id), await seal([...m.values()])).catch(() => undefined);
    }
  }, 600);
}

export function cachePut(msgs: CachedMsg[]) {
  if (!enabled || !key) return;
  for (const m of msgs) {
    if (!m.payload || m.payload.t === 'system') continue;
    if (isCacheDisabled(m.chatId)) continue; // user opted this chat out of the local cache
    let c = mem.get(m.chatId);
    if (!c) mem.set(m.chatId, (c = new Map()));
    c.set(m.id, m);
    if (c.size > MAX_PER_CHAT) {
      const sorted = [...c.values()].sort((a, b) => a.seq - b.seq);
      for (const old of sorted.slice(0, c.size - MAX_PER_CHAT)) c.delete(old.id);
    }
    scheduleFlush(m.chatId);
  }
}

export function cacheRemove(chatId: string, ids: string[]) {
  const c = mem.get(chatId);
  if (!c) return;
  let changed = false;
  for (const id of ids) changed = c.delete(id) || changed;
  if (changed) scheduleFlush(chatId);
}

export function cacheRemoveEverywhere(items: { chatId: string; id: string }[]) {
  const by = new Map<string, string[]>();
  for (const it of items) by.set(it.chatId, [...(by.get(it.chatId) ?? []), it.id]);
  for (const [c, ids] of by) cacheRemove(c, ids);
}

/** Drop everything at or below `beforeSeq` (history cleared) and anything already expired. */
export function cachePrune(chatId: string, beforeSeq: number) {
  const c = mem.get(chatId);
  if (!c) return;
  const now = Date.now();
  let changed = false;
  for (const [id, m] of c)
    if (m.seq <= beforeSeq || (m.expiresAt && m.expiresAt <= now)) {
      c.delete(id);
      changed = true;
    }
  if (changed) scheduleFlush(chatId);
}

export function cacheDropChat(chatId: string) {
  mem.delete(chatId);
  scheduleFlush(chatId);
}

/** Keep only chats that still exist for us. */
export function cacheKeepChats(chatIds: string[]) {
  const keep = new Set(chatIds);
  for (const id of [...mem.keys()]) if (!keep.has(id)) cacheDropChat(id);
}

export function cachedMessages(chatId: string): CachedMsg[] {
  return [...(mem.get(chatId)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
}
export function cachedCount(chatId?: string) {
  if (chatId) return mem.get(chatId)?.size ?? 0;
  let n = 0;
  for (const c of mem.values()) n += c.size;
  return n;
}
export function cachedMinSeq(chatId: string) {
  let min = Infinity;
  for (const m of mem.get(chatId)?.values() ?? []) min = Math.min(min, m.seq);
  return min;
}

export function searchableText(p: Payload): string {
  if (p.t === 'text') return p.text;
  if (p.t === 'file') return `${p.name} ${p.caption ?? ''}`;
  if (p.t === 'poll') return `${p.q} ${p.options.join(' ')}`;
  if (p.t === 'bundle') return `${p.title} ${p.items.map((i) => (i.p.t === 'text' ? i.p.text : i.p.t === 'file' ? i.p.name : '')).join(' ')}`;
  return '';
}

export interface SearchHit {
  msg: CachedMsg;
  text: string;
  index: number;
}

/** Case-insensitive substring search (works for Chinese without a tokenizer). Newest first. */
export function searchCache(q: string, limit = 60): SearchHit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  const now = Date.now();
  for (const c of mem.values())
    for (const m of c.values()) {
      if (m.expiresAt && m.expiresAt <= now) continue;
      const text = searchableText(m.payload);
      const index = text.toLowerCase().indexOf(needle);
      if (index >= 0) hits.push({ msg: m, text, index });
    }
  return hits.sort((a, b) => b.msg.createdAt - a.msg.createdAt).slice(0, limit);
}

// ---- chat list snapshot for offline mode
export async function saveChatsSnapshot(chats: unknown) {
  if (!enabled || !key) return;
  await idbSet(`chats:${userId}`, await seal(chats)).catch(() => undefined);
}
export async function loadChatsSnapshot<T>(): Promise<T | null> {
  return open<T>(await idbGet<{ iv: Uint8Array; ct: ArrayBuffer }>(`chats:${userId}`).catch(() => undefined));
}

export async function setCacheEnabled(on: boolean) {
  enabled = on;
  await idbSet('pref:cache', on).catch(() => undefined);
  if (!on) {
    for (const id of [...mem.keys()]) await idbDel(cacheKey(id)).catch(() => undefined);
    await idbDel(`chats:${userId}`).catch(() => undefined);
    mem.clear();
  }
}

export async function getSyncSince(): Promise<number> {
  return (await idbGet<number>(`sync:${userId}`).catch(() => undefined)) ?? 0;
}
export async function setSyncSince(t: number) {
  await idbSet(`sync:${userId}`, t).catch(() => undefined);
}
export async function lastUserId(): Promise<string | undefined> {
  return idbGet<string>('last-user').catch(() => undefined);
}
