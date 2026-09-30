#!/usr/bin/env node
// Release signatures (v0.9). Ed25519, Node's built-in crypto (no dependencies).
//   node verify-release.mjs pkg <release.pub> <update.tar.gz> [<update.tar.gz.sig>]   — the update package itself
//   node verify-release.mjs web <release.pub> <web/dist>                                — the web files on disk
// Exit code 0 = valid. The public key lives in a root-owned place (/usr/local/lib/securechat-ops/release.pub);
// it is installed once and never overwritten by an update.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeDir, MANIFEST, pretty } from './fingerprint.mjs';

export const webMessage = (version, fingerprint) => Buffer.from(`securechat-web-code|${version}|${fingerprint}`);
export const keyId = (pubPem) => crypto.createHash('sha256').update(crypto.createPublicKey(pubPem).export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 16).toUpperCase().match(/.{4}/g).join(' ');

export function verifyPackage(pubPem, file, sigB64) {
  return crypto.verify(null, fs.readFileSync(file), crypto.createPublicKey(pubPem), Buffer.from(sigB64.trim(), 'base64'));
}

/** Recompute the fingerprint from the files and check the release key signed exactly that. */
export function verifyWeb(pubPem, dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  const { fingerprint } = computeDir(dir);
  if (fingerprint !== m.fingerprint) return { ok: false, why: 'files', fingerprint };
  if (!m.sig) return { ok: false, why: 'unsigned', fingerprint };
  const ok = crypto.verify(null, webMessage(m.version, m.fingerprint), crypto.createPublicKey(pubPem), Buffer.from(m.sig, 'base64'));
  return { ok, why: ok ? '' : 'signature', fingerprint, version: m.version };
}

const [mode, pub, a, b] = process.argv.slice(2);
if (mode && process.argv[1] && path.resolve(process.argv[1]).endsWith('verify-release.mjs')) {
  try {
    const pem = fs.readFileSync(pub, 'utf8');
    if (mode === 'pkg') {
      const sigFile = b ?? `${a}.sig`;
      if (!fs.existsSync(sigFile)) {
        console.error(`✘ 找不到签名文件 ${sigFile}（请把 .sig 文件和更新包放在同一目录）`);
        process.exit(3);
      }
      if (!verifyPackage(pem, a, fs.readFileSync(sigFile, 'utf8'))) {
        console.error('✘ 更新包签名无效：这个包不是用发布密钥签的，或者被改动过');
        process.exit(2);
      }
      console.log(`✔ 更新包签名有效（发布密钥 ${keyId(pem)}）`);
    } else if (mode === 'web') {
      const r = verifyWeb(pem, a);
      if (r.ok) console.log(`${pretty(r.fingerprint)}  ✔ 已由发布密钥签名`);
      else {
        console.log(`${pretty(r.fingerprint)}  ✘ ${r.why === 'files' ? '网页文件在安装后被改动过' : r.why === 'unsigned' ? '没有签名' : '签名无效'}`);
        process.exit(2);
      }
    } else throw new Error('mode');
  } catch (e) {
    console.error('✘ 无法校验：' + (e?.message ?? e));
    process.exit(4);
  }
}
