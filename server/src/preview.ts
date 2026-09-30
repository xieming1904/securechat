/**
 * Opt-in link previews.
 *
 * Only the SENDER's browser asks for a preview (and only if they switched it on in their settings). The result is put
 * inside the end-to-end encrypted message, so recipients never contact the linked site and the server never sees what
 * was sent — it only learns which URL the sender asked to preview, at the moment they asked.
 *
 * SSRF protection: http/https on standard ports only; every hostname is resolved by us and EVERY resolved address must
 * be public (no loopback, private, link-local, CGNAT, multicast, reserved, IPv4-mapped…); the socket connects to the
 * address we validated (custom lookup, so no DNS-rebinding window); redirects are followed manually (max 3) and each hop
 * is validated again; strict timeouts and byte limits; no cookies or credentials are ever sent.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import type { LookupFunction } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { requireUser } from './auth.js';
import { limits } from './settings.js';
import { HttpError, str } from './util.js';

const HTML_LIMIT = 512 * 1024;
const IMG_LIMIT = 600 * 1024;
const TIMEOUT = 6_000;
const PER_MINUTE = 20;

// ---------------------------------------------------------------- address checks
function v4Blocked(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this-net, private, loopback, multicast + reserved + broadcast
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF, TEST-NET-1
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** This server's own addresses (public IP behind NAT, interface IPs): never fetch ourselves. */
const selfIps = new Set<string>();
export function addSelfIp(ip: string) {
  if (net.isIP(ip)) selfIps.add(ip.toLowerCase());
}

export function isBlockedAddress(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0];
  const mappedSelf = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (selfIps.has(lower) || (mappedSelf && selfIps.has(mappedSelf))) return true;
  const fam = net.isIP(ip);
  if (fam === 4) return v4Blocked(ip);
  if (fam !== 6) return true;
  const x = ip.toLowerCase().split('%')[0];
  if (x === '::' || x === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return v4Blocked(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(x)) return true; // mapped, hex form — just refuse
  const first = parseInt(x.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local
    (first & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (first & 0xff00) === 0xff00 || // multicast
    first === 0x2001 && parseInt(x.split(':')[1] || '0', 16) === 0x0db8 || // documentation
    first === 0x0064 || // 64:ff9b::/96 NAT64 (could reach internal v4)
    first === 0x2002 || // 6to4
    first === 0 // anything else in ::/16
  );
}

const safeLookup: LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return (cb as (e: Error | null, a: string, f: number) => void)(err, '', 0);
    const list = addrs as dns.LookupAddress[];
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
      return (cb as (e: Error | null, a: string, f: number) => void)(new HttpError(400, 'blocked_host', '不允许预览内网地址'), '', 0);
    }
    const want = (options as dns.LookupOptions).family;
    const pick = list.find((a) => !want || a.family === want) ?? list[0];
    if ((options as dns.LookupOptions).all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, [pick]);
    (cb as (e: Error | null, a: string, f: number) => void)(null, pick.address, pick.family);
  });
};

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'bad_url', '链接无效');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'bad_url', '只支持 http/https 链接');
  if (u.username || u.password) throw new HttpError(400, 'bad_url', '链接里不能带账号密码');
  if (u.port && !['80', '443'].includes(u.port)) throw new HttpError(400, 'bad_url', '只支持标准端口');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) throw new HttpError(400, 'blocked_host', '不允许预览内网地址');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new HttpError(400, 'blocked_host', '不允许预览内网地址');
  return u;
}

interface Fetched {
  url: URL;
  type: string;
  body: Buffer;
}

function fetchOnce(u: URL, accept: string, limit: number): Promise<{ status: number; location?: string; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'GET',
        lookup: safeLookup,
        timeout: TIMEOUT,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SecureChatPreview/1.0)',
          Accept: accept,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'identity',
        },
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, location: res.headers.location, type: '', body: Buffer.alloc(0) });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > limit) {
            chunks.push(c.subarray(0, Math.max(0, limit - (size - c.length))));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const done = () => resolve({ status, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    const hard = setTimeout(() => req.destroy(new HttpError(504, 'timeout', '网页响应超时')), TIMEOUT + 2000);
    req.on('timeout', () => req.destroy(new HttpError(504, 'timeout', '网页响应超时')));
    req.on('error', (e) => (clearTimeout(hard), reject(e)));
    req.on('close', () => clearTimeout(hard));
    req.end();
  });
}

async function safeFetch(start: URL, accept: string, limit: number): Promise<Fetched> {
  let u = start;
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetchOnce(u, accept, limit);
    if (r.location) {
      u = checkUrl(new URL(r.location, u).toString());
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw new HttpError(502, 'upstream', `网页返回 ${r.status}`);
    return { url: u, type: r.type.toLowerCase(), body: r.body };
  }
  throw new HttpError(502, 'upstream', '重定向次数过多');
}

// ---------------------------------------------------------------- HTML → preview
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();

