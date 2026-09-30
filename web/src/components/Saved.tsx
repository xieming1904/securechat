import { useState } from 'react';
import { Bookmark, Forward, Trash2, Search } from 'lucide-react';
import type { FilePayload } from '../crypto/core';
import { fullTime } from '../lib/format';
import { unsave, useSocial, type SavedItem } from '../lib/social';
import { openChat, toast, useStore } from '../lib/store';
import { forwardSaved } from '../lib/savedForward';
import { BundleBubble } from './Bundle';
import { LinkCard } from './LinkCard';
import { FileBubble, Lightbox, RichText, summarize } from './MessageParts';
import { StickerView } from './Stickers';
import { Modal } from './ui';
import { tr } from '../lib/i18n';

function Body({ it, onOpen }: { it: SavedItem; onOpen: (p: FilePayload) => void }) {
  const p = it.p;
  if (p.t === 'text')
    return (
      <div className="text">
        <RichText text={p.text} />
        {p.preview && <LinkCard p={p.preview} />}
      </div>
    );
  if (p.t === 'file')
    return p.sticker ? (
      <StickerView p={p} />
    ) : (
      <>
        <FileBubble p={p} onOpen={onOpen} />
        {p.caption && (
          <div className="text">
            <RichText text={p.caption} />
          </div>
        )}
      </>
    );
  if (p.t === 'bundle') return <BundleBubble p={p} />;
  return <div className="text">{summarize(p)}</div>;
}

/** "Saved messages": my private, end-to-end encrypted bookmark list (synced between my devices). */
export function SavedDialog({ onClose }: { onClose: () => void }) {
  const saved = useSocial((s) => s.saved);
  const chats = useStore((s) => s.chats);
  const [q, setQ] = useState('');
  const [lightbox, setLightbox] = useState<FilePayload | null>(null);
  const [fwd, setFwd] = useState<SavedItem | null>(null);
  const t = q.trim().toLowerCase();
  const list = t ? saved.filter((s) => `${s.from} ${s.chatTitle} ${summarize(s.p)} ${s.p.t === 'text' ? s.p.text : ''}`.toLowerCase().includes(t)) : saved;
  return (
    <Modal title={tr('收藏夹（{v0}）', { v0: saved.length })} onClose={onClose} wide>
      <p className="muted small inline-ic">
        <Bookmark size={14} /> {tr('只有你能看到。内容用你自己的密钥加密，在你的所有设备上同步；原消息删了收藏也还在。')}
      </p>
      {saved.length > 0 && (
        <label className="search">
          <Search size={16} />
          <input placeholder={tr('搜索收藏')} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      )}
      {saved.length === 0 ? (
        <p className="muted center">{tr('还没有收藏。在消息上右键（手机上长按）选择「收藏」。')}</p>
      ) : (
        <div className="saved-list">
          {list.map((it) => (
            <div key={it.id} className="saved-item">
              <div className="saved-meta muted small">
                <b>{it.from}</b> · {it.chatTitle} · {fullTime(it.at)}
              </div>
              <Body it={it} onOpen={setLightbox} />
              <div className="saved-actions">
                <button className="link small" onClick={() => setFwd(it)}>
                  <Forward size={13} /> {tr('转发')}
                </button>
                <button className="link small danger" onClick={() => unsave(it.id).catch((e) => toast(e.message))}>
                  <Trash2 size={13} /> {tr('取消收藏')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {lightbox && <Lightbox p={lightbox} onClose={() => setLightbox(null)} />}
      {fwd && (
        <Modal title={tr('转发到…')} onClose={() => setFwd(null)}>
          <div className="forward-list">
            {Object.values(chats)
              .filter((c) => c.integrity !== 'mismatch')
              .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt))
              .map((c) => (
                <button
                  key={c.id}
                  className="chat-item"
                  onClick={() => {
                    const item = fwd;
                    setFwd(null);
                    onClose();
                    forwardSaved(item, c.id)
                      .then(() => openChat(c.id))
                      .catch((e) => toast(e.message));
                  }}
                >
                  <span className="chat-title">{c.title}</span>
                </button>
              ))}
          </div>
        </Modal>
      )}
    </Modal>
  );
}
