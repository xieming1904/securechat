import { create } from 'zustand';
import { io, type Socket } from 'socket.io-client';
import * as C from '../crypto/core';
import * as O from '../crypto/opaqueClient';
import { idbClear, idbDel, idbGet, idbSet, knownSignKey, loadIdentity, rememberSignKey, saveIdentity } from '../crypto/keystore';
import * as LC from './localcache';
import { isCacheDisabled, prefs, setPrefs } from './prefs';
import { disableLockUnsafe } from './applock';
import { disablePush, notifyLocal, setNameResolver } from './notify';
import { ApiError, api, backToGate } from './api';
import * as OB from './outbox';
import { clearFileCache, transferBlob, uploadBlob, uploadLarge, type PreparedFile } from './files';
import { forgetResume, initResume, type ResumeRec } from './resume';
import { tr } from './i18n';

// --------------------------------------------------------------------------- types
export interface Me {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  isAdmin: boolean;
  totp?: boolean;
  /** the admin requires two-step verification and this account has none yet */
  needs2fa?: boolean;
}
export interface Member {
  id: string;
  username: string;
  displayName: string;
  role: 'owner' | 'admin' | 'member';
  lastReadSeq: number;
  online: boolean;
  /** muted by a group admin until this time */
  mutedUntil?: number | null;
  /** this account was deleted by its owner (messages stay) */
  deleted?: boolean;
}
export interface ServerReaction {
  userId: string;
  epoch: number;
  nonce: string;
  ciphertext: string;
  signature: string;
}
export interface ServerMsg {
  id: string;
  chatId: string;
  seq: number;
  senderId: string;
  epoch: number;
  clientMsgId: string;
  nonce: string;
  ciphertext: string;
  signature: string;
  editedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  reactions?: ServerReaction[];
  votes?: ServerReaction[];
}
export interface Msg {
  id: string;
  chatId: string;
  seq: number;
  senderId: string;
  clientMsgId: string;
  createdAt: number;
  editedAt: number | null;
  expiresAt: number | null;
  payload?: C.Payload;
  error?: string;
  pending?: boolean;
  failed?: boolean;
  /** userId -> emoji (decrypted) */
  reactions?: Record<string, string>;
  /** poll messages: userId -> chosen option indexes (decrypted) */
  votes?: Record<string, number[]>;
  /** waiting in the offline outbox */
  queued?: boolean;
  /** upload progress 0..1 for outgoing attachments */
  progress?: number;
}
export interface Chat {
  id: string;
  type: 'direct' | 'group';
  titleCt: string | null;
  title: string;
  currentEpoch: number;
  needsRotation: boolean;
  /** the current key is old (7 days / 1000 messages): the next sender re-keys first */
  rotateSoon?: boolean;
  membershipVersion: number;
  pendingJoins: number;
  pins: string[];
  /** someone @-mentioned me in an unread message (computed client-side, the server can't see it) */
  mentioned?: boolean;
  /** ok = server member list matches the signed membership chain */
  integrity: 'ok' | 'mismatch' | 'unverified';
  /** signed settings check (title + disappearing timer) */
  settings?: SettingsState;
  disappearingSeconds: number;
  /** group: who may post */
  postPolicy?: 'all' | 'admins';
  lastSeq: number;
  lastMessageAt: number | null;
  createdAt: number;
  myRole: 'owner' | 'admin' | 'member';
  myLastReadSeq: number;
  clearedBeforeSeq: number;
  unread: number;
  /** my own notification mute (server skips push while it lasts): ms timestamp, -1 = until turned back on */
  notifyOffUntil?: number | null;
  lastMessage: Msg | null;
  members: Member[];
}
export interface SettingsState {
  v: number;
  disappearing: number;
  by?: string;
  at?: number;
  title?: string;
  /** group announcement (part of the admin-signed settings) */
  ann?: string;
  /** group avatar (key covered by the admin signature) */
  av?: C.AvatarRef;
  /** signed = verified admin signature; unsigned = legacy/none; invalid = bad signature or signer not admin;
   *  rollback = older than a version this device already saw; mismatch = server enforces a different timer */
  status: 'signed' | 'unsigned' | 'invalid' | 'rollback' | 'mismatch' | 'resign';
}
type ServerChat = Omit<Chat, 'title' | 'lastMessage' | 'integrity' | 'settings'> & { lastMessage: ServerMsg | null };

interface State {
  phase: 'loading' | 'auth' | 'locked' | 'ready' | 'need2fa';
  me: Me | null;
  connected: boolean;
  chats: Record<string, Chat>;
  messages: Record<string, Msg[]>;
  hasMore: Record<string, boolean>;
  activeChatId: string | null;
  typing: Record<string, Record<string, number>>; // chatId -> userId -> expiry
  keyWarnings: Record<string, boolean>;
  toast: string | null;
  /** read-only mode from the local encrypted cache (server unreachable) */
  offline: boolean;
  /** scroll-to-message request (from search results) */
  jump: { chatId: string; messageId: string; n: number } | null;
  /** logins on other devices noticed while we were connected */
  loginAlerts: LoginAlert[];
  /** my scheduled (not yet sent) messages, decrypted, per chat */
  scheduled: Record<string, ScheduledMsg[]>;
  /** my encrypted-synced drafts, decrypted, per chat */
  drafts: Record<string, C.DraftData & { updatedAt: number }>;
}

export interface ScheduledMsg {
  id: string;
  chatId: string;
  clientMsgId: string;
  sendAt: number;
  stale: boolean;
  payload?: C.Payload;
}
interface ServerScheduled {
  id: string;
  chatId: string;
  epoch: number;
  clientMsgId: string;
  nonce: string;
  ciphertext: string;
  signature: string;
  sendAt: number;
  stale: boolean;
}

export interface LoginAlert {
  sessionId: string;
  deviceName: string | null;
  userAgent: string;
  ip: string;
  at: number;
}

export const useStore = create<State>(() => ({
  phase: 'loading',
  me: null,
  connected: false,
  chats: {},
  messages: {},
  hasMore: {},
  activeChatId: null,
  typing: {},
  keyWarnings: {},
  toast: null,
  offline: false,
  jump: null,
  loginAlerts: [],
  scheduled: {},
  drafts: {},
}));
const set = useStore.setState;
const get = useStore.getState;

export function toast(msg: string) {
  set({ toast: msg });
  setTimeout(() => get().toast === msg && set({ toast: null }), 3500);
}

// --------------------------------------------------------------------------- crypto state (never in React state)
let identity: C.Identity | null = null;
let socket: Socket | null = null;
const userKeys = new Map<string, { signPk: Uint8Array; boxPk: Uint8Array }>();
const chatKeys = new Map<string, Map<number, Uint8Array>>();
/** Verified membership chain per chat (replayed from signed records). */
const verified = new Map<string, { version: number; log: C.MembershipRecord[]; members: C.MemberEntry[]; history: Map<number, C.MemberEntry[]> }>();

export const myIdentity = () => identity;

export async function getUserKeys(userId: string) {
  const cached = userKeys.get(userId);
  if (cached) return cached;
  const r = await api.get(`/api/users/${userId}`);
  const k = { signPk: C.unb64(r.keys.signPk), boxPk: C.unb64(r.keys.boxPk) };
  // trust on first use; warn if a contact's identity key ever changes
  const known = await knownSignKey(userId);
  if (known && known !== r.keys.signPk) set((s) => ({ keyWarnings: { ...s.keyWarnings, [userId]: true } }));
  else if (!known) await rememberSignKey(userId, r.keys.signPk);
  userKeys.set(userId, k);
  return k;
}

/**
 * Fetch and verify the chat's signed membership log (incrementally). Throws if the chain is broken.
 * Returns the verified member list — the ONLY list we ever seal keys to.
 */
const sameRecords = (old: unknown[], cur: unknown[]) => old.every((r, i) => JSON.stringify(r) === JSON.stringify(cur[i]));
async function verifyMembership(chatId: string, force = false, knownVersion?: number) {
  const cur = verified.get(chatId);
  // the version of the chat being checked (a refresh may carry a newer one than what the store holds)
  const serverVersion = knownVersion ?? get().chats[chatId]?.membershipVersion;
  if (cur && !force && serverVersion !== undefined && cur.version >= serverVersion) return cur;
  const { log } = await api.get(`/api/chats/${chatId}/membership`);
  const v = await C.verifyMembershipChain(chatId, log, async (uid) => (await getUserKeys(uid)).signPk);
  // the chain only ever grows: a server that serves an older (still validly signed) prefix — e.g. to undo a
  // removal — is caught here, because what this device already verified must be a prefix of the new log
  if (cur && (v.version < cur.version || !sameRecords(cur.log, log))) throw new Error('membership log rolled back or rewritten');
  const entry = { ...v, log };
  verified.set(chatId, entry);
  return entry;
}

/** Compare the server's member list with the verified chain; flag the chat if they differ. */
async function checkIntegrity(c: Chat): Promise<Chat['integrity']> {
  try {
    const serverList = c.members.map((m) => `${m.id}:${m.role}`).sort().join(',');
    const matches = (v: { members: C.MemberEntry[]; version: number }) =>
      serverList === v.members.map((m) => `${m.id}:${m.role}`).sort().join(',') && v.version === c.membershipVersion;
    let v = await verifyMembership(c.id, false, c.membershipVersion);
    // a cached chain can lag behind a change that just happened: re-read it once before raising the alarm
    if (!matches(v)) v = await verifyMembership(c.id, true);
    return matches(v) ? 'ok' : 'mismatch';
  } catch (e) {
    console.warn('membership verification failed', c.id, e);
    return 'mismatch';
  }
}

async function loadChatKeys(chatId: string) {
  const { keys } = await api.get(`/api/chats/${chatId}/keys`);
  const map = chatKeys.get(chatId) ?? new Map<number, Uint8Array>();
  let v: Awaited<ReturnType<typeof verifyMembership>> | null = null;
  for (const k of keys as { epoch: number; membershipVersion: number; sealedKey: string; distributorId: string; signature: string }[]) {
    if (map.has(k.epoch)) continue;
    try {
      if (!v || !v.history.has(k.membershipVersion)) v = await verifyMembership(chatId, true);
      // the distributor must have been a member at the membership version the key was issued for
      if (!v.history.get(k.membershipVersion)?.some((m) => m.id === k.distributorId)) throw new Error('distributor not a member');
      const d = await getUserKeys(k.distributorId);
      map.set(k.epoch, C.openChatKey(k, chatId, get().me!.id, identity!, d.signPk));
    } catch (e) {
      console.warn('skip chat key', chatId, k.epoch, e);
    }
  }
  chatKeys.set(chatId, map);
  return map;
}

async function keyFor(chatId: string, epoch: number) {
  let k = chatKeys.get(chatId)?.get(epoch);
  if (!k) k = (await loadChatKeys(chatId)).get(epoch);
  return k;
}

async function decryptReactionFor(chatId: string, messageId: string, r: ServerReaction): Promise<string | null> {
  try {
    const key = await keyFor(chatId, r.epoch);
    if (!key) return null;
    return C.decryptReaction(r, key, chatId, messageId, (await getUserKeys(r.userId)).signPk);
  } catch {
    return null;
  }
}

async function decryptVoteFor(chatId: string, messageId: string, r: ServerReaction): Promise<number[] | null> {
  try {
    const key = await keyFor(chatId, r.epoch);
    if (!key) return null;
    return C.decryptVote(r, key, chatId, messageId, (await getUserKeys(r.userId)).signPk);
  } catch {
    return null;
  }
}

async function decryptMsg(m: ServerMsg): Promise<Msg> {
  const base: Msg = {
    id: m.id,
    chatId: m.chatId,
    seq: m.seq,
    senderId: m.senderId,
    clientMsgId: m.clientMsgId,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    expiresAt: m.expiresAt,
  };
  try {
    const key = await keyFor(m.chatId, m.epoch);
    if (!key) return { ...base, error: tr('没有该消息的密钥（加入前的消息）') };
    const sender = await getUserKeys(m.senderId);
    const payload = C.decryptMessage(m, key, sender.signPk);
    const reactions: Record<string, string> = {};
    for (const r of m.reactions ?? []) {
      const e = await decryptReactionFor(m.chatId, m.id, r);
      if (e) reactions[r.userId] = e;
    }
    const votes: Record<string, number[]> = {};
    for (const r of m.votes ?? []) {
      const v = await decryptVoteFor(m.chatId, m.id, r);
      if (v && v.length) votes[r.userId] = v;
    }
    return { ...base, payload, reactions, ...(m.votes?.length ? { votes } : {}) };
  } catch {
    return { ...base, error: tr('无法解密或签名校验失败') };
  }
}

