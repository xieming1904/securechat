/**
 * v0.6 personal data backup / restore (.scbackup).
 * What's in it: contact names & notes (and which keys I verified), saved messages, stickers, chat list (pins,
 * archive, folders), synced settings, privacy switches, block list. Attachments of saved items and stickers are
 * included decrypted (inside the encrypted file) up to 25 MB each / 150 MB in total.
 * Not in it: messages (they stay on the server; use chat export for those), keys, passwords, two-step verification.
 * The file is encrypted with a passphrase (Argon2id + XChaCha20-Poly1305, same as chat archives).
 * Import merges into the current account — nothing already there is removed or overwritten.
 */
import * as C from '../crypto/core';
import { fetchBlob, uploadBlob } from './files';
import { useStore, toast } from './store';
import { useSocial, putVault, saveContact, block, setPrivacy, addStickerFromFile, type Contact, type SavedItem, type Privacy } from './social';
import { useChatList, importChatList, type ChatList } from './chatlist';
import { SYNCED, setPrefs, usePrefs, type SyncedPrefs } from './prefs';
import { sanitize as sanitizePrefs } from './prefsync';
import { tr } from './i18n';

const MAX_ONE = 25 * 1024 * 1024;
const MAX_TOTAL = 150 * 1024 * 1024;
const KIND = 'securechat-personal';

interface FileBlob {
  mime: string;
  data: string; // base64 plaintext
}
export interface PersonalBackup {
  kind: typeof KIND;
  v: 1;
  exportedAt: number;
  username: string;
  contacts: Record<string, Contact>;
  saved: (Omit<SavedItem, 'id'> & { files?: Record<string, FileBlob> })[];
  stickers: FileBlob[];
  chatlist: Partial<ChatList>;
  prefs: Partial<SyncedPrefs>;
  privacy: Privacy;
  blocked: string[];
}

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const filesOfCount = (p: C.Payload) => filesOf(p).length;

/** Files of a payload (a file, or the files inside a merged-forward bundle). */
function filesOf(p: C.Payload): C.FilePayload[] {
  if (p.t === 'file') return [p];
  if (p.t === 'bundle') return p.items.map((i) => i.p).filter((x): x is C.FilePayload => x.t === 'file');
  return [];
}

export async function exportPersonal(passphrase: string, onProgress: (s: string) => void) {
  const me = useStore.getState().me!;
  const so = useSocial.getState();
  let total = 0;
  let skipped = 0;
  const grab = async (f: C.FilePayload): Promise<FileBlob | null> => {
    if (!f.blobId || f.size > MAX_ONE || total + f.size > MAX_TOTAL) return (skipped++, null);
    try {
      const pt = C.unpadAttachment(C.decryptFile(await fetchBlob(f.blobId), f.key, f.header, f.chunk), f.size);
      total += pt.length;
      return { mime: f.mime, data: b64(pt) };
    } catch {
      skipped++;
      return null;
    }
  };
  const saved: PersonalBackup['saved'] = [];
  let i = 0;
  for (const s of so.saved) {
    onProgress(tr('正在打包收藏 {v0}/{v1}…', { v0: ++i, v1: so.saved.length }));
    const files: Record<string, FileBlob> = {};
    for (const f of filesOf(s.p)) {
      const got = await grab(f);
      if (got) files[f.blobId] = got;
    }
    const { id: _id, ...rest } = s;
    saved.push({ ...rest, files });
  }
  const stickers: FileBlob[] = [];
  i = 0;
  for (const st of so.stickers) {
    onProgress(tr('正在打包贴纸 {v0}/{v1}…', { v0: ++i, v1: so.stickers.length }));
    const got = await grab(st.p);
    if (got) stickers.push(got);
  }
  const { loaded: _l, ...cl } = useChatList.getState();
  const prefs = Object.fromEntries(SYNCED.map((k) => [k, usePrefs.getState()[k]])) as Partial<SyncedPrefs>;
  const data: PersonalBackup = {
    kind: KIND,
    v: 1,
    exportedAt: Date.now(),
    username: me.username,
    contacts: so.contacts,
    saved,
    stickers,
    chatlist: cl,
    prefs,
    privacy: so.privacy,
    blocked: so.blocked.map((b) => b.id),
  };
  onProgress(tr('正在加密…'));
  const sealed = C.sealArchive(new TextEncoder().encode(JSON.stringify(data)), passphrase);
  download(sealed, `密聊个人数据-${me.username}-${new Date().toISOString().slice(0, 10)}.scbackup`);
  return { saved: saved.length, stickers: stickers.length, contacts: Object.keys(so.contacts).length, skipped };
}

export const MAX_BACKUP_FILE = 300 * 1024 * 1024;
const own = (o: unknown, k: string) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : undefined);

export function openPersonal(bytes: Uint8Array, passphrase: string): PersonalBackup {
  if (bytes.length > MAX_BACKUP_FILE) throw new Error(tr('文件太大，不是有效的个人数据备份'));
  let raw: Uint8Array;
  try {
    raw = C.openArchive(bytes, passphrase);
  } catch {
    throw new Error(tr('口令不对，或者文件已损坏'));
  }
  const d = JSON.parse(new TextDecoder().decode(raw)) as PersonalBackup;
  if (d?.kind !== KIND || d.v !== 1) throw new Error(tr('这不是个人数据备份文件（聊天存档请在「打开存档」里查看）'));
  return d;
}

