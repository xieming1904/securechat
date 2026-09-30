import { useEffect, useRef, useState } from 'react';
import { DatabaseBackup, Download, Upload, UserX, Fingerprint } from 'lucide-react';
import { api } from '../lib/api';
import { deleteAccount, toast, useStore } from '../lib/store';
import { exportPersonal, importPersonal, openPersonal, MAX_BACKUP_FILE, type PersonalBackup } from '../lib/backup';
import { passkeyProof, passkeysSupported } from '../lib/passkey';
import { Modal, useAsync } from './ui';
import { tr } from '../lib/i18n';

/** Settings → Security: personal data backup / restore, and deleting the account. */
export function AccountData() {
  const [dlg, setDlg] = useState<null | 'export' | 'import' | 'delete'>(null);
  return (
    <div className="stack">
      <h4 className="inline-ic">
        <DatabaseBackup size={16} /> {tr('个人数据备份')}
      </h4>
      <p className="muted small">
        {tr('把备注名、收藏、贴纸、聊天分组、设置和屏蔽名单导出成一个用口令加密的文件，换账号或以后需要时再导入。聊天消息不在里面（它们保存在服务器上；单个聊天可以在聊天信息里导出）。')}
      </p>
      <div className="row gap wrap">
        <button className="btn small secondary" onClick={() => setDlg('export')}>
          <Download size={15} /> {tr('导出个人数据')}
        </button>
        <button className="btn small secondary" onClick={() => setDlg('import')}>
          <Upload size={15} /> {tr('导入个人数据')}
        </button>
      </div>
      <hr />
      <h4 className="inline-ic danger-text">
        <UserX size={16} /> {tr('注销账号')}
      </h4>
      <p className="muted small">{tr('永久删除你的账号。别人手里的聊天记录会保留，你的名字会显示为「已注销账号」。')}</p>
      <div>
        <button className="btn small danger ghost" onClick={() => setDlg('delete')}>
          {tr('注销账号…')}
        </button>
      </div>
      {dlg === 'export' && <ExportDialog onClose={() => setDlg(null)} />}
      {dlg === 'import' && <ImportDialog onClose={() => setDlg(null)} />}
      {dlg === 'delete' && <DeleteDialog onClose={() => setDlg(null)} onExport={() => setDlg('export')} />}
    </div>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [status, setStatus] = useState('');
  const a = useAsync();
  return (
    <Modal title={tr('导出个人数据')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          a.run(async () => {
            const r = await exportPersonal(pw, setStatus);
            setStatus('');
            toast(
              tr('已导出：{v0} 个备注、{v1} 条收藏、{v2} 个贴纸', { v0: r.contacts, v1: r.saved, v2: r.stickers }) +
                (r.skipped ? tr('（{v0} 个过大或已失效的附件没有包含）', { v0: r.skipped }) : ''),
            );
            onClose();
          });
        }}
      >
        <p className="muted small">{tr('设置一个口令来加密这个文件（至少 8 位）。导入时需要它，忘了就打不开。')}</p>
        <input type="password" placeholder={tr('口令')} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus />
        <input type="password" placeholder={tr('再输入一次')} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
        {status && <p className="muted small">{status}</p>}
        {a.error && <p className="error">{a.error}</p>}
        <button className="btn" disabled={pw.length < 8 || pw !== pw2 || a.busy}>
          {tr('导出')}
        </button>
      </form>
    </Modal>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [pw, setPw] = useState('');
  const [data, setData] = useState<PersonalBackup | null>(null);
  const [status, setStatus] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const a = useAsync();
  const me = useStore((s) => s.me)!;
  return (
    <Modal title={tr('导入个人数据')} onClose={onClose}>
      {!data ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            a.run(async () => setData(openPersonal(bytes!, pw)));
          }}
        >
          <p className="muted small">{tr('选择之前导出的 .scbackup 文件，输入当时设置的口令。导入只会添加，不会删除或覆盖你现有的内容。')}</p>
          <input
            ref={file}
            type="file"
            accept=".scbackup"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f && f.size > MAX_BACKUP_FILE) return toast(tr('文件太大，不是有效的个人数据备份'));
              setBytes(new Uint8Array((await f?.arrayBuffer()) ?? new ArrayBuffer(0)));
            }}
          />
          <input type="password" placeholder={tr('口令')} value={pw} onChange={(e) => setPw(e.target.value)} />
          {a.error && <p className="error">{a.error}</p>}
          <button className="btn" disabled={!bytes?.length || !pw || a.busy}>
            {tr('打开')}
          </button>
        </form>
      ) : (
        <div className="stack">
          <p>
            {tr('来自 @{v0}，导出于 {v1}', { v0: data.username, v1: new Date(data.exportedAt).toLocaleString() })}
            {data.username.toLowerCase() !== me.username.toLowerCase() && <span className="muted small block">{tr('（和当前账号不同，这没关系）')}</span>}
          </p>
          <ul className="muted small">
            <li>{tr('{v0} 个联系人备注', { v0: Object.keys(data.contacts ?? {}).length })}</li>
            <li>{tr('{v0} 条收藏', { v0: data.saved?.length ?? 0 })}</li>
            <li>{tr('{v0} 个贴纸', { v0: data.stickers?.length ?? 0 })}</li>
            <li>{tr('{v0} 个聊天分组，{v1} 个屏蔽', { v0: data.chatlist?.folders?.length ?? 0, v1: data.blocked?.length ?? 0 })}</li>
          </ul>
          {status && <p className="muted small">{status}</p>}
          {a.error && <p className="error">{a.error}</p>}
          <button
            className="btn"
            disabled={a.busy}
            onClick={() =>
              a.run(async () => {
                const r = await importPersonal(data, setStatus);
                toast(tr('已导入：{v0} 个备注、{v1} 条收藏、{v2} 个贴纸', { v0: r.contacts, v1: r.saved, v2: r.stickers }));
                onClose();
              })
            }
          >
            {tr('导入')}
          </button>
        </div>
      )}
    </Modal>
  );
}

