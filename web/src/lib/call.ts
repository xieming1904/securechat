/**
 * 1:1 audio/video calls over WebRTC.
 *
 * - Media: DTLS-SRTP, end-to-end between the two browsers. A TURN relay (coturn), if used, only forwards encrypted packets.
 * - Signalling (offer/answer/ICE) goes through our server over Socket.IO, but every message is encrypted with the
 *   chat key and signed with the sender's identity key. The SDP carries the DTLS certificate fingerprints, so the
 *   server can neither read the signalling nor swap in its own keys (no man-in-the-middle) without the signature failing.
 */
import { create } from 'zustand';
import * as C from '../crypto/core';
import { api } from './api';
import { prefs } from './prefs';
import { chatKeyAt, currentChatKey, getSocket, getUserKeys, myIdentity, postCallLog, setCallSignalHandler, toast, useStore, type CallSignal } from './store';
import { tr } from './i18n';
import { useGroupCall } from './groupcall';

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active';

interface CallState {
  phase: CallPhase;
  callId: string | null;
  chatId: string | null;
  peerId: string | null;
  video: boolean;
  muted: boolean;
  camOff: boolean;
  local: MediaStream | null;
  remote: MediaStream | null;
  startedAt: number | null;
  relayed: boolean;
  note: string;
  /** sharing my screen instead of the camera */
  sharing: boolean;
  /** more than one camera available (phones: front/back) */
  canFlip: boolean;
  /** connection quality from WebRTC stats (round-trip time + packet loss) */
  quality: 'good' | 'ok' | 'poor' | null;
  /** the connection dropped and is being re-established (network change) */
  reconnecting: boolean;
  /** v0.9: a call inside a secret chat (signalling key delivered through the double ratchet) */
  secretChatId: string | null;
}

const IDLE: CallState = {
  phase: 'idle',
  callId: null,
  chatId: null,
  peerId: null,
  video: false,
  muted: false,
  camOff: false,
  local: null,
  remote: null,
  startedAt: null,
  relayed: false,
  note: '',
  sharing: false,
  canFlip: false,
  quality: null,
  reconnecting: false,
  secretChatId: null,
};

export const useCall = create<CallState>(() => ({ ...IDLE }));
const set = useCall.setState;
const get = useCall.getState;

type Sig =
  | { type: 'offer'; callId: string; sdp: string; video: boolean }
  | { type: 'reoffer'; callId: string; sdp: string }
  | { type: 'answer'; callId: string; sdp: string }
  | { type: 'ice'; callId: string; candidate: RTCIceCandidateInit }
  | { type: 'hangup' | 'reject' | 'busy' | 'handled'; callId: string };

const RING_TIMEOUT = 45_000;
let pc: RTCPeerConnection | null = null;
let role: 'caller' | 'callee' | null = null;
let pendingIce: RTCIceCandidateInit[] = [];
let incomingOffer: string | null = null;
let ringTimer: ReturnType<typeof setTimeout> | null = null;
let outcome: C.CallPayload['outcome'] = 'cancelled';
let ringer: { stop: () => void } | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let facing: 'user' | 'environment' = 'user';
let cameraTrack: MediaStreamTrack | null = null;
/** call ids already seen: a replayed offer (e.g. re-sent by the server) must not ring again */
const seenCalls = new Map<string, number>();
const CONNECT_TIMEOUT = 30_000;
const alive = (id: string | null) => !!id && get().callId === id;

// ------------------------------------------------------------------ secret-chat calls (v0.9)
/**
 * In a secret chat the offer travels inside the double ratchet together with a fresh random signalling key for this
 * call; answer / ICE / hang-up then use that key over the normal relay (the pair's direct chat), with epoch 0.
 * Other devices of both people get the relayed signals too but can't decrypt them, so only the two bound devices ring.
 */
