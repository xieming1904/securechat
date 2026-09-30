import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X, Users, Lock as LockIcon, Check, Copy } from 'lucide-react';
import { colorFor, initials } from '../lib/format';
import { tr } from '../lib/i18n';
import { useAvatars } from '../lib/avatarStore';

/**
 * Round avatar: the (end-to-end encrypted, decrypted locally) picture if there is one, else initials / group icon.
 * `user`: whose picture; `chat`: a chat's picture (the peer's for a direct chat, the group's for a group).
 */
export function Avatar({
  id,
  name,
  size = 44,
  online,
  group,
  user,
  chat,
}: {
  id: string;
  name: string;
  size?: number;
  online?: boolean;
  group?: boolean;
  user?: string;
  chat?: { id: string; type: string; members: { id: string }[] };
}) {
  const meId = useAvatars((s) => s.meId);
  const uid = user ?? (chat?.type === 'direct' ? chat.members.find((m) => m.id !== meId)?.id : undefined);
  const pic = useAvatars((s) => (uid ? s.users[uid]?.url : undefined) ?? (chat?.type === 'group' ? s.groups[chat.id]?.url : undefined));
  return (
    <div className={`avatar ${pic ? 'has-pic' : ''}`} style={{ width: size, height: size, background: pic ? undefined : colorFor(id), fontSize: size * 0.4 }} aria-hidden>
      {pic ? <img src={pic} alt="" className="avatar-img" draggable={false} /> : group ? <Users size={size * 0.46} strokeWidth={2.2} /> : initials(name)}
      {online && <span className="online-dot" />}
    </div>
  );
}


export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={tr('关闭')}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function QR({ text, size = 200 }: { text: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    // loaded on demand: only invite dialogs show QR codes
    import('qrcode').then(({ default: QRCode }) => ref.current && QRCode.toCanvas(ref.current, text, { width: size, margin: 1 })).catch(() => undefined);
  }, [text, size]);
  return <canvas ref={ref} className="qr" width={size} height={size} />;
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-field">
      {label && <span className="muted small">{label}</span>}
      <div className="row">
        <input readOnly value={value} onFocus={(e) => e.target.select()} />
        <button
          className="btn secondary"
          onClick={async () => {
            await navigator.clipboard?.writeText(value).catch(() => undefined);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }}
        >
          {done ? <Check size={16} /> : <Copy size={16} />}
          {done ? tr('已复制') : tr('复制')}
        </button>
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label={tr('加载中')} />;
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

export const Lock = ({ size = 13 }: { size?: number }) => <LockIcon size={size} strokeWidth={2.4} aria-hidden className="lock-ic" />;
