import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, openChat, openMessage, searchMessages, isNotifyOff, setChatNotify, toast, type Chat } from '../lib/store';
import { listTime } from '../lib/format';
import { Avatar } from '../components/ui';
import { lockEnabled, lockNow } from '../lib/applock';
import {
  Lock as LockIcon, Menu, MessageSquarePlus, UsersRound, Settings, ShieldCheck, Search, WifiOff, Loader2, SquarePen, Bookmark,
  Pin, PinOff, BellOff, Bell, Archive, ArchiveRestore, ArrowLeft, Mail, MailOpen, FolderPlus, Folder as FolderIcon, Check, CheckCheck, ChevronRight, PhoneCall,
  LockKeyhole,
} from 'lucide-react';
import { openSecret, useSecret } from '../lib/secret';
import { summarize } from '../components/MessageParts';
import { useChatTitle } from '../lib/social';
import {
  useChatList, inTab, sortChats, hasUnread, togglePin, toggleArchive, markUnread, markRead, markAllRead, toggleInFolder, type Tab,
} from '../lib/chatlist';
import { FoldersDialog } from '../components/Folders';
import { useGroupCall } from '../lib/groupcall';
import { tr } from '../lib/i18n';

export function previewText(chat: Chat, meId: string) {
  const m = chat.lastMessage;
  if (!m) return chat.type === 'group' ? tr('群聊已创建') : tr('加密聊天已建立');
  const who = chat.type === 'group' ? (m.senderId === meId ? tr('你: ') : `${chat.members.find((x) => x.id === m.senderId)?.displayName ?? ''}: `) : m.senderId === meId ? tr('你: ') : '';
  return who + summarize(m.payload, m.error);
}

