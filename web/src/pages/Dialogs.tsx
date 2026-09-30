import { useEffect, useState } from 'react';
import { acceptCurrentCode, checkCodeFingerprint, prettyFp, useCodeFp } from '../lib/fingerprint';
import { api } from '../lib/api';
import { useStore, createDirect, createGroup, findUser, openChat, changePassword, logout, updateMe, toast, regenerateRecovery, localCacheInfo, setLocalCache } from '../lib/store';
import { disablePush, enablePush, pushState, setPreviewLevel, type PreviewLevel } from '../lib/notify';
import { newRecoveryPhrase } from '../crypto/recovery';
import { ago, describeUA } from '../lib/format';
import { Avatar, CopyField, Modal, QR, Spinner, useAsync } from '../components/ui';
import { X } from 'lucide-react';
import { setPrefs, usePrefs, type ChatBg, type FontSize } from '../lib/prefs';
import { disableLockUnsafe, enableLock, lockEnabled, lockIdleMinutes, lockNow, setIdleMinutes, validatePin, verifyPin } from '../lib/applock';
import { LANG, tr } from '../lib/i18n';
import { setPrivacy, unblock, useSocial } from '../lib/social';
import { AccountData } from '../components/AccountData';
import { AvatarPicker } from '../components/AvatarPicker';
import { removeMyAvatar, setMyAvatar, useAvatars } from '../lib/avatars';
import { TwoFactorSettings } from '../components/TwoFactor';
import { ApproveLinkButton } from '../components/DeviceLink';
import { OpenArchiveButton } from '../components/ExportDialog';

export function NewDirectDialog({ onClose }: { onClose: () => void }) {
  const [u, setU] = useState('');
  const { busy, error, run } = useAsync();
  return (
    <Modal title={tr('新建私聊')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const user = await findUser(u.trim());
            if (user.id === useStore.getState().me!.id) throw new Error(tr('不能和自己聊天'));
            const id = await createDirect(user.id);
            onClose();
            await openChat(id);
          });
        }}
      >
        <input placeholder={tr('对方的用户名，例如 alice')} value={u} onChange={(e) => setU(e.target.value)} autoFocus required />
        <p className="muted small">{tr('出于隐私，只能按完整用户名查找，不支持模糊搜索。也可以让对方把「我的名片」链接发给你。')}</p>
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy}>
          {busy ? <Spinner /> : tr('开始加密聊天')}
        </button>
      </form>
    </Modal>
  );
}

