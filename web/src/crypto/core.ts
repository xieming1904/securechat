/**
 * End-to-end encryption core. Pure functions on top of libsodium — used by the
 * browser client and by the server test-suite (to act as real clients).
 *
 *  password ──Argon2id──▶ master ──KDF──▶ authKey (sent to server for login)
 *                                   └──▶ encKey  (never leaves the browser; wraps identity backup)
 *  identity = Ed25519 (sign) + X25519 (box)
 *  chat key (per epoch) = 32 random bytes, sealed to each member's X25519 key and signed by distributor
 *  message = XChaCha20-Poly1305(chatKey, pad(json), aad) + Ed25519 signature by sender
 */
import _sodium from 'libsodium-wrappers-sumo';

export type Sodium = typeof _sodium;
let s: Sodium;

export async function ready(): Promise<Sodium> {
  if (!s) {
    await _sodium.ready;
    s = _sodium;
  }
  return s;
}

export const b64 = (u8: Uint8Array): string => s.to_base64(u8, s.base64_variants.URLSAFE_NO_PADDING);
export const unb64 = (str: string): Uint8Array => s.from_base64(str, s.base64_variants.URLSAFE_NO_PADDING);
const utf8 = (str: string) => s.from_string(str);
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Deterministic, length-prefixed binary encoding for associated data / signed context:
 *   tag || for each field: uint32_be(len) || utf8(field)
 * Avoids field-boundary ambiguity of string concatenation.
 */
export const PROTOCOL_VERSION = 1;
export function encodeFields(tag: string, fields: (string | number)[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of [tag, `v${PROTOCOL_VERSION}`, ...fields.map(String)]) {
    const b = utf8(f);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length);
    parts.push(len, b);
  }
  return concat(...parts);
}

// ------------------------------------------------------------------ backup keys
/**
 * Key that encrypts the identity backup, derived from an OPAQUE export key.
 * The export key is only known to a client that knows the password (or recovery words) AND
 * completed OPAQUE with the server — so a stolen database alone can't be brute-forced offline.
 */
export function backupKeyFromExport(exportKeyB64: string, purpose: 'password' | 'recovery'): Uint8Array {
  return s.crypto_generichash(32, concat(encodeFields('sc-backup-key', [purpose]), unb64(exportKeyB64)), null);
}

// ------------------------------------------------------------------ identity
export interface Identity {
  signPk: Uint8Array;
  signSk: Uint8Array;
  boxPk: Uint8Array;
  boxSk: Uint8Array;
}

export function generateIdentity(): Identity {
  const sign = s.crypto_sign_keypair();
  const box = s.crypto_box_keypair();
  return { signPk: sign.publicKey, signSk: sign.privateKey, boxPk: box.publicKey, boxSk: box.privateKey };
}

export function serializeIdentity(id: Identity): string {
  return JSON.stringify({ v: 1, signPk: b64(id.signPk), signSk: b64(id.signSk), boxPk: b64(id.boxPk), boxSk: b64(id.boxSk) });
}
export function deserializeIdentity(json: string): Identity {
  const o = JSON.parse(json);
  return { signPk: unb64(o.signPk), signSk: unb64(o.signSk), boxPk: unb64(o.boxPk), boxSk: unb64(o.boxSk) };
}

const BACKUP_AAD = 'sc-identity-backup-v1';
export function encryptBackup(id: Identity, encKey: Uint8Array) {
  const nonce = s.randombytes_buf(24);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(utf8(serializeIdentity(id)), utf8(BACKUP_AAD), null, nonce, encKey);
  return { backupCt: b64(ct), backupNonce: b64(nonce) };
}
export function decryptBackup(backupCt: string, backupNonce: string, encKey: Uint8Array): Identity {
  const pt = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(backupCt), utf8(BACKUP_AAD), unb64(backupNonce), encKey);
  return deserializeIdentity(s.to_string(pt));
}

// ------------------------------------------------------------------ chat keys
export function newChatKey(): Uint8Array {
  return s.crypto_aead_xchacha20poly1305_ietf_keygen();
}

const keyDistMsg = (chatId: string, epoch: number, membershipVersion: number, recipientId: string, distributorId: string, sealed: Uint8Array) =>
  concat(encodeFields('sc-key', [chatId, epoch, membershipVersion, recipientId, distributorId]), sealed);

export interface SealedKey {
  recipientId: string;
  sealedKey: string;
  signature: string;
}

export interface KeyContext {
  chatId: string;
  epoch: number;
  membershipVersion: number;
  distributorId: string;
}

export function sealChatKey(chatKey: Uint8Array, ctx: KeyContext, recipientId: string, recipientBoxPk: Uint8Array, me: Identity): SealedKey {
  const sealed = s.crypto_box_seal(chatKey, recipientBoxPk);
  const signature = s.crypto_sign_detached(keyDistMsg(ctx.chatId, ctx.epoch, ctx.membershipVersion, recipientId, ctx.distributorId, sealed), me.signSk);
  return { recipientId, sealedKey: b64(sealed), signature: b64(signature) };
}

/** Verify + open a sealed chat key. The caller must separately check that the distributor was a member at that version. */
export function openChatKey(
  entry: { epoch: number; membershipVersion: number; sealedKey: string; signature: string; distributorId: string },
  chatId: string,
  myId: string,
  me: Identity,
  distributorSignPk: Uint8Array,
): Uint8Array {
  const sealed = unb64(entry.sealedKey);
  const msg = keyDistMsg(chatId, entry.epoch, entry.membershipVersion, myId, entry.distributorId, sealed);
  if (!s.crypto_sign_verify_detached(unb64(entry.signature), msg, distributorSignPk)) throw new Error('chat key signature invalid');
  return s.crypto_box_seal_open(sealed, me.boxPk, me.boxSk);
}

