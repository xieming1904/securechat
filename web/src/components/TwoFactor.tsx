import { useEffect, useState } from 'react';
import { ShieldCheck, Smartphone, LogOut, KeyRound, Fingerprint, Trash2, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { logout, reauthWithPassword, setSecondFactorPrompt, toast, type SecondFactorAnswer } from '../lib/store';
import { ApiError } from '../lib/api';
import { createPasskey, defaultPasskeyName, passkeyProof, passkeysSupported } from '../lib/passkey';
import { fullTime } from '../lib/format';
import { CopyField, Modal, QR, Spinner, useAsync } from './ui';
import { tr } from '../lib/i18n';

/** Registers the second-step dialog used during login / recovery (code, recovery code or passkey). Mount once. */
export function SecondFactorPromptHost() {
  const [req, setReq] = useState<{ retry: boolean; methods: string[]; resolve: (v: SecondFactorAnswer) => void } | null>(null);
  const [code, setCode] = useState('');
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    setSecondFactorPrompt((retry, methods) => new Promise((resolve) => (setCode(''), setTyping(false), setReq({ retry, methods, resolve }))));
  }, []);
  if (!req) return null;
  const done = (v: SecondFactorAnswer) => {
    req.resolve(v);
    setReq(null);
  };
  const hasPasskey = req.methods.includes('passkey') && passkeysSupported();
  const hasTotp = req.methods.includes('totp');
  const showCode = hasTotp || typing || !hasPasskey;
  return (
    <Modal title={tr('两步验证')} onClose={() => done(null)}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) done(code.trim());
        }}
      >
        {hasPasskey && (
          <>
            <p className="muted">{tr('用这台设备（或手机 / 安全密钥）上的通行密钥确认是你本人。')}</p>
            <button type="button" className="btn" onClick={() => done({ passkey: true })} autoFocus>
              <Fingerprint size={18} /> {tr('使用通行密钥')}
            </button>
          </>
        )}
        {showCode ? (
          <>
            <p className="muted">
              {hasTotp
                ? tr('打开手机上的验证器 App，输入「密聊」显示的 6 位数字。手机丢了可以输入一个备用恢复码。')
                : tr('输入一个备用恢复码。')}
            </p>
            <input
              className="pin-input"
              inputMode={hasTotp ? 'numeric' : 'text'}
              autoComplete="one-time-code"
              placeholder={hasTotp ? '123456' : 'abcde-fghij'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus={!hasPasskey}
              maxLength={20}
            />
            {req.retry && <p className="error">{tr('验证码不正确，请重试')}</p>}
            <button className={`btn ${hasPasskey ? 'secondary' : ''}`} disabled={!code.trim()}>
              {tr('验证')}
            </button>
          </>
        ) : (
          <button type="button" className="link small" onClick={() => setTyping(true)}>
            {tr('通行密钥不在身边？使用备用恢复码')}
          </button>
        )}
      </form>
    </Modal>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="stack">
      <p className="warn-text">{tr('请把这 10 个备用恢复码抄下来或存到密码管理器里。手机丢失时，每个恢复码可以代替验证码使用一次。它们只显示这一次。')}</p>
      <div className="recovery-codes">
        {codes.map((c) => (
          <code key={c}>{c}</code>
        ))}
      </div>
      <CopyField value={codes.join('\n')} />
    </div>
  );
}

interface State2fa {
  enabled: boolean;
  methods: string[];
  passkeys: number;
  required: boolean;
  recoveryLeft: number;
}
interface PasskeyRow {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Settings → Security: passkeys, authenticator app, recovery codes. */
export function TwoFactorSettings({ onEnabled }: { onEnabled?: () => void }) {
  const [st, setSt] = useState<State2fa | null>(null);
  const [keys, setKeys] = useState<PasskeyRow[]>([]);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [newName, setNewName] = useState(defaultPasskeyName());
  const [pwNeeded, setPwNeeded] = useState<null | (() => Promise<void>)>(null);
  const [pw, setPw] = useState('');
  const a = useAsync();
  /** The first method needs the password once more (the server says so): ask, then retry the action. */
  // passkey prompts need a fresh click (browsers require a user gesture), so those aren't retried automatically
  const withReauth = (fn: () => Promise<void>, autoRetry = true) =>
    a.run(async () => {
      try {
        await fn();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'reauth_required')
          setPwNeeded(() => (autoRetry ? fn : async () => toast(tr('密码已确认，请再点一次「添加通行密钥」'))));
        else throw e;
      }
    });
  const load = async () => {
    const [s, k] = await Promise.all([api.get('/api/me/2fa'), api.get('/api/me/passkeys')]);
    setSt(s);
    setKeys(k.passkeys);
  };
  useEffect(() => {
    load();
  }, []);
  if (!st) return <Spinner />;
  const any = st.methods.length > 0;
  const hasPasskey = st.methods.includes('passkey');

