import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff, ShieldCheck, Video, VideoOff, Minimize2, Maximize2, Loader2, Users, MonitorUp, MonitorX } from 'lucide-react';
import { groupScreenTrack, leaveGroupCall, toggleGroupCamera, toggleGroupMute, toggleGroupScreenShare, useGroupCall } from '../lib/groupcall';
import { formatDuration } from '../lib/files';
import { useStore } from '../lib/store';
import { useNameFor } from '../lib/social';
import { Avatar } from './ui';
import { tr } from '../lib/i18n';

/**
 * A remote video track can be "live" and unmuted while nothing is being sent (voice calls keep an idle video slot so
 * screen sharing needs no renegotiation), so the tile only switches to video once frames actually arrive.
 */
function StreamVideo({ stream, muted, className, onFrames }: { stream: MediaStream; muted?: boolean; className?: string; onFrames?: (on: boolean) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    if (!onFrames) return;
    const check = () => onFrames(v.videoWidth > 0);
    const t = setInterval(check, 500);
    v.addEventListener('resize', check);
    v.addEventListener('loadeddata', check);
    check();
    return () => {
      clearInterval(t);
      v.removeEventListener('resize', check);
      v.removeEventListener('loadeddata', check);
    };
  }, [stream, onFrames]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

function PeerAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

function Tile({ id, name, stream, video, me, speaking, state, screen }: { id: string; name: string; stream: MediaStream | null; video: boolean; me?: boolean; speaking: boolean; state?: string; screen?: boolean }) {
  const [frames, setFrames] = useState(false);
  return (
    <div className={`gc-tile ${speaking ? 'speaking' : ''}`}>
      {stream && video && (
        <StreamVideo stream={stream} muted onFrames={me ? undefined : setFrames} className={`gc-video ${me && !screen ? 'mirror' : ''} ${screen ? 'screen' : ''} ${me || frames ? '' : 'waiting'}`} />
      )}
      {!(stream && video && (me || frames)) && <Avatar id={id} user={id} name={name} size={64} />}
      <div className="gc-name">
        {name}
        {state && state !== 'connected' && (
          <span className="gc-state">
            {state === 'failed' ? tr('连接失败') : (
              <>
                <Loader2 size={11} className="spin" /> {tr('连接中')}
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

export function GroupCallOverlay() {
  const g = useGroupCall();
  // my own tile: the shared screen while sharing, else my camera
  const myStream = useMemo(() => (g.sharing && groupScreenTrack() ? new MediaStream([groupScreenTrack()!]) : g.local), [g.sharing, g.local]);
  const chat = useStore((s) => (g.chatId ? s.chats[g.chatId] : undefined));
  const me = useStore((s) => s.me);
  const nameOf = useNameFor();
  const [mini, setMini] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (g.phase !== 'in') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [g.phase]);
  if (g.phase === 'idle' || !me) return null;
  const room = g.chatId ? g.rooms[g.chatId] : undefined;
  const others = (room?.participants ?? []).filter((id) => id !== me.id);
  const member = (id: string) => chat?.members.find((m) => m.id === id);
  const n = others.length + 1;
  return (
    <div className={`call-overlay gc ${mini ? 'mini' : ''}`} role="dialog" aria-label={tr('群通话')}>
      <div className="call-top">
        <button className="call-icon-btn" onClick={() => setMini(!mini)} aria-label={mini ? tr('展开') : tr('缩小')}>
          {mini ? <Maximize2 size={18} /> : <Minimize2 size={18} />}
        </button>
        <span className="call-e2e">
          <ShieldCheck size={14} /> {tr('端到端加密')} · <Users size={13} /> {n}
        </span>
      </div>
      <div className="gc-title">
        <b>{chat?.title ?? tr('群通话')}</b>
        <span className="call-status">{g.phase === 'joining' ? tr('正在加入…') : formatDuration((now - (g.startedAt ?? now)) / 1000)}</span>
      </div>
      {!mini && (
        <div className={`gc-grid n${Math.min(n, 9)}`}>
          <Tile id={me.id} name={g.sharing ? tr('我（共享屏幕）') : tr('我')} stream={myStream} video={g.sharing || (g.video && !g.camOff)} me screen={g.sharing} speaking={!!g.speaking[me.id]} />
          {others.map((id) => {
            const m = member(id);
            const p = g.peers[id];
            return (
              <Tile
                key={id}
                id={id}
                name={m ? nameOf(id, m.displayName) : tr('成员')}
                stream={p?.stream ?? null}
                video={!!p?.hasVideo}
                speaking={!!g.speaking[id]}
                state={p?.state ?? 'new'}
              />
            );
          })}
        </div>
      )}
      {/* everyone's audio, independent of the tiles (keeps playing when minimised) */}
      {others.map((id) => (g.peers[id] ? <PeerAudio key={id} stream={g.peers[id].stream} /> : null))}
      <div className="call-controls">
        <button className={`call-btn ${g.muted ? 'off' : ''}`} onClick={toggleGroupMute} aria-label={g.muted ? tr('取消静音') : tr('静音')}>
          {g.muted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        {g.video && (
          <button className={`call-btn ${g.camOff ? 'off' : ''}`} onClick={toggleGroupCamera} aria-label={g.camOff ? tr('打开摄像头') : tr('关闭摄像头')}>
            {g.camOff ? <VideoOff size={22} /> : <Video size={22} />}
          </button>
        )}
        {g.phase === 'in' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && (
          <button className={`call-btn ${g.sharing ? 'off' : ''}`} onClick={toggleGroupScreenShare} aria-label={g.sharing ? tr('停止共享屏幕') : tr('共享屏幕')}>
            {g.sharing ? <MonitorX size={22} /> : <MonitorUp size={22} />}
          </button>
        )}
        <button className="call-btn danger" onClick={leaveGroupCall} aria-label={tr('离开通话')}>
          <PhoneOff size={24} />
        </button>
      </div>
    </div>
  );
}
