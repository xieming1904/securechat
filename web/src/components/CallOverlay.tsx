import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, ShieldCheck, Video, VideoOff, Minimize2, Maximize2, MonitorUp, MonitorX, SwitchCamera } from 'lucide-react';
import { acceptCall, flipCamera, hangup, rejectCall, toggleCamera, toggleMute, toggleScreenShare, useCall } from '../lib/call';
import { formatDuration } from '../lib/files';
import { useStore } from '../lib/store';
import { Avatar } from './ui';
import { tr } from '../lib/i18n';

function StreamVideo({ stream, muted, className }: { stream: MediaStream | null; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

export function CallOverlay() {
  const c = useCall();
  const peer = useStore((s) => (c.chatId ? s.chats[c.chatId]?.members.find((m) => m.id === c.peerId) : undefined));
  const [now, setNow] = useState(Date.now());
  const [mini, setMini] = useState(false);
  useEffect(() => {
    if (c.phase !== 'active') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [c.phase]);
  useEffect(() => {
    if (c.phase === 'idle') setMini(false);
  }, [c.phase]);
  if (c.phase === 'idle') return null;

  const name = peer?.displayName ?? tr('对方');
  const hasRemoteVideo = c.video && (c.remote?.getVideoTracks().length ?? 0) > 0;
  const status =
    c.phase === 'incoming'
      ? c.video
        ? tr('邀请你视频通话…')
        : tr('邀请你语音通话…')
      : c.phase === 'outgoing'
        ? tr('正在呼叫…')
        : c.phase === 'connecting'
          ? tr('正在建立加密连接…')
          : c.reconnecting
            ? tr('网络切换，正在重新连接…')
            : formatDuration((now - (c.startedAt ?? now)) / 1000);

  return (
    <div className={`call-overlay ${mini ? 'mini' : ''} ${c.video ? 'is-video' : ''}`} role="dialog" aria-label={tr('通话')}>
      {/* remote audio always plays through this element (also for voice calls) */}
      {!hasRemoteVideo && c.remote && <StreamVideo stream={c.remote} className="call-audio" />}
      {hasRemoteVideo && <StreamVideo stream={c.remote} className="call-remote" />}
      {c.video && c.local && !c.camOff && <StreamVideo stream={c.local} muted className={`call-local ${c.sharing ? 'screen' : ''}`} />}

      <div className="call-top">
        <button className="call-icon-btn" onClick={() => setMini(!mini)} aria-label={mini ? tr('展开') : tr('缩小')}>
          {mini ? <Maximize2 size={18} /> : <Minimize2 size={18} />}
        </button>
        <span className="call-e2e">
          <ShieldCheck size={14} /> {c.secretChatId ? tr('私密通话') : tr('端到端加密')}{c.relayed ? tr(' · 经中转隐藏 IP') : ''}
          {c.phase === 'active' && c.quality && (
            <span className={`call-quality ${c.quality}`} title={c.quality === 'good' ? tr('网络良好') : c.quality === 'ok' ? tr('网络一般') : tr('网络较差')}>
              <i />
              <i />
              <i />
            </span>
          )}
        </span>
      </div>

      {(!hasRemoteVideo || mini) && (
        <div className="call-center">
          {peer && <Avatar id={peer.id} user={peer.id} name={name} size={mini ? 44 : 96} />}
          <div className="call-name">{name}</div>
          <div className="call-status">{status}</div>
          {c.note && !mini && <div className="call-note">{c.note}</div>}
        </div>
      )}
      {hasRemoteVideo && !mini && (
        <div className="call-caption">
          {name} · {status}
        </div>
      )}

      <div className="call-controls">
        {c.phase === 'incoming' ? (
          <>
            <button className="call-btn danger" onClick={rejectCall} aria-label={tr('拒绝')}>
              <PhoneOff size={24} />
            </button>
            <button className="call-btn accept" onClick={acceptCall} aria-label={tr('接听')}>
              {c.video ? <Video size={24} /> : <Phone size={24} />}
            </button>
          </>
        ) : (
          <>
            <button className={`call-btn ${c.muted ? 'off' : ''}`} onClick={toggleMute} aria-label={c.muted ? tr('取消静音') : tr('静音')}>
              {c.muted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>
            {c.video && (
              <button className={`call-btn ${c.camOff ? 'off' : ''}`} onClick={toggleCamera} aria-label={c.camOff ? tr('打开摄像头') : tr('关闭摄像头')}>
                {c.camOff ? <VideoOff size={22} /> : <Video size={22} />}
              </button>
            )}
            {c.video && c.phase === 'active' && c.canFlip && !c.sharing && (
              <button className="call-btn" onClick={flipCamera} aria-label={tr('切换摄像头')}>
                <SwitchCamera size={22} />
              </button>
            )}
            {c.video && c.phase === 'active' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && (
              <button className={`call-btn ${c.sharing ? 'off' : ''}`} onClick={toggleScreenShare} aria-label={c.sharing ? tr('停止共享屏幕') : tr('共享屏幕')}>
                {c.sharing ? <MonitorX size={22} /> : <MonitorUp size={22} />}
              </button>
            )}
            <button className="call-btn danger" onClick={hangup} aria-label={tr('挂断')}>
              <PhoneOff size={24} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
