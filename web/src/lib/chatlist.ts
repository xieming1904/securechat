/**
 * v0.5 chat list organisation: pinned chats, archive, "mark as unread" and folders.
 * Stored as ONE encrypted vault item (kind "chatlist") so the server learns nothing — not even which chats are
 * pinned or archived. Per-chat notification mute is separate (server-side, because the server must skip the push).
 */
import { create } from 'zustand';
import * as C from '../crypto/core';
import { api } from './api';
import { isNotifyOff, markChatRead, myIdentity, onAppReady, onSocket, toast, useStore, type Chat } from './store';
import { tr } from './i18n';

export interface Folder {
  id: string;
  name: string;
  /** explicitly added chats */
  chats: string[];
  /** also include every chat of these types */
  types?: ('direct' | 'group')[];
  /** only unread / only non-muted */
  unreadOnly?: boolean;
}
export interface ChatList {
  v: 1;
  /** pinned chat ids, in display order */
  pinned: string[];
  archived: string[];
  /** manually marked as unread */
  unread: string[];
  folders: Folder[];
}

const EMPTY: ChatList = { v: 1, pinned: [], archived: [], unread: [], folders: [] };
export const MAX_PINNED = 5;
export const MAX_FOLDERS = 10;
const KIND = 'chatlist';
const ITEM = 'main';

export const useChatList = create<ChatList & { loaded: boolean }>(() => ({ ...EMPTY, loaded: false }));
const get = useChatList.getState;

function clean(x: Partial<ChatList> | null): ChatList {
  const ids = (a: unknown) => (Array.isArray(a) ? [...new Set(a.filter((v): v is string => typeof v === 'string' && v.length < 80))] : []);
  const folders = Array.isArray(x?.folders)
    ? x!.folders
        .filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string')
        .slice(0, MAX_FOLDERS)
        .map((f) => ({
          id: f.id.slice(0, 40),
          name: f.name.slice(0, 24),
          chats: ids(f.chats).slice(0, 500),
          types: Array.isArray(f.types) ? f.types.filter((t) => t === 'direct' || t === 'group') : undefined,
          unreadOnly: !!f.unreadOnly,
        }))
    : [];
  return { v: 1, pinned: ids(x?.pinned).slice(0, MAX_PINNED), archived: ids(x?.archived).slice(0, 2000), unread: ids(x?.unread).slice(0, 2000), folders };
}

function openRow(r: { nonce: string; ciphertext: string }): ChatList | null {
  const id = myIdentity();
  const me = useStore.getState().me;
  if (!id || !me) return null;
  try {
    return clean(C.decryptVault<ChatList>(r, id, me.id, KIND, ITEM));
  } catch {
    return null;
  }
}

async function load() {
  const r = await api.get(`/api/vault/${KIND}`);
  const row = (r.items as { id: string; nonce: string; ciphertext: string }[]).find((x) => x.id === ITEM);
  useChatList.setState({ ...(row ? openRow(row) ?? EMPTY : EMPTY), loaded: true });
}
onAppReady(async () => {
  useChatList.setState({ loaded: false });
  // retry a few times: saving before the current list is known would overwrite it
  for (let i = 0; i < 5; i++) {
    try {
      return await load();
    } catch {
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
});
onSocket((s) =>
  s.on('vault', ({ kind, id, item }: { kind: string; id: string; item: { nonce: string; ciphertext: string } | null }) => {
    if (kind !== KIND || id !== ITEM) return;
    const next = item ? openRow(item) : EMPTY;
    if (next) useChatList.setState(next);
  }),
);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Apply a change locally now and save (debounced) — the socket echo brings other devices up to date. */
function update(fn: (c: ChatList) => ChatList) {
  if (!get().loaded) {
    toast(tr('聊天列表设置还在加载，请稍后再试'));
    return;
  }
  const { loaded: _l, ...cur } = get();
  const next = clean(fn(cur));
  useChatList.setState(next);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const id = myIdentity();
    const me = useStore.getState().me;
    if (!id || !me) return;
    const { loaded: _x, ...body } = get();
    api.put(`/api/vault/${KIND}/${ITEM}`, { ...C.encryptVault(body, id, me.id, KIND, ITEM), blobIds: [] }).catch((e) => toast(e.message));
  }, 400);
}

// ------------------------------------------------------------------ actions
export function togglePin(chatId: string) {
  const c = get();
  if (c.pinned.includes(chatId)) return update((x) => ({ ...x, pinned: x.pinned.filter((i) => i !== chatId) }));
  if (c.pinned.length >= MAX_PINNED) return toast(tr('最多置顶 {v0} 个聊天', { v0: MAX_PINNED }));
  update((x) => ({ ...x, pinned: [chatId, ...x.pinned], archived: x.archived.filter((i) => i !== chatId) }));
}
export function movePinned(chatId: string, dir: -1 | 1) {
  update((x) => {
    const p = [...x.pinned];
    const i = p.indexOf(chatId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= p.length) return x;
    [p[i], p[j]] = [p[j], p[i]];
    return { ...x, pinned: p };
  });
}
export function toggleArchive(chatId: string) {
  const on = get().archived.includes(chatId);
  update((x) => ({ ...x, archived: on ? x.archived.filter((i) => i !== chatId) : [chatId, ...x.archived], pinned: x.pinned.filter((i) => i !== chatId) }));
  if (!on) toast(tr('已归档。有新消息时会自动移出归档（免打扰的聊天除外）'));
}
export function markUnread(chatId: string) {
  update((x) => ({ ...x, unread: [...x.unread.filter((i) => i !== chatId), chatId] }));
}
export async function markRead(chatId: string) {
  if (get().unread.includes(chatId)) update((x) => ({ ...x, unread: x.unread.filter((i) => i !== chatId) }));
  await markChatRead(chatId);
}
export async function markAllRead(chatIds: string[]) {
  update((x) => ({ ...x, unread: x.unread.filter((i) => !chatIds.includes(i)) }));
  const chats = useStore.getState().chats;
  await Promise.all(chatIds.filter((id) => chats[id]?.unread).map((id) => markChatRead(id)));
}

