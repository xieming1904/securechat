/**
 * Passkeys (WebAuthn) in the browser. The WebAuthn helper library is loaded only when a passkey is actually used.
 */
import { api } from './api';
import { tr } from './i18n';

export const passkeysSupported = () => typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';

function friendly(e: unknown): Error {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new Error(tr('已取消，或通行密钥验证超时'));
  if (name === 'InvalidStateError') return new Error(tr('这个设备上的通行密钥已经添加过了'));
  if (name === 'SecurityError') return new Error(tr('通行密钥需要通过 https 网址打开'));
  return e instanceof Error ? e : new Error(String(e));
}

/** Sign a server challenge with one of my passkeys. */
export async function assertPasskey(optionsJSON: unknown) {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  try {
    return await startAuthentication({ optionsJSON: optionsJSON as never });
  } catch (e) {
    throw friendly(e);
  }
}

export async function createPasskey(optionsJSON: unknown) {
  const { startRegistration } = await import('@simplewebauthn/browser');
  try {
    return await startRegistration({ optionsJSON: optionsJSON as never });
  } catch (e) {
    throw friendly(e);
  }
}

/** "It's still me" for sensitive changes, using a passkey. */
export async function passkeyProof() {
  const opts = await api.post('/api/me/2fa/stepup-options');
  return { passkey: await assertPasskey(opts) };
}

/** A readable default name for a new passkey (the device it is created on). */
export function defaultPasskeyName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return tr('通行密钥');
}
