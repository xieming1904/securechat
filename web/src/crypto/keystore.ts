/**
 * Local key storage. The identity private keys are kept in IndexedDB, encrypted with a
 * NON-EXTRACTABLE WebCrypto AES-GCM key (also stored in IndexedDB as a CryptoKey object).
 * Script running in the page can still *use* it, but cannot export the raw wrapping key.
 */
import { deserializeIdentity, serializeIdentity, type Identity } from './core';

const DB_NAME = 'securechat';
const STORE = 'kv';

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export const idbGet = <T>(k: string) => tx<T>('readonly', (s) => s.get(k) as IDBRequest<T>);
export const idbSet = (k: string, v: unknown) => tx('readwrite', (s) => s.put(v, k));
export const idbDel = (k: string) => tx('readwrite', (s) => s.delete(k));
export const idbClear = () => tx('readwrite', (s) => s.clear());

export const idbKeys = () => tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());

/** The non-extractable AES key that also protects the local message cache. */
export async function getWrapKey(userId: string): Promise<CryptoKey | null> {
  const rec = await idbGet<{ userId: string; wrapKey: CryptoKey }>('identity').catch(() => undefined);
  return rec && rec.userId === userId ? rec.wrapKey : null;
}

export async function saveIdentity(userId: string, id: Identity) {
  // keep the existing wrapping key for the same user so the encrypted local cache stays readable
  const wrapKey = (await getWrapKey(userId)) ?? (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  await idbSet('last-user', userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, new TextEncoder().encode(serializeIdentity(id)));
  await idbSet('identity', { userId, wrapKey, iv, ct });
}

export async function loadIdentity(userId: string): Promise<Identity | null> {
  try {
    const rec = await idbGet<{ userId: string; wrapKey: CryptoKey; iv: Uint8Array; ct: ArrayBuffer }>('identity');
    if (!rec || rec.userId !== userId) return null;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as Uint8Array<ArrayBuffer> }, rec.wrapKey, rec.ct);
    return deserializeIdentity(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}

/** Trust-on-first-use record of each contact's signing key, to detect key changes. */
export async function knownSignKey(userId: string): Promise<string | undefined> {
  return idbGet<string>(`known:${userId}`).catch(() => undefined);
}
export async function rememberSignKey(userId: string, signPk: string) {
  await idbSet(`known:${userId}`, signPk).catch(() => undefined);
}