const SETTINGS_SEEN = 'securechat.settingsv.v1';
type Seen = { v: number; h?: string };
function seenSettings(chatId: string): Seen {
  try {
    const x = JSON.parse(localStorage.getItem(`${SETTINGS_SEEN}.${get().me?.id}`) ?? '{}')[chatId];
    return typeof x === 'number' ? { v: x } : x && typeof x.v === 'number' ? x : { v: 0 };
  } catch {
    return { v: 0 };
  }
}
function rememberSettings(chatId: string, v: number, h: string) {
  try {
    const k = `${SETTINGS_SEEN}.${get().me?.id}`;
    const m = JSON.parse(localStorage.getItem(k) ?? '{}');
    const cur = typeof m[chatId] === 'number' ? { v: m[chatId] } : m[chatId] ?? { v: 0 };
    if (cur.v <= v) localStorage.setItem(k, JSON.stringify({ ...m, [chatId]: { v, h } }));
  } catch {
    /* storage unavailable */
  }
}

async function openChatSettings(c: { id: string; titleCt: string | null }) {
  if (!c.titleCt) return null;
  let keys = chatKeys.get(c.id)?.size ? chatKeys.get(c.id)! : await loadChatKeys(c.id).catch(() => new Map<number, Uint8Array>());
  let o = C.openSettings(c.titleCt, c.id, (e) => keys.get(e));
  if (o === null) {
    // encrypted under an epoch we haven't fetched yet
    keys = await loadChatKeys(c.id).catch(() => keys);
    o = C.openSettings(c.titleCt, c.id, (e) => keys.get(e));
  }
  return o;
}

async function checkSettings(c: Chat, o: C.OpenedSettings | null): Promise<SettingsState> {
  const seen = seenSettings(c.id);
  if (!o || o.kind === 'legacy') {
    // once this device has seen signed settings, anything unsigned or unreadable is a downgrade
    return { v: 0, disappearing: c.disappearingSeconds, status: seen.v > 0 ? 'rollback' : 'unsigned' };
  }
  const rec = o.rec;
  const h = C.settingsHash(o.recJson);
  const base = { v: rec.v, disappearing: rec.disappearing, by: rec.by, at: rec.at, title: rec.title, ann: rec.ann, av: C.isAvatarRef(rec.av) ? rec.av : undefined };
  let sigOk = false;
  let signerIsAdminNow = false;
  try {
    const v = await verifyMembership(c.id);
    const isAdmin = (ms: C.MemberEntry[] | undefined) => !!ms?.some((m) => m.id === rec.by && (c.type === 'direct' || m.role !== 'member'));
    signerIsAdminNow = isAdmin(v.members) && (rec.mv === undefined || isAdmin(v.history.get(rec.mv)));
    sigOk = C.verifySettings(o, c.id, (await getUserKeys(rec.by)).signPk);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ...base, status: 'invalid' };
  if (rec.v < seen.v) return { ...base, status: 'rollback' };
  if (!signerIsAdminNow) {
    // signed by someone who is no longer an admin: only fine if it is exactly the record we already accepted
    // (an admin's client then re-signs it); a NEW record from an ex-admin is rejected
    return { ...base, status: rec.v === seen.v && seen.h === h ? 'resign' : 'invalid' };
  }
  rememberSettings(c.id, rec.v, h);
  if (rec.disappearing !== c.disappearingSeconds) return { ...base, status: 'mismatch' };
  return { ...base, status: 'signed' };
}

async function hydrateChat(c: ServerChat): Promise<Chat> {
  c = { ...c, members: c.members.map((m) => (m.deleted ? { ...m, displayName: tr('已注销账号') } : m)) };
  let title = '';
  const me = get().me!;
  const opened = await openChatSettings(c);
  const h: Chat = { ...c, title: '', lastMessage: c.lastMessage ? await decryptMsg(c.lastMessage) : null, integrity: 'unverified' };
  h.integrity = await checkIntegrity(h);
  h.settings = await checkSettings(h, opened);
  if (c.type === 'direct') {
    const peer = c.members.find((m) => m.id !== me.id);
    title = peer?.displayName ?? tr('（已删除用户）');
  } else if (h.settings.status === 'unsigned') title = (opened?.kind === 'legacy' ? opened.title : '') || tr('群聊');
  else if (h.settings.status === 'invalid' || h.settings.status === 'rollback') title = tr('群聊');
  else title = h.settings.title || tr('群聊');
  h.title = title;
  // the record's signer is no longer an admin: an admin re-signs the (already verified) content
  if (h.settings.status === 'resign' && h.myRole !== 'member' && h.integrity === 'ok' && !upgrading.has(c.id)) {
    upgrading.add(c.id);
    setTimeout(() => saveSettings(c.id, {}).catch(() => undefined).finally(() => upgrading.delete(c.id)), 300);
  }
  return h;
}
const upgrading = new Set<string>();

/** Sign + store new settings (admins in groups, either side in a direct chat). Unchanged fields keep their value. */
export async function saveSettings(chatId: string, change: { title?: string; disappearing?: number; announcement?: string; avatar?: C.AvatarRef | null }) {
  const chat = get().chats[chatId];
  if (!chat) return;
  assertIntegrity(chatId);
  const key = await keyFor(chatId, chat.currentEpoch);
  if (!key) throw new Error(tr('缺少密钥'));
  const s = chat.settings;
  const verified = s && (s.status === 'signed' || s.status === 'mismatch' || s.status === 'resign');
  const rec: C.ChatSettings = {
    v: Math.max(s?.v ?? 0, seenSettings(chatId).v) + 1,
    title: change.title ?? (chat.type === 'group' ? (verified ? s!.title ?? chat.title : chat.title) : ''),
    // the signed value is authoritative; the server's value is only used for a first, explicit signing
    disappearing: change.disappearing ?? (verified ? s!.disappearing : chat.disappearingSeconds),
    at: Date.now(),
    by: get().me!.id,
    mv: chat.membershipVersion,
  };
  const ann = change.announcement !== undefined ? change.announcement.trim().slice(0, 4000) : verified ? s!.ann : undefined;
  if (ann) rec.ann = ann;
  const av = change.avatar !== undefined ? change.avatar : verified ? s!.av : undefined;
  if (av) rec.av = av;
  const titleCt = C.sealSettings(rec, identity!, key, chatId, chat.currentEpoch);
  await api.patch(`/api/chats/${chatId}`, { titleCt, disappearingSeconds: rec.disappearing });
  rememberSettings(chatId, rec.v, C.settingsHash(JSON.stringify(rec)));
  await refreshChat(chatId);
}

const refreshSeq = new Map<string, number>();
async function refreshChat(chatId: string) {
  const mySeq = (refreshSeq.get(chatId) ?? 0) + 1;
  refreshSeq.set(chatId, mySeq);
  try {
    const { chat } = await api.get(`/api/chats/${chatId}`);
    const h = await hydrateChat(chat);
    if (refreshSeq.get(chatId) !== mySeq) return h; // a newer refresh started meanwhile: let it win
    set((s) => ({ chats: { ...s.chats, [chatId]: h } }));
    if (h.needsRotation) scheduleRotation(chatId);
    if (h.pendingJoins > 0 && h.myRole !== 'member') scheduleJoinProcessing(chatId);
    return h;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) removeChatLocal(chatId);
    return null;
  }
}

function removeChatLocal(chatId: string) {
  OB.outboxDropChat(chatId);
  set((s) => {
    const chats = { ...s.chats };
    delete chats[chatId];
    const messages = { ...s.messages };
    delete messages[chatId];
    return { chats, messages, activeChatId: s.activeChatId === chatId ? null : s.activeChatId };
  });
  chatKeys.delete(chatId);
  verified.delete(chatId);
  LC.cacheDropChat(chatId);
}

export async function loadChats() {
  const { chats } = await api.get('/api/chats');
  const hydrated = await Promise.all((chats as ServerChat[]).map(hydrateChat));
  set({ chats: Object.fromEntries(hydrated.map((c) => [c.id, c])) });
  LC.cacheKeepChats(hydrated.map((c) => c.id));
  hydrated.forEach((c) => LC.cachePrune(c.id, c.clearedBeforeSeq));
  // chats opted out of the local cache keep no message preview in the offline snapshot either
  LC.saveChatsSnapshot({ me: get().me, chats: hydrated.map((c) => (isCacheDisabled(c.id) ? { ...c, lastMessage: undefined } : c)) });
  hydrated.filter((c) => c.needsRotation).forEach((c) => scheduleRotation(c.id));
  hydrated.filter((c) => c.pendingJoins > 0 && c.myRole !== 'member').forEach((c) => scheduleJoinProcessing(c.id));
}

// --------------------------------------------------------------------------- session
async function enterApp(me: Me, id: C.Identity) {
  identity = id;
  await LC.initCache(me.id);
  await OB.initOutbox(me.id);
  await initResume(me.id);
  if (me.needs2fa) return set({ me, phase: 'need2fa', offline: false });
  set({ me, phase: 'ready', offline: false });
  try {
    await loadChats();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'totp_required') return set({ phase: 'need2fa' });
    throw e;
  }
  showOutbox();
  connectSocket();
  flushOutbox();
  loadScheduledAndDrafts().catch(() => undefined);
  readyHooks.forEach((h) => Promise.resolve(h()).catch(() => undefined));
  syncRemovals().then(() => setTimeout(backfillAll, 1500));
}

/** Drop from the local cache everything that was deleted/hidden while we weren't looking. */
async function syncRemovals() {
  try {
    const since = await LC.getSyncSince();
    const r = await api.get(`/api/sync/removed?since=${Math.max(0, since - 60_000)}`);
    LC.cacheRemoveEverywhere(r.removed);
    await LC.setSyncSince(r.now);
  } catch {
    /* next time */
  }
}

/** Fill the search cache with older history, gently, one page at a time. */
let backfilling = false;
async function backfillAll() {
  if (backfilling || !LC.cacheEnabled() || get().offline) return;
  backfilling = true;
  try {
    for (const chat of Object.values(get().chats)) {
      if (await idbGet(`bf:${get().me!.id}:${chat.id}`).catch(() => undefined)) continue;
      for (let page = 0; page < 40; page++) {
        const min = LC.cachedMinSeq(chat.id);
        const r = await api.get(`/api/chats/${chat.id}/messages?limit=100${isFinite(min) ? `&before=${min}` : ''}`).catch(() => null);
        if (!r) break;
        const dec = await Promise.all((r.messages as ServerMsg[]).map(decryptMsg));
        LC.cachePut(dec.filter((m) => m.payload).map(toCached));
        if (!r.hasMore) {
          await idbSet(`bf:${get().me!.id}:${chat.id}`, true).catch(() => undefined);
          break;
        }
        await new Promise((res) => setTimeout(res, 200));
      }
    }
  } finally {
    backfilling = false;
  }
}

function toCached(m: Msg): LC.CachedMsg {
  return { id: m.id, chatId: m.chatId, seq: m.seq, senderId: m.senderId, createdAt: m.createdAt, editedAt: m.editedAt, expiresAt: m.expiresAt, clientMsgId: m.clientMsgId, payload: m.payload! };
}
function cacheMsgs(list: Msg[]) {
  LC.cachePut(list.filter((m) => m.payload && !m.pending && !m.error).map(toCached));
}

export function searchMessages(q: string) {
  return LC.searchCache(q);
}

export interface ChatSearchFilter {
  senderId?: string;
  /** ms timestamps, inclusive */
  from?: number;
  to?: number;
}
export interface ChatHit {
  id: string;
  seq: number;
  senderId: string;
  createdAt: number;
  text: string;
  index: number;
}
/**
 * Search inside one chat: this device's encrypted cache + what is loaded (+ `extra`, e.g. the whole history fetched
 * on request). Newest first. An empty query with a filter lists every message that matches the filter.
 */
