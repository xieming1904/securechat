/**
 * Secret chats (v0.8): per-device keys, X3DH key agreement and the Double Ratchet with header encryption.
 *
 * Follows the Signal specifications (X3DH; Double Ratchet §3.5 "header encryption"), built only from libsodium:
 *   DH       X25519 (crypto_scalarmult), all-zero outputs rejected
 *   KDF_RK   BLAKE2b-512 keyed with the root key → (root key, chain key, next header key)
 *   KDF_CK   BLAKE2b keyed with the chain key, constants 0x01 (message key) / 0x02 (next chain key)
 *   AEAD     XChaCha20-Poly1305 (random 24-byte nonce) for headers and messages
 *   signing  Ed25519: the account key signs the device certificate, the device key signs its signed prekey
 *
 * Everything here is pure: state goes in, new state comes out. Decryption works on a copy, so a failed or forged
 * message never changes the stored state. Randomness can be injected (tests compare this module byte for byte with an
 * independently written reference implementation).
 */
import _sodium from 'libsodium-wrappers-sumo';
import { b64, unb64, encodeFields } from './core';

const S = () => _sodium;
const utf8 = (x: string) => S().from_string(x);
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && S().memcmp(a, b);

/** Source of randomness (tests inject a deterministic one). */
export interface Rng {
  bytes(n: number): Uint8Array;
}
export const sysRng: Rng = { bytes: (n) => S().randombytes_buf(n) };

export const MAX_SKIP = 1000; // per chain
export const MAX_SKIPPED_TOTAL = 2000;
export const SKIPPED_TTL_MS = 7 * 86_400_000;