  /** Proof for sensitive changes: a passkey if I have one, else the code typed in the field. */
  const proof = async (): Promise<Record<string, unknown>> => {
    if (hasPasskey && !code.trim()) return passkeyProof();
    if (!code.trim()) throw new Error(tr('请先在上面输入验证码或备用恢复码'));
    return { code: code.trim() };
  };
  const finished = (rc?: string[]) => {
    setCode('');
    if (rc?.length) setCodes(rc);
    else if (!any) onEnabled?.();
  };

  if (codes)
    return (
      <div className="stack">
        <h4 className="inline-ic">
          <ShieldCheck size={16} /> {tr('两步验证已开启')}
        </h4>
        <RecoveryCodes codes={codes} />
        <button className="btn" onClick={() => (setCodes(null), onEnabled?.())}>
          {tr('我已保存好')}
        </button>
      </div>
    );

  const addPasskey = () =>
    withReauth(async () => {
      const pr = any ? await proof() : undefined;
      const opts = await api.post('/api/me/passkeys/options');
      const response = await createPasskey(opts);
      const r = await api.post('/api/me/passkeys', { name: newName.trim() || defaultPasskeyName(), response, proof: pr });
      toast(tr('通行密钥已添加'));
      await load();
      finished(r.recoveryCodes);
    }, false);

