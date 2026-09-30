import { useEffect, useState } from 'react';
import { QrCode, ScanLine, TriangleAlert } from 'lucide-react';
import { approveLink, inspectLink, startLinkLogin, toast } from '../lib/store';
import { describeUA } from '../lib/format';
import { QrScanner } from './QrScanner';
import { Modal, QR, Spinner } from './ui';
import { tr } from '../lib/i18n';
import * as C from '../crypto/core';

/** New device: show a QR code that a logged-in device scans. */
export function LinkLogin({ onBack }: { onBack: () => void }) {
  const [qr, setQr] = useState<{ text: string; exp: number } | null>(null);
  const [err, setErr] = useState('');
  const [round, setRound] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const signal = { cancelled: false };
    setQr(null);
    setErr('');
    startLinkLogin((text, exp) => setQr({ text, exp }), signal)
      .then((ok) => !ok && !signal.cancelled && setRound((r) => r + 1)) // expired: new code
      .catch((e) => setErr((e as Error).message));
    return () => {
      signal.cancelled = true;
    };
  }, [round]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>{tr('扫码登录')}</h1>
        <ol className="muted small link-steps">
          <li>{tr('在已登录的手机或电脑上打开密聊')}</li>
          <li>{tr('设置 → 设备管理 → 扫码登录新设备')}</li>
          <li>{tr('扫描下面的二维码，并在那台设备上输入确认码')}</li>
        </ol>
        {err ? <p className="error">{err}</p> : qr ? <QR text={qr.text} size={220} /> : <Spinner />}
        {qr && (
          <p>
            {tr('确认码')} <b className="link-code">{C.linkCode(qr.text.split(':')[2])}</b>
          </p>
        )}
        {qr && <p className="muted small">{tr('二维码 {v0} 秒后自动刷新', { v0: Math.max(0, Math.ceil((qr.exp - now) / 1000)) })}</p>}
        <p className="muted small">{tr('你的密钥会从已登录的设备端到端加密后直接传过来，服务器看不到。')}</p>
        <button className="link small" onClick={onBack}>
          {tr('返回用密码登录')}
        </button>
      </div>
    </div>
  );
}

/** Logged-in device: scan a new device's QR and approve it. */
export function ApproveLinkButton() {
  const [scan, setScan] = useState(false);
  const [pending, setPending] = useState<Awaited<ReturnType<typeof inspectLink>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  return (
    <>
      <button className="btn secondary inline-ic" onClick={() => (setCode(''), setScan(true))}>
        <ScanLine size={16} /> {tr('扫码登录新设备')}
      </button>
      {scan && (
        <QrScanner
          title={tr('扫描新设备上的二维码')}
          hint={tr('在新设备的登录页点「扫码登录」，把出现的二维码对准摄像头。')}
          onClose={() => setScan(false)}
          onResult={(text) => {
            setScan(false);
            inspectLink(text)
              .then(setPending)
              .catch((e) => toast(e.message));
          }}
        />
      )}
      {pending && (
        <Modal title={tr('确认登录新设备？')} onClose={() => setPending(null)}>
          <div className="stack">
            <p className="inline-ic">
              <QrCode size={16} /> <b>{describeUA(pending.userAgent)}</b> · IP {pending.ip}
            </p>
            <p className="warn-text inline-ic">
              <TriangleAlert size={15} /> {tr('只确认你自己眼前的设备。如果有人发给你二维码让你扫，那是骗局——对方会完全登录你的账号。')}
            </p>
            <label className="field">
              {tr('输入新设备屏幕上显示的 6 位确认码')}
              <input className="pin-input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            </label>
            {code.length === 6 && code !== C.linkCode(pending.pk) && <p className="error small">{tr('确认码不对。请确认你扫的是自己眼前那台设备的二维码。')}</p>}
            <div className="row end gap">
              <button className="btn ghost" onClick={() => setPending(null)}>
                {tr('取消')}
              </button>
              <button
                className="btn"
                disabled={busy || code !== C.linkCode(pending.pk)}
                onClick={() => {
                  setBusy(true);
                  approveLink(pending.linkId, pending.pk)
                    .then(() => (toast(tr('新设备已登录')), setPending(null)))
                    .catch((e) => toast(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                {tr('确认登录')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
