/**
 * Secret chats (v0.8) — client side. Protocol: crypto/ratchet.ts (X3DH + Double Ratchet with header encryption).
 *
 *  - This browser (session) is one "device" with its own keys, certified by the account key.
 *  - A secret chat binds exactly two devices. The initiator sends an invitation to every device of the peer;
 *    the first one to come online accepts it, the others are told "taken".
 *  - Nothing is kept on the server: envelopes are deleted once this device has stored the result.
 *  - Everything local (device keys, ratchet states, messages) is sealed with this browser's non-exportable
 *    AES-GCM key and lives in IndexedDB; logging out wipes it.
 *  - Ratchet states must never fork: every read-modify-write runs under one Web Lock shared by all tabs,
 *    and other tabs are told to reload through a BroadcastChannel.
 */
import { create } from 'zustand';
import * as C from '../crypto/core';
import * as R from '../crypto/ratchet';
import { getWrapKey, idbDel, idbGet, idbKeys, idbSet } from '../crypto/keystore';
import { api, ApiError } from './api';
import { getUserKeys, myIdentity, onAppReady, onSocket, openChat, useStore } from './store';
import { clearFileCache, uploadBlob, type PreparedFile } from './files';
import { tr } from './i18n';
import { notifySecret } from './notify';
import { forgetResumeHandles } from './resume';
import { receiveSecretCall, setSecretCallHooks, startSecretCall } from './call';
import { callLabel } from '../components/MessageParts';

export type SecretStatus = 'waiting' | 'active' | 'elsewhere' | 'closed' | 'peer_gone';
export interface SecretChat {
  id: string;
  peerId: string;
  peerName: string;
  role: 'initiator' | 'responder';
  status: SecretStatus;
  /** the peer device this chat is bound to (once accepted) */
  peerDevice?: string;
  peerCert?: R.DeviceCert;
  /** seconds; 0 = messages don't disappear */
  ttl: number;
  createdAt: number;
  lastAt: number;
  lastText: string;
  unread: number;
  /** v0.9, this device only: I compared the safety number with them */
  verified?: boolean;
  pinned?: boolean;
  muted?: boolean;
}
export interface SecretMsg {
  id: string;
  mine: boolean;
  at: number;
  expiresAt: number | null;
  /** only text and file payloads are used here */
  p: C.Payload | { t: 'event'; text: string };
  status?: 'sending' | 'sent' | 'failed';
}

const DEFAULT_TTL = 86_400;
export const TTL_CHOICES = [0, 30, 300, 3600, 86_400, 604_800];
const SPK_ROTATE_MS = 7 * 86_400_000;
const SPK_KEEP_MS = 14 * 86_400_000;
const OPK_BATCH = 50;
const OPK_LOW = 20;

// ------------------------------------------------------------------ sealed local storage
interface DeviceRec {
  device: ReturnType<typeof R.serializeDevice>;
  cert: R.DeviceCert;
  spks: { id: number; pk: string; sk: string; sig: string; at: number }[];
  opks: Record<number, { pk: string; sk: string; at?: number }>;
  nextOpkId: number;
}
interface SessionRec {
  state: Record<string, unknown>;
  ad: string;
  cert: R.DeviceCert;
}
interface Db {
  device: DeviceRec | null;
  chats: Record<string, SecretChat>;
  /** chatId → peer deviceId → session (initiator keeps one per invited device until one accepts) */
  sessions: Record<string, Record<string, SessionRec>>;
  /** envelope ids already processed, and X3DH ephemeral keys already seen (replay protection) */
  seen: string[];
  seenEk: string[];
}
const emptyDb = (): Db => ({ device: null, chats: {}, sessions: {}, seen: [], seenEk: [] });

let uid = '';
let wrapKey: CryptoKey | null = null;
const k = (name: string) => `secret:${uid}:${name}`;

async function seal(obj: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey!, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv, ct };
}
async function unseal<T>(rec: { iv: Uint8Array; ct: ArrayBuffer } | undefined): Promise<T | null> {
  if (!rec || !wrapKey) return null;
  try {
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as Uint8Array<ArrayBuffer> }, wrapKey, rec.ct))) as T;
  } catch {
    return null;
  }
}
const loadDb = async () => (await unseal<Db>(await idbGet(k('db')))) ?? emptyDb();
const saveDb = async (db: Db) => idbSet(k('db'), await seal(db));
const loadMsgs = async (chatId: string) => (await unseal<SecretMsg[]>(await idbGet(k('m:' + chatId)))) ?? [];
const saveMsgs = async (chatId: string, list: SecretMsg[]) => idbSet(k('m:' + chatId), await seal(list));