  if (pwNeeded)
    return (
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          a.run(async () => {
            await reauthWithPassword(pw);
            setPw('');
            const fn = pwNeeded;
            setPwNeeded(null);
            await fn();
          });
        }}
      >
        <h4 className="inline-ic">
          <KeyRound size={16} /> {tr('请输入登录密码确认是你本人')}
        </h4>
        <p className="muted small">{tr('开启第一种两步验证前需要再确认一次密码，防止别人用你没退出的设备替你开启、把你锁在外面。')}</p>
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder={tr('登录密码')} autoComplete="current-password" />
        <div className="row gap">
          <button className="btn" disabled={!pw || a.busy}>
            {tr('确认')}
          </button>
          <button type="button" className="btn secondary" onClick={() => (setPwNeeded(null), setPw(''))}>
            {tr('取消')}
          </button>
        </div>
        {a.error && <p className="error">{a.error}</p>}
      </form>
    );

  return (
    <div className="stack">
      <h4 className={`inline-ic ${any ? 'ok-text' : ''}`}>
        <ShieldCheck size={16} /> {any ? tr('两步验证已开启') : tr('两步验证')}
      </h4>
      <p className="muted small">
        {any
          ? tr('登录新设备或用恢复词找回账号时，除了密码还需要通行密钥或验证器 App 的 6 位数字。剩余备用恢复码：{v0} 个。', { v0: st.recoveryLeft })
          : tr('开启后，登录新设备除了密码，还要用通行密钥（指纹、面容、电脑 PIN 或安全密钥）或手机验证器 App 的 6 位动态码确认。不需要手机号，也不经过任何第三方。')}
      </p>
      {any && (
        <input
          placeholder={hasPasskey ? tr('验证码 / 恢复码（有通行密钥时可不填）') : tr('当前验证码或备用恢复码')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={20}
          aria-label={tr('当前验证码或备用恢复码')}
        />
      )}

      {/* ---- passkeys ---- */}
      <div className="tf-section">
        <b className="inline-ic">
          <Fingerprint size={16} /> {tr('通行密钥')}
        </b>
        {keys.map((k) => (
          <div key={k.id} className="pk-row">
            <KeyRound size={16} className="muted" />
            <span className="grow">
              {k.name}
              <span className="muted small block">
                {tr('添加于 {v0}', { v0: fullTime(k.createdAt) })}
                {k.lastUsedAt ? ' · ' + tr('上次使用 {v0}', { v0: fullTime(k.lastUsedAt) }) : ''}
              </span>
            </span>
            <button
              className="icon-btn danger"
              aria-label={tr('删除')}
              disabled={a.busy}
              onClick={() =>
                a.run(async () => {
                  const pr = await proof();
                  await api.post(`/api/me/passkeys/${encodeURIComponent(k.id)}/delete`, pr);
                  setCode('');
                  toast(tr('已删除通行密钥'));
                  await load();
                })
              }
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        {passkeysSupported() ? (
          <div className="row gap">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40} aria-label={tr('通行密钥名称')} />
            <button className="btn small" disabled={a.busy} onClick={addPasskey}>
              <Plus size={15} /> {tr('添加通行密钥')}
            </button>
          </div>
        ) : (
          <p className="muted small">{tr('这个浏览器不支持通行密钥。')}</p>
        )}
      </div>

      {/* ---- authenticator app ---- */}
      <div className="tf-section">
        <b className="inline-ic">
          <Smartphone size={16} /> {tr('验证器 App')}
        </b>
        {st.enabled ? (
          <div className="row gap wrap">
            <span className="badge ok">{tr('已开启')}</span>
            {(!st.required || hasPasskey) && (
              <button
                className="btn small danger"
                disabled={a.busy}
                onClick={() =>
                  a.run(async () => {
                    await api.post('/api/me/2fa/disable', await proof());
                    setCode('');
                    toast(tr('已关闭验证器 App'));
                    await load();
                  })
                }
              >
                {tr('关闭')}
              </button>
            )}
          </div>
        ) : !setup ? (
          <div>
            <button className="btn small secondary" disabled={a.busy} onClick={() => a.run(async () => setSetup(await api.post('/api/me/2fa/setup')))}>
              {tr('设置验证器 App')}
            </button>
          </div>
        ) : (
          <TotpSetup
            setup={setup}
            busy={a.busy}
            onConfirm={(c) =>
              withReauth(async () => {
                const pr = hasPasskey ? await passkeyProof() : undefined;
                const r = await api.post('/api/me/2fa/enable', { code: c, proof: pr });
                setSetup(null);
                await load();
                finished(r.recoveryCodes);
              })
            }
          />
        )}
      </div>

      {any && (
        <div>
          <button
            className="btn small secondary"
            disabled={a.busy}
            onClick={() =>
              a.run(async () => {
                const r = await api.post('/api/me/2fa/recovery-codes', await proof());
                setCode('');
                setCodes(r.recoveryCodes);
              })
            }
          >
            {tr('重新生成恢复码')}
          </button>
        </div>
      )}
      {a.error && <p className="error">{a.error}</p>}
    </div>
  );
}

function TotpSetup({ setup, busy, onConfirm }: { setup: { secret: string; uri: string }; busy: boolean; onConfirm: (code: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm(code);
      }}
    >
      <p>{tr('1. 用验证器 App 扫描二维码（或手动输入下面的密钥）：')}</p>
      <div className="center">
        <QR text={setup.uri} size={180} />
      </div>
      <CopyField value={setup.secret} />
      <p>{tr('2. 输入 App 显示的 6 位数字：')}</p>
      <input className="pin-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} placeholder="123456" />
      <button className="btn" disabled={code.length !== 6 || busy}>
        {tr('确认开启')}
      </button>
    </form>
  );
}

/** Full-screen gate when the admin requires 2FA and this account hasn't set it up. */
export function Need2faPage() {
  return (
    <div className="auth-shell">
      <div className="auth-card wide-card">
        <h1>{tr('请先开启两步验证')}</h1>
        <p className="muted">{tr('管理员要求所有账号开启两步验证。完成设置后即可继续使用。')}</p>
        <TwoFactorSettings onEnabled={() => location.reload()} />
        <button className="link small inline-ic" onClick={() => logout().finally(() => location.reload())}>
          <LogOut size={14} /> {tr('退出登录')}
        </button>
      </div>
    </div>
  );
}