// ------------------------------------------------------------------ signed membership
// MUST stay in sync with server/src/membership.ts
export type Role = 'owner' | 'admin' | 'member';
export type MembershipAction = 'create' | 'add' | 'remove' | 'leave' | 'role';
export interface MemberEntry {
  id: string;
  role: Role;
}
export interface MembershipRecord {
  version: number;
  action: MembershipAction;
  actorId: string;
  targets: string[];
  role: string | null;
  signature: string;
}

export function applyMembership(prev: MemberEntry[], action: MembershipAction, actorId: string, targets: string[], role?: string | null): MemberEntry[] {
  const deny = (m: string) => new Error(`membership: ${m}`);
  const find = (id: string) => prev.find((m) => m.id === id);
  const actor = find(actorId);
  switch (action) {
    case 'create': {
      if (prev.length) throw deny('chat already exists');
      if (role === 'direct') {
        if (targets.length !== 1 || targets[0] === actorId) throw deny('direct chat needs exactly one peer');
        return [
          { id: actorId, role: 'member' },
          { id: targets[0], role: 'member' },
        ];
      }
      if (role !== 'group') throw deny('bad chat type');
      if (new Set(targets).size !== targets.length || targets.includes(actorId)) throw deny('duplicate members');
      return [{ id: actorId, role: 'owner' }, ...targets.map((id) => ({ id, role: 'member' as Role }))];
    }
    case 'add': {
      if (!actor || actor.role === 'member') throw deny('only owner/admin can add');
      if (!targets.length || new Set(targets).size !== targets.length || targets.some((t) => find(t))) throw deny('invalid targets');
      return [...prev, ...targets.map((id) => ({ id, role: 'member' as Role }))];
    }
    case 'remove': {
      if (targets.length !== 1) throw deny('remove one member at a time');
      const target = find(targets[0]);
      if (!actor || actor.role === 'member' || !target || target.id === actorId) throw deny('not allowed to remove');
      if (target.role === 'owner' || (target.role === 'admin' && actor.role !== 'owner')) throw deny('not allowed to remove');
      return prev.filter((m) => m.id !== target.id);
    }
    case 'leave': {
      if (!actor || targets.length !== 1 || targets[0] !== actorId) throw deny('invalid leave');
      const rest = prev.filter((m) => m.id !== actorId);
      if (actor.role === 'owner' && rest.length && !rest.some((m) => m.role === 'owner')) {
        const heir = rest.find((m) => m.role === 'admin') ?? rest[0];
        return rest.map((m) => (m.id === heir.id ? { ...m, role: 'owner' as Role } : m));
      }
      return rest;
    }
    case 'role': {
      if (targets.length !== 1 || (role !== 'admin' && role !== 'member')) throw deny('invalid role change');
      const target = find(targets[0]);
      if (!actor || actor.role !== 'owner' || !target || target.id === actorId) throw deny('only the owner can change roles');
      return prev.map((m) => (m.id === target.id ? { ...m, role: role as Role } : m));
    }
    default:
      throw deny('unknown action');
  }
}

export function membershipMessage(chatId: string, version: number, action: MembershipAction, actorId: string, targets: string[], role: string | null | undefined, result: MemberEntry[]) {
  return encodeFields('sc-members', [chatId, version, action, actorId, targets.join(','), role ?? '', ...result.map((m) => `${m.id}:${m.role}`)]);
}

/** Sign a membership change; returns the signature and the resulting member list. */
export function signMembership(
  chatId: string,
  version: number,
  prev: MemberEntry[],
  action: MembershipAction,
  me: { id: string; identity: Identity },
  targets: string[],
  role?: string | null,
) {
  const result = applyMembership(prev, action, me.id, targets, role);
  const signature = b64(s.crypto_sign_detached(membershipMessage(chatId, version, action, me.id, targets, role, result), me.identity.signSk));
  return { signature, result };
}

/**
 * Replay a chat's signed membership log from the start. Throws if any record is out of order,
 * breaks the rules, or carries a bad signature. Returns the member list after every version.
 */
export async function verifyMembershipChain(chatId: string, log: MembershipRecord[], signPkOf: (userId: string) => Promise<Uint8Array>) {
  let members: MemberEntry[] = [];
  const history = new Map<number, MemberEntry[]>();
  for (let i = 0; i < log.length; i++) {
    const r = log[i];
    if (r.version !== i + 1) throw new Error('membership log has gaps');
    if ((i === 0) !== (r.action === 'create')) throw new Error('membership log must start with create');
    const next = applyMembership(members, r.action, r.actorId, r.targets, r.role);
    const ok = s.crypto_sign_verify_detached(unb64(r.signature), membershipMessage(chatId, r.version, r.action, r.actorId, r.targets, r.role, next), await signPkOf(r.actorId));
    if (!ok) throw new Error(`membership record v${r.version} has a bad signature`);
    members = next;
    history.set(r.version, members);
  }
  return { members, history, version: log.length };
}

