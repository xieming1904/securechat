import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, LockKeyhole, Paperclip, SendHorizontal, Mic, Trash2, Timer, ShieldCheck, Info, Hourglass, X, Phone, Video, BadgeCheck, RotateCcw } from 'lucide-react';
import { callInSecretChat, deleteSecretChat, openSecret, setSecretLocal, startSecretChat, secretSafetyNumber, sendSecretFile, sendSecretText, setSecretTtl, TTL_CHOICES, ttlLabel, useSecret, type SecretChat, type SecretMsg } from '../lib/secret';
import { toast } from '../lib/store';
import { prepareFile, prepareVoice, VoiceRecorder, formatDuration } from '../lib/files';
import { usePrefs } from '../lib/prefs';
import { dayKey, dayLabel, timeOf } from '../lib/format';
import { FileBubble, Lightbox, RichText } from '../components/MessageParts';
import { Avatar, Modal } from '../components/ui';
import type { FilePayload } from '../crypto/core';
import { tr } from '../lib/i18n';

const STATUS_NOTE: Record<string, string> = {
  waiting: '已发出邀请。对方的设备上线后会自动接受，之后就可以聊天了。',
  elsewhere: '这个私密对话已在你的另一台设备上接受，只能在那台设备上查看。',
  closed: '这个私密对话已经结束。',
  peer_gone: '对方那台设备已经不在了（退出登录、清除了数据或换了设备），这个私密对话不能继续。',
};