export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [u, setU] = useState('');
  const [members, setMembers] = useState<{ id: string; username: string; displayName: string }[]>([]);
  const add = useAsync();
  const create = useAsync();
  return (
    <Modal title={tr('新建群组')} onClose={onClose}>
      <div className="stack">
        <input placeholder={tr('群名称（加密保存）')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={64} autoFocus />
        <form
          className="row gap"
          onSubmit={(e) => {
            e.preventDefault();
            add.run(async () => {
              const user = await findUser(u.trim());
              if (user.id === useStore.getState().me!.id) throw new Error(tr('你已经在群里了'));
              if (!members.some((m) => m.id === user.id)) setMembers([...members, user]);
              setU('');
            });
          }}
        >
          <input placeholder={tr('添加成员：输入用户名')} value={u} onChange={(e) => setU(e.target.value)} />
          <button className="btn secondary" disabled={add.busy || !u.trim()}>
            {tr('添加')}
          </button>
        </form>
        {add.error && <p className="error">{add.error}</p>}
        <div className="chips">
          {members.map((m) => (
            <span key={m.id} className="chip">
              {m.displayName}
              <button onClick={() => setMembers(members.filter((x) => x.id !== m.id))} aria-label={tr('移除')}>
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
        <p className="muted small">{tr('也可以先创建空群，再用「邀请链接」邀请成员。')}</p>
        {create.error && <p className="error">{create.error}</p>}
        <button
          className="btn"
          disabled={create.busy || !title.trim()}
          onClick={() =>
            create.run(async () => {
              const id = await createGroup(
                title.trim(),
                members.map((m) => m.id),
              );
              onClose();
              await openChat(id);
            })
          }
        >
          {create.busy ? <Spinner /> : tr('创建群组')}
        </button>
      </div>
    </Modal>
  );
}

interface SessionRow {
  id: string;
  deviceName: string | null;
  userAgent: string;
  ip: string;
  lastSeenAt: number;
  current: boolean;
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const [tab, setTab] = useState<'profile' | 'devices' | 'security' | 'privacy' | 'notify' | 'look'>('profile');
  return (
    <Modal title={tr('设置')} onClose={onClose} wide>
      <div className="tabs">
        <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>
          {tr('个人资料')}
        </button>
        <button className={tab === 'devices' ? 'active' : ''} onClick={() => setTab('devices')}>
          {tr('设备管理')}
        </button>
        <button className={tab === 'notify' ? 'active' : ''} onClick={() => setTab('notify')}>
          {tr('通知与存储')}
        </button>
        <button className={tab === 'look' ? 'active' : ''} onClick={() => setTab('look')}>
          {tr('外观与快捷键')}
        </button>
        <button className={tab === 'privacy' ? 'active' : ''} onClick={() => setTab('privacy')}>
          {tr('隐私')}
        </button>
        <button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}>
          {tr('安全')}
        </button>
      </div>
      {tab === 'profile' && <Profile />}
      {tab === 'devices' && <Devices />}
      {tab === 'security' && (
        <>
          <TwoFactorSettings />
          <hr />
          <AppLockSettings />
          <hr />
          <Security />
          <hr />
          <RecoveryWords />
          <hr />
          <AccountData />
          <hr />
          <CodeFingerprint />
        </>
      )}
      {tab === 'notify' && <NotifyAndStorage />}
      {tab === 'privacy' && <PrivacySettings />}
      {tab === 'look' && <Appearance />}
      <hr />
      <div className="row between">
        <span className="muted small">
          @{me.username}
          {me.isAdmin && tr(' · 管理员')} · {tr('密聊')} v{__APP_VERSION__}
        </span>
        <button className="btn danger ghost" onClick={() => logout()}>
          {tr('退出登录')}
        </button>
      </div>
    </Modal>
  );
}

function Profile() {
  const me = useStore((s) => s.me)!;
  const [f, setF] = useState({ displayName: me.displayName, bio: me.bio });
  const { busy, error, run } = useAsync();
  const card = `${location.origin}/u/${me.username}`;
  const myPic = useAvatars((s) => s.users[me.id]);
  return (
    <div className="stack">
      <div className="row gap">
        <AvatarPicker has={!!myPic} label={tr('更换头像')} onPick={setMyAvatar} onRemove={removeMyAvatar}>
          <Avatar id={me.id} user={me.id} name={f.displayName} size={64} />
        </AvatarPicker>
        <div className="grow stack">
          <input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} maxLength={64} placeholder={tr('昵称')} />
          <input value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} maxLength={200} placeholder={tr('个人简介')} />
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <button
        className="btn"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const r = await api.patch('/api/me', f);
            updateMe(r.user);
            toast(tr('已保存'));
          })
        }
      >
        {tr('保存')}
      </button>
      <h4>{tr('我的名片')}</h4>
      <p className="muted small">{tr('把链接或二维码发给已注册的朋友，对方打开即可和你发起加密私聊。')}</p>
      <CopyField value={card} />
      <div className="center">
        <QR text={card} size={160} />
      </div>
    </div>
  );
}

