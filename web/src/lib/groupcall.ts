/**
 * Group calls (v0.5) — a small mesh: every participant has a direct WebRTC connection (DTLS-SRTP) to every other one,
 * so audio/video stay end-to-end encrypted without any media server. Up to 8 people (voice) / 6 (video, 360p).
 *
 * Signalling is the same as for 1:1 calls: encrypted with the group key and signed with the sender's identity key,
 * relayed by the server only between people who are in the call. Whoever joins later sends the offers to everyone
 * already there (so two sides never offer at once); the offering side also restarts ICE when a connection breaks.
 */
import { create } from 'zustand';
import * as C from '../crypto/core';
import { api } from './api';
import { prefs } from './prefs';
import { chatKeyAt, currentChatKey, getSocket, getUserKeys, myIdentity, onSocket, postCallLog, toast, useStore } from './store';
import { useCall } from './call';
import { tr } from './i18n';

export const MAX_AUDIO = 8;
export const MAX_VIDEO = 6;

export interface RoomInfo {
  chatId: string;
  callId: string | null;
  video?: boolean;
  startedAt?: number;
  startedBy?: string;
  participants: string[];
}
export interface PeerView {
  stream: MediaStream;
  state: RTCPeerConnectionState | 'new';
  hasVideo: boolean;
}
interface GroupCallState {
  phase: 'idle' | 'joining' | 'in';
  chatId: string | null;
  callId: string | null;
  video: boolean;
  muted: boolean;
  camOff: boolean;
  local: MediaStream | null;
  startedAt: number | null;
  peers: Record<string, PeerView>;
  speaking: Record<string, boolean>;
  /** sharing my screen (sent in place of the camera, or as the only video in a voice call) */
  sharing: boolean;
  /** calls going on in my groups (for the "join" banner) */
  rooms: Record<string, RoomInfo>;
}

const IDLE = { phase: 'idle' as const, chatId: null, callId: null, video: false, muted: false, camOff: false, local: null, startedAt: null, peers: {}, speaking: {}, sharing: false };
export const useGroupCall = create<GroupCallState>(() => ({ ...IDLE, rooms: {} }));
const set = useGroupCall.setState;
const get = useGroupCall.getState;

type Sig =
  | { type: 'offer'; callId: string; sdp: string }
  | { type: 'answer'; callId: string; sdp: string }
  | { type: 'ice'; callId: string; candidate: RTCIceCandidateInit };
/** every join (and rejoin after a reconnect) gets a fresh id, so the others replace their old connection to me */
type Tagged = Sig & { g?: number; sid?: string };

interface Peer {
  pc: RTCPeerConnection;
  offerer: boolean;
  stream: MediaStream;
  pendingIce: RTCIceCandidateInit[];
  restarts: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** the other side's join id */
  remoteSid: string | null;
}
const peers = new Map<string, Peer>();
const creating = new Map<string, Promise<Peer | null>>();
/** the screen being shared (replaces the camera on every connection, no renegotiation needed) */
let screenTrack: MediaStreamTrack | null = null;
/** most people in the call at once (for the call-log message) */
let maxPeople = 1;
let mySid = '';
let iceConfig: { iceServers: RTCIceServer[]; relay: boolean } | null = null;

// ------------------------------------------------------------------ signalling
async function send(to: string, data: Sig) {
  const s = get();
  const me = useStore.getState().me;
  const id = myIdentity();
  const sock = getSocket();
  if (!s.chatId || !me || !id || !sock) return;
  const { key, epoch } = await currentChatKey(s.chatId);
  sock.emit('gcall:signal', { chatId: s.chatId, to, env: C.encryptSignal({ ...data, g: 1, sid: mySid }, key, { chatId: s.chatId, from: me.id, to, epoch }, id) });
}

