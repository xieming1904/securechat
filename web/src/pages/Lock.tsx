import { useEffect, useRef, useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { MAX_FAILS, verifyPin, waitRemaining } from '../lib/applock';
import { logout } from '../lib/store';
import { Spinner } from '../components/ui';
import { tr } from '../lib/i18n';

/** Shown before anything is decrypted when the app lock is on. */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [wait, setWait] = useState(waitRemaining());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setInterval(() => setWait(waitRemaining()), 500);
    return () => clearInterval(t);
  }, [wait]);

  const submit = async () => {
    if (!pin || busy || wait > 0) return;
    setBusy(true);
    const r = await verifyPin(pin);
    setBusy(false);
    setPin('');
    if (r.ok) return onUnlock();
    if (r.wipe) {
      await logout().catch(() => undefined);
      location.reload();
      return;
    }
    setWait(r.waitMs);
    setMsg(r.left <= 3 ? tr('PIN 错误。再错 {v0} 次，本机数据将被清除（需要用密码重新登录）', { v0: r.left }) : tr('PIN 错误'));
    setTimeout(() => input.current?.focus(), 0);
  };

  return (
    <div className="auth-shell">
      <div className="auth-card lock-card">
        <div className="hero-ic lock-ic-big">
          <LockKeyhole size={34} strokeWidth={1.8} />
        </div>
        <h1>{tr('密聊已锁定')}</h1>
        <p className="muted">{tr('输入本机 PIN 解锁')}</p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            ref={input}
            className="pin-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
            disabled={wait > 0}
          />
          {msg && <p className="error">{msg}</p>}
          {wait > 0 && <p className="muted small">{tr('请 {v0} 秒后再试', { v0: Math.ceil(wait / 1000) })}</p>}
          <button className="btn" disabled={busy || !pin || wait > 0}>
            {busy ? <Spinner /> : tr('解锁')}
          </button>
        </form>
        <button
          className="link small"
          onClick={() => {
            if (confirm(tr('忘记 PIN 只能退出登录：本机的密钥和缓存会被清除，之后需要用账号密码重新登录（聊天记录不会丢失）。继续？')))
              logout().finally(() => location.reload());
          }}
        >
          {tr('忘记 PIN？')}
        </button>
        <p className="muted small">{tr('连续输错 {v0} 次会自动清除本机数据', { v0: MAX_FAILS })}</p>
      </div>
    </div>
  );
}
