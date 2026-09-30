/**
 * v0.4 contacts, privacy, saved messages and stickers.
 * Everything personal (aliases, notes, saved items, sticker packs) lives in the server's per-user vault, encrypted with
 * a key only my own devices can derive; the block list and privacy switches are plaintext because the server enforces them.
 */
import { create } from 'zustand';
import * as C from '../crypto/core';
import { api } from './api';
import { getUserKeys, myIdentity, onAppReady, onSocket, toast, useStore, type Msg } from './store';
import { transferBlob, uploadBlob } from './files';
import { tr } from './i18n';

export interface Contact {
  alias?: string;
  note?: string;
  /** identity key I verified in person (safety number / QR); cleared automatically when it changes */
  verifiedKey?: string;
  verifiedAt?: number;
}
export interface SavedItem {
  id: string;
  savedAt: number;
  from: string;
  chatTitle: string;
  at: number;
  p: C.Payload;
}
export interface Sticker {
  id: string;
  addedAt: number;
  p: C.FilePayload;
}
export interface Privacy {
  hideOnline: boolean;
  noReceipts: boolean;
  coarseOnline?: boolean;
  pushDelay?: boolean;
}
export interface Blocked {
  id: string;
  username: string;
  displayName: string;
}

interface SocialState {
  contacts: Record<string, Contact>;
  blocked: Blocked[];
  privacy: Privacy;
  saved: SavedItem[];
  stickers: Sticker[];
  loaded: boolean;
}

export const useSocial = create<SocialState>(() => ({
  contacts: {},
  blocked: [],
  privacy: { hideOnline: false, noReceipts: false },
  saved: [],
  stickers: [],
  loaded: false,
}));
const set = useSocial.setState;
const get = useSocial.getState;

type VaultRow = { id: string; nonce: string; ciphertext: string; updatedAt: number };

function open<T>(kind: string, r: VaultRow): T | null {
  const id = myIdentity();
  const me = useStore.getState().me;
  if (!id || !me) return null;
  try {
    return C.decryptVault<T>(r, id, me.id, kind, r.id);
  } catch {
    return null;
  }
}

export async function putVault(kind: string, itemId: string, obj: unknown, blobIds: string[] = []) {
  const id = myIdentity()!;
  const me = useStore.getState().me!;
  await api.put(`/api/vault/${kind}/${encodeURIComponent(itemId)}`, { ...C.encryptVault(obj, id, me.id, kind, itemId), blobIds });
}

function applyItem(kind: string, itemId: string, row: VaultRow | null) {
  if (kind === 'contact') {
    const contacts = { ...get().contacts };
    const c = row ? open<Contact>(kind, row) : null;
    if (c) contacts[itemId] = c;
    else delete contacts[itemId];
    set({ contacts });
  } else if (kind === 'saved') {
    const rest = get().saved.filter((x) => x.id !== itemId);
    const s = row ? open<Omit<SavedItem, 'id'>>(kind, row) : null;
    set({ saved: s ? [{ ...s, id: itemId }, ...rest].sort((a, b) => b.savedAt - a.savedAt) : rest });
  } else if (kind === 'sticker') {
    const rest = get().stickers.filter((x) => x.id !== itemId);
    const s = row ? open<Omit<Sticker, 'id'>>(kind, row) : null;
    set({ stickers: s ? [...rest, { ...s, id: itemId }].sort((a, b) => a.addedAt - b.addedAt) : rest });
  }
}

export async function loadSocial() {
  const [contacts, saved, stickers, blocked, privacy] = await Promise.all([
    api.get('/api/vault/contact'),
    api.get('/api/vault/saved'),
    api.get('/api/vault/sticker'),
    api.get('/api/blocks'),
    api.get('/api/me/privacy'),
  ]);
  const c: Record<string, Contact> = {};
  for (const r of contacts.items as VaultRow[]) {
    const x = open<Contact>('contact', r);
    if (x) c[r.id] = x;
  }
  const sv: SavedItem[] = [];
  for (const r of saved.items as VaultRow[]) {
    const x = open<Omit<SavedItem, 'id'>>('saved', r);
    const p = x && C.validatePayload(x.p);
    if (x && p) sv.push({ ...x, p, id: r.id });
  }
  const st: Sticker[] = [];
  for (const r of stickers.items as VaultRow[]) {
    const x = open<Omit<Sticker, 'id'>>('sticker', r);
    if (x && C.validatePayload(x.p)) st.push({ ...x, id: r.id });
  }
  set({
    contacts: c,
    saved: sv.sort((a, b) => b.savedAt - a.savedAt),
    stickers: st.sort((a, b) => a.addedAt - b.addedAt),
    blocked: blocked.blocked,
    privacy: privacy.privacy,
    loaded: true,
  });
}

onAppReady(loadSocial);
onSocket((s) => {
  s.on('vault', ({ kind, id, item }: { kind: string; id: string; item: VaultRow | null }) => applyItem(kind, id, item));
  s.on('blocks:changed', () => api.get('/api/blocks').then((r) => set({ blocked: r.blocked })).catch(() => undefined));
});

// ------------------------------------------------------------------ contacts
/** The name I see for a user: my alias for them, else their display name. */
export function nameFor(userId: string, displayName: string) {
  return get().contacts[userId]?.alias?.trim() || displayName;
}
export function useNameFor() {
  const contacts = useSocial((s) => s.contacts);
  return (userId: string, displayName: string) => contacts[userId]?.alias?.trim() || displayName;
}

