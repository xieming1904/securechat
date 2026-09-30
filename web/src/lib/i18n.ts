/**
 * Minimal i18n. Source strings are the Chinese UI texts themselves; `t()` looks them up in the English table when
 * the interface language is English and falls back to the Chinese text for anything not (yet) translated.
 * `{name}` placeholders are filled from `vars`. Switching language reloads the page.
 */
let EN: Record<string, string> = {};

type Vars = Record<string, string | number | undefined | null>;

function currentLang(): 'zh' | 'en' {
  try {
    const p = JSON.parse(localStorage.getItem('securechat.prefs.v1') ?? '{}');
    if (p.lang === 'en' || p.lang === 'zh') return p.lang;
  } catch {
    /* storage unavailable */
  }
  return 'zh'; // Chinese unless the user picks English in Settings → Appearance
}

export const LANG = currentLang();
if (typeof document !== 'undefined') document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';

/** Load the English table (a separate chunk) before the first render. */
export async function loadLanguage() {
  if (LANG === 'en') EN = (await import('./i18n.en')).EN;
}

export function tr(zh: string, vars?: Vars): string {
  const s = LANG === 'en' ? (EN[zh] ?? zh) : zh;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k]))) : s;
}