// ------------------------------------------------------------------ messages
export type FileKind = 'image' | 'video' | 'audio' | 'voice' | 'file';
export interface FilePayload {
  t: 'file';
  kind: FileKind;
  blobId: string;
  key: string; // secretstream key (base64url)
  header: string; // secretstream header (base64url)
  chunk: number; // plaintext chunk size
  name: string;
  mime: string;
  size: number; // plaintext bytes
  w?: number;
  h?: number;
  duration?: number; // seconds (audio/video/voice)
  thumb?: string; // small JPEG data: URL (images/videos)
  caption?: string;
  /** shown as a sticker (no bubble, small) */
  sticker?: boolean;
  replyTo?: string;
  fwd?: string;
  mentions?: string[];
}
export type Payload =
  | { t: 'text'; text: string; replyTo?: string; fwd?: string; mentions?: string[]; preview?: LinkPreview }
  | FilePayload
  | PollPayload
  | BundlePayload
  | CallPayload
  | { t: 'system'; text: string };

/** Call log entry, posted by the caller when a call ends. */
export interface CallPayload {
  t: 'call';
  video: boolean;
  /** seconds; 0 = not answered */
  duration: number;
  outcome: 'answered' | 'missed' | 'rejected' | 'cancelled' | 'failed';
  /** group call: how many people took part (at most at once) */
  group?: number;
  replyTo?: string;
  fwd?: string;
  mentions?: string[];
}

/** One message inside a merged forward ("chat history"). */
export interface BundleItem {
  from: string; // display name at the time of forwarding
  at: number; // original send time
  p: Exclude<Payload, BundlePayload | CallPayload | { t: 'system'; text: string }> | { t: 'bundle'; title: string; n: number };
}
export interface BundlePayload {
  t: 'bundle';
  title: string;
  items: BundleItem[];
  replyTo?: string;
  fwd?: string;
  mentions?: string[];
}

export interface LinkPreview {
  url: string;
  title: string;
  desc?: string;
  site?: string;
  /** small JPEG thumbnail re-encoded by the sender's browser (data: URL) */
  img?: string;
}

export interface PollPayload {
  t: 'poll';
  q: string;
  options: string[];
  multi: boolean;
  closed?: boolean;
  replyTo?: string;
  fwd?: string;
  mentions?: string[];
}

export interface EncryptedMessage {
  nonce: string;
  ciphertext: string;
  signature: string;
}

const msgAad = (chatId: string, epoch: number, senderId: string, clientMsgId: string) => encodeFields('sc-msg', [chatId, epoch, senderId, clientMsgId]);

export function encryptMessage(
  payload: Payload,
  chatKey: Uint8Array,
  meta: { chatId: string; epoch: number; senderId: string; clientMsgId: string },
  me: Identity,
): EncryptedMessage {
  const aad = msgAad(meta.chatId, meta.epoch, meta.senderId, meta.clientMsgId);
  const nonce = s.randombytes_buf(24);
  const padded = s.pad(utf8(JSON.stringify(payload)), 256); // hide exact length
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(padded, aad, null, nonce, chatKey);
  const signature = s.crypto_sign_detached(concat(nonce, ct, aad), me.signSk);
  return { nonce: b64(nonce), ciphertext: b64(ct), signature: b64(signature) };
}

export function decryptMessage(
  msg: { chatId: string; epoch: number; senderId: string; clientMsgId: string; nonce: string; ciphertext: string; signature: string },
  chatKey: Uint8Array,
  senderSignPk: Uint8Array,
): Payload {
  const aad = msgAad(msg.chatId, msg.epoch, msg.senderId, msg.clientMsgId);
  const nonce = unb64(msg.nonce);
  const ct = unb64(msg.ciphertext);
  if (!s.crypto_sign_verify_detached(unb64(msg.signature), concat(nonce, ct, aad), senderSignPk)) throw new Error('message signature invalid');
  const padded = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, chatKey);
  const p = validatePayload(JSON.parse(s.to_string(s.unpad(padded, 256))));
  if (!p) throw new Error('malformed payload');
  return p;
}

// ------------------------------------------------------------------ payload validation
// Decrypted payloads come from other (possibly malicious) chat members: check the shape before the UI touches them.
const isStr = (x: unknown, max = 100_000): x is string => typeof x === 'string' && x.length <= max;
const optStr = (x: unknown, max = 200) => x === undefined || isStr(x, max);
const isNum = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
const optStrArr = (x: unknown) => x === undefined || (Array.isArray(x) && x.length <= 100 && x.every((y) => isStr(y, 100)));

function validPreview(x: unknown): boolean {
  if (x === undefined) return true;
  const o = x as Record<string, unknown>;
  return !!o && typeof o === 'object' && isStr(o.url, 2048) && isStr(o.title, 500) && optStr(o.desc, 1000) && optStr(o.site, 200) && optStr(o.img, 200_000);
}

function validFile(o: Record<string, unknown>): boolean {
  return (
    ['image', 'video', 'audio', 'voice', 'file'].includes(o.kind as string) &&
    isStr(o.blobId, 100) &&
    isStr(o.key, 100) &&
    isStr(o.header, 100) &&
    isNum(o.chunk) &&
    (o.chunk as number) > 0 &&
    (o.chunk as number) <= 16 * 1024 * 1024 &&
    isStr(o.name, 1000) &&
    isStr(o.mime, 200) &&
    isNum(o.size) &&
    (o.size as number) >= 0 &&
    (o.w === undefined || isNum(o.w)) &&
    (o.h === undefined || isNum(o.h)) &&
    (o.duration === undefined || isNum(o.duration)) &&
    optStr(o.thumb, 200_000) &&
    optStr(o.caption, 20_000) &&
    (o.sticker === undefined || typeof o.sticker === 'boolean')
  );
}

