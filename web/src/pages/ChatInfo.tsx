import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  useStore,
  safetyNumberWith,
  acceptKeyChange,
  setDisappearing,
  clearHistory,
  deleteChat,
  renameGroup,
  addMembers,
  removeMember,
  setRole,
  findUser,
  toast,
  listJoinRequests,
  rejectJoin,
  setChatCacheDisabled,
  saveSettings,
  setPostPolicy,
  muteMember,
  type Chat,
  type JoinRequest,
} from '../lib/store';
import { DISAPPEAR_OPTIONS, fullTime } from '../lib/format';
import { X, KeyRound, HardDriveDownload, Timer, UserPlus, Link2, Eraser, LogOut, Trash2, ShieldCheck, ShieldAlert, ChevronRight, NotebookPen, Ban, ScanLine, BadgeCheck, Megaphone, MessageSquareOff, FileDown, BellOff, Images, LockKeyhole } from 'lucide-react';
import { SharedMedia } from '../components/SharedMedia';
import { startSecretChat } from '../lib/secret';
import { isNotifyOff, setChatNotify } from '../lib/store';
import { Avatar, CopyField, Modal, QR, useAsync } from '../components/ui';
import { usePrefs } from '../lib/prefs';
import { tr } from '../lib/i18n';
import { AvatarPicker } from '../components/AvatarPicker';
import { setGroupAvatar, useAvatars } from '../lib/avatars';
import { block, isVerified, markVerified, saveContact, unblock, useChatTitle, useSocial } from '../lib/social';
import { QrScanner } from '../components/QrScanner';
import { ExportDialog } from '../components/ExportDialog';

