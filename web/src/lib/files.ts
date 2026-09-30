/**
 * Attachments: preparing (thumbnails, metadata stripping), encrypted upload, download + decrypt with caching.
 */
import * as C from '../crypto/core';
import { ApiError, api, backToGate } from './api';
import { tr } from './i18n';
import { dropResume, findResume, fingerprint, putResume, saveHandleFor, setActive, type FileBase, type ResumeRec } from './resume';

/** Up to this size files are encrypted in memory and uploaded in one request; above it: streamed in parts. */
export const MAX_FILE = 90 * 1024 * 1024;
export const MAX_LARGE_FILE = 2048 * 1024 * 1024;
const MAX_IMAGE_DIM = 4096;
const THUMB_DIM = 240;

export interface PreparedFile {
  /** small files: plaintext in memory */
  bytes?: Uint8Array;
  /** large files: read from disk piece by piece while encrypting */
  source?: Blob;
  size: number;
  kind: C.FileKind;
  name: string;
  mime: string;
  w?: number;
  h?: number;
  duration?: number;
  thumb?: string;
}

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(sec?: number) {
  if (!sec || !isFinite(sec)) return '0:00';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function canvasTo(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, quality));
}

function drawScaled(src: CanvasImageSource, w: number, h: number, max: number) {
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function thumbnailOf(src: CanvasImageSource, w: number, h: number) {
  const c = drawScaled(src, w, h, THUMB_DIM);
  return c.toDataURL('image/jpeg', 0.5);
}

/**
 * Photos are re-encoded through a canvas: this drops EXIF (GPS location, camera serial, …).
 * "Send as file" keeps the original bytes untouched.
 */
async function prepareImage(file: File, asFile: boolean): Promise<PreparedFile> {
  const bmp = await createImageBitmap(file);
  const { width: w, height: h } = bmp;
  const thumb = await thumbnailOf(bmp, w, h);
  if (asFile || file.type === 'image/gif') {
    bmp.close();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { bytes, size: bytes.length, kind: asFile ? 'file' : 'image', name: file.name, mime: file.type, w, h, thumb };
  }
  const c = drawScaled(bmp, w, h, MAX_IMAGE_DIM);
  bmp.close();
  const png = file.type === 'image/png';
  const blob = await canvasTo(c, png ? 'image/png' : 'image/jpeg', png ? undefined : 0.9);
  const name = file.name.replace(/\.[^.]+$/, '') + (png ? '.png' : '.jpg');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, size: bytes.length, kind: 'image', name, mime: blob.type, w: c.width, h: c.height, thumb };
}

function mediaMeta(file: Blob, video: boolean): Promise<{ duration?: number; w?: number; h?: number; thumb?: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(video ? 'video' : 'audio') as HTMLVideoElement;
    el.preload = 'metadata';
    el.muted = true;
    let done = false;
    const finish = (r: { duration?: number; w?: number; h?: number; thumb?: string }) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(r);
    };
    setTimeout(() => finish({}), 4000);
    el.onerror = () => finish({});
    el.onloadedmetadata = () => {
      const duration = isFinite(el.duration) ? el.duration : undefined;
      if (!video) return finish({ duration });
      el.currentTime = Math.min(0.1, (duration ?? 1) / 2);
      el.onseeked = async () => {
        try {
          finish({ duration, w: el.videoWidth, h: el.videoHeight, thumb: await thumbnailOf(el, el.videoWidth, el.videoHeight) });
        } catch {
          finish({ duration, w: el.videoWidth, h: el.videoHeight });
        }
      };
    };
    el.src = url;
  });
}

export async function prepareFile(file: File, asFile = false): Promise<PreparedFile> {
  const type = file.type || 'application/octet-stream';
  if (file.size > MAX_LARGE_FILE) throw new Error(tr('「{v0}」超过 2 GB', { v0: file.name }));
  if (file.size > MAX_FILE) return { source: file, size: file.size, kind: 'file', name: file.name || 'file', mime: type };
  if (type.startsWith('image/') && type !== 'image/svg+xml') {
    try {
      return await prepareImage(file, asFile);
    } catch {
      /* undecodable image (e.g. HEIC) → plain file */
    }
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = bytes.length;
  if (!asFile && type.startsWith('video/')) return { bytes, size, kind: 'video', name: file.name, mime: type, ...(await mediaMeta(file, true)) };
  if (!asFile && type.startsWith('audio/')) return { bytes, size, kind: 'audio', name: file.name, mime: type, ...(await mediaMeta(file, false)) };
  return { bytes, size, kind: 'file', name: file.name || 'file', mime: type };
}

export async function prepareVoice(blob: Blob, duration: number): Promise<PreparedFile> {
  const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, size: bytes.length, kind: 'voice', name: `voice.${ext}`, mime: blob.type || 'audio/webm', duration };
}