function validInner(o: Record<string, unknown>, depth: number): boolean {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  switch (o.t) {
    case 'text':
      return isStr(o.text) && validPreview(o.preview);
    case 'file':
      return validFile(o);
    case 'poll':
      return (
        isStr(o.q, 1000) &&
        Array.isArray(o.options) &&
        o.options.length >= 2 &&
        o.options.length <= 16 &&
        o.options.every((x) => isStr(x, 500)) &&
        typeof o.multi === 'boolean' &&
        (o.closed === undefined || typeof o.closed === 'boolean')
      );
    case 'bundle':
      if (depth > 0) return isStr(o.title, 500) && isNum(o.n);
      return (
        isStr(o.title, 500) &&
        Array.isArray(o.items) &&
        o.items.length <= 200 &&
        o.items.every((it: Record<string, unknown>) => it && typeof it === 'object' && isStr(it.from, 200) && isNum(it.at) && validInner(it.p as Record<string, unknown>, 1))
      );
    case 'call':
      return (
        typeof o.video === 'boolean' &&
        isNum(o.duration) &&
        ['answered', 'missed', 'rejected', 'cancelled', 'failed'].includes(o.outcome as string) &&
        (o.group === undefined || (isNum(o.group) && (o.group as number) <= 50))
      );
    case 'system':
      return isStr(o.text, 2000);
    default:
      return false;
  }
}

export function validatePayload(x: unknown): Payload | null {
  const o = x as Record<string, unknown>;
  if (!validInner(o, 0)) return null;
  if (!optStr(o.replyTo, 100) || !optStr(o.fwd, 200) || !optStrArr(o.mentions)) return null;
  return o as unknown as Payload;
}