export function ChatInfo({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const titleOf = useChatTitle();
  const [exporting, setExporting] = useState(false);
  const [startingSecret, setStartingSecret] = useState(false);
  const me = useStore((s) => s.me)!;
  const warn = useStore((s) => s.keyWarnings);
  const peer = chat.type === 'direct' ? chat.members.find((m) => m.id !== me.id) : undefined;
  const isAdmin = chat.myRole !== 'member';
  const groupPic = useAvatars((s) => s.groups[chat.id]);
  const [shared, setShared] = useState(false);
  const [dialog, setDialog] = useState<null | 'clear' | 'delete' | 'invite' | 'safety' | 'add'>(null);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const noCache = usePrefs((p) => p.noCache.includes(chat.id));

  return (
    <aside className="info-panel">
      <div className="info-head">
        <h2>{chat.type === 'group' ? tr('群组信息') : tr('用户信息')}</h2>
        <button className="icon-btn" onClick={onClose} aria-label={tr('关闭')}>
          <X size={20} />
        </button>
      </div>
      <div className="info-body">
        <div className="info-profile">
          {chat.type === 'group' && isAdmin ? (
            <AvatarPicker has={!!groupPic} label={tr('更换群头像')} onPick={(f) => setGroupAvatar(chat.id, f)} onRemove={() => setGroupAvatar(chat.id, null)}>
              <Avatar id={chat.id} chat={chat} name={titleOf(chat)} size={88} group />
            </AvatarPicker>
          ) : (
            <Avatar id={chat.id} chat={chat} name={titleOf(chat)} size={88} group={chat.type === 'group'} />
          )}
          {renaming ? (
            <form
              className="row gap"
              onSubmit={async (e) => {
                e.preventDefault();
                await renameGroup(chat.id, title.trim()).catch((er) => toast(er.message));
                setRenaming(false);
              }}
            >
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={64} autoFocus />
              <button className="btn">{tr('保存')}</button>
            </form>
          ) : (
            <h3>
              {titleOf(chat)}
              {chat.type === 'group' && isAdmin && (
                <button className="link" style={{ marginLeft: 8, fontSize: 13 }} onClick={() => setRenaming(true)}>
                  {tr('改名')}
                </button>
              )}
            </h3>
          )}
          {peer && (
            <p className="muted">
              {titleOf(chat) !== peer.displayName && <>{peer.displayName} · </>}@{peer.username} · {peer.online ? tr('在线') : tr('离线')}
            </p>
          )}
          {chat.type === 'group' && <p className="muted">{tr('{v0} 位成员', { v0: chat.members.length })}</p>}
        </div>

        {peer && (
          <button className="info-row" onClick={() => setDialog('safety')}>
            <span className="info-ic">
              <KeyRound size={18} />
            </span>
            <span className="grow">{tr('查看安全码')}</span>
            {warn[peer.id] ? <span className="badge warn">{tr('已变更')}</span> : <VerifiedBadge userId={peer.id} />}
            <ChevronRight size={18} className="muted" />
          </button>
        )}

        {peer && <ContactCard userId={peer.id} />}

        {peer && !peer.deleted && (
          <button
            className="info-row"
            disabled={startingSecret}
            onClick={() => {
              setStartingSecret(true);
              startSecretChat(peer.id, titleOf(chat))
                .then(onClose)
                .catch((e) => toast(e.message))
                .finally(() => setStartingSecret(false));
            }}
          >
            <span className="info-ic secret-ic">
              <LockKeyhole size={18} />
            </span>
            <span className="grow">
              {tr('发起私密对话')}
              <span className="muted small block">{tr('只在你们两台设备上，有前向保密，不保存在服务器')}</span>
            </span>
            <ChevronRight size={18} className="muted" />
          </button>
        )}

        <label className="info-row">
          <span className="info-ic">
            <Timer size={18} />
          </span>
          <span className="grow">{tr('阅后即焚')}</span>
          <select
            value={chat.disappearingSeconds}
            disabled={chat.type === 'group' && !isAdmin}
            onChange={(e) => setDisappearing(chat.id, Number(e.target.value)).catch((er) => toast(er.message))}
          >
            {DISAPPEAR_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>

        <label className="info-row">
          <span className="info-ic">
            <BellOff size={18} />
          </span>
          <span className="grow">
            {tr('免打扰')}
            {isNotifyOff(chat) && chat.notifyOffUntil !== -1 && (
              <span className="muted small block">{tr('到 {v0} 为止', { v0: fullTime(chat.notifyOffUntil) })}</span>
            )}
          </span>
          <select
            value={!isNotifyOff(chat) ? '0' : chat.notifyOffUntil === -1 ? '-1' : 'timed'}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'timed') return;
              const n = Number(v);
              setChatNotify(chat.id, n <= 0 ? n : Date.now() + n).catch((er) => toast(er.message));
            }}
          >
            <option value="0">{tr('关闭')}</option>
            {isNotifyOff(chat) && chat.notifyOffUntil !== -1 && <option value="timed">{tr('已开启')}</option>}
            <option value={3_600_000}>{tr('1 小时')}</option>
            <option value={8 * 3_600_000}>{tr('8 小时')}</option>
            <option value={86_400_000}>{tr('1 天')}</option>
            <option value={7 * 86_400_000}>{tr('7 天')}</option>
            <option value="-1">{tr('一直')}</option>
          </select>
        </label>

        <label className="info-row">
          <span className="info-ic">
            <HardDriveDownload size={18} />
          </span>
          <span className="grow">
            {tr('保存到本机缓存')}
            <span className="muted small block">{tr('关闭后这个聊天不能离线查看、不能本机搜索，已缓存的内容会立即删除')}</span>
          </span>
          <input type="checkbox" className="switch" checked={!noCache} onChange={(e) => setChatCacheDisabled(chat.id, !e.target.checked)} />
        </label>

        <button className="info-row" onClick={() => setShared(true)}>
          <span className="info-ic">
            <Images size={18} />
          </span>
          <span className="grow">{tr('共享内容')}</span>
          <span className="muted small">{tr('图片、文件、语音、链接')}</span>
          <ChevronRight size={18} className="muted" />
        </button>
        {shared && <SharedMedia chat={chat} onClose={() => setShared(false)} />}

        <button className="info-row" onClick={() => setExporting(true)}>
          <span className="info-ic">
            <FileDown size={18} />
          </span>
          <span className="grow">{tr('导出聊天记录')}</span>
          <ChevronRight size={18} className="muted" />
        </button>
        {exporting && <ExportDialog chat={chat} onClose={() => setExporting(false)} />}

        {chat.type === 'group' && <GroupModeration chat={chat} isAdmin={isAdmin} />}

        {chat.type === 'group' && (
          <>
            <div className="info-section">
              <div className="row between">
                <h4>{tr('成员')}</h4>
                {isAdmin && (
                  <div className="row gap">
                    <button className="link inline-ic" onClick={() => setDialog('add')}>
                      <UserPlus size={15} /> {tr('添加')}
                    </button>
                    <button className="link inline-ic" onClick={() => setDialog('invite')}>
                      <Link2 size={15} /> {tr('邀请链接')}
                    </button>
                  </div>
                )}
              </div>
              {chat.members.map((m) => (
                <div key={m.id} className="member">
                  <Avatar id={m.id} user={m.id} name={m.displayName} size={36} online={m.online} />
                  <div className="grow">
                    <div>
                      {m.displayName} {m.id === me.id && <span className="muted">{tr('(你)')}</span>}
                    </div>
                    <div className="muted small">
                      @{m.username}
                      {m.mutedUntil && m.mutedUntil > Date.now() && <span className="badge warn" style={{ marginLeft: 6 }}>{tr('禁言中')}</span>}
                    </div>
                  </div>
                  {m.role !== 'member' && <span className="role">{m.role === 'owner' ? tr('群主') : tr('管理员')}</span>}
                  {m.id !== me.id && chat.myRole === 'owner' && (
                    <button className="link small" onClick={() => setRole(chat.id, m.id, m.role === 'admin' ? 'member' : 'admin').catch((e) => toast(e.message))}>
                      {m.role === 'admin' ? tr('撤销管理') : tr('设为管理')}
                    </button>
                  )}
                  {m.id !== me.id && isAdmin && m.role === 'member' && (
                    <select
                      className="mute-select"
                      value=""
                      aria-label={tr('禁言')}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        muteMember(chat.id, m.id, v <= 0 ? v : Date.now() + v).catch((er) => toast(er.message));
                      }}
                    >
                      <option value="" disabled>
                        {m.mutedUntil && m.mutedUntil > Date.now() ? tr('禁言中') : tr('禁言')}
                      </option>
                      <option value={3_600_000}>{tr('1 小时')}</option>
                      <option value={86_400_000}>{tr('1 天')}</option>
                      <option value={7 * 86_400_000}>{tr('7 天')}</option>
                      <option value={-1}>{tr('直到解除')}</option>
                      {m.mutedUntil && m.mutedUntil > Date.now() && <option value={0}>{tr('解除禁言')}</option>}
                    </select>
                  )}
                  {m.id !== me.id && isAdmin && m.role !== 'owner' && !(m.role === 'admin' && chat.myRole !== 'owner') && (
                    <button className="link small danger" onClick={() => confirm(tr('将 {v0} 移出群组？', { v0: m.displayName })) && removeMember(chat.id, m.id).catch((e) => toast(e.message))}>
                      {tr('移除')}
                    </button>
                  )}
                </div>
              ))}
            </div>
            {isAdmin && chat.pendingJoins > 0 && <JoinRequests chat={chat} />}
          </>
        )}

        <div className="info-section">
          <button className="info-row danger" onClick={() => setDialog('clear')}>
            <span className="info-ic">
              <Eraser size={18} />
            </span>
            {tr('清空聊天记录')}
          </button>
          <button className="info-row danger" onClick={() => setDialog('delete')}>
            <span className="info-ic">{chat.type === 'group' ? <LogOut size={18} /> : <Trash2 size={18} />}</span>
            {chat.type === 'group' ? tr('退出 / 解散群组') : tr('删除聊天')}
          </button>
        </div>
        <p className="muted small center">
          {tr('创建于 {v0} · 密钥纪元 #{v1} · 成员版本 #{v2}', { v0: fullTime(chat.createdAt), v1: chat.currentEpoch, v2: chat.membershipVersion })}{' '}
          {chat.integrity === 'ok' ? (
            <span className="inline-ic ok-text">
              · <ShieldCheck size={13} /> {tr('成员签名已验证')}
            </span>
          ) : null}
          {chat.settings?.status === 'signed' || chat.settings?.status === 'resign' ? (
            <span className="inline-ic ok-text">
              {' '}
              · <ShieldCheck size={13} /> {tr('设置已签名（v{v0}）', { v0: chat.settings.v })}
            </span>
          ) : chat.settings && chat.settings.status !== 'unsigned' ? (
            <span className="inline-ic danger">
              {' '}
              · <ShieldAlert size={13} /> {tr('设置签名异常')}
            </span>
          ) : null}
          {chat.integrity === 'ok' ? null : chat.integrity === 'mismatch' ? (
            <span className="inline-ic danger">
              · <ShieldAlert size={13} /> {tr('成员签名校验失败')}
            </span>
          ) : (
            ''
          )}
        </p>
      </div>

      {dialog === 'safety' && peer && <SafetyDialog peerId={peer.id} name={peer.displayName} onClose={() => setDialog(null)} />}
      {dialog === 'clear' && <ClearDialog chat={chat} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteChatDialog chat={chat} onClose={() => setDialog(null)} />}
      {dialog === 'invite' && <GroupInviteDialog chat={chat} onClose={() => setDialog(null)} />}
      {dialog === 'add' && <AddMemberDialog chat={chat} onClose={() => setDialog(null)} />}
    </aside>
  );
}