/** Upload ciphertext with progress (XHR, because fetch has no upload progress). */
export function uploadBlob(chatId: string, ct: Uint8Array, onProgress?: (p: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/chats/${chatId}/blobs`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let j: any = {};
      try {
        j = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status === 403 && (j.error === 'ip_not_allowed' || j.error === 'ip_blocked')) backToGate();
      if (xhr.status >= 200 && xhr.status < 300) resolve(j.blobId);
      else reject(new ApiError(xhr.status, j.error ?? 'upload_failed', j.message ?? tr('上传失败')));
    };
    xhr.onerror = () => reject(new Error(tr('网络错误，上传失败')));
    xhr.send(new Blob([ct as Uint8Array<ArrayBuffer>]));
  });
}

export async function fetchBlob(blobId: string): Promise<Uint8Array> {
  const res = await fetch(`/api/blobs/${blobId}`, { credentials: 'same-origin' }).catch(() => {
    throw new Error(tr('网络不可用，暂时无法加载附件'));
  });
  if (!res.ok) throw new Error(res.status === 404 ? tr('附件已被删除') : tr('下载失败'));
  return new Uint8Array(await res.arrayBuffer());
}

// ------------------------------------------------------------------ large files (chunked, resumable)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function putPart(uploadId: string, offset: number, part: Uint8Array, onProgress?: (loaded: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/uploads/${uploadId}?offset=${offset}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () => {
      let j: any = {};
      try {
        j = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status === 403 && (j.error === 'ip_not_allowed' || j.error === 'ip_blocked')) backToGate();
      if (xhr.status >= 200 && xhr.status < 300) resolve(j.received);
      else reject(new ApiError(xhr.status, j.error ?? 'upload_failed', j.message ?? tr('上传失败')));
    };
    xhr.onerror = () => reject(new TypeError('network'));
    xhr.send(new Blob([part as Uint8Array<ArrayBuffer>]));
  });
}

/** Upload one part, retrying through network drops (resuming at whatever the server already has). */
async function sendPart(uploadId: string, offset: number, part: Uint8Array, onProgress: (loaded: number) => void) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await putPart(uploadId, offset, part, onProgress);
    } catch (e) {
      const retryable = !(e instanceof ApiError) || e.status >= 500 || e.code === 'busy' || e.code === 'upload_failed';
      if (!retryable || attempt >= 12) throw e instanceof ApiError && e.status < 500 ? e : new NetworkUploadError(tr('网络错误，上传失败。恢复联网后可以继续上传，已上传的部分不会重传。'));
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      try {
        const st = await api.get(`/api/uploads/${uploadId}`);
        if (st.received >= offset + part.length) return st.received; // it did arrive after all
      } catch {
        /* still offline — keep waiting */
      }
    }
  }
}

async function startUpload(chatId: string, ctSize: number): Promise<{ uploadId: string; partSize: number }> {
  return api.post(`/api/chats/${chatId}/uploads`, { size: ctSize });
}
async function finishUpload(uploadId: string): Promise<string> {
  return (await api.post(`/api/uploads/${uploadId}/finish`)).blobId;
}

/** Upload stopped by the network (the upload stays on the server and can be continued). */
export class NetworkUploadError extends Error {}

/**
 * Encrypt a large file while reading it, and upload the ciphertext in parts. Nothing larger than one part is in memory.
 * With `base` (the message the file belongs to), progress is remembered after every part, so the upload can be
 * continued — after a network drop or a page reload — from the last part the server confirmed.
 */
export async function uploadLarge(chatId: string, source: Blob, onProgress?: (p: number) => void, base?: FileBase) {
  const total = C.fileCtSize(source.size);
  let rec = base ? findResume(chatId, source) : undefined;
  let start: { uploadId: string; partSize: number; sent: number; plainOff: number };
  let enc: ReturnType<typeof C.resumableEncryptor>;
  const fp = base ? await fingerprint(source) : '';
  if (rec) {
    // continue only if it is the same file and the server still has the upload
    const st = rec.fp === fp && rec.total === total ? await api.get(`/api/uploads/${rec.uploadId}`).catch(() => null) : null;
    // The server must hold exactly what we recorded — or also the part that was in flight, if the re-picked file
    // has the same bytes there (then resending it produces identical ciphertext). Anything else: start over, so
    // different data is never encrypted at the same keystream position.
    let ok = !!st && st.size === total && st.received >= rec.sent;
    if (ok && st.received !== rec.sent) {
      const f = rec.inflight;
      ok = !!f && st.received === f.ctEnd && (await hashRange(source, rec.plainOff, f.plainEnd)) === f.hash;
    }
    if (!ok) {
      if (st) api.del(`/api/uploads/${rec.uploadId}`).catch(() => undefined);
      dropResume(rec.uploadId);
      rec = undefined;
    }
  }
  if (rec) {
    enc = C.resumableEncryptor({ key: rec.key, header: rec.header, state: rec.state });
    const partSize = (await api.get(`/api/uploads/${rec.uploadId}`)).partSize as number;
    start = { uploadId: rec.uploadId, partSize, sent: rec.sent, plainOff: rec.plainOff };
  } else {
    enc = C.resumableEncryptor();
    const up = await startUpload(chatId, total);
    start = { ...up, sent: 0, plainOff: 0 };
  }
  const { uploadId, partSize } = start;
  const file = source as File;
  let lastRec: ResumeRec | null = null;
  const remember = (sent: number, plainOff: number) => {
    if (!base) return;
    lastRec = {
      uploadId,
      chatId,
      name: file.name ?? '',
      size: source.size,
      lastModified: file.lastModified ?? 0,
      fp,
      key: enc.key,
      header: enc.header,
      state: enc.state(),
      sent,
      plainOff,
      total,
      base,
      updatedAt: Date.now(),
    };
    if (!sent) saveHandleFor(uploadId, file); // first record of this upload: keep the file's handle if we have one
    putResume(lastRec);
  };
  setActive(uploadId, true);
  try {
    const part = new Uint8Array(partSize + enc.chunk + 64);
    let fill = 0;
    let sent = start.sent;
    const nChunks = Math.max(1, Math.ceil(source.size / enc.chunk));
    let idx = start.plainOff / enc.chunk;
    if (!rec) remember(0, 0);
    else lastRec = rec;
    onProgress?.(sent / total);
    let ph = C.hasher();
    const flush = async () => {
      const data = part.slice(0, fill);
      // before sending: note which plaintext this part covers (see the resume check above)
      if (lastRec) putResume((lastRec = { ...lastRec, inflight: { ctEnd: sent + data.length, plainEnd: Math.min(source.size, idx * enc.chunk), hash: ph.digest() }, updatedAt: Date.now() }));
      ph = C.hasher();
      await sendPart(uploadId, sent, data, (l) => onProgress?.((sent + l) / total));
      sent += data.length;
      fill = 0;
      remember(sent, Math.min(source.size, idx * enc.chunk));
    };
    const READ = 4 * 1024 * 1024; // a multiple of the crypto chunk size, so chunks never straddle two reads
    for (let pos = start.plainOff; pos < source.size; pos += READ) {
      const buf = new Uint8Array(await source.slice(pos, Math.min(source.size, pos + READ)).arrayBuffer());
      for (let o = 0; o < buf.length; o += enc.chunk) {
        const plain = buf.subarray(o, Math.min(buf.length, o + enc.chunk));
        ph.update(plain);
        const c = enc.push(plain, ++idx === nChunks);
        part.set(c, fill);
        fill += c.length;
        if (fill >= partSize) await flush();
      }
    }
    if (fill) await flush();
    const blobId = await finishUpload(uploadId);
    dropResume(uploadId);
    return { blobId, key: enc.key, header: enc.header, chunk: enc.chunk };
  } catch (e) {
    // a network drop keeps the upload (and our progress) for later; anything else abandons it
    if (!(e instanceof NetworkUploadError && base)) {
      api.del(`/api/uploads/${uploadId}`).catch(() => undefined);
      dropResume(uploadId);
    }
    throw e;
  } finally {
    setActive(uploadId, false);
  }
}

async function hashRange(f: Blob, from: number, to: number) {
  const h = C.hasher();
  for (let p = from; p < to; p += 4 * 1024 * 1024) h.update(new Uint8Array(await f.slice(p, Math.min(to, p + 4 * 1024 * 1024)).arrayBuffer()));
  return h.digest();
}

/** Give up an interrupted upload. */
export function abandonUpload(uploadId: string) {
  api.del(`/api/uploads/${uploadId}`).catch(() => undefined);
  dropResume(uploadId);
}

async function fetchRange(blobId: string, start: number, end: number): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`/api/blobs/${blobId}`, { credentials: 'same-origin', headers: { range: `bytes=${start}-${end}` } });
      if (res.status === 404) throw new ApiError(404, 'not_found', tr('附件已被删除'));
      if (res.status !== 206) throw new ApiError(res.status, 'download_failed', tr('下载失败'));
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if ((e instanceof ApiError && e.status < 500) || attempt >= 8) throw e instanceof ApiError ? e : new Error(tr('网络错误，下载失败'));
      await sleep(Math.min(20_000, 1000 * 2 ** attempt));
    }
  }
}

/** Copy an encrypted attachment into another chat (forwarding) without decrypting it. */
export async function transferBlob(p: C.FilePayload, targetChatId: string, onProgress?: (p: number) => void): Promise<string> {
  const ctSize = C.fileCtSize(p.size, p.chunk);
  if (ctSize <= MAX_FILE + 1024 * 1024) return uploadBlob(targetChatId, await fetchBlob(p.blobId), onProgress);
  const { uploadId, partSize } = await startUpload(targetChatId, ctSize);
  try {
    for (let off = 0; off < ctSize; off += partSize) {
      const data = await fetchRange(p.blobId, off, Math.min(ctSize, off + partSize) - 1);
      await sendPart(uploadId, off, data, (l) => onProgress?.((off + l) / ctSize));
    }
    return await finishUpload(uploadId);
  } catch (e) {
    api.del(`/api/uploads/${uploadId}`).catch(() => undefined);
    throw e;
  }
}

export const isLarge = (p: C.FilePayload) => C.fileCtSize(p.size, p.chunk) > MAX_FILE + 1024 * 1024;

/**
 * Download + decrypt a large attachment piece by piece. With the File System Access API (desktop Chrome/Edge)
 * the plaintext streams straight to disk; otherwise it is collected as Blob parts (which browsers page to disk).
 */
export async function saveLarge(p: C.FilePayload, onProgress?: (p: number) => void) {
  const dec = C.fileDecryptor(p.key, p.header, p.chunk);
  const ctSize = C.fileCtSize(p.size, p.chunk);
  const step = dec.cchunk * 128; // ~8 MB, always whole crypto chunks
  type Writable = { write: (d: Uint8Array) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> };
  let writable: Writable | null = null;
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<Writable> }> }).showSaveFilePicker;
  if (picker) {
    try {
      writable = await (await picker({ suggestedName: p.name || 'file' })).createWritable();
    } catch (e) {
      if ((e as Error).name === 'AbortError') return; // user cancelled
      writable = null;
    }
  }
  const parts: Blob[] = [];
  try {
    for (let off = 0; off < ctSize; off += step) {
      const ct = await fetchRange(p.blobId, off, Math.min(ctSize, off + step) - 1);
      const plain: Uint8Array[] = [];
      for (let o = 0; o < ct.length; o += dec.cchunk) plain.push(dec.pull(ct.subarray(o, Math.min(ct.length, o + dec.cchunk))));
      const blob = new Blob(plain as Uint8Array<ArrayBuffer>[]);
      if (writable) await writable.write(new Uint8Array(await blob.arrayBuffer()));
      else parts.push(blob);
      onProgress?.(Math.min(1, (off + ct.length) / ctSize));
    }
    dec.done();
  } catch (e) {
    await writable?.abort?.().catch(() => undefined);
    throw e;
  }
  if (writable) return writable.close();
  const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = p.name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// decrypted object URLs, cached for the session
const urlCache = new Map<string, Promise<string>>();

export function fileUrl(p: C.FilePayload): Promise<string> {
  let u = urlCache.get(p.blobId);
  if (!u) {
    u = fetchBlob(p.blobId).then((ct) => {
      const pt = C.unpadAttachment(C.decryptFile(ct, p.key, p.header, p.chunk), p.size);
      // never let the browser sniff/execute: images/audio/video get their type, everything else is a download
      const safeMime = /^(image\/(png|jpeg|gif|webp|avif)|video\/|audio\/)/.test(p.mime) ? p.mime : 'application/octet-stream';
      return URL.createObjectURL(new Blob([pt as Uint8Array<ArrayBuffer>], { type: safeMime }));
    });
    u.catch(() => urlCache.delete(p.blobId));
    urlCache.set(p.blobId, u);
  }
  return u;
}

export async function downloadFile(p: C.FilePayload) {
  const url = await fileUrl(p);
  const a = document.createElement('a');
  a.href = url;
  a.download = p.name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function clearFileCache() {
  for (const u of urlCache.values()) u.then((x) => URL.revokeObjectURL(x)).catch(() => undefined);
  urlCache.clear();
}

/** Voice recorder (MediaRecorder with Opus where available). */
export class VoiceRecorder {
  private rec?: MediaRecorder;
  private chunks: Blob[] = [];
  private started = 0;
  private stream?: MediaStream;

  static supported() {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    this.started = Date.now();
  }

  elapsed() {
    return this.started ? (Date.now() - this.started) / 1000 : 0;
  }

  stop(): Promise<{ blob: Blob; duration: number }> {
    return new Promise((resolve) => {
      const duration = this.elapsed();
      this.rec!.onstop = () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        resolve({ blob: new Blob(this.chunks, { type: this.rec!.mimeType || 'audio/webm' }), duration });
      };
      this.rec!.stop();
    });
  }

  cancel() {
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
