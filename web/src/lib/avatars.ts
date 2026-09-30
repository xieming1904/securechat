/**
 * v0.6 end-to-end encrypted avatars (see server/src/avatars.ts for the model).
 * - My avatar: encrypted with its own key; the key (+ picture id) is kept in my vault so all my devices can hand it
 *   out, and handed to each chat as an envelope encrypted with the chat key and signed with my identity key.
 * - Other people's avatars: envelope → verify signature with their identity key → decrypt picture → object URL.
 * - Group avatar: the key is in the admin-signed group settings.
 */
import { useAvatars } from './avatarStore';
import * as C from '../crypto/core';
import { api } from './api';
import { fetchBlob, uploadBlob } from './files';
import { chatKeyAt, currentChatKey, getUserKeys, myIdentity, onAppReady, onSocket, saveSettings, useStore } from './store';
import { putVault } from './social';

type Mine = C.AvatarRef & { v: number };
type AvatarState = import('./avatarStore').AvatarState;
export { useAvatars };
const set = useAvatars.setState;
const get = useAvatars.getState;

const SIZE = 256;

/** Square, re-encoded (strips metadata such as GPS), small. */
async function toAvatarBytes(file: Blob) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  c.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bmp.close();
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/webp', 0.85));
  return new Uint8Array(await blob.arrayBuffer());
}

async function decryptToUrl(ref: C.AvatarRef) {
  const pt = C.decryptFile(await fetchBlob(ref.blobId), ref.key, ref.header);
  return URL.createObjectURL(new Blob([pt as Uint8Array<ArrayBuffer>], { type: 'image/webp' }));
}