const secretKeys = new Map<string, { key: Uint8Array; secretChatId: string; at: number }>();
interface SecretHooks {
  invite(secretChatId: string, call: { callId: string; key: string; video: boolean; sdp: string }): Promise<void>;
  log(secretChatId: string, p: C.CallPayload, mine: boolean): void;
}
let secretHooks: SecretHooks | null = null;
export function setSecretCallHooks(h: SecretHooks) {
  secretHooks = h;
}

// ------------------------------------------------------------------ signalling
async function send(to: string, data: Sig, hint: { ring?: boolean; end?: boolean } = {}) {
  const s = get();
  const me = useStore.getState().me;
  const id = myIdentity();
  const sock = getSocket();
  if (!s.chatId || !me || !id || !sock) return;
  if (s.secretChatId) {
    const sk = s.callId ? secretKeys.get(s.callId) : undefined;
    if (!sk) return;
    const env = C.encryptSignal(data, sk.key, { chatId: s.chatId, from: me.id, to, epoch: 0 }, id);
    sock.emit('call:signal', { chatId: s.chatId, to, env }); // no ring/end hints: nothing is pushed for secret calls
    return;
  }
  const { key, epoch } = await currentChatKey(s.chatId);
  const env = C.encryptSignal(data, key, { chatId: s.chatId, from: me.id, to, epoch }, id);
  // ring/end are plaintext hints so the server can push "incoming call" to an offline phone; the payload stays sealed
  sock.emit('call:signal', { chatId: s.chatId, to, env, ...hint });
}
const toPeer = (d: Sig, hint?: { ring?: boolean; end?: boolean }) => {
  const p = get().peerId;
  return p ? send(p, d, hint) : Promise.resolve();
};
const toMyOtherDevices = (d: Sig) => {
  const me = useStore.getState().me;
  if (get().secretChatId) return Promise.resolve(); // my other devices never rang
  return me ? send(me.id, d) : Promise.resolve();
};

async function onSignal(d: CallSignal) {
  const me = useStore.getState().me;
  if (!me) return;
  let msg: Sig | null = null;
  try {
    if (d.env.epoch === 0) {
      // a secret-chat call: only a device that got the key through the ratchet can read it
      const signPk = (await getUserKeys(d.from)).signPk;
      for (const sk of secretKeys.values()) {
        try {
          msg = C.decryptSignal<Sig>(d.env, sk.key, { chatId: d.chatId, from: d.from, to: me.id }, signPk);
          break;
        } catch {
          /* not this call's key */
        }
      }
      if (!msg || msg.type === 'offer' || !secretKeys.has(msg.callId)) return;
    } else {
      const key = await chatKeyAt(d.chatId, d.env.epoch);
      if (!key) return;
      msg = C.decryptSignal<Sig>(d.env, key, { chatId: d.chatId, from: d.from, to: me.id }, (await getUserKeys(d.from)).signPk);
    }
  } catch {
    return; // forged, replayed or undecryptable — ignore
  }
  if (!msg) return;
  const s = get();
  if (d.from === me.id) {
    // handled on another of my devices: stop ringing here
    if (msg.type === 'handled' && s.phase === 'incoming' && s.callId === msg.callId) cleanup();
    return;
  }
  if (msg.type === 'offer') {
    const chat = useStore.getState().chats[d.chatId];
    if (!chat || chat.type !== 'direct') return;
    for (const [k, at] of seenCalls) if (Date.now() - at > 10 * 60_000) seenCalls.delete(k);
    if (seenCalls.has(msg.callId)) return;
    seenCalls.set(msg.callId, Date.now());
    if (s.phase !== 'idle' || useGroupCall.getState().phase !== 'idle') {
      // already in a call: tell the caller we're busy (sent directly, the current call state stays)
      const sock = getSocket();
      const id = myIdentity();
      const { key, epoch } = await currentChatKey(d.chatId);
      if (sock && id) sock.emit('call:signal', { chatId: d.chatId, to: d.from, env: C.encryptSignal({ type: 'busy', callId: msg.callId }, key, { chatId: d.chatId, from: me.id, to: d.from, epoch }, id) });
      return;
    }
    role = 'callee';
    incomingOffer = msg.sdp;
    pendingIce = [];
    set({ ...IDLE, phase: 'incoming', callId: msg.callId, chatId: d.chatId, peerId: d.from, video: msg.video });
    ringer = ring('in');
    ringTimer = setTimeout(() => cleanup(), RING_TIMEOUT + 5000);
    notifyIncoming(d.chatId, msg.video);
    return;
  }
  if (s.callId !== msg.callId || d.from !== s.peerId) return;
  switch (msg.type) {
    case 'answer':
      if (role !== 'caller' || !pc || pc.signalingState !== 'have-local-offer') return;
      if (s.phase === 'outgoing') {
        clearRing();
        set({ phase: 'connecting' });
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        await flushIce();
        armConnectTimeout(msg.callId);
      } else await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); // answer to an ICE restart
      break;
    case 'reoffer':
      // the caller restarts ICE after a network change: answer on the same connection
      if (role !== 'callee' || !pc) return;
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await toPeer({ type: 'answer', callId: msg.callId, sdp: pc.localDescription!.sdp });
      break;
    case 'ice':
      if (pc?.remoteDescription) await pc.addIceCandidate(msg.candidate).catch(() => undefined);
      else pendingIce.push(msg.candidate);
      break;
    case 'reject':
      outcome = 'rejected';
      toast(tr('对方拒绝了通话'));
      end();
      break;
    case 'busy':
      outcome = 'missed';
      toast(tr('对方正在通话中'));
      end();
      break;
    case 'hangup':
      if (s.phase === 'incoming') outcome = 'missed';
      end();
      break;
  }
}
setCallSignalHandler(onSignal);