function SafetyDialog({ peerId, name, onClose }: { peerId: string; name: string; onClose: () => void }) {
  const [num, setNum] = useState('');
  const [scan, setScan] = useState(false);
  const [verified, setVerified] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const contact = useSocial((s) => s.contacts[peerId]);
  const warn = useStore((s) => s.keyWarnings[peerId]);
  useEffect(() => {
    safetyNumberWith(peerId).then(setNum);
    isVerified(peerId).then(setVerified);
  }, [peerId, contact?.verifiedKey]);
  const digits = num.replace(/ /g, '');
  return (
    <Modal title={tr('与 {v0} 的安全码', { v0: name })} onClose={onClose}>
      {verified && !warn && (
        <p className="ok-text inline-ic">
          <ShieldCheck size={15} /> {tr('你已当面核对过此人的安全码')}
        </p>
      )}
      <p className="muted small">{tr('当面让对方扫描你的二维码，或你扫描对方的；也可以逐位比对下面的数字。一致说明你们之间的加密没有被中间人替换。')}</p>
      <pre className="safety">{num.match(/.{1,23}/g)?.join('\n')}</pre>
      {num && (
        <div className="center">
          <QR text={`securechat-safety:${digits}`} size={180} />
        </div>
      )}
      {msg && <p className={msg.ok ? 'ok-text' : 'error'}>{msg.text}</p>}
      <div className="row gap wrap">
        <button className="btn secondary" onClick={() => (setMsg(null), setScan(true))}>
          <ScanLine size={16} /> {tr('扫描对方的二维码')}
        </button>
        {!verified && !warn && (
          <button className="btn ghost" onClick={() => markVerified(peerId).then(() => setMsg({ ok: true, text: tr('已标记为已核对') }))}>
            {tr('数字一致，标记为已核对')}
          </button>
        )}
      </div>
      {warn && (
        <button className="btn" onClick={() => acceptKeyChange(peerId).then(onClose)}>
          {tr('我已核对，信任新的安全码')}
        </button>
      )}
      {scan && (
        <QrScanner
          title={tr('扫描对方的安全码')}
          hint={tr('让对方打开与你的聊天 → 用户信息 → 查看安全码，把二维码对准摄像头。')}
          onClose={() => setScan(false)}
          onResult={async (text) => {
            setScan(false);
            const got = /^securechat-safety:(\d+)$/.exec(text)?.[1];
            if (!got) return setMsg({ ok: false, text: tr('这不是密聊的安全码二维码') });
            if (got !== digits) return setMsg({ ok: false, text: tr('安全码不一致！可能有人在中间冒充。请不要通过这个聊天发送敏感内容，并换一种方式联系对方确认。') });
            if (warn) await acceptKeyChange(peerId);
            await markVerified(peerId);
            setMsg({ ok: true, text: tr('安全码一致，已标记为已核对') });
          }}
        />
      )}
    </Modal>
  );
}

function ClearDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const peer = chat.type === 'direct' ? chat.members.find((m) => m.id !== me.id) : undefined;
  const canBoth = chat.type === 'direct' || chat.myRole !== 'member';
  const [both, setBoth] = useState(false);
  const { busy, error, run } = useAsync();
  return (
    <Modal title={tr('清空聊天记录？')} onClose={onClose}>
      {canBoth && (
        <label className="check">
          <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} />
          {peer ? tr('同时为 {v0} 清空', { v0: peer.displayName }) : tr('为所有成员清空')}
        </label>
      )}
      <p className="muted small">{both ? tr('所有消息将从服务器永久删除，所有人都看不到。') : tr('只清空你这边，其他人的记录不受影响。')}</p>
      {error && <p className="error">{error}</p>}
      <div className="row end gap">
        <button className="btn ghost" onClick={onClose}>
          {tr('取消')}
        </button>
        <button className="btn danger" disabled={busy} onClick={() => run(async () => (await clearHistory(chat.id, both ? 'everyone' : 'me'), onClose()))}>
          {tr('清空')}
        </button>
      </div>
    </Modal>
  );
}

function DeleteChatDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const peer = chat.type === 'direct' ? chat.members.find((m) => m.id !== me.id) : undefined;
  const [both, setBoth] = useState(false);
  const { busy, error, run } = useAsync();
  if (chat.type === 'group')
    return (
      <Modal title={tr('退出群组')} onClose={onClose}>
        <p className="muted small">{tr('退出后你将看不到之后的消息，群密钥会自动轮换。')}</p>
        {error && <p className="error">{error}</p>}
        <div className="stack">
          <button className="btn danger" disabled={busy} onClick={() => run(async () => (await removeMember(chat.id, me.id), onClose()))}>
            {tr('退出群组')}
          </button>
          {chat.myRole === 'owner' && (
            <button className="btn danger ghost" disabled={busy} onClick={() => confirm(tr('解散后所有成员的聊天记录都会被永久删除，确定？')) && run(async () => (await deleteChat(chat.id, true), onClose()))}>
              {tr('解散群组（为所有人删除）')}
            </button>
          )}
        </div>
      </Modal>
    );
  return (
    <Modal title={tr('删除聊天？')} onClose={onClose}>
      <label className="check">
        <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} />
        {tr('同时为 {v0} 删除', { v0: peer?.displayName })}
      </label>
      <p className="muted small">{both ? tr('整个聊天及全部消息将从服务器和对方设备上永久删除。') : tr('只从你的列表中删除并清空你这边的记录。')}</p>
      {error && <p className="error">{error}</p>}
      <div className="row end gap">
        <button className="btn ghost" onClick={onClose}>
          {tr('取消')}
        </button>
        <button className="btn danger" disabled={busy} onClick={() => run(async () => (await deleteChat(chat.id, both), onClose()))}>
          {tr('删除')}
        </button>
      </div>
    </Modal>
  );
}