function Devices() {
  const [list, setList] = useState<SessionRow[] | null>(null);
  const reload = () => api.get('/api/auth/sessions').then((r) => setList(r.sessions));
  useEffect(() => {
    reload();
  }, []);
  if (!list) return <Spinner />;
  return (
    <div className="stack">
      <div>
        <ApproveLinkButton />
      </div>
      {list.map((s) => (
        <div key={s.id} className="device">
          <div className="grow">
            <b>{s.deviceName ?? describeUA(s.userAgent)}</b> {s.current && <span className="badge ok">{tr('当前设备')}</span>}
            <div className="muted small">
              {tr('{v0}IP {v1} · 最后活动 {v2}', { v0: s.deviceName ? `${describeUA(s.userAgent)} · ` : '', v1: s.ip, v2: ago(s.lastSeenAt) })}
            </div>
          </div>
          {!s.current && (
            <button className="btn danger ghost small" onClick={() => api.del(`/api/auth/sessions/${s.id}`).then(reload)}>
              {tr('下线')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Security() {
  const [f, setF] = useState({ old: '', next: '', confirm: '' });
  const { busy, error, setError, run } = useAsync();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (f.next.length < 10) return setError(tr('新密码至少 10 位'));
        if (f.next !== f.confirm) return setError(tr('两次输入不一致'));
        run(async () => {
          await changePassword(f.old, f.next);
          setF({ old: '', next: '', confirm: '' });
          toast(tr('密码已修改，其他设备已下线'));
        });
      }}
    >
      <h4>{tr('修改密码')}</h4>
      <p className="muted small">{tr('修改密码会在本机重新加密你的私钥备份，聊天记录不受影响；其他设备会被强制下线。')}</p>
      <input type="password" placeholder={tr('当前密码')} value={f.old} onChange={(e) => setF({ ...f, old: e.target.value })} autoComplete="current-password" required />
      <input type="password" placeholder={tr('新密码（至少 10 位）')} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" required />
      <input type="password" placeholder={tr('确认新密码')} value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" required />
      {error && <p className="error">{error}</p>}
      <button className="btn" disabled={busy}>
        {busy ? <Spinner /> : tr('修改密码')}
      </button>
    </form>
  );
}

function NotifyAndStorage() {
  const [push, setPush] = useState<string>('…');
  const level = usePrefs((p) => p.notifyPreview);
  const mentionBypass = usePrefs((p) => p.mentionBypassMute);
  const errorReports = usePrefs((p) => p.errorReports);
  const [cache, setCache] = useState(localCacheInfo());
  const { busy, error, run } = useAsync();
  useEffect(() => {
    pushState().then(setPush);
  }, []);
  return (
    <div className="stack">
      <div>
        <OpenArchiveButton />
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('推送通知')}</b>
          <div className="muted small">
            {tr('网页关闭时也能收到提醒。推送内容只有「你有新消息」，不含发送者、聊天或内容——服务器本来也看不到。')}
            {push === 'unsupported' && tr(' 此浏览器不支持（iPhone 需先「添加到主屏幕」再从主屏幕打开）。')}
            {push === 'denied' && tr(' 通知权限已被拒绝，请在浏览器设置里允许。')}
          </div>
        </div>
        {(push === 'on' || push === 'off') && (
          <button
            className={`btn ${push === 'on' ? 'ghost' : ''}`}
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (push === 'on') await disablePush();
                else await enablePush();
                setPush(await pushState());
              })
            }
          >
            {push === 'on' ? tr('关闭') : tr('开启')}
          </button>
        )}
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('网页打开时的通知显示')}</b>
          <div className="muted small">{tr('网页在后台时，由本机解密后生成通知')}</div>
        </div>
        <select
          value={level}
          onChange={(e) => {
            setPreviewLevel(e.target.value as PreviewLevel);
            if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
          }}
        >
          <option value="none">{tr('不显示任何信息')}</option>
          <option value="sender">{tr('只显示发送者')}</option>
          <option value="full">{tr('显示发送者和内容')}</option>
        </select>
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('免打扰的聊天里有人 @我 时仍然通知')}</b>
          <div className="muted small">{tr('只在网页打开时有效；只对这台设备生效')}</div>
        </div>
        <input type="checkbox" className="switch" checked={mentionBypass} onChange={(e) => setPrefs({ mentionBypassMute: e.target.checked })} aria-label={tr('免打扰的聊天里有人 @我 时仍然通知')} />
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('发送匿名错误报告')}</b>
          <div className="muted small">{tr('页面出错时，把错误信息（不含聊天内容和账号）发给管理员，帮助修复问题。只对这台设备生效')}</div>
        </div>
        <input type="checkbox" className="switch" checked={errorReports} onChange={(e) => setPrefs({ errorReports: e.target.checked })} aria-label={tr('发送匿名错误报告')} />
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('本机加密缓存（用于搜索和离线查看）')}</b>
          <div className="muted small">
            {tr('已缓存 {v0} 条消息。缓存用本机不可导出的密钥加密；删除的消息会同步从缓存移除；退出登录时清空。', { v0: cache.count })}
          </div>
        </div>
        <button
          className={`btn ${cache.enabled ? 'ghost' : ''}`}
          disabled={busy}
          onClick={() =>
            run(async () => {
              await setLocalCache(!cache.enabled);
              setCache(localCacheInfo());
            })
          }
        >
          {cache.enabled ? tr('关闭并清除') : tr('开启')}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function RecoveryWords() {
  const [step, setStep] = useState<'idle' | 'password' | 'words' | 'done'>('idle');
  const [pw, setPw] = useState('');
  const [phrase] = useState(() => newRecoveryPhrase());
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAsync();
  if (step === 'idle' || step === 'done')
    return (
      <div className="stack">
        <h4>{tr('恢复词')}</h4>
        <p className="muted small">
          {step === 'done' ? tr('新的恢复词已生效，旧的恢复词已作废。') : tr('恢复词丢了或可能被别人看到？生成一组新的，旧的会立即作废。')}
        </p>
        {step === 'idle' && (
          <button className="btn secondary" onClick={() => setStep('password')}>
            {tr('重新生成恢复词')}
          </button>
        )}
      </div>
    );
  if (step === 'password')
    return (
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setStep('words');
        }}
      >
        <h4>{tr('重新生成恢复词')}</h4>
        <input type="password" placeholder={tr('输入当前密码以确认')} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required autoFocus />
        <button className="btn">{tr('下一步')}</button>
      </form>
    );
  return (
    <div className="stack">
      <h4>{tr('新的恢复词')}</h4>
      <ol className="words">
        {phrase.split(' ').map((w, i) => (
          <li key={i}>
            <span>{i + 1}</span>
            {w}
          </li>
        ))}
      </ol>
      <p className="warn small">{tr('请手抄保存。确认后旧恢复词立即作废。')}</p>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {tr('我已经抄写好了')}
      </label>
      {error && <p className="error">{error}</p>}
      <button
        className="btn"
        disabled={!saved || busy}
        onClick={() =>
          run(async () => {
            await regenerateRecovery(pw, phrase);
            setPw('');
            setStep('done');
          })
        }
      >
        {busy ? <Spinner /> : tr('确认启用新恢复词')}
      </button>
    </div>
  );
}