async function flushIce() {
  const list = pendingIce;
  pendingIce = [];
  for (const c of list) await pc?.addIceCandidate(c).catch(() => undefined);
}

// ------------------------------------------------------------------ peer connection
async function makePc(callId: string) {
  const ice = await api.get('/api/calls/ice').catch(() => ({ iceServers: [], relay: false }));
  if (!alive(callId)) return null;
  const relayOnly = prefs().callRelayOnly && ice.relay;
  const conn = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all', bundlePolicy: 'max-bundle' });
  if (!ice.iceServers.length) set({ note: tr('服务器未配置 TURN 中转，不在同一网络时可能无法接通') });
  const remote = new MediaStream();
  set({ remote, relayed: relayOnly });
  conn.ontrack = (e) => {
    if (conn !== pc) return;
    remote.addTrack(e.track);
    set({ remote });
  };
  conn.onicecandidate = (e) => {
    if (e.candidate && conn === pc) toPeer({ type: 'ice', callId, candidate: e.candidate.toJSON() });
  };
  conn.onconnectionstatechange = () => {
    if (conn !== pc) return;
    const st = conn.connectionState;
    if (st === 'connected') {
      clearReconnect();
      if (get().phase !== 'active') {
        clearRing();
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        set({ phase: 'active', startedAt: get().startedAt ?? Date.now(), note: '' });
        outcome = 'answered';
        startStats(callId);
      }
      return;
    }
    if (get().phase !== 'active') {
      if (st === 'failed') {
        outcome = 'failed';
        toast(tr('通话连接失败'));
        toPeer({ type: 'hangup', callId });
        end();
      }
      return;
    }
    // an active call lost its path (Wi-Fi ↔ mobile data, sleep): try to re-establish it instead of hanging up
    if (st === 'disconnected' || st === 'failed') beginReconnect(callId, st === 'failed');
  };
  return conn;
}

// ------------------------------------------------------------------ reconnect (ICE restart) + quality
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
const RECONNECT_GIVE_UP = 25_000;

function clearReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (giveUpTimer) clearTimeout(giveUpTimer);
  reconnectTimer = giveUpTimer = null;
  if (get().reconnecting) set({ reconnecting: false });
}

