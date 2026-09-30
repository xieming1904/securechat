/**
 * Settings that follow me to my other devices (see SYNCED in prefs.ts), kept as one encrypted vault item.
 *
 * - Each saved copy carries a version (time of the change) inside the encryption; a device never applies a copy
 *   older than one it has already seen, so the server can't roll settings back by replaying an old item.
 * - The first time a device meets the synced copy, the two are MERGED towards privacy (union of "don't cache"
 *   chats, relay-only calls / privacy screen if either side had them on, link previews only if both had them on),
 *   so joining the sync never silently weakens this device's settings. After that, changes follow the newest copy.
 */
import * as C from '../crypto/core';
import { api } from './api';
import { myIdentity, onAppReady, onSocket, setChatCacheDisabled, useStore } from './store';
import { SYNCED, setPrefs, usePrefs, type SyncedPrefs } from './prefs';

const KIND = 'pref';
const ITEM = 'settings';
let applying = false;
let ready = false;
let timer: ReturnType<typeof setTimeout> | null = null;

type Versioned = Partial<SyncedPrefs> & { v: number };

const seenKey = () => `securechat.prefsync.v.${useStore.getState().me?.id ?? ''}`;
function seenVersion() {
  try {
    return Number(localStorage.getItem(seenKey())) || 0;
  } catch {
    return 0;
  }
}
function setSeen(v: number) {
  try {
    localStorage.setItem(seenKey(), String(v));
  } catch {
    /* ignore */
  }
}

const pick = (): SyncedPrefs => Object.fromEntries(SYNCED.map((k) => [k, usePrefs.getState()[k]])) as SyncedPrefs;

export function sanitize(x: Record<string, unknown>): Versioned {
  const out: Versioned = { v: typeof x.v === 'number' && Number.isFinite(x.v) ? x.v : 0 };
  if (typeof x.chatBg === 'string' && ['dots', 'plain', 'aurora', 'grid', 'paper'].includes(x.chatBg)) out.chatBg = x.chatBg as SyncedPrefs['chatBg'];
  if (Array.isArray(x.noCache)) out.noCache = x.noCache.filter((v): v is string => typeof v === 'string').slice(0, 5000);
  for (const k of ['linkPreview', 'callRelayOnly', 'privacyScreen'] as const) if (typeof x[k] === 'boolean') out[k] = x[k] as boolean;
  if (typeof x.notifyPreview === 'string' && ['none', 'sender', 'full'].includes(x.notifyPreview)) out.notifyPreview = x.notifyPreview as SyncedPrefs['notifyPreview'];
  return out;
}

function decrypt(r: { nonce: string; ciphertext: string }) {
  const id = myIdentity();
  const me = useStore.getState().me;
  if (!id || !me) return null;
  try {
    return sanitize(C.decryptVault<Record<string, unknown>>(r, id, me.id, KIND, ITEM));
  } catch {
    return null;
  }
}

const PREVIEW_RANK = { none: 0, sender: 1, full: 2 } as const;
/** First contact: combine this device's settings with the synced ones, keeping whichever is more private. */
function mergePrivate(local: SyncedPrefs, remote: Partial<SyncedPrefs>): Partial<SyncedPrefs> {
  return {
    ...remote,
    noCache: [...new Set([...local.noCache, ...(remote.noCache ?? [])])],
    callRelayOnly: local.callRelayOnly || !!remote.callRelayOnly,
    privacyScreen: local.privacyScreen || !!remote.privacyScreen,
    linkPreview: local.linkPreview && remote.linkPreview !== false,
    notifyPreview: remote.notifyPreview && PREVIEW_RANK[remote.notifyPreview] < PREVIEW_RANK[local.notifyPreview] ? remote.notifyPreview : local.notifyPreview,
  };
}

function applyPrefs(p: Partial<SyncedPrefs>) {
  applying = true;
  try {
    // chats newly excluded from the local cache on another device: purge them here too
    const before = new Set(usePrefs.getState().noCache);
    const { noCache, ...rest } = p;
    setPrefs(rest);
    if (noCache) {
      for (const id of noCache) if (!before.has(id)) setChatCacheDisabled(id, true);
      for (const id of before) if (!noCache.includes(id)) setChatCacheDisabled(id, false);
    }
  } finally {
    applying = false;
  }
}

function upload() {
  const id = myIdentity();
  const me = useStore.getState().me;
  if (!id || !me) return;
  const v = Math.max(Date.now(), seenVersion() + 1);
  setSeen(v);
  api.put(`/api/vault/${KIND}/${ITEM}`, { ...C.encryptVault({ ...pick(), v }, id, me.id, KIND, ITEM), blobIds: [] }).catch(() => undefined);
}

/** A copy from the vault (at start or pushed live). */
function onRemote(p: Versioned | null) {
  if (!p) return;
  const seen = seenVersion();
  if (seen === 0) {
    // first time on this device: merge towards privacy, then publish the merged result
    applyPrefs(mergePrivate(pick(), p));
    upload();
    return;
  }
  if (p.v <= seen) return; // my own echo, or an older copy replayed
  setSeen(p.v);
  const { v: _v, ...rest } = p;
  applyPrefs(rest);
}

onAppReady(async () => {
  ready = false;
  const r = await api.get(`/api/vault/${KIND}`).catch(() => null);
  if (!r) return;
  const row = (r.items as { id: string; nonce: string; ciphertext: string }[]).find((x) => x.id === ITEM);
  if (row) onRemote(decrypt(row));
  else upload();
  ready = true;
});
onSocket((s) =>
  s.on('vault', ({ kind, id, item }: { kind: string; id: string; item: { nonce: string; ciphertext: string } | null }) => {
    if (kind === KIND && id === ITEM && item && ready) onRemote(decrypt(item));
  }),
);

usePrefs.subscribe((s, prev) => {
  if (applying || !ready) return;
  if (!SYNCED.some((k) => JSON.stringify(s[k]) !== JSON.stringify(prev[k]))) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => ((timer = null), upload()), 600);
});
