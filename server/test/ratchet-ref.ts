/**
 * Independent reference implementation of the secret-chat protocol, written directly from the Signal
 * Double Ratchet spec pseudocode (§3.5, header encryption) as a class with mutable fields — deliberately
 * structured differently from web/src/crypto/ratchet.ts. Tests drive both with the same deterministic randomness
 * and require byte-identical wire output. Only the constants/primitives (the "wire spec") are shared by definition.
 */
import sodium from 'libsodium-wrappers-sumo';

const te = new TextEncoder();
const join = (...xs: Uint8Array[]) => {
  const o = new Uint8Array(xs.reduce((a, x) => a + x.length, 0));
  let i = 0;
  for (const x of xs) {
    o.set(x, i);
    i += x.length;
  }
  return o;
};
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const B64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');

export interface RefRng {
  bytes(n: number): Uint8Array;
}

// GENERATE_DH / DH
function GENERATE_DH(rng: RefRng) {
  const kp = sodium.crypto_box_seed_keypair(rng.bytes(32));
  return { pub: kp.publicKey, priv: kp.privateKey };
}
function DH(priv: Uint8Array, pub: Uint8Array) {
  return sodium.crypto_scalarmult(priv, pub);
}
// KDF_RK_HE(rk, dh_out) → (rk, ck, nhk)
function KDF_RK_HE(rk: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  const a = sodium.crypto_generichash(64, join(te.encode('sc-ratchet-rk'), dhOut), rk);
  const nhk = sodium.crypto_generichash(32, join(te.encode('sc-ratchet-nhk'), dhOut), rk);
  return [a.subarray(0, 32).slice(), a.subarray(32).slice(), nhk];
}
// KDF_CK(ck) → (ck, mk)
function KDF_CK(ck: Uint8Array): [Uint8Array, Uint8Array] {
  return [sodium.crypto_generichash(32, Uint8Array.of(2), ck), sodium.crypto_generichash(32, Uint8Array.of(1), ck)];
}
function AEAD_ENC(key: Uint8Array, pt: Uint8Array, ad: Uint8Array | null, rng: RefRng) {
  const n = rng.bytes(24);
  return join(n, sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(pt, ad, null, n, key));
}
function AEAD_DEC(key: Uint8Array, ct: Uint8Array, ad: Uint8Array | null): Uint8Array | null {
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct.subarray(24), ad, ct.subarray(0, 24), key);
  } catch {
    return null;
  }
}
function HEADER(pub: Uint8Array, pn: number, n: number) {
  const b = new Uint8Array(40);
  b.set(pub);
  new DataView(b.buffer).setUint32(32, pn);
  new DataView(b.buffer).setUint32(36, n);
  return b;
}
function PARSE(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, 40);
  return { dh: b.slice(0, 32), pn: v.getUint32(32), n: v.getUint32(36) };
}

export class RefRatchet {
  DHs!: { pub: Uint8Array; priv: Uint8Array };
  DHr: Uint8Array | null = null;
  RK!: Uint8Array;
  CKs: Uint8Array | null = null;
  CKr: Uint8Array | null = null;
  Ns = 0;
  Nr = 0;
  PN = 0;
  HKs: Uint8Array | null = null;
  HKr: Uint8Array | null = null;
  NHKs!: Uint8Array;
  NHKr!: Uint8Array;
  MKSKIPPED = new Map<string, Uint8Array>(); // hex(hk)+':'+n
  constructor(private rng: RefRng) {}