function beginReconnect(callId: string, failed: boolean) {
  if (!get().reconnecting) set({ reconnecting: true, quality: 'poor' });
  giveUpTimer ??= setTimeout(() => {
    if (!alive(callId)) return;
    toast(tr('网络中断，通话已结束'));
    toPeer({ type: 'hangup', callId });
    end();
  }, RECONNECT_GIVE_UP);
  // the caller drives the ICE restart (right away when failed, after a short grace period when merely disconnected)
  if (role !== 'caller') return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(
    async () => {
      reconnectTimer = null;
      if (!alive(callId) || !pc || pc.connectionState === 'connected') return;
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        await toPeer({ type: 'reoffer', callId, sdp: offer.sdp! });
      } catch {
        /* next state change retries */
      }
    },
    failed ? 0 : 4000,
  );
}

let lastLoss = { lost: 0, recv: 0 };
function startStats(callId: string) {
  if (statsTimer) clearInterval(statsTimer);
  lastLoss = { lost: 0, recv: 0 };
  statsTimer = setInterval(async () => {
    if (!alive(callId) || !pc) {
      if (statsTimer) clearInterval(statsTimer);
      statsTimer = null;
      return;
    }
    if (get().reconnecting) return;
    try {
      const report = await pc.getStats();
      let rtt: number | null = null;
      let lost = 0;
      let recv = 0;
      report.forEach((r) => {
        if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded' && typeof r.currentRoundTripTime === 'number') rtt = r.currentRoundTripTime;
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          lost += r.packetsLost ?? 0;
          recv += r.packetsReceived ?? 0;
        }
      });
      const dl = lost - lastLoss.lost;
      const dr = recv - lastLoss.recv;
      lastLoss = { lost, recv };
      const loss = dl + dr > 0 ? dl / (dl + dr) : 0;
      const r = rtt ?? 0;
      set({ quality: r < 0.3 && loss < 0.03 ? 'good' : r < 0.6 && loss < 0.08 ? 'ok' : 'poor' });
    } catch {
      /* ignore */
    }
  }, 2000);
}

/** Give up if the media connection is not up within CONNECT_TIMEOUT after the answer. */
function armConnectTimeout(callId: string) {
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (alive(callId) && get().phase === 'connecting') {
      outcome = 'failed';
      toast(tr('通话连接超时'));
      toPeer({ type: 'hangup', callId });
      end();
    }
  }, CONNECT_TIMEOUT);
}

/** Stop a stream / connection that belongs to a call that has already ended meanwhile. */
function discard(local?: MediaStream | null, conn?: RTCPeerConnection | null) {
  local?.getTracks().forEach((tr_) => tr_.stop());
  try {
    conn?.close();
  } catch {
    /* ignore */
  }
}

async function getMedia(video: boolean) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error(tr('此浏览器不支持通话（需要 HTTPS 和较新的浏览器）'));
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: facing } : false,
    });
  } catch {
    throw new Error(video ? tr('无法使用摄像头或麦克风（请检查浏览器权限）') : tr('无法使用麦克风（请检查浏览器权限）'));
  }
}