/** Serialise all read-modify-write of the local state, across tabs (Web Locks) and inside this tab. */
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = () => (navigator.locks ? navigator.locks.request(`sc-secret-${uid}`, fn) : fn());
  const p = chain.then(run, run) as Promise<T>;
  chain = p.catch(() => undefined);
  return p;
}
let bc: BroadcastChannel | null = null;
const announce = () => bc?.postMessage('changed');

// ------------------------------------------------------------------ UI state
interface UiState {
  ready: boolean;
  chats: Record<string, SecretChat>;
  messages: Record<string, SecretMsg[]>;
  active: string | null;
  myCert: R.DeviceCert | null;
}
export const useSecret = create<UiState>(() => ({ ready: false, chats: {}, messages: {}, active: null, myCert: null }));
const setUi = useSecret.setState;

async function refreshUi(chatIds?: string[]) {
  const db = await loadDb();
  const messages = { ...useSecret.getState().messages };
  const now = Date.now();
  for (const id of chatIds ?? Object.keys(messages)) if (db.chats[id]) messages[id] = (await loadMsgs(id)).filter((m) => !m.expiresAt || m.expiresAt > now);
  setUi({ chats: db.chats, messages, myCert: db.device?.cert ?? null, ready: true });
}

// ------------------------------------------------------------------ device keys
function dev(db: Db) {
  return R.deserializeDevice(db.device!.device);
}
async function ensureDevice(): Promise<void> {
  const me = useStore.getState().me;
  const id = myIdentity();
  if (!me || !id) return;
  await locked(async () => {
    const db = await loadDb();
    const now = Date.now();
    let changed = false;
    if (!db.device || db.device.cert.userId !== me.id || !R.verifyCert(db.device.cert, id.signPk)) {
      const d = R.generateDeviceKeys();
      const spk = R.newSignedPrekey(d, 1, now);
      db.device = {
        device: R.serializeDevice(d),
        cert: R.certifyDevice(d, me.id, id.signSk),
        spks: [{ id: 1, pk: C.b64(spk.pk), sk: C.b64(spk.sk), sig: C.b64(spk.sig), at: now }],
        opks: {},
        nextOpkId: 1,
      };
      changed = true;
    }
    const rec = db.device;
    const cur = rec.spks[rec.spks.length - 1];
    if (now - cur.at > SPK_ROTATE_MS) {
      const spk = R.newSignedPrekey(dev(db), cur.id + 1, now);
      rec.spks.push({ id: spk.id, pk: C.b64(spk.pk), sk: C.b64(spk.sk), sig: C.b64(spk.sig), at: now });
      changed = true;
    }
    // old signed prekeys are kept a while for invitations still in flight, then deleted (forward secrecy)
    const keep = rec.spks.filter((s, i) => i === rec.spks.length - 1 || now - s.at < SPK_KEEP_MS);
    if (keep.length !== rec.spks.length) (rec.spks = keep), (changed = true);
    const spk = rec.spks[rec.spks.length - 1];
    if (changed) await saveDb(db);
    const bindAt = Date.now();
    const r = await api.put('/api/devices/me', { cert: rec.cert, spkId: spk.id, spkPk: spk.pk, spkSig: spk.sig, bindAt, bindSig: R.signDeviceBind(dev(db), me.id, bindAt) });
    // one-time prekeys the server handed out long ago but nobody used: their private halves can go
    const onServer = new Set<number>(((await api.get('/api/devices/me')).device?.opkIds ?? []) as number[]);
    let pruned = false;
    for (const [idStr, o] of Object.entries(rec.opks)) {
      const id = Number(idStr);
      if (!o.at) (o.at = now), (pruned = true);
      else if (!onServer.has(id) && now - o.at > 30 * 86_400_000) (delete rec.opks[id], (pruned = true));
    }
    if (pruned) await saveDb(db);
    if (r.opkCount < OPK_LOW) {
      const fresh = R.newOneTimePrekeys(rec.nextOpkId, OPK_BATCH);
      for (const o of fresh) rec.opks[o.id] = { pk: C.b64(o.pk), sk: C.b64(o.sk), at: now };
      rec.nextOpkId += OPK_BATCH;
      await saveDb(db); // private halves first, then publish
      await api.post('/api/devices/me/opks', { keys: fresh.map((o) => ({ id: o.id, pk: C.b64(o.pk) })) });
    }
    setUi({ myCert: rec.cert });
  });
}