const FONT_SIZES: [FontSize, string][] = [
  ['s', tr('小')],
  ['m', tr('标准')],
  ['l', tr('大')],
  ['xl', tr('特大')],
];
const BACKGROUNDS: [ChatBg, string][] = [
  ['dots', tr('点阵')],
  ['plain', tr('纯色')],
  ['aurora', tr('极光')],
  ['grid', tr('网格')],
  ['paper', tr('纸张')],
];
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function Appearance() {
  const p = usePrefs();
  return (
    <div className="stack">
      <p className="muted small">{tr('聊天背景、通知预览、链接预览、隐私屏、通话中转和本机缓存设置会加密同步到你的其他设备；语言、字体大小和回车键只对这台设备生效。')}</p>
      <div className="pref-row">
        <div>
          <b>{tr('界面语言')}</b>
          <div className="muted small">Language</div>
        </div>
        <div className="choice-row">
          {([['zh', '中文'], ['en', 'English']] as const).map(([k, l]) => (
            <button
              key={k}
              className={`choice ${LANG === k ? 'on' : ''}`}
              onClick={() => {
                if (LANG === k) return;
                setPrefs({ lang: k });
                location.reload();
              }}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('消息文字大小')}</b>
        </div>
        <div className="choice-row">
          {FONT_SIZES.map(([k, l]) => (
            <button key={k} className={`choice ${p.fontSize === k ? 'on' : ''}`} onClick={() => setPrefs({ fontSize: k })}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('聊天背景')}</b>
        </div>
        <div className="choice-row">
          {BACKGROUNDS.map(([k, l]) => (
            <button key={k} className={`choice ${p.chatBg === k ? 'on' : ''}`} onClick={() => setPrefs({ chatBg: k })}>
              <span className={`bg-swatch ${k}`} />
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('发送方式')}</b>
          <div className="muted small">{p.enterSends ? tr('Enter 发送，Shift+Enter 换行') : tr('{v0}+Enter 发送，Enter 换行', { v0: MOD })}</div>
        </div>
        <div className="choice-row">
          <button className={`choice ${p.enterSends ? 'on' : ''}`} onClick={() => setPrefs({ enterSends: true })}>
            Enter
          </button>
          <button className={`choice ${!p.enterSends ? 'on' : ''}`} onClick={() => setPrefs({ enterSends: false })}>
            {MOD}+Enter
          </button>
        </div>
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('隐私屏')}</b>
          <div className="muted small">{tr('切到后台或锁屏时模糊整个页面，别人在应用切换界面里看不到聊天内容。')}</div>
        </div>
        <input type="checkbox" className="switch" checked={p.privacyScreen} onChange={(e) => setPrefs({ privacyScreen: e.target.checked })} aria-label={tr('隐私屏')} />
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('链接预览')}</b>
          <div className="muted small">
            {tr('发送带链接的消息时显示标题和图片。开启后由服务器代你打开该网页（服务器会知道你预览了哪个链接）；预览内容随消息一起端到端加密，对方不会访问该网站。')}
          </div>
        </div>
        <input type="checkbox" className="switch" checked={p.linkPreview} onChange={(e) => setPrefs({ linkPreview: e.target.checked })} aria-label={tr('链接预览')} />
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('通话时隐藏我的 IP')}</b>
          <div className="muted small">{tr('语音 / 视频通话只走服务器的 TURN 中转，对方看不到你的 IP 地址（需要服务器已安装 coturn；延迟可能略高）。通话内容始终端到端加密。')}</div>
        </div>
        <input type="checkbox" className="switch" checked={p.callRelayOnly} onChange={(e) => setPrefs({ callRelayOnly: e.target.checked })} aria-label={tr('通话时隐藏我的 IP')} />
      </div>
      <h4>{tr('键盘快捷键')}</h4>
      <div className="kbd-list">
        <kbd>{MOD} K</kbd>
        <span>{tr('搜索聊天和消息')}</span>
        <kbd>Alt ↑ / ↓</kbd>
        <span>{tr('切换到上一个 / 下一个聊天')}</span>
        <kbd>{MOD} Shift N</kbd>
        <span>{tr('新建私聊')}</span>
        <kbd>{MOD} ,</kbd>
        <span>{tr('打开设置')}</span>
        <kbd>Esc</kbd>
        <span>{tr('关闭弹窗、取消回复或编辑')}</span>
        <kbd>↑</kbd>
        <span>{tr('输入框为空时，编辑自己的上一条消息')}</span>
      </div>
      <p className="muted small">{tr('外观设置只保存在这台设备的浏览器里。')}</p>
    </div>
  );
}

const IDLE_OPTIONS: [number, string][] = [
  [0, tr('不自动锁定')],
  [1, tr('1 分钟')],
  [5, tr('5 分钟')],
  [15, tr('15 分钟')],
  [60, tr('1 小时')],
];

function AppLockSettings() {
  const [on, setOn] = useState(lockEnabled());
  const [idle, setIdle] = useState(lockIdleMinutes() || 5);
  const [pin, setPin] = useState({ a: '', b: '', cur: '' });
  const [mode, setMode] = useState<'idle' | 'setup' | 'disable'>('idle');
  const { busy, error, setError, run } = useAsync();
  return (
    <div className="stack">
      <div className="pref-row">
        <div>
          <b>{tr('本机应用锁')}</b>
          <div className="muted small">
            {tr('打开网页或闲置一段时间后需要输入 PIN。锁定时不解密任何内容。只对这台设备生效；忘记 PIN 可退出登录后用账号密码重新登录。')}
          </div>
        </div>
        {on ? (
          <div className="row gap">
            <button className="btn secondary" onClick={() => lockNow()}>
              {tr('立即锁定')}
            </button>
            <button className="btn ghost" onClick={() => setMode(mode === 'disable' ? 'idle' : 'disable')}>
              {tr('关闭')}
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => setMode(mode === 'setup' ? 'idle' : 'setup')}>
            {tr('开启')}
          </button>
        )}
      </div>
      {on && (
        <div className="pref-row">
          <div>
            <b>{tr('闲置自动锁定')}</b>
          </div>
          <select
            value={lockIdleMinutes()}
            onChange={(e) => {
              setIdleMinutes(Number(e.target.value));
              setIdle(Number(e.target.value));
              toast(tr('设置已保存，刷新后生效'));
            }}
          >
            {IDLE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      )}
      {mode === 'setup' && !on && (
        <form
          className="stack invite-box"
          onSubmit={(e) => {
            e.preventDefault();
            const bad = validatePin(pin.a);
            if (bad) return setError(bad);
            if (pin.a !== pin.b) return setError(tr('两次输入的 PIN 不一致'));
            run(async () => {
              await enableLock(pin.a, idle);
              setOn(true);
              setMode('idle');
              setPin({ a: '', b: '', cur: '' });
              toast(tr('应用锁已开启'));
            });
          }}
        >
          <input type="password" inputMode="numeric" autoComplete="new-password" placeholder={tr('设置 PIN（至少 4 位）')} value={pin.a} onChange={(e) => setPin({ ...pin, a: e.target.value })} autoFocus />
          <input type="password" inputMode="numeric" autoComplete="new-password" placeholder={tr('再输入一次')} value={pin.b} onChange={(e) => setPin({ ...pin, b: e.target.value })} />
          <label className="field">
            {tr('闲置多久自动锁定')}
            <select value={idle} onChange={(e) => setIdle(Number(e.target.value))}>
              {IDLE_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn" disabled={busy}>
            {tr('开启应用锁')}
          </button>
        </form>
      )}
      {mode === 'disable' && on && (
        <form
          className="row gap invite-box"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await verifyPin(pin.cur);
              if (!r.ok) throw new Error(r.wipe ? tr('PIN 错误次数过多') : tr('PIN 错误'));
              disableLockUnsafe();
              setOn(false);
              setMode('idle');
              setPin({ a: '', b: '', cur: '' });
              toast(tr('应用锁已关闭'));
            });
          }}
        >
          <input className="grow" type="password" inputMode="numeric" placeholder={tr('输入当前 PIN 确认关闭')} value={pin.cur} onChange={(e) => setPin({ ...pin, cur: e.target.value })} autoFocus />
          <button className="btn danger" disabled={busy || !pin.cur}>
            {tr('关闭应用锁')}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
    </div>
  );
}

function PrivacySettings() {
  const p = useSocial((s) => s.privacy);
  const blocked = useSocial((s) => s.blocked);
  const a = useAsync();
  return (
    <div className="stack">
      <div className="pref-row">
        <div>
          <b>{tr('隐藏我的在线状态')}</b>
          <div className="muted small">{tr('别人看不到你是否在线。公平起见，你也看不到别人的在线状态。')}</div>
        </div>
        <input type="checkbox" className="switch" checked={p.hideOnline} onChange={(e) => a.run(() => setPrivacy({ hideOnline: e.target.checked }))} aria-label={tr('隐藏我的在线状态')} />
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('不发送已读回执')}</b>
          <div className="muted small">{tr('别人看不到你是否已读。公平起见，你也看不到别人的已读状态。')}</div>
        </div>
        <input type="checkbox" className="switch" checked={p.noReceipts} onChange={(e) => a.run(() => setPrivacy({ noReceipts: e.target.checked }))} aria-label={tr('不发送已读回执')} />
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('模糊显示我的在线状态')}</b>
          <div className="muted small">{tr('别人仍能看到你「在线」，但上线、下线都会随机延迟几分钟到半小时显示，看不出你准确什么时候在用。下次上线时生效。')}</div>
        </div>
        <input type="checkbox" className="switch" checked={!!p.coarseOnline} disabled={p.hideOnline} onChange={(e) => a.run(() => setPrivacy({ coarseOnline: e.target.checked }))} aria-label={tr('模糊显示我的在线状态')} />
      </div>
      <div className="pref-row">
        <div>
          <b>{tr('推送通知延迟合并')}</b>
          <div className="muted small">{tr('网页关着时的推送延迟 2–8 分钟，期间的新消息合并成一条。推送服务商（Google、Apple 等）就更难把推送和具体某条消息对上。')}</div>
        </div>
        <input type="checkbox" className="switch" checked={!!p.pushDelay} onChange={(e) => a.run(() => setPrivacy({ pushDelay: e.target.checked }))} aria-label={tr('推送通知延迟合并')} />
      </div>
      {a.error && <p className="error">{a.error}</p>}
      <h4>{tr('已屏蔽的人（{v0}）', { v0: blocked.length })}</h4>
      {blocked.length === 0 ? (
        <p className="muted small">{tr('在私聊的「用户信息」里可以屏蔽某人。被屏蔽的人不能给你发消息、打电话或把你拉进群，也不会收到通知。')}</p>
      ) : (
        <div className="stack tight">
          {blocked.map((b) => (
            <div key={b.id} className="row between">
              <span>
                {b.displayName} <span className="muted small">@{b.username}</span>
              </span>
              <button className="btn small secondary" onClick={() => a.run(() => unblock(b.id))}>
                {tr('取消屏蔽')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CodeFingerprint() {
  const { result, checking } = useCodeFp();
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!result && !checking) checkCodeFingerprint().catch((e) => setErr(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="pref-row col">
      <div>
        <b>{tr('网页代码指纹')}</b>
        <div className="muted small">
          {tr('把它和更新说明里的指纹比对，一致说明你运行的就是发布的代码。注意：被恶意替换的代码也可能伪造这里的显示，更可靠的核对是服务器管理员运行 ops/fingerprint.mjs。')}
        </div>
      </div>
      {err ? (
        <div className="error">{err}</div>
      ) : !result ? (
        <div className="muted small">{tr('正在计算…')}</div>
      ) : (
        <div className="fp-box">
          <code className="safety-code">{prettyFp(result.computed)}</code>
          <div className={`small ${result.signed === 'valid' && result.ok ? 'ok-text' : result.signed === 'missing' ? 'muted' : 'error'}`}>
            {result.signed === 'valid' && result.ok
              ? tr('已由发布密钥签名（密钥 {v0}）', { v0: result.keyId })
              : result.signed === 'missing'
                ? tr('这个版本没有签名')
                : result.signed === 'valid'
                  ? tr('签名有效，但文件和签过名的清单对不上！')
                  : tr('签名无效！')}
          </div>
          <div className={`small ${result.ok ? 'ok-text' : 'error'}`}>
            v{result.version} · {result.ok ? tr('文件与清单一致（要核对的是上面这个数字，而不是这行字）') : tr('与这个版本自带的清单不一致')}
          </div>
          {result.changedSilently && (
            <div className="key-warning">
              {tr('网页代码在版本号没变的情况下发生了变化。如果管理员最近没有改动过服务器，请提醒他检查。')}
              <button className="btn small" onClick={acceptCurrentCode}>
                {tr('我知道了')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