type RawSignal = { chatId: string; from: string; env: { epoch: number; nonce: string; ciphertext: string; signature: string } };
/** offers can arrive while I'm still joining (the server lists me before my join is confirmed): hold them briefly */
let early: RawSignal[] = [];
async function onSignal(d: RawSignal) {
  const s = get();
  const me = useStore.getState().me;
  if (s.phase === 'joining' && d.chatId === s.chatId) {
    if (early.length < 200) early.push(d);
    return;
  }
  if (s.phase !== 'in' || d.chatId !== s.chatId || !me) return;
  let msg: Tagged;
  try {
    const key = await chatKeyAt(d.chatId, d.env.epoch);
    if (!key) return;
    msg = C.decryptSignal(d.env, key, { chatId: d.chatId, from: d.from, to: me.id }, (await getUserKeys(d.from)).signPk);
  } catch {
    return; // forged or undecryptable
  }
  if (msg.g !== 1 || msg.callId !== s.callId || typeof msg.sid !== 'string') return;
  // only people who are members of the group (per the signed member list) may take part
  if (!useStore.getState().chats[d.chatId]?.members.some((m) => m.id === d.from)) return;
  const existing = peers.get(d.from);
  if (msg.type === 'offer') {
    let p: Peer | null | undefined = existing;
    // they rejoined (reconnect / another device): drop the old connection and take the new one
    if (p && p.remoteSid && p.remoteSid !== msg.sid) {
      closePeer(d.from);
      p = undefined;
    }
    if (p?.offerer) return; // we're the side that offers to them
    if (!p) p = await getPeer(d.from, false);
    if (!p) return;
    p.remoteSid = msg.sid;
    await p.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    // the offer always carries a video slot: send on it too (camera, a shared screen later, or nothing yet)
    for (const t of p.pc.getTransceivers()) if (t.receiver.track.kind === 'video' && t.direction === 'recvonly') t.direction = 'sendrecv';
    const vs = videoSender(p.pc);
    const out = outgoingVideo();
    if (vs && out && vs.track !== out) await vs.replaceTrack(out).catch(() => undefined);
    await flush(p);
    const ans = await p.pc.createAnswer();
    await p.pc.setLocalDescription(ans);
    await send(d.from, { type: 'answer', callId: msg.callId, sdp: ans.sdp! });
  } else if (msg.type === 'answer') {
    const p = existing;
    if (!p?.offerer || p.pc.signalingState !== 'have-local-offer') return;
    if (p.remoteSid && p.remoteSid !== msg.sid) return;
    p.remoteSid = msg.sid;
    await p.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    await flush(p);
  } else if (msg.type === 'ice') {
    const p = existing;
    if (!p || (p.remoteSid && p.remoteSid !== msg.sid)) return;
    if (p.pc.remoteDescription) await p.pc.addIceCandidate(msg.candidate).catch(() => undefined);
    else p.pendingIce.push(msg.candidate);
  }
}

async function flush(p: Peer) {
  const list = p.pendingIce;
  p.pendingIce = [];
  for (const c of list) await p.pc.addIceCandidate(c).catch(() => undefined);
}

onSocket((sock) => {
  sock.on('gcall:signal', (d) => onSignal(d).catch(() => undefined));
  sock.on('gcall:state', (r: RoomInfo) => onRoomState(r));
  sock.on('gcall:replaced', ({ chatId }: { chatId: string }) => {
    if (get().chatId === chatId && get().phase !== 'idle') {
      toast(tr('你已在另一台设备上加入了这个群通话'));
      teardown();
    }
  });
  // reconnected: the server has forgotten this socket — rejoin the call I'm in
  sock.on('connect', () => {
    const s = get();
    if (s.phase === 'in' && s.chatId)
      sock.emit('gcall:join', { chatId: s.chatId, video: s.video }, (x: { callId?: string; others?: string[] } | undefined) => {
        if (x?.callId !== get().callId) {
          if (x?.callId) sock.emit('gcall:leave', { chatId: s.chatId });
          toast(tr('群通话已结束'));
          return teardown();
        }
        // same call: everyone dropped me when my connection blinked — reconnect to all of them as a newcomer
        mySid = C.randomId();
        for (const uid of [...peers.keys()]) closePeer(uid);
        for (const uid of x.others ?? []) offerTo(uid).catch(() => undefined);
      });
  });
});