/**
 * The peer's account key, but only if it is the one we pinned (trust on first use). If the server now reports a
 * different key, secret chats with that person stop until the safety number has been checked again.
 */
async function trustedSignPk(userId: string): Promise<Uint8Array> {
  const k = await getUserKeys(userId);
  if (useStore.getState().keyWarnings[userId]) throw new Error(tr('对方的安全码已变更。请先在对方的信息页核对安全码，再开始私密对话。'));
  return k.signPk;
}

// ------------------------------------------------------------------ envelopes
type Inner =
  | { t: 'hello'; chatId: string; ttl: number }
  | { t: 'accept' }
  | { t: 'taken' }
  | { t: 'msg'; id: string; at: number; ttl: number; p: C.Payload }
  | { t: 'ttl'; ttl: number }
  | { t: 'close' }
  | { t: 'call'; callId: string; key: string; video: boolean; sdp: string; at?: number };
type Envelope =
  | { v: 1; t: 'init'; chatId: string; cert: R.DeviceCert; ek: string; spkId: number; opkId?: number; msg: R.WireMessage }
  | { v: 1; t: 'm'; chatId: string; msg: R.WireMessage };

const enc = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
const dec = <T>(u: Uint8Array) => JSON.parse(new TextDecoder().decode(u)) as T;
const adFor = (x3dhAd: Uint8Array, chatId: string) => new Uint8Array([...x3dhAd, ...C.encodeFields('sc-secret-chat', [chatId])]);

/** Encrypt `inner` for a session and post it; saves the advanced ratchet state first. */
async function sendInner(db: Db, chatId: string, deviceId: string, inner: Inner) {
  const s = db.sessions[chatId]?.[deviceId];
  if (!s) throw new Error('no session');
  const r = R.ratchetEncrypt(R.deserializeState(s.state), enc(inner), C.unb64(s.ad));
  s.state = R.serializeState(r.state);
  await saveDb(db); // never reuse a message key, even if the post fails
  const env: Envelope = { v: 1, t: 'm', chatId, msg: r.msg };
  try {
    await api.post('/api/secret/send', { toDevice: deviceId, envelope: JSON.stringify(env) });
  } catch (e) {
    if (e instanceof ApiError && e.code === 'device_gone') await markPeerGone(db, chatId);
    throw e;
  }
}

/** The peer's device no longer exists (logged out, cleared its data, signed out remotely): this chat can't continue. */
async function markPeerGone(db: Db, chatId: string) {
  const chat = db.chats[chatId];
  if (!chat || chat.status !== 'active') return;
  chat.status = 'peer_gone';
  chat.lastText = tr('对方的设备已更换，需要重新发起');
  delete db.sessions[chatId];
  await saveDb(db);
  await addMsg(chatId, { id: 'ev_gone_' + Date.now(), mine: false, at: Date.now(), expiresAt: null, p: { t: 'event', text: tr('对方那台设备已经不在了（退出登录、清除了数据或换了设备）。可以重新发起私密对话。') } });
}

async function addMsg(chatId: string, m: SecretMsg, preview?: string, unread = false) {
  const list = await loadMsgs(chatId);
  if (list.some((x) => x.id === m.id)) return;
  list.push(m);
  await saveMsgs(chatId, list);
  return { list, preview, unread };
}

