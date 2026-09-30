import { beforeAll, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import * as C from '../../web/src/crypto/core.js';
import * as R from '../../web/src/crypto/ratchet.js';
import { RefRatchet, refX3dh, refDH } from './ratchet-ref.js';

/** Deterministic randomness: BLAKE2b(seed ‖ counter). */
function detRng(seed: string): R.Rng {
  let n = 0;
  return {
    bytes(len: number) {
      const out = new Uint8Array(len);
      let o = 0;
      while (o < len) {
        const block = sodium.crypto_generichash(64, sodium.from_string(`${seed}|${n++}`), null);
        out.set(block.subarray(0, Math.min(64, len - o)), o);
        o += 64;
      }
      return out;
    },
  };
}
const txt = (s: string) => sodium.from_string(s);
const str = (u: Uint8Array) => sodium.to_string(u);

interface Party {
  account: C.Identity;
  userId: string;
  dev: R.DeviceKeys;
  cert: R.DeviceCert;
}
function party(userId: string, rng: R.Rng): Party {
  const account = C.generateIdentity();
  const dev = R.generateDeviceKeys(rng);
  return { account, userId, dev, cert: R.certifyDevice(dev, userId, account.signSk) };
}

/** Alice starts a session with Bob's bundle; returns both ratchet states after Bob processed message #0. */
function handshake(rng: R.Rng, withOpk = true) {
  const A = party('u_alice', rng);
  const B = party('u_bob', rng);
  const spk = R.newSignedPrekey(B.dev, 7, Date.now(), rng);
  const [opk] = R.newOneTimePrekeys(100, 1, rng);
  const bundle: R.PrekeyBundle = {
    cert: B.cert,
    spkId: spk.id,
    spkPk: C.b64(spk.pk),
    spkSig: C.b64(spk.sig),
    ...(withOpk ? { opkId: opk.id, opkPk: C.b64(opk.pk) } : {}),
  };
  expect(R.verifyBundle(bundle, 'u_bob', B.account.signPk)).toBe(true);
  const xa = R.x3dhInitiate(A.dev, A.cert, bundle, rng);
  let a = R.initInitiator(xa, spk.pk, rng);
  const xb = R.x3dhRespond(B.dev, B.cert, spk, withOpk ? opk : null, A.cert, xa.ekPk);
  expect(C.b64(xb.sk)).toBe(C.b64(xa.sk));
  let b = R.initResponder(xb, { pk: spk.pk, sk: spk.sk });
  return { A, B, spk, opk, xa, xb, a, b };
}

describe('secret chats: X3DH + Double Ratchet (header encryption)', () => {
  beforeAll(async () => {
    await C.ready();
    await sodium.ready;
  });

  it('device certificates and signed prekeys are verified end to end', () => {
    const rng = R.sysRng;
    const B = party('u_bob', rng);
    const spk = R.newSignedPrekey(B.dev, 1, 0, rng);
    const good: R.PrekeyBundle = { cert: B.cert, spkId: 1, spkPk: C.b64(spk.pk), spkSig: C.b64(spk.sig) };
    expect(R.verifyBundle(good, 'u_bob', B.account.signPk)).toBe(true);
    expect(R.verifyBundle(good, 'u_mallory', B.account.signPk)).toBe(false); // bound to the user id
    expect(R.verifyBundle(good, 'u_bob', C.generateIdentity().signPk)).toBe(false); // another account's key
    expect(R.verifyBundle({ ...good, spkId: 2 }, 'u_bob', B.account.signPk)).toBe(false); // spk id is signed
    const other = R.newSignedPrekey(B.dev, 1, 0, rng);
    expect(R.verifyBundle({ ...good, spkPk: C.b64(other.pk) }, 'u_bob', B.account.signPk)).toBe(false); // swapped spk
    expect(R.verifyBundle({ ...good, cert: { ...B.cert, dhPk: C.b64(other.pk) } }, 'u_bob', B.account.signPk)).toBe(false);
    expect(R.verifyBundle({ ...good, opkPk: 'AAAA' }, 'u_bob', B.account.signPk)).toBe(false);
  });

  it('a conversation with ratchet steps and out-of-order delivery decrypts on both sides', () => {
    let { a, b, xa, xb } = handshake(R.sysRng);
    const now = Date.now();
    const sendA = (t: string) => {
      const r = R.ratchetEncrypt(a, txt(t), xa.ad);
      a = r.state;
      return r.msg;
    };
    const sendB = (t: string) => {
      const r = R.ratchetEncrypt(b, txt(t), xb.ad);
      b = r.state;
      return r.msg;
    };
    const recvB = (m: R.WireMessage) => {
      const r = R.ratchetDecrypt(b, m, xb.ad, now);
      b = r.state;
      return str(r.plaintext);
    };
    const recvA = (m: R.WireMessage) => {
      const r = R.ratchetDecrypt(a, m, xa.ad, now);
      a = r.state;
      return str(r.plaintext);
    };
    expect(() => R.ratchetEncrypt(b, txt('too early'), xb.ad)).toThrow(); // responder can't send first
    const a1 = sendA('hello');
    const a2 = sendA('second');
    const a3 = sendA('third');
    expect(recvB(a1)).toBe('hello');
    expect(recvB(a3)).toBe('third'); // a2 skipped
    const b1 = sendB('hi alice');
    expect(recvA(b1)).toBe('hi alice');
    expect(recvB(a2)).toBe('second'); // late message from the old chain
    const a4 = sendA('after ratchet');
    const a5 = sendA('after ratchet 2');
    expect(recvB(a5)).toBe('after ratchet 2');
    expect(recvB(a4)).toBe('after ratchet');
    for (let i = 0; i < 5; i++) {
      expect(recvA(sendB('ping ' + i))).toBe('ping ' + i);
      expect(recvB(sendA('pong ' + i))).toBe('pong ' + i);
    }
    expect(Object.keys(a.skipped)).toHaveLength(0);
    expect(Object.keys(b.skipped)).toHaveLength(0);
    // state survives JSON storage
    b = R.deserializeState(JSON.parse(JSON.stringify(R.serializeState(b))));
    expect(recvB(sendA('stored'))).toBe('stored');
  });

  it('forged, tampered, replayed and far-future messages are rejected without touching the state', () => {
    let { a, b, xa, xb } = handshake(R.sysRng, false);
    const now = Date.now();
    const m1 = R.ratchetEncrypt(a, txt('one'), xa.ad);
    a = m1.state;
    const before = JSON.stringify(R.serializeState(b));
    // body tampered
    const body = C.unb64(m1.msg.c);
    body[body.length - 1] ^= 1;
    expect(() => R.ratchetDecrypt(b, { h: m1.msg.h, c: C.b64(body) }, xb.ad, now)).toThrow();
    // header tampered
    const hdr = C.unb64(m1.msg.h);
    hdr[30] ^= 1;
    expect(() => R.ratchetDecrypt(b, { h: C.b64(hdr), c: m1.msg.c }, xb.ad, now)).toThrow();
    // wrong associated data (e.g. message replayed into another session)
    expect(() => R.ratchetDecrypt(b, m1.msg, txt('other session'), now)).toThrow();
    expect(JSON.stringify(R.serializeState(b))).toBe(before); // nothing changed
    b = R.ratchetDecrypt(b, m1.msg, xb.ad, now).state;
    // replay
    expect(() => R.ratchetDecrypt(b, m1.msg, xb.ad, now)).toThrow();
    // more than MAX_SKIP ahead
    let far = a;
    let last: R.WireMessage | null = null;
    for (let i = 0; i < R.MAX_SKIP + 2; i++) {
      const r = R.ratchetEncrypt(far, txt('x'), xa.ad);
      far = r.state;
      last = r.msg;
    }
    expect(() => R.ratchetDecrypt(b, last!, xb.ad, now)).toThrow(/skipped/);
  });

  it('forward secrecy: keys that decrypted a message are gone; old state copies are the only way back', () => {
    let { a, b, xa, xb } = handshake(R.sysRng);
    const now = Date.now();
    const m = R.ratchetEncrypt(a, txt('secret'), xa.ad);
    a = m.state;
    const bAfter = R.ratchetDecrypt(b, m.msg, xb.ad, now).state;
    // the new state can't decrypt it again (message key deleted, chain moved on)
    expect(() => R.ratchetDecrypt(bAfter, m.msg, xb.ad, now)).toThrow();
    // after a round trip, even the sending side's current state has no key for old traffic
    const r = R.ratchetEncrypt(bAfter, txt('reply'), xb.ad);
    const aAfter = R.ratchetDecrypt(a, r.msg, xa.ad, now).state;
    expect(C.b64(aAfter.rk)).not.toBe(C.b64(a.rk));
    expect(aAfter.cks && C.b64(aAfter.cks)).not.toBe(a.cks && C.b64(a.cks));
  });

  it('low-order public keys are refused', () => {
    const { a } = handshake(R.sysRng);
    expect(() => R.dh(a.dhs.sk, new Uint8Array(32))).toThrow();
  });

  it('matches an independently written reference implementation byte for byte', () => {
    for (const withOpk of [true, false]) {
      // run 1: our implementation
      const rng1 = detRng('conv-' + withOpk);
      const h = handshake(rng1, withOpk);
      // run 2: reference, same randomness stream re-derived for the same key material
      const rng2 = detRng('conv-' + withOpk);
      const A2 = { dev: R.generateDeviceKeys(rng2) };
      const B2 = { dev: R.generateDeviceKeys(rng2) };
      const spk2 = R.newSignedPrekey(B2.dev, 7, 0, rng2);
      const [opk2] = R.newOneTimePrekeys(100, 1, rng2);
      expect(C.b64(A2.dev.dhPk)).toBe(C.b64(h.A.dev.dhPk));
      expect(C.b64(spk2.pk)).toBe(C.b64(h.spk.pk));
      const ek = sodium.crypto_box_seed_keypair(rng2.bytes(32));
      const dhs = [refDH(A2.dev.dhSk, spk2.pk), refDH(ek.privateKey, B2.dev.dhPk), refDH(ek.privateKey, spk2.pk)];
      if (withOpk) dhs.push(refDH(ek.privateKey, opk2.pk));
      const x = refX3dh(dhs);
      expect(C.b64(x.SK)).toBe(C.b64(h.xa.sk));
      const alice = RefRatchet.alice(rng2, x.SK, spk2.pk, x.HKA, x.NHKB);
      const bob = RefRatchet.bob(rng2, x.SK, { pub: spk2.pk, priv: spk2.sk }, x.HKA, x.NHKB);
      // our own continues with rng1: its call sequence from here must match the reference's use of rng2
      let a = h.a;
      let b = h.b;
      const now = Date.now();
      const script: [string, string][] = [
        ['A', 'm1'], ['A', 'm2'], ['A', 'm3'], ['deliverB', '0'], ['deliverB', '2'], ['B', 'r1'], ['B', 'r2'], ['deliverA', '1'],
        ['deliverB', '1'], ['A', 'm4'], ['deliverA', '0'], ['deliverB', '3'], ['B', 'r3'], ['deliverA', '2'], ['A', 'm5'], ['deliverB', '4'],
      ];
      const oursA: R.WireMessage[] = [];
      const oursB: R.WireMessage[] = [];
      const refA: { h: string; c: string }[] = [];
      const refB: { h: string; c: string }[] = [];
      for (const [op, arg] of script) {
        if (op === 'A') {
          const r = R.ratchetEncrypt(a, txt(arg), h.xa.ad, rng1);
          a = r.state;
          oursA.push(r.msg);
          refA.push(alice.encrypt(txt(arg), h.xa.ad));
          expect(r.msg).toEqual(refA[refA.length - 1]);
        } else if (op === 'B') {
          const r = R.ratchetEncrypt(b, txt(arg), h.xb.ad, rng1);
          b = r.state;
          oursB.push(r.msg);
          refB.push(bob.encrypt(txt(arg), h.xb.ad));
          expect(r.msg).toEqual(refB[refB.length - 1]);
        } else if (op === 'deliverB') {
          const i = Number(arg);
          const r = R.ratchetDecrypt(b, oursA[i], h.xb.ad, now, rng1);
          b = r.state;
          expect(str(bob.decrypt(refA[i], h.xb.ad))).toBe(str(r.plaintext));
        } else {
          const i = Number(arg);
          const r = R.ratchetDecrypt(a, oursB[i], h.xa.ad, now, rng1);
          a = r.state;
          expect(str(alice.decrypt(refB[i], h.xa.ad))).toBe(str(r.plaintext));
        }
      }
      // cross-decrypt: reference output is readable by ours and vice versa (already equal bytes, but check keys too)
      expect(C.b64(a.rk)).toBe(C.b64(alice.RK));
      expect(C.b64(b.rk)).toBe(C.b64(bob.RK));
    }
  });
});
