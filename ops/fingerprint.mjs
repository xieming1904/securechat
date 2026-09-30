#!/usr/bin/env node
// Code fingerprint of the web client (v0.8): SHA-256 over "<sha256>  <path>\n" for every file in web/dist, sorted by path.
// The same number is computed by the build, printed in each release note, shown in the app (设置 → 关于), and
// computed here from the files actually on the server:  node ops/fingerprint.mjs [web/dist]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MANIFEST = 'code-fingerprint.json';

export function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) {
      const rel = path.relative(base, p).split(path.sep).join('/');
      if (rel !== MANIFEST) out.push(rel);
    }
  }
  return out.sort();
}

export function fingerprintOf(entries) {
  const text = entries.map(([file, hash]) => `${hash}  ${file}\n`).join('');
  return crypto.createHash('sha256').update(text).digest('hex');
}

export const pretty = (hex) => hex.slice(0, 32).toUpperCase().match(/.{4}/g).join(' ');

export function computeDir(dir) {
  const entries = listFiles(dir).map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]);
  return { entries, fingerprint: fingerprintOf(entries) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist'));
  const { fingerprint } = computeDir(dir);
  let declared = null;
  try {
    declared = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')).fingerprint;
  } catch {
    /* no manifest */
  }
  console.log(pretty(fingerprint));
  if (declared && declared !== fingerprint) {
    console.error('✘ 与更新包自带的指纹不一致：网页文件在安装后被改动过');
    process.exit(2);
  }
}
