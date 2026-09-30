import { useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import type { BundleItem, BundlePayload, FilePayload } from '../crypto/core';
import { fullTime } from '../lib/format';
import { FileBubble, Lightbox, RichText, summarize } from './MessageParts';
import { LinkCard } from './LinkCard';
import { Avatar, Modal } from './ui';
import { tr } from '../lib/i18n';

const line = (i: BundleItem) => (i.p.t === 'bundle' ? tr('[聊天记录] {v0}', { v0: i.p.title }) : summarize(i.p));

/** A merged forward ("chat history") inside a bubble: title + the first lines; click to open. */
export function BundleBubble({ p }: { p: BundlePayload }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="bundle-card"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <div className="bundle-title">
          <MessagesSquare size={15} /> {p.title}
        </div>
        <div className="bundle-lines">
          {p.items.slice(0, 4).map((i, k) => (
            <div key={k}>
              <b>{tr('{v0}：', { v0: i.from })}</b>
              {line(i)}
            </div>
          ))}
        </div>
        <div className="bundle-foot">{tr('查看 {v0} 条聊天记录', { v0: p.items.length })}</div>
      </button>
      {open && <BundleView p={p} onClose={() => setOpen(false)} />}
    </>
  );
}

export function BundleView({ p, onClose }: { p: BundlePayload; onClose: () => void }) {
  const [lightbox, setLightbox] = useState<FilePayload | null>(null);
  return (
    <Modal title={p.title} onClose={onClose} wide>
      <div className="bundle-view">
        {p.items.map((i, k) => (
          <div key={k} className="bundle-item">
            <Avatar id={i.from} name={i.from} size={32} />
            <div className="bundle-item-body">
              <div className="bundle-meta">
                <b>{i.from}</b> <span className="muted small">{fullTime(i.at)}</span>
              </div>
              {i.p.t === 'text' ? (
                <div className="text">
                  <RichText text={i.p.text} />
                  {i.p.preview && <LinkCard p={i.p.preview} />}
                </div>
              ) : i.p.t === 'file' ? (
                <>
                  <FileBubble p={i.p} onOpen={setLightbox} />
                  {i.p.caption && (
                    <div className="text">
                      <RichText text={i.p.caption} />
                    </div>
                  )}
                </>
              ) : i.p.t === 'bundle' ? (
                <div className="text muted">
                  {tr('[聊天记录] {v0}（{v1} 条，内容未包含在此次转发中）', { v0: i.p.title, v1: i.p.n })}
                </div>
              ) : (
                <div className="text muted">{line(i)}</div>
              )}
            </div>
          </div>
        ))}
      </div>
      {lightbox && <Lightbox p={lightbox} onClose={() => setLightbox(null)} />}
    </Modal>
  );
}