export function searchInChat(chatId: string, q: string, f: ChatSearchFilter = {}, extra: Msg[] = []): ChatHit[] {
  const needle = q.trim().toLowerCase();
  if (!needle && !f.senderId && !f.from && !f.to) return [];
  const seen = new Set<string>();
  const out: ChatHit[] = [];
  const now = Date.now();
  const consider = (m: { id: string; seq: number; senderId: string; createdAt: number; expiresAt: number | null; payload?: C.Payload | null }) => {
    if (seen.has(m.id) || !m.payload || m.payload.t === 'system' || !m.seq) return;
    seen.add(m.id);
    if (m.expiresAt && m.expiresAt <= now) return;
    if (f.senderId && m.senderId !== f.senderId) return;
    if (f.from && m.createdAt < f.from) return;
    if (f.to && m.createdAt > f.to) return;
    const text = LC.searchableText(m.payload);
    const index = needle ? text.toLowerCase().indexOf(needle) : 0;
    if (needle && index < 0) return;
    out.push({ id: m.id, seq: m.seq, senderId: m.senderId, createdAt: m.createdAt, text, index });
  };
  for (const m of extra) consider(m);
  for (const m of get().messages[chatId] ?? []) consider(m);
  for (const m of LC.cachedMessages(chatId)) consider(m);
  return out.sort((a, b) => b.seq - a.seq);
}
export function localCacheInfo() {
  return { enabled: LC.cacheEnabled(), count: LC.cachedCount() };
}
export async function setLocalCache(on: boolean) {
  await LC.setCacheEnabled(on);
  if (on) {
    const me = get().me!;
    for (const c of Object.keys(get().chats)) await idbDel(`bf:${me.id}:${c}`).catch(() => undefined);
    for (const list of Object.values(get().messages)) cacheMsgs(list);
    backfillAll();
  }
}

/** Open a chat and scroll to a message, loading older pages until it's there. */
export async function openMessage(chatId: string, messageId: string, seq: number) {
  await openChat(chatId);
  for (let i = 0; i < 40; i++) {
    const list = get().messages[chatId] ?? [];
    if (list.some((m) => m.id === messageId)) break;
    const first = list.find((m) => !m.pending)?.seq ?? Infinity;
    if (first <= seq || !get().hasMore[chatId]) break;
    await loadMessages(chatId, true);
  }
  set((s) => ({ jump: { chatId, messageId, n: (s.jump?.n ?? 0) + 1 } }));
}

export async function bootstrap() {
  await C.ready();
  try {
    const { user } = await api.get('/api/me');
    const id = await loadIdentity(user.id);
    if (id) await enterApp(user, id);
    else set({ me: user, phase: 'locked' });
  } catch (e) {
    // network down (not an auth error): open read-only from the local encrypted cache if we can
    if (!(e instanceof ApiError) && (await enterOffline())) return;
    set({ phase: 'auth' });
  }
}

async function enterOffline() {
  const uid = await LC.lastUserId();
  const id = uid && (await loadIdentity(uid));
  if (!uid || !id) return false;
  await LC.initCache(uid);
  await OB.initOutbox(uid);
  const snap = await LC.loadChatsSnapshot<{ me: Me; chats: Chat[] }>();
  if (!snap) return false;
  identity = id;
  const chats = snap.chats.map((c) => ({ ...c, members: c.members.map((m) => ({ ...m, online: false })) }));
  set({ me: snap.me, chats: Object.fromEntries(chats.map((c) => [c.id, c])), phase: 'ready', offline: true, connected: false });
  showOutbox();
  // come back to life as soon as the server is reachable again
  const probe = setInterval(() => {
    fetch('/api/gate/status', { cache: 'no-store' })
      .then((r) => r.ok && (clearInterval(probe), location.reload()))
      .catch(() => undefined);
  }, 5000);
  return true;
}

const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'Linux';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '浏览器';
  return `${br} · ${os}`;
};

/** Pin the server's OPAQUE public key on first use; refuse to continue if it ever changes. */
async function checkServerKey(serverStaticPublicKey: string) {
  const known = await idbGet<string>('server-pk').catch(() => undefined);
  if (known && known !== serverStaticPublicKey)
    throw new Error(tr('服务器身份密钥与上次不同，可能正在遭受中间人攻击。已停止登录，请联系管理员核实。'));
  if (!known) await idbSet('server-pk', serverStaticPublicKey).catch(() => undefined);
}

/** OPAQUE login; returns the export key (never sent anywhere). */
async function opaqueLogin(username: string, password: string) {
  const s = await O.startLogin(password);
  const start = await api.post('/api/auth/login/start', { username, startLoginRequest: s.startLoginRequest });
  const fin = await O.finishLogin({ password, clientLoginState: s.clientLoginState, loginResponse: start.loginResponse });
  if (!fin) throw new Error(tr('用户名或密码错误'));
  await checkServerKey(fin.serverStaticPublicKey);
  let r = await api.post('/api/auth/login/finish', { username, loginId: start.loginId, finishLoginRequest: fin.finishLoginRequest, deviceName: deviceName() });
  if (r.totpRequired) r = await secondFactor(r.ticket, r.methods);
  return { r, exportKey: fin.exportKey };
}

// --------------------------------------------------------------------------- two-step verification prompt
export type SecondFactorAnswer = string | { passkey: true } | null;
let askCode: ((retry: boolean, methods: string[]) => Promise<SecondFactorAnswer>) | null = null;
/** The UI registers a dialog that asks for the 6-digit code, a recovery code, or to use a passkey. */
export function setSecondFactorPrompt(fn: (retry: boolean, methods: string[]) => Promise<SecondFactorAnswer>) {
  askCode = fn;
}
async function secondFactor(ticket: string, methods: string[] = ['totp']) {
  if (!askCode) throw new Error(tr('需要两步验证码'));
  let retry = false;
  for (let i = 0; i < 5; i++) {
    const answer = await askCode(retry, methods);
    if (!answer) throw new Error(tr('已取消登录'));
    try {
      if (typeof answer === 'string') return await api.post('/api/auth/2fa', { ticket, code: answer });
      const { assertPasskey } = await import('./passkey');
      const opts = await api.post('/api/auth/2fa/passkey-options', { ticket });
      const passkey = await assertPasskey(opts).catch((e: Error) => {
        toast(e.message);
        return null;
      });
      if (!passkey) {
        retry = false;
        continue;
      }
      return await api.post('/api/auth/2fa', { ticket, passkey });
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'bad_code') throw e;
      retry = true;
    }
  }
  throw new Error(tr('验证码错误次数过多，请重新登录'));
}

export async function login(username: string, password: string) {
  const { r, exportKey } = await opaqueLogin(username, password);
  const id = C.decryptBackup(r.keys.backupCt, r.keys.backupNonce, C.backupKeyFromExport(exportKey, 'password'));
  await saveIdentity(r.user.id, id);
  await enterApp(r.user, id);
}

/** Session cookie is still valid but local keys are gone (e.g. site data cleared): log in again. */
export async function unlock(password: string) {
  await login(get().me!.username, password);
}

/** Registration: one OPAQUE record for the password, one for the 24 recovery words. */
export async function register(invite: string, username: string, displayName: string, password: string, recoveryPhrase: string) {
  const pw = await O.startRegistration(password);
  const rc = await O.startRegistration(recoveryPhrase);
  const start = await api.post('/api/auth/register/start', {
    invite,
    username,
    registrationRequest: pw.registrationRequest,
    recoveryRegistrationRequest: rc.registrationRequest,
  });
  const pwDone = await O.finishRegistration({ password, clientRegistrationState: pw.clientRegistrationState, registrationResponse: start.registrationResponse });
  const rcDone = await O.finishRegistration({ password: recoveryPhrase, clientRegistrationState: rc.clientRegistrationState, registrationResponse: start.recoveryRegistrationResponse });
  await checkServerKey(pwDone.serverStaticPublicKey);
  const id = C.generateIdentity();
  const backup = C.encryptBackup(id, C.backupKeyFromExport(pwDone.exportKey, 'password'));
  const rbackup = C.encryptBackup(id, C.backupKeyFromExport(rcDone.exportKey, 'recovery'));
  const r = await api.post('/api/auth/register/finish', {
    invite,
    username,
    displayName,
    registrationRecord: pwDone.registrationRecord,
    recoveryRecord: rcDone.registrationRecord,
    signPk: C.b64(id.signPk),
    boxPk: C.b64(id.boxPk),
    ...backup,
    recoveryBackupCt: rbackup.backupCt,
    recoveryBackupNonce: rbackup.backupNonce,
    deviceName: deviceName(),
  });
  await saveIdentity(r.user.id, id);
  await rememberSignKey(r.user.id, C.b64(id.signPk));
  await enterApp(r.user, id);
}

export async function changePassword(oldPassword: string, newPassword: string) {
  const s = await O.startLogin(oldPassword);
  const reg = await O.startRegistration(newPassword);
  const start = await api.post('/api/auth/password/start', { startLoginRequest: s.startLoginRequest, registrationRequest: reg.registrationRequest });
  const fin = await O.finishLogin({ password: oldPassword, clientLoginState: s.clientLoginState, loginResponse: start.loginResponse });
  if (!fin) throw new Error(tr('当前密码错误'));
  const done = await O.finishRegistration({ password: newPassword, clientRegistrationState: reg.clientRegistrationState, registrationResponse: start.registrationResponse });
  const backup = C.encryptBackup(identity!, C.backupKeyFromExport(done.exportKey, 'password'));
  await api.post('/api/auth/password/finish', {
    loginId: start.loginId,
    finishLoginRequest: fin.finishLoginRequest,
    registrationRecord: done.registrationRecord,
    ...backup,
  });
}

/** New recovery words (the old ones stop working). Requires the current password. */
/** Prove the password again (needed before adding the first two-step verification method). */
export async function reauthWithPassword(password: string) {
  const s = await O.startLogin(password);
  const start = await api.post('/api/auth/reauth/start', { startLoginRequest: s.startLoginRequest });
  const fin = await O.finishLogin({ password, clientLoginState: s.clientLoginState, loginResponse: start.loginResponse });
  if (!fin) throw new Error(tr('密码错误'));
  await api.post('/api/auth/reauth/finish', { loginId: start.loginId, finishLoginRequest: fin.finishLoginRequest });
}

/**
 * Delete my account. Checked by the server first (username, password, second factor); then I leave every group
 * (signed by me, so the member lists stay verifiable) and the server wipes the account. Local data goes too.
 */
export async function deleteAccount(opts: { password: string; confirm: string; proof?: Record<string, unknown> }) {
  await reauthWithPassword(opts.password);
  const { token } = await api.post('/api/me/delete/prepare', { confirm: opts.confirm, proof: opts.proof });
  const me = get().me!;
  const failed: string[] = [];
  for (const c of Object.values(get().chats)) {
    if (c.type !== 'group') continue;
    await changeMembership(c.id, 'leave', [me.id]).catch(() => failed.push(c.title));
  }
  if (failed.length) throw new Error(tr('没能退出这些群组：{v0}。请手动退出后再注销。', { v0: failed.join('、') }));
  await api.post('/api/me/delete', { token });
  await logout().catch(() => undefined);
}

export async function regenerateRecovery(password: string, phrase: string) {
  const s = await O.startLogin(password);
  const reg = await O.startRegistration(phrase);
  const start = await api.post('/api/auth/recovery/start', { startLoginRequest: s.startLoginRequest, registrationRequest: reg.registrationRequest });
  const fin = await O.finishLogin({ password, clientLoginState: s.clientLoginState, loginResponse: start.loginResponse });
  if (!fin) throw new Error(tr('密码错误'));
  const done = await O.finishRegistration({ password: phrase, clientRegistrationState: reg.clientRegistrationState, registrationResponse: start.registrationResponse });
  const rb = C.encryptBackup(identity!, C.backupKeyFromExport(done.exportKey, 'recovery'));
  await api.post('/api/auth/recovery/finish', {
    loginId: start.loginId,
    finishLoginRequest: fin.finishLoginRequest,
    recoveryRecord: done.registrationRecord,
    recoveryBackupCt: rb.backupCt,
    recoveryBackupNonce: rb.backupNonce,
  });
}

