import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { login, logout, register, unlock, useStore, acceptGroupInvite, openChat, recoverWithPhrase, finishRecovery } from '../lib/store';
import { newRecoveryPhrase, normalizeRecoveryPhrase } from '../crypto/recovery';
import type { Identity } from '../crypto/core';
import { Spinner, useAsync } from '../components/ui';
import { tr } from '../lib/i18n';
import { LinkLogin } from '../components/DeviceLink';
import { QrCode } from 'lucide-react';

function Shell({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const [mode, setMode] = useState<'password' | 'recover' | 'link'>('password');
  if (mode === 'recover') return <RecoverPage onBack={() => setMode('password')} />;
  if (mode === 'link') return <LinkLogin onBack={() => setMode('password')} />;
  return <LoginForm onRecover={() => setMode('recover')} onLink={() => setMode('link')} />;
}

function LoginForm({ onRecover, onLink }: { onRecover: () => void; onLink: () => void }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const { busy, error, run } = useAsync();
  return (
    <Shell title={tr('登录')} sub={tr('消息在你的浏览器中端到端加密')}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => login(u.trim(), p));
        }}
      >
        <input placeholder={tr('用户名')} autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required autoFocus />
        <input placeholder={tr('密码')} type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required />
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy}>
          {busy ? <Spinner /> : tr('登录')}
        </button>
      </form>
      <button className="btn secondary inline-ic" onClick={onLink}>
        <QrCode size={16} /> {tr('用已登录的设备扫码登录')}
      </button>
      <button className="link small" onClick={onRecover}>
        {tr('忘记密码？用恢复词找回')}
      </button>
      <p className="muted small">{tr('没有账号？请向管理员或朋友索取邀请链接。')}</p>
    </Shell>
  );
}

export function UnlockPage() {
  const me = useStore((s) => s.me)!;
  const [p, setP] = useState('');
  const { busy, error, run } = useAsync();
  return (
    <Shell title={tr('解锁 @{v0}', { v0: me.username })} sub={tr('本设备上没有找到你的密钥，请输入密码从加密备份中恢复。')}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => unlock(p));
        }}
      >
        <input placeholder={tr('密码')} type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required autoFocus />
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy}>
          {busy ? <Spinner /> : tr('解锁')}
        </button>
        <button type="button" className="btn ghost" onClick={() => logout()}>
          {tr('换个账号')}
        </button>
      </form>
    </Shell>
  );
}