  static alice(rng: RefRng, SK: Uint8Array, bobPub: Uint8Array, sharedHka: Uint8Array, sharedNhkb: Uint8Array) {
    const s = new RefRatchet(rng);
    s.DHs = GENERATE_DH(rng);
    s.DHr = bobPub;
    [s.RK, s.CKs, s.NHKs] = KDF_RK_HE(SK, DH(s.DHs.priv, s.DHr));
    s.HKs = sharedHka;
    s.NHKr = sharedNhkb;
    return s;
  }
  static bob(rng: RefRng, SK: Uint8Array, bobKp: { pub: Uint8Array; priv: Uint8Array }, sharedHka: Uint8Array, sharedNhkb: Uint8Array) {
    const s = new RefRatchet(rng);
    s.DHs = bobKp;
    s.RK = SK;
    s.NHKs = sharedNhkb;
    s.NHKr = sharedHka;
    return s;
  }

  encrypt(pt: Uint8Array, AD: Uint8Array) {
    const [ck, mk] = KDF_CK(this.CKs!);
    this.CKs = ck;
    const encHeader = AEAD_ENC(this.HKs!, HEADER(this.DHs.pub, this.PN, this.Ns), null, this.rng);
    this.Ns += 1;
    return { h: B64(encHeader), c: B64(AEAD_ENC(mk, pt, join(AD, encHeader), this.rng)) };
  }

  decrypt(msg: { h: string; c: string }, AD: Uint8Array): Uint8Array {
    const encHeader = Buffer.from(msg.h, 'base64url');
    const ct = Buffer.from(msg.c, 'base64url');
    const ad2 = join(AD, encHeader);
    for (const [key, mk] of this.MKSKIPPED) {
      const hk = Buffer.from(key.split(':')[0], 'hex');
      const hb = AEAD_DEC(hk, encHeader, null);
      if (hb && `${hex(hk)}:${PARSE(hb).n}` === key) {
        this.MKSKIPPED.delete(key);
        const pt = AEAD_DEC(mk, ct, ad2);
        if (!pt) throw new Error('auth');
        return pt;
      }
    }
    let header;
    let dhRatchet = false;
    const h1 = this.HKr && AEAD_DEC(this.HKr, encHeader, null);
    if (h1) header = PARSE(h1);
    else {
      const h2 = AEAD_DEC(this.NHKr, encHeader, null);
      if (!h2) throw new Error('header');
      header = PARSE(h2);
      dhRatchet = true;
    }
    if (dhRatchet) {
      this.skip(header.pn);
      this.PN = this.Ns;
      this.Ns = 0;
      this.Nr = 0;
      this.HKs = this.NHKs;
      this.HKr = this.NHKr;
      this.DHr = header.dh;
      [this.RK, this.CKr, this.NHKr] = KDF_RK_HE(this.RK, DH(this.DHs.priv, this.DHr));
      this.DHs = GENERATE_DH(this.rng);
      [this.RK, this.CKs, this.NHKs] = KDF_RK_HE(this.RK, DH(this.DHs.priv, this.DHr));
    }
    this.skip(header.n);
    const [ck, mk] = KDF_CK(this.CKr!);
    this.CKr = ck;
    this.Nr += 1;
    const pt = AEAD_DEC(mk, ct, ad2);
    if (!pt) throw new Error('auth');
    return pt;
  }
  private skip(until: number) {
    if (this.Nr + 1000 < until) throw new Error('skip');
    if (this.CKr) {
      while (this.Nr < until) {
        const [ck, mk] = KDF_CK(this.CKr);
        this.CKr = ck;
        this.MKSKIPPED.set(`${hex(this.HKr!)}:${this.Nr}`, mk);
        this.Nr += 1;
      }
    }
  }
}

/** X3DH as in the spec: SK = KDF(F || DH1 || DH2 || DH3 [|| DH4]). */
export function refX3dh(dhs: Uint8Array[]) {
  const input = join(new Uint8Array(32).fill(255), ...dhs);
  const t = (s: string) => sodium.crypto_generichash(32, join(te.encode(s), input), null);
  return { SK: t('sc-x3dh-sk'), HKA: t('sc-x3dh-hka'), NHKB: t('sc-x3dh-nhkb') };
}
export { DH as refDH, GENERATE_DH as refGenerateDH };