/** Step 1 of recovery: prove knowledge of the 24 words, get the identity back. */
export async function recoverWithPhrase(username: string, phrase: string) {
  const s = await O.startLogin(phrase);
  const start = await api.post('/api/auth/recover/start', { username, startLoginRequest: s.startLoginRequest });
  const fin = await O.finishLogin({ password: phrase, clientLoginState: s.clientLoginState, loginResponse: start.loginResponse });
  if (!fin) throw new Error(tr('用户名或恢复词错误'));
  await checkServerKey(fin.serverStaticPublicKey);
  let r = await api.post('/api/auth/recover/finish', { username, loginId: start.loginId, finishLoginRequest: fin.finishLoginRequest });
  if (r.totpRequired) r = await secondFactor(r.ticket, r.methods);
  const id = C.decryptBackup(r.recoveryBackupCt, r.recoveryBackupNonce, C.backupKeyFromExport(fin.exportKey, 'recovery'));
  return { recoveryToken: r.recoveryToken as string, identity: id };
}

/** Step 2: set a new password. All other sessions are revoked by the server. */
export async function finishRecovery(recoveryToken: string, id: C.Identity, newPassword: string) {
  const reg = await O.startRegistration(newPassword);
  const start = await api.post('/api/auth/recover/reset/start', { recoveryToken, registrationRequest: reg.registrationRequest });
  const done = await O.finishRegistration({ password: newPassword, clientRegistrationState: reg.clientRegistrationState, registrationResponse: start.registrationResponse });
  const backup = C.encryptBackup(id, C.backupKeyFromExport(done.exportKey, 'password'));
  const r = await api.post('/api/auth/recover/reset/finish', { recoveryToken, registrationRecord: done.registrationRecord, ...backup, deviceName: deviceName() });
  await saveIdentity(r.user.id, id);
  await enterApp(r.user, id);
}

export async function logout() {
  await disablePush().catch(() => undefined);
  await api.post('/api/auth/logout').catch(() => undefined);
  socket?.close();
  socket = null;
  identity = null;
  userKeys.clear();
  chatKeys.clear();
  verified.clear();
  clearFileCache();
  OB.outboxForget();
  forgetResume();
  const pk = await idbGet<string>('server-pk').catch(() => undefined);
  await idbClear().catch(() => undefined);
  if (pk) await idbSet('server-pk', pk).catch(() => undefined); // keep the pinned server key
  disableLockUnsafe(); // the app lock belongs to the logged-in device state
  set({ phase: 'auth', me: null, chats: {}, messages: {}, activeChatId: null });
}

export function updateMe(me: Me) {
  set({ me });
}

// --------------------------------------------------------------------------- key rotation & membership
async function sealToMembers(key: Uint8Array, kc: Omit<C.KeyContext, 'distributorId'>, members: C.MemberEntry[]) {
  const out: C.SealedKey[] = [];
  for (const m of members) out.push(C.sealChatKey(key, { ...kc, distributorId: get().me!.id }, m.id, (await getUserKeys(m.id)).boxPk, identity!));
  return out;
}

function assertIntegrity(chatId: string) {
  const c = get().chats[chatId];
  if (c?.integrity === 'mismatch') throw new Error(tr('成员列表未通过签名校验，已停止发送和分发密钥'));
}

const rotating = new Set<string>();
function scheduleRotation(chatId: string) {
  setTimeout(() => rotateIfNeeded(chatId).catch((e) => console.warn('rotation', e)), Math.random() * 1500);
}

/** After someone left: any remaining member seals a fresh key to the VERIFIED member list. */
export async function rotateIfNeeded(chatId: string) {
  if (rotating.has(chatId)) return;
  rotating.add(chatId);
  try {
    const { chat } = await api.get(`/api/chats/${chatId}`);
    if (!chat.needsRotation && !chat.rotateSoon) return;
    const h = await hydrateChat(chat);
    set((s) => ({ chats: { ...s.chats, [chatId]: h } }));
    assertIntegrity(chatId);
    const v = await verifyMembership(chatId, true);
    const epoch = chat.currentEpoch + 1;
    const key = C.newChatKey();
    const keys = await sealToMembers(key, { chatId, epoch, membershipVersion: v.version }, v.members);
    try {
      await api.post(`/api/chats/${chatId}/keys`, { epoch, membershipVersion: v.version, keys });
      (chatKeys.get(chatId) ?? chatKeys.set(chatId, new Map()).get(chatId)!).set(epoch, key);
      await reencryptTitle(chatId, key, epoch);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e; // someone else rotated first
    }
    await refreshChat(chatId);
  } finally {
    rotating.delete(chatId);
  }
}

/** After a key rotation: re-encrypt the SAME (signed) settings record under the new key. */
async function reencryptTitle(chatId: string, key: Uint8Array, epoch: number) {
  const cur = get().chats[chatId];
  if (!cur?.titleCt) return;
  const o = await openChatSettings(cur).catch(() => null);
  if (o) await api.patch(`/api/chats/${chatId}`, { titleCt: C.encryptTitle(o.raw, key, chatId, epoch) }).catch(() => undefined);
}

/**
 * Signed membership change. add/remove carry a fresh key sealed to the resulting members (atomic rotation);
 * leave/role do not rotate.
 */
async function changeMembership(chatId: string, action: 'add' | 'remove' | 'leave' | 'role', targets: string[], role?: 'admin' | 'member') {
  assertIntegrity(chatId);
  const { chat } = await api.get(`/api/chats/${chatId}`);
  const v = await verifyMembership(chatId, true);
  if (v.version !== chat.membershipVersion) throw new Error(tr('成员列表未通过签名校验'));
  const version = v.version + 1;
  const { signature, result } = C.signMembership(chatId, version, v.members, action, { id: get().me!.id, identity: identity! }, targets, role);
  const body: Record<string, unknown> = { version, action, targets, role, signature };
  let key: Uint8Array | undefined;
  const epoch = chat.currentEpoch + 1;
  if (action === 'add' || action === 'remove') {
    key = C.newChatKey();
    body.epoch = epoch;
    body.keys = await sealToMembers(key, { chatId, epoch, membershipVersion: version }, result);
  }
  await api.post(`/api/chats/${chatId}/membership`, body);
  if (key) {
    (chatKeys.get(chatId) ?? chatKeys.set(chatId, new Map()).get(chatId)!).set(epoch, key);
    await reencryptTitle(chatId, key, epoch);
  }
  if (action === 'leave') removeChatLocal(chatId);
  else await refreshChat(chatId);
}

export const addMembers = (chatId: string, userIds: string[]) => changeMembership(chatId, 'add', userIds);
export const removeMember = (chatId: string, userId: string) =>
  userId === get().me!.id ? changeMembership(chatId, 'leave', [userId]) : changeMembership(chatId, 'remove', [userId]);
export const setRole = (chatId: string, userId: string, role: 'admin' | 'member') => changeMembership(chatId, 'role', [userId], role);

// --------------------------------------------------------------------------- join requests (group invite links)
export interface JoinRequest {
  userId: string;
  username: string;
  displayName: string;
  autoApprove: boolean;
  createdAt: number;
}
const joining = new Set<string>();
function scheduleJoinProcessing(chatId: string) {
  setTimeout(() => processJoinRequests(chatId).catch((e) => console.warn('join', e)), 300 + Math.random() * 1500);
}

/** Admin clients sign in people who used an invite link that doesn't need manual approval. */
async function processJoinRequests(chatId: string) {
  if (joining.has(chatId)) return;
  const c = get().chats[chatId];
  if (!c || c.myRole === 'member' || c.integrity === 'mismatch') return;
  joining.add(chatId);
  try {
    const { requests } = await api.get(`/api/chats/${chatId}/join-requests`);
    const auto = (requests as JoinRequest[]).filter((r) => r.autoApprove).map((r) => r.userId);
    if (auto.length) await addMembers(chatId, auto).catch((e) => !(e instanceof ApiError && e.status === 409) && console.warn(e));
  } finally {
    joining.delete(chatId);
  }
}

export async function listJoinRequests(chatId: string): Promise<JoinRequest[]> {
  return (await api.get(`/api/chats/${chatId}/join-requests`)).requests;
}
export async function rejectJoin(chatId: string, userId: string) {
  await api.del(`/api/chats/${chatId}/join-requests/${userId}`);
  await refreshChat(chatId);
}

// --------------------------------------------------------------------------- messages
function upsertMsgs(chatId: string, msgs: Msg[], mode: 'append' | 'prepend' | 'replace') {
  set((s) => {
    const cur = mode === 'replace' ? [] : s.messages[chatId] ?? [];
    const byKey = new Map<string, Msg>();
    for (const m of [...cur, ...msgs]) {
      // an optimistic message is replaced by the server copy with the same clientMsgId
      const k = `${m.senderId}|${m.clientMsgId}`;
      byKey.set(k, m);
    }
    const list = [...byKey.values()].sort((a, b) => (a.pending ? Infinity : a.seq) - (b.pending ? Infinity : b.seq));
    return { messages: { ...s.messages, [chatId]: list } };
  });
}

export async function openChat(chatId: string | null) {
  set((s) => ({ activeChatId: chatId, chats: chatId && s.chats[chatId] ? { ...s.chats, [chatId]: { ...s.chats[chatId], mentioned: false } } : s.chats }));
  if (!chatId) return;
  // v0.8: an old key (7 days / 1000 messages) is replaced as soon as someone opens the chat, not only on the next send
  const c = get().chats[chatId];
  if (c && (c.rotateSoon || c.needsRotation) && !get().offline && c.integrity !== 'mismatch') scheduleRotation(chatId);
  if (!get().messages[chatId]) await loadMessages(chatId);
  markRead(chatId);
}

/** Messages that arrived over the socket while a (re)load of that chat was in flight. */
const arrivedDuringLoad = new Map<string, Map<string, Msg>>();

export async function loadMessages(chatId: string, older = false) {
  if (get().offline) {
    const list = LC.cachedMessages(chatId).map((m) => ({ ...m, reactions: {} }) as Msg);
    const pending = (get().messages[chatId] ?? []).filter((m) => m.pending || m.failed);
    upsertMsgs(chatId, [...list, ...pending], 'replace');
    set((s) => ({ hasMore: { ...s.hasMore, [chatId]: false } }));
    return;
  }
  const cur = get().messages[chatId] ?? [];
  const firstSeq = cur.find((m) => !m.pending)?.seq;
  const url = `/api/chats/${chatId}/messages?limit=50${older && firstSeq ? `&before=${firstSeq}` : ''}`;
  if (!older) arrivedDuringLoad.set(chatId, new Map());
  try {
    const { messages, hasMore } = await api.get(url);
    const dec = await Promise.all((messages as ServerMsg[]).map(decryptMsg));
    cacheMsgs(dec);
    if (older) upsertMsgs(chatId, dec, 'prepend');
    else {
      // keep anything pushed over the socket while the request was in flight (it is newer than the snapshot)
      const late = [...(arrivedDuringLoad.get(chatId)?.values() ?? [])];
      const pending = (get().messages[chatId] ?? []).filter((m) => m.pending || m.failed);
      upsertMsgs(chatId, [...dec, ...late, ...pending], 'replace');
    }
    set((s) => ({ hasMore: { ...s.hasMore, [chatId]: hasMore } }));
  } finally {
    if (!older) arrivedDuringLoad.delete(chatId);
  }
}

export async function markRead(chatId: string) {
  const chat = get().chats[chatId];
  if (!chat || document.hidden) return;
  const list = get().messages[chatId] ?? [];
  const lastSeq = list.filter((m) => !m.pending).at(-1)?.seq ?? chat.lastSeq;
  if (lastSeq > chat.myLastReadSeq || chat.unread > 0) {
    set((s) => ({ chats: { ...s.chats, [chatId]: { ...chat, unread: 0, myLastReadSeq: Math.max(chat.myLastReadSeq, lastSeq) } } }));
    await api.post(`/api/chats/${chatId}/read`, { seq: lastSeq }).catch(() => undefined);
  }
}

