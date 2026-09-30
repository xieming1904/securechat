import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore, bootstrap, findUser, createDirect, openChat, toast } from './lib/store';
import { Sidebar } from './pages/Sidebar';
import { ChatView, EmptyPane } from './pages/ChatView';
import { Spinner } from './components/ui';
import { LockScreen } from './pages/Lock';
import { LoginAlerts } from './components/LoginAlerts';
import { CallOverlay } from './components/CallOverlay';
import { GroupCallOverlay } from './components/GroupCallOverlay';
import { Need2faPage, SecondFactorPromptHost } from './components/TwoFactor';
import './lib/social';
import './lib/prefsync';
import './lib/avatars';
import { countedUnread, useChatList } from './lib/chatlist';
import { useResume } from './lib/resume';
import './lib/privacyScreen';
import { useSecret } from './lib/secret';
import { acceptCurrentCode, checkCodeFingerprint, useCodeFp } from './lib/fingerprint';
import { SecretChatView } from './pages/SecretChatView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { lockEnabled, startIdleWatch } from './lib/applock';
import { tr } from './lib/i18n';

// admin console is only for admins: load it on demand
const AdminPage = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminPage })));
// screens that aren't needed to show the chat list are split out too (smaller first load after an update)
const LoginPage = lazy(() => import('./pages/Auth').then((m) => ({ default: m.LoginPage })));
const UnlockPage = lazy(() => import('./pages/Auth').then((m) => ({ default: m.UnlockPage })));
const InvitePage = lazy(() => import('./pages/Auth').then((m) => ({ default: m.InvitePage })));
const ChatInfo = lazy(() => import('./pages/ChatInfo').then((m) => ({ default: m.ChatInfo })));
const NewDirectDialog = lazy(() => import('./pages/Dialogs').then((m) => ({ default: m.NewDirectDialog })));
const NewGroupDialog = lazy(() => import('./pages/Dialogs').then((m) => ({ default: m.NewGroupDialog })));
const SettingsDialog = lazy(() => import('./pages/Dialogs').then((m) => ({ default: m.SettingsDialog })));
const SavedDialog = lazy(() => import('./components/Saved').then((m) => ({ default: m.SavedDialog })));

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    window.addEventListener('popstate', f);
    return () => window.removeEventListener('popstate', f);
  }, []);
  const go = (p: string) => {
    history.pushState(null, '', p);
    setPath(p);
  };
  return [path, go] as const;
}

export default function App() {
  const phase = useStore((s) => s.phase);
  const toastMsg = useStore((s) => s.toast);
  const [path, go] = usePath();
  const [locked, setLocked] = useState(() => lockEnabled());

  useEffect(() => {
    if (!locked) bootstrap();
  }, [locked]);

  // auto-lock after inactivity (only once the app is actually open)
  useEffect(() => (phase === 'ready' && !locked ? startIdleWatch() : undefined), [phase, locked]);
  // v0.8: notice when the web code changes without a version change (checked once per start, in the background)
  useEffect(() => {
    if (phase !== 'ready') return;
    const t = setTimeout(() => checkCodeFingerprint().catch(() => undefined), 8000);
    return () => clearTimeout(t);
  }, [phase]);
  // warm the split-out screens once the app is up, so they are cached (service worker) for offline use too
  useEffect(() => {
    if (phase !== 'ready') return;
    const t = setTimeout(() => {
      for (const load of [() => import('./pages/ChatInfo'), () => import('./pages/Dialogs'), () => import('./components/Saved'), () => import('./pages/Auth')]) load().catch(() => undefined);
    }, 4000);
    return () => clearTimeout(t);
  }, [phase]);

  const invite = path.match(/^\/i\/([A-Za-z0-9_-]+)$/);
  let page: React.ReactNode;
  if (invite) page = <InvitePage token={invite[1]} />;
  else if (locked) page = <LockScreen onUnlock={() => setLocked(false)} />;
  else if (phase === 'loading')
    page = (
      <div className="auth-shell">
        <Spinner />
      </div>
    );
  else if (phase === 'auth') page = <LoginPage />;
  else if (phase === 'locked') page = <UnlockPage />;
  else if (phase === 'need2fa') page = <Need2faPage />;
  else if (path === '/admin')
    page = (
      <Suspense fallback={<div className="center-page"><Spinner /></div>}>
        <AdminPage onExit={() => go('/')} />
      </Suspense>
    );
  else page = <Main path={path} go={go} />;

  return (
    <>
      <ErrorBoundary
        fallback={
          <div className="auth-shell">
            <div className="auth-card">
              <h1>{tr('出错了')}</h1>
              <p className="muted">{tr('页面遇到了意外错误。你的数据是安全的，刷新即可恢复。')}</p>
              <button className="btn" onClick={() => location.reload()}>
                {tr('刷新')}
              </button>
            </div>
          </div>
        }
      >
        <Suspense fallback={<div className="auth-shell"><Spinner /></div>}>{page}</Suspense>
      </ErrorBoundary>
      {toastMsg && <div className="toast">{toastMsg}</div>}
      <SecondFactorPromptHost />
    </>
  );
}