function onRoomState(r: RoomInfo) {
  const rooms = { ...get().rooms };
  if (r.callId) rooms[r.chatId] = r;
  else delete rooms[r.chatId];
  set({ rooms });
  const s = get();
  if (s.phase !== 'in' || s.chatId !== r.chatId) return;
  if (!r.callId || r.callId !== s.callId) return teardown(); // the call is gone on the server (e.g. it restarted)
  maxPeople = Math.max(maxPeople, r.participants.length);
  for (const uid of [...peers.keys()]) if (!r.participants.includes(uid)) closePeer(uid);
}

// ------------------------------------------------------------------ peers
async function iceServers() {
  if (!iceConfig) iceConfig = await api.get('/api/calls/ice').catch(() => ({ iceServers: [], relay: false }));
  return iceConfig!;
}

/** One connection per person, even when two signals race to create it. */
function getPeer(uid: string, offerer: boolean): Promise<Peer | null> {
  const p = peers.get(uid);
  if (p) return Promise.resolve(p);
  let c = creating.get(uid);
  if (!c) {
    c = makePeer(uid, offerer).finally(() => creating.delete(uid));
    creating.set(uid, c);
  }
  return c;
}

async function makePeer(uid: string, offerer: boolean): Promise<Peer | null> {
  const ice = await iceServers();
  const s = get();
  if (s.phase !== 'in' || !s.local) return null;
  const pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: prefs().callRelayOnly && ice.relay ? 'relay' : 'all', bundlePolicy: 'max-bundle' });
  const stream = new MediaStream();
  const p: Peer = { pc, offerer, stream, pendingIce: [], restarts: 0, timer: null, remoteSid: null };
  peers.set(uid, p);
  for (const t of s.local.getAudioTracks()) pc.addTrack(t, s.local);
  // always one video slot, so a screen can be shared later without renegotiating (also in voice calls)
  const out = outgoingVideo();
  if (out) capBitrate(pc.addTrack(out, s.local));
  else if (offerer) pc.addTransceiver('video', { direction: 'sendrecv' });
  pc.ontrack = (e) => {
    if (peers.get(uid) !== p) return;
    stream.addTrack(e.track);
    e.track.onunmute = () => view(uid);
    e.track.onmute = () => view(uid);
    view(uid);
    watchLevel(uid, stream);
  };
  pc.onicecandidate = (e) => {
    if (e.candidate && peers.get(uid) === p) send(uid, { type: 'ice', callId: get().callId!, candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (peers.get(uid) !== p) return;
    view(uid);
    const st = pc.connectionState;
    if (st === 'connected') {
      p.restarts = 0;
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
    } else if (st === 'disconnected') {
      // brief network hiccup (Wi-Fi ↔ mobile): give it a few seconds, then restart ICE
      if (!p.timer) p.timer = setTimeout(() => ((p.timer = null), restart(uid)), 5000);
    } else if (st === 'failed') restart(uid);
  };
  view(uid);
  return p;
}

function outgoingVideo(): MediaStreamTrack | null {
  return screenTrack ?? get().local?.getVideoTracks()[0] ?? null;
}
function videoSender(pc: RTCPeerConnection) {
  return pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender ?? null;
}

/** Share my screen with everyone in the call (again = stop). */
let picking = false;
export async function toggleGroupScreenShare() {
  const s = get();
  if (s.phase !== 'in' || picking) return;
  if (s.sharing) return stopSharing();
  const callId = s.callId;
  if (!navigator.mediaDevices?.getDisplayMedia) return toast(tr('此浏览器不支持屏幕共享'));
  let track: MediaStreamTrack | undefined;
  picking = true;
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false });
    track = display.getVideoTracks()[0];
  } catch {
    return; // cancelled
  } finally {
    picking = false;
  }
  // the call may have ended (or another one started) while the picker was open
  if (!track || get().phase !== 'in' || get().callId !== callId) return track?.stop();
  screenTrack?.stop();
  screenTrack = track;
  track.contentHint = 'detail';
  track.onended = () => {
    if (screenTrack === track) stopSharing();
  };
  for (const p of peers.values()) await videoSender(p.pc)?.replaceTrack(track).catch(() => undefined);
  set({ sharing: true });
}
async function stopSharing() {
  const t = screenTrack;
  screenTrack = null;
  t?.stop();
  const cam = get().local?.getVideoTracks()[0] ?? null;
  for (const p of peers.values()) await videoSender(p.pc)?.replaceTrack(cam).catch(() => undefined);
  set({ sharing: false });
}
export const groupScreenTrack = () => screenTrack;