// ------------------------------------------------------------------ public actions
export async function startCall(chatId: string, video: boolean) {
  if (get().phase !== 'idle' || useGroupCall.getState().phase !== 'idle') return toast(tr('已经在通话中'));
  const st = useStore.getState();
  const chat = st.chats[chatId];
  const me = st.me;
  if (!chat || chat.type !== 'direct' || !me) return;
  const peer = chat.members.find((m) => m.id !== me.id);
  if (!peer) return;
  if (st.keyWarnings[peer.id]) return toast(tr('{v0} 的安全码已变更，请先核对后再通话', { v0: peer.displayName }));
  if (chat.integrity === 'mismatch') return toast(tr('成员列表未通过签名校验，不能发起通话'));
  if (!st.connected) return toast(tr('未连接到服务器'));
  const callId = C.randomId();
  role = 'caller';
  outcome = 'cancelled';
  pendingIce = [];
  set({ ...IDLE, phase: 'outgoing', callId, chatId, peerId: peer.id, video });
  try {
    const local = await getMedia(video);
    if (!alive(callId)) return discard(local);
    set({ local });
    afterMedia(local);
    const conn = await makePc(callId);
    if (!alive(callId) || !conn) return discard(null, conn);
    pc = conn;
    local.getTracks().forEach((t) => conn.addTrack(t, local));
    const offer = await conn.createOffer();
    await conn.setLocalDescription(offer);
    if (!alive(callId)) return;
    await toPeer({ type: 'offer', callId, sdp: offer.sdp!, video }, { ring: true });
    if (!alive(callId)) return;
    ringer = ring('out');
    ringTimer = setTimeout(() => {
      if (get().phase === 'outgoing') {
        outcome = 'missed';
        toast(tr('对方无应答'));
        toPeer({ type: 'hangup', callId }, { end: true });
        end();
      }
    }, RING_TIMEOUT);
  } catch (e) {
    if (!alive(callId)) return;
    toast((e as Error).message);
    outcome = 'failed';
    end(false);
  }
}

/** Call the bound device of a secret chat. `directChatId` is the pair's normal chat (used only as the relay route). */
export async function startSecretCall(secretChatId: string, directChatId: string, peerId: string, video: boolean) {
  if (get().phase !== 'idle' || useGroupCall.getState().phase !== 'idle') return toast(tr('已经在通话中'));
  if (!secretHooks) return;
  if (!useStore.getState().connected) return toast(tr('未连接到服务器'));
  const callId = C.randomId();
  const key = crypto.getRandomValues(new Uint8Array(32));
  secretKeys.set(callId, { key, secretChatId, at: Date.now() });
  role = 'caller';
  outcome = 'cancelled';
  pendingIce = [];
  set({ ...IDLE, phase: 'outgoing', callId, chatId: directChatId, peerId, video, secretChatId });
  try {
    const local = await getMedia(video);
    if (!alive(callId)) return discard(local);
    set({ local });
    afterMedia(local);
    const conn = await makePc(callId);
    if (!alive(callId) || !conn) return discard(null, conn);
    pc = conn;
    local.getTracks().forEach((t) => conn.addTrack(t, local));
    const offer = await conn.createOffer();
    await conn.setLocalDescription(offer);
    if (!alive(callId)) return;
    await secretHooks.invite(secretChatId, { callId, key: C.b64(key), video, sdp: offer.sdp! });
    if (!alive(callId)) return;
    ringer = ring('out');
    ringTimer = setTimeout(() => {
      if (get().phase === 'outgoing') {
        outcome = 'missed';
        toast(tr('对方无应答'));
        toPeer({ type: 'hangup', callId });
        end();
      }
    }, RING_TIMEOUT);
  } catch (e) {
    if (!alive(callId)) return;
    toast((e as Error).message);
    outcome = 'failed';
    end(false);
  }
}

/** An offer that arrived through the ratchet of a secret chat. */
export async function receiveSecretCall(secretChatId: string, directChatId: string, peerId: string, c: { callId: string; key: string; video: boolean; sdp: string }) {
  const me = useStore.getState().me;
  if (!me || typeof c?.callId !== 'string' || typeof c.sdp !== 'string' || typeof c.key !== 'string') return;
  for (const [k, v] of secretKeys) if (Date.now() - v.at > 10 * 60_000 && get().callId !== k) secretKeys.delete(k);
  for (const [k, at] of seenCalls) if (Date.now() - at > 10 * 60_000) seenCalls.delete(k);
  if (seenCalls.has(c.callId)) return;
  seenCalls.set(c.callId, Date.now());
  const key = C.unb64(c.key);
  if (key.length !== 32) return;
  if (get().phase !== 'idle' || useGroupCall.getState().phase !== 'idle') {
    // busy: answer once with the call's key, and don't keep it
    const sock = getSocket();
    const id = myIdentity();
    if (sock && id) sock.emit('call:signal', { chatId: directChatId, to: peerId, env: C.encryptSignal({ type: 'busy', callId: c.callId }, key, { chatId: directChatId, from: me.id, to: peerId, epoch: 0 }, id) });
    return;
  }
  secretKeys.set(c.callId, { key, secretChatId, at: Date.now() });
  role = 'callee';
  incomingOffer = c.sdp;
  pendingIce = [];
  set({ ...IDLE, phase: 'incoming', callId: c.callId, chatId: directChatId, peerId, video: !!c.video, secretChatId });
  ringer = ring('in');
  ringTimer = setTimeout(() => cleanup(), RING_TIMEOUT + 5000);
  notifyIncoming(directChatId, !!c.video);
}

