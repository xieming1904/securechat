import { useState } from 'react';
import { CalendarClock, SendHorizontal, Trash2, TriangleAlert } from 'lucide-react';
import { cancelScheduled, rescheduleMsg, sendScheduledNow, toast, useStore, type ScheduledMsg } from '../lib/store';
import { summarize } from './MessageParts';
import { Modal, Spinner } from './ui';
import { tr } from '../lib/i18n';

const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function whenLabel(t: number) {
  const d = new Date(t);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === today.toDateString()) return tr('今天 {v0}', { v0: hm });
  if (d.toDateString() === tomorrow.toDateString()) return tr('明天 {v0}', { v0: hm });
  return tr('{v0}{v1}月{v2}日 {v3}', { v0: d.getFullYear() !== today.getFullYear() ? tr('{v0}年', { v0: d.getFullYear() }) : '', v1: d.getMonth() + 1, v2: d.getDate(), v3: hm });
}

function presets() {
  const now = new Date();
  const at = (days: number, h: number, m = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const list: { label: string; t: number }[] = [
    { label: tr('1 小时后'), t: Date.now() + 3_600_000 },
    { label: tr('3 小时后'), t: Date.now() + 3 * 3_600_000 },
  ];
  if (now.getHours() < 20) list.push({ label: tr('今晚 21:00'), t: at(0, 21) });
  list.push({ label: tr('明早 9:00'), t: at(1, 9) });
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  list.push({ label: tr('下周一 9:00'), t: at(toMonday, 9) });
  return list;
}

/** Pick a time for a scheduled message. */
export function SchedulePicker({ initial, title = tr('定时发送'), onPick, onClose }: { initial?: number; title?: string; onPick: (t: number) => Promise<void>; onClose: () => void }) {
  const [custom, setCustom] = useState(toLocalInput(initial ?? Date.now() + 3_600_000));
  const [busy, setBusy] = useState(false);
  const pick = async (t: number) => {
    if (t < Date.now() + 10_000) return toast(tr('请选择未来的时间'));
    if (t > Date.now() + 365 * 86_400_000) return toast(tr('最多只能定时到一年以后'));
    setBusy(true);
    try {
      await onPick(t);
      onClose();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <div className="sched-presets">
          {presets().map((p) => (
            <button key={p.label} className="btn secondary" disabled={busy} onClick={() => pick(p.t)}>
              {p.label}
              <span className="muted small">{whenLabel(p.t)}</span>
            </button>
          ))}
        </div>
        <label className="stack tight">
          <span className="small muted">{tr('自定义时间')}</span>
          <input type="datetime-local" value={custom} min={toLocalInput(Date.now())} onChange={(e) => setCustom(e.target.value)} />
        </label>
        <button className="btn" disabled={busy || !custom} onClick={() => pick(new Date(custom).getTime())}>
          {busy ? <Spinner /> : tr('在 {v0} 发送', { v0: custom ? whenLabel(new Date(custom).getTime()) : '…' })}
        </button>
        <p className="muted small">{tr('消息现在就在本机加密并签名，服务器只保存密文，到点原样发出。如果期间群成员变化导致密钥轮换，你下次上线时会自动用新密钥重新加密。')}</p>
      </div>
    </Modal>
  );
}

/** My pending scheduled messages in one chat. */
export function ScheduledList({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const list = useStore((s) => s.scheduled[chatId] ?? []);
  const [editing, setEditing] = useState<ScheduledMsg | null>(null);
  const run = (p: Promise<unknown>) => p.catch((e) => toast((e as Error).message));
  if (editing) return <SchedulePicker title={tr('修改发送时间')} initial={editing.sendAt} onPick={(t) => rescheduleMsg(editing, t)} onClose={() => setEditing(null)} />;
  return (
    <Modal title={tr('定时消息（{v0}）', { v0: list.length })} onClose={onClose}>
      {list.length === 0 ? (
        <p className="muted">{tr('没有待发送的定时消息')}</p>
      ) : (
        <div className="sched-list">
          {list.map((m) => (
            <div key={m.id} className="sched-item">
              <div className="sched-when">
                <CalendarClock size={14} /> {whenLabel(m.sendAt)}
                {m.stale && (
                  <span className="warn-chip" title={tr('密钥已轮换，等待重新加密')}>
                    <TriangleAlert size={12} /> {tr('待重新加密')}
                  </span>
                )}
              </div>
              <div className="sched-text">{m.payload ? summarize(m.payload) : tr('[无法解密]')}</div>
              <div className="sched-actions">
                <button className="link small" onClick={() => setEditing(m)}>
                  {tr('改时间')}
                </button>
                <button className="link small" onClick={() => run(sendScheduledNow(m))}>
                  <SendHorizontal size={13} /> {tr('立即发送')}
                </button>
                <button className="link small danger" onClick={() => run(cancelScheduled(m))}>
                  <Trash2 size={13} /> {tr('删除')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
