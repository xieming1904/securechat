import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Image as ImageIcon, FileText, Mic, Link2, Play, Download, Loader2 } from 'lucide-react';
import type { FilePayload } from '../crypto/core';
import { fetchAllMessages, fetchMediaPage, openMessage, useStore, type Chat, type Msg } from '../lib/store';
import { cachedMessages } from '../lib/localcache';
import { downloadFile, fileUrl, formatDuration, formatSize } from '../lib/files';
import { fullTime } from '../lib/format';
import { Lightbox } from './MessageParts';
import { Modal, Spinner } from './ui';
import { useNameFor } from '../lib/social';
import { tr } from '../lib/i18n';

type Tab = 'media' | 'files' | 'voice' | 'links';
interface Item {
  msg: Msg;
  p: FilePayload;
}
const URL_RE = /\bhttps?:\/\/[^\s<>"'）)]+/gi;

/** Files of a message (a single attachment, or the ones inside a merged forward). */
function filesOf(m: Msg): FilePayload[] {
  const p = m.payload;
  if (!p) return [];
  if (p.t === 'file') return p.sticker ? [] : [p];
  if (p.t === 'bundle') return p.items.map((i) => i.p).filter((x): x is FilePayload => x.t === 'file' && !x.sticker);
  return [];
}

function Thumb({ p }: { p: FilePayload }) {
  const [url, setUrl] = useState<string | null>(p.thumb ?? null);
  useEffect(() => {
    if (p.thumb || p.kind !== 'image' || p.size > 8 * 1024 * 1024) return;
    let live = true;
    fileUrl(p)
      .then((u) => live && setUrl(u))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [p.blobId]); // eslint-disable-line react-hooks/exhaustive-deps
  return url ? <img src={url} alt="" draggable={false} /> : <ImageIcon size={22} className="muted" />;
}

/** Chat info → "Shared media": photos & videos, files, voice messages and links, newest first. */
export function SharedMedia({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('media');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [next, setNext] = useState<number | undefined>(undefined);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState<FilePayload | null>(null);
  const [allText, setAllText] = useState<Msg[] | null>(null);
  const loaded = useStore((s) => s.messages[chat.id]);
  const nameOf = useNameFor();
  const sender = (id: string) => {
    const me = useStore.getState().me!;
    if (id === me.id) return tr('我');
    const m = chat.members.find((x) => x.id === id);
    return m ? nameOf(m.id, m.displayName) : tr('已退出的成员');
  };

  const loadMore = async () => {
    if (busy || !more) return;
    setBusy(true);
    try {
      const r = await fetchMediaPage(chat.id, next);
      setMsgs((cur) => [...cur, ...r.messages.filter((m) => !cur.some((c) => c.id === m.id))]);
      setNext(r.next);
      setMore(r.hasMore);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    loadMore();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const items: Item[] = useMemo(() => msgs.flatMap((m) => filesOf(m).map((p) => ({ msg: m, p }))), [msgs]);
  const media = items.filter((i) => i.p.kind === 'image' || i.p.kind === 'video');
  const files = items.filter((i) => i.p.kind === 'file' || i.p.kind === 'audio');
  const voice = items.filter((i) => i.p.kind === 'voice');
  // links: from what this device has (loaded + encrypted local cache), or everything after "search all"
  const links = useMemo(() => {
    const src: { id: string; senderId: string; createdAt: number; seq: number; text: string }[] = [];
    const seen = new Set<string>();
    const add = (id: string, senderId: string, createdAt: number, seq: number, p: Msg['payload']) => {
      if (seen.has(id) || !p) return;
      const text = p.t === 'text' ? p.text : p.t === 'file' ? p.caption ?? '' : '';
      if (!text) return;
      seen.add(id);
      src.push({ id, senderId, createdAt, seq, text });
    };
    for (const m of allText ?? []) add(m.id, m.senderId, m.createdAt, m.seq, m.payload);
    for (const m of loaded ?? []) add(m.id, m.senderId, m.createdAt, m.seq, m.payload);
    for (const m of cachedMessages(chat.id)) add(m.id, m.senderId, m.createdAt, m.seq, m.payload);
    const out: { url: string; id: string; senderId: string; createdAt: number; seq: number }[] = [];
    for (const m of src.sort((a, b) => b.seq - a.seq)) for (const u of m.text.match(URL_RE) ?? []) out.push({ url: u, id: m.id, senderId: m.senderId, createdAt: m.createdAt, seq: m.seq });
    return out;
  }, [allText, loaded, chat.id]);

  const jump = (m: { id: string; seq: number }) => {
    onClose();
    openMessage(chat.id, m.id, m.seq);
  };
  const tabs: [Tab, string, ReactNode, number][] = [
    ['media', tr('图片和视频'), <ImageIcon size={15} />, media.length],
    ['files', tr('文件'), <FileText size={15} />, files.length],
    ['voice', tr('语音'), <Mic size={15} />, voice.length],
    ['links', tr('链接'), <Link2 size={15} />, links.length],
  ];
  const empty = <p className="muted small center">{busy ? '' : tr('这里还没有内容')}</p>;
  return (
    <Modal title={tr('共享内容')} onClose={onClose} wide>
      <nav className="tabs">
        {tabs.map(([k, l, icon, n]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {icon} {l}
            {n > 0 && <span className="muted small">{n}</span>}
          </button>
        ))}
      </nav>
      <div className="shared-body">
        {tab === 'media' &&
          (media.length ? (
            <div className="media-grid">
              {media.map((i) => (
                <button key={i.msg.id + i.p.blobId} className="media-cell" onClick={() => setLightbox(i.p)} title={fullTime(i.msg.createdAt)}>
                  <Thumb p={i.p} />
                  {i.p.kind === 'video' && (
                    <span className="media-badge">
                      <Play size={12} /> {i.p.duration ? formatDuration(i.p.duration) : ''}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            empty
          ))}
        {(tab === 'files' || tab === 'voice') &&
          ((tab === 'files' ? files : voice).length ? (
            <div className="shared-list">
              {(tab === 'files' ? files : voice).map((i) => (
                <div key={i.msg.id + i.p.blobId} className="shared-row">
                  <span className="shared-ic">{tab === 'voice' ? <Mic size={18} /> : <FileText size={18} />}</span>
                  <button className="link grow ellipsis left" onClick={() => jump(i.msg)} title={tr('跳到这条消息')}>
                    {tab === 'voice' ? tr('语音 {v0}', { v0: formatDuration(i.p.duration ?? 0) }) : i.p.name}
                    <span className="muted small block">
                      {sender(i.msg.senderId)} · {fullTime(i.msg.createdAt)} · {formatSize(i.p.size)}
                    </span>
                  </button>
                  <button className="icon-btn" onClick={() => downloadFile(i.p)} aria-label={tr('下载')}>
                    <Download size={17} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            empty
          ))}
        {tab === 'links' && (
          <>
            {links.length ? (
              <div className="shared-list">
                {links.map((l, k) => (
                  <div key={l.id + k} className="shared-row">
                    <span className="shared-ic">
                      <Link2 size={18} />
                    </span>
                    <div className="grow ellipsis">
                      <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="ellipsis block">
                        {l.url}
                      </a>
                      <button className="link small muted" onClick={() => jump(l)}>
                        {sender(l.senderId)} · {fullTime(l.createdAt)}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              empty
            )}
            {!allText && (
              <p className="muted small center">
                {tr('链接只能在本机解密后查找。')}{' '}
                <button
                  className="link"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      setAllText(await fetchAllMessages(chat.id));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {tr('读取全部消息来查找')}
                </button>
              </p>
            )}
          </>
        )}
        {tab !== 'links' && more && (
          <div className="center">
            <button className="btn small secondary" disabled={busy} onClick={loadMore}>
              {busy ? <Loader2 size={15} className="spin" /> : null} {tr('加载更早的')}
            </button>
          </div>
        )}
        {busy && !msgs.length && <Spinner />}
      </div>
      {lightbox && <Lightbox p={lightbox} list={media.map((i) => i.p)} onClose={() => setLightbox(null)} />}
    </Modal>
  );
}
