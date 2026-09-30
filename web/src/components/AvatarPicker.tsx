import { useRef, useState, type ReactNode } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import { toast } from '../lib/store';
import { Spinner } from './ui';
import { tr } from '../lib/i18n';

/** Click an avatar to pick a new (end-to-end encrypted) picture; optional "remove". */
export function AvatarPicker({ children, onPick, onRemove, has, label }: { children: ReactNode; onPick: (f: File) => Promise<unknown>; onRemove?: () => Promise<unknown>; has: boolean; label: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const run = (p: () => Promise<unknown>) => {
    setBusy(true);
    p()
      .catch((e: Error) => toast(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="avatar-picker">
      <button type="button" className="avatar-pick-btn" onClick={() => input.current?.click()} aria-label={label} title={label} disabled={busy}>
        {children}
        <span className="avatar-pick-overlay">{busy ? <Spinner /> : <Camera size={18} />}</span>
      </button>
      {has && onRemove && (
        <button type="button" className="link small inline-ic" disabled={busy} onClick={() => run(onRemove)}>
          <Trash2 size={13} /> {tr('移除头像')}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) run(() => onPick(f));
        }}
      />
    </div>
  );
}