function Main({ path, go }: { path: string; go: (p: string) => void }) {
  const active = useStore((s) => (s.activeChatId ? s.chats[s.activeChatId] : undefined));
  const secretActive = useSecret((s) => (s.active && s.chats[s.active] ? s.active : null));
  const chatsAll = useStore((s) => s.chats);
  const cl = useChatList();
  const unread = countedUnread(chatsAll, cl);
  const [dialog, setDialog] = useState<null | 'direct' | 'group' | 'settings' | 'saved'>(null);
  const [info, setInfo] = useState(false);

  useEffect(() => {
    document.title = unread ? tr('({v0}) 密聊', { v0: unread }) : tr('密聊');
  }, [unread]);

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const modalOpen = !!document.querySelector('.modal-backdrop, .lightbox');
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const el = document.getElementById('chat-search') as HTMLInputElement | null;
        if (useStore.getState().activeChatId && matchMedia('(max-width: 760px)').matches) openChat(null);
        setTimeout(() => (el ?? (document.getElementById('chat-search') as HTMLInputElement | null))?.focus(), 0);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setDialog('direct');
      } else if (mod && e.key === ',') {
        e.preventDefault();
        setDialog('settings');
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !modalOpen) {
        e.preventDefault();
        const s = useStore.getState();
        const list = Object.values(s.chats).sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
        if (!list.length) return;
        const i = list.findIndex((c) => c.id === s.activeChatId);
        const next = i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowUp' ? -1 : 1)));
        openChat(list[next].id);
      } else if (e.key === 'Escape' && !modalOpen && info) {
        setInfo(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [info]);

  // uploads interrupted by the last reload: point at them once
  useEffect(() => {
    const n = useResume.getState().recs.length;
    if (n) toast(tr('有 {v0} 个大文件上传被中断，打开对应的聊天即可继续上传', { v0: n }));
  }, []);

  // personal card links: /u/<username> opens (or creates) the direct chat
  useEffect(() => {
    const m = path.match(/^\/u\/([A-Za-z0-9_]{3,32})$/);
    if (!m) return;
    go('/');
    findUser(m[1])
      .then(async (u) => {
        if (u.id === useStore.getState().me!.id) return toast(tr('这是你自己的名片'));
        await openChat(await createDirect(u.id));
      })
      .catch((e) => toast(e.message));
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`layout ${active || secretActive ? 'has-chat' : ''} ${info && active ? 'has-info' : ''}`}>
      <Sidebar onMenu={(w) => (w === 'admin' ? go('/admin') : setDialog(w))} />
      {secretActive ? <SecretChatView key={secretActive} chatId={secretActive} /> : active ? <ChatView key={active.id} chat={active} onInfo={() => setInfo(!info)} /> : <EmptyPane />}
      <Suspense fallback={null}>
        {info && active && <ChatInfo chat={active} onClose={() => setInfo(false)} />}
        {dialog === 'direct' && <NewDirectDialog onClose={() => setDialog(null)} />}
        {dialog === 'group' && <NewGroupDialog onClose={() => setDialog(null)} />}
        {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(null)} />}
        {dialog === 'saved' && <SavedDialog onClose={() => setDialog(null)} />}
      </Suspense>
      <CodeChangeAlert />
      <LoginAlerts />
      <CallOverlay />
      <GroupCallOverlay />
    </div>
  );
}

function CodeChangeAlert() {
  const r = useCodeFp((s) => s.result);
  if (!r?.changedSilently) return null;
  return (
    <div className="code-alert" role="alert">
      <span>{tr('网页代码在版本号没变的情况下发生了变化（设置 → 安全 → 网页代码指纹）。如果管理员最近没有改动服务器，请提醒他检查。')}</span>
      <button className="btn small" onClick={acceptCurrentCode}>
        {tr('我知道了')}
      </button>
    </div>
  );
}
