/**
 * Load test (v0.7): 50 users on one server process.
 *   - everyone registers (OPAQUE), joins one 50-person group (the maximum) and has a few direct chats;
 *   - everyone is connected over Socket.IO;
 *   - for DURATION seconds every user sends an encrypted message every ~INTERVAL ms (group or direct);
 *   - we measure the HTTP send latency, the time until other members receive `msg:new`, and event-loop delay.
 * The clients run in the same Node process (their crypto is cheap next to the server's work), so the numbers are
 * an upper bound for the server on this machine.
 *
 * Usage (in server/):  npx tsx test/load.ts [users=50] [seconds=60] [intervalMs=2000]
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createInvite } from '../src/invites.js';
import { allowIp } from '../src/gate.js';
import { Client, C, makeApp } from './helpers.js';

process.env.LOG_LEVEL ??= 'warn';
const USERS = Number(process.argv[2] ?? 50);
const SECONDS = Number(process.argv[3] ?? 60);
const INTERVAL = Number(process.argv[4] ?? 2000);

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 50).toFixed(0)}ms p95=${pct(xs, 95).toFixed(0)}ms p99=${pct(xs, 99).toFixed(0)}ms max=${xs.reduce((a, b) => Math.max(a, b), 0).toFixed(0)}ms`;

const env = await makeApp();
await env.app.listen({ port: 0, host: '127.0.0.1' });
const port = (env.app.server.address() as AddressInfo).port;
const t0 = Date.now();

// ---- users ----
const users: Client[] = [];
for (let i = 0; i < USERS; i++) {
  const ip = `10.77.${Math.floor(i / 250)}.${(i % 250) + 1}`;
  allowIp(env.ctx, ip, 'cli', 'load test');
  const c = new Client(env.app, ip);
  const inv = createInvite(env.ctx, { kind: 'register', maxUses: 1, grantsAdmin: i === 0 });
  await c.register(inv.token, `load${i}`, `load-password-${i}`);
  users.push(c);
}
console.log(`registered ${USERS} users in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// ---- chats: one full group + a ring of direct chats ----
const owner = users[0];
const g = await owner.createGroup('load group', users.slice(1).map((u) => u.id));
if (g.r.status !== 200) throw new Error('group: ' + g.r.body);
const chats: { id: string; key: Uint8Array; members: Client[] }[] = [{ id: g.chatId, key: g.key, members: users }];
for (let i = 0; i < USERS; i++) {
  const a = users[i];
  const b = users[(i + 1) % USERS];
  if (a === b) continue;
  const d = await a.createDirect(b.id);
  if (d.r.status !== 200) throw new Error('direct: ' + d.r.body);
  chats.push({ id: d.chatId, key: d.key, members: [a, b] });
}
console.log(`created 1 group of ${USERS} + ${chats.length - 1} direct chats`);

// ---- sockets ----
const sent = new Map<string, number>(); // clientMsgId → send time
const deliver: number[] = [];
const sockets: Socket[] = [];
for (const u of users) {
  const s = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], extraHeaders: { cookie: u.cookie, 'x-forwarded-for': u.ip } });
  await new Promise<void>((res, rej) => (s.on('connect', () => res()), s.on('connect_error', rej)));
  s.on('msg:new', (m: { clientMsgId?: string; senderId?: string }) => {
    const at = m.clientMsgId ? sent.get(m.clientMsgId) : undefined;
    if (at && m.senderId !== u.id) deliver.push(Date.now() - at);
  });
  sockets.push(s);
}
console.log(`${sockets.length} sockets connected`);

// ---- traffic ----
const post: number[] = [];
let errors = 0;
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const cpu0 = process.cpuUsage();
const end = Date.now() + SECONDS * 1000;
await Promise.all(
  users.map(async (u, i) => {
    await new Promise((r) => setTimeout(r, Math.random() * INTERVAL));
    let n = 0;
    while (Date.now() < end) {
      // 60% of messages go to the big group (fan-out to 49), the rest to one of my direct chats
      const mine = chats.filter((c) => c.members.includes(u));
      const chat = Math.random() < 0.6 ? chats[0] : mine[1 + Math.floor(Math.random() * (mine.length - 1))] ?? chats[0];
      const clientMsgId = C.newClientMsgId();
      const enc = C.encryptMessage({ t: 'text', text: `load ${i}/${n++} ` + 'x'.repeat(Math.floor(Math.random() * 200)) }, chat.key, { chatId: chat.id, epoch: 1, senderId: u.id, clientMsgId }, u.identity!);
      const t = Date.now();
      sent.set(clientMsgId, t);
      const r = await u.post(`/api/chats/${chat.id}/messages`, { clientMsgId, epoch: 1, ...enc });
      if (r.status === 200) post.push(Date.now() - t);
      else errors++;
      await new Promise((res) => setTimeout(res, INTERVAL * (0.5 + Math.random())));
    }
  }),
);
await new Promise((r) => setTimeout(r, 1500)); // let the last deliveries arrive
loop.disable();
const cpu = process.cpuUsage(cpu0);

// ---- history read (everyone opens the group) ----
const reads: number[] = [];
await Promise.all(
  users.map(async (u) => {
    const t = Date.now();
    const r = await u.get(`/api/chats/${chats[0].id}/messages?limit=50`);
    if (r.status === 200) reads.push(Date.now() - t);
  }),
);

const mem = process.memoryUsage();
console.log('');
console.log(`== ${USERS} users · ${SECONDS} s · one message per ~${INTERVAL} ms per user ==`);
console.log(`messages sent        ${post.length}  (${(post.length / SECONDS).toFixed(1)}/s), errors ${errors}`);
console.log(`send (HTTP)          ${fmt(post)}`);
console.log(`delivered (socket)   ${fmt(deliver)}`);
console.log(`history read (50)    ${fmt(reads)}`);
console.log(`event-loop delay     p50=${(loop.percentile(50) / 1e6).toFixed(1)}ms p99=${(loop.percentile(99) / 1e6).toFixed(1)}ms max=${(loop.max / 1e6).toFixed(1)}ms`);
console.log(`CPU (incl. clients)  ${((cpu.user + cpu.system) / 1e6 / SECONDS * 100).toFixed(0)}% of one core`);
console.log(`memory               rss=${(mem.rss / 1048576).toFixed(0)} MB heap=${(mem.heapUsed / 1048576).toFixed(0)} MB`);

for (const s of sockets) s.close();
await env.app.close();
process.exit(errors ? 1 : 0);
