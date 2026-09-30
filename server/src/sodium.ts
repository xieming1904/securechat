import _sodium from 'libsodium-wrappers-sumo';
import * as opaque from '@serenity-kit/opaque';
import type { DB } from './db.js';
import { getSetting, setSetting } from './db.js';

let sodium: typeof _sodium;
let opaqueSetup = '';

export async function initSodium() {
  await _sodium.ready;
  await opaque.ready;
  sodium = _sodium;
  return sodium;
}
export const S = () => sodium;

/**
 * OPAQUE server setup (the server's long-term OPRF + AKE key).
 * Production: set OPAQUE_SERVER_SETUP in the environment so the key is NOT inside database backups.
 * Otherwise it is generated once and kept in the settings table.
 */
export function initOpaqueSetup(db: DB) {
  const fromEnv = process.env.OPAQUE_SERVER_SETUP;
  if (fromEnv) opaqueSetup = fromEnv;
  else {
    let s = getSetting(db, 'opaque_server_setup');
    if (!s) {
      s = opaque.server.createSetup();
      setSetting(db, 'opaque_server_setup', s);
    }
    opaqueSetup = s;
  }
  // Every OPAQUE record is bound to this key. Refuse to start with a different one once accounts exist,
  // instead of silently locking everybody out.
  const pk = opaque.server.getPublicKey(opaqueSetup);
  const pinned = getSetting(db, 'opaque_server_pk');
  const hasUsers = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
  if (pinned && pinned !== pk && hasUsers) {
    throw new Error(
      'OPAQUE_SERVER_SETUP 与创建现有账号时使用的不一致。继续运行会让所有账号无法登录（恢复词也会失效）。' +
        '请恢复原来的 OPAQUE_SERVER_SETUP（或去掉该环境变量以使用数据库中保存的值）。',
    );
  }
  setSetting(db, 'opaque_server_pk', pk);
  return opaqueSetup;
}
export const serverSetup = () => opaqueSetup;
export const serverPublicKey = () => opaque.server.getPublicKey(opaqueSetup);
export { opaque };

/** Argon2id hash for human passwords (the site access password). */
export function hashPassword(password: string): string {
  return sodium.crypto_pwhash_str(password, sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE);
}
export function verifyPassword(hash: string, password: string): boolean {
  try {
    return sodium.crypto_pwhash_str_verify(hash, password);
  } catch {
    return false;
  }
}

/** Length-prefixed binary encoding — must match web/src/crypto/core.ts encodeFields(). */
export const PROTOCOL_VERSION = 1;
export function encodeFields(tag: string, fields: (string | number)[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const f of [tag, `v${PROTOCOL_VERSION}`, ...fields.map(String)]) {
    const b = Buffer.from(f, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    parts.push(len, b);
  }
  return Buffer.concat(parts);
}

export function verifySig(signatureB64: string, message: Uint8Array, signPkB64: string): boolean {
  try {
    return sodium.crypto_sign_verify_detached(Buffer.from(signatureB64, 'base64url'), message, Buffer.from(signPkB64, 'base64url'));
  } catch {
    return false;
  }
}