export async function saveContact(userId: string, c: Contact) {
  const prev = get().contacts[userId] ?? {};
  const clean: Contact = {
    alias: c.alias?.trim().slice(0, 64) || undefined,
    note: c.note?.trim().slice(0, 2000) || undefined,
    verifiedKey: c.verifiedKey ?? prev.verifiedKey,
    verifiedAt: c.verifiedAt ?? prev.verifiedAt,
  };
  if (!clean.alias && !clean.note && !clean.verifiedKey) {
    await api.del(`/api/vault/contact/${encodeURIComponent(userId)}`);
    return;
  }
  await putVault('contact', userId, clean);
}

export const isBlocked = (userId: string) => get().blocked.some((b) => b.id === userId);
export async function block(userId: string) {
  await api.put(`/api/blocks/${userId}`);
  const r = await api.get('/api/blocks');
  set({ blocked: r.blocked });
}
export async function unblock(userId: string) {
  await api.del(`/api/blocks/${userId}`);
  set({ blocked: get().blocked.filter((b) => b.id !== userId) });
}

export async function setPrivacy(p: Partial<Privacy>) {
  const next = { ...get().privacy, ...p };
  const r = await api.put('/api/me/privacy', next);
  set({ privacy: r.privacy });
}

// ------------------------------------------------------------------ saved messages
/** Personal copy of an attachment (so it survives the message being deleted in the chat). */
async function copyFileToSelf(p: C.FilePayload) {
  const blobId = await transferBlob(p, 'self');
  return { ...p, blobId };
}

export async function saveMessage(m: Msg) {
  const p = m.payload;
  if (!p || p.t === 'system' || p.t === 'call') return;
  if (get().saved.length >= 5000) throw new Error(tr('收藏已达上限'));
  const st = useStore.getState();
  const chat = st.chats[m.chatId];
  const me = st.me!;
  const sender = m.senderId === me.id ? me.displayName : chat?.members.find((x) => x.id === m.senderId)?.displayName ?? '';
  const { replyTo: _r, mentions: _m, ...clean } = p as C.Payload & { replyTo?: string; mentions?: string[] };
  let payload = clean as C.Payload;
  const blobIds: string[] = [];
  if (payload.t === 'file') {
    payload = await copyFileToSelf(payload);
    blobIds.push((payload as C.FilePayload).blobId);
  } else if (payload.t === 'bundle') {
    const items: C.BundleItem[] = [];
    for (const it of payload.items) {
      if (it.p.t === 'file') {
        const f = await copyFileToSelf(it.p);
        blobIds.push(f.blobId);
        items.push({ ...it, p: f });
      } else items.push(it);
    }
    payload = { ...payload, items };
  }
  if (blobIds.length > 10) throw new Error(tr('附件太多，无法收藏'));
  const id = C.randomId();
  const item = { savedAt: Date.now(), from: sender, chatTitle: chat?.title ?? '', at: m.createdAt, p: payload };
  await putVault('saved', id, item, blobIds);
  set({ saved: [{ ...item, id }, ...get().saved.filter((x) => x.id !== id)] });
  toast(tr('已收藏'));
}

export async function unsave(id: string) {
  await api.del(`/api/vault/saved/${encodeURIComponent(id)}`);
  set({ saved: get().saved.filter((x) => x.id !== id) });
}

// ------------------------------------------------------------------ stickers
export async function addSticker(p: C.FilePayload) {
  if (get().stickers.length >= 500) throw new Error(tr('贴纸已达上限'));
  const copy = await copyFileToSelf(p);
  const id = C.randomId();
  const item = { addedAt: Date.now(), p: copy };
  await putVault('sticker', id, item, [copy.blobId]);
  set({ stickers: [...get().stickers.filter((x) => x.id !== id), { ...item, id }] });
  toast(tr('已添加到贴纸'));
}

/** New sticker from an image file (re-encoded, max 512 px, transparent PNG kept). */
export async function addStickerFromFile(file: File) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/webp', 0.9));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const enc = C.encryptFile(bytes);
  const blobId = await uploadBlob('self', enc.ciphertext);
  const p: C.FilePayload = {
    t: 'file',
    kind: 'image',
    blobId,
    key: enc.key,
    header: enc.header,
    chunk: enc.chunk,
    name: 'sticker.webp',
    mime: blob.type || 'image/webp',
    size: bytes.length,
    w: c.width,
    h: c.height,
    sticker: true,
  };
  const id = C.randomId();
  const item = { addedAt: Date.now(), p };
  await putVault('sticker', id, item, [blobId]);
  set({ stickers: [...get().stickers, { ...item, id }] });
}

export async function removeSticker(id: string) {
  await api.del(`/api/vault/sticker/${encodeURIComponent(id)}`);
  set({ stickers: get().stickers.filter((x) => x.id !== id) });
}

/** Title of a chat as I see it (my alias for the peer of a direct chat). */
export function useChatTitle() {
  const contacts = useSocial((s) => s.contacts);
  const me = useStore((s) => s.me);
  return (c: { type: string; title: string; members: { id: string }[] }) => {
    if (c.type !== 'direct' || !me) return c.title;
    const peer = c.members.find((m) => m.id !== me.id);
    return (peer && contacts[peer.id]?.alias?.trim()) || c.title;
  };
}

/** Remember that I verified this person's identity key (after comparing safety numbers / scanning their QR). */
export async function markVerified(userId: string) {
  const k = await getUserKeys(userId);
  const c = get().contacts[userId] ?? {};
  await saveContact(userId, { ...c, verifiedKey: C.b64(k.signPk), verifiedAt: Date.now() });
  set({ contacts: { ...get().contacts, [userId]: { ...c, verifiedKey: C.b64(k.signPk), verifiedAt: Date.now() } } });
}

/** true = verified and the key is still the same one. */
export async function isVerified(userId: string) {
  const c = get().contacts[userId];
  if (!c?.verifiedKey) return false;
  return C.b64((await getUserKeys(userId)).signPk) === c.verifiedKey;
}