interface InviteRow {
  id: string;
  maxUses: number | null;
  usedCount: number;
  expiresAt: number | null;
  createdAt: number;
}

function GroupInviteDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const [list, setList] = useState<InviteRow[]>([]);
  const [fresh, setFresh] = useState<{ token: string; code: string } | null>(null);
  const [opts, setOpts] = useState({ expiresInHours: 24, maxUses: 0, needsApproval: false });
  const { busy, error, run } = useAsync();
  const reload = () => api.get(`/api/chats/${chat.id}/invites`).then((r) => setList(r.invites));
  useEffect(() => {
    reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const link = fresh ? `${location.origin}/i/${fresh.token}` : '';
  return (
    <Modal title={tr('群邀请链接')} onClose={onClose}>
      <div className="row gap wrap">
        <label className="field">
          {tr('有效期')}
          <select value={opts.expiresInHours} onChange={(e) => setOpts({ ...opts, expiresInHours: Number(e.target.value) })}>
            <option value={1}>{tr('1 小时')}</option>
            <option value={24}>{tr('1 天')}</option>
            <option value={168}>{tr('7 天')}</option>
            <option value={0}>{tr('永久')}</option>
          </select>
        </label>
        <label className="field">
          {tr('可用次数')}
          <select value={opts.maxUses} onChange={(e) => setOpts({ ...opts, maxUses: Number(e.target.value) })}>
            <option value={1}>{tr('1 次')}</option>
            <option value={5}>{tr('5 次')}</option>
            <option value={20}>{tr('20 次')}</option>
            <option value={0}>{tr('不限')}</option>
          </select>
        </label>
        <label className="check small">
          <input type="checkbox" checked={opts.needsApproval} onChange={(e) => setOpts({ ...opts, needsApproval: e.target.checked })} />
          {tr('需要审批')}
        </label>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await api.post(`/api/chats/${chat.id}/invites`, {
                expiresInHours: opts.expiresInHours || undefined,
                maxUses: opts.maxUses || undefined,
                needsApproval: opts.needsApproval,
              });
              setFresh(r);
              reload();
            })
          }
        >
          {tr('生成新链接')}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {fresh && (
        <div className="invite-box">
          <CopyField value={link} label={tr('邀请链接（同时可放行对方的 IP）')} />
          <CopyField value={fresh.code} label={tr('邀请码（可在验证页输入）')} />
          <div className="center">
            <QR text={link} />
          </div>
          <p className="muted small">{tr('链接只显示这一次，请现在复制。对方点开后，由在线的管理员设备为其签名入群并更换群密钥')}{opts.needsApproval ? tr('（需要你在「成员」下方手动批准）') : tr('（自动完成）')}。</p>
        </div>
      )}
      <h4>{tr('有效的邀请')}</h4>
      {list.length === 0 && <p className="muted small">{tr('暂无')}</p>}
      {list.map((i) => (
        <div key={i.id} className="row between invite-row">
          <span className="small">
            {tr('已用')} {i.usedCount}
            {i.maxUses ? ` / ${i.maxUses}` : ''} {tr('次')} · {i.expiresAt ? tr('到期 {v0}', { v0: fullTime(i.expiresAt) }) : tr('永久')}
          </span>
          <button className="link danger small" onClick={() => api.del(`/api/invites/${i.id}`).then(reload)}>
            {tr('撤销')}
          </button>
        </div>
      ))}
    </Modal>
  );
}

function AddMemberDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const [u, setU] = useState('');
  const { busy, error, run } = useAsync();
  return (
    <Modal title={tr('添加成员')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const user = await findUser(u.trim());
            if (chat.members.some((m) => m.id === user.id)) throw new Error(tr('该用户已在群内'));
            await addMembers(chat.id, [user.id]);
            toast(tr('已添加 {v0}', { v0: user.displayName }));
            onClose();
          });
        }}
      >
        <input placeholder={tr('对方的用户名（完整输入）')} value={u} onChange={(e) => setU(e.target.value)} autoFocus required />
        <p className="muted small">{tr('新成员只能看到加入之后的消息。添加后群密钥会自动轮换。')}</p>
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy}>
          {tr('添加')}
        </button>
      </form>
    </Modal>
  );
}

function JoinRequests({ chat }: { chat: Chat }) {
  const [list, setList] = useState<JoinRequest[] | null>(null);
  const reload = () => listJoinRequests(chat.id).then(setList).catch(() => setList([]));
  useEffect(() => {
    reload();
  }, [chat.pendingJoins]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list?.length) return null;
  return (
    <div className="info-section">
      <h4>{tr('入群申请')}</h4>
      {list.map((r) => (
        <div key={r.userId} className="join-req">
          <Avatar id={r.userId} user={r.userId} name={r.displayName} size={32} />
          <div className="grow">
            <div>{r.displayName}</div>
            <div className="muted small">
              @{r.username} · {r.autoApprove ? tr('等待自动签名') : tr('需要审批')}
            </div>
          </div>
          <button className="btn small" onClick={() => addMembers(chat.id, [r.userId]).then(reload).catch((e) => toast(e.message))}>
            {tr('批准')}
          </button>
          <button className="btn small ghost" onClick={() => rejectJoin(chat.id, r.userId).then(reload)}>
            {tr('拒绝')}
          </button>
        </div>
      ))}
    </div>
  );
}