export async function acceptCall() {
  const s = get();
  if (s.phase !== 'incoming' || !incomingOffer) return;
  clearRing();
  set({ phase: 'connecting' });
  toMyOtherDevices({ type: 'handled', callId: s.callId! });
  const callId = s.callId!;
  const offerSdp = incomingOffer;
  try {
    const local = await getMedia(s.video);
    // the caller may have hung up while the permission prompt was open
    if (!alive(callId)) return discard(local);
    set({ local });
    afterMedia(local);
    const conn = await makePc(callId);
    if (!alive(callId) || !conn) return discard(null, conn);
    pc = conn;
    local.getTracks().forEach((t) => conn.addTrack(t, local));
    await conn.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await flushIce();
    const answer = await conn.createAnswer();
    await conn.setLocalDescription(answer);
    if (!alive(callId)) return;
    await toPeer({ type: 'answer', callId, sdp: answer.sdp! });
    armConnectTimeout(callId);
  } catch (e) {
    if (!alive(callId)) return;
    toast((e as Error).message);
    toPeer({ type: 'hangup', callId });
    end();
  }
}

export function rejectCall() {
  const s = get();
  if (s.phase !== 'incoming') return;
  toPeer({ type: 'reject', callId: s.callId! });
  toMyOtherDevices({ type: 'handled', callId: s.callId! });
  cleanup();
}

export function hangup() {
  const s = get();
  if (s.phase === 'idle') return;
  if (s.phase === 'incoming') return rejectCall();
  toPeer({ type: 'hangup', callId: s.callId! }, { end: true });
  end();
}

let screenTrack: MediaStreamTrack | null = null;

function afterMedia(local: MediaStream) {
  cameraTrack = local.getVideoTracks()[0] ?? null;
  navigator.mediaDevices
    ?.enumerateDevices?.()
    .then((ds) => set({ canFlip: !!cameraTrack && ds.filter((d) => d.kind === 'videoinput').length > 1 }))
    .catch(() => undefined);
}

async function replaceVideo(track: MediaStreamTrack) {
  const sender = pc?.getSenders().find((x) => x.track?.kind === 'video');
  if (sender) await sender.replaceTrack(track);
  const local = get().local;
  if (local) {
    local.getVideoTracks().forEach((v) => local.removeTrack(v));
    local.addTrack(track);
    set({ local: new MediaStream(local.getTracks()) });
  }
}

/** Share my screen in a video call (the camera track is swapped out; the peer connection is not renegotiated). */
export async function toggleScreenShare() {
  const s = get();
  if (!s.video || !pc) return;
  if (s.sharing) {
    screenTrack?.stop();
    screenTrack = null;
    if (cameraTrack) await replaceVideo(cameraTrack);
    return set({ sharing: false });
  }
  if (!navigator.mediaDevices?.getDisplayMedia) return toast(tr('此浏览器不支持屏幕共享'));
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    const track = display.getVideoTracks()[0];
    if (!track || !alive(s.callId)) return display.getTracks().forEach((x) => x.stop());
    screenTrack = track;
    track.onended = () => {
      if (screenTrack === track) toggleScreenShare();
    };
    await replaceVideo(track);
    set({ sharing: true, camOff: false });
  } catch {
    /* cancelled */
  }
}