export function saveFolder(f: Folder) {
  if (!f.name.trim()) return toast(tr('请填写分组名称'));
  update((x) => {
    const exists = x.folders.some((y) => y.id === f.id);
    if (!exists && x.folders.length >= MAX_FOLDERS) {
      toast(tr('最多 {v0} 个分组', { v0: MAX_FOLDERS }));
      return x;
    }
    return { ...x, folders: exists ? x.folders.map((y) => (y.id === f.id ? f : y)) : [...x.folders, f] };
  });
}
export function deleteFolder(id: string) {
  update((x) => ({ ...x, folders: x.folders.filter((f) => f.id !== id) }));
}
export function moveFolder(id: string, dir: -1 | 1) {
  update((x) => {
    const f = [...x.folders];
    const i = f.findIndex((y) => y.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= f.length) return x;
    [f[i], f[j]] = [f[j], f[i]];
    return { ...x, folders: f };
  });
}
export function toggleInFolder(folderId: string, chatId: string) {
  update((x) => ({
    ...x,
    folders: x.folders.map((f) => (f.id !== folderId ? f : { ...f, chats: f.chats.includes(chatId) ? f.chats.filter((i) => i !== chatId) : [...f.chats, chatId] })),
  }));
}

/** Personal-data restore: merge an imported chat list (only chats I'm in now; nothing I have is dropped). */
export function importChatList(x: Partial<ChatList>) {
  const chats = useStore.getState().chats;
  const inc = clean(x);
  const have = (id: string) => !!chats[id];
  update((c) => ({
    ...c,
    pinned: [...new Set([...c.pinned, ...inc.pinned.filter(have)])].slice(0, MAX_PINNED),
    archived: [...new Set([...c.archived, ...inc.archived.filter(have)])],
    folders: [
      ...c.folders,
      ...inc.folders
        .filter((f) => !c.folders.some((g) => g.name === f.name))
        .map((f) => ({ ...f, id: C.randomId().slice(0, 16), chats: f.chats.filter(have) })),
    ].slice(0, MAX_FOLDERS),
  }));
}

// ------------------------------------------------------------------ queries
export type Tab = 'all' | 'unread' | 'direct' | 'group' | `f:${string}`;

export const hasUnread = (c: Chat, cl: Pick<ChatList, 'unread'>) => c.unread > 0 || cl.unread.includes(c.id);

export function inTab(c: Chat, tab: Tab, cl: ChatList) {
  if (tab === 'all') return true;
  if (tab === 'unread') return hasUnread(c, cl);
  if (tab === 'direct' || tab === 'group') return c.type === tab;
  const f = cl.folders.find((x) => `f:${x.id}` === tab);
  if (!f) return true;
  const member = f.chats.includes(c.id) || !!f.types?.includes(c.type);
  return member && (!f.unreadOnly || hasUnread(c, cl));
}

/** Sort: pinned (in their order) first, then by last activity. */
export function sortChats(list: Chat[], cl: ChatList) {
  const pin = (id: string) => {
    const i = cl.pinned.indexOf(id);
    return i < 0 ? Infinity : i;
  };
  return [...list].sort((a, b) => pin(a.id) - pin(b.id) || (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
}

/** Unread count for the tab title / badges: muted and archived chats don't count. */
export function countedUnread(chats: Record<string, Chat>, cl: ChatList) {
  let n = 0;
  for (const c of Object.values(chats)) if (!isNotifyOff(c) && !cl.archived.includes(c.id)) n += c.unread;
  return n;
}

// ------------------------------------------------------------------ automatic behaviour
// - opening a chat clears its manual "unread" mark
// - a new message from someone else in an archived, non-muted chat brings it back out of the archive
useStore.subscribe((s, prev) => {
  const cl = get();
  if (!cl.loaded) return;
  if (s.activeChatId && s.activeChatId !== prev.activeChatId && cl.unread.includes(s.activeChatId)) {
    const id = s.activeChatId;
    update((x) => ({ ...x, unread: x.unread.filter((i) => i !== id) }));
  }
  if (s.chats === prev.chats || !cl.archived.length) return;
  const meId = s.me?.id;
  const out = cl.archived.filter((id) => {
    const c = s.chats[id];
    const p = prev.chats[id];
    return c && p && c.lastSeq > p.lastSeq && !!c.lastMessage && c.lastMessage.senderId !== meId && !isNotifyOff(c);
  });
  if (out.length) update((x) => ({ ...x, archived: x.archived.filter((i) => !out.includes(i)) }));
});

// chats that no longer exist are dropped from the lists on the next change
export function pruneMissing() {
  const chats = useStore.getState().chats;
  const cl = get();
  const gone = (id: string) => !chats[id];
  if (cl.pinned.some(gone) || cl.archived.some(gone) || cl.unread.some(gone) || cl.folders.some((f) => f.chats.some(gone)))
    update((x) => ({
      ...x,
      pinned: x.pinned.filter((i) => !gone(i)),
      archived: x.archived.filter((i) => !gone(i)),
      unread: x.unread.filter((i) => !gone(i)),
      folders: x.folders.map((f) => ({ ...f, chats: f.chats.filter((i) => !gone(i)) })),
    }));
}