// ------------------------------------------------------------------ mine
export async function setMyAvatar(file: File) {
  const bytes = await toAvatarBytes(file);
  const enc = C.encryptFile(bytes);
  const blobId = await uploadBlob('self', enc.ciphertext);
  const { v } = await api.put('/api/me/avatar', { blobId });
  const mine: Mine = { blobId, key: enc.key, header: enc.header, v };
  await putVault('pref', 'avatar', mine);
  const me = useStore.getState().me!;
  const prev = get().users[me.id];
  if (prev) URL.revokeObjectURL(prev.url);
  set({ mine, users: { ...get().users, [me.id]: { v, url: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/webp' })) } } });
  await distribute();
}

export async function removeMyAvatar() {
  await api.put('/api/me/avatar', { blobId: null });
  await api.del('/api/vault/pref/avatar').catch(() => undefined);
  const me = useStore.getState().me!;
  const users = { ...get().users };
  if (users[me.id]) URL.revokeObjectURL(users[me.id].url);
  delete users[me.id];
  set({ mine: null, users });
}

/** Hand my avatar key to every chat that doesn't have the current one (new chats, new key epochs). */
let distributing = false;
async function distribute(existing?: { chatId: string; v: number; epoch: number }[]) {
  const mine = get().mine;
  const me = useStore.getState().me;
  const id = myIdentity();
  if (!mine || !me || !id || distributing) return;
  distributing = true;
  try {
    const have = existing ?? ((await api.get('/api/avatars')).envelopes as { userId: string; chatId: string; v: number; epoch: number }[]).filter((e) => e.userId === me.id);
    for (const chat of Object.values(useStore.getState().chats)) {
      const e = have.find((x) => x.chatId === chat.id);
      if (e && e.v === mine.v && e.epoch >= chat.currentEpoch) continue;
      try {
        const { key, epoch } = await currentChatKey(chat.id);
        const env = C.sealAvatarKey({ blobId: mine.blobId, key: mine.key, header: mine.header }, key, { chatId: chat.id, userId: me.id, epoch, v: mine.v }, id);
        await api.put(`/api/chats/${chat.id}/avatar-key`, { v: mine.v, epoch, ...env });
      } catch {
        /* no key yet / left the chat — next time */
      }
    }
  } finally {
    distributing = false;
  }
}

// ------------------------------------------------------------------ everyone else
/** Highest avatar version seen per person (this device): versions only go up. */
const seenKey = () => `securechat.avatarv.${useStore.getState().me?.id ?? ''}`;
function seenVersions(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(seenKey()) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function saveSeen(v: Record<string, number>) {
  try {
    localStorage.setItem(seenKey(), JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
type Env = { userId: string; chatId: string; v: number; epoch: number; nonce: string; ciphertext: string; signature: string; blobId: string };

async function load() {
  const me = useStore.getState().me;
  if (!me) return;
  const r = await api.get('/api/avatars');
  // my own avatar reference (from my vault) — needed to hand it out from this device
  if (r.mine.v) {
    const vr = await api.get('/api/vault/pref').catch(() => null);
    const row = vr?.items?.find((x: { id: string }) => x.id === 'avatar');
    const id = myIdentity();
    if (row && id) {
      try {
        const m = C.decryptVault<Mine>(row, id, me.id, 'pref', 'avatar');
        if (m.v === r.mine.v && C.isAvatarRef(m)) set({ mine: m });
      } catch {
        /* ignore */
      }
    }
  } else set({ mine: null });
  const envs = r.envelopes as Env[];
  const byUser = new Map<string, Env[]>();
  for (const e of envs) byUser.set(e.userId, [...(byUser.get(e.userId) ?? []), e]);
  const users: AvatarState['users'] = { ...get().users };
  const seen = seenVersions();
  for (const [uid, list] of byUser) {
    const v = list[0].v;
    if (users[uid]?.v === v) continue;
    if (v < (seen[uid] ?? 0)) continue; // an older (still validly signed) picture replayed by the server
    for (const e of list.sort((a, b) => b.epoch - a.epoch)) {
      try {
        const key = await chatKeyAt(e.chatId, e.epoch);
        if (!key) continue;
        const ref = C.openAvatarKey(e, key, { chatId: e.chatId, userId: uid, epoch: e.epoch, v: e.v }, (await getUserKeys(uid)).signPk);
        if (ref.blobId !== e.blobId) continue; // the picture the server points to must be the signed one
        if (users[uid]) URL.revokeObjectURL(users[uid].url);
        users[uid] = { v, url: await decryptToUrl(ref) };
        seen[uid] = v;
        break;
      } catch {
        /* forged / undecryptable: try another chat */
      }
    }
  }
  // people who removed their avatar
  for (const uid of Object.keys(users)) if (uid !== me.id && !byUser.has(uid)) (URL.revokeObjectURL(users[uid].url), delete users[uid]);
  set({ users });
  saveSeen(seen);
  if (get().mine && !users[me.id]) {
    try {
      set({ users: { ...get().users, [me.id]: { v: get().mine!.v, url: await decryptToUrl(get().mine!) } } });
    } catch {
      /* ignore */
    }
  }
  await distribute(envs.filter((e) => e.userId === me.id));
}

/** Group pictures come from the (verified) group settings. */
async function syncGroups() {
  const groups = { ...get().groups };
  let changed = false;
  for (const c of Object.values(useStore.getState().chats)) {
    const av = c.type === 'group' && c.settings && ['signed', 'resign', 'mismatch'].includes(c.settings.status) ? c.settings.av : undefined;
    if (!av) {
      if (groups[c.id]) (URL.revokeObjectURL(groups[c.id].url), delete groups[c.id], (changed = true));
      continue;
    }
    if (groups[c.id]?.blobId === av.blobId) continue;
    try {
      groups[c.id] = { blobId: av.blobId, url: await decryptToUrl(av) };
      changed = true;
    } catch {
      /* ignore */
    }
  }
  if (changed) set({ groups });
}

export async function setGroupAvatar(chatId: string, file: File | null) {
  if (!file) {
    await api.put(`/api/chats/${chatId}/avatar`, { blobId: null });
    await saveSettings(chatId, { avatar: null });
    return;
  }
  const bytes = await toAvatarBytes(file);
  const enc = C.encryptFile(bytes);
  const blobId = await uploadBlob(chatId, enc.ciphertext);
  await api.put(`/api/chats/${chatId}/avatar`, { blobId });
  await saveSettings(chatId, { avatar: { blobId, key: enc.key, header: enc.header } });
}

let timer: ReturnType<typeof setTimeout> | null = null;
const soon = (fn: () => Promise<unknown>, ms = 800) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => ((timer = null), fn().catch(() => undefined)), ms);
};
onAppReady(() => {
  for (const x of Object.values(get().users)) URL.revokeObjectURL(x.url);
  for (const x of Object.values(get().groups)) URL.revokeObjectURL(x.url);
  set({ users: {}, groups: {}, mine: null, meId: useStore.getState().me?.id ?? null });
  return Promise.all([load(), syncGroups()]).catch(() => undefined);
});
onSocket((s) => s.on('avatar:changed', () => soon(load)));
// new chats / new key epochs → hand out my avatar key; changed group settings → group pictures
let lastSig = '';
useStore.subscribe((st) => {
  if (st.phase !== 'ready') return;
  const sig = Object.values(st.chats)
    .map((c) => `${c.id}:${c.currentEpoch}:${c.settings?.av?.blobId ?? ''}`)
    .sort()
    .join(',');
  if (sig === lastSig) return;
  lastSig = sig;
  soon(async () => {
    await syncGroups();
    await distribute();
  }, 1500);
});