/** Switch between front and back camera (phones). */
export async function flipCamera() {
  const s = get();
  if (!s.video || s.sharing || !pc) return;
  const next = facing === 'user' ? 'environment' : 'user';
  try {
    const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { exact: next } } });
    const track = cam.getVideoTracks()[0];
    if (!alive(s.callId)) return track.stop();
    cameraTrack?.stop();
    cameraTrack = track;
    track.enabled = !s.camOff;
    facing = next;
    await replaceVideo(track);
  } catch {
    toast(tr('无法切换摄像头'));
  }
}

export function toggleMute() {
  const muted = !get().muted;
  get().local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  set({ muted });
}

export function toggleCamera() {
  const camOff = !get().camOff;
  get().local?.getVideoTracks().forEach((t) => (t.enabled = !camOff));
  if (cameraTrack) cameraTrack.enabled = !camOff;
  set({ camOff });
}

// ------------------------------------------------------------------ teardown
function clearRing() {
  if (ringTimer) clearTimeout(ringTimer);
  ringTimer = null;
  ringer?.stop();
  ringer = null;
}

function cleanup() {
  clearRing();
  clearReconnect();
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
  get().local?.getTracks().forEach((t) => t.stop());
  cameraTrack?.stop();
  cameraTrack = null;
  screenTrack?.stop();
  screenTrack = null;
  try {
    pc?.close();
  } catch {
    /* ignore */
  }
  pc = null;
  incomingOffer = null;
  pendingIce = [];
  role = null;
  const cid = get().callId;
  if (cid) secretKeys.delete(cid); // the per-call signalling key is gone with the call
  set({ ...IDLE });
}

/** End the call; the caller posts an encrypted call-log message into the chat. */
function end(log = true) {
  const s = get();
  const wasCaller = role === 'caller';
  const duration = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
  cleanup();
  if (s.secretChatId) {
    // secret chats keep their own (local) call log, on both sides
    if (log) secretHooks?.log(s.secretChatId, { t: 'call', video: s.video, duration, outcome: s.startedAt ? 'answered' : outcome }, wasCaller);
    return;
  }
  if (log && wasCaller && s.chatId) postCallLog(s.chatId, { t: 'call', video: s.video, duration, outcome: s.startedAt ? 'answered' : outcome }).catch(() => undefined);
}

window.addEventListener('beforeunload', () => {
  if (get().phase !== 'idle') hangup();
});

// ------------------------------------------------------------------ ringing + notification
function ring(kind: 'in' | 'out') {
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  try {
    ctx = new AudioContext();
    const beep = () => {
      if (!ctx) return;
      const tones = kind === 'in' ? [880, 660] : [440];
      tones.forEach((f, i) => {
        const o = ctx!.createOscillator();
        const g = ctx!.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, ctx!.currentTime + i * 0.25);
        g.gain.exponentialRampToValueAtTime(kind === 'in' ? 0.18 : 0.08, ctx!.currentTime + i * 0.25 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx!.currentTime + i * 0.25 + (kind === 'in' ? 0.22 : 0.9));
        o.connect(g).connect(ctx!.destination);
        o.start(ctx!.currentTime + i * 0.25);
        o.stop(ctx!.currentTime + i * 0.25 + 1);
      });
    };
    beep();
    timer = setInterval(beep, kind === 'in' ? 1500 : 3000);
  } catch {
    /* no audio */
  }
  return {
    stop() {
      if (timer) clearInterval(timer);
      ctx?.close().catch(() => undefined);
      ctx = null;
    },
  };
}

function notifyIncoming(chatId: string, video: boolean) {
  if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const title = useStore.getState().chats[chatId]?.title ?? tr('密聊');
  navigator.serviceWorker?.getRegistration('/').then((reg) => {
    const opts = { body: video ? tr('邀请你视频通话') : tr('邀请你语音通话'), tag: `call-${chatId}`, icon: '/icon-192.png', requireInteraction: true, data: { chatId } };
    if (reg) reg.showNotification(title, opts);
    else new Notification(title, opts);
  });
}
