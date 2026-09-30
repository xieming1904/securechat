import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useStore,
  openChat,
  loadMessages,
  sendText,
  sendFile,
  editText,
  deleteMessages,
  discardFailed,
  retrySend,
  sendTyping,
  react,
  pinMessage,
  fetchMessage,
  forwardMessage,
  forwardBundle,
  sendSticker,
  postBlockedReason,
  BUNDLE_MAX,
  saveDraft,
  saveSettings,
  scheduleText,
  toast,
  setNextMessageTtl,
  type Chat,
  type Msg,
} from '../lib/store';
import { dayKey, dayLabel, disappearLabel, timeOf } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { prepareFile, prepareVoice, VoiceRecorder, formatDuration, formatSize } from '../lib/files';
import type { FilePayload } from '../crypto/core';
import { Avatar, Lock, Modal, Spinner, useAsync } from '../components/ui';
import { PollBubble, CreatePollDialog } from '../components/Poll';
import { fetchPreview, firstUrl } from '../lib/linkpreview';
import { LinkCard } from '../components/LinkCard';
import { BundleBubble } from '../components/Bundle';
import type { LinkPreview } from '../crypto/core';
import { SchedulePicker, ScheduledList, whenLabel } from '../components/Schedule';
import { callLabel, FileBubble, Lightbox, QUICK_REACTIONS, ReactionRow, RichText, summarize } from '../components/MessageParts';
import { startCall } from '../lib/call';
import { joinGroupCall, useGroupCall, MAX_AUDIO, MAX_VIDEO } from '../lib/groupcall';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  ArrowLeft, Info, Timer, ShieldAlert, TriangleAlert, Forward, LockKeyhole, Check, CheckCheck, Clock3, CircleAlert,
  MoreHorizontal, Reply, Copy, Pencil, Pin, PinOff, SquareCheck, Trash2, X, SendHorizontal, Paperclip, Mic, ChartColumnBig, CalendarClock, File as FileIcon, ShieldCheck,
  Phone, Video, PhoneMissed, Bookmark, Sticker, Ban, Megaphone, Upload, Search, Hourglass,
} from 'lucide-react';
import { ChatSearch } from '../components/ChatSearch';
import { addSticker, saveMessage, unblock, useChatTitle, useNameFor, useSocial } from '../lib/social';
import { StickerPicker, StickerView } from '../components/Stickers';
import { tr } from '../lib/i18n';
import { fileFromHandle, hasHandle, rememberHandle, useResume, type ResumeRec } from '../lib/resume';
import { abandonUpload } from '../lib/files';
import { resumeFileSend } from '../lib/store';

const ONE_TTLS: [number, string][] = [
  [60, '1 分钟'],
  [3600, '1 小时'],
  [86_400, '1 天'],
  [604_800, '7 天'],
];
const WINDOW = 150;
const WINDOW_STEP = 100;
const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches;
const textOf = (m?: Msg) => (m ? summarize(m.payload, m.error) : '');
const rawText = (m?: Msg) => (m?.payload?.t === 'text' ? m.payload.text : m?.payload?.t === 'file' ? (m.payload.caption ?? '') : '');