/** Linear-time attribute parser (no backtracking regexes: page HTML is attacker-controlled). */
export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const n = Math.min(tag.length, 4096);
  let i = 0;
  const isName = (c: string) => /[a-zA-Z0-9:_-]/.test(c);
  while (i < n) {
    while (i < n && !isName(tag[i])) i++;
    const s = i;
    while (i < n && isName(tag[i])) i++;
    const name = tag.slice(s, i).toLowerCase();
    while (i < n && (tag[i] === ' ' || tag[i] === '\t' || tag[i] === '\n' || tag[i] === '\r')) i++;
    if (tag[i] !== '=') continue;
    i++;
    while (i < n && (tag[i] === ' ' || tag[i] === '\t' || tag[i] === '\n' || tag[i] === '\r')) i++;
    let v = '';
    const q = tag[i];
    if (q === '"' || q === "'") {
      const e = tag.indexOf(q, i + 1);
      const end = e < 0 || e > n ? n : e;
      v = tag.slice(i + 1, end);
      i = end + 1;
    } else {
      const s2 = i;
      while (i < n && !/[\s>]/.test(tag[i])) i++;
      v = tag.slice(s2, i);
    }
    if (name && !(name in out)) out[name] = v;
  }
  return out;
}

function charsetOf(type: string, head: Buffer): string {
  const fromHeader = /charset=([\w-]+)/i.exec(type)?.[1];
  const fromMeta = /<meta[^<>]{0,512}charset\s{0,5}=\s{0,5}["']?([\w-]{1,40})/i.exec(head.subarray(0, 4096).toString('latin1'))?.[1];
  const cs = (fromHeader ?? fromMeta ?? 'utf-8').toLowerCase();
  return ['gbk', 'gb2312', 'gb18030', 'big5', 'shift_jis', 'euc-jp', 'euc-kr', 'windows-1252', 'iso-8859-1', 'utf-8'].includes(cs) ? cs : 'utf-8';
}

export function parsePreview(html: string, base: URL) {
  const head = html.slice(0, 300_000);
  const lower = head.toLowerCase();
  const meta: Record<string, string> = {};
  // scan <meta …> tags with indexOf (linear), each tag capped at 4 KB
  for (let pos = lower.indexOf('<meta'); pos >= 0 && Object.keys(meta).length < 200; pos = lower.indexOf('<meta', pos + 5)) {
    const end = lower.indexOf('>', pos);
    if (end < 0) break;
    if (end - pos > 4096) continue;
    const a = attrs(head.slice(pos + 5, end));
    const k = (a.property ?? a.name ?? '').toLowerCase();
    if (k && a.content && !(k in meta)) meta[k] = decode(a.content.slice(0, 2000));
  }
  let titleTag: string | undefined;
  const ts = lower.indexOf('<title');
  if (ts >= 0) {
    const open = lower.indexOf('>', ts);
    const close = open >= 0 ? lower.indexOf('</title>', open) : -1;
    if (open >= 0 && close > open) titleTag = head.slice(open + 1, Math.min(close, open + 1 + 2000));
  }
  const title = meta['og:title'] ?? meta['twitter:title'] ?? (titleTag ? decode(titleTag) : '');
  const desc = meta['og:description'] ?? meta['twitter:description'] ?? meta['description'] ?? '';
  const site = meta['og:site_name'] ?? base.hostname.replace(/^www\./, '');
  let image: string | undefined = meta['og:image:secure_url'] ?? meta['og:image'] ?? meta['twitter:image'] ?? meta['twitter:image:src'];
  try {
    image = image ? new URL(image, base).toString() : undefined;
  } catch {
    image = undefined;
  }
  return { title: title.slice(0, 200), desc: desc.slice(0, 300), site: site.slice(0, 80), image };
}

export function registerPreview(app: FastifyInstance, ctx: Ctx) {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) addSelfIp(a.address);
  for (const ip of (process.env.PREVIEW_DENY_IPS ?? '').split(',')) addSelfIp(ip.trim());
  try {
    const host = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).hostname : '';
    if (host) dns.lookup(host, { all: true }, (err, addrs) => !err && (addrs as dns.LookupAddress[]).forEach((a) => addSelfIp(a.address)));
  } catch {
    /* bad PUBLIC_ORIGIN */
  }
  const hits = new Map<string, number[]>();

  app.post('/api/link-preview', async (req) => {
    const { user } = requireUser(ctx, req);
    if (!limits(ctx).linkPreview) throw new HttpError(403, 'disabled', '管理员已关闭链接预览');
    const t = Date.now();
    const recent = (hits.get(user.id) ?? []).filter((x) => x > t - 60_000);
    if (recent.length >= PER_MINUTE) throw new HttpError(429, 'rate_limited', '预览请求太频繁');
    recent.push(t);
    hits.set(user.id, recent);

    const url = checkUrl(str(req.body as Record<string, unknown>, 'url', { max: 2048 }));
    let page: Fetched;
    try {
      page = await safeFetch(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', HTML_LIMIT);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'upstream', '无法打开这个网页');
    }
    if (!/text\/html|application\/xhtml/.test(page.type)) throw new HttpError(415, 'not_html', '不是网页');
    let html: string;
    try {
      html = new TextDecoder(charsetOf(page.type, page.body)).decode(page.body);
    } catch {
      html = page.body.toString('utf8');
    }
    const p = parsePreview(html, page.url);
    if (!p.title && !p.desc) throw new HttpError(404, 'no_preview', '这个网页没有可预览的信息');

    let image: string | undefined;
    if (p.image) {
      try {
        const img = await safeFetch(checkUrl(p.image), 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', IMG_LIMIT);
        if (/^image\/(png|jpeg|jpg|webp|gif|avif)/.test(img.type) && img.body.length < IMG_LIMIT)
          image = `data:${img.type.split(';')[0]};base64,${img.body.toString('base64')}`;
      } catch {
        /* preview without image */
      }
    }
    return { url: page.url.toString(), title: p.title, desc: p.desc, site: p.site, image };
  });
}