/** 360p video at ~500 kbit/s per connection keeps a 6-person mesh usable on a phone. */
function capBitrate(sender: RTCRtpSender) {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 500_000;
    sender.setParameters(params).catch(() => undefined);
  } catch {
    /* not supported */
  }
}

async function offerTo(uid: string, restartIce = false) {
  const p = await getPeer(uid, true);
  if (!p || !p.offerer) return;
  const offer = await p.pc.createOffer(restartIce ? { iceRestart: true } : undefined);
  await p.pc.setLocalDescription(offer);
  await send(uid, { type: 'offer', callId: get().callId!, sdp: offer.sdp! });
  // no answer (e.g. the signal got lost): try again, a few times
  setTimeout(() => {
    if (peers.get(uid) === p && p.pc.signalingState === 'have-local-offer' && ++p.restarts <= 3) offerTo(uid, true).catch(() => undefined);
  }, 12_000);
}

function restart(uid: string) {
  const p = peers.get(uid);
  if (!p || get().phase !== 'in') return;
  if (!p.offerer) return; // the side that offered restarts; we just answer
  if (++p.restarts > 3) return view(uid);
  offerTo(uid, true).catch(() => undefined);
}

function closePeer(uid: string) {
  const p = peers.get(uid);
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  peers.delete(uid);
  try {
    p.pc.close();
  } catch {
    /* ignore */
  }
  stopLevel(uid);
  const pv = { ...get().peers };
  delete pv[uid];
  const sp = { ...get().speaking };
  delete sp[uid];
  set({ peers: pv, speaking: sp });
}

function view(uid: string) {
  const p = peers.get(uid);
  if (!p) return;
  const hasVideo = p.stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
  set({ peers: { ...get().peers, [uid]: { stream: p.stream, state: p.pc.connectionState, hasVideo } } });
}

// ------------------------------------------------------------------ who is speaking (local analysis only)
let audioCtx: AudioContext | null = null;
const meters = new Map<string, { src: MediaStreamAudioSourceNode; an: AnalyserNode }>();
let meterTimer: ReturnType<typeof setInterval> | null = null;
function watchLevel(uid: string, stream: MediaStream) {
  if (!stream.getAudioTracks().length || meters.has(uid)) return;
  try {
    audioCtx ??= new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    meters.set(uid, { src, an });
  } catch {
    return;
  }
  meterTimer ??= setInterval(() => {
    const buf = new Uint8Array(256);
    const speaking: Record<string, boolean> = {};
    for (const [id, m] of meters) {
      m.an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += (v - 128) * (v - 128);
      speaking[id] = Math.sqrt(sum / buf.length) > 6;
    }
    const me = useStore.getState().me?.id;
    if (me && get().muted) speaking[me] = false;
    set({ speaking });
  }, 250);
}
function stopLevel(uid: string) {
  const m = meters.get(uid);
  if (!m) return;
  try {
    m.src.disconnect();
  } catch {
    /* ignore */
  }
  meters.delete(uid);
}