/** Process one envelope. Returns the chat ids whose view changed. */
async function handle(db: Db, e: { id: string; fromDevice: string; fromUser: string; envelope: string; createdAt: number }): Promise<string[]> {
  const env = JSON.parse(e.envelope) as Envelope;
  if (env?.v !== 1 || typeof env.chatId !== 'string' || !/^sc_[A-Za-z0-9_-]{16,40}$/.test(env.chatId)) throw new Error('bad envelope');
  const now = Date.now();
  const me = dev(db);
  const rec = db.device!;
  if (env.t === 'init') {
    // someone invites this device
    const peerSignPk = await trustedSignPk(e.fromUser);
    if (env.cert.userId !== e.fromUser || env.cert.deviceId !== e.fromDevice || !R.verifyCert(env.cert, peerSignPk)) throw new Error('bad certificate');
    if (db.chats[env.chatId]) throw new Error('duplicate invitation');
    if (db.seenEk.includes(env.ek)) throw new Error('replayed invitation');
    const spk = rec.spks.find((s) => s.id === env.spkId);
    if (!spk) throw new Error('unknown signed prekey');
    let opk: { sk: Uint8Array } | null = null;
    if (env.opkId !== undefined) {
      const o = rec.opks[env.opkId];
      if (!o) throw new Error('one-time prekey already used');
      opk = { sk: C.unb64(o.sk) };
    }
    const x = R.x3dhRespond(me, rec.cert, { sk: C.unb64(spk.sk) }, opk, env.cert, C.unb64(env.ek));
    const ad = adFor(x.ad, env.chatId);
    const st0 = R.initResponder(x, { pk: C.unb64(spk.pk), sk: C.unb64(spk.sk) });
    const r = R.ratchetDecrypt(st0, env.msg, ad, now);
    const hello = dec<Inner>(r.plaintext);
    if (hello.t !== 'hello' || hello.chatId !== env.chatId) throw new Error('bad hello');
    if (env.opkId !== undefined) delete rec.opks[env.opkId]; // one-time: gone for good
    db.seenEk = [...db.seenEk.slice(-500), env.ek];
    const peer = useStore.getState().chats;
    const name = Object.values(peer).flatMap((c) => c.members).find((m) => m.id === e.fromUser)?.displayName ?? tr('联系人');
    db.chats[env.chatId] = {
      id: env.chatId,
      peerId: e.fromUser,
      peerName: name,
      role: 'responder',
      status: 'active',
      peerDevice: e.fromDevice,
      peerCert: env.cert,
      ttl: TTL_CHOICES.includes(hello.ttl) ? hello.ttl : DEFAULT_TTL,
      createdAt: now,
      lastAt: now,
      lastText: tr('私密对话已建立'),
      unread: 1,
    };
    db.sessions[env.chatId] = { [e.fromDevice]: { state: R.serializeState(r.state), ad: C.b64(ad), cert: env.cert } };
    await saveDb(db);
    await addMsg(env.chatId, { id: 'ev_' + env.chatId, mine: false, at: now, expiresAt: null, p: { t: 'event', text: tr('{v0} 发起了私密对话', { v0: name }) } });
    await sendInner(db, env.chatId, e.fromDevice, { t: 'accept' }).catch(() => undefined);
    notifySecret(name);
    return [env.chatId];
  }
  // a message in an existing chat, from the bound device (or, before binding, from any invited device)
  const chat = db.chats[env.chatId];
  const sess = db.sessions[env.chatId]?.[e.fromDevice];
  if (!chat || !sess || chat.peerId !== e.fromUser) throw new Error('unknown chat');
  const r = R.ratchetDecrypt(R.deserializeState(sess.state), env.msg, C.unb64(sess.ad), now);
  sess.state = R.serializeState(r.state);
  const inner = dec<Inner>(r.plaintext);
  // the first authenticated message from an invited device counts as its acceptance (in case the accept was lost)
  const accepting = inner.t === 'accept' || (inner.t === 'msg' && chat.role === 'initiator' && chat.status === 'waiting');
  if (accepting && chat.role === 'initiator') {
    if (chat.peerDevice && chat.peerDevice !== e.fromDevice) {
      await sendInner(db, chat.id, e.fromDevice, { t: 'taken' }).catch(() => undefined);
      delete db.sessions[chat.id][e.fromDevice];
      await saveDb(db);
      return [chat.id];
    }
    if (chat.status === 'waiting') {
      chat.status = 'active';
      chat.peerDevice = e.fromDevice;
      chat.peerCert = sess.cert;
      chat.lastText = tr('对方已接受私密对话');
      chat.lastAt = now;
      // the sessions with the other invited devices stay until they answer (they are then told "taken")
      await addMsg(chat.id, { id: 'ev_acc_' + chat.id, mine: false, at: now, expiresAt: null, p: { t: 'event', text: tr('对方已接受，可以开始聊天') } });
      await saveDb(db);
    }
  }
  switch (inner.t) {
    case 'accept':
      break;
    case 'taken':
      if (chat.role === 'responder' && chat.peerDevice === e.fromDevice) {
        chat.status = 'elsewhere';
        chat.lastText = tr('已在你的另一台设备上接受');
        delete db.sessions[chat.id];
      }
      break;
    case 'msg': {
      if (e.fromDevice !== chat.peerDevice || chat.status !== 'active') break;
      if (inner.p.t !== 'text' && inner.p.t !== 'file') break;
      const valid = C.validatePayload(inner.p);
      if (!valid) break;
      const at = Math.min(now, Math.max(now - 10 * 60_000, Number(inner.at) || now)); // the sender's clock, within reason
      const ttl = TTL_CHOICES.includes(inner.ttl) ? inner.ttl : chat.ttl; // the sender's timer decides
      chat.lastAt = now;
      chat.lastText = summaryOf(valid);
      if (useSecret.getState().active !== chat.id || document.hidden) chat.unread += 1;
      // message first, then the advanced ratchet state: a crash in between re-delivers (deduplicated by id)
      await addMsg(chat.id, { id: String(inner.id).slice(0, 40), mine: false, at, expiresAt: ttl ? now + ttl * 1000 : null, p: valid });
      await saveDb(db);
      if (document.hidden && !chat.muted) notifySecret(chat.peerName);
      break;
    }
    case 'ttl':
      if (e.fromDevice !== chat.peerDevice || !TTL_CHOICES.includes(inner.ttl)) break;
      chat.ttl = inner.ttl;
      await saveDb(db);
      await addMsg(chat.id, { id: 'ev_ttl_' + now, mine: false, at: now, expiresAt: null, p: { t: 'event', text: ttlEvent(inner.ttl, chat.peerName) } });
      break;
    case 'call':
      if (e.fromDevice !== chat.peerDevice || chat.status !== 'active') break;
      {
        const direct = directChatOf(chat.peerId);
        // an offer that waited in the queue (the caller has long given up) must not ring
        const fresh = typeof inner.at === 'number' && Math.abs(Date.now() - inner.at) < 60_000;
        if (direct && fresh) receiveSecretCall(chat.id, direct, chat.peerId, inner);
      }
      break;
    case 'close':
      if (e.fromDevice !== chat.peerDevice) break;
      chat.status = 'closed';
      chat.lastText = tr('对方已结束私密对话');
      delete db.sessions[chat.id];
      await saveDb(db);
      await saveMsgs(chat.id, []); // ending the chat removes its messages on both sides
      await addMsg(chat.id, { id: 'ev_close_' + now, mine: false, at: now, expiresAt: null, p: { t: 'event', text: tr('对方已结束这个私密对话') } });
      break;
  }
  await saveDb(db);
  return [chat.id];
}

