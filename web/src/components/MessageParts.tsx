import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FilePayload, Payload } from '../crypto/core';
import { downloadFile, fileUrl, formatDuration, formatSize, isLarge, saveLarge } from '../lib/files';
import { Spinner } from './ui';
import { Play, Pause, Download, Mic, FileText, ChevronLeft, ChevronRight } from 'lucide-react';
import { tr } from '../lib/i18n';

// ---------------------------------------------------------------------------------------------
// Plain-text summary (chat list previews, reply quotes, notifications)
// ---------------------------------------------------------------------------------------------
const KIND_LABEL: Record<string, string> = { image: tr('[图片]'), video: tr('[视频]'), audio: tr('[音频]'), voice: tr('[语音]'), file: tr('[文件]') };

/** Markdown → plain one-line text; spoilers stay hidden in previews. */
function plain(t: string) {
  return t
    .replace(/```[\s\S]*?```/g, tr('[代码]'))
    .replace(/\|\|[^|\n]+\|\|/g, '▒▒▒')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function callLabel(p: { video: boolean; duration: number; outcome: string; group?: number }) {
  if (p.group) return tr('[{v0}] {v1} 人 · 时长 {v2}', { v0: p.video ? tr('群视频通话') : tr('群语音通话'), v1: p.group, v2: formatDuration(p.duration) });
  const kind = p.video ? tr('视频通话') : tr('语音通话');
  if (p.outcome === 'answered') return tr('[{v0}] 通话时长 {v1}', { v0: kind, v1: formatDuration(p.duration) });
  return `[${kind}] ${tr(({ missed: '未接听', rejected: '已拒绝', cancelled: '已取消', failed: '连接失败' } as Record<string, string>)[p.outcome] ?? '')}`;
}

export function summarize(p?: Payload, error?: string): string {
  if (error) return tr('[无法解密的消息]');
  if (!p) return '';
  if (p.t === 'file' && p.sticker) return tr('[贴纸]');
  if (p.t === 'file') return `${KIND_LABEL[p.kind] ?? tr('[文件]')}${p.kind === 'file' ? ' ' + p.name : ''}${p.caption ? ' ' + plain(p.caption) : ''}`;
  if (p.t === 'text') return plain(p.text);
  if (p.t === 'poll') return tr('[投票] {v0}', { v0: p.q });
  if (p.t === 'bundle') return tr('[聊天记录] {v0}', { v0: p.title });
  if (p.t === 'call') return callLabel(p);
  return p.text;
}

// ---------------------------------------------------------------------------------------------
// Safe rich text: a tiny Markdown subset rendered as React nodes (never as HTML).
//   ```code block```   `code`   **bold**   *italic* / _italic_   ~~strike~~   ||spoiler||   links   @mentions
// ---------------------------------------------------------------------------------------------
const URL_RE = /https?:\/\/[^\s<>"'）)]+/;

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      className={`spoiler ${shown ? 'shown' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        setShown(true);
      }}
    >
      {children}
    </span>
  );
}

type Tok = { re: RegExp; render: (m: RegExpExecArray, key: number, inner: (s: string) => ReactNode[]) => ReactNode };

function inline(text: string, mentionNames: string[]): ReactNode[] {
  const mentionRe = mentionNames.length ? new RegExp(`@(${mentionNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`) : null;
  const toks: Tok[] = [
    { re: /`([^`\n]+)`/, render: (m, k) => <code key={k}>{m[1]}</code> },
    { re: /\*\*([^*\n]+)\*\*/, render: (m, k, r) => <b key={k}>{r(m[1])}</b> },
    { re: /~~([^~\n]+)~~/, render: (m, k, r) => <s key={k}>{r(m[1])}</s> },
    { re: /\|\|([^|\n]+)\|\|/, render: (m, k, r) => <Spoiler key={k}>{r(m[1])}</Spoiler> },
    { re: /(?<![\w*])\*([^*\n]+)\*(?!\w)/, render: (m, k, r) => <i key={k}>{r(m[1])}</i> },
    { re: /(?<!\w)_([^_\n]+)_(?!\w)/, render: (m, k, r) => <i key={k}>{r(m[1])}</i> },
    {
      re: URL_RE,
      render: (m, k) => (
        <a key={k} href={m[0]} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => e.stopPropagation()}>
          {m[0]}
        </a>
      ),
    },
    ...(mentionRe ? [{ re: mentionRe, render: (m: RegExpExecArray, k: number) => <span key={k} className="mention">{m[0]}</span> }] : []),
  ];
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  const recurse = (s: string) => inline(s, mentionNames);
  while (rest) {
    let best: { tok: Tok; m: RegExpExecArray } | null = null;
    for (const tok of toks) {
      const m = tok.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { tok, m };
    }
    if (!best) {
      out.push(<Fragment key={key++}>{rest}</Fragment>);
      break;
    }
    if (best.m.index > 0) out.push(<Fragment key={key++}>{rest.slice(0, best.m.index)}</Fragment>);
    out.push(best.tok.render(best.m, key++, recurse));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}

export function RichText({ text, mentionNames = [] }: { text: string; mentionNames?: string[] }) {
  const parts = text.split(/```([\s\S]*?)```/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="codeblock">
            {p.replace(/^\n/, '')}
          </pre>
        ) : (
          <Fragment key={i}>{inline(p, mentionNames)}</Fragment>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------------------------
function useFileUrl(p: FilePayload, auto: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const load = () => {
    if (!p.blobId || url || loading) return;
    setLoading(true);
    fileUrl(p)
      .then(setUrl)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    if (auto) load();
  }, [p.blobId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { url, err, loading, load };
}

/**
 * Full-screen viewer. Images: wheel / pinch / double-tap zoom, drag to pan. With `list`, ← / → (or swipe)
 * move through all photos and videos of the chat.
 */
export function Lightbox({ p, list, onClose }: { p: FilePayload; list?: FilePayload[]; onClose: () => void }) {
  const [cur, setCur] = useState(p);
  const idx = list ? list.findIndex((x) => x.blobId === cur.blobId) : -1;
  const go = (d: number) => {
    if (!list || idx < 0) return;
    const n = list[idx + d];
    if (n) setCur(n);
  };
  const { url, err } = useFileUrl(cur, true);
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; s: number } | null>(null);
  const swipe = useRef<{ x: number; t: number } | null>(null);
  useEffect(() => setZ({ s: 1, x: 0, y: 0 }), [cur.blobId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  const clampS = (s: number) => Math.min(6, Math.max(1, s));
  const img = cur.kind !== 'video';
  return (
    <div className="lightbox" onClick={() => z.s === 1 && onClose()}>
      {err ? (
        <p className="error">{err}</p>
      ) : !url ? (
        <Spinner />
      ) : !img ? (
        <video src={url} controls autoPlay onClick={(e) => e.stopPropagation()} />
      ) : (
        <img
          src={url}
          alt={cur.name}
          draggable={false}
          style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})`, cursor: z.s > 1 ? 'grab' : 'zoom-in', touchAction: 'none' }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => (e.stopPropagation(), setZ(z.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }))}
          onWheel={(e) => setZ((o) => ({ ...o, s: clampS(o.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)), ...(o.s <= 1.01 && e.deltaY > 0 ? { x: 0, y: 0 } : {}) }))}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.current.size === 1) swipe.current = { x: e.clientX, t: Date.now() };
            if (pointers.current.size === 2) {
              const [a, b] = [...pointers.current.values()];
              pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), s: z.s };
            }
          }}
          onPointerMove={(e) => {
            const prev = pointers.current.get(e.pointerId);
            if (!prev) return;
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.current.size === 2 && pinch.current) {
              const [a, b] = [...pointers.current.values()];
              const s = clampS((pinch.current.s * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.d);
              setZ((o) => ({ ...o, s }));
            } else if (z.s > 1) setZ((o) => ({ ...o, x: o.x + e.clientX - prev.x, y: o.y + e.clientY - prev.y }));
          }}
          onPointerUp={(e) => {
            pointers.current.delete(e.pointerId);
            if (pointers.current.size < 2) pinch.current = null;
            const sw = swipe.current;
            swipe.current = null;
            if (sw && z.s === 1 && Date.now() - sw.t < 500 && Math.abs(e.clientX - sw.x) > 60) go(e.clientX < sw.x ? 1 : -1);
          }}
        />
      )}
      {list && idx > 0 && (
        <button className="lb-nav prev" onClick={(e) => (e.stopPropagation(), go(-1))} aria-label={tr('上一张')}>
          <ChevronLeft size={28} />
        </button>
      )}
      {list && idx >= 0 && idx < list.length - 1 && (
        <button className="lb-nav next" onClick={(e) => (e.stopPropagation(), go(1))} aria-label={tr('下一张')}>
          <ChevronRight size={28} />
        </button>
      )}
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>
          {cur.name}
          {list && idx >= 0 && list.length > 1 && <span className="muted"> · {idx + 1}/{list.length}</span>}
        </span>
        <button className="btn secondary small" onClick={() => downloadFile(cur)}>
          {tr('保存')}
        </button>
        <button className="btn ghost small" onClick={onClose}>
          {tr('关闭')}
        </button>
      </div>
    </div>
  );
}

function VoicePlayer({ p }: { p: FilePayload }) {
  const { url, err, loading, load } = useFileUrl(p, false);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [speed, setSpeed] = useState(1);
  const want = useRef(false);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
    if (url && want.current) audio.current?.play();
  }, [url]);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!url) {
      want.current = true;
      return load();
    }
    const a = audio.current!;
    a.paused ? a.play() : a.pause();
  };
  const dur = p.duration ?? 0;
  return (
    <div className="voice">
      <button className="voice-btn" onClick={toggle} aria-label={playing ? tr('暂停') : tr('播放')}>
        {loading ? <Spinner /> : playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="nudge" />}
      </button>
      <div className="voice-track">
        <div className="voice-fill" style={{ width: dur ? `${Math.min(100, (pos / dur) * 100)}%` : 0 }} />
      </div>
      <span className="voice-time">{formatDuration(playing || pos ? pos : dur)}</span>
      <button
        className="voice-speed"
        onClick={(e) => {
          e.stopPropagation();
          const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
          setSpeed(next);
          if (audio.current) audio.current.playbackRate = next;
        }}
        aria-label={tr('播放速度')}
      >
        {speed}×
      </button>
      {err && <span className="error small">{err}</span>}
      {url && (
        <audio
          ref={audio}
          src={url}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => (setPlaying(false), setPos(0))}
          onTimeUpdate={(e) => setPos((e.target as HTMLAudioElement).currentTime)}
        />
      )}
    </div>
  );
}

export function FileBubble({ p, progress, onOpen }: { p: FilePayload; progress?: number; onOpen: (p: FilePayload) => void }) {
  const [dl, setDl] = useState<number | null>(null);
  const [dlErr, setDlErr] = useState('');
  const autoImage = p.kind === 'image' && p.size <= 3 * 1024 * 1024;
  const { url, err, loading, load } = useFileUrl(p, autoImage);
  const uploading = progress !== undefined && !p.blobId;

  if (p.kind === 'image' || p.kind === 'video') {
    const ratio = p.w && p.h ? p.h / p.w : 0.75;
    const w = Math.min(320, p.w ?? 320);
    return (
      <div
        className="media"
        style={{ width: w, aspectRatio: `${1} / ${Math.min(1.6, Math.max(0.4, ratio))}` }}
        onClick={(e) => {
          e.stopPropagation();
          if (p.blobId) onOpen(p);
        }}
      >
        {(url && p.kind === 'image' ? <img src={url} alt="" /> : p.thumb ? <img src={p.thumb} alt="" className={url ? '' : 'blur'} /> : null) ?? <div className="media-ph" />}
        {p.kind === 'video' && !uploading && <span className="play-center"><Play size={22} fill="currentColor" /></span>}
        {p.kind === 'video' && !uploading && <span className="play-badge"><Play size={11} fill="currentColor" /> {formatDuration(p.duration)}</span>}
        {(uploading || (loading && autoImage)) && (
          <span className="media-progress">{uploading ? `${Math.round((progress ?? 0) * 100)}%` : <Spinner />}</span>
        )}
        {err && <span className="media-progress error">{err}</span>}
      </div>
    );
  }

  if (p.kind === 'voice' || p.kind === 'audio') {
    if (uploading) return <div className="voice"><span className="voice-btn"><Mic size={16} /></span> {tr('上传中')} {Math.round((progress ?? 0) * 100)}%</div>;
    return (
      <div>
        {p.kind === 'audio' && <div className="file-name">{p.name}</div>}
        <VoicePlayer p={p} />
      </div>
    );
  }

  return (
    <div
      className="file-card"
      onClick={(e) => {
        e.stopPropagation();
        if (!p.blobId || dl !== null) return;
        if (isLarge(p)) {
          setDl(0);
          setDlErr('');
          saveLarge(p, setDl)
            .catch((er) => setDlErr((er as Error).message))
            .finally(() => setDl(null));
        } else downloadFile(p).catch(() => load());
      }}
    >
      <span className="file-icon">{uploading ? <small>{Math.round((progress ?? 0) * 100)}%</small> : dl !== null ? <small>{Math.round(dl * 100)}%</small> : <><FileText size={20} className="fi-doc" /><Download size={20} className="fi-dl" /></>}</span>
      <div className="grow">
        <div className="file-name">{p.name}</div>
        <div className="muted small">
          {formatSize(p.size)}
          {dl !== null && tr(' · 正在下载并解密…')}
          {(err || dlErr) && <span className="error"> · {err || dlErr}</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------------------------
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏'];

export function ReactionRow({ reactions, meId, names, onToggle }: { reactions: Record<string, string>; meId: string; names: (id: string) => string; onToggle: (emoji: string) => void }) {
  const groups = new Map<string, string[]>();
  for (const [uid, e] of Object.entries(reactions)) groups.set(e, [...(groups.get(e) ?? []), uid]);
  if (!groups.size) return null;
  return (
    <div className="reactions">
      {[...groups].map(([emoji, users]) => (
        <button
          key={emoji}
          className={`reaction ${users.includes(meId) ? 'mine' : ''}`}
          title={users.map(names).join(tr('、'))}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(emoji);
          }}
        >
          {emoji} {users.length}
        </button>
      ))}
    </div>
  );
}