function sendBlocked(chatId: string, queueable = false): string | null {
  if (get().offline && !queueable) return tr('离线模式：文件、语音和定时消息需要联网后再发送');
  if (get().chats[chatId]?.integrity === 'mismatch') return tr('成员列表未通过签名校验，已停止发送。请联系群管理员核实。');
  const warned = get().chats[chatId]?.members.find((m) => get().keyWarnings[m.id]);
  if (warned) return tr('{v0} 的安全码已变更，请先在「聊天信息」中核对后再发送', { v0: warned.displayName });
  return null;
}

const retries = new Map<string, () => void>();
export function retrySend(clientMsgId: string) {
  retries.get(clientMsgId)?.();
}

function setProgress(chatId: string, clientMsgId: string, progress: number) {
  set((s) => ({ messages: { ...s.messages, [chatId]: (s.messages[chatId] ?? []).map((m) => (m.clientMsgId === clientMsgId && m.pending ? { ...m, progress } : m)) } }));
}

/**
 * Generic send: shows an optimistic bubble, optionally runs `build` (encrypt + upload attachments),
 * then encrypts the payload with the current epoch key. Retries once after a 409 (epoch changed).
 */
/** v0.9: the next message sent in a chat deletes itself after this many seconds (one-shot). */
const nextTtl = new Map<string, number>();
export function setNextMessageTtl(chatId: string, ttl: number | null) {
  if (ttl && ttl >= 30) nextTtl.set(chatId, ttl);
  else nextTtl.delete(chatId);
}

async function sendMessage(
  chatId: string,
  preview: C.Payload,
  build?: (onProgress: (p: number) => void) => Promise<{ payload: C.Payload; blobIds: string[] }>,
  opts: { clientMsgId?: string; createdAt?: number; fromOutbox?: boolean; ttl?: number } = {},
) {
  // v0.9: the one-shot timer is taken now and travels with this message (outbox, retry)
  const ttl = opts.ttl ?? (opts.fromOutbox ? undefined : nextTtl.get(chatId));
  if (!opts.fromOutbox) nextTtl.delete(chatId);
  const blocked = sendBlocked(chatId, !build);
  if (blocked) {
    if (opts.fromOutbox) return false;
    toast(blocked);
    return false;
  }
  const me = get().me!;
  const clientMsgId = opts.clientMsgId ?? C.newClientMsgId();
  const optimistic: Msg = {
    id: `tmp_${clientMsgId}`,
    chatId,
    seq: 0,
    senderId: me.id,
    clientMsgId,
    createdAt: opts.createdAt ?? Date.now(),
    editedAt: null,
    expiresAt: null,
    payload: preview,
    pending: true,
    progress: build ? 0 : undefined,
  };
  upsertMsgs(chatId, [optimistic], 'append');
  // messages without attachments survive a lost connection: keep them (encrypted at rest) until they are delivered
  if (!build) OB.outboxAdd({ chatId, clientMsgId, payload: preview, createdAt: optimistic.createdAt, ...(ttl ? { ttl } : {}) });

  const attempt = async (payload: C.Payload, blobIds: string[]) => {
    let chat = get().chats[chatId];
    if (chat.needsRotation || chat.rotateSoon) {
      await rotateIfNeeded(chatId);
      chat = get().chats[chatId];
    }
    const key = await keyFor(chatId, chat.currentEpoch);
    if (!key) throw new Error(tr('缺少当前密钥，请稍后再试'));
    const enc = C.encryptMessage(payload, key, { chatId, epoch: chat.currentEpoch, senderId: me.id, clientMsgId }, identity!);
    return api.post(`/api/chats/${chatId}/messages`, { clientMsgId, epoch: chat.currentEpoch, ...enc, blobIds, ...(ttl ? { ttl } : {}) });
  };
  try {
    if (get().offline || !navigator.onLine) throw new TypeError('offline');
    const { payload, blobIds } = build ? await build((p) => setProgress(chatId, clientMsgId, p)) : { payload: preview, blobIds: [] };
    let r;
    try {
      r = await attempt(payload, blobIds);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await refreshChat(chatId);
        await loadChatKeys(chatId);
        r = await attempt(payload, blobIds);
      } else throw e;
    }
    retries.delete(clientMsgId);
    OB.outboxRemove(clientMsgId);
    await onMsgNew(r.message);
    return true;
  } catch (e) {
    if (!build && isNetworkError(e)) {
      // stays in the outbox; flushOutbox() sends it when we're back
      upsertMsgs(chatId, [{ ...optimistic, queued: true }], 'append');
      if (!opts.fromOutbox) toast(tr('网络不可用：消息已加入发送队列，联网后自动发送'));
      return false;
    }
    OB.outboxRemove(clientMsgId);
    upsertMsgs(chatId, [{ ...optimistic, failed: true, queued: false, progress: undefined }], 'append');
    retries.set(clientMsgId, () => {
      discardFailed(chatId, clientMsgId);
      retries.delete(clientMsgId);
      sendMessage(chatId, preview, build, ttl ? { ttl } : {});
    });
    toast(e instanceof Error ? e.message : tr('发送失败'));
    return false;
  }
}

const isNetworkError = (e: unknown) => !(e instanceof ApiError) ? e instanceof TypeError : e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504;

let flushing = false;
/** Deliver queued messages, oldest first. Stops at the first one that still can't get through. */
export async function flushOutbox() {
  if (flushing || get().offline || !identity) return;
  flushing = true;
  try {
    for (const it of OB.outboxItems()) {
      if (!get().chats[it.chatId]) {
        OB.outboxRemove(it.clientMsgId);
        continue;
      }
      const ok = await sendMessage(it.chatId, it.payload, undefined, { clientMsgId: it.clientMsgId, createdAt: it.createdAt, fromOutbox: true, ttl: it.ttl });
      if (!ok && OB.outboxHas(it.clientMsgId)) break; // still offline
    }
  } finally {
    flushing = false;
  }
}

/** Show queued messages as pending bubbles (after start-up). */
function showOutbox() {
  const me = get().me;
  if (!me) return;
  for (const it of OB.outboxItems()) {
    if (!get().chats[it.chatId]) continue;
    upsertMsgs(it.chatId, [
      { id: `tmp_${it.clientMsgId}`, chatId: it.chatId, seq: 0, senderId: me.id, clientMsgId: it.clientMsgId, createdAt: it.createdAt, editedAt: null, expiresAt: null, payload: it.payload, pending: true, queued: true },
    ], 'append');
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => flushOutbox());
  setInterval(() => {
    if (OB.outboxItems().length && get().connected) flushOutbox();
  }, 20_000);
}

// --------------------------------------------------------------------------- scheduled messages
async function encryptForSchedule(chatId: string, clientMsgId: string, payload: C.Payload) {
  let chat = get().chats[chatId];
  if (chat.needsRotation) {
    await rotateIfNeeded(chatId);
    chat = get().chats[chatId];
  }
  const key = await keyFor(chatId, chat.currentEpoch);
  if (!key) throw new Error(tr('缺少当前密钥，请稍后再试'));
  const enc = C.encryptMessage(payload, key, { chatId, epoch: chat.currentEpoch, senderId: get().me!.id, clientMsgId }, identity!);
  return { epoch: chat.currentEpoch, ...enc };
}

async function decryptScheduled(r: ServerScheduled): Promise<ScheduledMsg> {
  const base = { id: r.id, chatId: r.chatId, clientMsgId: r.clientMsgId, sendAt: r.sendAt, stale: r.stale };
  try {
    const key = await keyFor(r.chatId, r.epoch);
    if (!key || !identity) return base;
    return { ...base, payload: C.decryptMessage({ ...r, senderId: get().me!.id }, key, identity.signPk) };
  } catch {
    return base;
  }
}

async function putScheduled(r: ServerScheduled) {
  const m = await decryptScheduled(r);
  set((st) => {
    const list = (st.scheduled[r.chatId] ?? []).filter((x) => x.id !== r.id);
    return { scheduled: { ...st.scheduled, [r.chatId]: [...list, m].sort((a, b) => a.sendAt - b.sendAt) } };
  });
  if (m.stale && m.payload) reencryptScheduled(m).catch(() => undefined);
}

/** After a key rotation the stored ciphertext is for an old epoch: re-encrypt it with the current key. */
async function reencryptScheduled(m: ScheduledMsg, sendAt = m.sendAt) {
  if (!m.payload) throw new Error(tr('无法解密这条定时消息'));
  const attempt = async () => api.put(`/api/scheduled/${m.id}`, { ...(await encryptForSchedule(m.chatId, m.clientMsgId, m.payload!)), sendAt });
  try {
    await attempt();
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) throw e;
    await refreshChat(m.chatId);
    await loadChatKeys(m.chatId);
    await attempt();
  }
}

export async function loadScheduledAndDrafts() {
  const [{ scheduled }, { drafts }] = await Promise.all([api.get('/api/scheduled'), api.get('/api/drafts')]);
  const list = await Promise.all((scheduled as ServerScheduled[]).map(decryptScheduled));
  const by: Record<string, ScheduledMsg[]> = {};
  for (const m of list) (by[m.chatId] ??= []).push(m);
  set({ scheduled: by });
  list.filter((m) => m.stale && m.payload).forEach((m) => reencryptScheduled(m).catch(() => undefined));
  const d: State['drafts'] = {};
  for (const r of drafts as { chatId: string; nonce: string; ciphertext: string; updatedAt: number }[]) {
    try {
      d[r.chatId] = { ...C.decryptDraft(r, identity!, get().me!.id, r.chatId), updatedAt: r.updatedAt };
    } catch {
      /* ignore undecryptable drafts */
    }
  }
  set({ drafts: d });
}

export async function scheduleText(chatId: string, text: string, sendAt: number, replyTo?: string, mentions?: string[]) {
  const blocked = sendBlocked(chatId);
  if (blocked) throw new Error(blocked);
  const payload: C.Payload = { t: 'text', text };
  if (replyTo) payload.replyTo = replyTo;
  if (mentions?.length) payload.mentions = mentions;
  const clientMsgId = C.newClientMsgId();
  const post = async () => api.post(`/api/chats/${chatId}/scheduled`, { clientMsgId, ...(await encryptForSchedule(chatId, clientMsgId, payload)), sendAt });
  let r;
  try {
    r = await post();
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409 && e.code !== 'duplicate')) throw e;
    await refreshChat(chatId);
    await loadChatKeys(chatId);
    r = await post();
  }
  await putScheduled(r.scheduled);
}

export async function cancelScheduled(m: ScheduledMsg) {
  await api.del(`/api/scheduled/${m.id}`);
}
export async function sendScheduledNow(m: ScheduledMsg) {
  try {
    await api.post(`/api/scheduled/${m.id}/send-now`);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) throw e;
    await reencryptScheduled(m, Date.now());
  }
}
export async function rescheduleMsg(m: ScheduledMsg, sendAt: number) {
  await reencryptScheduled(m, sendAt);
}

// --------------------------------------------------------------------------- drafts (end-to-end encrypted, synced between my devices)
function applyDraft(chatId: string, r: { nonce: string; ciphertext: string; updatedAt: number } | null) {
  const cur = get().drafts[chatId];
  if (!r) {
    if (!cur) return;
    const d = { ...get().drafts };
    delete d[chatId];
    return set({ drafts: d });
  }
  if (cur && cur.updatedAt >= r.updatedAt) return;
  try {
    const dd = C.decryptDraft(r, identity!, get().me!.id, chatId);
    set({ drafts: { ...get().drafts, [chatId]: { ...dd, updatedAt: r.updatedAt } } });
  } catch {
    /* ignore */
  }
}

const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Save (debounced) my draft for a chat. Empty text deletes it. */
export function saveDraft(chatId: string, text: string, replyTo?: string) {
  const t = Date.now();
  const d = { ...get().drafts };
  if (text.trim()) d[chatId] = { text, ...(replyTo ? { replyTo } : {}), updatedAt: t };
  else delete d[chatId];
  set({ drafts: d });
  clearTimeout(draftTimers.get(chatId));
  draftTimers.set(
    chatId,
    setTimeout(() => {
      draftTimers.delete(chatId);
      if (!identity || get().offline) return;
      if (!text.trim()) return void api.del(`/api/drafts/${chatId}`).catch(() => undefined);
      api
        .put(`/api/drafts/${chatId}`, C.encryptDraft({ text, ...(replyTo ? { replyTo } : {}) }, identity, get().me!.id, chatId))
        .then((r: { updatedAt: number }) => {
          const cur = get().drafts[chatId];
          if (cur && cur.text === text) set({ drafts: { ...get().drafts, [chatId]: { ...cur, updatedAt: r.updatedAt } } });
        })
        .catch(() => undefined);
    }, 1200),
  );
}

