/// <reference lib="webworker" />
// OPAQUE client steps that run Argon2id (finishRegistration / finishLogin) happen here so the UI never freezes.
import * as opaque from '@serenity-kit/opaque';

self.onmessage = async (e: MessageEvent<{ id: number; op: 'finishRegistration' | 'finishLogin'; params: any }>) => {
  const { id, op, params } = e.data;
  try {
    await opaque.ready;
    const result = op === 'finishRegistration' ? opaque.client.finishRegistration(params) : opaque.client.finishLogin(params);
    (self as unknown as Worker).postMessage({ id, ok: true, result: result ?? null });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err) });
  }
};
