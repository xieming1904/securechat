import { useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { dismissLoginAlert, revokeSession, toast, useStore } from '../lib/store';
import { describeUA, fullTime } from '../lib/format';
import { tr } from '../lib/i18n';

/** Pops up when the account logs in somewhere else while this device is connected. */
export function LoginAlerts() {
  const alerts = useStore((s) => s.loginAlerts);
  const [busy, setBusy] = useState<string | null>(null);
  if (!alerts.length) return null;
  return (
    <div className="login-alerts" role="alert">
      {alerts.map((a) => (
        <div key={a.sessionId} className="login-alert">
          <span className="la-ic">
            <MonitorSmartphone size={20} />
          </span>
          <div className="grow">
            <b>{tr('你的账号在新设备上登录了')}</b>
            <div className="muted small">
              {a.deviceName ? `${a.deviceName} · ` : ''}
              {describeUA(a.userAgent)} · IP {a.ip} · {fullTime(a.at)}
            </div>
            <div className="row gap la-actions">
              <button className="btn small secondary" onClick={() => dismissLoginAlert(a.sessionId)}>
                {tr('是我')}
              </button>
              <button
                className="btn small danger"
                disabled={busy === a.sessionId}
                onClick={async () => {
                  setBusy(a.sessionId);
                  try {
                    await revokeSession(a.sessionId);
                    toast(tr('已让该设备下线。建议马上在「设置 → 安全」里修改密码。'));
                  } catch (e) {
                    toast((e as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {tr('不是我，让它下线')}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
