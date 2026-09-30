/**
 * Opt-in link previews: the sender's browser asks the server to fetch the page (with SSRF protection), then puts a
 * small re-encoded preview INSIDE the encrypted message. Recipients never contact the linked site.
 */
import { api } from './api';
import type { LinkPreview } from '../crypto/core';

const URL_RE = /https?:\/\/[^\s<>"'）)]+/i;
const cache = new Map<string, Promise<LinkPreview | null>>();

export function firstUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  return m[0].replace(/[.,;:!?。，；：！？]+$/, '');
}

/** Re-encode any image we got to a small JPEG (drops metadata, removes anything that isn't a plain bitmap). */
async function toThumb(dataUrl: string): Promise<string | undefined> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const max = 320;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (bmp.width < 48 || bmp.height < 48) return undefined; // favicons / tracking pixels
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const out = c.toDataURL('image/jpeg', 0.6);
    return out.length < 60_000 ? out : c.toDataURL('image/jpeg', 0.35);
  } catch {
    return undefined;
  }
}

export function fetchPreview(url: string): Promise<LinkPreview | null> {
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      try {
        const r = await api.post('/api/link-preview', { url });
        const img = r.image ? await toThumb(r.image) : undefined;
        return { url, title: String(r.title ?? '').slice(0, 200), desc: String(r.desc ?? '').slice(0, 300) || undefined, site: String(r.site ?? '').slice(0, 80) || undefined, img };
      } catch {
        return null;
      }
    })();
    cache.set(url, p);
  }
  return p;
}

/** Only render thumbnails we could have produced ourselves. */
export const safeThumb = (s?: string) => (s && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s) ? s : undefined);