export async function sendText(chatId: string, text: string, replyTo?: string, mentions?: string[], preview?: C.LinkPreview) {
  const payload: C.Payload = { t: 'text', text };
  if (preview) payload.preview = preview;
  if (replyTo) payload.replyTo = replyTo;
  if (mentions?.length) payload.mentions = mentions;
  await sendMessage(chatId, payload);
}

/** Encrypt + upload a prepared attachment, then send the message that carries its key. */
export async function sendFile(chatId: string, f: PreparedFile, opts: { caption?: string; replyTo?: string } = {}) {
  const base = {
    t: 'file' as const,
    kind: f.kind,
    name: f.name,
    mime: f.mime,
    size: f.size,
    ...(f.w ? { w: f.w, h: f.h } : {}),
    ...(f.duration ? { duration: f.duration } : {}),
    ...(f.thumb ? { thumb: f.thumb } : {}),
    ...(opts.caption ? { caption: opts.caption } : {}),
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
  };
  const preview: C.FilePayload = { ...base, blobId: '', key: '', header: '', chunk: C.FILE_CHUNK };
  await sendMessage(chatId, preview, async (onProgress) => {
    if (f.source) {
      const up = await uploadLarge(chatId, f.source, onProgress, base);
      return { payload: { ...base, blobId: up.blobId, key: up.key, header: up.header, chunk: up.chunk }, blobIds: [up.blobId] };
    }
    const enc = C.encryptFile(C.padAttachment(f.bytes!)); // v0.9: the server sees a rounded size only
    const blobId = await uploadBlob(chatId, enc.ciphertext, onProgress);
    return { payload: { ...base, blobId, key: enc.key, header: enc.header, chunk: enc.chunk }, blobIds: [blobId] };
  });
}

/** Continue an upload that was interrupted (page reload / network) with the same file, picked again by the user. */
export async function resumeFileSend(rec: ResumeRec, file: File) {
  if (file.name !== rec.name || file.size !== rec.size || file.lastModified !== rec.lastModified) throw new Error(tr('这不是同一个文件（名称、大小或修改时间不同）'));
  const base = rec.base;
  const preview: C.FilePayload = { ...base, blobId: '', key: '', header: '', chunk: C.FILE_CHUNK };
  await sendMessage(rec.chatId, preview, async (onProgress) => {
    const up = await uploadLarge(rec.chatId, file, onProgress, base);
    return { payload: { ...base, blobId: up.blobId, key: up.key, header: up.header, chunk: up.chunk }, blobIds: [up.blobId] };
  });
}

/** Forward: re-encrypt the payload for the target chat; attachments are re-uploaded (same file key). */
export async function forwardMessage(msg: Msg, targetChatId: string) {
  const p = msg.payload;
  if (!p || p.t === 'system') return;
  const src = get().chats[msg.chatId];
  const from = p.fwd ?? (msg.senderId === get().me!.id ? get().me!.displayName : src?.members.find((m) => m.id === msg.senderId)?.displayName ?? tr('未知'));
  return forwardPayload(p, targetChatId, from);
}

/** Forward a (decrypted) payload into a chat, re-encrypting it and re-uploading attachments there. */
export async function forwardPayload(p: C.Payload, targetChatId: string, from: string) {
  if (p.t === 'system') return;
  if (p.t === 'text') return sendMessage(targetChatId, { t: 'text', text: p.text, fwd: from, ...(p.preview ? { preview: p.preview } : {}) });
  if (p.t === 'poll') return sendMessage(targetChatId, { t: 'poll', q: p.q, options: p.options, multi: p.multi, fwd: from });
  if (p.t === 'bundle') return forwardBundleAgain(p, targetChatId, from);
  if (p.t === 'call') return;
  const { replyTo: _r, mentions: _m, ...rest } = p;
  const preview: C.FilePayload = { ...rest, fwd: from };
  await sendMessage(targetChatId, { ...preview, blobId: '' }, async (onProgress) => {
    const blobId = await transferBlob(p as C.FilePayload, targetChatId, onProgress);
    return { payload: { ...preview, blobId }, blobIds: [blobId] };
  });
}

/** Send one of my stickers: its encrypted file is copied into the chat (still encrypted with its own file key). */
export async function sendSticker(chatId: string, p: C.FilePayload) {
  const preview: C.FilePayload = { ...p, blobId: '', sticker: true, caption: undefined };
  await sendMessage(chatId, preview, async (onProgress) => {
    const blobId = await transferBlob(p, chatId, onProgress);
    return { payload: { ...preview, blobId }, blobIds: [blobId] };
  });
}

export async function sendPoll(chatId: string, q: string, options: string[], multi: boolean, replyTo?: string) {
  const payload: C.PollPayload = { t: 'poll', q: q.trim(), options: options.map((o) => o.trim()).filter(Boolean), multi };
  if (payload.options.length < 2 || payload.options.length > 10 || !payload.q) throw new Error(tr('投票需要问题和 2–10 个选项'));
  if (replyTo) payload.replyTo = replyTo;
  await sendMessage(chatId, payload);
}

/** Cast (or with an empty list, retract) my vote on a poll. Votes are encrypted + signed like reactions. */
export async function vote(msg: Msg, choice: number[]) {
  const p = msg.payload;
  if (!p || p.t !== 'poll' || p.closed) return;
  const me = get().me!;
  const clean = [...new Set(choice)].filter((i) => Number.isInteger(i) && i >= 0 && i < p.options.length).sort((a, b) => a - b);
  if (!p.multi && clean.length > 1) clean.length = 1;
  if (!clean.length) {
    await api.del(`/api/messages/${msg.id}/vote`);
    return;
  }
  const chat = get().chats[msg.chatId];
  const key = await keyFor(msg.chatId, chat.currentEpoch);
  if (!key) throw new Error(tr('缺少密钥'));
  const r = C.encryptVote(clean, key, { chatId: msg.chatId, messageId: msg.id, userId: me.id, epoch: chat.currentEpoch }, identity!);
  await api.put(`/api/messages/${msg.id}/vote`, r);
}

/** Close my poll: re-encrypt the same payload with closed=true (a signed edit, so nobody else can close it). */
export async function closePoll(msg: Msg) {
  const p = msg.payload;
  if (!p || p.t !== 'poll' || p.closed) return;
  await editPayload(msg, { ...p, closed: true });
}

/** Forwarding a chat-history message as-is: re-upload its attachments into the target chat. */
async function forwardBundleAgain(p: C.BundlePayload, targetChatId: string, from: string) {
  const preview: C.BundlePayload = { t: 'bundle', title: p.title, items: p.items, fwd: from };
  const files = p.items.filter((i) => i.p.t === 'file');
  if (!files.length) return sendMessage(targetChatId, preview);
  await sendMessage(targetChatId, preview, async (onProgress) => {
    const blobIds: string[] = [];
    const items: C.BundleItem[] = [];
    for (const it of p.items) {
      if (it.p.t !== 'file') {
        items.push(it);
        continue;
      }
      const blobId = await transferBlob(it.p, targetChatId, (x) => onProgress((blobIds.length + x) / files.length));
      blobIds.push(blobId);
      items.push({ ...it, p: { ...it.p, blobId } });
    }
    return { payload: { ...preview, items }, blobIds };
  });
}

export const BUNDLE_MAX = 100;
export const BUNDLE_MAX_FILES = 10;

/**
 * Merged forward: several messages become ONE encrypted "chat history" message in the target chat.
 * Attachments are downloaded, and re-uploaded (still encrypted with their own file keys) into the target chat.
 */
export async function forwardBundle(msgs: Msg[], targetChatId: string) {
  const me = get().me!;
  const sorted = [...msgs].filter((m) => m.payload && m.payload.t !== 'system' && m.payload.t !== 'call' && !m.error).sort((a, b) => a.seq - b.seq);
  if (!sorted.length) return;
  if (sorted.length > BUNDLE_MAX) throw new Error(tr('合并转发最多 {v0} 条', { v0: BUNDLE_MAX }));
  const files = sorted.filter((m) => m.payload!.t === 'file').length;
  if (files > BUNDLE_MAX_FILES) throw new Error(tr('合并转发最多带 {v0} 个附件，请分批转发', { v0: BUNDLE_MAX_FILES }));
  const src = get().chats[sorted[0].chatId];
  const nameOf = (id: string) => (id === me.id ? me.displayName : src?.members.find((x) => x.id === id)?.displayName ?? tr('未知'));
  const items: C.BundleItem[] = sorted.map((m) => {
    const p = m.payload!;
    const from = nameOf(m.senderId);
    if (p.t === 'bundle') return { from, at: m.createdAt, p: { t: 'bundle', title: p.title, n: p.items.length } };
    if (p.t === 'text') return { from, at: m.createdAt, p: { t: 'text', text: p.text, ...(p.preview ? { preview: p.preview } : {}) } };
    if (p.t === 'poll') return { from, at: m.createdAt, p: { t: 'poll', q: p.q, options: p.options, multi: p.multi, closed: true } };
    const { replyTo: _r, mentions: _m, fwd: _f, ...rest } = p as C.FilePayload;
    return { from, at: m.createdAt, p: rest };
  });
  const title = src?.type === 'group' ? tr('{v0} 的聊天记录', { v0: src.title }) : tr('{v0}的聊天记录', { v0: [...new Set(sorted.map((m) => nameOf(m.senderId)))].join(tr('和')) });
  const preview: C.BundlePayload = { t: 'bundle', title: title.slice(0, 120), items };
  // keep the encrypted payload well under the server's per-message limit: drop thumbnails if needed
  if (JSON.stringify(preview).length > 140_000) for (const it of items) if (it.p.t === 'file') delete (it.p as C.FilePayload).thumb;
  if (JSON.stringify(preview).length > 140_000) throw new Error(tr('内容太多，无法合并为一条，请减少条数'));
  if (!files) return sendMessage(targetChatId, preview);
  await sendMessage(targetChatId, preview, async (onProgress) => {
    const out: C.BundleItem[] = [];
    const blobIds: string[] = [];
    let done = 0;
    for (const it of items) {
      if (it.p.t !== 'file') {
        out.push(it);
        continue;
      }
      const blobId = await transferBlob(it.p, targetChatId, (x) => onProgress((done + x) / files));
      done++;
      blobIds.push(blobId);
      out.push({ ...it, p: { ...it.p, blobId } });
    }
    return { payload: { ...preview, items: out }, blobIds };
  });
}

/** Toggle my reaction (one per message, like Telegram without premium). */
export async function react(msg: Msg, emoji: string) {
  const me = get().me!;
  if (msg.reactions?.[me.id] === emoji) {
    await api.del(`/api/messages/${msg.id}/reaction`);
    return;
  }
  const chat = get().chats[msg.chatId];
  const key = await keyFor(msg.chatId, chat.currentEpoch);
  if (!key) throw new Error(tr('缺少密钥'));
  const r = C.encryptReaction(emoji, key, { chatId: msg.chatId, messageId: msg.id, userId: me.id, epoch: chat.currentEpoch }, identity!);
  await api.put(`/api/messages/${msg.id}/reaction`, r);
}

export async function pinMessage(chatId: string, messageId: string, pin: boolean) {
  if (pin) await api.post(`/api/chats/${chatId}/pins`, { messageId });
  else await api.del(`/api/chats/${chatId}/pins/${messageId}`);
  await refreshChat(chatId);
}

/** Fetch + decrypt a single message (pinned messages that aren't in the loaded page). */
export async function fetchMessage(messageId: string): Promise<Msg | null> {
  try {
    const { message } = await api.get(`/api/messages/${messageId}`);
    return await decryptMsg(message);
  } catch {
    return null;
  }
}

