/**
 * Thin async wrapper around the OPAQUE client. In the browser the expensive steps run in a Web Worker;
 * in Node (tests) they run inline.
 */
type Opaque = typeof import('@serenity-kit/opaque');
// ~420 KB of WebAssembly: only loaded when someone actually logs in / registers / changes a password
let mod: Promise<Opaque> | null = null;
const load = () =>
  (mod ??= import('@serenity-kit/opaque').then(async (m) => {
    await m.ready;
    return m;
  }));

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function inWorker<T>(op: 'finishRegistration' | 'finishLogin', params: unknown): Promise<T> {
  if (typeof Worker === 'undefined') {
    return load().then((opaque) => ((op === 'finishRegistration' ? opaque.client.finishRegistration(params as any) : opaque.client.finishLogin(params as any)) ?? null) as T);
  }
  if (!worker) {
    worker = new Worker(new URL('./opaque.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      e.data.ok ? w.resolve(e.data.result) : w.reject(new Error(e.data.error));
    };
  }
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker!.postMessage({ id, op, params });
  });
}

export async function startRegistration(password: string) {
  return (await load()).client.startRegistration({ password });
}
export function finishRegistration(p: { password: string; clientRegistrationState: string; registrationResponse: string }) {
  return inWorker<{ registrationRecord: string; exportKey: string; serverStaticPublicKey: string }>('finishRegistration', p);
}
export async function startLogin(password: string) {
  return (await load()).client.startLogin({ password });
}
/** Resolves to null when the password is wrong. */
export function finishLogin(p: { password: string; clientLoginState: string; loginResponse: string }) {
  return inWorker<{ finishLoginRequest: string; sessionKey: string; exportKey: string; serverStaticPublicKey: string } | null>('finishLogin', p);
}
