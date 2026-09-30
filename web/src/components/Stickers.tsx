import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { FilePayload } from '../crypto/core';
import { fileUrl } from '../lib/files';
import { addStickerFromFile, removeSticker, type Sticker } from '../lib/social';
import { toast } from '../lib/store';
import { Spinner } from './ui';
import { tr } from '../lib/i18n';

function StickerImg({ p }: { p: FilePayload }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fileUrl(p)
      .then((u) => live && setUrl(u))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [p.blobId]); // eslint-disable-line react-hooks/exhaustive-deps
  return url ? <img src={url} alt="" draggable={false} /> : <Spinner />;
}

/** My personal (encrypted) sticker pack, above the composer. */
export function StickerPicker({ stickers, onPick, onClose }: { stickers: Sticker[]; onPick: (p: FilePayload) => void; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sticker-picker" role="dialog" aria-label={tr('贴纸')}>
      <div className="sticker-head">
        <b>{tr('我的贴纸')}</b>
        <span className="muted small">{tr('端到端加密，只有你能看到这个贴纸库')}</span>
        <span className="grow" />
        {stickers.length > 0 && (
          <button className="link small" onClick={() => setEditing(!editing)}>
            {editing ? tr('完成') : tr('管理')}
          </button>
        )}
        <button className="icon-btn" onClick={onClose} aria-label={tr('关闭')}>
          <X size={18} />
        </button>
      </div>
      <div className="sticker-grid">
        {stickers.map((s) => (
          <button
            key={s.id}
            className={`sticker-cell ${editing ? 'editing' : ''}`}
            onClick={() => (editing ? removeSticker(s.id).catch((e) => toast(e.message)) : onPick(s.p))}
            aria-label={editing ? tr('删除贴纸') : tr('发送贴纸')}
          >
            <StickerImg p={s.p} />
            {editing && (
              <span className="sticker-del">
                <Trash2 size={13} />
              </span>
            )}
          </button>
        ))}
        <button className="sticker-cell add" onClick={() => file.current?.click()} disabled={busy} aria-label={tr('添加贴纸')}>
          {busy ? <Spinner /> : <Plus size={22} />}
        </button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          multiple
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            setBusy(true);
            for (const f of files.slice(0, 20)) await addStickerFromFile(f).catch(() => toast(tr('无法添加：{v0}', { v0: f.name })));
            setBusy(false);
          }}
        />
      </div>
      {stickers.length === 0 && <p className="muted small center">{tr('点 + 选择图片做成贴纸，或在聊天里右键图片选择「添加到贴纸」。')}</p>}
    </div>
  );
}

export function StickerView({ p, onOpen }: { p: FilePayload; onOpen?: () => void }) {
  return (
    <div className="sticker-msg" onClick={(e) => (e.stopPropagation(), onOpen?.())}>
      {p.blobId ? <StickerImg p={p} /> : <Spinner />}
    </div>
  );
}