/** My private notes about a contact (alias + note, end-to-end encrypted in my vault) and block / unblock. */
function ContactCard({ userId }: { userId: string }) {
  const c = useSocial((s) => s.contacts[userId]);
  const blocked = useSocial((s) => s.blocked.some((b) => b.id === userId));
  const [editing, setEditing] = useState(false);
  const [alias, setAlias] = useState('');
  const [note, setNote] = useState('');
  const a = useAsync();
  return (
    <>
      {editing ? (
        <form
          className="contact-edit stack"
          onSubmit={(e) => {
            e.preventDefault();
            a.run(async () => {
              await saveContact(userId, { alias, note });
              setEditing(false);
            });
          }}
        >
          <label className="field">
            {tr('备注名')}
            <input value={alias} maxLength={64} onChange={(e) => setAlias(e.target.value)} placeholder={tr('只有你自己能看到')} autoFocus />
          </label>
          <label className="field">
            {tr('备注')}
            <textarea rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder={tr('例如：怎么认识的、生日…（端到端加密）')} />
          </label>
          {a.error && <p className="error">{a.error}</p>}
          <div className="row gap">
            <button className="btn small" disabled={a.busy}>
              {tr('保存')}
            </button>
            <button type="button" className="btn small secondary" onClick={() => setEditing(false)}>
              {tr('取消')}
            </button>
          </div>
        </form>
      ) : (
        <button
          className="info-row"
          onClick={() => {
            setAlias(c?.alias ?? '');
            setNote(c?.note ?? '');
            setEditing(true);
          }}
        >
          <span className="info-ic">
            <NotebookPen size={18} />
          </span>
          <span className="grow">
            {c?.alias || c?.note ? (
              <>
                {c.alias && <b>{c.alias}</b>}
                {c.note && <span className="muted small contact-note">{c.note}</span>}
              </>
            ) : (
              tr('添加备注名和备注')
            )}
          </span>
          <ChevronRight size={18} className="muted" />
        </button>
      )}
      <button
        className={`info-row ${blocked ? '' : 'danger'}`}
        onClick={() => {
          if (blocked) unblock(userId).catch((e) => toast(e.message));
          else if (confirm(tr('屏蔽后，对方无法给你发消息、打电话或把你拉进群。对方不会收到通知。继续？'))) block(userId).catch((e) => toast(e.message));
        }}
      >
        <span className="info-ic">
          <Ban size={18} />
        </span>
        <span className="grow">{blocked ? tr('取消屏蔽') : tr('屏蔽此人')}</span>
      </button>
    </>
  );
}

function VerifiedBadge({ userId }: { userId: string }) {
  const key = useSocial((s) => s.contacts[userId]?.verifiedKey);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    isVerified(userId).then(setOk);
  }, [userId, key]);
  return ok ? (
    <span className="badge ok inline-ic">
      <BadgeCheck size={12} /> {tr('已核对')}
    </span>
  ) : null;
}

/** Announcement (admin-signed) and who may post (server-enforced). */
function GroupModeration({ chat, isAdmin }: { chat: Chat; isAdmin: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const a = useAsync();
  const ann = chat.settings && ['signed', 'resign', 'mismatch'].includes(chat.settings.status) ? chat.settings.ann ?? '' : '';
  if (!isAdmin && !ann) return null;
  return (
    <div className="info-section">
      <div className="row between">
        <h4 className="inline-ic">
          <Megaphone size={15} /> {tr('群公告')}
        </h4>
        {isAdmin && !editing && (
          <button className="link small" onClick={() => (setText(ann), setEditing(true))}>
            {ann ? tr('编辑') : tr('发布公告')}
          </button>
        )}
      </div>
      {editing ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            a.run(async () => {
              await saveSettings(chat.id, { announcement: text });
              setEditing(false);
            });
          }}
        >
          <textarea rows={4} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder={tr('公告内容会由你签名并端到端加密，所有成员可见；留空即撤下公告')} autoFocus />
          {a.error && <p className="error">{a.error}</p>}
          <div className="row gap">
            <button className="btn small" disabled={a.busy}>
              {tr('发布')}
            </button>
            <button type="button" className="btn small secondary" onClick={() => setEditing(false)}>
              {tr('取消')}
            </button>
          </div>
        </form>
      ) : ann ? (
        <p className="announce-full">{ann}</p>
      ) : (
        <p className="muted small">{tr('还没有公告')}</p>
      )}
      {isAdmin && (
        <label className="info-row">
          <span className="info-ic">
            <MessageSquareOff size={18} />
          </span>
          <span className="grow">
            {tr('仅管理员可发言')}
            <span className="muted small" style={{ display: 'block' }}>
              {tr('开启后普通成员只能看、回应和投票，适合通知群')}
            </span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={chat.postPolicy === 'admins'}
            onChange={(e) => setPostPolicy(chat.id, e.target.checked ? 'admins' : 'all').catch((er) => toast(er.message))}
          />
        </label>
      )}
    </div>
  );
}