export function discardFailed(chatId: string, clientMsgId: string) {
  OB.outboxRemove(clientMsgId);
  set((s) => ({ messages: { ...s.messages, [chatId]: (s.messages[chatId] ?? []).filter((m) => m.clientMsgId !== clientMsgId || !m.failed) } }));
}

export async function editText(msg: Msg, text: string) {
  const old = msg.payload && msg.payload.t === 'text' ? msg.payload : undefined;
  await editPayload(msg, {
    t: 'text',
    text,
    ...(old?.replyTo ? { replyTo: old.replyTo } : {}),
    ...(old?.mentions ? { mentions: old.mentions } : {}),
    ...(old?.preview && text.includes(old.preview.url) ? { preview: old.preview } : {}),
  });
}

async function editPayload(msg: Msg, payload: C.Payload) {
  const chat = get().chats[msg.chatId];
  const me = get().me!;
  const server = await api.get(`/api/chats/${msg.chatId}/messages?before=${msg.seq + 1}&limit=1`);
  const sm: ServerMsg | undefined = server.messages[0];
  if (!sm || sm.id !== msg.id) throw new Error(tr('消息不存在'));
  const key = await keyFor(msg.chatId, sm.epoch);
  if (!key) throw new Error(tr('缺少密钥'));
  const enc = C.encryptMessage(payload, key, { chatId: chat.id, epoch: sm.epoch, senderId: me.id, clientMsgId: sm.clientMsgId }, identity!);
  const r = await api.patch(`/api/messages/${msg.id}`, enc);
  await onMsgEdited(r.message);
}

export async function deleteMessages(ids: string[], scope: 'me' | 'everyone') {
  await api.post('/api/messages/delete', { ids, scope });
}

export async function clearHistory(chatId: string, scope: 'me' | 'everyone') {
  await api.post(`/api/chats/${chatId}/clear`, { scope });
}

export async function deleteChat(chatId: string, forEveryone: boolean) {
  await api.del(`/api/chats/${chatId}${forEveryone ? '?forEveryone=1' : ''}`);
  removeChatLocal(chatId);
}

export async function setDisappearing(chatId: string, seconds: number) {
  await saveSettings(chatId, { disappearing: seconds });
}

// --------------------------------------------------------------------------- chat creation / membership
export async function findUser(username: string) {
  const { user } = await api.get(`/api/users/by-username/${encodeURIComponent(username.replace(/^@/, ''))}`);
  return user as { id: string; username: string; displayName: string };
}

async function createChat(type: 'direct' | 'group', targets: string[], title?: string) {
  const me = get().me!;
  const id = `c_${C.randomId()}`;
  const key = C.newChatKey();
  const { signature, result } = C.signMembership(id, 1, [], 'create', { id: me.id, identity: identity! }, targets, type);
  const keys = await sealToMembers(key, { chatId: id, epoch: 1, membershipVersion: 1 }, result);
  const body: Record<string, unknown> = { id, type, keys, membershipSignature: signature };
  if (type === 'direct') body.peerId = targets[0];
  else {
    body.memberIds = targets;
    body.titleCt = C.sealSettings({ v: 1, title: title!, disappearing: 0, at: Date.now(), by: me.id, mv: 1 }, identity!, key, id, 1);
  }
  const r = await api.post('/api/chats', body);
  if (!r.existing) chatKeys.set(id, new Map([[1, key]]));
  const h = await hydrateChat(r.chat);
  set((s) => ({ chats: { ...s.chats, [h.id]: h } }));
  return h.id as string;
}

export const createDirect = (peerId: string) => createChat('direct', [peerId]);
export const createGroup = (title: string, memberIds: string[]) =>
  createChat(
    'group',
    [...new Set(memberIds)].filter((m) => m !== get().me!.id),
    title,
  );

export async function renameGroup(chatId: string, title: string) {
  await saveSettings(chatId, { title });
}

/** Using a group invite only queues a join request; an admin's client signs the membership change. */
export async function acceptGroupInvite(token: string) {
  const r = await api.post(`/api/invites/${encodeURIComponent(token)}/accept`);
  if (r.alreadyMember) await refreshChat(r.chatId);
  return r as { chatId: string; alreadyMember: boolean; pending: boolean; needsApproval?: boolean };
}

export async function safetyNumberWith(userId: string) {
  const me = get().me!;
  const peer = await getUserKeys(userId);
  return C.safetyNumber(me.id, identity!.signPk, userId, peer.signPk);
}
export async function acceptKeyChange(userId: string) {
  const r = await api.get(`/api/users/${userId}`);
  await rememberSignKey(userId, r.keys.signPk);
  set((s) => {
    const w = { ...s.keyWarnings };
    delete w[userId];
    return { keyWarnings: w };
  });
}

// --------------------------------------------------------------------------- realtime
async function onMsgNew(sm: ServerMsg) {
  const m = await decryptMsg(sm);
  cacheMsgs([m]);
  notifyLocal(m);
  const s = get();
  if (!s.chats[sm.chatId]) {
    await refreshChat(sm.chatId);
  }
  arrivedDuringLoad.get(sm.chatId)?.set(m.id, m);
  if (get().messages[sm.chatId]) upsertMsgs(sm.chatId, [m], 'append');
  set((st) => {
    const c = st.chats[sm.chatId];
    if (!c) return {};
    const mine = sm.senderId === st.me!.id;
    const isActive = st.activeChatId === sm.chatId && !document.hidden;
    return {
      chats: {
        ...st.chats,
        [c.id]: {
          ...c,
          lastMessage: m,
          lastSeq: Math.max(c.lastSeq, sm.seq),
          lastMessageAt: sm.createdAt,
          unread: mine || isActive ? c.unread : c.unread + 1,
          myLastReadSeq: mine ? Math.max(c.myLastReadSeq, sm.seq) : c.myLastReadSeq,
          mentioned: c.mentioned || (!mine && !isActive && !!m.payload && 'mentions' in m.payload && !!m.payload.mentions?.includes(st.me!.id)),
        },
      },
    };
  });
  if (get().activeChatId === sm.chatId && sm.senderId !== get().me!.id) markRead(sm.chatId);
  // clear typing indicator for the sender
  set((st) => {
    const t = { ...(st.typing[sm.chatId] ?? {}) };
    delete t[sm.senderId];
    return { typing: { ...st.typing, [sm.chatId]: t } };
  });
}

async function onMsgEdited(sm: ServerMsg) {
  const prev = get().messages[sm.chatId]?.find((x) => x.id === sm.id);
  const m = { ...(await decryptMsg(sm)), reactions: prev?.reactions ?? {}, votes: prev?.votes };
  cacheMsgs([m]);
  set((s) => {
    const list = s.messages[sm.chatId];
    const chat = s.chats[sm.chatId];
    return {
      messages: list ? { ...s.messages, [sm.chatId]: list.map((x) => (x.id === m.id ? m : x)) } : s.messages,
      chats: chat && chat.lastMessage?.id === m.id ? { ...s.chats, [chat.id]: { ...chat, lastMessage: m } } : s.chats,
    };
  });
}

function connectSocket() {
  socket?.close();
  const s = io({ withCredentials: true });
  socket = s;
  let first = true;
  s.on('connect', () => {
    set({ connected: true });
    if (first) first = false;
    else {
      // catch up after a reconnect
      syncRemovals();
      loadChats().catch(() => undefined);
      loadScheduledAndDrafts().catch(() => undefined);
      readyHooks.forEach((h) => Promise.resolve(h()).catch(() => undefined));
      flushOutbox();
      const a = get().activeChatId;
      if (a) loadMessages(a).catch(() => undefined);
    }
  });
  s.on('disconnect', () => set({ connected: false }));
  s.on('connect_error', (e) => {
    set({ connected: false });
    if (e.message === 'unauthorized') set({ phase: 'auth' });
    if (e.message === 'ip_not_allowed') backToGate();
  });
  s.on('msg:new', onMsgNew);
  s.on('msg:edited', onMsgEdited);
  s.on('msg:deleted', async ({ chatId, ids }: { chatId: string; ids: string[] }) => {
    const gone = new Set(ids);
    LC.cacheRemove(chatId, ids);
    ids.forEach((id) => arrivedDuringLoad.get(chatId)?.delete(id));
    set((st) => ({ messages: st.messages[chatId] ? { ...st.messages, [chatId]: st.messages[chatId].filter((m) => !gone.has(m.id)) } : st.messages }));
    const c = get().chats[chatId];
    if (c?.lastMessage && gone.has(c.lastMessage.id)) await refreshChat(chatId);
  });
  s.on('chat:new', ({ chatId }: { chatId: string }) => refreshChat(chatId));
  s.on('chat:updated', ({ chatId }: { chatId: string }) => refreshChat(chatId));
  s.on('chat:deleted', ({ chatId }: { chatId: string }) => removeChatLocal(chatId));
  s.on('chat:cleared', async ({ chatId, beforeSeq }: { chatId: string; beforeSeq: number }) => {
    LC.cachePrune(chatId, beforeSeq);
    set((st) => ({ messages: st.messages[chatId] ? { ...st.messages, [chatId]: st.messages[chatId].filter((m) => m.pending || m.seq > beforeSeq) } : st.messages }));
    await refreshChat(chatId);
  });
  s.on('receipt', ({ chatId, userId, seq }: { chatId: string; userId: string; seq: number }) => {
    set((st) => {
      const c = st.chats[chatId];
      if (!c) return {};
      return { chats: { ...st.chats, [chatId]: { ...c, members: c.members.map((m) => (m.id === userId ? { ...m, lastReadSeq: Math.max(m.lastReadSeq, seq) } : m)) } } };
    });
  });
  s.on('typing', ({ chatId, userId, typing }: { chatId: string; userId: string; typing: boolean }) => {
    set((st) => {
      const t = { ...(st.typing[chatId] ?? {}) };
      if (typing) t[userId] = Date.now() + 6000;
      else delete t[userId];
      return { typing: { ...st.typing, [chatId]: t } };
    });
  });
  s.on('presence', ({ userId, online }: { userId: string; online: boolean }) => {
    set((st) => {
      const chats = { ...st.chats };
      for (const [id, c] of Object.entries(chats)) {
        if (c.members.some((m) => m.id === userId)) chats[id] = { ...c, members: c.members.map((m) => (m.id === userId ? { ...m, online } : m)) };
      }
      return { chats };
    });
  });
  s.on('key:needed', ({ chatId }: { chatId: string }) => scheduleRotation(chatId));
  s.on('reaction', async ({ chatId, messageId, userId, reaction }: { chatId: string; messageId: string; userId: string; reaction: ServerReaction | null }) => {
    const emoji = reaction ? await decryptReactionFor(chatId, messageId, reaction) : null;
    set((st) => {
      const list = st.messages[chatId];
      if (!list) return {};
      return {
        messages: {
          ...st.messages,
          [chatId]: list.map((m) => {
            if (m.id !== messageId) return m;
            const r = { ...(m.reactions ?? {}) };
            if (emoji) r[userId] = emoji;
            else delete r[userId];
            return { ...m, reactions: r };
          }),
        },
      };
    });
  });
  s.on('vote', async ({ chatId, messageId, userId, vote }: { chatId: string; messageId: string; userId: string; vote: ServerReaction | null }) => {
    const v = vote ? await decryptVoteFor(chatId, messageId, vote) : null;
    set((st) => {
      const list = st.messages[chatId];
      if (!list) return {};
      return {
        messages: {
          ...st.messages,
          [chatId]: list.map((m) => {
            if (m.id !== messageId) return m;
            const r = { ...(m.votes ?? {}) };
            if (v && v.length) r[userId] = v;
            else delete r[userId];
            return { ...m, votes: r };
          }),
        },
      };
    });
  });
  s.on('scheduled:changed', (r: ServerScheduled) => putScheduled(r));
  s.on('scheduled:stale', (r: ServerScheduled) => putScheduled(r));
  s.on('scheduled:sent', ({ id, chatId }: { id: string; chatId: string }) =>
    set((st) => ({ scheduled: { ...st.scheduled, [chatId]: (st.scheduled[chatId] ?? []).filter((x) => x.id !== id) } })),
  );
  socketHooks.forEach((h) => h(s));
  s.on('call:signal', (d: CallSignal) => callSignalHandler?.(d));
  s.on('draft', ({ chatId, draft }: { chatId: string; draft: { nonce: string; ciphertext: string; updatedAt: number } | null }) => applyDraft(chatId, draft));
  s.on('join:pending', ({ chatId }: { chatId: string }) => refreshChat(chatId));
  s.on('join:rejected', () => toast(tr('你的入群申请被拒绝了')));
  s.on('security:factor', (e: { what: string; name?: string | null }) => {
    const msg: Record<string, string> = {
      passkey_added: tr('你的账号在另一台设备上添加了通行密钥「{v0}」。如果不是你本人操作，请立即修改密码并检查设备。', { v0: e.name ?? '' }),
      passkey_removed: tr('你的账号在另一台设备上删除了一个通行密钥。如果不是你本人操作，请立即修改密码。'),
      totp_added: tr('你的账号在另一台设备上开启了验证器 App。如果不是你本人操作，请立即修改密码。'),
      totp_removed: tr('你的账号在另一台设备上关闭了验证器 App。如果不是你本人操作，请立即修改密码。'),
    };
    if (msg[e.what]) toast(msg[e.what]);
  });
  s.on('security:new-login', (a: LoginAlert) => set({ loginAlerts: [...get().loginAlerts.filter((x) => x.sessionId !== a.sessionId), a] }));
  s.on('key:rotated', async ({ chatId }: { chatId: string }) => {
    await loadChatKeys(chatId).catch(() => undefined);
    await refreshChat(chatId);
  });
}

