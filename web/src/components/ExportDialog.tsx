import { useMemo, useState } from 'react';
import { FileArchive, FileCode2, FolderOpen } from 'lucide-react';
import { exportEncrypted, exportHtml, openArchiveFile, SAFE_MIME, type Archive } from '../lib/exporter';
import type { Chat } from '../lib/store';
import { summarize, RichText } from './MessageParts';
import { Modal, Spinner } from './ui';
import { tr } from '../lib/i18n';

export function ExportDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const [fmt, setFmt] = useState<'archive' | 'html'>('archive');
  const [files, setFiles] = useState(true);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const ok = fmt === 'html' || (pw.length >= 8 && pw === pw2);
  const run = async () => {
    setBusy(true);
    setErr('');
    try {
      const n = fmt === 'archive' ? await exportEncrypted(chat, pw, files, setMsg) : await exportHtml(chat, files, setMsg);
      setMsg(tr('已导出 {v0} 条消息', { v0: n }));
    } catch (e) {
      setErr((e as Error).message);
      setMsg('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={tr('导出聊天记录')} onClose={onClose}>
      <div className="stack">
        <div className="choice-row">
          <button className={`choice ${fmt === 'archive' ? 'on' : ''}`} onClick={() => setFmt('archive')}>
            <FileArchive size={16} /> {tr('加密存档')}
          </button>
          <button className={`choice ${fmt === 'html' ? 'on' : ''}`} onClick={() => setFmt('html')}>
            <FileCode2 size={16} /> {tr('网页（可直接阅读）')}
          </button>
        </div>
        <p className="muted small">
          {fmt === 'archive'
            ? tr('用你设置的密码加密成一个文件，可以在任意设备的密聊里打开查看（设置 → 通知与存储 → 打开存档）。忘记密码就无法打开。')
            : tr('生成一个普通的网页文件，任何浏览器都能打开。注意：它没有加密，请妥善保管。')}
        </p>
        <label className="check">
          <input type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} /> {tr('包含图片和文件（单个 25 MB 以内，合计最多 150 MB）')}
        </label>
        {fmt === 'archive' && (
          <>
            <input type="password" placeholder={tr('存档密码（至少 8 位）')} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
            <input type="password" placeholder={tr('再输一次')} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
            {pw2 && pw !== pw2 && <p className="error small">{tr('两次输入不一致')}</p>}
          </>
        )}
        {msg && <p className="muted small inline-ic">{busy && <Spinner />} {msg}</p>}
        {err && <p className="error">{err}</p>}
        <button className="btn" disabled={!ok || busy} onClick={run}>
          {busy ? <Spinner /> : tr('导出')}
        </button>
      </div>
    </Modal>
  );
}

function ArchiveView({ a }: { a: Archive }) {
  const urls = useMemo(() => {
    const m: Record<string, string> = {};
    return m;
  }, []);
  const fileUrl = (blobId: string, mime: string) => {
    if (!urls[blobId] && a.files[blobId]) {
      const bin = atob(a.files[blobId]);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const safe = SAFE_MIME.test(mime) ? mime : 'application/octet-stream';
      urls[blobId] = URL.createObjectURL(new Blob([u], { type: safe }));
    }
    return urls[blobId];
  };
  return (
    <div className="bundle-view">
      <p className="muted small">{tr('「{v0}」· {v1} 导出 · {v2} 条消息', { v0: a.chat.title, v1: new Date(a.exportedAt).toLocaleString(), v2: a.messages.length })}</p>
      {a.messages.map((m, i) => (
        <div key={i} className="bundle-item">
          <div className="bundle-item-body">
            <div className="bundle-meta">
              <b>{m.from}</b> <span className="muted small">{new Date(m.at).toLocaleString()}</span>
            </div>
            {m.p.t === 'text' ? (
              <div className="text">
                <RichText text={m.p.text} />
              </div>
            ) : m.p.t === 'file' ? (
              a.files[m.p.blobId] ? (
                m.p.kind === 'image' ? (
                  <img className="archive-img" src={fileUrl(m.p.blobId, m.p.mime)} alt={m.p.name} />
                ) : (
                  <a className="link" href={fileUrl(m.p.blobId, m.p.mime)} download={m.p.name}>
                    📎 {m.p.name}
                  </a>
                )
              ) : (
                <span className="muted">{summarize(m.p)}</span>
              )
            ) : (
              <span className="muted">{summarize(m.p)}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Open a .scarchive file exported earlier. */
export function OpenArchiveButton() {
  const [file, setFile] = useState<Uint8Array | null>(null);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [a, setA] = useState<Archive | null>(null);
  return (
    <>
      <label className="btn secondary inline-ic">
        <FolderOpen size={16} /> {tr('打开导出的存档')}
        <input
          type="file"
          accept=".scarchive"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) setFile(new Uint8Array(await f.arrayBuffer()));
          }}
        />
      </label>
      {file && !a && (
        <Modal title={tr('打开加密存档')} onClose={() => setFile(null)}>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setErr('');
              setTimeout(() => {
                try {
                  setA(openArchiveFile(file, pw));
                } catch {
                  setErr(tr('密码不对，或文件已损坏'));
                } finally {
                  setBusy(false);
                }
              }, 30);
            }}
          >
            <input type="password" placeholder={tr('存档密码')} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
            {err && <p className="error">{err}</p>}
            <button className="btn" disabled={!pw || busy}>
              {busy ? <Spinner /> : tr('打开')}
            </button>
          </form>
        </Modal>
      )}
      {a && (
        <Modal title={a.chat.title} onClose={() => (setA(null), setFile(null), setPw(''))} wide>
          <ArchiveView a={a} />
        </Modal>
      )}
    </>
  );
}