export function Sidebar({ onMenu }: { onMenu: (what: 'direct' | 'group' | 'settings' | 'admin' | 'saved') => void }) {
  const chats = useStore((s) => s.chats);
  const me = useStore((s) => s.me)!;
  const active = useStore((s) => s.activeChatId);
  const connected = useStore((s) => s.connected);
  const offline = useStore((s) => s.offline);
  const typing = useStore((s) => s.typing);
  const drafts = useStore((s) => s.drafts);
  const callRooms = useGroupCall((s) => s.rooms);
  const titleOf = useChatTitle();
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState(false);
  // close the menu on a tap/click outside it or Escape (touch screens have no mouseleave)
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => !(e.target as HTMLElement).closest?.('.menu-wrap') && setMenu(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [menu]);

  const cl = useChatList();
  const [tab, setTab] = useState<Tab>('all');
  const [archiveView, setArchiveView] = useState(false);
  const [ctx, setCtx] = useState<null | { chat: Chat; x: number; y: number; sub?: 'mute' | 'folder' }>(null);
  const [tabMenu, setTabMenu] = useState<null | { tab: Tab; x: number; y: number }>(null);
  const [folders, setFolders] = useState<null | { editId?: string }>(null);
  const press = useRef<{ t: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  // a tab that no longer exists (folder deleted on another device) falls back to "all"
  useEffect(() => {
    if (tab.startsWith('f:') && !cl.folders.some((f) => `f:${f.id}` === tab)) setTab('all');
  }, [cl.folders, tab]);
  useEffect(() => {
    if (!ctx && !tabMenu) return;
    const down = (e: PointerEvent) => !(e.target as HTMLElement).closest?.('.ctx-menu') && (setCtx(null), setTabMenu(null));
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (setCtx(null), setTabMenu(null));
    const t = setTimeout(() => document.addEventListener('pointerdown', down), 0);
    document.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [ctx, tabMenu]);

  const hits = useMemo(() => (q.trim() ? searchMessages(q) : []), [q, chats]);
  const archivedSet = useMemo(() => new Set(cl.archived), [cl.archived]);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t)
      return sortChats(
        Object.values(chats).filter((c) => c.title.toLowerCase().includes(t) || titleOf(c).toLowerCase().includes(t) || c.members.some((m) => m.username.toLowerCase().includes(t))),
        cl,
      );
    const base = Object.values(chats).filter((c) => (archiveView ? archivedSet.has(c.id) : !archivedSet.has(c.id) && inTab(c, tab, cl)));
    return sortChats(base, archiveView ? { ...cl, pinned: [] } : cl);
  }, [chats, q, titleOf, cl, tab, archiveView, archivedSet]);
  const archivedUnread = useMemo(() => cl.archived.reduce((n, id) => n + (chats[id] && hasUnread(chats[id], cl) ? 1 : 0), 0), [cl, chats]);
  const archivedCount = cl.archived.filter((id) => chats[id]).length;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'all', label: tr('全部') },
    { id: 'unread', label: tr('未读') },
    { id: 'direct', label: tr('私聊') },
    { id: 'group', label: tr('群组') },
    ...cl.folders.map((f) => ({ id: `f:${f.id}` as Tab, label: f.name })),
  ];
  const tabUnread = (t: Tab) => Object.values(chats).filter((c) => !archivedSet.has(c.id) && inTab(c, t, cl) && hasUnread(c, cl) && !isNotifyOff(c)).length;
  const openMenu = (chat: Chat, x: number, y: number) => setCtx({ chat, x, y });

  return (
    <aside className="sidebar">
      <div className="side-head">
        <div className="menu-wrap">
          <button className="icon-btn" aria-label={tr('菜单')} onClick={() => setMenu(!menu)}>
            <Menu size={21} />
          </button>
          {menu && (
            <div className="dropdown" onMouseLeave={() => setMenu(false)}>
              <div className="menu-me">
                <Avatar id={me.id} user={me.id} name={me.displayName} size={36} />
                <div>
                  <b>{me.displayName}</b>
                  <span className="muted small">@{me.username}</span>
                </div>
              </div>
              <button onClick={() => (setMenu(false), onMenu('direct'))}>
                <MessageSquarePlus size={18} /> {tr('新建私聊')}
              </button>
              <button onClick={() => (setMenu(false), onMenu('group'))}>
                <UsersRound size={18} /> {tr('新建群组')}
              </button>
              <button onClick={() => (setMenu(false), onMenu('saved'))}>
                <Bookmark size={18} /> {tr('收藏夹')}
              </button>
              <button onClick={() => (setMenu(false), onMenu('settings'))}>
                <Settings size={18} /> {tr('设置')}
              </button>
              {me.isAdmin && (
                <button onClick={() => (setMenu(false), onMenu('admin'))}>
                  <ShieldCheck size={18} /> {tr('管理后台')}
                </button>
              )}
              {lockEnabled() && (
                <button onClick={() => lockNow()}>
                  <LockIcon size={18} /> {tr('立即锁定')}
                </button>
              )}
            </div>
          )}
        </div>
        <label className="search">
          <Search size={16} />
          <input id="chat-search" placeholder={tr('搜索聊天和消息')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setQ(''), e.currentTarget.blur())} />
        </label>
        <button className="icon-btn" aria-label={tr('新建私聊')} title={tr('新建私聊')} onClick={() => onMenu('direct')}>
          <SquarePen size={19} />
        </button>
      </div>
      {offline ? (
        <div className="conn-banner offline">
          <WifiOff size={14} /> {tr('离线模式：显示本机加密缓存，文字消息联网后自动发出')}
        </div>
      ) : (
        !connected && (
          <div className="conn-banner">
            <Loader2 size={14} className="spin" /> {tr('正在连接…')}
          </div>
        )
      )}
      {!q.trim() &&
        (archiveView ? (
          <div className="archive-head">
            <button className="icon-btn" onClick={() => setArchiveView(false)} aria-label={tr('返回')}>
              <ArrowLeft size={19} />
            </button>
            <b>{tr('归档聊天')}</b>
          </div>
        ) : (
          <div className="chat-tabs" role="tablist">
            {tabs.map((t) => {
              const n = t.id === 'all' ? 0 : tabUnread(t.id);
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`chat-tab ${tab === t.id ? 'on' : ''}`}
                  onClick={() => setTab(t.id)}
                  onContextMenu={(e) => (e.preventDefault(), setTabMenu({ tab: t.id, x: e.clientX, y: e.clientY }))}
                >
                  {t.label}
                  {n > 0 && <span className="tab-count">{n > 99 ? '99+' : n}</span>}
                </button>
              );
            })}
            <button className="chat-tab add" onClick={() => setFolders({})} aria-label={tr('管理分组')} title={tr('管理分组')}>
              <FolderPlus size={15} />
            </button>
          </div>
        ))}
      <div className="chat-list">
        {!q.trim() && !archiveView && tab === 'all' && archivedCount > 0 && (
          <button className="chat-item archive-row" onClick={() => setArchiveView(true)}>
            <div className="avatar archive-av" style={{ width: 44, height: 44 }}>
              <Archive size={20} />
            </div>
            <div className="chat-item-body">
              <div className="row between">
                <span className="chat-title">{tr('归档聊天')}</span>
                <ChevronRight size={16} className="muted" />
              </div>
              <span className="chat-preview">{tr('{v0} 个聊天', { v0: archivedCount })}</span>
            </div>
            {archivedUnread > 0 && <span className="badge muted-badge">{archivedUnread}</span>}
          </button>
        )}
        {!q.trim() && !archiveView && (tab === 'all' || tab === 'direct') && <SecretList />}
        {!q.trim() && list.length === 0 && (archiveView || tab !== 'all') && (
          <div className="muted small list-empty">{archiveView ? tr('没有归档的聊天') : tr('这里还没有聊天')}</div>
        )}
        {q.trim() && <div className="list-section">{tr('聊天')}</div>}
        {q.trim() && list.length === 0 && <div className="muted small list-empty">{tr('没有匹配的聊天')}</div>}
        {!q.trim() && !archiveView && tab === 'all' && list.length === 0 && archivedCount === 0 && (
          <div className="empty">
            <div className="empty-ic">
              <MessageSquarePlus size={28} />
            </div>
            <p>{tr('还没有聊天')}</p>
            <button className="btn" onClick={() => onMenu('direct')}>
              {tr('发起私聊')}
            </button>
          </div>
        )}
        {list.map((c) => {
          const peer = c.type === 'direct' ? c.members.find((m) => m.id !== me.id) : undefined;
          const typers = Object.entries(typing[c.id] ?? {}).filter(([, exp]) => exp > Date.now());
          const quiet = isNotifyOff(c);
          const pinned = !archiveView && cl.pinned.includes(c.id);
          const marked = c.unread === 0 && cl.unread.includes(c.id);
          return (
            <button
              key={c.id}
              className={`chat-item ${active === c.id ? 'active' : ''}`}
              onClick={() => {
                if (press.current?.fired) return;
                openChat(c.id);
              }}
              onContextMenu={(e) => (e.preventDefault(), openMenu(c, e.clientX, e.clientY))}
              onTouchStart={(e) => {
                const t0 = e.touches[0];
                const x = t0.clientX;
                const y = t0.clientY;
                press.current = { fired: false, t: setTimeout(() => (press.current && (press.current.fired = true), openMenu(c, x, y)), 500) };
              }}
              onTouchMove={() => press.current && clearTimeout(press.current.t)}
              onTouchEnd={(e) => {
                if (!press.current) return;
                clearTimeout(press.current.t);
                if (press.current.fired) e.preventDefault();
                const p = press.current;
                setTimeout(() => press.current === p && (press.current = null), 50);
              }}
            >
              <Avatar id={c.id} chat={c} name={titleOf(c)} online={peer?.online} group={c.type === 'group'} />
              <div className="chat-item-body">
                <div className="row between">
                  <span className="chat-title">
                    {titleOf(c)}
                    {quiet && <BellOff size={13} className="title-ic" aria-label={tr('免打扰')} />}
                    {callRooms[c.id]?.callId && <PhoneCall size={13} className="title-ic live" aria-label={tr('群通话进行中 · {v0} 人', { v0: callRooms[c.id].participants.length })} />}
                  </span>
                  <span className="chat-time">{listTime(c.lastMessageAt)}</span>
                </div>
                <div className="row between">
                  <span className={`chat-preview ${typers.length ? 'typing' : ''}`}>{typers.length ? (
                      tr('正在输入…')
                    ) : drafts[c.id] && active !== c.id ? (
                      <>
                        <span className="draft-label">{tr('[草稿]')}</span> {drafts[c.id].text.replace(/\s+/g, ' ')}
                      </>
                    ) : (
                      previewText(c, me.id)
                    )}
                  </span>
                  {c.mentioned && c.unread > 0 && <span className="badge mention-badge">@</span>}
                  {c.unread > 0 && <span className={`badge ${quiet ? 'muted-badge' : ''}`}>{c.unread > 99 ? '99+' : c.unread}</span>}
                  {marked && <span className={`badge unread-dot ${quiet ? 'muted-badge' : ''}`} aria-label={tr('标记为未读')} />}
                  {pinned && c.unread === 0 && !marked && <Pin size={14} className="pin-ic" aria-label={tr('已置顶')} />}
                </div>
              </div>
            </button>
          );
        })}
        {q.trim() && (
          <>
            <div className="list-section">{tr('消息（本机加密索引）')}</div>
            {hits.length === 0 && <div className="muted small list-empty">{tr('没有找到。只能搜索本机已缓存的消息。')}</div>}
            {hits.map((h) => {
              const c = chats[h.msg.chatId];
              if (!c) return null;
              const from = Math.max(0, h.index - 12);
              const snippet = h.text.slice(from, h.index + q.trim().length + 40);
              const at = h.index - from;
              return (
                <button key={h.msg.id} className="chat-item hit" onClick={() => openMessage(c.id, h.msg.id, h.msg.seq)}>
                  <Avatar id={c.id} chat={c} name={titleOf(c)} size={40} group={c.type === 'group'} />
                  <div className="chat-item-body">
                    <div className="row between">
                      <span className="chat-title">{titleOf(c)}</span>
                      <span className="chat-time">{listTime(h.msg.createdAt)}</span>
                    </div>
                    <span className="chat-preview">
                      {from > 0 && '…'}
                      {snippet.slice(0, at)}
                      <mark>{snippet.slice(at, at + q.trim().length)}</mark>
                      {snippet.slice(at + q.trim().length)}
                    </span>
                  </div>
                </button>
              );
            })}
          </>
        )}
      </div>
      {ctx && <ChatMenu ctx={ctx} setCtx={setCtx} onFolders={(editId) => (setCtx(null), setFolders({ editId }))} />}
      {tabMenu && (
        <div className="ctx-menu" style={{ left: Math.min(tabMenu.x, window.innerWidth - 250), top: Math.min(tabMenu.y, window.innerHeight - 160) }}>
          <button
            onClick={() => {
              const ids = Object.values(chats).filter((c) => !archivedSet.has(c.id) && inTab(c, tabMenu.tab, cl) && hasUnread(c, cl)).map((c) => c.id);
              markAllRead(ids).catch((e) => toast(e.message));
              setTabMenu(null);
            }}
          >
            <CheckCheck size={17} /> {tr('全部标为已读')}
          </button>
          {tabMenu.tab.startsWith('f:') && (
            <button onClick={() => (setFolders({ editId: tabMenu.tab.slice(2) }), setTabMenu(null))}>
              <FolderIcon size={17} /> {tr('编辑分组')}
            </button>
          )}
          <button onClick={() => (setFolders({}), setTabMenu(null))}>
            <FolderPlus size={17} /> {tr('管理分组')}
          </button>
        </div>
      )}
      {folders && <FoldersDialog editId={folders.editId} onClose={() => setFolders(null)} />}
    </aside>
  );
}