let lastTypingSent = 0;
export function sendTyping(chatId: string, typing: boolean) {
  const t = Date.now();
  if (typing && t - lastTypingSent < 3000) return;
  lastTypingSent = typing ? t : 0;
  socket?.emit('typing', { chatId, typing });
}

document.addEventListener('visibilitychange', () => {
  const a = get().activeChatId;
  if (!document.hidden && a) markRead(a);
});

// expire disappearing messages locally even before the server purge arrives
setInterval(() => {
  const t = Date.now();
  const s = get();
  let changed = false;
  const messages = { ...s.messages };
  for (const [cid, list] of Object.entries(messages)) {
    const f = list.filter((m) => !m.expiresAt || m.expiresAt > t);
    if (f.length !== list.length) {
      messages[cid] = f;
      changed = true;
    }
  }
  if (changed) set({ messages });
  // drop stale typing indicators
  let tChanged = false;
  const typing = { ...s.typing };
  for (const [cid, m] of Object.entries(typing)) {
    const live = Object.fromEntries(Object.entries(m).filter(([, exp]) => exp > t));
    if (Object.keys(live).length !== Object.keys(m).length) {
      typing[cid] = live;
      tChanged = true;
    }
  }
  if (tChanged) set({ typing });
}, 1000);

setNameResolver((m) => {
  const st = get();
  const chat = st.chats[m.chatId];
  const sender = chat?.members.find((x) => x.id === m.senderId)?.displayName ?? tr('有人');
  // a mention only counts if it is visible in the text too (the mentions list alone is invisible metadata)
  const p = m.payload as { mentions?: string[]; text?: string; caption?: string } | undefined;
  const myName = chat?.members.find((x) => x.id === st.me?.id)?.displayName;
  const mentioned = !!st.me && !!myName && !!p?.mentions?.includes(st.me.id) && `${p.text ?? ''} ${p.caption ?? ''}`.includes(`@${myName}`);
  const muted = !!chat && isNotifyOff(chat) && !(mentioned && prefs().mentionBypassMute);
  return { chat: chat?.title ?? tr('新消息'), sender, isMe: m.senderId === st.me?.id, muted };
});

/** Opt a chat in/out of the local encrypted cache. Opting out also deletes what is already cached for it. */
export function setChatCacheDisabled(chatId: string, disabled: boolean) {
  const cur = new Set(prefs().noCache);
  if (disabled) cur.add(chatId);
  else cur.delete(chatId);
  setPrefs({ noCache: [...cur] });
  if (disabled) {
    LC.cacheDropChat(chatId);
    LC.saveChatsSnapshot({ me: get().me, chats: Object.values(get().chats).map((c) => (isCacheDisabled(c.id) ? { ...c, lastMessage: undefined } : c)) });
  } else {
    const msgs = get().messages[chatId] ?? [];
    LC.cachePut(msgs.filter((m) => m.payload && !m.pending && !m.error).map(toCached));
  }
}

export function dismissLoginAlert(sessionId: string) {
  set({ loginAlerts: get().loginAlerts.filter((a) => a.sessionId !== sessionId) });
}

/** "That wasn't me": sign that session out everywhere right away. */
export async function revokeSession(sessionId: string) {
  await api.del(`/api/auth/sessions/${encodeURIComponent(sessionId)}`);
  dismissLoginAlert(sessionId);
}

export function getSocket() {
  return socket;
}

// --------------------------------------------------------------------------- helpers for calls (lib/call.ts)
export async function currentChatKey(chatId: string) {
  let chat = get().chats[chatId];
  if (chat.needsRotation) {
    await rotateIfNeeded(chatId);
    chat = get().chats[chatId];
  }
  const key = await keyFor(chatId, chat.currentEpoch);
  if (!key) throw new Error(tr('缺少密钥'));
  return { key, epoch: chat.currentEpoch };
}
export const chatKeyAt = (chatId: string, epoch: number) => keyFor(chatId, epoch);
export async function postCallLog(chatId: string, p: C.CallPayload) {
  await sendMessage(chatId, p);
}

export interface CallSignal {
  chatId: string;
  from: string;
  env: { epoch: number; nonce: string; ciphertext: string; signature: string };
}
let callSignalHandler: ((d: CallSignal) => void) | null = null;
export function setCallSignalHandler(fn: (d: CallSignal) => void) {
  callSignalHandler = fn;
}

// --------------------------------------------------------------------------- extension points (lib/social.ts etc.)
const readyHooks: (() => unknown)[] = [];
const socketHooks: ((s: Socket) => void)[] = [];
/** Run after login / app start (online). */
export function onAppReady(fn: () => unknown) {
  readyHooks.push(fn);
}
/** Attach handlers to every (re)created socket. */
export function onSocket(fn: (s: Socket) => void) {
  socketHooks.push(fn);
}

// --------------------------------------------------------------------------- per-chat notification mute
export const isNotifyOff = (c: Pick<Chat, 'notifyOffUntil'>) => !!c.notifyOffUntil && (c.notifyOffUntil === -1 || c.notifyOffUntil > Date.now());
/** until: ms timestamp, -1 = until turned back on, 0 = turn notifications back on */
export async function setChatNotify(chatId: string, until: number) {
  await api.put(`/api/chats/${chatId}/notify`, { until });
  set((s) => (s.chats[chatId] ? { chats: { ...s.chats, [chatId]: { ...s.chats[chatId], notifyOffUntil: until === 0 ? null : until } } } : {}));
}
/** Mark a chat read without opening it (chat list menu / "mark all read"). */
export async function markChatRead(chatId: string) {
  const chat = get().chats[chatId];
  if (!chat) return;
  set((s) => ({ chats: { ...s.chats, [chatId]: { ...chat, unread: 0, mentioned: false, myLastReadSeq: Math.max(chat.myLastReadSeq, chat.lastSeq) } } }));
  await api.post(`/api/chats/${chatId}/read`, { seq: chat.lastSeq }).catch(() => undefined);
}

// --------------------------------------------------------------------------- group moderation (server-enforced)
export async function setPostPolicy(chatId: string, policy: 'all' | 'admins') {
  await api.patch(`/api/chats/${chatId}`, { postPolicy: policy });
  await refreshChat(chatId);
}
/** until: ms timestamp, -1 = until lifted, 0 = lift now */
export async function muteMember(chatId: string, userId: string, until: number) {
  await api.put(`/api/chats/${chatId}/members/${userId}/mute`, { until });
  await refreshChat(chatId);
}
/** Why I can't post in this chat right now (null = I can). */
export function postBlockedReason(chat: Chat, meId: string): string | null {
  if (chat.type === 'direct' && chat.members.some((m) => m.id !== meId && m.deleted)) return tr('对方已注销账号，无法再发送消息。聊天记录仍然保留。');
  if (chat.type !== 'group' || chat.myRole !== 'member') return null;
  if (chat.postPolicy === 'admins') return tr('本群只有管理员可以发言');
  const m = chat.members.find((x) => x.id === meId);
  if (m?.mutedUntil && m.mutedUntil > Date.now())
    return m.mutedUntil > Date.now() + 365 * 86_400_000 ? tr('你已被管理员禁言') : tr('你已被管理员禁言，{v0} 解除', { v0: new Date(m.mutedUntil).toLocaleString() });
  return null;
}

// --------------------------------------------------------------------------- scan-to-login (device linking)
/** New device: create a link request; `qr` is what the logged-in device must scan. Resolves when approved. */
export async function startLinkLogin(onQr: (qr: string, expiresAt: number) => void, signal: { cancelled: boolean }) {
  const kp = C.linkKeypair();
  const st = await api.post('/api/link/start', { pk: C.b64(kp.pk) });
  onQr(`securechat-link:${st.linkId}:${C.b64(kp.pk)}`, st.expiresAt);
  while (!signal.cancelled && Date.now() < st.expiresAt) {
    await new Promise((r) => setTimeout(r, 2000));
    if (signal.cancelled) return false;
    const r = await api.post(`/api/link/${st.linkId}/poll`, { pollToken: st.pollToken, deviceName: deviceName() });
    if (r.pending) continue;
    const id = C.openSealedIdentity(r.sealed, kp);
    // the keys must really belong to this account
    const keys = (await api.get(`/api/users/${r.user.id}`)).keys;
    if (keys.signPk !== C.b64(id.signPk) || keys.boxPk !== C.b64(id.boxPk)) throw new Error(tr('收到的密钥与账号不匹配，已停止'));
    await saveIdentity(r.user.id, id);
    const me = (await api.get('/api/me')).user;
    await enterApp(me, id);
    return true;
  }
  return false;
}

/** Logged-in device: look up a scanned link QR (to show what will be logged in). */
export async function inspectLink(qr: string) {
  const m = /^securechat-link:([A-Za-z0-9_-]{8,40}):([A-Za-z0-9_-]{40,50})$/.exec(qr.trim());
  if (!m) throw new Error(tr('这不是密聊的登录二维码'));
  const info = await api.get(`/api/link/${m[1]}`);
  if (info.pk !== m[2]) throw new Error(tr('二维码与服务器记录不一致，已拒绝'));
  return { linkId: m[1], pk: m[2], userAgent: info.userAgent as string, ip: info.ip as string };
}
export async function approveLink(linkId: string, pk: string) {
  await api.post(`/api/link/${linkId}/approve`, { sealed: C.sealIdentityTo(pk, identity!) });
}

// --------------------------------------------------------------------------- export helpers
/** Every message of a chat I can still see (oldest first), decrypted locally. */
/** One page (newest first) of messages that carry attachments — for the shared-media page. */
export async function fetchMediaPage(chatId: string, before?: number): Promise<{ messages: Msg[]; hasMore: boolean; next?: number }> {
  const r = await api.get(`/api/chats/${chatId}/messages?media=1&limit=60${before ? `&before=${before}` : ''}`);
  const raw = r.messages as ServerMsg[];
  const messages = (await Promise.all(raw.map(decryptMsg))).reverse();
  return { messages, hasMore: r.hasMore && raw.length > 0, next: raw[0]?.seq };
}

export async function fetchAllMessages(chatId: string, onProgress?: (n: number) => void): Promise<Msg[]> {
  const out: Msg[] = [];
  let before: number | undefined;
  for (;;) {
    const r = await api.get(`/api/chats/${chatId}/messages?limit=100${before ? `&before=${before}` : ''}`);
    const dec = await Promise.all((r.messages as ServerMsg[]).map(decryptMsg));
    out.unshift(...dec);
    onProgress?.(out.length);
    if (!r.hasMore || !r.messages.length) break;
    before = (r.messages as ServerMsg[])[0].seq;
  }
  return out;
}
