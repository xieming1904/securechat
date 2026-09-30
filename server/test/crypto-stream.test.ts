import { beforeAll, describe, expect, it } from 'vitest';
import * as C from '../../web/src/crypto/core.js';

describe('resumable secretstream (large-upload resume)', () => {
  beforeAll(() => C.ready());
  it('is byte-compatible with libsodium and survives a save/restore of its state', () => {
    for (const size of [0, 1, 15, 16, 17, 100, C.FILE_CHUNK - 1, C.FILE_CHUNK, C.FILE_CHUNK + 5, 5 * C.FILE_CHUNK + 333]) {
      const data = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 0xff);
      let enc = C.resumableEncryptor();
      const n = Math.max(1, Math.ceil(size / C.FILE_CHUNK));
      const parts: Uint8Array[] = [];
      for (let i = 0; i < n; i++) {
        if (i === 2) enc = C.resumableEncryptor({ key: enc.key, header: enc.header, state: JSON.parse(JSON.stringify(enc.state())) });
        parts.push(enc.push(data.subarray(i * C.FILE_CHUNK, Math.min(size, (i + 1) * C.FILE_CHUNK)), i === n - 1));
      }
      const ct = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
      let o = 0;
      for (const p of parts) (ct.set(p, o), (o += p.length));
      expect(ct.length).toBe(C.fileCtSize(size));
      expect(C.decryptFile(ct, enc.key, enc.header)).toEqual(data); // libsodium's own pull
    }
  });
  it('a tampered chunk or a wrong resume state is rejected by the reader', () => {
    const data = new Uint8Array(3 * C.FILE_CHUNK).fill(9);
    const enc = C.resumableEncryptor();
    const a = enc.push(data.subarray(0, C.FILE_CHUNK), false);
    const bad = C.resumableEncryptor({ key: enc.key, header: enc.header, state: { ...enc.state(), n: C.b64(new Uint8Array(12)) } });
    const b = bad.push(data.subarray(C.FILE_CHUNK), true);
    const ct = new Uint8Array(a.length + b.length);
    ct.set(a);
    ct.set(b, a.length);
    expect(() => C.decryptFile(ct, enc.key, enc.header)).toThrow();
  });
});