const MUTE_OPTIONS: { label: string; ms: number }[] = [
  { label: '1 小时', ms: 3_600_000 },
  { label: '8 小时', ms: 8 * 3_600_000 },
  { label: '1 天', ms: 86_400_000 },
  { label: '7 天', ms: 7 * 86_400_000 },
  { label: '一直', ms: -1 },
];

function ChatMenu({
  ctx,
  setCtx,
  onFolders,
}: {
  ctx: { chat: Chat; x: number; y: number; sub?: 'mute' | 'folder' };
  setCtx: (v: null | { chat: Chat; x: number; y: number; sub?: 'mute' | 'folder' }) => void;
  onFolders: (editId?: string) => void;
}) {
  const cl = useChatList();
  const c = useStore((s) => s.chats[ctx.chat.id]) ?? ctx.chat;
  const close = () => setCtx(null);
  const pinned = cl.pinned.includes(c.id);
  const archived = cl.archived.includes(c.id);
  const unread = hasUnread(c, cl);
  const quiet = isNotifyOff(c);
  const style = { left: Math.max(8, Math.min(ctx.x, window.innerWidth - 250)), top: Math.max(8, Math.min(ctx.y, window.innerHeight - 320)) };
  const run = (p: Promise<unknown> | void) => {
    if (p) p.catch((e: Error) => toast(e.message));
    close();
  };
  if (ctx.sub === 'mute')
    return (
      <div className="ctx-menu" style={style} role="menu">
        <div className="menu-label">{tr('免打扰时长')}</div>
        {MUTE_OPTIONS.map((o) => (
          <button key={o.label} onClick={() => run(setChatNotify(c.id, o.ms === -1 ? -1 : Date.now() + o.ms))}>
            <BellOff size={17} /> {tr(o.label)}
          </button>
        ))}
      </div>
    );
  if (ctx.sub === 'folder')
    return (
      <div className="ctx-menu" style={style} role="menu">
        <div className="menu-label">{tr('添加到分组')}</div>
        {cl.folders.map((f) => (
          <button key={f.id} onClick={() => run(toggleInFolder(f.id, c.id))}>
            {f.chats.includes(c.id) ? <Check size={17} /> : <FolderIcon size={17} />} {f.name}
          </button>
        ))}
        <button onClick={() => onFolders()}>
          <FolderPlus size={17} /> {tr('新建分组…')}
        </button>
      </div>
    );
  return (
    <div className="ctx-menu" style={style} role="menu">
      {!archived && (
        <button onClick={() => run(togglePin(c.id))}>
          {pinned ? <PinOff size={17} /> : <Pin size={17} />} {pinned ? tr('取消置顶') : tr('置顶')}
        </button>
      )}
      <button onClick={() => run(unread ? markRead(c.id) : markUnread(c.id))}>
        {unread ? <MailOpen size={17} /> : <Mail size={17} />} {unread ? tr('标记为已读') : tr('标记为未读')}
      </button>
      {quiet ? (
        <button onClick={() => run(setChatNotify(c.id, 0))}>
          <Bell size={17} /> {tr('开启通知')}
        </button>
      ) : (
        <button onClick={() => setCtx({ ...ctx, sub: 'mute' })}>
          <BellOff size={17} /> {tr('免打扰…')}
        </button>
      )}
      <button onClick={() => run(toggleArchive(c.id))}>
        {archived ? <ArchiveRestore size={17} /> : <Archive size={17} />} {archived ? tr('移出归档') : tr('归档')}
      </button>
      <button onClick={() => (cl.folders.length ? setCtx({ ...ctx, sub: 'folder' }) : onFolders())}>
        <FolderPlus size={17} /> {tr('添加到分组…')}
      </button>
    </div>
  );
}

function SecretList() {
  const chats = useSecret((s) => s.chats);
  const active = useSecret((s) => s.active);
  const list = Object.values(chats).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastAt - a.lastAt);
  return (
    <>
      {list.map((c) => (
        <button key={c.id} className={`chat-item secret-item ${active === c.id ? 'active' : ''}`} onClick={() => openSecret(c.id)}>
          <Avatar id={c.peerId} user={c.peerId} name={c.peerName} />
          <div className="chat-item-body">
            <div className="row between">
              <span className="chat-title secret-title">
                <LockKeyhole size={13} /> {c.peerName}
                {c.muted && <BellOff size={13} className="title-ic" aria-label={tr('免打扰')} />}
              </span>
              <span className="chat-time">{listTime(c.lastAt)}</span>
            </div>
            <div className="row between">
              <span className="chat-preview">{c.lastText}</span>
              {c.unread > 0 && <span className={`badge ${c.muted ? 'muted-badge' : 'secret-badge'}`}>{c.unread > 99 ? '99+' : c.unread}</span>}
              {c.pinned && c.unread === 0 && <Pin size={14} className="pin-ic" aria-label={tr('已置顶')} />}
            </div>
          </div>
        </button>
      ))}
    </>
  );
}