let fetching = false;
let again = false;
/** Pull the queue for this device, process in order, then acknowledge (only after the result is stored). */
export async function pullInbox() {
  if (!uid) return;
  if (fetching) return void (again = true);
  fetching = true;
  try {
    do {
      again = false;
      const r = await api.get('/api/secret/inbox');
      const list = r.envelopes as { id: string; fromDevice: string; fromUser: string; envelope: string; createdAt: number }[];
      if (!list.length) break;
      const changed = new Set<string>();
      await locked(async () => {
        const db = await loadDb();
        if (!db.device) return;
        for (const e of list) {
          if (db.seen.includes(e.id)) continue;
          try {
            (await handle(db, e)).forEach((c) => changed.add(c));
          } catch (err) {
            console.warn('secret envelope dropped', err);
          }
          db.seen = [...db.seen.slice(-1000), e.id];
          await saveDb(db);
        }
      });
      await api.post('/api/secret/ack', { ids: list.map((e) => e.id) });
      await refreshUi([...changed]);
      announce();
      if (list.length >= 100) again = true;
    } while (again);
  } catch (e) {
    if (!(e instanceof ApiError)) console.warn('secret inbox', e);
  } finally {
    fetching = false;
  }
}

// ------------------------------------------------------------------ actions
function summaryOf(p: C.Payload): string {
  if (p.t === 'text') return p.text.replace(/\s+/g, ' ').slice(0, 80);
  if (p.t === 'file') return p.kind === 'image' ? tr('[图片]') : p.kind === 'voice' ? tr('[语音]') : p.kind === 'video' ? tr('[视频]') : tr('[文件] {v0}', { v0: p.name });
  return '';
}
export function ttlLabel(ttl: number) {
  return ttl === 0 ? tr('关闭') : ttl < 60 ? tr('{v0} 秒', { v0: ttl }) : ttl < 3600 ? tr('{v0} 分钟', { v0: ttl / 60 }) : ttl < 86_400 ? tr('{v0} 小时', { v0: ttl / 3600 }) : tr('{v0} 天', { v0: ttl / 86_400 });
}
const ttlEvent = (ttl: number, who: string) => (ttl ? tr('{v0} 把阅后即焚设为 {v1}', { v0: who, v1: ttlLabel(ttl) }) : tr('{v0} 关闭了阅后即焚', { v0: who }));