export function SecretChatView({ chatId }: { chatId: string }) {
  const chat = useSecret((s) => s.chats[chatId]);
  const messages = useSecret((s) => s.messages[chatId]);
  const [info, setInfo] = useState(false);
  const [lightbox, setLightbox] = useState<FilePayload | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);
  if (!chat) return null;
  const list = messages ?? [];
  return (
    <section className="chat-view secret-view">
      <header className="chat-head">
        <button className="icon-btn back" onClick={() => openSecret(null)} aria-label={tr('返回')}>
          <ArrowLeft size={21} />
        </button>
        <button className="chat-head-main" onClick={() => setInfo(true)}>
          <Avatar id={chat.peerId} user={chat.peerId} name={chat.peerName} size={40} />
          <div>
            <div className="chat-title secret-title">
              <LockKeyhole size={15} /> {chat.peerName}
              {chat.verified && chat.status === 'active' && <BadgeCheck size={15} className="ok-text" aria-label={tr('已验证')} />}
            </div>
            <div className="muted small">
              {tr('私密对话')}
              {chat.ttl > 0 && (
                <span className="inline-ic">
                  {' · '}
                  <Timer size={12} /> {ttlLabel(chat.ttl)}
                </span>
              )}
            </div>
          </div>
        </button>
        {chat.status === 'active' && (
          <>
            <button className="icon-btn" onClick={() => Promise.resolve(callInSecretChat(chat.id, false)).catch((e) => toast(e.message))} aria-label={tr('私密语音通话')} title={tr('私密语音通话')}>
              <Phone size={19} />
            </button>
            <button className="icon-btn" onClick={() => Promise.resolve(callInSecretChat(chat.id, true)).catch((e) => toast(e.message))} aria-label={tr('私密视频通话')} title={tr('私密视频通话')}>
              <Video size={20} />
            </button>
          </>
        )}
        <button className="icon-btn" onClick={() => setInfo(true)} aria-label={tr('私密对话信息')}>
          <Info size={20} />
        </button>
      </header>
      <div className="secret-banner">
        <ShieldCheck size={15} /> {tr('只在这台设备和对方的一台设备上。消息有前向保密，服务器送达后即删除。')}
      </div>
      <div className="messages" ref={scroller}>
        {list.map((m, i) => {
          const prev = list[i - 1];
          const newDay = !prev || dayKey(prev.at) !== dayKey(m.at);
          return (
            <Fragment key={m.id}>
              {newDay && <div className="day-sep">{dayLabel(m.at)}</div>}
              <SecretBubble m={m} onOpen={setLightbox} />
            </Fragment>
          );
        })}
        {chat.status !== 'active' && (
          <div className="secret-status muted small">
            {tr(STATUS_NOTE[chat.status])}
            {(chat.status === 'peer_gone' || chat.status === 'closed') && (
              <div>
                <button className="btn small" style={{ marginTop: 10 }} onClick={() => startSecretChat(chat.peerId, chat.peerName).catch((e) => toast(e.message))}>
                  <RotateCcw size={14} /> {tr('重新发起私密对话')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {chat.status === 'active' ? <SecretComposer chat={chat} /> : <div className="composer-wrap" />}
      {lightbox && <Lightbox p={lightbox} onClose={() => setLightbox(null)} />}
      {info && <SecretInfo chat={chat} onClose={() => setInfo(false)} />}
    </section>
  );
}

function SecretBubble({ m, onOpen }: { m: SecretMsg; onOpen: (p: FilePayload) => void }) {
  const p = m.p;
  if (p.t === 'event') return <div className="day-sep secret-event">{p.text}</div>;
  const isMedia = p.t === 'file' && (p.kind === 'image' || p.kind === 'video') && !p.caption;
  return (
    <div className={`msg-row ${m.mine ? 'mine' : ''}`}>
      <div className={`bubble ${isMedia ? 'media-only' : ''}`}>
        {p.t === 'file' && <FileBubble p={p} onOpen={onOpen} />}
        {p.t === 'text' ? (
          <div className="text">
            <RichText text={p.text} />
          </div>
        ) : p.t === 'file' && p.caption ? (
          <div className="text">
            <RichText text={p.caption} />
          </div>
        ) : null}
        <div className="meta">
          {m.expiresAt && <ExpiresIn at={m.expiresAt} />}
          <span>{timeOf(m.at)}</span>
        </div>
      </div>
    </div>
  );
}

function ExpiresIn({ at }: { at: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((at - Date.now()) / 1000));
  const label = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86_400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86_400)}d`;
  return (
    <span className="inline-ic" title={tr('阅后即焚')}>
      <Hourglass size={11} /> {label}
    </span>
  );
}

function SecretComposer({ chat }: { chat: SecretChat }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<null | { rec: VoiceRecorder; t: number }>(null);
  const enterSends = usePrefs((p) => p.enterSends);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setRecording((r) => (r ? { ...r, t: r.t + 1 } : r)), 1000);
    return () => clearInterval(t);
  }, [!!recording]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn()
      .catch((e) => toast(e.message))
      .finally(() => setBusy(false));
  };
  const send = () => {
    const t = text;
    if (!t.trim()) return;
    setText('');
    run(() => sendSecretText(chat.id, t).catch((e) => (setText(t), Promise.reject(e))));
  };
  const startVoice = async () => {
    if (!VoiceRecorder.supported()) return toast(tr('此浏览器不支持录音'));
    const rec = new VoiceRecorder();
    try {
      await rec.start();
      setRecording({ rec, t: 0 });
    } catch {
      toast(tr('无法使用麦克风'));
    }
  };
  const stopVoice = async (sendIt: boolean) => {
    const r = recording;
    setRecording(null);
    if (!r) return;
    const out = await r.rec.stop();
    if (sendIt && out.duration >= 1) run(async () => sendSecretFile(chat.id, await prepareVoice(out.blob, out.duration)));
  };
  if (recording)
    return (
      <div className="composer-wrap">
        <div className="composer recording">
          <button className="icon-btn" onClick={() => stopVoice(false)} aria-label={tr('取消录音')}>
            <Trash2 size={20} />
          </button>
          <span className="rec-dot" /> {tr('正在录音 {v0}', { v0: formatDuration(recording.t) })}
          <span className="grow" />
          <button className="send-btn" onClick={() => stopVoice(true)} aria-label={tr('发送语音')}>
            <SendHorizontal size={19} />
          </button>
        </div>
      </div>
    );
  return (
    <div className="composer-wrap">
      <div className="composer">
        <button className="icon-btn attach" onClick={() => fileInput.current?.click()} aria-label={tr('发送文件')} disabled={busy}>
          <Paperclip size={21} />
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            run(async () => {
              for (const f of files) await sendSecretFile(chat.id, await prepareFile(f));
            });
          }}
        />
        <textarea
          rows={1}
          placeholder={tr('输入私密消息…')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            if (enterSends ? !e.shiftKey : e.ctrlKey || e.metaKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {text.trim() ? (
          <button className="send-btn" onClick={send} aria-label={tr('发送')} disabled={busy}>
            <SendHorizontal size={19} />
          </button>
        ) : (
          <button className="send-btn mic" onClick={startVoice} aria-label={tr('录制语音')} disabled={busy}>
            <Mic size={20} />
          </button>
        )}
      </div>
    </div>
  );
}

function SecretInfo({ chat, onClose }: { chat: SecretChat; onClose: () => void }) {
  const mine = useSecret((s) => s.myCert);
  const code = secretSafetyNumber(chat, mine);
  const [confirm, setConfirm] = useState(false);
  return (
    <Modal title={tr('私密对话')} onClose={onClose}>
      <div className="secret-info">
        <p className="muted small">
          {tr('私密对话只存在于这台设备和对方的一台设备上。每条消息用一次性的密钥加密，密钥用完即删；即使以后设备被入侵，已经删除的消息也解不开。文字消息送达后服务器立即删除；图片和文件（加密的）在服务器上最多保留 14 天。换设备或清除浏览器数据后无法恢复。')}
        </p>
        <h4>{tr('安全码')}</h4>
        {code ? (
          <>
            <code className="safety-code">{code}</code>
            <p className="muted small">{tr('和对方当面或通过其他渠道比对，一致就说明中间没有人冒充。这个安全码只属于这一对设备。')}</p>
            <label className="pref-row">
              <span>
                <b>{tr('已核对，标记为已验证')}</b>
                <span className="muted small block">{tr('只记在这台设备上。对方换了设备就是新的私密对话，需要重新核对。')}</span>
              </span>
              <input type="checkbox" className="switch" checked={!!chat.verified} onChange={(e) => setSecretLocal(chat.id, { verified: e.target.checked })} aria-label={tr('已核对，标记为已验证')} />
            </label>
          </>
        ) : (
          <p className="muted small">{tr('对方接受后才会显示。')}</p>
        )}
        <h4>{tr('这台设备上')}</h4>
        <label className="pref-row">
          <b>{tr('置顶')}</b>
          <input type="checkbox" className="switch" checked={!!chat.pinned} onChange={(e) => setSecretLocal(chat.id, { pinned: e.target.checked })} aria-label={tr('置顶')} />
        </label>
        <label className="pref-row">
          <b>{tr('免打扰')}</b>
          <input type="checkbox" className="switch" checked={!!chat.muted} onChange={(e) => setSecretLocal(chat.id, { muted: e.target.checked })} aria-label={tr('免打扰')} />
        </label>
        {chat.status === 'active' && (
          <>
            <h4>{tr('阅后即焚')}</h4>
            <div className="choices">
              {TTL_CHOICES.map((t) => (
                <button key={t} className={`choice ${chat.ttl === t ? 'on' : ''}`} onClick={() => setSecretTtl(chat.id, t).catch((e) => toast(e.message))}>
                  {ttlLabel(t)}
                </button>
              ))}
            </div>
            <p className="muted small">{tr('从消息发出（或收到）时开始计时，到时间后两边都会删除。')}</p>
          </>
        )}
        <div className="row gap" style={{ marginTop: 16 }}>
          {confirm ? (
            <>
              <button className="btn danger" onClick={() => deleteSecretChat(chat.id).then(onClose)}>
                <Trash2 size={16} /> {chat.status === 'active' ? tr('确认结束并删除') : tr('确认删除')}
              </button>
              <button className="btn ghost" onClick={() => setConfirm(false)}>
                <X size={16} /> {tr('取消')}
              </button>
            </>
          ) : (
            <button className="btn danger ghost" onClick={() => setConfirm(true)}>
              <Trash2 size={16} /> {chat.status === 'active' ? tr('结束私密对话') : tr('删除这个私密对话')}
            </button>
          )}
        </div>
        {confirm && chat.status === 'active' && <p className="muted small">{tr('双方设备上的这个对话都会被删除。')}</p>}
      </div>
    </Modal>
  );
}