// ------------------------------------------------------------------ group titles
export function encryptTitle(title: string, chatKey: Uint8Array, chatId: string, epoch: number): string {
  const nonce = s.randombytes_buf(24);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(utf8(title), encodeFields('sc-title', [chatId]), null, nonce, chatKey);
  return JSON.stringify({ e: epoch, n: b64(nonce), c: b64(ct) });
}
export function decryptTitle(titleCt: string, chatId: string, keyForEpoch: (epoch: number) => Uint8Array | undefined): string | null {
  try {
    const o = JSON.parse(titleCt);
    const key = keyForEpoch(o.e);
    if (!key) return null;
    return s.to_string(s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(o.c), encodeFields('sc-title', [chatId]), unb64(o.n), key));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ signed chat settings (title, disappearing timer)
/**
 * Settings are a record signed by the admin (or, in a direct chat, the participant) who changed them, then
 * encrypted with the chat key in the `titleCt` slot. After a key rotation any member may re-encrypt the SAME
 * signed record under the new key, but only an admin can produce a new valid one. `v` only ever goes up, so a
 * server can't roll the settings back to an older signed version without clients noticing.
 */
export interface ChatSettings {
  v: number;
  title: string;
  disappearing: number;
  at: number;
  by: string;
  /** membership version the signer was an admin at */
  mv?: number;
  /** group announcement */
  ann?: string;
  /** group avatar (encrypted picture in the group; key here, so it is covered by the admin signature) */
  av?: AvatarRef;
}
export interface AvatarRef {
  blobId: string;
  key: string;
  header: string;
}
const validAvatarRef = (x: unknown): x is AvatarRef =>
  !!x && typeof x === 'object' && typeof (x as AvatarRef).blobId === 'string' && typeof (x as AvatarRef).key === 'string' && typeof (x as AvatarRef).header === 'string';
export const settingsHash = (recJson: string) => b64(s.crypto_generichash(16, utf8(recJson), null));
const settingsSigMsg = (chatId: string, recJson: string) => concat(encodeFields('sc-settings', [chatId]), utf8(recJson));

export function sealSettings(rec: ChatSettings, me: Identity, chatKey: Uint8Array, chatId: string, epoch: number): string {
  const r = JSON.stringify(rec);
  const sig = b64(s.crypto_sign_detached(settingsSigMsg(chatId, r), me.signSk));
  return encryptTitle(JSON.stringify({ s: 1, r, sig }), chatKey, chatId, epoch);
}

export type OpenedSettings = { kind: 'legacy'; title: string; raw: string } | { kind: 'signed'; rec: ChatSettings; recJson: string; sig: string; raw: string };

export function openSettings(titleCt: string, chatId: string, keyForEpoch: (epoch: number) => Uint8Array | undefined): OpenedSettings | null {
  const raw = decryptTitle(titleCt, chatId, keyForEpoch);
  if (raw === null) return null;
  if (raw.startsWith('{"s":1')) {
    try {
      const o = JSON.parse(raw);
      const rec = JSON.parse(o.r) as ChatSettings;
      if (typeof rec.v !== 'number' || typeof rec.by !== 'string' || typeof rec.disappearing !== 'number') return null;
      return { kind: 'signed', rec: { ...rec, title: String(rec.title ?? '') }, recJson: o.r, sig: o.sig, raw };
    } catch {
      return null;
    }
  }
  return { kind: 'legacy', title: raw, raw };
}

export function verifySettings(o: { recJson: string; sig: string }, chatId: string, signPk: Uint8Array): boolean {
  try {
    return s.crypto_sign_verify_detached(unb64(o.sig), settingsSigMsg(chatId, o.recJson), signPk);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ safety number
/** 60-digit number both sides can compare out-of-band (12 groups of 5). */
export function safetyNumber(aId: string, aSignPk: Uint8Array, bId: string, bSignPk: Uint8Array): string {
  const [x, y] = aId < bId ? [[aId, aSignPk] as const, [bId, bSignPk] as const] : [[bId, bSignPk] as const, [aId, aSignPk] as const];
  const h = s.crypto_generichash(60, concat(utf8(`sc-safety|${x[0]}|`), x[1], utf8(`|${y[0]}|`), y[1]), null);
  const groups: string[] = [];
  for (let i = 0; i < 60; i += 5) {
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + h[i + j];
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

export function randomId(): string {
  return b64(s.randombytes_buf(12));
}

/** 128-bit random message id (anti-replay: server enforces uniqueness per chat + sender). */
export function newClientMsgId(): string {
  return b64(s.randombytes_buf(16));
}

// ------------------------------------------------------------------ attachments
export const FILE_CHUNK = 64 * 1024;

/** Encrypt a whole file with a fresh key (XChaCha20-Poly1305 secretstream, 64 KiB chunks). */
/**
 * Padmé (Nikitin et al.): round a length up so that it leaks only O(log log n) bits, at most ~12% overhead.
 * v0.9: attachments are padded with zeros before encryption; readers cut them back to the payload's `size`.
 */
export function padme(len: number): number {
  if (len < 2) return len;
  const e = Math.floor(Math.log2(len));
  const s2 = Math.floor(Math.log2(e)) + 1;
  const lastBits = e - s2;
  const mask = 2 ** lastBits - 1;
  return Math.floor((len + mask) / (mask + 1)) * (mask + 1);
}
export function padAttachment(data: Uint8Array): Uint8Array {
  const n = padme(Math.max(data.length, 1024));
  if (n === data.length) return data;
  const out = new Uint8Array(n);
  out.set(data);
  return out;
}
/** Cut a decrypted attachment back to its real size (v0.9 padding; older, unpadded files are unchanged). */
export const unpadAttachment = (pt: Uint8Array, size: number | undefined) => (typeof size === 'number' && size >= 0 && pt.length > size ? pt.subarray(0, size) : pt);

export function encryptFile(data: Uint8Array) {
  const key = s.crypto_secretstream_xchacha20poly1305_keygen();
  const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(key);
  const n = Math.max(1, Math.ceil(data.length / FILE_CHUNK));
  const out = new Uint8Array(data.length + n * s.crypto_secretstream_xchacha20poly1305_ABYTES);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const chunk = data.subarray(i * FILE_CHUNK, Math.min(data.length, (i + 1) * FILE_CHUNK));
    const tag = i === n - 1 ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    const c = s.crypto_secretstream_xchacha20poly1305_push(state, chunk, null, tag);
    out.set(c, o);
    o += c.length;
  }
  return { key: b64(key), header: b64(header), chunk: FILE_CHUNK, ciphertext: out };
}

/** Decrypt a file; throws if any chunk was modified, reordered or the stream was truncated. */
export function decryptFile(ct: Uint8Array, keyB64: string, headerB64: string, chunk = FILE_CHUNK): Uint8Array {
  const state = s.crypto_secretstream_xchacha20poly1305_init_pull(unb64(headerB64), unb64(keyB64));
  const cchunk = chunk + s.crypto_secretstream_xchacha20poly1305_ABYTES;
  const n = Math.ceil(ct.length / cchunk);
  const out = new Uint8Array(ct.length - n * s.crypto_secretstream_xchacha20poly1305_ABYTES);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const r = s.crypto_secretstream_xchacha20poly1305_pull(state, ct.subarray(i * cchunk, Math.min(ct.length, (i + 1) * cchunk)), null);
    if (!r) throw new Error('attachment corrupted');
    const last = i === n - 1;
    if (last !== (r.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL)) throw new Error('attachment truncated');
    out.set(r.message, o);
    o += r.message.length;
  }
  return out;
}

/** Streaming variant of encryptFile (same format), for files too large to hold in memory. */
export function fileEncryptor() {
  const key = s.crypto_secretstream_xchacha20poly1305_keygen();
  const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(key);
  return {
    key: b64(key),
    header: b64(header),
    chunk: FILE_CHUNK,
    /** push exactly FILE_CHUNK bytes (the last chunk may be shorter; mark it last) */
    push(plain: Uint8Array, last: boolean) {
      const tag = last ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
      return s.crypto_secretstream_xchacha20poly1305_push(state, plain, null, tag);
    },
  };
}

/**
 * The same secretstream push (byte-for-byte compatible with libsodium's crypto_secretstream_xchacha20poly1305), but with
 * a state that can be saved and restored — so a large upload can continue after a page reload without re-uploading.
 * Built from libsodium primitives (HChaCha20, ChaCha20-IETF, Poly1305) exactly as in secretstream/xchacha20poly1305.c.
 */
/** Incremental BLAKE2b (for checking a re-picked file matches what was being uploaded). */
export function hasher() {
  const st = s.crypto_generichash_init(null, 32);
  return {
    update: (b: Uint8Array) => s.crypto_generichash_update(st, b),
    digest: () => b64(s.crypto_generichash_final(st, 32)),
  };
}

export interface StreamState {
  /** subkey (b64) */
  k: string;
  /** 12-byte nonce: 4-byte LE counter || 8-byte inonce (b64) */
  n: string;
}
export function resumableEncryptor(resume?: { key: string; header: string; state: StreamState }) {
  let key: Uint8Array;
  let header: Uint8Array;
  let k: Uint8Array;
  let nonce: Uint8Array;
  if (resume) {
    key = unb64(resume.key);
    header = unb64(resume.header);
    k = unb64(resume.state.k);
    nonce = unb64(resume.state.n);
    if (k.length !== 32 || nonce.length !== 12) throw new Error('bad stream state');
  } else {
    key = s.crypto_secretstream_xchacha20poly1305_keygen();
    header = s.randombytes_buf(24);
    k = s.crypto_core_hchacha20(header.subarray(0, 16), key, null);
    nonce = new Uint8Array(12);
    nonce[0] = 1; // counter = 1
    nonce.set(header.subarray(16, 24), 4);
  }
  const pad0 = new Uint8Array(16);
  return {
    key: b64(key),
    header: b64(header),
    chunk: FILE_CHUNK,
    state: (): StreamState => ({ k: b64(k), n: b64(nonce) }),
    push(m: Uint8Array, last: boolean) {
      const tag = last ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
      const block0 = s.crypto_stream_chacha20_ietf_xor_ic(new Uint8Array(64), nonce, 0, k);
      const st = s.crypto_onetimeauth_init(block0.subarray(0, 32));
      const block = new Uint8Array(64);
      block[0] = tag;
      const eblock = s.crypto_stream_chacha20_ietf_xor_ic(block, nonce, 1, k);
      s.crypto_onetimeauth_update(st, eblock);
      const out = new Uint8Array(1 + m.length + 16);
      out[0] = eblock[0];
      const c = s.crypto_stream_chacha20_ietf_xor_ic(m, nonce, 2, k);
      out.set(c, 1);
      s.crypto_onetimeauth_update(st, c);
      // libsodium pads with (0x10 - sizeof(block) + mlen) & 0xf bytes, i.e. mlen & 0xf (kept as-is for compatibility)
      const padLen = m.length & 0xf;
      if (padLen) s.crypto_onetimeauth_update(st, pad0.subarray(0, padLen));
      const lens = new Uint8Array(16);
      const dv = new DataView(lens.buffer);
      dv.setUint32(0, 0, true); // adlen = 0
      dv.setUint32(8, (64 + m.length) >>> 0, true);
      dv.setUint32(12, Math.floor((64 + m.length) / 2 ** 32), true);
      s.crypto_onetimeauth_update(st, lens);
      const mac = s.crypto_onetimeauth_final(st);
      out.set(mac, 1 + m.length);
      for (let i = 0; i < 8; i++) nonce[4 + i] ^= mac[i];
      // counter++ (LE, 32-bit); libsodium rekeys when it wraps — never reached for files up to 2 GB (32k chunks)
      for (let i = 0; i < 4; i++) {
        nonce[i] = (nonce[i] + 1) & 0xff;
        if (nonce[i] !== 0) break;
      }
      if (nonce[0] === 0 && nonce[1] === 0 && nonce[2] === 0 && nonce[3] === 0) throw new Error('stream too long');
      return out;
    },
  };
}

/** Streaming variant of decryptFile. Feed whole ciphertext chunks in order; `done()` checks the stream was not truncated. */
export function fileDecryptor(keyB64: string, headerB64: string, chunk = FILE_CHUNK) {
  const state = s.crypto_secretstream_xchacha20poly1305_init_pull(unb64(headerB64), unb64(keyB64));
  let final = false;
  return {
    cchunk: chunk + s.crypto_secretstream_xchacha20poly1305_ABYTES,
    pull(ct: Uint8Array): Uint8Array {
      if (final) throw new Error('attachment has trailing data');
      const r = s.crypto_secretstream_xchacha20poly1305_pull(state, ct, null);
      if (!r) throw new Error('attachment corrupted');
      final = r.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
      return r.message;
    },
    done() {
      if (!final) throw new Error('attachment truncated');
    },
  };
}

/** Ciphertext size of a plaintext of `n` bytes. */
export const fileCtSize = (n: number, chunk = FILE_CHUNK) => n + Math.max(1, Math.ceil(n / chunk)) * s.crypto_secretstream_xchacha20poly1305_ABYTES;

// ------------------------------------------------------------------ reactions
const reactionAad = (m: { chatId: string; messageId: string; userId: string; epoch: number }) => encodeFields('sc-react', [m.chatId, m.messageId, m.userId, m.epoch]);

export function encryptReaction(emoji: string, chatKey: Uint8Array, meta: { chatId: string; messageId: string; userId: string; epoch: number }, me: Identity) {
  const aad = reactionAad(meta);
  const nonce = s.randombytes_buf(24);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(s.pad(utf8(emoji), 32), aad, null, nonce, chatKey);
  const signature = s.crypto_sign_detached(concat(nonce, ct, aad), me.signSk);
  return { epoch: meta.epoch, nonce: b64(nonce), ciphertext: b64(ct), signature: b64(signature) };
}

export function decryptReaction(
  r: { userId: string; epoch: number; nonce: string; ciphertext: string; signature: string },
  chatKey: Uint8Array,
  chatId: string,
  messageId: string,
  signPk: Uint8Array,
): string {
  const aad = reactionAad({ chatId, messageId, userId: r.userId, epoch: r.epoch });
  const nonce = unb64(r.nonce);
  const ct = unb64(r.ciphertext);
  if (!s.crypto_sign_verify_detached(unb64(r.signature), concat(nonce, ct, aad), signPk)) throw new Error('reaction signature invalid');
  return s.to_string(s.unpad(s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, chatKey), 32));
}

// ------------------------------------------------------------------ poll votes (option indexes, encrypted like reactions)
const voteAad = (m: { chatId: string; messageId: string; userId: string; epoch: number }) => encodeFields('sc-vote', [m.chatId, m.messageId, m.userId, m.epoch]);

export function encryptVote(choice: number[], chatKey: Uint8Array, meta: { chatId: string; messageId: string; userId: string; epoch: number }, me: Identity) {
  const aad = voteAad(meta);
  const nonce = s.randombytes_buf(24);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(s.pad(utf8(JSON.stringify(choice)), 64), aad, null, nonce, chatKey);
  const signature = s.crypto_sign_detached(concat(nonce, ct, aad), me.signSk);
  return { epoch: meta.epoch, nonce: b64(nonce), ciphertext: b64(ct), signature: b64(signature) };
}

export function decryptVote(
  r: { userId: string; epoch: number; nonce: string; ciphertext: string; signature: string },
  chatKey: Uint8Array,
  chatId: string,
  messageId: string,
  signPk: Uint8Array,
): number[] {
  const aad = voteAad({ chatId, messageId, userId: r.userId, epoch: r.epoch });
  const nonce = unb64(r.nonce);
  const ct = unb64(r.ciphertext);
  if (!s.crypto_sign_verify_detached(unb64(r.signature), concat(nonce, ct, aad), signPk)) throw new Error('vote signature invalid');
  const v = JSON.parse(s.to_string(s.unpad(s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, chatKey), 64)));
  if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x) && x >= 0 && x < 16)) throw new Error('bad vote');
  return [...new Set(v as number[])];
}

