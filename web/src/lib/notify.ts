/**
 * Notifications.
 *  - Web Push (tab closed): the server only ever sends {"t":"msg"}; the service worker shows "你有新消息".
 *  - Local notifications (tab open but hidden): generated in the browser from already-decrypted data,
 *    showing as much as the user allows (nothing / sender / sender + text).
 */
import { summarize } from '../components/MessageParts';
import { api } from './api';
import type { Msg } from './store';
import { tr } from './i18n';
import { prefs, setPrefs } from './prefs';

export type PreviewLevel = 'none' | 'sender' | 'full';

export function previewLevel(): PreviewLevel {
  return prefs().notifyPreview;
}
export function setPreviewLevel(l: PreviewLevel) {
  setPrefs({ notifyPreview: l });
}

export const notificationsSupported = () => typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
export const pushSupported = () => notificationsSupported() && 'PushManager' in window;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // once this version is fully up, let the service worker drop cached files of older versions
    if (!pruneScheduled) {
      pruneScheduled = true;
      setTimeout(() => {
        if (!navigator.onLine) return;
        const used = performance
          .getEntriesByType('resource')
          .map((e) => new URL(e.name).pathname)
          .filter((p) => p.startsWith('/assets/'));
        navigator.serviceWorker.controller?.postMessage({ t: 'prune', keep: used });
      }, 20_000);
    }
    return reg;
  } catch {
    return null;
  }
}
let pruneScheduled = false;

function b64urlToBytes(s: string) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function pushState(): Promise<'unsupported' | 'denied' | 'on' | 'off'> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

export async function enablePush() {
  if (!pushSupported()) throw new Error(tr('此浏览器不支持推送通知（iPhone 需要先「添加到主屏幕」）'));
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(tr('没有获得通知权限'));
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  const { publicKey } = await api.get('/api/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  const j = sub.toJSON();
  await api.post('/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

// names for local notifications are resolved lazily to avoid a circular import with the store
let resolveNames: ((m: Msg) => { chat: string; sender: string; isMe: boolean; muted: boolean }) | null = null;
export function setNameResolver(fn: typeof resolveNames) {
  resolveNames = fn;
}

export function notifyLocal(m: Msg) {
  if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !resolveNames) return;
  const info = resolveNames(m);
  if (info.isMe || info.muted) return;
  const level = previewLevel();
  const title = level === 'none' ? tr('密聊') : info.chat;
  const body =
    level === 'none' ? tr('你有新消息') : level === 'sender' ? tr('{v0} 发来一条消息', { v0: info.sender }) : `${info.sender}: ${summarize(m.payload, m.error)}`.slice(0, 140);
  navigator.serviceWorker?.getRegistration('/').then((reg) => {
    const opts = { body, tag: `chat-${m.chatId}`, icon: '/icon-192.png', badge: '/icon-192.png', data: { chatId: m.chatId } };
    if (reg) reg.showNotification(title, opts);
    else new Notification(title, opts);
  });
}

/** Secret chats: never show message content in a notification, at most who wrote. */
export function notifySecret(sender: string) {
  if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const level = previewLevel();
  const body = level === 'none' ? tr('你有新消息') : tr('{v0} 发来一条私密消息', { v0: sender });
  const opts = { body, tag: 'secret', icon: '/icon-192.png', badge: '/icon-192.png' };
  navigator.serviceWorker?.getRegistration('/').then((reg) => {
    if (reg) reg.showNotification(tr('密聊'), opts);
    else new Notification(tr('密聊'), opts);
  });
}
