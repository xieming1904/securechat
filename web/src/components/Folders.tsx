import { useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import * as C from '../crypto/core';
import { Avatar, Modal } from './ui';
import { useStore } from '../lib/store';
import { useChatTitle } from '../lib/social';
import { deleteFolder, moveFolder, pruneMissing, saveFolder, useChatList, MAX_FOLDERS, type Folder } from '../lib/chatlist';
import { tr } from '../lib/i18n';

/** Manage chat folders (encrypted, synced across my devices). */
export function FoldersDialog({ onClose, editId }: { onClose: () => void; editId?: string }) {
  const folders = useChatList((s) => s.folders);
  const [editing, setEditing] = useState<Folder | null>(() => (editId ? folders.find((f) => f.id === editId) ?? null : null));
  if (editing) return <FolderEditor f={editing} onDone={() => (editId ? onClose() : setEditing(null))} />;
  return (
    <Modal title={tr('聊天分组')} onClose={onClose}>
      <p className="muted small">{tr('分组显示在聊天列表上方。分组信息加密保存，并在你的所有设备间同步，服务器看不到。')}</p>
      {folders.length === 0 && <p className="muted center">{tr('还没有自定义分组')}</p>}
      <div className="folder-list">
        {folders.map((f, i) => (
          <div key={f.id} className="folder-row">
            <b className="grow">{f.name}</b>
            <span className="muted small">{describe(f)}</span>
            <button className="icon-btn" disabled={i === 0} onClick={() => moveFolder(f.id, -1)} aria-label={tr('上移')}>
              <ArrowUp size={16} />
            </button>
            <button className="icon-btn" disabled={i === folders.length - 1} onClick={() => moveFolder(f.id, 1)} aria-label={tr('下移')}>
              <ArrowDown size={16} />
            </button>
            <button className="icon-btn" onClick={() => setEditing(f)} aria-label={tr('编辑')}>
              <Pencil size={16} />
            </button>
            <button className="icon-btn danger" onClick={() => deleteFolder(f.id)} aria-label={tr('删除')}>
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
      {folders.length < MAX_FOLDERS && (
        <button className="btn" onClick={() => (pruneMissing(), setEditing({ id: C.randomId().slice(0, 16), name: '', chats: [] }))}>
          <Plus size={17} /> {tr('新建分组')}
        </button>
      )}
    </Modal>
  );
}

function describe(f: Folder) {
  const parts: string[] = [];
  if (f.types?.includes('direct')) parts.push(tr('所有私聊'));
  if (f.types?.includes('group')) parts.push(tr('所有群组'));
  if (f.chats.length) parts.push(tr('{v0} 个聊天', { v0: f.chats.length }));
  if (f.unreadOnly) parts.push(tr('仅未读'));
  return parts.join(' · ') || tr('空');
}

function FolderEditor({ f, onDone }: { f: Folder; onDone: () => void }) {
  const [name, setName] = useState(f.name);
  const [types, setTypes] = useState<('direct' | 'group')[]>(f.types ?? []);
  const [unreadOnly, setUnreadOnly] = useState(!!f.unreadOnly);
  const [picked, setPicked] = useState<Set<string>>(new Set(f.chats));
  const [q, setQ] = useState('');
  const chats = useStore((s) => s.chats);
  const titleOf = useChatTitle();
  const list = Object.values(chats)
    .filter((c) => !q.trim() || titleOf(c).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
  const toggleType = (t: 'direct' | 'group') => setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t]);
  return (
    <Modal title={f.name ? tr('编辑分组') : tr('新建分组')} onClose={onDone}>
      <label className="field">
        {tr('名称')}
        <input autoFocus maxLength={24} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('例如：工作、家人')} />
      </label>
      <div className="folder-opts">
        <label className="check">
          <input type="checkbox" checked={types.includes('direct')} onChange={() => toggleType('direct')} /> {tr('包含所有私聊')}
        </label>
        <label className="check">
          <input type="checkbox" checked={types.includes('group')} onChange={() => toggleType('group')} /> {tr('包含所有群组')}
        </label>
        <label className="check">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> {tr('只显示未读')}
        </label>
      </div>
      <div className="field">
        {tr('选择聊天（{v0}）', { v0: picked.size })}
        <input placeholder={tr('搜索')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="folder-pick">
        {list.map((c) => (
          <label key={c.id} className="check pick-row">
            <input
              type="checkbox"
              checked={picked.has(c.id)}
              onChange={() => {
                const n = new Set(picked);
                if (n.has(c.id)) n.delete(c.id);
                else n.add(c.id);
                setPicked(n);
              }}
            />
            <Avatar id={c.id} chat={c} name={titleOf(c)} size={30} group={c.type === 'group'} />
            <span className="grow ellipsis">{titleOf(c)}</span>
          </label>
        ))}
      </div>
      <div className="row gap end">
        <button className="btn ghost" onClick={onDone}>
          {tr('取消')}
        </button>
        <button
          className="btn"
          disabled={!name.trim()}
          onClick={() => {
            saveFolder({ id: f.id, name: name.trim(), chats: [...picked], types: types.length ? types : undefined, unreadOnly });
            onDone();
          }}
        >
          {tr('保存')}
        </button>
      </div>
    </Modal>
  );
}
