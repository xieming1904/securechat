/**
 * UI preferences. Stored in localStorage; the fields in SYNCED are also kept (encrypted) in my vault and follow me
 * to my other devices (lib/prefsync.ts). Font size, language and the Enter key stay per device (they depend on the screen).
 * Stored in localStorage; every access is wrapped because storage can be unavailable (private mode, blocked).
 */
import { create } from 'zustand';

export type FontSize = 's' | 'm' | 'l' | 'xl';
export type ChatBg = 'dots' | 'plain' | 'aurora' | 'grid' | 'paper';
export type Lang = 'zh' | 'en';

export interface Prefs {
  fontSize: FontSize;
  chatBg: ChatBg;
  lang: Lang;
  /** chat ids whose messages must not be written to the local encrypted cache */
  noCache: string[];
  /** ask the server to fetch link previews (the server then sees the URL) */
  linkPreview: boolean;
  /** enter sends; when false, Ctrl/Cmd+Enter sends */
  enterSends: boolean;
  /** calls: only use the TURN relay, so the other side never learns my IP address */
  callRelayOnly: boolean;
  /** blur the app when it goes to the background (app switcher thumbnails, shoulder surfing) */
  privacyScreen: boolean;
  /** what local notifications show: nothing / sender / sender + text */
  notifyPreview: 'none' | 'sender' | 'full';
  /** a muted chat still notifies (tab open) when someone @mentions me. Per device. */
  mentionBypassMute: boolean;
  /** send anonymous error reports (message + stack frames, no content) to the admin. Per device. */
  errorReports: boolean;
}

export const SYNCED = ['chatBg', 'noCache', 'linkPreview', 'callRelayOnly', 'privacyScreen', 'notifyPreview'] as const;
export type SyncedPrefs = Pick<Prefs, (typeof SYNCED)[number]>;

const KEY = 'securechat.prefs.v1';
const DEFAULTS: Prefs = { fontSize: 'm', chatBg: 'dots', lang: 'zh', noCache: [], linkPreview: false, enterSends: true, callRelayOnly: false, privacyScreen: true, notifyPreview: 'sender', mentionBypassMute: true, errorReports: true };

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = { ...DEFAULTS, ...JSON.parse(raw) } as Prefs;
      // v0.4 kept the notification preview level under its own key
      const old = localStorage.getItem('notify-preview');
      if (old && !JSON.parse(raw).notifyPreview && ['none', 'sender', 'full'].includes(old)) p.notifyPreview = old as Prefs['notifyPreview'];
      return p;
    }
  } catch {
    /* storage unavailable */
  }
  const lang: Lang = typeof navigator !== 'undefined' && !navigator.language?.toLowerCase().startsWith('zh') ? 'en' : 'zh';
  return { ...DEFAULTS, lang };
}

export const usePrefs = create<Prefs>(() => load());

export function setPrefs(p: Partial<Prefs>) {
  usePrefs.setState(p);
  try {
    localStorage.setItem(KEY, JSON.stringify(usePrefs.getState()));
  } catch {
    /* ignore */
  }
  applyPrefs();
}

export const prefs = () => usePrefs.getState();

/** Reflect prefs on <html> so CSS can react (font size, chat background, language). */
export function applyPrefs() {
  const p = usePrefs.getState();
  const el = document.documentElement;
  el.dataset.fs = p.fontSize;
  el.dataset.bg = p.chatBg;
  el.lang = p.lang === 'en' ? 'en' : 'zh-CN';
}

export function isCacheDisabled(chatId: string) {
  return usePrefs.getState().noCache.includes(chatId);
}
