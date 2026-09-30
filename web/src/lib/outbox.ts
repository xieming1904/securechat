/**
 * Offline outbox: text/poll/forwarded messages written while the connection is down are kept here and sent
 * automatically once we are back online. Items are stored in IndexedDB encrypted with this browser's
 * non-extractable wrapping key (like the message cache) and encrypted for the chat only at send time,
 * with the key that is current then. The server de-duplicates by clientMsgId, so a retry never doubles a message.
 */
import type { Payload } from '../crypto/core';
import { getWrapKey, idbGet, idbSet } from '../crypto/keystore';

export interface OutItem {
  chatId: string;
  clientMsgId: string;
  payload: Payload;
  createdAt: number;
  /** v0.9: this message's own self-destruct timer (seconds) */
  ttl?: number;
}

let uid = '';
let key: CryptoKey | null = null;
let items: OutItem[] = [];
let saving: Promise<unknown> = Promise.resolve();

const k = () => `outbox:${uid}`;

export async function initOutbox(userId: string) {
  uid = userId;
  key = await getWrapKey(userId);
  items = [];
  if (!key) return;
  const rec = await idbGet<{ iv: Uint8Array; ct: ArrayBuffer }>(k()).catch(() => undefined);
  if (!rec) return;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as Uint8Array<ArrayBuffer> }, key, rec.ct);
    const data = JSON.parse(new TextDecoder().decode(pt));
    if (Array.isArray(data)) items = data;
  } catch {
    items = [];
  }
}

function persist() {
  if (!key) return;
  const snapshot = items.slice();
  saving = saving.then(async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key!, new TextEncoder().encode(JSON.stringify(snapshot)));
    await idbSet(k(), { iv, ct });
  }).catch(() => undefined);
}

export const outboxItems = () => items.slice().sort((a, b) => a.createdAt - b.createdAt);
export const outboxHas = (clientMsgId: string) => items.some((x) => x.clientMsgId === clientMsgId);

export function outboxAdd(it: OutItem) {
  items = [...items.filter((x) => x.clientMsgId !== it.clientMsgId), it];
  persist();
}

export function outboxRemove(clientMsgId: string) {
  if (!outboxHas(clientMsgId)) return;
  items = items.filter((x) => x.clientMsgId !== clientMsgId);
  persist();
}

export function outboxDropChat(chatId: string) {
  if (!items.some((x) => x.chatId === chatId)) return;
  items = items.filter((x) => x.chatId !== chatId);
  persist();
}

export function outboxClear() {
  items = [];
  persist();
}

/** Logged out: forget everything in memory (IndexedDB is wiped separately). */
export function outboxForget() {
  items = [];
  key = null;
}
