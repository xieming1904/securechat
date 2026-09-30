#!/usr/bin/env node
// Build the signed update package (developer side; not shipped).
//   node tools/release.mjs <release-signing.pem> <out.tar.gz>
// Expects `npm run build` done. Writes <out.tar.gz> and <out.tar.gz>.sig, signs web/dist/code-fingerprint.json inside.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MANIFEST, computeDir, pretty } from '../ops/fingerprint.mjs';
import { webMessage, keyId, verifyPackage, verifyWeb } from '../ops/verify-release.mjs';

const [keyFile, out] = process.argv.slice(2);
if (!keyFile || !out) throw new Error('usage: release.mjs <key.pem> <out.tar.gz>');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
const pubPem = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
if (pubPem.trim() !== fs.readFileSync(path.join(root, 'ops/release.pub'), 'utf8').trim()) throw new Error('key does not match ops/release.pub');

const stage = fs.mkdtempSync('/tmp/claude-0/sc-release-');
const dst = path.join(stage, 'securechat');
const copy = (rel, to = rel) => fs.cpSync(path.join(root, rel), path.join(dst, to), { recursive: true });
copy('server/dist');
copy('server/package.json');
copy('web/dist');
copy('web/package.json');
copy('ops');
for (const f of ['start.sh', 'package.json', 'package-lock.json', 'CHANGELOG.md']) copy(f);
for (const f of ['使用手册.md', '运维手册.md', '安全设计.md', '前向保密设计.md']) copy(`docs/${f}`);

// sign the web code fingerprint (after re-checking it matches the files)
const dist = path.join(dst, 'web/dist');
const m = JSON.parse(fs.readFileSync(path.join(dist, MANIFEST), 'utf8'));
const { fingerprint } = computeDir(dist);
if (fingerprint !== m.fingerprint) throw new Error('manifest does not match web/dist — rebuild');
m.sig = crypto.sign(null, webMessage(m.version, m.fingerprint), key).toString('base64');
fs.writeFileSync(path.join(dist, MANIFEST), JSON.stringify(m));
if (!verifyWeb(pubPem, dist).ok) throw new Error('web signature self-check failed');

execFileSync('tar', ['czf', path.resolve(out), '--owner=0', '--group=0', '-C', stage, 'securechat']);
const sig = crypto.sign(null, fs.readFileSync(out), key).toString('base64');
fs.writeFileSync(out + '.sig', sig + '\n');
if (!verifyPackage(pubPem, out, sig)) throw new Error('package signature self-check failed');
console.log(`version      ${m.version}`);
console.log(`sha256       ${crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex')}`);
console.log(`fingerprint  ${pretty(m.fingerprint)}`);
console.log(`release key  ${keyId(pubPem)}`);
fs.rmSync(stage, { recursive: true, force: true });
