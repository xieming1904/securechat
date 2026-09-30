import { LANG, tr } from './i18n';
const pad = (n: number) => String(n).padStart(2, '0');

export function timeOf(ts: number) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (dayKey(ts) === dayKey(today.getTime())) return tr('今天');
  if (dayKey(ts) === dayKey(y.getTime())) return tr('昨天');
  return d.getFullYear() === today.getFullYear() ? tr('{v0}月{v1}日', { v0: d.getMonth() + 1, v1: d.getDate() }) : tr('{v0}年{v1}月{v2}日', { v0: d.getFullYear(), v1: d.getMonth() + 1, v2: d.getDate() });
}

export function listTime(ts: number | null) {
  if (!ts) return '';
  if (dayKey(ts) === dayKey(Date.now())) return timeOf(ts);
  const d = new Date(ts);
  return Date.now() - ts < 6 * 86_400_000 ? (LANG === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] : '周' + '日一二三四五六'[d.getDay()]) : `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fullTime(ts: number | null | undefined) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ago(ts: number | null | undefined) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return tr('刚刚');
  if (s < 3600) return tr('{v0} 分钟前', { v0: Math.floor(s / 60) });
  if (s < 86400) return tr('{v0} 小时前', { v0: Math.floor(s / 3600) });
  return tr('{v0} 天前', { v0: Math.floor(s / 86400) });
}

export const DISAPPEAR_OPTIONS: [number, string][] = [
  [0, tr('关闭')],
  [30, tr('30 秒')],
  [300, tr('5 分钟')],
  [3600, tr('1 小时')],
  [86400, tr('1 天')],
  [604800, tr('1 周')],
];
export const disappearLabel = (s: number) => DISAPPEAR_OPTIONS.find(([v]) => v === s)?.[1] ?? tr('{v0} 秒', { v0: s });

// soft two-stop gradients (top-left → bottom-right)
const COLORS = [
  'linear-gradient(135deg,#ff8a8a,#e5566c)',
  'linear-gradient(135deg,#8fd46b,#4caf6a)',
  'linear-gradient(135deg,#6ec3ff,#3b82f6)',
  'linear-gradient(135deg,#b69cff,#7c5cf0)',
  'linear-gradient(135deg,#ff9ccf,#e0569b)',
  'linear-gradient(135deg,#67dccd,#1ea7a0)',
  'linear-gradient(135deg,#ffc27a,#f08a3c)',
  'linear-gradient(135deg,#8aa8ff,#5566e8)',
];
export function colorFor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
export function initials(name: string) {
  const t = name.trim();
  if (!t) return '?';
  const parts = t.split(/\s+/);
  if (/^[\x00-\x7f]/.test(t) && parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return [...t][0].toUpperCase();
}

/** "Chrome · macOS" from a user-agent string (best effort, for showing devices to the user). */
export function describeUA(ua: string) {
  const b = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : tr('浏览器');
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${b} · ${os}` : b;
}
