import { tr } from './i18n';
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, attempt = 0): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    // the server's flood guard refused the request before handling it: wait and try again (a few times)
    if (res.status === 429 && json?.error === 'slow_down' && attempt < 4) {
      const wait = (Number(res.headers.get('retry-after')) || 2) * 1000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      return request<T>(method, url, body, attempt + 1);
    }
    if (res.status === 403 && (json?.error === 'ip_not_allowed' || json?.error === 'ip_blocked')) backToGate();
    throw new ApiError(res.status, json?.error ?? 'error', json?.message ?? tr('请求失败 ({v0})', { v0: res.status }));
  }
  return json as T;
}

export const api = {
  get: <T = any>(u: string) => request<T>('GET', u),
  post: <T = any>(u: string, b: unknown = {}) => request<T>('POST', u, b),
  put: <T = any>(u: string, b: unknown = {}) => request<T>('PUT', u, b),
  patch: <T = any>(u: string, b: unknown = {}) => request<T>('PATCH', u, b),
  del: <T = any>(u: string) => request<T>('DELETE', u),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Our IP was removed from the allow-list (or changed network): reload so the server shows the gate page. */
export function backToGate() {
  try {
    const last = Number(sessionStorage.getItem('gate-reload') ?? 0);
    if (Date.now() - last < 15_000) return; // avoid reload loops (e.g. Vite dev server serving the SPA directly)
    sessionStorage.setItem('gate-reload', String(Date.now()));
  } catch {
    /* storage unavailable */
  }
  location.reload();
}
