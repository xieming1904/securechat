import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X, History, SlidersHorizontal } from 'lucide-react';
import { fetchAllMessages, openMessage, searchInChat, useStore, toast, type Chat, type Msg } from '../lib/store';
import { useNameFor } from '../lib/social';
import { tr } from '../lib/i18n';
import { Spinner } from './ui';

const dayStart = (s: string) => (s ? new Date(s + 'T00:00:00').getTime() : undefined);
const dayEnd = (s: string) => (s ? new Date(s + 'T23:59:59.999').getTime() : undefined);

/** Search bar inside one chat: text + sender / date filters, results walked with ↑ / ↓ (newest first). */
export function ChatSearch({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sender, setSender] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filters, setFilters] = useState(false);
  const [pos, setPos] = useState(0);
  const [extra, setExtra] = useState<Msg[]>([]);
  const [loadingAll, setLoadingAll] = useState<number | null>(null);
  const [allLoaded, setAllLoaded] = useState(false);
  const loaded = useStore((s) => s.messages[chat.id]);
  const aliasOf = useNameFor();
  const nameFor = (id: string, dn?: string) => {
    const m = chat.members.find((x) => x.id === id);
    return m ? aliasOf(id, dn ?? m.displayName) : tr('已退出的成员');
  };
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const hits = useMemo(
    () => searchInChat(chat.id, debounced, { senderId: sender || undefined, from: dayStart(from), to: dayEnd(to) }, extra),
    [chat.id, debounced, sender, from, to, extra, loaded],
  );
  const active = !!(debounced.trim() || sender || from || to);

  useEffect(() => setPos(0), [debounced, sender, from, to]);
  useEffect(() => {
    const h = hits[pos];
    if (h) openMessage(chat.id, h.id, h.seq).catch(() => undefined);
  }, [hits[pos]?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = (d: number) => hits.length && setPos((p) => (p + d + hits.length) % hits.length);
  const loadAll = async () => {
    setLoadingAll(0);
    try {
      setExtra(await fetchAllMessages(chat.id, (n) => setLoadingAll(n)));
      setAllLoaded(true);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setLoadingAll(null);
    }
  };

  const cur = hits[pos];
  return (
    <div className="chat-search" role="search">
      <div className="row">
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tr('在此聊天中搜索')}
          aria-label={tr('在此聊天中搜索')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.preventDefault(), step(e.shiftKey ? -1 : 1));
            else if (e.key === 'Escape') onClose();
          }}
        />
        <span className="muted small count" aria-live="polite">
          {active ? (hits.length ? `${pos + 1}/${hits.length}` : tr('无结果')) : ''}
        </span>
        <button className="icon-btn" onClick={() => step(1)} disabled={!hits.length} aria-label={tr('更早的结果')} title={tr('更早的结果（回车）')}>
          <ChevronUp size={18} />
        </button>
        <button className="icon-btn" onClick={() => step(-1)} disabled={!hits.length} aria-label={tr('更新的结果')} title={tr('更新的结果（Shift+回车）')}>
          <ChevronDown size={18} />
        </button>
        <button className={`icon-btn ${filters || sender || from || to ? 'on' : ''}`} onClick={() => setFilters((v) => !v)} aria-label={tr('筛选')} title={tr('按发送者、日期筛选')}>
          <SlidersHorizontal size={17} />
        </button>
        <button className="icon-btn" onClick={onClose} aria-label={tr('关闭搜索')}>
          <X size={18} />
        </button>
      </div>
      {filters && (
        <div className="row filters">
          {chat.type === 'group' && (
            <select value={sender} onChange={(e) => setSender(e.target.value)} aria-label={tr('发送者')}>
              <option value="">{tr('所有人')}</option>
              {chat.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {nameFor(m.id, m.displayName)}
                </option>
              ))}
            </select>
          )}
          <label className="small">
            {tr('从')} <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label={tr('开始日期')} />
          </label>
          <label className="small">
            {tr('到')} <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label={tr('结束日期')} />
          </label>
          {(sender || from || to) && (
            <button className="btn ghost small" onClick={() => (setSender(''), setFrom(''), setTo(''))}>
              {tr('清除筛选')}
            </button>
          )}
        </div>
      )}
      {cur && (
        <div className="muted small hit-line">
          <b>{nameFor(cur.senderId)}</b> · {new Date(cur.createdAt).toLocaleString()} · {snippet(cur.text, cur.index, debounced.trim().length)}
        </div>
      )}
      {active && !allLoaded && (
        <div className="muted small hit-line">
          {loadingAll !== null ? (
            <>
              <Spinner /> {tr('正在读取全部消息…（{v0}）', { v0: loadingAll })}
            </>
          ) : (
            <>
              {tr('只搜索了本机已有的消息。')}
              <button className="link" onClick={loadAll}>
                <History size={13} /> {tr('搜索全部历史')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function snippet(text: string, index: number, len: number) {
  const flat = text.replace(/\s/g, ' ');
  if (!len) return flat.slice(0, 80) || tr('（非文字消息）');
  const start = Math.max(0, index - 30);
  return (
    <>
      {start > 0 && '…'}
      {flat.slice(start, index)}
      <mark>{flat.slice(index, index + len)}</mark>
      {flat.slice(index + len, index + len + 50)}
    </>
  );
}