// ------------------------------------------------------------------ public actions
export async function joinGroupCall(chatId: string, wantVideo: boolean) {
  if (get().phase !== 'idle') return toast(tr('已经在通话中'));
  if (useCall.getState().phase !== 'idle') return toast(tr('已经在通话中'));
  const st = useStore.getState();
  const chat = st.chats[chatId];
  const sock = getSocket();
  if (!chat || chat.type !== 'group' || !st.me) return;
  if (chat.integrity === 'mismatch') return toast(tr('成员列表未通过签名校验，不能发起通话'));
  if (!sock || !st.connected) return toast(tr('未连接到服务器'));
  set({ ...IDLE, phase: 'joining', chatId, rooms: get().rooms });
  early = [];
  mySid = C.randomId();
  // microphone / camera first (the permission prompt can take a while), then join — so nobody waits on me
  const video = get().rooms[chatId]?.video ?? wantVideo;
  let local: MediaStream | null = null;
  try {
    try {
      local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: video ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 24 } } : false,
      });
    } catch {
      throw new Error(video ? tr('无法使用摄像头或麦克风（请检查浏览器权限）') : tr('无法使用麦克风（请检查浏览器权限）'));
    }
    if (get().chatId !== chatId || get().phase !== 'joining') return local.getTracks().forEach((t) => t.stop());
    const r = await new Promise<{ error?: string; max?: number; callId: string; video: boolean; startedAt: number; others: string[] }>((res, rej) => {
      const t = setTimeout(() => rej(new Error(tr('服务器没有响应'))), 10_000);
      sock.emit('gcall:join', { chatId, video }, (x: never) => (clearTimeout(t), res(x)));
    });
    if (r.error === 'full') throw new Error(tr('通话人数已满（最多 {v0} 人）', { v0: r.max ?? MAX_AUDIO }));
    if (r.error) throw new Error(tr('无法加入通话'));
    if (get().chatId !== chatId || get().phase !== 'joining') {
      local.getTracks().forEach((t) => t.stop());
      return sock.emit('gcall:leave', { chatId });
    }
    // the room turned out to be voice-only: don't send the camera
    if (!r.video) local.getVideoTracks().forEach((t) => (t.stop(), local!.removeTrack(t)));
    maxPeople = r.others.length + 1;
    set({ phase: 'in', callId: r.callId, video: r.video, local, startedAt: r.startedAt });
    watchLevel(st.me.id, local);
    const held = early;
    early = [];
    for (const d of held) onSignal(d).catch(() => undefined);
    // I'm the newcomer: I call everyone who is already there
    const members = new Set(chat.members.map((m) => m.id));
    for (const uid of r.others) if (members.has(uid)) offerTo(uid).catch(() => undefined);
  } catch (e) {
    local?.getTracks().forEach((t) => t.stop());
    teardown(false);
    toast((e as Error).message);
  }
}

export function leaveGroupCall() {
  const s = get();
  if (s.phase === 'idle') return;
  if (s.chatId) getSocket()?.emit('gcall:leave', { chatId: s.chatId });
  // the last one out leaves a record of the call in the group (encrypted like any message)
  const room = s.chatId ? get().rooms[s.chatId] : undefined;
  const me = useStore.getState().me?.id;
  if (s.phase === 'in' && s.chatId && s.startedAt && room && me && room.participants.every((u) => u === me) && maxPeople > 1)
    postCallLog(s.chatId, { t: 'call', video: s.video, duration: Math.max(0, Math.round((Date.now() - s.startedAt) / 1000)), outcome: 'answered', group: maxPeople }).catch(() => undefined);
  teardown();
}

function teardown(_log = true) {
  early = [];
  screenTrack?.stop();
  screenTrack = null;
  maxPeople = 1;
  for (const uid of [...peers.keys()]) closePeer(uid);
  const s = get();
  s.local?.getTracks().forEach((t) => t.stop());
  for (const uid of [...meters.keys()]) stopLevel(uid);
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = null;
  audioCtx?.close().catch(() => undefined);
  audioCtx = null;
  iceConfig = null;
  set({ ...IDLE, rooms: get().rooms });
}

export function toggleGroupMute() {
  const muted = !get().muted;
  get().local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  set({ muted });
}
export function toggleGroupCamera() {
  const camOff = !get().camOff;
  get().local?.getVideoTracks().forEach((t) => (t.enabled = !camOff));
  set({ camOff });
}

window.addEventListener('beforeunload', () => {
  if (get().phase !== 'idle') leaveGroupCall();
});
