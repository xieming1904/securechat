/**
 * Anonymous error reports (v0.7): when the page hits an unexpected error, send the error message and stack frames
 * (no user id, no message content) so the admin can see it in 管理后台 → 错误日志. Quoted text, query strings and long
 * tokens are removed before sending. Can be turned off per device (设置 → 通知与存储).
 */
import { prefs } from './prefs';

declare const __APP_VERSION__: string;
const MAX_PER_PAGE = 10;
let sent = 0;
const seen = new Set<string>();

const scrub = (s: string, max: number) =>
  s
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, '"…"')
    .replace(/([?#])[^\s)]*/g, '$1…')
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, '…')
    .slice(0, max);

function browser(): string {
  const ua = navigator.userAgent;
  const m = /(Edg|Firefox|Chrome|Version)\/(\d+)/.exec(ua);
  if (!m) return 'other';
  const name = m[1] === 'Edg' ? 'Edge' : m[1] === 'Version' ? 'Safari' : m[1];
  return `${name} ${m[2]}${/Mobile|Android|iPhone|iPad/.test(ua) ? ' mobile' : ''}`;
}

export function reportError(err: unknown, where = '') {
  try {
    if (!prefs().errorReports || sent >= MAX_PER_PAGE || !navigator.onLine) return;
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'non-error thrown');
    // network hiccups and user cancellations are not bugs
    if (/Failed to fetch|NetworkError|Load failed|AbortError|NotAllowedError/.test(`${e.name} ${e.message}`)) return;
    // only the error type and the beginning of its text, cut at the first quote / newline, ASCII words only:
    // error texts can embed data (JSON.parse shows a slice of its input, app errors may name a file or group)
    const head = e.message.split(/["'`\n]/)[0].replace(/[^A-Za-z0-9 _.:#()/-]+/g, '…').slice(0, 120);
    const message = scrub(`${where ? where + ': ' : ''}${e.name}: ${head}`, 200);
    // keep only stack frame lines (function names + our asset URLs)
    const stack = scrub(
      (e.stack ?? '')
        .split('\n')
        .filter((l) => /^\s*at\s|@/.test(l))
        .slice(0, 12)
        .join('\n'),
      2000,
    );
    const key = message + stack.split('\n')[0];
    if (seen.has(key)) return;
    seen.add(key);
    sent++;
    fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit', // anonymous on purpose: no session cookie
      body: JSON.stringify({ message, stack, path: location.pathname.replace(/^\/i\/.*/, '/i/…'), version: __APP_VERSION__, browser: browser() }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* never let reporting itself throw */
  }
}

export function installErrorReporting() {
  window.addEventListener('error', (ev) => {
    // resource load errors (img/script) have no .error; ignore them
    if (ev.error) reportError(ev.error);
  });
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason, 'unhandled'));
}