// ------------------------------------------------------------------ drafts (only my own devices can read them)
const draftKey = (me: Identity) => s.crypto_generichash(32, concat(utf8('sc-draft-key|'), me.boxSk), null);
const draftAad = (userId: string, chatId: string) => encodeFields('sc-draft', [userId, chatId]);

export interface DraftData {
  text: string;
  replyTo?: string;
}

export function encryptDraft(d: DraftData, me: Identity, userId: string, chatId: string) {
  const nonce = s.randombytes_buf(24);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(s.pad(utf8(JSON.stringify(d)), 128), draftAad(userId, chatId), null, nonce, draftKey(me));
  return { nonce: b64(nonce), ciphertext: b64(ct) };
}

export function decryptDraft(r: { nonce: string; ciphertext: string }, me: Identity, userId: string, chatId: string): DraftData {
  const pt = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(r.ciphertext), draftAad(userId, chatId), unb64(r.nonce), draftKey(me));
  const d = JSON.parse(s.to_string(s.unpad(pt, 128)));
  return { text: String(d.text ?? ''), ...(typeof d.replyTo === 'string' ? { replyTo: d.replyTo } : {}) };
}

// ------------------------------------------------------------------ call signalling (encrypted + signed, relayed by the server)
const signalAad = (m: { chatId: string; from: string; to: string; epoch: number }) => encodeFields('sc-call', [m.chatId, m.from, m.to, m.epoch]);

