import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { getSocket, toast } from '../lib/store';
import { ago, fullTime } from '../lib/format';
import { formatSize } from '../lib/files';
import { CopyField, QR, Spinner, useAsync } from '../components/ui';
import { BellRing, DatabaseBackup, KeyRound, ShieldAlert, UserCog, ArrowLeft, Inbox, Globe, Ticket, Users as UsersIcon, ScrollText, Settings as SettingsIcon, UserRound, Ban, MessagesSquare, HardDrive, MapPin, BarChart3, History, Sparkles, Cloud, CloudOff, CircleCheck, CircleAlert, Bug } from 'lucide-react';
import { tr } from '../lib/i18n';

type Tab = 'requests' | 'allowlist' | 'invites' | 'users' | 'stats' | 'alerts' | 'backup' | 'audit' | 'errors' | 'log' | 'settings';

export function AdminPage({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<Tab>('requests');
  const [ov, setOv] = useState<Record<string, any> | null>(null);
  const loadOv = () => api.get('/api/admin/overview').then(setOv);
  useEffect(() => {
    loadOv();
    const t = setInterval(loadOv, 10_000);
    const s = getSocket();
    s?.on('admin:alert', loadOv);
    return () => {
      clearInterval(t);
      s?.off('admin:alert', loadOv);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const tabs: [Tab, string, ReactNode, ReactNode?][] = [
    ['requests', tr('准入申请'), <Inbox size={17} />, ov?.pendingRequests ? <span className="badge">{ov.pendingRequests}</span> : null],
    ['allowlist', tr('IP 白名单'), <Globe size={17} />],
    ['invites', tr('注册邀请'), <Ticket size={17} />],
    ['users', tr('用户'), <UsersIcon size={17} />],
    ['stats', tr('统计'), <BarChart3 size={17} />],
    ['alerts', tr('告警'), <BellRing size={17} />, ov?.unreadAlerts ? <span className="badge danger-solid">{ov.unreadAlerts}</span> : null],
    ['backup', tr('备份'), <DatabaseBackup size={17} />],
    ['audit', tr('操作记录'), <History size={17} />],
    ['errors', tr('错误日志'), <Bug size={17} />],
    ['log', tr('验证日志'), <ScrollText size={17} />],
    ['settings', tr('系统设置'), <SettingsIcon size={17} />],
  ];
  return (
    <div className="admin">
      <header className="admin-head">
        <button className="icon-btn" onClick={onExit} aria-label={tr('返回')}>
          <ArrowLeft size={21} />
        </button>
        <h1>{tr('管理后台')}</h1>
      </header>
      {ov && (
        <div className="stats">
          <Stat icon={<UserRound size={18} />} label={tr('用户')} value={ov.users} />
          <Stat icon={<Globe size={18} />} label={tr('白名单')} value={ov.allowlist} />
          <Stat icon={<Ban size={18} />} label={tr('封禁')} value={ov.blocked} tone={ov.blocked ? 'warn' : undefined} />
          <Stat icon={<MessagesSquare size={18} />} label={tr('聊天')} value={ov.chats} />
          <Stat icon={<HardDrive size={18} />} label={tr('附件（密文）')} value={formatSize(ov.storageBytes ?? 0)} />
          <Stat icon={<MapPin size={18} />} label={tr('你的 IP')} value={ov.yourIp} mono />
        </div>
      )}
      <nav className="tabs">
        {tabs.map(([k, l, icon, extra]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {icon} {l} {extra}
          </button>
        ))}
      </nav>
      <div className="admin-body">
        {tab === 'requests' && <Requests onChange={loadOv} />}
        {tab === 'allowlist' && <Allowlist />}
        {tab === 'invites' && <Invites />}
        {tab === 'users' && <Users />}
        {tab === 'alerts' && <Alerts onChange={loadOv} />}
        {tab === 'log' && <Log />}
        {tab === 'stats' && <Stats />}
        {tab === 'backup' && <Backups />}
        {tab === 'audit' && <Audit />}
        {tab === 'errors' && <ClientErrors />}
        {tab === 'settings' && <Settings />}
      </div>
    </div>
  );
}

function Stat({ icon, label, value, tone, mono }: { icon: ReactNode; label: string; value: ReactNode; tone?: 'warn'; mono?: boolean }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <span className="stat-ic">{icon}</span>
      <div>
        <div className={`stat-val ${mono ? 'mono' : ''}`}>{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

function useList<T>(url: string, key: string) {
  const [rows, setRows] = useState<T[] | null>(null);
  const reload = () => api.get(url).then((r) => setRows(r[key]));
  useEffect(() => {
    reload();
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, reload };
}

function Requests({ onChange }: { onChange: () => void }) {
  const { rows, reload } = useList<any>('/api/admin/gate-requests', 'requests');
  if (!rows) return <Spinner />;
  if (!rows.length) return <p className="muted">{tr('暂无申请。未授权的访客可以在验证页提交申请。')}</p>;
  const act = async (id: string, a: 'approve' | 'reject') => {
    await api.post(`/api/admin/gate-requests/${id}/${a}`);
    reload();
    onChange();
  };
  return (
    <table>
      <thead>
        <tr>
          <th>{tr('时间')}</th>
          <th>IP</th>
          <th>{tr('留言')}</th>
          <th>{tr('设备')}</th>
          <th>{tr('状态')}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{fullTime(r.createdAt)}</td>
            <td>{r.ip}</td>
            <td>{r.message || <span className="muted">—</span>}</td>
            <td className="ua">{r.userAgent}</td>
            <td>{{ pending: tr('待处理'), approved: tr('已批准'), rejected: tr('已拒绝') }[r.status as string]}</td>
            <td className="actions">
              {r.status === 'pending' && (
                <>
                  <button className="btn small" onClick={() => act(r.id, 'approve')}>
                    {tr('批准')}
                  </button>
                  <button className="btn small ghost" onClick={() => act(r.id, 'reject')}>
                    {tr('拒绝')}
                  </button>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Allowlist() {
  const { rows, reload } = useList<any>('/api/admin/allowlist', 'entries');
  const blocked = useList<any>('/api/admin/blocklist', 'entries');
  const [ip, setIp] = useState('');
  const [note, setNote] = useState('');
  const { error, run } = useAsync();
  return (
    <div className="stack">
      <form
        className="row gap wrap"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api.post('/api/admin/allowlist', { ip: ip.trim(), note });
            setIp('');
            setNote('');
            reload();
          });
        }}
      >
        <input placeholder={tr('手动添加 IP')} value={ip} onChange={(e) => setIp(e.target.value)} required />
        <input placeholder={tr('备注')} value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn">{tr('添加')}</button>
      </form>
      {error && <p className="error">{error}</p>}
      {!rows ? (
        <Spinner />
      ) : (
        <table>
          <thead>
            <tr>
              <th>{tr('IP / 网段')}</th>
              <th>{tr('来源')}</th>
              <th>{tr('备注')}</th>
              <th>{tr('首次')}</th>
              <th>{tr('最近')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.ipKey} {r.current && <span className="badge ok">{tr('当前')}</span>}
                </td>
                <td>{{ password: tr('访问密码'), invite: tr('邀请'), approval: tr('审批'), admin: tr('手动'), cli: tr('命令行') }[r.source as string] ?? r.source}</td>
                <td>
                  <input
                    className="inline"
                    defaultValue={r.note ?? ''}
                    onBlur={(e) => e.target.value !== (r.note ?? '') && api.patch(`/api/admin/allowlist/${r.id}`, { note: e.target.value }).then(() => toast(tr('备注已保存')))}
                  />
                </td>
                <td>{fullTime(r.createdAt)}</td>
                <td>{ago(r.lastSeenAt)}</td>
                <td className="actions">
                  {!r.current && (
                    <button className="btn small danger ghost" onClick={() => api.del(`/api/admin/allowlist/${r.id}`).then(reload)}>
                      {tr('移除')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>{tr('封禁中的 IP')}</h3>
      {blocked.rows?.length === 0 && <p className="muted small">{tr('无')}</p>}
      {blocked.rows?.map((b) => (
        <div key={b.ipKey} className="row between invite-row">
          <span>
            {b.ipKey} · {tr('失败 {v0} 次', { v0: b.totalFails })} · {b.permanent ? tr('永久封禁') : tr('至 {v0}', { v0: fullTime(b.blockedUntil) })}
          </span>
          <button className="btn small ghost" onClick={() => api.del(`/api/admin/blocklist/${encodeURIComponent(b.ipKey)}`).then(blocked.reload)}>
            {tr('解封')}
          </button>
        </div>
      ))}
    </div>
  );
}

function Invites() {
  const { rows, reload } = useList<any>('/api/admin/invites', 'invites');
  const [opts, setOpts] = useState({ maxUses: 1, expiresInHours: 72, note: '', grantsAdmin: false });
  const [fresh, setFresh] = useState<{ token: string; code: string } | null>(null);
  const { busy, error, run } = useAsync();
  const link = fresh ? `${location.origin}/i/${fresh.token}` : '';
  return (
    <div className="stack">
      <div className="row gap wrap">
        <label className="field">
          {tr('可用次数')}
          <select value={opts.maxUses} onChange={(e) => setOpts({ ...opts, maxUses: Number(e.target.value) })}>
            <option value={1}>{tr('1 次')}</option>
            <option value={5}>{tr('5 次')}</option>
            <option value={20}>{tr('20 次')}</option>
            <option value={0}>{tr('不限')}</option>
          </select>
        </label>
        <label className="field">
          {tr('有效期')}
          <select value={opts.expiresInHours} onChange={(e) => setOpts({ ...opts, expiresInHours: Number(e.target.value) })}>
            <option value={1}>{tr('1 小时')}</option>
            <option value={24}>{tr('1 天')}</option>
            <option value={72}>{tr('3 天')}</option>
            <option value={720}>{tr('30 天')}</option>
            <option value={0}>{tr('永久')}</option>
          </select>
        </label>
        <input placeholder={tr('备注（给谁的）')} value={opts.note} onChange={(e) => setOpts({ ...opts, note: e.target.value })} />
        <label className="check">
          <input type="checkbox" checked={opts.grantsAdmin} onChange={(e) => setOpts({ ...opts, grantsAdmin: e.target.checked, maxUses: e.target.checked ? 1 : opts.maxUses })} />
          {tr('管理员')}
        </label>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setFresh(await api.post('/api/admin/invites', opts));
              reload();
            })
          }
        >
          {tr('生成邀请')}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {fresh && (
        <div className="invite-box">
          <div className="row gap wrap">
            <QR text={link} size={170} />
            <div className="grow stack">
              <CopyField value={link} label={tr('邀请链接：对方打开即可通过 IP 验证并注册')} />
              <CopyField value={fresh.code} label={tr('邀请码：在验证页输入，可口头告知')} />
              <p className="muted small">{tr('链接和邀请码只显示这一次。')}</p>
            </div>
          </div>
        </div>
      )}
      {!rows ? (
        <Spinner />
      ) : (
        <table>
          <thead>
            <tr>
              <th>{tr('创建')}</th>
              <th>{tr('备注')}</th>
              <th>{tr('使用')}</th>
              <th>{tr('到期')}</th>
              <th>{tr('状态')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const dead = r.revokedAt || (r.expiresAt && r.expiresAt < Date.now()) || (r.maxUses && r.usedCount >= r.maxUses);
              return (
                <tr key={r.id} className={dead ? 'dim' : ''}>
                  <td>{fullTime(r.createdAt)}</td>
                  <td>
                    {r.note ?? '—'} {r.grantsAdmin && <span className="badge warn">{tr('管理员')}</span>}
                  </td>
                  <td>
                    {tr('注册')} {r.usedCount}
                    {r.maxUses ? `/${r.maxUses}` : ''} · {tr('放行 {v0}', { v0: r.gateUses })}
                  </td>
                  <td>{r.expiresAt ? fullTime(r.expiresAt) : tr('永久')}</td>
                  <td>{r.revokedAt ? tr('已撤销') : dead ? tr('已失效') : tr('有效')}</td>
                  <td className="actions">
                    {!dead && (
                      <button className="btn small danger ghost" onClick={() => api.del(`/api/invites/${r.id}`).then(reload)}>
                        {tr('撤销')}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Users() {
  const [data, setData] = useState<{ users: any[]; defaultQuotaMb: number } | null>(null);
  const reload = () => api.get('/api/admin/users').then(setData);
  useEffect(() => {
    reload();
  }, []);
  if (!data) return <Spinner />;
  const act = (id: string, a: string) =>
    api
      .post(`/api/admin/users/${id}/${a}`)
      .then(reload)
      .catch((e) => toast(e.message));
  const setQuota = (u: any) => {
    const v = prompt(tr('@{v0} 每 24 小时的上传额度（MB）。留空 = 使用默认值 {v1} MB', { v0: u.username, v1: data.defaultQuotaMb }), u.quotaMb ?? '');
    if (v === null) return;
    api
      .put(`/api/admin/users/${u.id}/quota`, { quotaMb: v.trim() === '' ? null : Number(v) })
      .then(reload)
      .catch((e) => toast(e.message));
  };
  return (
    <table>
      <thead>
        <tr>
          <th>{tr('用户')}</th>
          <th>{tr('最近活动')}</th>
          <th>{tr('设备')}</th>
          <th>{tr('消息')}</th>
          <th>{tr('附件占用')}</th>
          <th>{tr('今日上传 / 额度')}</th>
          <th>{tr('注册')}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {data.users.map((u) => {
          const quota = (u.quotaMb ?? data.defaultQuotaMb) * 1024 * 1024;
          const pct = Math.min(100, Math.round((u.uploadedToday / quota) * 100));
          return (
            <tr key={u.id} className={u.disabledAt ? 'dim' : ''}>
              <td>
                <div className="user-cell">
                  <b>{u.displayName}</b> <span className="muted">@{u.username}</span>
                  {u.isAdmin && <span className="badge warn">{tr('管理员')}</span>}
                  {u.totp && <span className="badge ok" title={tr('已开启两步验证')}>2FA</span>}
                  {u.deletedAt ? <span className="badge">{tr('已注销')}</span> : u.disabledAt && <span className="badge danger">{tr('已停用')}</span>}
                </div>
                <div className="muted small">{tr('邀请人')} {u.invitedBy ?? '—'}</div>
              </td>
              <td>{u.online ? <span className="badge ok">{tr('在线')}</span> : ago(u.lastSeenAt)}</td>
              <td>{u.sessions}</td>
              <td>{u.messages}</td>
              <td>{formatSize(u.storageBytes)}</td>
              <td>
                <div className="quota">
                  <div className="quota-bar">
                    <div style={{ width: `${pct}%` }} className={pct > 85 ? 'hot' : ''} />
                  </div>
                  <button className="link small" onClick={() => setQuota(u)} title={tr('修改额度')}>
                    {formatSize(u.uploadedToday)} / {u.quotaMb ? `${u.quotaMb} MB` : tr('默认 {v0} MB', { v0: data.defaultQuotaMb })}
                  </button>
                </div>
              </td>
              <td className="muted small">{fullTime(u.createdAt)}</td>
              <td className="actions">
                {u.deletedAt ? null : u.disabledAt ? (
                  <button className="btn small ghost" onClick={() => act(u.id, 'enable')}>
                    {tr('启用')}
                  </button>
                ) : (
                  <button className="btn small danger ghost" onClick={() => confirm(tr('停用 {v0}？其所有设备将被下线。', { v0: u.displayName })) && act(u.id, 'disable')}>
                    {tr('停用')}
                  </button>
                )}
                {!u.deletedAt && (
                  <button className="btn small ghost" onClick={() => act(u.id, u.isAdmin ? 'revoke-admin' : 'make-admin')}>
                    {u.isAdmin ? tr('撤销管理员') : tr('设为管理员')}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const ALERT_ICON: Record<string, ReactNode> = {
  ip_banned: <Ban size={18} />,
  ip_blocked: <ShieldAlert size={18} />,
  gate_flood: <ShieldAlert size={18} />,
  login_bruteforce: <KeyRound size={18} />,
  disk_low: <HardDrive size={18} />,
  backup_stale: <DatabaseBackup size={18} />,
  offsite_failed: <CloudOff size={18} />,
  offsite_stale: <CloudOff size={18} />,
  admin_change: <UserCog size={18} />,
};

/** Backup health (local daily snapshot + optional encrypted off-site copy). */
function Backups() {
  const [b, setB] = useState<any>(null);
  useEffect(() => {
    api.get('/api/admin/backup-status').then(setB).catch(() => setB({ error: true }));
  }, []);
  if (!b) return <Spinner />;
  if (b.error) return <p className="error">{tr('无法读取备份状态')}</p>;
  const stale = (t: number | null, h: number) => !t || Date.now() - t > h * 3_600_000;
  const Row = ({ ok, title, children }: { ok: boolean | null; title: string; children: ReactNode }) => (
    <div className={`backup-row ${ok === null ? '' : ok ? 'ok' : 'bad'}`}>
      <span className="backup-ic">{ok === null ? <Cloud size={20} /> : ok ? <CircleCheck size={20} /> : <CircleAlert size={20} />}</span>
      <div className="grow">
        <b>{title}</b>
        <div className="muted small">{children}</div>
      </div>
    </div>
  );
  return (
    <div className="stack">
      {!b.installed ? (
        <Row ok={false} title={tr('本地备份')}>
          {tr('还没有备份记录。请在服务器上运行 ops/install-service.sh 安装每日备份，或手动运行 ops/backup.sh。')}
        </Row>
      ) : (
        <Row ok={!stale(b.local.last, 36)} title={tr('本地备份（每天一次）')}>
          {tr('最近一次：{v0}（{v1}）', { v0: fullTime(b.local.last), v1: ago(b.local.last) })}
          {b.local.size && <> · {tr('本次 {v0}', { v0: b.local.size })}</>}
          {b.local.count && <> · {tr('共 {v0} 份，占用 {v1}', { v0: b.local.count, v1: b.local.total ?? '?' })}</>}
        </Row>
      )}
      {!b.offsite.configured ? (
        <Row ok={null} title={tr('异地备份（未开启）')}>
          {tr('服务器整体损坏时，本地备份也会一起丢失。建议开启：先在服务器执行 rclone config 添加存储，再运行 ops/setup-offsite.sh。')}
        </Row>
      ) : (
        <Row ok={!b.offsite.failedAt && !stale(b.offsite.last, 48)} title={tr('异地备份')}>
          {b.offsite.remote}
          {' · '}
          {b.offsite.last ? tr('最近上传：{v0}（{v1}）', { v0: fullTime(b.offsite.last), v1: ago(b.offsite.last) }) : tr('还没有成功上传过')}
          {b.offsite.failedAt && (
            <span className="error block">{tr('{v0} 上传失败，请在服务器上查看 journalctl -u securechat-backup', { v0: fullTime(b.offsite.failedAt) })}</span>
          )}
        </Row>
      )}
      <p className="muted small">{tr('备份内容：数据库快照和附件（都是密文）+ 登录密钥文件。异地备份在上传前用 AES-256 再加密一次，存储商看不到内容。')}</p>
    </div>
  );
}

function Alerts({ onChange }: { onChange: () => void }) {
  const { rows, reload } = useList<any>('/api/admin/alerts', 'alerts');
  useEffect(() => {
    const s = getSocket();
    const f = () => reload();
    s?.on('admin:alert', f);
    return () => {
      s?.off('admin:alert', f);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows) return <Spinner />;
  const unread = rows.filter((r) => !r.readAt).length;
  return (
    <div className="stack">
      <div className="row between">
        <span className="muted small">{tr('保留最近 90 天。封禁、密码爆破、磁盘空间、备份过期、管理员变更都会在这里提醒，并推送到开启了通知的管理员设备。')}</span>
        {unread > 0 && (
          <button className="btn small secondary" onClick={() => api.post('/api/admin/alerts/read-all').then(() => (reload(), onChange()))}>
            {tr('全部标为已读')}
          </button>
        )}
      </div>
      {rows.length === 0 && (
        <div className="empty">
          <div className="empty-ic">
            <BellRing size={26} />
          </div>
          <p>{tr('暂无告警')}</p>
        </div>
      )}
      <div className="alert-list">
        {rows.map((r) => (
          <div key={r.id} className={`alert-item ${r.readAt ? '' : 'unread'} k-${r.kind}`}>
            <span className="alert-ic">{ALERT_ICON[r.kind] ?? <BellRing size={18} />}</span>
            <div className="grow">
              <div>{r.message}</div>
              <div className="muted small">{fullTime(r.createdAt)}</div>
            </div>
            {!r.readAt && <span className="dot" />}
          </div>
        ))}
      </div>
    </div>
  );
}

function Log() {
  const { rows } = useList<any>('/api/admin/gate-attempts?limit=200', 'attempts');
  if (!rows) return <Spinner />;
  return (
    <table>
      <thead>
        <tr>
          <th>{tr('时间')}</th>
          <th>IP</th>
          <th>{tr('方式')}</th>
          <th>{tr('结果')}</th>
          <th>{tr('设备')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{fullTime(r.createdAt)}</td>
            <td>{r.ip}</td>
            <td>{{ password: tr('访问密码'), invite: tr('邀请'), request: tr('申请审批') }[r.method as string] ?? r.method}</td>
            <td>{r.success ? <span className="badge ok">{tr('成功')}</span> : <span className="badge danger">{tr('失败')}</span>}</td>
            <td className="ua">{r.userAgent}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Settings() {
  const [pw, setPw] = useState('');
  const a = useAsync();
  const b = useAsync();
  return (
    <div className="stack narrow">
      <h3>{tr('访问密码')}</h3>
      <p className="muted small">{tr('新 IP 输入此密码即可通过验证并被记住。修改后，已记住的 IP 不受影响。')}</p>
      <form
        className="row gap"
        onSubmit={(e) => {
          e.preventDefault();
          a.run(async () => {
            await api.put('/api/admin/gate-password', { password: pw });
            setPw('');
            toast(tr('访问密码已更新'));
          });
        }}
      >
        <input type="password" placeholder={tr('新的访问密码（至少 8 位）')} value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required autoComplete="new-password" />
        <button className="btn">{tr('保存')}</button>
      </form>
      {a.error && <p className="error">{a.error}</p>}
      <LimitsForm />
      <h3>{tr('紧急锁定')}</h3>
      <p className="muted small">{tr('清空除你当前 IP 外的所有白名单，并让除当前设备外的所有会话下线。怀疑访问密码泄露时使用，之后请立即更换访问密码。')}</p>
      {b.error && <p className="error">{b.error}</p>}
      <button
        className="btn danger"
        disabled={b.busy}
        onClick={() =>
          confirm(tr('确定执行紧急锁定？所有其他人都需要重新验证和登录。')) &&
          b.run(async () => {
            const r = await api.post('/api/admin/lockdown');
            toast(tr('已锁定，下线 {v0} 个会话', { v0: r.revokedSessions }));
          })
        }
      >
        {tr('紧急锁定')}
      </button>
    </div>
  );
}

function LimitsForm() {
  const [v, setV] = useState<{ gate: Record<string, number>; limits: Record<string, number | boolean> } | null>(null);
  const a = useAsync();
  useEffect(() => {
    api.get('/api/admin/limits').then(setV);
  }, []);
  if (!v) return <Spinner />;
  const num = (grp: 'gate' | 'limits', k: string, label: string, unit: string, hint?: string) => (
    <label className="field">
      {label}
      <div className="row gap">
        <input type="number" min={0} value={Number(v[grp][k])} onChange={(e) => setV({ ...v, [grp]: { ...v[grp], [k]: Number(e.target.value) } })} />
        <span className="muted small nowrap">{unit}</span>
      </div>
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        a.run(async () => {
          setV(await api.put('/api/admin/limits', v));
          toast(tr('规则已保存，立即生效'));
        });
      }}
    >
      <h3>{tr('封禁规则')}</h3>
      <div className="form-grid">
        {num('gate', 'maxFails', tr('连续输错几次后暂时封禁'), tr('次'))}
        {num('gate', 'windowMin', tr('统计时间窗口'), tr('分钟'), tr('在这段时间内累计输错才算连续'))}
        {num('gate', 'blockMin', tr('暂时封禁时长'), tr('分钟'))}
        {num('gate', 'permanentAfter', tr('累计输错几次后永久封禁'), tr('次'), tr('0 = 永不永久封禁'))}
      </div>
      <h3>{tr('上传额度')}</h3>
      <div className="form-grid">
        {num('limits', 'dailyUploadMb', tr('每人每 24 小时默认上传额度'), 'MB', tr('可在「用户」里为某个人单独设置'))}
        {num('limits', 'maxFileMb', tr('单个附件最大'), 'MB', tr('最大 2048 MB'))}
      </div>
      <h3>{tr('附件保留')}</h3>
      <div className="form-grid">
        {num('limits', 'attachmentRetentionDays', tr('附件保留天数'), tr('天'), tr('超过这个天数的聊天附件会被自动删除（消息文字保留）；0 = 永久保留。收藏夹和贴纸不受影响'))}
      </div>
      <h3>{tr('两步验证')}</h3>
      <label className="check">
        <input
          type="checkbox"
          className="switch"
          checked={v.limits.require2fa === true}
          onChange={(e) => setV({ ...v, limits: { ...v.limits, require2fa: e.target.checked } })}
        />
        {tr('要求所有账号开启两步验证（没开的人登录后只能先完成设置；你自己需要先开启）')}
      </label>
      <h3>{tr('链接预览')}</h3>
      <label className="check">
        <input
          type="checkbox"
          className="switch"
          checked={v.limits.linkPreview !== false}
          onChange={(e) => setV({ ...v, limits: { ...v.limits, linkPreview: e.target.checked } })}
        />
        {tr('允许用户开启链接预览（由服务器代为抓取网页标题和图片；用户需在自己的设置里主动开启）')}
      </label>
      {a.error && <p className="error">{a.error}</p>}
      <div>
        <button className="btn" disabled={a.busy}>
          {tr('保存规则')}
        </button>
      </div>
    </form>
  );
}

type DayStat = { day: string; active: number; messages: number; uploaded: number };

function Bars({ data, pick, fmt }: { data: DayStat[]; pick: (d: DayStat) => number; fmt?: (n: number) => string }) {
  const max = Math.max(1, ...data.map(pick));
  return (
    <div className="bars" role="img">
      {data.map((d) => (
        <div key={d.day} className="bar" title={`${d.day}: ${fmt ? fmt(pick(d)) : pick(d)}`}>
          <span style={{ height: `${(pick(d) / max) * 100}%` }} />
        </div>
      ))}
    </div>
  );
}

function Stats() {
  const [s, setS] = useState<{ version: string; days: DayStat[]; totals: Record<string, number> } | null>(null);
  const [upd, setUpd] = useState<{ configured: boolean; current: string; latest?: string; newer?: boolean; notes?: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    api.get('/api/admin/stats').then(setS);
    api.get('/api/admin/update-check').then(setUpd).catch(() => undefined);
  }, []);
  if (!s) return <Spinner />;
  const T = s.totals;
  return (
    <div className="stack">
      <div className="stat-grid">
        <Stat icon={<UserRound size={18} />} label={tr('用户')} value={T.users} />
        <Stat icon={<UserRound size={18} />} label={tr('7 天活跃')} value={T.active7} />
        <Stat icon={<UserRound size={18} />} label={tr('30 天活跃')} value={T.active30} />
        <Stat icon={<MessagesSquare size={18} />} label={tr('消息（服务器上）')} value={T.messages} />
        <Stat icon={<MessagesSquare size={18} />} label={tr('聊天 / 群')} value={`${T.chats} / ${T.groups}`} />
        <Stat icon={<HardDrive size={18} />} label={tr('附件（密文）')} value={formatSize(T.storageBytes)} />
        <Stat icon={<KeyRound size={18} />} label={tr('开启两步验证')} value={`${T.twoFactor} / ${T.users}`} />
      </div>
      <h3>{tr('每日活跃用户（30 天）')}</h3>
      <Bars data={s.days} pick={(d) => d.active} />
      <h3>{tr('每日消息数')}</h3>
      <Bars data={s.days} pick={(d) => d.messages} />
      <h3>{tr('每日上传量')}</h3>
      <Bars data={s.days} pick={(d) => d.uploaded} fmt={formatSize} />
      <div className="bars-axis muted small">
        <span>{s.days[0].day}</span>
        <span>{s.days[s.days.length - 1].day}</span>
      </div>
      <p className="muted small">{tr('只统计数量：服务器看不到消息内容，也不记录谁和谁聊天。')}</p>
      <h3 className="inline-ic">
        <Sparkles size={16} /> {tr('版本')}
      </h3>
      <p>
        {tr('当前版本 v{v0}', { v0: s.version })}
        {upd?.configured === false && <span className="muted small"> · {tr('未配置更新源（可在 .env 设置 UPDATE_FEED_URL）')}</span>}
        {upd?.newer && (
          <b className="ok-text">
            {' '}
            · {tr('有新版本 v{v0} 可用', { v0: upd.latest })}
          </b>
        )}
        {upd?.configured && !upd.newer && !upd.error && <span className="muted small"> · {tr('已是最新')}</span>}
        {upd?.error && <span className="error small"> · {upd.error}</span>}
      </p>
      {upd?.newer && upd.notes && <pre className="update-notes">{upd.notes}</pre>}
      <p className="muted small">{tr('升级方法：上传更新包后执行 bash /www/wwwroot/securechat/ops/update.sh <更新包路径>')}</p>
    </div>
  );
}

const AUDIT_LABEL: Record<string, string> = {
  'POST allowlist': '添加 IP 白名单',
  'PATCH allowlist/:id': '修改白名单备注',
  'DELETE allowlist/:id': '删除 IP 白名单',
  'DELETE blocklist/:ipKey': '解除封禁',
  'POST gate-requests/:id/:action': '处理准入申请',
  'PUT gate-password': '修改访问密码',
  'POST lockdown': '紧急锁定',
  'POST users/:id/:action': '用户操作',
  'POST invites': '生成邀请',
  'PUT users/:id/quota': '修改用户额度',
  'PUT limits': '修改系统规则',
};

interface ClientError {
  sig: string;
  message: string;
  stack: string | null;
  path: string | null;
  version: string | null;
  browser: string | null;
  count: number;
  firstAt: number;
  lastAt: number;
}
function ClientErrors() {
  const [rows, setRows] = useState<ClientError[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api.get('/api/admin/client-errors').then((r) => setRows(r.errors));
  useEffect(() => {
    load();
  }, []);
  if (!rows) return <Spinner />;
  return (
    <div>
      <p className="muted small">
        {tr('用户浏览器里发生的意外错误（匿名：不记录账号和 IP，不含聊天内容）。相同的错误合并显示，最多保留 300 条。用户可以在设置里关闭上报。')}
      </p>
      {rows.length === 0 ? (
        <p className="muted">{tr('没有错误报告')}</p>
      ) : (
        <>
          <button
            className="btn ghost small"
            onClick={() =>
              api
                .post('/api/admin/client-errors/clear')
                .then(load)
                .catch((e) => toast(e.message))
            }
          >
            {tr('清空')}
          </button>
          <div className="audit-list">
            {rows.map((r) => (
              <div key={r.sig} className="audit-row err-row" onClick={() => setOpen(open === r.sig ? null : r.sig)}>
                <span className="muted small nowrap">{ago(r.lastAt)}</span>
                <b className="nowrap">× {r.count}</b>
                <span className="grow err-msg">{r.message}</span>
                <span className="muted small nowrap">
                  {r.version ?? '?'} · {r.browser ?? '?'} · {r.path ?? ''}
                </span>
                {open === r.sig && (
                  <div className="err-detail">
                    <div className="muted small">
                      {tr('首次 {v0} · 最近 {v1}', { v0: fullTime(r.firstAt), v1: fullTime(r.lastAt) })}
                    </div>
                    {r.stack && <pre className="small">{r.stack}</pre>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState<{ id: number; at: number; action: string; target: string | null; detail: string | null; username: string | null }[] | null>(null);
  useEffect(() => {
    api.get('/api/admin/audit').then((r) => setRows(r.entries));
  }, []);
  if (!rows) return <Spinner />;
  if (!rows.length) return <p className="muted">{tr('还没有管理操作记录')}</p>;
  return (
    <div className="audit-list">
      {rows.map((r) => (
        <div key={r.id} className="audit-row">
          <span className="muted small nowrap">{fullTime(r.at)}</span>
          <b>@{r.username ?? '?'}</b>
          <span>{AUDIT_LABEL[r.action] ? tr(AUDIT_LABEL[r.action]) : r.action}</span>
          {r.target && <code className="small">{r.target}</code>}
          {r.detail && <code className="small muted audit-detail">{r.detail}</code>}
        </div>
      ))}
    </div>
  );
}
