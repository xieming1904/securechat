/**
 * Chat export (v0.4), all done in the browser:
 *  - readable HTML (a single file you can open anywhere), optionally with pictures/files embedded
 *  - an encrypted archive (.scarchive): Argon2id + XChaCha20-Poly1305 with a passphrase you choose; can be opened
 *    again in 密聊 (Settings → Storage → Open archive) on any device.
 */
import * as C from '../crypto/core';
import { fetchBlob } from './files';
import { fetchAllMessages, useStore, type Chat, type Msg } from './store';
import { summarize } from '../components/MessageParts';
import { tr } from './i18n';

export interface ArchiveMsg {
  from: string;
  at: number;
  p: C.Payload;
}
export interface Archive {
  v: 1;
  exportedAt: number;
  chat: { title: string; type: string };
  exportedBy: string;
  messages: ArchiveMsg[];
  /** blobId → base64 plaintext */
  files: Record<string, string>;
}

const MAX_TOTAL = 150 * 1024 * 1024;
const MAX_ONE = 25 * 1024 * 1024; // bigger files are listed by name only (keeps the export in memory limits)
export const SAFE_MIME = /^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|ogg|webm|mp4|aac|wav)|video\/(mp4|webm|ogg))$/;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const b64std = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function collect(chat: Chat, includeFiles: boolean, onProgress: (s: string) => void) {
  const me = useStore.getState().me!;
  const name = (id: string) => (id === me.id ? me.displayName : chat.members.find((m) => m.id === id)?.displayName ?? tr('已退出的成员'));
  const msgs: Msg[] = await fetchAllMessages(chat.id, (n) => onProgress(tr('正在读取消息… {v0}', { v0: n })));
  const out: ArchiveMsg[] = msgs.filter((m) => m.payload && m.payload.t !== 'system').map((m) => ({ from: name(m.senderId), at: m.createdAt, p: m.payload! }));
  const files: Record<string, string> = {};
  if (includeFiles) {
    let total = 0;
    const want: C.FilePayload[] = [];
    for (const m of out) {
      if (m.p.t === 'file') want.push(m.p);
      if (m.p.t === 'bundle') for (const it of m.p.items) if (it.p.t === 'file') want.push(it.p);
    }
    let i = 0;
    for (const f of want) {
      i++;
      if (!f.blobId || files[f.blobId] || f.size > MAX_ONE || total + f.size > MAX_TOTAL) continue;
      onProgress(tr('正在下载并解密附件 {v0}/{v1}…', { v0: i, v1: want.length }));
      try {
        const pt = C.unpadAttachment(C.decryptFile(await fetchBlob(f.blobId), f.key, f.header, f.chunk), f.size);
        files[f.blobId] = b64std(pt);
        total += pt.length;
      } catch {
        /* deleted or expired attachment: skip */
      }
    }
  }
  return { me, out, files };
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'chat';
const stamp = () => new Date().toISOString().slice(0, 10);

export async function exportEncrypted(chat: Chat, passphrase: string, includeFiles: boolean, onProgress: (s: string) => void) {
  const { me, out, files } = await collect(chat, includeFiles, onProgress);
  onProgress(tr('正在加密…'));
  const archive: Archive = { v: 1, exportedAt: Date.now(), chat: { title: chat.title, type: chat.type }, exportedBy: me.displayName, messages: out, files };
  const sealed = C.sealArchive(new TextEncoder().encode(JSON.stringify(archive)), passphrase);
  download(new Blob([sealed as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), `${safeName(chat.title)}-${stamp()}.scarchive`);
  return out.length;
}

export function openArchiveFile(bytes: Uint8Array, passphrase: string): Archive {
  const a = JSON.parse(new TextDecoder().decode(C.openArchive(bytes, passphrase))) as Archive;
  if (a.v !== 1 || !Array.isArray(a.messages)) throw new Error(tr('不认识的存档格式'));
  a.messages = a.messages.filter((m) => C.validatePayload(m.p));
  return a;
}

/** Readable, self-contained HTML (no scripts). */
export async function exportHtml(chat: Chat, includeFiles: boolean, onProgress: (s: string) => void) {
  const { me, out, files } = await collect(chat, includeFiles, onProgress);
  const fileHtml = (f: C.FilePayload) => {
    const data = files[f.blobId];
    // the mime type comes from the (untrusted) sender: only exact, known values, never raw text in the HTML
    const mime = SAFE_MIME.test(f.mime) ? f.mime : 'application/octet-stream';
    if (data && f.kind === 'image') return `<img src="data:${esc(mime)};base64,${data}" alt="${esc(f.name)}">`;
    if (data) return `<a download="${esc(f.name)}" href="data:${esc(mime)};base64,${data}">📎 ${esc(f.name)}</a>`;
    return `<span class="f">📎 ${esc(f.name)}</span>`;
  };
  const body = out
    .map((m) => {
      let inner = '';
      const p = m.p;
      if (p.t === 'text') inner = esc(p.text).replace(/\n/g, '<br>');
      else if (p.t === 'file') inner = fileHtml(p) + (p.caption ? `<div>${esc(p.caption).replace(/\n/g, '<br>')}</div>` : '');
      else if (p.t === 'bundle')
        inner = `<div class="b"><b>${esc(p.title)}</b>${p.items.map((it) => `<div>${esc(it.from)}: ${it.p.t === 'file' ? fileHtml(it.p) : esc(it.p.t === 'text' ? it.p.text : summarize(it.p as C.Payload))}</div>`).join('')}</div>`;
      else inner = esc(summarize(p));
      return `<div class="m${m.from === me.displayName ? ' me' : ''}"><div class="h"><b>${esc(m.from)}</b> <time>${esc(new Date(m.at).toLocaleString())}</time></div><div class="c">${inner}</div></div>`;
    })
    .join('\n');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'">
<title>${esc(chat.title)} — ${esc(tr('聊天记录'))}</title>
<style>body{font:15px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#111;background:#f5f6fa}
h1{font-size:20px}.m{background:#fff;border-radius:12px;padding:8px 12px;margin:8px 0;box-shadow:0 1px 2px #0001}.m.me{background:#eef1ff}
.h{font-size:12px;color:#667}.c{white-space:normal;word-break:break-word}img{max-width:100%;border-radius:8px;margin-top:4px}.b{border-left:3px solid #4f6bff;padding-left:8px}
.f{color:#667}@media (prefers-color-scheme:dark){body{background:#0b0e14;color:#e6e8ef}.m{background:#151a25}.m.me{background:#1c2340}.h,.f{color:#99a}}</style></head>
<body><h1>${esc(chat.title)}</h1><p class="h">${esc(tr('由 {v0} 于 {v1} 从密聊导出，共 {v2} 条消息。此文件未加密，请妥善保管。', { v0: me.displayName, v1: new Date().toLocaleString(), v2: out.length }))}</p>
${body}</body></html>`;
  download(new Blob([html], { type: 'text/html;charset=utf-8' }), `${safeName(chat.title)}-${stamp()}.html`);
  return out.length;
}