export function ChatView({ chat, onInfo }: { chat: Chat; onInfo: () => void }) {
  const me = useStore((s) => s.me)!;
  const messages = useStore((s) => s.messages[chat.id]);
  const hasMore = useStore((s) => s.hasMore[chat.id]);
  const typingMap = useStore((s) => s.typing[chat.id]);
  const warn = useStore((s) => s.keyWarnings);
  const offline = useStore((s) => s.offline);
  const jump = useStore((s) => s.jump);
  const [searching, setSearching] = useState(false);
  useEffect(() => setSearching(false), [chat.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [reply, setReply] = useState<Msg | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  // swipe right on a message (touch) = reply
  const [swipe, setSwipe] = useState<{ id: string; dx: number } | null>(null);
  const swipeStart = useRef<{ id: string; x: number; y: number } | null>(null);
  const swallowTap = useRef(false);
  const [schedList, setSchedList] = useState(false);
  const scheduledCount = useStore((s) => s.scheduled[chat.id]?.length ?? 0);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<{ msg: Msg; x: number; y: number } | null>(null);
  const [confirmDel, setConfirmDel] = useState<Msg[] | null>(null);
  const [forwarding, setForwarding] = useState<Msg[] | null>(null);
  const [lightbox, setLightbox] = useState<FilePayload | null>(null);
  const [dropFiles, setDropFiles] = useState<File[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const prevHeight = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // windowing: only the newest `limit` loaded messages are in the DOM; more are revealed when scrolling up
  const [limit, setLimit] = useState(WINDOW);
  const total = messages?.length ?? 0;
  const startAt = Math.max(0, total - limit);
  const shown = useMemo(() => (messages ?? []).slice(startAt), [messages, startAt]);
  const pendingJump = useRef<string | null>(null);

  const peer = chat.type === 'direct' ? chat.members.find((m) => m.id !== me.id) : undefined;
  const byId = useMemo(() => new Map((messages ?? []).map((m) => [m.id, m])), [messages]);
  const aliasOf = useNameFor();
  const titleOf = useChatTitle();
  const title = titleOf(chat);
  const blockedPeer = useSocial((s) => (peer ? s.blocked.some((b) => b.id === peer.id) : false));
  const stickers = useSocial((s) => s.stickers);
  const nameOf = (id: string) => {
    if (id === me.id) return tr('你');
    const m = chat.members.find((x) => x.id === id);
    return m ? aliasOf(m.id, m.displayName) : tr('已退出的成员');
  };
  const mentionNames = useMemo(() => chat.members.map((m) => m.displayName), [chat.members]);
  const typers = Object.entries(typingMap ?? {})
    .filter(([uid, exp]) => exp > Date.now() && uid !== me.id)
    .map(([uid]) => chat.members.find((m) => m.id === uid)?.displayName ?? '');
  const canPin = chat.type === 'direct' || chat.myRole !== 'member';

  useEffect(() => {
    setReply(null);
    setEditing(null);
    setSelected(new Set());
    setLimit(WINDOW);
    stickBottom.current = true;
  }, [chat.id]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (loadingOlder) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      prevHeight.current = 0;
      setLoadingOlder(false);
    } else if (stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // revealing older (already loaded) messages keeps the viewport where it was; a pending jump target gets scrolled to
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (pendingJump.current) {
      const id = pendingJump.current;
      pendingJump.current = null;
      requestAnimationFrame(() => jumpTo(id));
    } else if (prevHeight.current && !loadingOlder) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      prevHeight.current = 0;
    } else if (stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [startAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // a window that has grown far above the viewport shrinks back once we are at the bottom again
  useEffect(() => {
    if (limit > WINDOW && stickBottom.current && total - startAt > WINDOW * 2) setLimit(WINDOW);
  }, [total]); // eslint-disable-line react-hooks/exhaustive-deps

  const revealOlder = () => {
    if (startAt === 0) return;
    prevHeight.current = scroller.current!.scrollHeight;
    setLimit((l) => l + WINDOW_STEP);
  };

  // the "show earlier" row reveals more as soon as it scrolls into view (also when we were already at the top
  // and new messages pushed the window forward, where no scroll event would come)
  const topSentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = topSentinel.current;
    if (!el || startAt === 0 || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting) && !prevHeight.current) revealOlder();
    }, { root: scroller.current, rootMargin: '300px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [startAt > 0, startAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = scroller.current!;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 300 && startAt > 0 && !prevHeight.current) revealOlder();
  };

  const older = async () => {
    prevHeight.current = scroller.current!.scrollHeight;
    setLoadingOlder(true);
    setLimit(total + 200);
    await loadMessages(chat.id, true).catch(() => ((prevHeight.current = 0), setLoadingOlder(false)));
  };

  const jumpTo = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el && messages) {
      const idx = messages.findIndex((m) => m.id === id);
      if (idx >= 0 && idx < startAt) {
        pendingJump.current = id;
        setLimit(total - idx + 20);
        return;
      }
    }
    if (!el) return toast(tr('这条消息较早，请先向上加载更早的消息'));
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  };

  useEffect(() => {
    if (jump && jump.chatId === chat.id) {
      stickBottom.current = false;
      requestAnimationFrame(() => jumpTo(jump.messageId));
    }
  }, [jump?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const readByOthers = (m: Msg) => chat.members.some((x) => x.id !== me.id && x.lastReadSeq >= m.seq);
  const selecting = selected.size > 0;
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const subtitle = typers.length
    ? tr('{v0}正在输入…', { v0: chat.type === 'group' ? typers.join('、') + ' ' : '' })
    : chat.type === 'direct'
      ? peer?.online
        ? tr('在线')
        : tr('离线')
      : tr('{v0} 位成员 · {v1} 人在线', { v0: chat.members.length, v1: chat.members.filter((m) => m.online).length });

  return (
    <section
      className={`chat-view ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = [...e.dataTransfer.files];
        // v0.9 (Chromium): keep a handle to each dropped file so a large upload can continue after a reload
        const items = [...e.dataTransfer.items].filter((it) => it.kind === 'file');
        items.forEach((it, i) => {
          const get = (it as unknown as { getAsFileSystemHandle?: () => Promise<unknown> }).getAsFileSystemHandle;
          if (get && files[i]) get.call(it).then((h) => rememberHandle(files[i], h), () => undefined);
        });
        if (files.length) setDropFiles(files);
      }}
    >
      <header className="chat-head">
        <button className="icon-btn back" onClick={() => openChat(null)} aria-label={tr('返回')}>
          <ArrowLeft size={21} />
        </button>
        <button className="chat-head-main" onClick={onInfo}>
          <Avatar id={chat.id} chat={chat} name={title} size={40} online={peer?.online} group={chat.type === 'group'} />
          <div>
            <div className="chat-title">
              {title} <Lock />
            </div>
            <div className={`muted small ${typers.length ? 'typing' : ''}`}>
              {subtitle}
              {chat.disappearingSeconds > 0 && (
                <span className="inline-ic">
                  {' · '}
                  <Timer size={12} /> {disappearLabel(chat.disappearingSeconds)}
                </span>
              )}
            </div>
          </div>
        </button>
        {chat.type === 'direct' && peer && !peer.deleted && (
          <>
            <button className="icon-btn" onClick={() => startCall(chat.id, false)} aria-label={tr('语音通话')} title={tr('语音通话（端到端加密）')} disabled={offline}>
              <Phone size={19} />
            </button>
            <button className="icon-btn" onClick={() => startCall(chat.id, true)} aria-label={tr('视频通话')} title={tr('视频通话（端到端加密）')} disabled={offline}>
              <Video size={20} />
            </button>
          </>
        )}
        {chat.type === 'group' && (
          <>
            <button className="icon-btn" onClick={() => joinGroupCall(chat.id, false)} aria-label={tr('群语音通话')} title={tr('群语音通话（端到端加密，最多 {v0} 人）', { v0: MAX_AUDIO })} disabled={offline}>
              <Phone size={19} />
            </button>
            <button className="icon-btn" onClick={() => joinGroupCall(chat.id, true)} aria-label={tr('群视频通话')} title={tr('群视频通话（端到端加密，最多 {v0} 人）', { v0: MAX_VIDEO })} disabled={offline}>
              <Video size={20} />
            </button>
          </>
        )}
        <button className={`icon-btn ${searching ? 'on' : ''}`} onClick={() => setSearching((v) => !v)} aria-label={tr('搜索聊天记录')} title={tr('搜索聊天记录（Ctrl/⌘ + F）')}>
          <Search size={19} />
        </button>
        <button className="icon-btn" onClick={onInfo} aria-label={tr('聊天信息')}>
          <Info size={20} />
        </button>
      </header>
      {searching && <ChatSearch chat={chat} onClose={() => setSearching(false)} />}
      {chat.type === 'group' && <GroupCallBar chat={chat} />}

      {chat.type === 'group' && chat.settings?.ann && ['signed', 'resign', 'mismatch'].includes(chat.settings.status) && (
        <AnnouncementBar chatId={chat.id} text={chat.settings.ann} v={chat.settings.v} />
      )}
      {chat.pins.length > 0 && <PinnedBar chat={chat} byId={byId} onJump={jumpTo} canPin={canPin} />}
      {scheduledCount > 0 && (
        <button className="sched-bar" onClick={() => setSchedList(true)}>
          <CalendarClock size={14} /> {tr('{v0} 条定时消息待发送', { v0: scheduledCount })} <span className="muted">{tr('· 点击管理')}</span>
        </button>
      )}

      {chat.integrity === 'mismatch' && (
        <div className="integrity-warning">
          <ShieldAlert size={16} />
          {tr('服务器给出的成员列表与成员签名记录不一致，可能有人被未经授权地加入了此聊天。已停止发送消息和分发密钥。')}
        </div>
      )}
      {chat.settings && ['invalid', 'rollback', 'mismatch'].includes(chat.settings.status) && (
        <div className="key-warning">
          <TriangleAlert size={16} />
          {chat.settings.status === 'invalid'
            ? tr('聊天设置（名称 / 阅后即焚）的签名无效或不是管理员签的，可能被服务器篡改。')
            : chat.settings.status === 'rollback'
              ? tr('聊天设置被回退到了旧版本，可能被服务器篡改。')
              : tr('服务器执行的阅后即焚时长与签名设置不一致（签名设置：{v0}）。', { v0: disappearLabel(chat.settings.disappearing) })}
        </div>
      )}
      {chat.type === 'group' && chat.settings?.status === 'unsigned' && chat.myRole !== 'member' && chat.integrity === 'ok' && (
        <div className="key-warning info">
          <ShieldCheck size={16} />
          <span className="grow">
            {tr('这个群的名称和阅后即焚设置还没有签名（旧版本创建）。确认当前群名「{v0}」和阅后即焚「{v1}」无误后签名，以后服务器就无法篡改。', {
              v0: chat.title,
              v1: disappearLabel(chat.disappearingSeconds),
            })}
          </span>
          <button className="btn small" onClick={() => saveSettings(chat.id, {}).catch((e) => toast(e.message))}>
            {tr('确认并签名')}
          </button>
        </div>
      )}
      {peer && warn[peer.id] && (
        <div className="key-warning">
          <TriangleAlert size={16} />
          {tr('{v0} 的安全码已变更。可能是对方重置了账号，也可能是中间人攻击。请在「聊天信息」中核对安全码。', { v0: peer.displayName })}
        </div>
      )}

      <div className="messages" ref={scroller} onScroll={onScroll} onClick={() => setMenuFor(null)}>
        {messages === undefined && (
          <div className="center">
            <Spinner />
          </div>
        )}
        {startAt > 0 && (
          <div className="center" ref={topSentinel}>
            <button className="btn ghost small" onClick={revealOlder}>
              {tr('显示更早的消息')}
            </button>
          </div>
        )}
        {startAt === 0 && hasMore && (
          <div className="center">
            <button className="btn ghost small" onClick={older}>
              {tr('加载更早的消息')}
            </button>
          </div>
        )}
        {messages?.length === 0 && (
          <div className="e2e-note">
            <span className="e2e-ic">
              <ShieldCheck size={26} />
            </span>
            <b>{tr('端到端加密')}</b>
            <span>{tr('消息和附件在你的设备上加密，服务器只能看到密文。')}</span>
          </div>
        )}
        {shown.map((m, j) => {
          const i = startAt + j;
          const mine = m.senderId === me.id;
          const prev = messages![i - 1];
          const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
          const showName = chat.type === 'group' && !mine && (newDay || prev?.senderId !== m.senderId);
          const p = m.payload;
          const replyId = p && p.t !== 'system' ? p.replyTo : undefined;
          const replyTo = replyId ? byId.get(replyId) : undefined;
          const mentionsMe = p && p.t !== 'system' && p.mentions?.includes(me.id);
          const isSticker = p?.t === 'file' && !!p.sticker;
          const isMedia = p?.t === 'file' && (p.kind === 'image' || p.kind === 'video') && !p.caption;
          return (
            <Fragment key={`${m.senderId}|${m.clientMsgId}`}><ErrorBoundary fallback={<div className="msg-row muted small center">{tr('[无法显示的消息]')}</div>}>
              {newDay && <div className="day-sep">{dayLabel(m.createdAt)}</div>}
              <div
                id={`msg-${m.id}`}
                className={`msg-row ${mine ? 'mine' : ''} ${selected.has(m.id) ? 'selected' : ''}`}
                style={swipe?.id === m.id && swipe.dx > 0 ? { transform: `translateX(${Math.min(swipe.dx, 80)}px)` } : undefined}
                onTouchStart={(e) => {
                  if (m.pending || m.error || selecting) return;
                  const t0 = e.touches[0];
                  swipeStart.current = { id: m.id, x: t0.clientX, y: t0.clientY };
                }}
                onTouchMove={(e) => {
                  const s0 = swipeStart.current;
                  if (!s0 || s0.id !== m.id) return;
                  const t0 = e.touches[0];
                  const dx = t0.clientX - s0.x;
                  if (Math.abs(t0.clientY - s0.y) > 30) return (swipeStart.current = null), setSwipe(null);
                  if (dx > 8) setSwipe({ id: m.id, dx });
                }}
                onTouchEnd={() => {
                  const sw = swipe;
                  swipeStart.current = null;
                  setSwipe(null);
                  if (sw?.id === m.id && sw.dx > 56) {
                    swallowTap.current = true;
                    setTimeout(() => (swallowTap.current = false), 400);
                    setReply(m);
                    setEditing(null);
                  }
                }}
                onClick={(e) => {
                  if (swallowTap.current) return;
                  if (m.pending) return;
                  if (selecting) return toggle(m.id);
                  if (TOUCH && !(e.target as HTMLElement).closest('a,button,audio,video')) {
                    e.stopPropagation();
                    setMenuFor({ msg: m, x: e.clientX, y: e.clientY });
                  }
                }}
                onContextMenu={(e) => {
                  if (m.pending) return;
                  e.preventDefault();
                  setMenuFor({ msg: m, x: e.clientX, y: e.clientY });
                }}
              >
                {selecting && <input type="checkbox" readOnly checked={selected.has(m.id)} className="sel-box" />}
                <div className={`bubble ${m.error ? 'err' : ''} ${mentionsMe ? 'mentions-me' : ''} ${isMedia ? 'media-only' : ''} ${isSticker ? 'sticker-only' : ''}`}>
                  {showName && <div className="sender">{nameOf(m.senderId)}</div>}
                  {p && p.t !== 'system' && p.fwd && <div className="fwd">
                      <Forward size={13} /> {tr('转发自 {v0}', { v0: p.fwd })}
                    </div>}
                  {replyId && (
                    <div className="quote" onClick={(e) => (e.stopPropagation(), jumpTo(replyId))}>
                      <b>{replyTo ? nameOf(replyTo.senderId) : ''}</b>
                      <span>{replyTo ? textOf(replyTo) : tr('消息已删除或未加载')}</span>
                    </div>
                  )}
                  {p?.t === 'bundle' && !m.error && <BundleBubble p={p} />}
                  {p?.t === 'call' && !m.error && (
                    <button
                      className={`call-log ${p.outcome === 'answered' ? '' : 'missed'}`}
                      onClick={(e) => (e.stopPropagation(), chat.type === 'group' ? joinGroupCall(chat.id, p.video) : startCall(chat.id, p.video))}
                      title={chat.type === 'group' ? tr('发起群通话') : tr('再次呼叫')}
                    >
                      {p.outcome !== 'answered' ? <PhoneMissed size={17} /> : p.video ? <Video size={17} /> : <Phone size={17} />}
                      <span>{callLabel(p).replace(/^\[(.+?)\] /, '$1 · ')}</span>
                    </button>
                  )}
                  {p?.t === 'poll' && !m.error && <PollBubble m={m} p={p} meId={me.id} names={nameOf} />}
                  {p?.t === 'file' && (p.sticker ? <StickerView p={p} /> : <FileBubble p={p} progress={m.progress} onOpen={setLightbox} />)}
                  {m.error ? (
                    <div className="text">
                      <i className="inline-ic">
                        <LockKeyhole size={13} /> {m.error}
                      </i>
                    </div>
                  ) : p?.t === 'text' ? (
                    <div className="text">
                      <RichText text={p.text} mentionNames={p.mentions?.length ? mentionNames : []} />
                      {p.preview && <LinkCard p={p.preview} />}
                    </div>
                  ) : p?.t === 'file' && p.caption ? (
                    <div className="text">
                      <RichText text={p.caption} />
                    </div>
                  ) : null}
                  <div className="meta">
                    {m.expiresAt && (
                      <span title={tr('阅后即焚')} className="inline-ic">
                        <Timer size={11} />
                      </span>
                    )}
                    {m.editedAt && p?.t !== 'poll' && <span>{tr('已编辑')}</span>}
                    <span>{timeOf(m.createdAt)}</span>
                    {mine && (
                      <span title={m.queued ? tr('等待联网后自动发送') : undefined} className={`ticks ${m.queued ? 'queued' : ''} ${!m.pending && readByOthers(m) ? 'read' : ''} ${m.failed ? 'failed' : ''}`}>
                        {m.failed ? <CircleAlert size={14} /> : m.pending ? <Clock3 size={13} aria-label={m.queued ? tr('等待联网发送') : tr('发送中')} /> : readByOthers(m) ? <CheckCheck size={15} /> : <Check size={15} />}
                      </span>
                    )}
                  </div>
                  {m.reactions && <ReactionRow reactions={m.reactions} meId={me.id} names={nameOf} onToggle={(e) => react(m, e).catch((er) => toast(er.message))} />}
                  {!m.pending && !selecting && (
                    <button
                      className="msg-more"
                      aria-label={tr('更多')}
                      onClick={(e) => {
                        e.stopPropagation();
                        const r = (e.target as HTMLElement).getBoundingClientRect();
                        setMenuFor({ msg: m, x: r.left, y: r.bottom });
                      }}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  )}
                </div>
                {m.failed && (
                  <div className="failed-actions">
                    <button className="link" onClick={() => retrySend(m.clientMsgId)}>
                      {tr('重试')}
                    </button>
                    <button className="link" onClick={() => discardFailed(chat.id, m.clientMsgId)}>
                      {tr('丢弃')}
                    </button>
                  </div>
                )}
              </div>
            </ErrorBoundary></Fragment>
          );
        })}
      </div>

      {menuFor && (
        <div
          className="ctx-menu"
          style={{ left: Math.max(8, Math.min(menuFor.x, window.innerWidth - 250)), top: Math.max(8, Math.min(menuFor.y, window.innerHeight - 340)) }}
          onMouseLeave={() => setMenuFor(null)}
        >
          {!menuFor.msg.error && (
            <div className="quick-reactions">
              {QUICK_REACTIONS.map((e) => (
                <button
                  key={e}
                  className={menuFor.msg.reactions?.[me.id] === e ? 'on' : ''}
                  onClick={() => {
                    react(menuFor.msg, e).catch((er) => toast(er.message));
                    setMenuFor(null);
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
          {!menuFor.msg.error && <button onClick={() => (setReply(menuFor.msg), setEditing(null), setMenuFor(null))}>
              <Reply size={17} /> {tr('回复')}
            </button>}
          {!menuFor.msg.error && <button onClick={() => (setForwarding([menuFor.msg]), setMenuFor(null))}>
              <Forward size={17} /> {tr('转发')}
            </button>}
          {!menuFor.msg.error && !menuFor.msg.pending && menuFor.msg.payload && !['system', 'call'].includes(menuFor.msg.payload.t) && (
            <button
              onClick={() => {
                const m = menuFor.msg;
                setMenuFor(null);
                saveMessage(m).catch((e) => toast(e.message));
              }}
            >
              <Bookmark size={17} /> {tr('收藏')}
            </button>
          )}
          {!menuFor.msg.error && menuFor.msg.payload?.t === 'file' && menuFor.msg.payload.kind === 'image' && !menuFor.msg.pending && (
            <button
              onClick={() => {
                const p = menuFor.msg.payload as FilePayload;
                setMenuFor(null);
                addSticker({ ...p, sticker: true, caption: undefined, replyTo: undefined, fwd: undefined, mentions: undefined }).catch((e) => toast(e.message));
              }}
            >
              <Sticker size={17} /> {tr('添加到贴纸')}
            </button>
          )}
          {!menuFor.msg.error && rawText(menuFor.msg) && (
            <button
              onClick={() => {
                navigator.clipboard?.writeText(rawText(menuFor.msg));
                setMenuFor(null);
                toast(tr('已复制'));
              }}
            >
              <Copy size={17} /> {tr('复制')}
            </button>
          )}
          {menuFor.msg.senderId === me.id && menuFor.msg.payload?.t === 'text' && (
            <button onClick={() => (setEditing(menuFor.msg), setReply(null), setMenuFor(null))}>
              <Pencil size={17} /> {tr('编辑')}
            </button>
          )}
          {canPin && (
            <button
              onClick={() => {
                const pinned = chat.pins.includes(menuFor.msg.id);
                pinMessage(chat.id, menuFor.msg.id, !pinned).catch((e) => toast(e.message));
                setMenuFor(null);
              }}
            >
              {chat.pins.includes(menuFor.msg.id) ? <PinOff size={17} /> : <Pin size={17} />} {chat.pins.includes(menuFor.msg.id) ? tr('取消置顶') : tr('置顶')}
            </button>
          )}
          <button onClick={() => (setSelected(new Set([menuFor.msg.id])), setMenuFor(null))}>
            <SquareCheck size={17} /> {tr('选择')}
          </button>
          <button className="danger" onClick={() => (setConfirmDel([menuFor.msg]), setMenuFor(null))}>
            <Trash2 size={17} /> {tr('删除')}
          </button>
        </div>
      )}

      {selecting ? (
        <div className="select-bar">
          <button className="btn ghost" onClick={() => setSelected(new Set())}>
            {tr('取消')}
          </button>
          <span>{tr('已选择 {v0} 条', { v0: selected.size })}</span>
          <div className="row gap">
            <button className="btn secondary" onClick={() => setForwarding((messages ?? []).filter((m) => selected.has(m.id) && !m.error))}>
              {tr('转发')}
            </button>
            <button className="btn danger" onClick={() => setConfirmDel((messages ?? []).filter((m) => selected.has(m.id)))}>
              {tr('删除')}
            </button>
          </div>
        </div>
      ) : (
        <>
        {blockedPeer && peer && (
          <div className="blocked-bar">
            <Ban size={16} /> {tr('你已屏蔽 {v0}，对方无法给你发消息或打电话。', { v0: nameOf(peer.id) })}
            <button className="btn small secondary" onClick={() => unblock(peer.id).catch((e) => toast(e.message))}>
              {tr('取消屏蔽')}
            </button>
          </div>
        )}
        <ResumeBars chatId={chat.id} />
        {stickerOpen && (
          <StickerPicker
            stickers={stickers}
            onPick={(p) => {
              setStickerOpen(false);
              sendSticker(chat.id, p).catch((e) => toast(e.message));
            }}
            onClose={() => setStickerOpen(false)}
          />
        )}
        {postBlockedReason(chat, me.id) && <div className="offline-note muted small center">{postBlockedReason(chat, me.id)}</div>}
        {offline && <div className="offline-note muted small center">{tr('离线模式：显示本机缓存。现在发送的文字消息会加密保存在本机，联网后自动发出')}</div>}
        {!postBlockedReason(chat, me.id) && <Composer
          chat={chat}
          reply={reply}
          editing={editing}
          onCancel={() => (setReply(null), setEditing(null))}
          onFiles={setDropFiles}
          onPoll={() => setPollOpen(true)}
          onSticker={() => setStickerOpen((v) => !v)}
          onEditLast={() => {
            const last = [...(messages ?? [])].reverse().find((m) => m.senderId === me.id && m.payload?.t === 'text' && !m.pending && !m.error);
            if (last) (setEditing(last), setReply(null));
          }}
        />}
        </>
      )}

      {schedList && <ScheduledList chatId={chat.id} onClose={() => setSchedList(false)} />}
      {pollOpen && <CreatePollDialog chatId={chat.id} replyTo={reply?.id} onClose={() => (setPollOpen(false), setReply(null))} />}
      {confirmDel && (
        <DeleteDialog
          chat={chat}
          msgs={confirmDel}
          onClose={() => setConfirmDel(null)}
          onDone={() => {
            setConfirmDel(null);
            setSelected(new Set());
          }}
        />
      )}
      {forwarding && (
        <ForwardDialog
          msgs={forwarding}
          onClose={() => setForwarding(null)}
          onDone={() => {
            setForwarding(null);
            setSelected(new Set());
          }}
        />
      )}
      {dropFiles && (
        <SendFilesDialog
          chat={chat}
          files={dropFiles}
          replyTo={reply?.id}
          onClose={() => setDropFiles(null)}
          onSent={() => {
            setDropFiles(null);
            setReply(null);
          }}
        />
      )}
      {lightbox && (
        <Lightbox
          p={lightbox}
          list={(messages ?? [])
            .map((m) => m.payload)
            .filter((x): x is FilePayload => x?.t === 'file' && (x.kind === 'image' || x.kind === 'video') && !!x.blobId && !x.sticker)}
          onClose={() => setLightbox(null)}
        />
      )}
    </section>
  );
}

function PinnedBar({ chat, byId, onJump, canPin }: { chat: Chat; byId: Map<string, Msg>; onJump: (id: string) => void; canPin: boolean }) {
  const [idx, setIdx] = useState(0);
  const id = chat.pins[Math.min(idx, chat.pins.length - 1)];
  const [msg, setMsg] = useState<Msg | null>(byId.get(id) ?? null);
  useEffect(() => {
    const local = byId.get(id);
    if (local) setMsg(local);
    else fetchMessage(id).then(setMsg);
  }, [id, byId]);
  return (
    <div className="pinned-bar">
      <button
        className="pinned-main"
        onClick={() => {
          onJump(id);
          setIdx((idx + 1) % chat.pins.length);
        }}
      >
        <b className="inline-ic">
          <Pin size={13} /> {tr('置顶消息{v0}', { v0: chat.pins.length > 1 ? ` ${Math.min(idx, chat.pins.length - 1) + 1}/${chat.pins.length}` : '' })}</b>
        <span>{msg ? textOf(msg) : '…'}</span>
      </button>
      {canPin && (
        <button className="icon-btn" aria-label={tr('取消置顶')} onClick={() => pinMessage(chat.id, id, false).catch((e) => toast(e.message))}>
          <X size={18} />
        </button>
      )}
    </div>
  );
}

function Composer({
  chat,
  reply,
  editing,
  onCancel,
  onFiles,
  onEditLast,
  onPoll,
  onSticker,
}: {
  chat: Chat;
  reply: Msg | null;
  editing: Msg | null;
  onCancel: () => void;
  onFiles: (f: File[]) => void;
  onEditLast: () => void;
  onPoll: () => void;
  onSticker: () => void;
}) {
  const enterSends = usePrefs((p) => p.enterSends);
  const previewOn = usePrefs((p) => p.linkPreview);
  const [lp, setLp] = useState<{ url: string; data?: LinkPreview | null } | null>(null);
  const dismissed = useRef(new Set<string>());
  const me = useStore((s) => s.me)!;
  const [text, setText] = useState('');
  const [mentionQ, setMentionQ] = useState<string | null>(null);
  const [recording, setRecording] = useState<null | { rec: VoiceRecorder; t: number }>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [scheduling, setScheduling] = useState(false);
  // v0.9: "this message deletes itself after …" (applies to the next message sent)
  const [oneTtl, setOneTtl] = useState<number | null>(null);
  const [ttlMenu, setTtlMenu] = useState(false);
  // link preview (opt-in): debounce on the first URL in the text
  useEffect(() => {
    const url = previewOn && !editing ? firstUrl(text) : null;
    if (!url || dismissed.current.has(url)) return setLp(null);
    if (lp?.url === url) return;
    const h = setTimeout(() => {
      setLp({ url });
      fetchPreview(url).then((data) => setLp((cur) => (cur?.url === url ? { url, data } : cur)));
    }, 600);
    return () => clearTimeout(h);
  }, [text, previewOn, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const remoteDraft = useStore((s) => s.drafts[chat.id]?.text ?? '');

  useEffect(() => {
    setText(useStore.getState().drafts[chat.id]?.text ?? '');
  }, [chat.id]);
  // a draft typed on another of my devices shows up here if this composer is empty and not in use
  useEffect(() => {
    if (!text && remoteDraft && !editing && document.activeElement !== ta.current) setText(remoteDraft);
  }, [remoteDraft]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editing) setText(rawText(editing));
    ta.current?.focus();
  }, [editing, reply]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [text]);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setRecording((r) => (r ? { ...r, t: r.rec.elapsed() } : r)), 250);
    return () => clearInterval(t);
  }, [recording?.rec]); // eslint-disable-line react-hooks/exhaustive-deps

  // @mention suggestions (groups only)
  const candidates =
    chat.type === 'group' && mentionQ !== null
      ? chat.members.filter((m) => m.id !== me.id && (m.displayName.toLowerCase().includes(mentionQ.toLowerCase()) || m.username.toLowerCase().includes(mentionQ.toLowerCase()))).slice(0, 6)
      : [];
  const updateMention = (value: string, caret: number) => {
    const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    setMentionQ(m ? m[2] : null);
  };
  const insertMention = (name: string) => {
    const el = ta.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@([^\s@]*)$/, `@${name} `);
    const next = before + text.slice(caret);
    setText(next);
    saveDraft(chat.id, next);
    setMentionQ(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    if (t.length > 20000) return toast(tr('消息太长'));
    setText('');
    setMentionQ(null);
    sendTyping(chat.id, false);
    if (!editing) saveDraft(chat.id, '');
    if (editing) {
      onCancel();
      await editText(editing, t).catch((e) => toast(e.message));
    } else {
      const r = reply?.id;
      const mentions = chat.type === 'group' ? chat.members.filter((m) => m.id !== me.id && t.includes(`@${m.displayName}`)).map((m) => m.id) : [];
      const preview = lp?.data && t.includes(lp.url) ? lp.data : undefined;
      setLp(null);
      onCancel();
      setNextMessageTtl(chat.id, oneTtl);
      setOneTtl(null);
      await sendText(chat.id, t, r, mentions, preview);
    }
  };

  const schedule = async (at: number) => {
    const t = text.trim();
    if (!t) return;
    const mentions = chat.type === 'group' ? chat.members.filter((m) => m.id !== me.id && t.includes(`@${m.displayName}`)).map((m) => m.id) : [];
    await scheduleText(chat.id, t, at, reply?.id, mentions);
    setText('');
    saveDraft(chat.id, '');
    onCancel();
    toast(tr('已定时：{v0} 发送', { v0: whenLabel(at) }));
  };

  const startVoice = async () => {
    if (!VoiceRecorder.supported()) return toast(tr('此浏览器不支持录音'));
    const rec = new VoiceRecorder();
    try {
      await rec.start();
      setRecording({ rec, t: 0 });
    } catch {
      toast(tr('无法使用麦克风（请检查浏览器权限）'));
    }
  };
  const stopVoice = async (send: boolean) => {
    const r = recording;
    setRecording(null);
    if (!r) return;
    if (!send) return r.rec.cancel();
    const { blob, duration } = await r.rec.stop();
    if (duration < 0.5) return toast(tr('录音太短'));
    const replyTo = reply?.id;
    onCancel();
    const f = await prepareVoice(blob, duration);
    setNextMessageTtl(chat.id, oneTtl);
    setOneTtl(null);
    await sendFile(chat.id, f, { replyTo });
  };

  const replyName = reply ? (reply.senderId === me.id ? tr('你') : chat.members.find((m) => m.id === reply.senderId)?.displayName) : '';
  return (
    <div className="composer-wrap">
      {scheduling && <SchedulePicker onPick={schedule} onClose={() => setScheduling(false)} />}
      {oneTtl && !editing && (
        <div className="compose-ctx ttl-chip">
          <div>
            <b className="inline-ic">
              <Hourglass size={13} /> {tr('下一条消息在 {v0}后自动删除', { v0: tr(ONE_TTLS.find(([s]) => s === oneTtl)?.[1] ?? '') })}
            </b>
          </div>
          <button className="icon-btn" onClick={() => setOneTtl(null)} aria-label={tr('取消限时')}>
            <X size={18} />
          </button>
        </div>
      )}
      {(reply || editing) && (
        <div className="compose-ctx">
          <div>
            <b>{editing ? tr('编辑消息') : tr('回复 {v0}', { v0: replyName })}</b>
            <span className="muted">{textOf(editing ?? reply ?? undefined)}</span>
          </div>
          <button className="icon-btn" onClick={() => (onCancel(), editing && setText(''))} aria-label={tr('取消')}>
            <X size={18} />
          </button>
        </div>
      )}
      {lp && (
        <div className="compose-ctx link-ctx">
          {lp.data === undefined ? (
            <span className="muted small inline-ic">
              <Spinner /> {tr('正在获取链接预览…')}
            </span>
          ) : lp.data === null ? (
            <span className="muted small">{tr('无法生成该链接的预览')}</span>
          ) : (
            <LinkCard p={lp.data} compact />
          )}
          <button className="icon-btn" onClick={() => (dismissed.current.add(lp.url), setLp(null))} aria-label={tr('不附带预览')}>
            <X size={18} />
          </button>
        </div>
      )}
      {candidates.length > 0 && (
        <div className="mention-list">
          {candidates.map((m) => (
            <button key={m.id} onMouseDown={(e) => (e.preventDefault(), insertMention(m.displayName))}>
              <Avatar id={m.id} user={m.id} name={m.displayName} size={26} /> {m.displayName} <span className="muted small">@{m.username}</span>
            </button>
          ))}
        </div>
      )}
      {recording ? (
        <div className="composer recording">
          <button className="icon-btn" onClick={() => stopVoice(false)} aria-label={tr('取消录音')}>
            <Trash2 size={20} />
          </button>
          <span className="rec-dot" /> {tr('正在录音 {v0}', { v0: formatDuration(recording.t) })}
          <span className="grow" />
          <button className="send-btn" onClick={() => stopVoice(true)} aria-label={tr('发送语音')}>
            <SendHorizontal size={19} />
          </button>
        </div>
      ) : (
        <div className="composer">
          <button className="icon-btn attach" onClick={() => {
              // with the handle-giving picker when the browser has it; otherwise the normal file input (synchronously,
              // so the click still counts as a user gesture)
              if ('showOpenFilePicker' in window) pickFiles().then((fs) => (fs === null ? toast(tr('无法打开文件选择器')) : fs.length && onFiles(fs)));
              else fileInput.current?.click();
            }} aria-label={tr('发送文件')} disabled={!!editing}>
            <Paperclip size={21} />
          </button>
          <button className="icon-btn attach" onClick={onSticker} aria-label={tr('贴纸')} title={tr('贴纸')} disabled={!!editing}>
            <Sticker size={21} />
          </button>
          <button className="icon-btn attach" onClick={onPoll} aria-label={tr('发起投票')} title={tr('发起投票')} disabled={!!editing}>
            <ChartColumnBig size={21} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) onFiles([...e.target.files]);
              e.target.value = '';
            }}
          />
          <textarea
            ref={ta}
            rows={1}
            placeholder={tr('输入加密消息…')}
            title={`${enterSends ? tr('Enter 发送，Shift+Enter 换行') : tr('Ctrl/⌘+Enter 发送')}${tr('；支持 **粗体** *斜体* `代码` ||剧透||')}`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (!editing) saveDraft(chat.id, e.target.value);
              updateMention(e.target.value, e.target.selectionStart);
              if (e.target.value) sendTyping(chat.id, true);
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                onFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (candidates.length && (e.key === 'Enter' || e.key === 'Tab')) {
                e.preventDefault();
                return insertMention(candidates[0].displayName);
              }
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                const mod = e.ctrlKey || e.metaKey;
                if (enterSends ? !e.shiftKey && !mod : mod) {
                  e.preventDefault();
                  submit();
                  return;
                }
              }
              if (e.key === 'ArrowUp' && !text && !editing) {
                e.preventDefault();
                onEditLast();
              }
              if (e.key === 'Escape') (setMentionQ(null), onCancel());
            }}
          />
          {text.trim() && !editing && !oneTtl && (
            <button className="icon-btn attach" onClick={() => setScheduling(true)} aria-label={tr('定时发送')} title={tr('定时发送')}>
              <CalendarClock size={20} />
            </button>
          )}
          {!editing && (
            <span className="ttl-wrap">
              <button className={`icon-btn attach ${oneTtl ? 'on' : ''}`} onClick={() => setTtlMenu((v) => !v)} aria-label={tr('限时消息')} title={tr('这条消息一段时间后自动删除')}>
                <Hourglass size={19} />
              </button>
              {ttlMenu && (
                <div className="dropdown ttl-menu" onMouseLeave={() => setTtlMenu(false)}>
                  {ONE_TTLS.map(([sec, label]) => (
                    <button key={sec} onClick={() => (setOneTtl(sec), setTtlMenu(false))}>
                      {tr(label)}
                    </button>
                  ))}
                  {oneTtl && (
                    <button onClick={() => (setOneTtl(null), setTtlMenu(false))}>{tr('不限时')}</button>
                  )}
                </div>
              )}
            </span>
          )}
          {text.trim() || editing ? (
            <button className="send-btn" onClick={submit} disabled={!text.trim()} aria-label={tr('发送')}>
              {editing ? <Check size={20} /> : <SendHorizontal size={19} />}
            </button>
          ) : (
            <button className="send-btn mic" onClick={startVoice} aria-label={tr('录制语音')}>
              <Mic size={20} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SendFilesDialog({ chat, files, replyTo, onClose, onSent }: { chat: Chat; files: File[]; replyTo?: string; onClose: () => void; onSent: () => void }) {
  const [caption, setCaption] = useState('');
  const [asFile, setAsFile] = useState(false);
  const [previews, setPreviews] = useState<(string | null)[]>([]);
  const { busy, error, run } = useAsync();
  const hasImages = files.some((f) => f.type.startsWith('image/') && f.type !== 'image/svg+xml');
  useEffect(() => {
    const urls = files.map((f) => (f.type.startsWith('image/') && f.type !== 'image/svg+xml' ? URL.createObjectURL(f) : null));
    setPreviews(urls);
    return () => urls.forEach((u) => u && URL.revokeObjectURL(u));
  }, [files]);
  return (
    <Modal title={tr('发送 {v0} 个文件', { v0: files.length })} onClose={onClose}>
      <div className="send-files">
        {files.map((f, i) => (
          <div key={i} className="send-file">
            {previews[i] ? <img src={previews[i]!} alt="" /> : <span className="file-icon">
                <FileIcon size={20} />
              </span>}
            <div className="grow">
              <div className="file-name">{f.name}</div>
              <div className="muted small">{formatSize(f.size)}</div>
            </div>
          </div>
        ))}
      </div>
      <input placeholder={tr('添加说明（可选）')} value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={1000} />
      {hasImages && (
        <label className="check small">
          <input type="checkbox" checked={asFile} onChange={(e) => setAsFile(e.target.checked)} />
          {tr('按原文件发送（保留 EXIF 等元数据，可能包含拍摄位置）')}
        </label>
      )}
      <p className="muted small">{tr('文件在本机加密后上传，服务器看不到内容和文件名。')}{!asFile && hasImages && tr('图片会重新编码以去除拍摄位置等元数据。')}</p>
      {error && <p className="error">{error}</p>}
      <div className="row end gap">
        <button className="btn ghost" onClick={onClose}>
          {tr('取消')}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const prepared = [];
              for (const f of files) prepared.push(await prepareFile(f, asFile));
              onSent();
              prepared.forEach((p, i) => sendFile(chat.id, p, { caption: i === prepared.length - 1 ? caption.trim() || undefined : undefined, replyTo: i === 0 ? replyTo : undefined }));
            })
          }
        >
          {busy ? <Spinner /> : tr('发送')}
        </button>
      </div>
    </Modal>
  );
}

function ForwardDialog({ msgs, onClose, onDone }: { msgs: Msg[]; onClose: () => void; onDone: () => void }) {
  const chats = useStore((s) => s.chats);
  const [q, setQ] = useState('');
  const [merge, setMerge] = useState(msgs.length > 1);
  const canMerge = msgs.length > 1 && msgs.length <= BUNDLE_MAX;
  const list = Object.values(chats)
    .filter((c) => c.integrity !== 'mismatch' && c.title.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
  return (
    <Modal title={tr('转发 {v0} 条消息到…', { v0: msgs.length })} onClose={onClose}>
      <input placeholder={tr('搜索聊天')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {canMerge && (
        <label className="check">
          <input type="checkbox" className="switch" checked={merge} onChange={(e) => setMerge(e.target.checked)} />
          {tr('合并为一条「聊天记录」')}
        </label>
      )}
      <p className="muted small">{tr('消息会用目标聊天的密钥重新加密；附件会重新上传到目标聊天。')}</p>
      <div className="forward-list">
        {list.map((c) => (
          <button
            key={c.id}
            className="chat-item"
            onClick={async () => {
              onDone();
              try {
                if (canMerge && merge) await forwardBundle(msgs, c.id);
                else for (const m of [...msgs].sort((a, b) => a.seq - b.seq)) await forwardMessage(m, c.id);
                toast(tr('已转发到 {v0}', { v0: c.title }));
              } catch (e) {
                toast((e as Error).message);
              }
              openChat(c.id);
            }}
          >
            <Avatar id={c.id} chat={c} name={c.title} size={36} group={c.type === 'group'} />
            <span className="chat-title">{c.title}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function DeleteDialog({ chat, msgs, onClose, onDone }: { chat: Chat; msgs: Msg[]; onClose: () => void; onDone: () => void }) {
  const me = useStore((s) => s.me)!;
  const peer = chat.type === 'direct' ? chat.members.find((m) => m.id !== me.id) : undefined;
  const isAdmin = chat.myRole !== 'member';
  const canEveryone = chat.type === 'direct' || isAdmin || msgs.every((m) => m.senderId === me.id);
  const [everyone, setEveryone] = useState(canEveryone);
  const { busy, error, run } = useAsync();
  return (
    <Modal title={msgs.length > 1 ? tr('删除 {v0} 条消息？', { v0: msgs.length }) : tr('删除这条消息？')} onClose={onClose}>
      {canEveryone && (
        <label className="check">
          <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
          {peer ? tr('同时为 {v0} 删除', { v0: peer.displayName }) : tr('为所有成员删除')}
        </label>
      )}
      <p className="muted small">{everyone ? tr('消息和附件将从服务器和所有人的设备上永久删除，无需对方同意。') : tr('仅从你这边隐藏，对方仍然可以看到。')}</p>
      {error && <p className="error">{error}</p>}
      <div className="row end gap">
        <button className="btn ghost" onClick={onClose}>
          {tr('取消')}
        </button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await deleteMessages(
                msgs.map((m) => m.id),
                everyone ? 'everyone' : 'me',
              );
              onDone();
            })
          }
        >
          {tr('删除')}
        </button>
      </div>
    </Modal>
  );
}

export function EmptyPane() {
  const me = useStore((s) => s.me)!;
  return (
    <section className="chat-view empty-pane">
      <div className="empty-hero">
        <div className="hero-ic">
          <ShieldCheck size={40} strokeWidth={1.8} />
        </div>
        <h2>{tr('你好，')}{me.displayName}</h2>
        <p className="muted">{tr('从左侧选择一个聊天，或新建私聊开始。')}</p>
        <p className="hero-note">
          <Lock /> {tr('所有消息均在本机端到端加密')}
        </p>
      </div>
    </section>
  );
}


/** Admin-signed group announcement; collapsible, remembers which version I dismissed. */
function AnnouncementBar({ chatId, text, v }: { chatId: string; text: string; v: number }) {
  const key = `securechat.ann.${chatId}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === String(v);
    } catch {
      return false;
    }
  });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(key) === String(v));
    } catch {
      /* ignore */
    }
  }, [key, v]);
  if (hidden) return null;
  return (
    <div className={`announce-bar ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
      <Megaphone size={15} />
      <div className="grow">
        <b>{tr('群公告')}</b>
        <div className="announce-text">{text}</div>
      </div>
      <button
        className="icon-btn"
        aria-label={tr('关闭公告')}
        onClick={(e) => {
          e.stopPropagation();
          try {
            localStorage.setItem(key, String(v));
          } catch {
            /* ignore */
          }
          setHidden(true);
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}

/**
 * v0.9: the file picker that also gives us a handle to each file (Chromium's File System Access API), so an
 * interrupted large upload can continue after a reload without picking the file again. null = not available.
 */
async function pickFiles(): Promise<File[] | null> {
  const picker = (window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<{ getFile(): Promise<File> }[]> }).showOpenFilePicker;
  if (!picker) return null;
  try {
    const hs = await picker({ multiple: true });
    return await Promise.all(
      hs.map(async (h) => {
        const f = await h.getFile();
        rememberHandle(f, h);
        return f;
      }),
    );
  } catch (e) {
    return (e as Error).name === 'AbortError' ? [] : null;
  }
}

/** Uploads interrupted by a page reload (or closed tab): continue with the same file (picked again if needed). */
function ResumeBars({ chatId }: { chatId: string }) {
  const all = useResume((s) => s.recs);
  const seen = useResume((s) => s.seen);
  const recs = all.filter((r) => r.chatId === chatId && !seen.includes(r.uploadId));
  const input = useRef<HTMLInputElement>(null);
  const [cur, setCur] = useState<ResumeRec | null>(null);
  const [withHandle, setWithHandle] = useState<Record<string, boolean>>({});
  useEffect(() => {
    for (const r of recs) if (withHandle[r.uploadId] === undefined) hasHandle(r.uploadId).then((h) => setWithHandle((m) => ({ ...m, [r.uploadId]: h })));
  }, [recs.map((r) => r.uploadId).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const continueWithHandle = async (r: ResumeRec) => {
    const f = await fileFromHandle(r.uploadId).catch(() => null);
    if (!f) return (setCur(r), input.current?.click()); // no permission / file moved: pick it by hand
    await resumeFileSend(r, f);
  };
  if (!recs.length) return null;
  return (
    <>
      {recs.map((r) => (
        <div key={r.uploadId} className="resume-bar">
          <Upload size={16} />
          <span className="grow ellipsis">
            {tr('「{v0}」上传中断，已传 {v1}%', { v0: r.name, v1: Math.floor((r.sent / r.total) * 100) })}
          </span>
          {withHandle[r.uploadId] ? (
            <button className="btn small" onClick={() => continueWithHandle(r).catch((er) => toast(er.message))}>
              {tr('继续上传')}
            </button>
          ) : (
            <button className="btn small" onClick={() => (setCur(r), input.current?.click())}>
              {tr('选择同一文件继续')}
            </button>
          )}
          <button className="btn small ghost" onClick={() => abandonUpload(r.uploadId)}>
            {tr('放弃')}
          </button>
        </div>
      ))}
      <input
        ref={input}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f && cur) resumeFileSend(cur, f).catch((er) => toast(er.message));
        }}
      />
    </>
  );
}

/** "A group call is going on — join" bar. */
function GroupCallBar({ chat }: { chat: Chat }) {
  const room = useGroupCall((s) => s.rooms[chat.id]);
  const inIt = useGroupCall((s) => s.phase !== 'idle' && s.chatId === chat.id);
  const nameOf = useNameFor();
  if (!room?.callId || inIt) return null;
  const names = room.participants
    .map((id) => chat.members.find((m) => m.id === id))
    .filter(Boolean)
    .map((m) => nameOf(m!.id, m!.displayName));
  const full = room.participants.length >= (room.video ? MAX_VIDEO : MAX_AUDIO);
  return (
    <div className="gcall-bar">
      <span className="gcall-dot" />
      {room.video ? <Video size={16} /> : <Phone size={16} />}
      <span className="grow ellipsis">
        {tr('群通话进行中 · {v0} 人', { v0: room.participants.length })}
        {names.length > 0 && <span className="muted small"> · {names.slice(0, 3).join('、')}{names.length > 3 ? '…' : ''}</span>}
      </span>
      <button className="btn small" disabled={full} onClick={() => joinGroupCall(chat.id, !!room.video)}>
        {full ? tr('已满') : tr('加入')}
      </button>
    </div>
  );
}