function DeleteDialog({ onClose, onExport }: { onClose: () => void; onExport: () => void }) {
  const me = useStore((s) => s.me)!;
  const [methods, setMethods] = useState<string[]>([]);
  const [confirm, setConfirm] = useState('');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [sure, setSure] = useState(false);
  const a = useAsync();
  useEffect(() => {
    api.get('/api/me/2fa').then((r) => setMethods(r.methods ?? [])).catch(() => undefined);
  }, []);
  const needsProof = methods.length > 0;
  const canPasskey = methods.includes('passkey') && passkeysSupported();
  const go = (usePasskey: boolean) =>
    a.run(async () => {
      const proof = !needsProof ? undefined : usePasskey ? await passkeyProof() : { code: code.trim() };
      await deleteAccount({ password: pw, confirm: confirm.trim(), proof });
      location.reload();
    });
  const ready = sure && confirm.trim().toLowerCase() === me.username.toLowerCase() && pw.length > 0;
  return (
    <Modal title={tr('注销账号')} onClose={onClose}>
      <div className="stack">
        <p className="warn-text">{tr('注销后无法恢复，也不能用同一个用户名重新注册。')}</p>
        <ul className="small">
          <li>{tr('会删除：登录密码和恢复词、所有设备上的登录、两步验证、收藏、贴纸、备注、设置和头像。')}</li>
          <li>{tr('你会自动退出所有群组。')}</li>
          <li>{tr('会保留：你已经发出的消息，别人仍然看得到，发送者显示为「已注销账号」。')}</li>
        </ul>
        <button className="link small" onClick={onExport}>
          {tr('先导出个人数据')}
        </button>
        <label className="field">
          {tr('输入你的用户名 {v0} 以确认', { v0: '@' + me.username })}
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          {tr('登录密码')}
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
        </label>
        {needsProof && (
          <label className="field">
            {canPasskey ? tr('两步验证：验证码 / 恢复码，或下面用通行密钥') : tr('两步验证：验证码或恢复码')}
            <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> {tr('我明白注销后无法恢复')}
        </label>
        {a.error && <p className="error">{a.error}</p>}
        <div className="row gap wrap">
          <button className="btn danger" disabled={!ready || (needsProof && !code.trim()) || a.busy} onClick={() => go(false)}>
            {tr('永久注销')}
          </button>
          {canPasskey && (
            <button className="btn danger ghost" disabled={!ready || a.busy} onClick={() => go(true)}>
              <Fingerprint size={16} /> {tr('用通行密钥确认并注销')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
