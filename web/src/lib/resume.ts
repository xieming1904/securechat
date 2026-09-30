/**
 * Large uploads that can continue after a page reload.
 * For every chunked upload in progress we keep: the server upload id, the file key + stream header, the encryption
 * state after the last part the server confirmed, and a fingerprint of the file. It is stored in IndexedDB encrypted
 * with this browser's non-extractable wrapping key (like the outbox). The file itself is NOT kept — after a reload
 * the user picks the same file again and we continue from where the server stopped, without re-uploading.
 */
import { create } from 'zustand';
import type { FilePayload, StreamState } from '../crypto/core';
import { getWrapKey, idbDel, idbGet, idbKeys, idbSet } from '../crypto/keystore';

export type FileBase = Omit<FilePayload, 'blobId' | 'key' | 'header' | 'chunk'>;
export interface ResumeRec {
  uploadId: string;
  chatId: string;
  name: string;
  size: number;
  lastModified: number;
  /** SHA-256 (b64) of the first and last MiB of the plaintext — makes sure the re-picked file is the same one */
  fp: string;
  key: string;
  header: string;
  state: StreamState;
  /** ciphertext bytes the server has confirmed */
  sent: number;
  /** plaintext bytes behind `sent` */
  plainOff: number;
  /** the part being sent when the record was written: where it ends and a hash of its plaintext */
  inflight?: { ctEnd: number; plainEnd: number; hash: string };
  total: number;
  base: FileBase;
  updatedAt: number;
}

let uid = '';
let key: CryptoKey | null = null;
let saving: Promise<unknown> = Promise.resolve();
const k = () => `resume:${uid}`;

/** Resumable uploads, and which of them are running in this tab right now. */
export const useResume = create<{ recs: ResumeRec[]; active: string[]; seen: string[] }>(() => ({ recs: [], active: [], seen: [] }));

export async function initResume(userId: string) {
  uid = userId;
  key = await getWrapKey(userId);
  useResume.setState({ recs: [], active: [], seen: [] });
  if (!key) return;
  const rec = await idbGet<{ iv: Uint8Array; ct: ArrayBuffer }>(k()).catch(() => undefined);
  if (!rec) return;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as Uint8Array<ArrayBuffer> }, key, rec.ct);
    const data = JSON.parse(new TextDecoder().decode(pt));
    // the server drops unfinished uploads after 24 h
    if (Array.isArray(data)) useResume.setState({ recs: data.filter((r: ResumeRec) => Date.now() - r.updatedAt < 23 * 3_600_000) });
  } catch {
    /* written with an older wrapping key */
  }
  // file handles of uploads that no longer exist
  const live = new Set(useResume.getState().recs.map((r) => r.uploadId));
  for (const k of (await idbKeys().catch(() => [])) as IDBValidKey[])
    if (typeof k === 'string' && k.startsWith(`resume-h:${uid}:`) && !live.has(k.slice(`resume-h:${uid}:`.length))) await idbDel(k).catch(() => undefined);
}

/** Signed out (here or remotely): forget the saved file handles. */
export async function forgetResumeHandles() {
  for (const k of (await idbKeys().catch(() => [])) as IDBValidKey[]) if (typeof k === 'string' && k.startsWith('resume-h:')) await idbDel(k).catch(() => undefined);
}

function persist() {
  if (!key) return;
  const snapshot = useResume.getState().recs;
  saving = saving
    .then(async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key!, new TextEncoder().encode(JSON.stringify(snapshot)));
      await idbSet(k(), { iv, ct });
    })
    .catch(() => undefined);
}

export function putResume(r: ResumeRec) {
  useResume.setState((s) => ({ recs: [...s.recs.filter((x) => x.uploadId !== r.uploadId), r] }));
  persist();
}
// ---- v0.9: remember which file an upload came from (Chromium: File System Access handles survive a reload)
type Handle = { kind: 'file'; name: string; getFile(): Promise<File>; queryPermission?(o: unknown): Promise<string>; requestPermission?(o: unknown): Promise<string> };
const handles = new WeakMap<File, Handle>();
export function rememberHandle(file: File, h: unknown) {
  if (h && (h as Handle).kind === 'file') handles.set(file, h as Handle);
}
export async function saveHandleFor(uploadId: string, file: File) {
  const h = handles.get(file);
  if (h) await idbSet(`resume-h:${uid}:${uploadId}`, h).catch(() => undefined);
}
export async function hasHandle(uploadId: string) {
  return !!(await idbGet(`resume-h:${uid}:${uploadId}`).catch(() => undefined));
}
/** The same file again, without the file picker (asks for read permission once if the browser needs it). */
export async function fileFromHandle(uploadId: string): Promise<File | null> {
  const h = await idbGet<Handle>(`resume-h:${uid}:${uploadId}`).catch(() => undefined);
  if (!h) return null;
  const opts = { mode: 'read' };
  if (h.queryPermission && (await h.queryPermission(opts)) !== 'granted' && h.requestPermission && (await h.requestPermission(opts)) !== 'granted') return null;
  return h.getFile();
}

export function dropResume(uploadId: string) {
  idbDel(`resume-h:${uid}:${uploadId}`).catch(() => undefined);
  if (!useResume.getState().recs.some((x) => x.uploadId === uploadId)) return;
  useResume.setState((s) => ({ recs: s.recs.filter((x) => x.uploadId !== uploadId) }));
  persist();
}
export function setActive(uploadId: string, on: boolean) {
  // `seen`: started or continued in this tab — its message bubble (with a retry button) is still on screen
  useResume.setState((s) => ({
    active: on ? [...new Set([...s.active, uploadId])] : s.active.filter((x) => x !== uploadId),
    seen: on ? [...new Set([...s.seen, uploadId])] : s.seen,
  }));
}
export function forgetResume() {
  useResume.setState({ recs: [], active: [], seen: [] });
  key = null;
}

export function findResume(chatId: string, f: Blob) {
  const file = f as File;
  const { recs, active } = useResume.getState();
  // an upload that is running right now (the same file sent twice at once) is not taken over
  return recs.find((r) => !active.includes(r.uploadId) && r.chatId === chatId && r.name === file.name && r.size === f.size && r.lastModified === file.lastModified);
}

export async function fingerprint(f: Blob) {
  // first and last MiB (plus the size): enough to tell a different file apart without reading gigabytes
  const MB = 1024 * 1024;
  const head = new Uint8Array(await f.slice(0, MB).arrayBuffer());
  const tail = new Uint8Array(await f.slice(Math.max(0, f.size - MB)).arrayBuffer());
  const buf = new Uint8Array(head.length + tail.length);
  buf.set(head);
  buf.set(tail, head.length);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let s = '';
  for (const b of h) s += String.fromCharCode(b);
  return btoa(s);
}