// ------------------------------------------------------------------ avatar key envelopes (per chat, encrypted + signed)
const avatarAad = (m: { chatId: string; userId: string; epoch: number; v: number }) => encodeFields('sc-avatar', [m.chatId, m.userId, m.epoch, m.v]);
export function sealAvatarKey(ref: AvatarRef, chatKey: Uint8Array, meta: { chatId: string; userId: string; epoch: number; v: number }, me: Identity) {
  const aad = avatarAad(meta);
  const nonce = s.randombytes_buf(24);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(utf8(JSON.stringify(ref)), aad, null, nonce, chatKey);
  return { nonce: b64(nonce), ciphertext: b64(ct), signature: b64(s.crypto_sign_detached(concat(nonce, ct, aad), me.signSk)) };
}
export function openAvatarKey(
  env: { nonce: string; ciphertext: string; signature: string },
  chatKey: Uint8Array,
  meta: { chatId: string; userId: string; epoch: number; v: number },
  ownerSignPk: Uint8Array,
): AvatarRef {
  const aad = avatarAad(meta);
  const nonce = unb64(env.nonce);
  const ct = unb64(env.ciphertext);
  if (!s.crypto_sign_verify_detached(unb64(env.signature), concat(nonce, ct, aad), ownerSignPk)) throw new Error('avatar signature invalid');
  const o = JSON.parse(s.to_string(s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, chatKey)));
  if (!validAvatarRef(o)) throw new Error('bad avatar key');
  return o;
}
export const isAvatarRef = validAvatarRef;

export function encryptSignal(data: unknown, chatKey: Uint8Array, meta: { chatId: string; from: string; to: string; epoch: number }, me: Identity) {
  const aad = signalAad(meta);
  const nonce = s.randombytes_buf(24);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(utf8(JSON.stringify({ ...(data as object), ts: Date.now() })), aad, null, nonce, chatKey);
  const signature = s.crypto_sign_detached(concat(nonce, ct, aad), me.signSk);
  return { epoch: meta.epoch, nonce: b64(nonce), ciphertext: b64(ct), signature: b64(signature) };
}