/** /i/<token> — registration invite (logged out) or group invite (logged in). */
export function InvitePage({ token }: { token: string }) {
  const phase = useStore((s) => s.phase);
  const [info, setInfo] = useState<{ kind: string; inviter: string | null; grantsAdmin: boolean } | null>(null);
  const [loadErr, setLoadErr] = useState('');
  useEffect(() => {
    api
      .get(`/api/invites/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e) => setLoadErr(e.message));
  }, [token]);

  if (loadErr)
    return (
      <Shell title={tr('邀请无效')} sub={loadErr}>
        <a className="btn" href="/">
          {tr('返回')}
        </a>
      </Shell>
    );
  if (!info || phase === 'loading')
    return (
      <Shell title={tr('正在读取邀请…')}>
        <Spinner />
      </Shell>
    );

  if (info.kind === 'group') {
    if (phase !== 'ready')
      return (
        <Shell title={tr('加入群聊')} sub={tr('请先登录，然后再次打开此邀请链接。')}>
          <LoginInline />
        </Shell>
      );
    return <JoinGroup token={token} inviter={info.inviter} />;
  }

  if (phase === 'ready')
    return (
      <Shell title={tr('你已经登录')} sub={tr('这是一个注册邀请，已登录的账号无需使用。')}>
        <a className="btn" href="/">
          {tr('进入聊天')}
        </a>
      </Shell>
    );
  return <RegisterForm token={token} inviter={info.inviter} admin={info.grantsAdmin} />;
}

function LoginInline() {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const { busy, error, run } = useAsync();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => login(u.trim(), p));
      }}
    >
      <input placeholder={tr('用户名')} value={u} onChange={(e) => setU(e.target.value)} required />
      <input placeholder={tr('密码')} type="password" value={p} onChange={(e) => setP(e.target.value)} required />
      {error && <p className="error">{error}</p>}
      <button className="btn" disabled={busy}>
        {busy ? <Spinner /> : tr('登录')}
      </button>
    </form>
  );
}

function JoinGroup({ token, inviter }: { token: string; inviter: string | null }) {
  const { busy, error, run } = useAsync();
  const [pending, setPending] = useState<null | { needsApproval?: boolean }>(null);
  const goHome = () => {
    history.replaceState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  if (pending)
    return (
      <Shell title={tr('已申请加入')} sub={pending.needsApproval ? tr('群管理员审批通过后，群聊会出现在你的聊天列表里。') : tr('群管理员的设备在线时会自动为你完成加密签名，群聊随后出现在你的聊天列表里。')}>
        <p className="muted small">{tr('加入后只能看到之后的新消息。')}</p>
        <button className="btn" onClick={goHome}>
          {tr('返回聊天列表')}
        </button>
      </Shell>
    );
  return (
    <Shell title={tr('加入群聊')} sub={inviter ? tr('{v0} 邀请你加入一个加密群聊', { v0: inviter }) : tr('你收到了一个加密群聊邀请')}>
      <p className="muted small">{tr('加入后只能看到之后的新消息，之前的聊天记录对你不可见。')}</p>
      {error && <p className="error">{error}</p>}
      <button
        className="btn"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const r = await acceptGroupInvite(token);
            if (r.alreadyMember) {
              goHome();
              await openChat(r.chatId);
            } else setPending(r);
          })
        }
      >
        {busy ? <Spinner /> : tr('申请加入')}
      </button>
    </Shell>
  );
}

function RegisterForm({ token, inviter, admin }: { token: string; inviter: string | null; admin: boolean }) {
  const [f, setF] = useState({ username: '', displayName: '', password: '', confirm: '' });
  const [step, setStep] = useState<'form' | 'words' | 'verify'>('form');
  const [phrase] = useState(() => newRecoveryPhrase());
  const [check] = useState(() => {
    const idx = new Set<number>();
    while (idx.size < 3) idx.add(Math.floor(Math.random() * 24));
    return [...idx].sort((a, b) => a - b);
  });
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [saved, setSaved] = useState(false);
  const { busy, error, setError, run } = useAsync();
  const up = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const words = phrase.split(' ');
  const title = admin ? tr('创建管理员账号') : tr('注册');

  if (step === 'words')
    return (
      <Shell title={tr('你的恢复词')} sub={tr('忘记密码时，只有这 24 个词能找回你的账号和聊天记录。')}>
        <ol className="words">
          {words.map((w, i) => (
            <li key={i}>
              <span>{i + 1}</span>
              {w}
            </li>
          ))}
        </ol>
        <p className="warn small">
          {tr('请')}<b>{tr('手抄在纸上')}</b>{tr('并妥善保管，不要截图或存在网盘。它只显示这一次，服务器不会保存明文。任何拿到恢复词的人都能在知道你用户名的情况下重置你的密码。')}
        </p>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          {tr('我已经抄写好了')}
        </label>
        <button className="btn" disabled={!saved} onClick={() => setStep('verify')}>
          {tr('下一步')}
        </button>
      </Shell>
    );

  if (step === 'verify')
    return (
      <Shell title={tr('核对恢复词')} sub={tr('请填写下面几个位置的词，确认你抄对了。')}>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (check.some((n, i) => answers[i].trim().toLowerCase() !== words[n])) return setError(tr('有词不对，请对照你抄写的内容重新检查'));
            run(async () => {
              await register(token, f.username, f.displayName.trim() || f.username, f.password, phrase);
              history.replaceState(null, '', '/');
              window.dispatchEvent(new PopStateEvent('popstate'));
            });
          }}
        >
          {check.map((n, i) => (
            <input
              key={n}
              placeholder={tr('第 {v0} 个词', { v0: n + 1 })}
              value={answers[i]}
              autoCapitalize="none"
              autoComplete="off"
              onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
              required
            />
          ))}
          {error && <p className="error">{error}</p>}
          <button className="btn" disabled={busy}>
            {busy ? (
              <>
                <Spinner /> {tr('正在生成密钥…')}
              </>
            ) : (
              tr('创建账号')
            )}
          </button>
          <button type="button" className="btn ghost" onClick={() => setStep('words')}>
            {tr('返回查看恢复词')}
          </button>
        </form>
      </Shell>
    );

  return (
    <Shell title={title} sub={inviter ? tr('{v0} 邀请你加入', { v0: inviter }) : tr('你收到了注册邀请')}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!/^[A-Za-z0-9_]{3,32}$/.test(f.username)) return setError(tr('用户名只能包含字母、数字、下划线，3–32 位'));
          if (f.password.length < 10) return setError(tr('密码至少 10 位'));
          if (f.password !== f.confirm) return setError(tr('两次输入的密码不一致'));
          setError('');
          setStep('words');
        }}
      >
        <input placeholder={tr('用户名（登录用，字母数字下划线）')} value={f.username} onChange={up('username')} autoComplete="username" required autoFocus />
        <input placeholder={tr('昵称（显示给别人）')} value={f.displayName} onChange={up('displayName')} maxLength={64} />
        <input placeholder={tr('密码（至少 10 位）')} type="password" value={f.password} onChange={up('password')} autoComplete="new-password" required />
        <input placeholder={tr('确认密码')} type="password" value={f.confirm} onChange={up('confirm')} autoComplete="new-password" required />
        <p className="muted small">{tr('密码不会以任何形式发送给服务器（OPAQUE 协议）。下一步会生成 24 个恢复词，忘记密码时用它找回账号。')}</p>
        {error && <p className="error">{error}</p>}
        <button className="btn">{tr('下一步')}</button>
      </form>
    </Shell>
  );
}

export function RecoverPage({ onBack }: { onBack: () => void }) {
  const [username, setUsername] = useState('');
  const [words, setWords] = useState('');
  const [found, setFound] = useState<null | { recoveryToken: string; identity: Identity }>(null);
  const [pw, setPw] = useState({ next: '', confirm: '' });
  const { busy, error, setError, run } = useAsync();
  if (found)
    return (
      <Shell title={tr('设置新密码')} sub={tr('恢复词验证通过。设置新密码后，所有旧设备都会被强制下线。')}>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (pw.next.length < 10) return setError(tr('密码至少 10 位'));
            if (pw.next !== pw.confirm) return setError(tr('两次输入的密码不一致'));
            run(() => finishRecovery(found.recoveryToken, found.identity, pw.next));
          }}
        >
          <input type="password" placeholder={tr('新密码（至少 10 位）')} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" required autoFocus />
          <input type="password" placeholder={tr('确认新密码')} value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" required />
          {error && <p className="error">{error}</p>}
          <button className="btn" disabled={busy}>
            {busy ? <Spinner /> : tr('保存并登录')}
          </button>
        </form>
      </Shell>
    );
  return (
    <Shell title={tr('用恢复词找回账号')} sub={tr('输入注册时抄下的 24 个恢复词（用空格分隔）。')}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const p = normalizeRecoveryPhrase(words);
          if (!p) return setError(tr('恢复词应为 24 个英文单词，且校验位正确。请检查拼写。'));
          run(async () => setFound(await recoverWithPhrase(username.trim(), p)));
        }}
      >
        <input placeholder={tr('用户名')} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        <textarea className="words-input" rows={5} placeholder="word1 word2 … word24" value={words} onChange={(e) => setWords(e.target.value)} autoCapitalize="none" autoComplete="off" spellCheck={false} required />
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy}>
          {busy ? <Spinner /> : tr('验证恢复词')}
        </button>
        <button type="button" className="btn ghost" onClick={onBack}>
          {tr('返回登录')}
        </button>
      </form>
    </Shell>
  );
}