// ------------------------------------------------------------------ primitives
export interface KeyPair {
  pk: Uint8Array;
  sk: Uint8Array;
}
export function dhKeyPair(rng: Rng = sysRng): KeyPair {
  const kp = S().crypto_box_seed_keypair(rng.bytes(32));
  return { pk: kp.publicKey, sk: kp.privateKey };
}
export function dh(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  if (pk.length !== 32) throw new Error('bad public key');
  const out = S().crypto_scalarmult(sk, pk);
  if (S().is_zero(out)) throw new Error('bad public key (low order)');
  return out;
}
export function kdfRk(rk: Uint8Array, dhOut: Uint8Array): { rk: Uint8Array; ck: Uint8Array; nhk: Uint8Array } {
  const o = S().crypto_generichash(64, cat(utf8('sc-ratchet-rk'), dhOut), rk);
  const o2 = S().crypto_generichash(32, cat(utf8('sc-ratchet-nhk'), dhOut), rk);
  return { rk: o.slice(0, 32), ck: o.slice(32, 64), nhk: o2 };
}
export function kdfCk(ck: Uint8Array): { ck: Uint8Array; mk: Uint8Array } {
  return { mk: S().crypto_generichash(32, new Uint8Array([1]), ck), ck: S().crypto_generichash(32, new Uint8Array([2]), ck) };
}
function seal(key: Uint8Array, pt: Uint8Array, ad: Uint8Array | null, rng: Rng): Uint8Array {
  const nonce = rng.bytes(24);
  return cat(nonce, S().crypto_aead_xchacha20poly1305_ietf_encrypt(pt, ad, null, nonce, key));
}
function open(key: Uint8Array, box: Uint8Array, ad: Uint8Array | null): Uint8Array | null {
  if (box.length < 24 + 16) return null;
  try {
    return S().crypto_aead_xchacha20poly1305_ietf_decrypt(null, box.subarray(24), ad, box.subarray(0, 24), key);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ device keys
/** This device's long-term keys (never leave the device). */
export interface DeviceKeys {
  deviceId: string;
  signPk: Uint8Array;
  signSk: Uint8Array;
  dhPk: Uint8Array;
  dhSk: Uint8Array;
}
/** Public device certificate: the account's Ed25519 key vouches for this device's keys. */
export interface DeviceCert {
  userId: string;
  deviceId: string;
  signPk: string;
  dhPk: string;
  sig: string;
}
export interface SignedPrekey {
  id: number;
  pk: Uint8Array;
  sk: Uint8Array;
  sig: Uint8Array;
  at: number;
}
export interface OneTimePrekey {
  id: number;
  pk: Uint8Array;
  sk: Uint8Array;
}
/** What the server hands out for a device (one OPK is removed from the server when handed out). */
export interface PrekeyBundle {
  cert: DeviceCert;
  spkId: number;
  spkPk: string;
  spkSig: string;
  opkId?: number;
  opkPk?: string;
}

export const newDeviceId = (rng: Rng = sysRng) => 'd_' + b64(rng.bytes(16));
export function generateDeviceKeys(rng: Rng = sysRng): DeviceKeys {
  const sign = S().crypto_sign_seed_keypair(rng.bytes(32));
  const d = dhKeyPair(rng);
  return { deviceId: newDeviceId(rng), signPk: sign.publicKey, signSk: sign.privateKey, dhPk: d.pk, dhSk: d.sk };
}
const certMsg = (c: Omit<DeviceCert, 'sig'>) => encodeFields('sc-device-cert', [c.userId, c.deviceId, c.signPk, c.dhPk]);
export function certifyDevice(dev: DeviceKeys, userId: string, accountSignSk: Uint8Array): DeviceCert {
  const c = { userId, deviceId: dev.deviceId, signPk: b64(dev.signPk), dhPk: b64(dev.dhPk) };
  return { ...c, sig: b64(S().crypto_sign_detached(certMsg(c), accountSignSk)) };
}
export function verifyCert(c: DeviceCert, accountSignPk: Uint8Array): boolean {
  try {
    if (!/^d_[A-Za-z0-9_-]{22}$/.test(c.deviceId) || unb64(c.signPk).length !== 32 || unb64(c.dhPk).length !== 32) return false;
    return S().crypto_sign_verify_detached(unb64(c.sig), certMsg(c), accountSignPk);
  } catch {
    return false;
  }
}
/** Proof for the server that this session holds the device key (sent when registering the device). */
export function signDeviceBind(dev: DeviceKeys, userId: string, at: number): string {
  return b64(S().crypto_sign_detached(encodeFields('sc-device-bind', [userId, dev.deviceId, at]), dev.signSk));
}
const spkMsg = (deviceId: string, id: number, pk: Uint8Array) => cat(encodeFields('sc-spk', [deviceId, id]), pk);
export function newSignedPrekey(dev: DeviceKeys, id: number, now: number, rng: Rng = sysRng): SignedPrekey {
  const kp = dhKeyPair(rng);
  return { id, pk: kp.pk, sk: kp.sk, sig: S().crypto_sign_detached(spkMsg(dev.deviceId, id, kp.pk), dev.signSk), at: now };
}
export function verifySpk(cert: DeviceCert, spkId: number, spkPk: Uint8Array, sig: Uint8Array): boolean {
  try {
    return S().crypto_sign_verify_detached(sig, spkMsg(cert.deviceId, spkId, spkPk), unb64(cert.signPk));
  } catch {
    return false;
  }
}
export function newOneTimePrekeys(firstId: number, n: number, rng: Rng = sysRng): OneTimePrekey[] {
  return Array.from({ length: n }, (_, i) => ({ id: firstId + i, ...dhKeyPair(rng) }));
}
/** Full check of a bundle from the server: account → device certificate → signed prekey. */
export function verifyBundle(b: PrekeyBundle, userId: string, accountSignPk: Uint8Array): boolean {
  if (b.cert.userId !== userId || !verifyCert(b.cert, accountSignPk)) return false;
  try {
    if (!verifySpk(b.cert, b.spkId, unb64(b.spkPk), unb64(b.spkSig))) return false;
    if (b.opkPk !== undefined && unb64(b.opkPk).length !== 32) return false;
  } catch {
    return false;
  }
  return true;
}

/** 60-digit code both sides compare for a secret chat (built from the two device certificates). */
export function deviceSafetyNumber(a: DeviceCert, b: DeviceCert): string {
  const [x, y] = a.deviceId < b.deviceId ? [a, b] : [b, a];
  const h = S().crypto_generichash(60, cat(encodeFields('sc-secret-safety', [x.userId, x.deviceId, x.signPk, x.dhPk, y.userId, y.deviceId, y.signPk, y.dhPk])), null);
  const groups: string[] = [];
  for (let i = 0; i < 60; i += 5) {
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + h[i + j];
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

// ------------------------------------------------------------------ X3DH
export interface X3dhResult {
  sk: Uint8Array;
  hka: Uint8Array; // initiator's first sending header key
  nhkb: Uint8Array; // responder's first "next" header key
  ad: Uint8Array;
}
/** Associated data binding both devices' identities (initiator first). */
export function x3dhAd(initiator: DeviceCert, responder: DeviceCert): Uint8Array {
  return encodeFields('sc-x3dh-ad', [initiator.userId, initiator.deviceId, initiator.dhPk, initiator.signPk, responder.userId, responder.deviceId, responder.dhPk, responder.signPk]);
}
function x3dhKdf(dhs: Uint8Array[]): { sk: Uint8Array; hka: Uint8Array; nhkb: Uint8Array } {
  const input = cat(new Uint8Array(32).fill(0xff), ...dhs);
  const tag = (t: string) => S().crypto_generichash(32, cat(utf8(t), input), null);
  return { sk: tag('sc-x3dh-sk'), hka: tag('sc-x3dh-hka'), nhkb: tag('sc-x3dh-nhkb') };
}
/** Initiator side. Returns the shared secrets plus what goes into the first message. */
export function x3dhInitiate(me: DeviceKeys, myCert: DeviceCert, bundle: PrekeyBundle, rng: Rng = sysRng): X3dhResult & { ekPk: Uint8Array } {
  const ek = dhKeyPair(rng);
  const spk = unb64(bundle.spkPk);
  const ikB = unb64(bundle.cert.dhPk);
  const dhs = [dh(me.dhSk, spk), dh(ek.sk, ikB), dh(ek.sk, spk)];
  if (bundle.opkPk) dhs.push(dh(ek.sk, unb64(bundle.opkPk)));
  return { ...x3dhKdf(dhs), ad: x3dhAd(myCert, bundle.cert), ekPk: ek.pk };
}
/** Responder side (the caller has verified the initiator's certificate and looked up its own SPK / OPK). */
export function x3dhRespond(me: DeviceKeys, myCert: DeviceCert, spk: { sk: Uint8Array }, opk: { sk: Uint8Array } | null, initiator: DeviceCert, ekPk: Uint8Array): X3dhResult {
  const ikA = unb64(initiator.dhPk);
  const dhs = [dh(spk.sk, ikA), dh(me.dhSk, ekPk), dh(spk.sk, ekPk)];
  if (opk) dhs.push(dh(opk.sk, ekPk));
  return { ...x3dhKdf(dhs), ad: x3dhAd(initiator, myCert) };
}

// ------------------------------------------------------------------ Double Ratchet with header encryption
export interface RatchetState {
  dhs: KeyPair;
  dhr: Uint8Array | null;
  rk: Uint8Array;
  cks: Uint8Array | null;
  ckr: Uint8Array | null;
  ns: number;
  nr: number;
  pn: number;
  hks: Uint8Array | null;
  hkr: Uint8Array | null;
  nhks: Uint8Array;
  nhkr: Uint8Array;
  /** skipped message keys: `${b64(hk)}|${n}` → message key + when it was stored */
  skipped: Record<string, { mk: Uint8Array; at: number }>;
}
export interface Header {
  dh: Uint8Array;
  pn: number;
  n: number;
}
export interface WireMessage {
  h: string; // encrypted header
  c: string; // encrypted body
}

export function initInitiator(x: X3dhResult, responderSpkPk: Uint8Array, rng: Rng = sysRng): RatchetState {
  const dhs = dhKeyPair(rng);
  const r = kdfRk(x.sk, dh(dhs.sk, responderSpkPk));
  return { dhs, dhr: responderSpkPk, rk: r.rk, cks: r.ck, ckr: null, ns: 0, nr: 0, pn: 0, hks: x.hka, hkr: null, nhks: r.nhk, nhkr: x.nhkb, skipped: {} };
}
export function initResponder(x: X3dhResult, spk: KeyPair): RatchetState {
  return { dhs: { pk: spk.pk, sk: spk.sk }, dhr: null, rk: x.sk, cks: null, ckr: null, ns: 0, nr: 0, pn: 0, hks: null, hkr: null, nhks: x.nhkb, nhkr: x.hka, skipped: {} };
}

export function encodeHeader(h: Header): Uint8Array {
  const out = new Uint8Array(40);
  out.set(h.dh, 0);
  const v = new DataView(out.buffer);
  v.setUint32(32, h.pn);
  v.setUint32(36, h.n);
  return out;
}
export function decodeHeader(b: Uint8Array): Header | null {
  if (b.length !== 40) return null;
  const v = new DataView(b.buffer, b.byteOffset, 40);
  return { dh: b.slice(0, 32), pn: v.getUint32(32), n: v.getUint32(36) };
}

const clone = (st: RatchetState): RatchetState => ({
  ...st,
  dhs: { pk: st.dhs.pk.slice(), sk: st.dhs.sk.slice() },
  skipped: Object.fromEntries(Object.entries(st.skipped).map(([k, v]) => [k, { mk: v.mk.slice(), at: v.at }])),
});

/** Encrypt one message. Returns the new state (the input is not modified). */
export function ratchetEncrypt(state: RatchetState, plaintext: Uint8Array, ad: Uint8Array, rng: Rng = sysRng): { state: RatchetState; msg: WireMessage } {
  if (!state.cks || !state.hks) throw new Error('cannot send before the first message from the other side');
  const st = clone(state);
  const { ck, mk } = kdfCk(st.cks!);
  st.cks = ck;
  const encHeader = seal(st.hks!, encodeHeader({ dh: st.dhs.pk, pn: st.pn, n: st.ns }), null, rng);
  st.ns += 1;
  const body = seal(mk, plaintext, cat(ad, encHeader), rng);
  return { state: st, msg: { h: b64(encHeader), c: b64(body) } };
}

const skKey = (hk: Uint8Array, n: number) => `${b64(hk)}|${n}`;

/** Decrypt one message. Throws (leaving the caller's state untouched) on anything forged, replayed or too far ahead. */
export function ratchetDecrypt(state: RatchetState, msg: WireMessage, ad: Uint8Array, now: number, rng: Rng = sysRng): { state: RatchetState; plaintext: Uint8Array } {
  const st = clone(state);
  const encHeader = unb64(msg.h);
  const body = unb64(msg.c);
  const fullAd = cat(ad, encHeader);
  // 1. a message whose key was skipped earlier
  for (const hkB64 of new Set(Object.keys(st.skipped).map((k) => k.split('|')[0]))) {
    const hk = unb64(hkB64);
    const hb = open(hk, encHeader, null);
    if (!hb) continue;
    const h = decodeHeader(hb);
    const k = h && skKey(hk, h.n);
    if (!k || !st.skipped[k]) continue;
    const pt = open(st.skipped[k].mk, body, fullAd);
    if (!pt) throw new Error('message authentication failed');
    delete st.skipped[k];
    return { state: st, plaintext: pt };
  }
  // 2. current or next header key
  let header: Header | null = null;
  let ratchet = false;
  if (st.hkr) {
    const hb = open(st.hkr, encHeader, null);
    if (hb) header = decodeHeader(hb);
  }
  if (!header) {
    const hb = open(st.nhkr, encHeader, null);
    if (hb) {
      header = decodeHeader(hb);
      ratchet = true;
    }
  }
  if (!header) throw new Error('header decryption failed');
  if (ratchet) {
    skip(st, header.pn, now);
    // DH ratchet step
    st.pn = st.ns;
    st.ns = 0;
    st.nr = 0;
    st.hks = st.nhks;
    st.hkr = st.nhkr;
    st.dhr = header.dh;
    const r1 = kdfRk(st.rk, dh(st.dhs.sk, st.dhr));
    st.rk = r1.rk;
    st.ckr = r1.ck;
    st.nhkr = r1.nhk;
    st.dhs = dhKeyPair(rng);
    const r2 = kdfRk(st.rk, dh(st.dhs.sk, st.dhr));
    st.rk = r2.rk;
    st.cks = r2.ck;
    st.nhks = r2.nhk;
  } else if (header.n < st.nr) {
    throw new Error('replayed or duplicate message');
  }
  skip(st, header.n, now);
  const { ck, mk } = kdfCk(st.ckr!);
  st.ckr = ck;
  st.nr += 1;
  const pt = open(mk, body, fullAd);
  if (!pt) throw new Error('message authentication failed');
  pruneSkipped(st, now);
  return { state: st, plaintext: pt };
}

function skip(st: RatchetState, until: number, now: number) {
  if (st.nr + MAX_SKIP < until) throw new Error('too many skipped messages');
  if (!st.ckr || !st.hkr) return;
  while (st.nr < until) {
    const { ck, mk } = kdfCk(st.ckr);
    st.ckr = ck;
    st.skipped[skKey(st.hkr, st.nr)] = { mk, at: now };
    st.nr += 1;
  }
}
function pruneSkipped(st: RatchetState, now: number) {
  const entries = Object.entries(st.skipped).filter(([, v]) => now - v.at < SKIPPED_TTL_MS);
  entries.sort((a, b) => a[1].at - b[1].at);
  st.skipped = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_SKIPPED_TOTAL)));
}

// ------------------------------------------------------------------ (de)serialisation for storage
type Json = Record<string, unknown>;
const bOrNull = (u: Uint8Array | null) => (u ? b64(u) : null);
const uOrNull = (s: unknown) => (typeof s === 'string' ? unb64(s) : null);
export function serializeState(st: RatchetState): Json {
  return {
    dhs: { pk: b64(st.dhs.pk), sk: b64(st.dhs.sk) },
    dhr: bOrNull(st.dhr),
    rk: b64(st.rk),
    cks: bOrNull(st.cks),
    ckr: bOrNull(st.ckr),
    ns: st.ns,
    nr: st.nr,
    pn: st.pn,
    hks: bOrNull(st.hks),
    hkr: bOrNull(st.hkr),
    nhks: b64(st.nhks),
    nhkr: b64(st.nhkr),
    skipped: Object.fromEntries(Object.entries(st.skipped).map(([k, v]) => [k, { mk: b64(v.mk), at: v.at }])),
  };
}
export function deserializeState(j: Json): RatchetState {
  const d = j.dhs as { pk: string; sk: string };
  return {
    dhs: { pk: unb64(d.pk), sk: unb64(d.sk) },
    dhr: uOrNull(j.dhr),
    rk: unb64(j.rk as string),
    cks: uOrNull(j.cks),
    ckr: uOrNull(j.ckr),
    ns: j.ns as number,
    nr: j.nr as number,
    pn: j.pn as number,
    hks: uOrNull(j.hks),
    hkr: uOrNull(j.hkr),
    nhks: unb64(j.nhks as string),
    nhkr: unb64(j.nhkr as string),
    skipped: Object.fromEntries(Object.entries((j.skipped ?? {}) as Record<string, { mk: string; at: number }>).map(([k, v]) => [k, { mk: unb64(v.mk), at: v.at }])),
  };
}
export const serializeDevice = (d: DeviceKeys) => ({ deviceId: d.deviceId, signPk: b64(d.signPk), signSk: b64(d.signSk), dhPk: b64(d.dhPk), dhSk: b64(d.dhSk) });
export const deserializeDevice = (j: ReturnType<typeof serializeDevice>): DeviceKeys => ({
  deviceId: j.deviceId,
  signPk: unb64(j.signPk),
  signSk: unb64(j.signSk),
  dhPk: unb64(j.dhPk),
  dhSk: unb64(j.dhSk),
});
export { eq as bytesEqual };