/** Merge a backup into the current account. Returns what was added. */
export async function importPersonal(d: PersonalBackup, onProgress: (s: string) => void) {
  const so = useSocial.getState();
  const me = useStore.getState().me!;
  const res = { contacts: 0, saved: 0, stickers: 0, blocked: 0 };
  // contacts: fill in what I don't have yet
  for (const [uid, c] of Object.entries(d.contacts ?? {})) {
    if (uid === me.id || !/^[A-Za-z0-9_-]{1,64}$/.test(uid) || own(so.contacts, uid) || !c || typeof c !== 'object') continue;
    // a verification mark only means something if it was made here: an imported one is kept only as a reminder
    // of which key was verified, and still checked against the person's current key before it shows "verified"
    const verifiedKey = str(c.verifiedKey, 100);
    await saveContact(uid, { alias: str(c.alias, 64), note: str(c.note, 2000), verifiedKey, verifiedAt: verifiedKey && typeof c.verifiedAt === 'number' ? c.verifiedAt : undefined }).catch(() => undefined);
    res.contacts++;
  }
  // saved items: attachments are re-encrypted with new keys into my personal space
  const seen = new Set(so.saved.map((s) => `${s.at}|${s.from}|${JSON.stringify(s.p).length}`));
  let i = 0;
  for (const s of d.saved ?? []) {
    onProgress(tr('正在导入收藏 {v0}/{v1}…', { v0: ++i, v1: d.saved.length }));
    const p0 = C.validatePayload(s.p);
    if (!p0 || seen.has(`${s.at}|${s.from}|${JSON.stringify(s.p).length}`)) continue;
    const blobIds: string[] = [];
    if (filesOfCount(p0) > 10) continue; // same limit as saving normally
    const reup = async (f: C.FilePayload): Promise<C.Payload> => {
      const fb = own(s.files, f.blobId) ? s.files![f.blobId] : undefined;
      if (!fb || typeof fb.data !== 'string') return { t: 'text', text: tr('[附件「{v0}」没有包含在备份里]', { v0: f.name }) };
      const enc = C.encryptFile(C.padAttachment(unb64(fb.data)));
      const blobId = await uploadBlob('self', enc.ciphertext);
      blobIds.push(blobId);
      return { ...f, blobId, key: enc.key, header: enc.header, chunk: enc.chunk };
    };
    let p: C.Payload = p0;
    try {
      if (p.t === 'file') p = await reup(p);
      else if (p.t === 'bundle')
        p = { ...p, items: await Promise.all(p.items.map(async (it) => (it.p.t === 'file' ? ({ ...it, p: (await reup(it.p)) as C.BundleItem['p'] } as C.BundleItem) : it))) };
      await putVault('saved', C.randomId(), { savedAt: s.savedAt, from: s.from, chatTitle: s.chatTitle, at: s.at, p }, blobIds.slice(0, 10));
      res.saved++;
    } catch (e) {
      toast((e as Error).message);
    }
  }
  i = 0;
  for (const st of d.stickers ?? []) {
    onProgress(tr('正在导入贴纸 {v0}/{v1}…', { v0: ++i, v1: d.stickers.length }));
    if (useSocial.getState().stickers.length >= 500) break;
    try {
      await addStickerFromFile(new File([unb64(st.data) as Uint8Array<ArrayBuffer>], 'sticker', { type: st.mime }));
      res.stickers++;
    } catch {
      /* not an image any more */
    }
  }
  if (d.chatlist) importChatList(d.chatlist);
  if (d.prefs && typeof d.prefs === 'object') {
    const p = sanitizePrefs(d.prefs as Record<string, unknown>);
    const rank = { none: 0, sender: 1, full: 2 } as const;
    const cur = usePrefs.getState().notifyPreview;
    setPrefs({
      ...(p.chatBg ? { chatBg: p.chatBg } : {}),
      // notification previews: only ever made more private by an import
      ...(p.notifyPreview && rank[p.notifyPreview] < rank[cur] ? { notifyPreview: p.notifyPreview } : {}),
      // privacy-related: only ever made stricter by an import
      callRelayOnly: usePrefs.getState().callRelayOnly || !!p.callRelayOnly,
      privacyScreen: usePrefs.getState().privacyScreen || !!p.privacyScreen,
      noCache: [...new Set([...usePrefs.getState().noCache, ...(Array.isArray(p.noCache) ? p.noCache : [])])],
    });
  }
  if (d.privacy) await setPrivacy({ hideOnline: so.privacy.hideOnline || !!d.privacy.hideOnline, noReceipts: so.privacy.noReceipts || !!d.privacy.noReceipts, coarseOnline: !!so.privacy.coarseOnline || !!d.privacy.coarseOnline, pushDelay: !!so.privacy.pushDelay || !!d.privacy.pushDelay }).catch(() => undefined);
  for (const uid of Array.isArray(d.blocked) ? d.blocked.slice(0, 1000) : []) {
    if (typeof uid !== 'string' || uid === me.id || useSocial.getState().blocked.some((b) => b.id === uid)) continue;
    await block(uid)
      .then(() => res.blocked++)
      .catch(() => undefined);
  }
  return res;
}