export function decryptSignal<T>(
  env: { epoch: number; nonce: string; ciphertext: string; signature: string },
  chatKey: Uint8Array,
  meta: { chatId: string; from: string; to: string },
  fromSignPk: Uint8Array,
): T {
  const aad = signalAad({ ...meta, epoch: env.epoch });
  const nonce = unb64(env.nonce);
  const ct = unb64(env.ciphertext);
  if (!s.crypto_sign_verify_detached(unb64(env.signature), concat(nonce, ct, aad), fromSignPk)) throw new Error('signal signature invalid');
  const o = JSON.parse(s.to_string(s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, chatKey)));
  if (typeof o.ts !== 'number' || Math.abs(Date.now() - o.ts) > 5 * 60_000) throw new Error('stale signal');
  // v0.8: within the 5-minute window, each signal is accepted once (a replayed copy is dropped)
  const t = Date.now();
  const id = env.nonce;
  if (seenSignals.has(id)) throw new Error('replayed signal');
  seenSignals.set(id, t);
  if (seenSignals.size > 5000) for (const [k, at] of seenSignals) if (t - at > 6 * 60_000) seenSignals.delete(k);
  return o as T;
}
const seenSignals = new Map<string, number>();

// ------------------------------------------------------------------ personal vault (contact notes, saved messages, stickers)
const vaultKey = (me: Identity) => s.crypto_generichash(32, concat(utf8('sc-vault-key|'), me.boxSk), null);
const vaultAad = (userId: string, kind: string, id: string) => encodeFields('sc-vault', [userId, kind, id]);

export function encryptVault(obj: unknown, me: Identity, userId: string, kind: string, id: string) {
  const nonce = s.randombytes_buf(24);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(s.pad(utf8(JSON.stringify(obj)), 256), vaultAad(userId, kind, id), null, nonce, vaultKey(me));
  return { nonce: b64(nonce), ciphertext: b64(ct) };
}

export function decryptVault<T>(r: { nonce: string; ciphertext: string }, me: Identity, userId: string, kind: string, id: string): T {
  const pt = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(r.ciphertext), vaultAad(userId, kind, id), unb64(r.nonce), vaultKey(me));
  return JSON.parse(s.to_string(s.unpad(pt, 256))) as T;
}

// ------------------------------------------------------------------ device linking (scan to log in)
export function linkKeypair() {
  const kp = s.crypto_box_keypair();
  return { pk: kp.publicKey, sk: kp.privateKey };
}
/** Seal my identity keys to the new device's ephemeral key (only that device can open it). */
export function sealIdentityTo(pkB64: string, id: Identity) {
  return b64(s.crypto_box_seal(utf8(serializeIdentity(id)), unb64(pkB64)));
}
/** 6-digit code derived from the new device's key: shown there, typed on the approving device. */
export function linkCode(pkB64: string) {
  const h = s.crypto_generichash(8, concat(utf8('sc-link-code|'), unb64(pkB64)), null);
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}
export function openSealedIdentity(sealedB64: string, kp: { pk: Uint8Array; sk: Uint8Array }): Identity {
  return deserializeIdentity(s.to_string(s.crypto_box_seal_open(unb64(sealedB64), kp.pk, kp.sk)));
}

// ------------------------------------------------------------------ passphrase-encrypted archives (chat export)
export const ARCHIVE_MAGIC = 'SCARCHIVE1';
/** Encrypt bytes with a passphrase: Argon2id (moderate) → XChaCha20-Poly1305 secretstream. */
const ARCHIVE_OPS = 3;
const ARCHIVE_MEM = 128 * 1024 * 1024;
/** Encrypt bytes with a passphrase: Argon2id (3 passes, 128 MiB) → XChaCha20-Poly1305 secretstream. */
export function sealArchive(data: Uint8Array, passphrase: string) {
  const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
  const key = s.crypto_pwhash(32, passphrase, salt, ARCHIVE_OPS, ARCHIVE_MEM, s.crypto_pwhash_ALG_ARGON2ID13);
  const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(key);
  const parts: Uint8Array[] = [];
  const n = Math.max(1, Math.ceil(data.length / FILE_CHUNK));
  for (let i = 0; i < n; i++)
    parts.push(s.crypto_secretstream_xchacha20poly1305_push(state, data.subarray(i * FILE_CHUNK, (i + 1) * FILE_CHUNK), null, i === n - 1 ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE));
  const head = utf8(JSON.stringify({ magic: ARCHIVE_MAGIC, kdf: 'argon2id13', ops: ARCHIVE_OPS, mem: ARCHIVE_MEM, salt: b64(salt), header: b64(header), chunk: FILE_CHUNK }) + '\n');
  return concat(head, ...parts);
}
export function openArchive(file: Uint8Array, passphrase: string): Uint8Array {
  const nl = file.indexOf(10);
  if (nl < 0 || nl > 4096) throw new Error('not an archive');
  const h = JSON.parse(s.to_string(file.subarray(0, nl)));
  if (h.magic !== ARCHIVE_MAGIC) throw new Error('not an archive');
  // parameters come from the file: accept only sane bounds (no memory bombs, no trivially weak settings)
  const ops = h.ops ?? s.crypto_pwhash_OPSLIMIT_INTERACTIVE;
  const mem = h.mem ?? s.crypto_pwhash_MEMLIMIT_INTERACTIVE;
  if (!(ops >= 2 && ops <= 10 && mem >= 64 * 1024 * 1024 && mem <= 512 * 1024 * 1024)) throw new Error('bad archive parameters');
  if (h.chunk !== FILE_CHUNK) throw new Error('bad archive parameters');
  const key = s.crypto_pwhash(32, passphrase, unb64(h.salt), ops, mem, s.crypto_pwhash_ALG_ARGON2ID13);
  return decryptFile(file.subarray(nl + 1), b64(key), h.header, h.chunk);
}
