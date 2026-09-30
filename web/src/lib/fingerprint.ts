/**
 * Web code fingerprint (v0.8). The page hashes every file of the web client it can load (same algorithm as
 * ops/fingerprint.mjs and the build): SHA-256 over "<sha256>  <path>\n", files sorted by path.
 *
 * What it is good for: comparing with the number in the release notes, and noticing when the code changes
 * without a version change. What it can't do: code that was replaced on purpose can also fake this display —
 * the reliable check is `ops/fingerprint.mjs` run by root on the server (see 安全设计 §8).
 */
import { create } from 'zustand';
import { tr } from './i18n';
import * as C from '../crypto/core';
import sodium from 'libsodium-wrappers-sumo';

declare const __APP_VERSION__: string;
const KEY = 'securechat.code-fp.v1';

export interface FingerprintResult {
  version: string;
  declared: string;
  computed: string;
  /** all files hashed and the total matches the manifest */
  ok: boolean;
  /** the code changed while the version number stayed the same */
  changedSilently: boolean;
  /** v0.9: the manifest carries a valid signature of the release key built into this code */
  signed: 'valid' | 'missing' | 'invalid';
  keyId: string;
}
export const useCodeFp = create<{ result: FingerprintResult | null; checking: boolean }>(() => ({ result: null, checking: false }));

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const prettyFp = (h: string) => (h.slice(0, 32).toUpperCase().match(/.{4}/g) ?? []).join(' ');

export async function checkCodeFingerprint(): Promise<FingerprintResult> {
  useCodeFp.setState({ checking: true });
  try {
    const m = (await (await fetch('/code-fingerprint.json', { cache: 'no-store' })).json()) as { version: string; fingerprint: string; files: { f: string; h: string }[]; sig?: string };
    const lines: string[] = [];
    for (const { f } of [...m.files].sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0))) {
      const r = await fetch('/' + f, { cache: 'no-store' }); // what the server has now (the service worker lets these through)
      if (!r.ok) throw new Error(tr('无法读取 {v0}', { v0: f }));
      lines.push(`${hex(await crypto.subtle.digest('SHA-256', await r.arrayBuffer()))}  ${f}\n`);
    }
    const computed = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines.join(''))));
    let prev: { version: string; fp: string } | null = null;
    try {
      prev = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      /* storage unavailable */
    }
    const changedSilently = !!prev && prev.version === m.version && prev.fp !== computed;
    if (!changedSilently) {
      try {
        localStorage.setItem(KEY, JSON.stringify({ version: m.version, fp: computed }));
      } catch {
        /* ignore */
      }
    }
    await C.ready();
    const pub = C.unb64(__RELEASE_PUBKEY__);
    let signed: FingerprintResult['signed'] = 'missing';
    if (m.sig) {
      try {
        const sig = Uint8Array.from(atob(m.sig), (ch) => ch.charCodeAt(0));
        signed = sodium.crypto_sign_verify_detached(sig, new TextEncoder().encode(`securechat-web-code|${m.version}|${m.fingerprint}`), pub) ? 'valid' : 'invalid';
      } catch {
        signed = 'invalid';
      }
    }
    // key id = SHA-256 of the key in SPKI form (same as `ops/verify-release.mjs` prints)
    const spki = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, ...pub]);
    const keyId = (hex(await crypto.subtle.digest('SHA-256', spki)).slice(0, 16).toUpperCase().match(/.{4}/g) ?? []).join(' ');
    const result = { version: m.version, declared: m.fingerprint, computed, ok: computed === m.fingerprint && m.version === __APP_VERSION__, changedSilently, signed, keyId };
    useCodeFp.setState({ result });
    return result;
  } finally {
    useCodeFp.setState({ checking: false });
  }
}

/** The user has looked at the change and accepts the current code as the new reference. */
export function acceptCurrentCode() {
  const r = useCodeFp.getState().result;
  if (!r) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: r.version, fp: r.computed }));
  } catch {
    /* ignore */
  }
  useCodeFp.setState({ result: { ...r, changedSilently: false } });
}