/** Invite every device of `peerId`; the first to come online takes the chat. */
export async function startSecretChat(peerId: string, peerName: string): Promise<string> {
  await ensureDevice();
  const { bundles } = await api.get(`/api/users/${peerId}/prekeys`);
  const signPk = await trustedSignPk(peerId);
  const good = (bundles as R.PrekeyBundle[]).filter((b) => R.verifyBundle(b, peerId, signPk));
  if (!good.length) throw new Error(tr('对方还没有可以接收私密对话的设备（需要对方用 v0.8 或更新的版本登录过一次）'));
  const chatId = 'sc_' + C.b64(crypto.getRandomValues(new Uint8Array(16)));
  const now = Date.now();
  await locked(async () => {
    const db = await loadDb();
    const me = dev(db);
    const sessions: Record<string, SessionRec> = {};
    const posts: { to: string; env: Envelope }[] = [];
    for (const b of good) {
      const x = R.x3dhInitiate(me, db.device!.cert, b);
      const ad = adFor(x.ad, chatId);
      const r = R.ratchetEncrypt(R.initInitiator(x, C.unb64(b.spkPk)), enc({ t: 'hello', chatId, ttl: DEFAULT_TTL } satisfies Inner), ad);
      sessions[b.cert.deviceId] = { state: R.serializeState(r.state), ad: C.b64(ad), cert: b.cert };
      posts.push({ to: b.cert.deviceId, env: { v: 1, t: 'init', chatId, cert: db.device!.cert, ek: C.b64(x.ekPk), spkId: b.spkId, ...(b.opkId !== undefined ? { opkId: b.opkId } : {}), msg: r.msg } });
    }
    db.chats[chatId] = { id: chatId, peerId, peerName, role: 'initiator', status: 'waiting', ttl: DEFAULT_TTL, createdAt: now, lastAt: now, lastText: tr('等待对方设备上线…'), unread: 0 };
    db.sessions[chatId] = sessions;
    await saveDb(db);
    await addMsg(chatId, { id: 'ev_' + chatId, mine: true, at: now, expiresAt: null, p: { t: 'event', text: tr('你发起了私密对话。对方的设备上线后会自动接受。') } });
    let ok = 0;
    for (const p of posts) ok += await api.post('/api/secret/send', { toDevice: p.to, envelope: JSON.stringify(p.env) }).then(() => 1, () => 0);
    if (!ok) {
      delete db.chats[chatId];
      delete db.sessions[chatId];
      await saveDb(db);
      await saveMsgs(chatId, []);
      throw new Error(tr('发送邀请失败，请稍后再试'));
    }
  });
  await refreshUi([chatId]);
  announce();
  openSecret(chatId);
  return chatId;
}

async function sendPayload(chatId: string, p: C.Payload) {
  const id = 'sm_' + C.b64(crypto.getRandomValues(new Uint8Array(12)));
  const at = Date.now();
  await locked(async () => {
    const db = await loadDb();
    const chat = db.chats[chatId];
    if (!chat || chat.status !== 'active' || !chat.peerDevice) throw new Error(tr('私密对话还没有建立'));
    await sendInner(db, chatId, chat.peerDevice, { t: 'msg', id, at, ttl: chat.ttl, p });
    chat.lastAt = at;
    chat.lastText = summaryOf(p);
    await saveDb(db);
    await addMsg(chatId, { id, mine: true, at, expiresAt: chat.ttl ? at + chat.ttl * 1000 : null, p, status: 'sent' });
  });
  await refreshUi([chatId]);
  announce();
}

export async function sendSecretText(chatId: string, text: string) {
  const t = text.trim();
  if (!t) return;
  if (t.length > 20_000) throw new Error(tr('消息太长'));
  await sendPayload(chatId, { t: 'text', text: t });
}

/** Attachments go through the pair's direct chat as ordinary encrypted blobs, marked to expire in 14 days. */
export async function sendSecretFile(chatId: string, f: PreparedFile, caption?: string) {
  if (!f.bytes) throw new Error(tr('私密对话里的文件不能超过 90 MB'));
  const chat = useSecret.getState().chats[chatId];
  const direct = Object.values(useStore.getState().chats).find((c) => c.type === 'direct' && c.members.some((m) => m.id === chat?.peerId));
  if (!chat || !direct) throw new Error(tr('需要先和对方有私聊'));
  const e = C.encryptFile(C.padAttachment(f.bytes));
  const blobId = await uploadBlob(direct.id, e.ciphertext);
  await api.post('/api/secret/blobs', { ids: [blobId] });
  await sendPayload(chatId, {
    t: 'file',
    kind: f.kind,
    name: f.name,
    mime: f.mime,
    size: f.size,
    ...(f.w ? { w: f.w, h: f.h } : {}),
    ...(f.duration ? { duration: f.duration } : {}),
    ...(f.thumb ? { thumb: f.thumb } : {}),
    ...(caption ? { caption } : {}),
    blobId,
    key: e.key,
    header: e.header,
    chunk: e.chunk,
  });
}

