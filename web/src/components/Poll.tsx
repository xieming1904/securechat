import { useState } from 'react';
import { Check, ListChecks, Lock as LockIcon, Plus, X } from 'lucide-react';
import type { PollPayload } from '../crypto/core';
import { closePoll, sendPoll, toast, vote, type Msg } from '../lib/store';
import { Modal, Spinner } from './ui';
import { tr } from '../lib/i18n';

/** A poll inside a bubble. Question/options travel in the encrypted message; each vote is its own encrypted, signed record. */
export function PollBubble({ m, p, meId, names }: { m: Msg; p: PollPayload; meId: string; names: (id: string) => string }) {
  const votes = m.votes ?? {};
  const mine = votes[meId] ?? [];
  const [draft, setDraft] = useState<number[] | null>(null); // multi-choice selection before submit
  const [busy, setBusy] = useState(false);
  const [showVoters, setShowVoters] = useState(false);
  const voters = Object.keys(votes);
  const counts = p.options.map((_, i) => voters.filter((u) => votes[u].includes(i)).length);
  const voted = mine.length > 0;
  const reveal = voted || p.closed || m.senderId === meId;

  const cast = async (choice: number[]) => {
    setBusy(true);
    try {
      await vote(m, choice);
      setDraft(null);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const click = (i: number) => {
    if (p.closed || busy || m.pending) return;
    if (p.multi && !voted) {
      const d = draft ?? [];
      setDraft(d.includes(i) ? d.filter((x) => x !== i) : [...d, i]);
      return;
    }
    if (voted && mine.length === 1 && mine[0] === i && !p.multi) return cast([]); // click again = retract
    if (!voted || !p.multi) cast([i]);
  };

  return (
    <div className="poll" onClick={(e) => e.stopPropagation()}>
      <div className="poll-q">{p.q}</div>
      <div className="poll-kind muted small">
        {p.closed ? tr('投票已结束') : p.multi ? tr('多选投票') : tr('单选投票')} {tr(' · 端到端加密 · {v0} 人已投', { v0: voters.length })}
      </div>
      <div className="poll-opts">
        {p.options.map((o, i) => {
          const chosen = mine.includes(i) || (draft?.includes(i) ?? false);
          const pct = voters.length ? Math.round((counts[i] / voters.length) * 100) : 0;
          return (
            <button key={i} className={`poll-opt ${chosen ? 'chosen' : ''} ${reveal ? 'reveal' : ''}`} onClick={() => click(i)} disabled={p.closed || busy}>
              {reveal && <span className="poll-bar" style={{ width: `${pct}%` }} />}
              <span className={`poll-mark ${p.multi ? 'sq' : ''}`}>{chosen && <Check size={12} strokeWidth={3} />}</span>
              <span className="poll-label">{o}</span>
              {reveal && (
                <span className="poll-pct">
                  {pct}% <span className="muted">({counts[i]})</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="poll-actions">
        {p.multi && !voted && !p.closed && (
          <button className="btn small" disabled={!draft?.length || busy} onClick={() => cast(draft!)}>
            {busy ? <Spinner /> : tr('投票')}
          </button>
        )}
        {voted && !p.closed && (
          <button className="link small" disabled={busy} onClick={() => cast([])}>
            {tr('撤回投票')}
          </button>
        )}
        {voters.length > 0 && (
          <button className="link small" onClick={() => setShowVoters((v) => !v)}>
            {showVoters ? tr('隐藏投票人') : tr('查看投票人')}
          </button>
        )}
        {m.senderId === meId && !p.closed && !m.pending && (
          <button
            className="link small"
            onClick={() => confirm(tr('结束投票后，任何人都不能再投票或改票。继续？')) && closePoll(m).catch((e) => toast(e.message))}
          >
            <LockIcon size={12} /> {tr('结束投票')}
          </button>
        )}
      </div>
      {showVoters && (
        <div className="poll-voters small">
          {p.options.map((o, i) =>
            counts[i] ? (
              <div key={i}>
                <b>{o}</b>{tr('：')}{voters.filter((u) => votes[u].includes(i)).map(names).join(tr('、'))}
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

export function CreatePollDialog({ chatId, replyTo, onClose }: { chatId: string; replyTo?: string; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [busy, setBusy] = useState(false);
  const filled = opts.map((o) => o.trim()).filter(Boolean);
  const dup = new Set(filled).size !== filled.length;
  const ok = q.trim() && filled.length >= 2 && !dup;

  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      await sendPoll(chatId, q, filled, multi, replyTo);
      onClose();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={tr('发起投票')} onClose={onClose}>
      <form
        className="stack poll-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label>
          {tr('问题')}
          <input value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} placeholder={tr('例如：周五聚餐去哪？')} autoFocus />
        </label>
        <div className="stack tight">
          <span className="small muted">{tr('选项（2–10 个）')}</span>
          {opts.map((o, i) => (
            <div key={i} className="poll-opt-edit">
              <input
                value={o}
                maxLength={100}
                placeholder={tr('选项 {v0}', { v0: i + 1 })}
                onChange={(e) => {
                  const n = [...opts];
                  n[i] = e.target.value;
                  if (i === n.length - 1 && e.target.value && n.length < 10) n.push('');
                  setOpts(n);
                }}
              />
              {opts.length > 2 && (
                <button type="button" className="icon-btn" aria-label={tr('删除选项')} onClick={() => setOpts(opts.filter((_, j) => j !== i))}>
                  <X size={16} />
                </button>
              )}
            </div>
          ))}
          {opts.length < 10 && opts[opts.length - 1].trim() !== '' && (
            <button type="button" className="link small" onClick={() => setOpts([...opts, ''])}>
              <Plus size={14} /> {tr('添加选项')}
            </button>
          )}
          {dup && <p className="error small">{tr('选项不能重复')}</p>}
        </div>
        <label className="check">
          <input type="checkbox" className="switch" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> {tr('允许多选')}
        </label>
        <p className="muted small inline-ic">
          <ListChecks size={14} /> {tr('问题、选项和每个人的选择都是端到端加密的，服务器只知道谁投过票，不知道投了什么。')}
        </p>
        <button className="btn" disabled={!ok || busy}>
          {busy ? <Spinner /> : tr('发送投票')}
        </button>
      </form>
    </Modal>
  );
}