export async function setSecretTtl(chatId: string, ttl: number) {
  if (!TTL_CHOICES.includes(ttl)) return;
  await locked(async () => {
    const db = await loadDb();
    const chat = db.chats[chatId];
    if (!chat?.peerDevice || chat.status !== 'active') return;
    await sendInner(db, chatId, chat.peerDevice, { t: 'ttl', ttl });
    chat.ttl = ttl;
    await saveDb(db);
    await addMsg(chatId, { id: 'ev_ttl_' + Date.now(), mine: true, at: Date.now(), expiresAt: null, p: { t: 'event', text: ttlEvent(ttl, tr('你')) } });
  });
  await refreshUi([chatId]);
  announce();
}

/** End the chat for both sides and delete it here (keys and messages). */
export async function deleteSecretChat(chatId: string) {
  await locked(async () => {
    const db = await loadDb();
    const chat = db.chats[chatId];
    if (!chat) return;
    // tell the bound device, or while still waiting every invited device, that the chat is over
    for (const d of Object.keys(db.sessions[chatId] ?? {})) {
      if ((chat.status === 'active' && d === chat.peerDevice) || chat.status === 'waiting') await sendInner(db, chatId, d, { t: 'close' }).catch(() => undefined);
    }
    delete db.sessions[chatId];
    delete db.chats[chatId];
    await saveDb(db);
    await saveMsgs(chatId, []);
  });
  const { messages, active } = useSecret.getState();
  const m = { ...messages };
  delete m[chatId];
  setUi({ messages: m, active: active === chatId ? null : active });
  await refreshUi();
  announce();
}

export function openSecret(chatId: string | null) {
  setUi({ active: chatId });
  if (!chatId) return;
  checkPeerAlive(chatId).catch(() => undefined);
  if (useStore.getState().activeChatId) openChat(null);
  locked(async () => {
    const db = await loadDb();
    if (db.chats[chatId]?.unread) {
      db.chats[chatId].unread = 0;
      await saveDb(db);
    }
  }).then(() => refreshUi([chatId]));
}

export function secretSafetyNumber(chat: SecretChat, mine: R.DeviceCert | null) {
  return chat.peerCert && mine ? R.deviceSafetyNumber(mine, chat.peerCert) : null;
}

const WAITING_TTL_MS = 14 * 86_400_000;
/**
 * Disappearing messages: delete expired ones locally (both sides run the same timer), clear a preview that showed
 * an expired message, and give up on invitations nobody accepted within 14 days.
 */
async function sweepExpired() {
  if (!uid || !wrapKey) return;
  const now = Date.now();
  const touched: string[] = [];
  let hadFile = false;
  await locked(async () => {
    const db = await loadDb();
    let dbChanged = false;
    for (const chat of Object.values(db.chats)) {
      const list = await loadMsgs(chat.id);
      const keep = list.filter((m) => !m.expiresAt || m.expiresAt > now);
      if (keep.length !== list.length) {
        hadFile ||= list.some((m) => m.expiresAt && m.expiresAt <= now && m.p.t === 'file');
        await saveMsgs(chat.id, keep);
        touched.push(chat.id);
        const last = [...keep].reverse().find((m) => m.p.t !== 'event');
        const lastText = last ? summaryOf(last.p as C.Payload) : tr('消息已按阅后即焚删除');
        if (chat.lastText !== lastText) (chat.lastText = lastText), (dbChanged = true);
      }
      if (chat.status === 'waiting' && now - chat.createdAt > WAITING_TTL_MS) {
        chat.status = 'closed';
        chat.lastText = tr('对方一直没有接受，邀请已失效');
        delete db.sessions[chat.id];
        dbChanged = true;
        touched.push(chat.id);
      }
    }
    if (dbChanged) await saveDb(db);
  });
  if (hadFile) clearFileCache(); // drop decrypted copies of expired attachments
  if (touched.length) {
    await refreshUi(touched);
    announce();
  }
}

// ------------------------------------------------------------------ v0.9: calls, liveness, local chat settings
function directChatOf(peerId: string): string | null {
  return Object.values(useStore.getState().chats).find((c) => c.type === 'direct' && c.members.some((m) => m.id === peerId))?.id ?? null;
}

setSecretCallHooks({
  async invite(chatId, call) {
    await locked(async () => {
      const db = await loadDb();
      const chat = db.chats[chatId];
      if (!chat?.peerDevice || chat.status !== 'active') throw new Error(tr('私密对话还没有建立'));
      await sendInner(db, chatId, chat.peerDevice, { t: 'call', ...call, at: Date.now() });
    });
  },
  log(chatId, p, mine) {
    const at = Date.now();
    locked(async () => {
      const db = await loadDb();
      const chat = db.chats[chatId];
      if (!chat) return;
      const text = callLabel(p);
      chat.lastAt = at;
      chat.lastText = text;
      await addMsg(chatId, { id: 'ev_call_' + at, mine, at, expiresAt: null, p: { t: 'event', text } });
      await saveDb(db);
    }).then(() => refreshUi([chatId]), () => undefined);
  },
});

export function callInSecretChat(chatId: string, video: boolean) {
  const chat = useSecret.getState().chats[chatId];
  if (!chat || chat.status !== 'active') return;
  const direct = directChatOf(chat.peerId);
  if (!direct) throw new Error(tr('需要先和对方有私聊'));
  return startSecretCall(chatId, direct, chat.peerId, video);
}

/** When a chat is opened: does the peer's device still exist? (cheap check, doesn't use up prekeys) */
async function checkPeerAlive(chatId: string) {
  const chat = useSecret.getState().chats[chatId];
  if (!chat?.peerDevice || chat.status !== 'active') return;
  // only an explicit "no such device" ends the chat; errors (no direct chat any more, blocked, offline) change nothing
  const r = await api.get(`/api/secret/devices/${encodeURIComponent(chat.peerDevice)}?user=${encodeURIComponent(chat.peerId)}`).catch(() => null);
  if (!r || r.alive !== false) return;
  await locked(async () => markPeerGone(await loadDb(), chatId));
  await refreshUi([chatId]);
  announce();
}

/** This device's own settings for a chat (not sent to the other side). */
export async function setSecretLocal(chatId: string, patch: Partial<Pick<SecretChat, 'verified' | 'pinned' | 'muted'>>) {
  await locked(async () => {
    const db = await loadDb();
    const chat = db.chats[chatId];
    if (!chat) return;
    Object.assign(chat, patch);
    await saveDb(db);
  });
  await refreshUi([chatId]);
  announce();
}

// ------------------------------------------------------------------ wiring
let timers: ReturnType<typeof setInterval>[] = [];
/** Forget everything in memory (logout, signed out remotely). With `wipe`, also delete this device's secret data. */
async function resetSecret(wipe: boolean) {
  const old = uid;
  timers.forEach(clearInterval);
  timers = [];
  bc?.close();
  bc = null;
  uid = '';
  wrapKey = null;
  setUi({ chats: {}, messages: {}, active: null, ready: false, myCert: null });
  if (wipe && old) {
    const keys = (await idbKeys().catch(() => [])) as IDBValidKey[];
    for (const key of keys) if (typeof key === 'string' && key.startsWith(`secret:${old}:`)) await idbDel(key).catch(() => undefined);
  }
}
async function init() {
  const me = useStore.getState().me;
  if (!me) return;
  if (uid !== me.id || !wrapKey) {
    await resetSecret(false);
    uid = me.id;
    wrapKey = await getWrapKey(me.id);
    bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sc-secret-${me.id}`) : null;
    if (bc) bc.onmessage = () => refreshUi();
    timers.push(setInterval(sweepExpired, 5000));
    // keep the signed prekey fresh and one-time prekeys topped up in long-lived tabs too
    timers.push(setInterval(() => ensureDevice().catch(() => undefined), 6 * 3600_000));
  }
  if (!wrapKey) return;
  await sweepExpired();
  await refreshUi();
  try {
    await ensureDevice();
  } catch (e) {
    console.warn('secret device', e);
  }
  await pullInbox();
}
onAppReady(() => init());
onSocket((s) => s.on('secret:new', () => pullInbox()));
useStore.subscribe((s, prev) => {
  // opening a normal chat leaves the secret one
  if (s.activeChatId && s.activeChatId !== prev.activeChatId && useSecret.getState().active) setUi({ active: null });
  // logged out here, or this session was signed out from elsewhere: the device is gone on the server; wipe it here too
  if (s.phase === 'auth' && prev.phase !== 'auth') {
    if (uid) resetSecret(true);
    forgetResumeHandles();
  }
});
export const secretReady = () => !!uid && !!wrapKey;
