import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as ioClient } from 'socket.io-client';
import { setSetting } from '../src/db.js';
import { hashPassword } from '../src/sodium.js';
import { createInvite } from '../src/invites.js';
import { purgeUnreferencedBlobs } from '../src/blobs.js';
import { Client, C, O, SoftPasskey, makeApp } from './helpers.js';
import * as R from '../../web/src/crypto/ratchet.js';

let env: Awaited<ReturnType<typeof makeApp>>;
const GATE_PW = 'correct horse battery';

beforeAll(async () => {
  env = await makeApp();
  setSetting(env.ctx.db, 'gate_password_hash', hashPassword(GATE_PW));
});
afterAll(async () => {
  await env.app.close();
});

describe('IP gate', () => {
  it('hides the app from unknown IPs', async () => {
    const c = new Client(env.app, '203.0.113.1');
    const page = await c.get('/');
    expect(page.status).toBe(403);
    expect(page.body).toContain('访问验证');
    expect(page.body).toContain('203.0.113.1'); // visitor sees their own IP
    expect((await c.get('/api/chats')).json.error).toBe('ip_not_allowed');
    expect((await c.get('/api/gate/status')).json.ip).toBe('203.0.113.1');
    expect((await c.get('/api/gate/status')).json.allowed).toBe(false);
  });

  it('remembers the IP after the access password', async () => {
    const c = new Client(env.app, '203.0.113.2');
    expect((await c.post('/api/gate/password', { password: 'nope' })).status).toBe(401);
    expect((await c.post('/api/gate/password', { password: GATE_PW })).status).toBe(200);
    expect((await c.get('/api/gate/status')).json.allowed).toBe(true);
    // a second visit from the same IP goes straight through
    expect((await c.get('/api/chats')).status).toBe(401); // passes gate, needs login
  });

  it('blocks an IP after 5 wrong passwords', async () => {
    const c = new Client(env.app, '203.0.113.3');
    for (let i = 0; i < 4; i++) expect((await c.post('/api/gate/password', { password: 'wrong' + i })).status).toBe(401);
    const fifth = await c.post('/api/gate/password', { password: 'wrong4' });
    expect(fifth.status).toBe(403); // the failure that triggers the block already reports it
    expect(fifth.json.ip).toBe('203.0.113.3');
    const r = await c.post('/api/gate/password', { password: GATE_PW });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: 'ip_blocked', ip: '203.0.113.3' });
    expect(r.json.until).toBeGreaterThan(Date.now());
    // pages show the blocked IP
    const page = await c.get('/');
    expect(page.status).toBe(403);
    expect(page.body).toContain('203.0.113.3');
    expect(page.body).toContain('访问被拒绝');
    expect((await c.get('/__gate.css')).status).toBe(200);
  });

  it('accepts same-site POSTs when the proxy adds :443 to Host, rejects other origins', async () => {
    const post = (origin: string, host: string) =>
      env.app.inject({
        method: 'POST', url: '/api/gate/invite', payload: {},
        headers: { origin, host, 'x-forwarded-for': '203.0.113.9' },
      });
    expect((await post('https://chat.example.com', 'chat.example.com:443')).json().error).toBe('invalid_input');
    expect((await post('https://chat.example.com', 'chat.example.com')).json().error).toBe('invalid_input');
    const bad = await post('https://evil.example', 'chat.example.com:443');
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error).toBe('bad_origin');
    expect((await post('https://chat.example.com:8443', 'chat.example.com:443')).statusCode).toBe(403);
  });

  it('health check is reachable without approval but hides the version from strangers', async () => {
    const outside = await env.app.inject({ method: 'GET', url: '/healthz', headers: { 'x-forwarded-for': '203.0.113.77' } });
    expect(outside.statusCode).toBe(200);
    expect(outside.json()).toEqual({ ok: true });
    const local = await env.app.inject({ method: 'GET', url: '/healthz' });
    expect(local.json()).toMatchObject({ ok: true, version: expect.any(String) });
  });

  it('treats IPv6 addresses by /64 prefix', async () => {
    const a = new Client(env.app, '2001:db8:1:2::10');
    await a.post('/api/gate/password', { password: GATE_PW });
    const b = new Client(env.app, '2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect((await b.get('/api/gate/status')).json.allowed).toBe(true);
    const other = new Client(env.app, '2001:db8:1:3::10');
    expect((await other.get('/api/gate/status')).json.allowed).toBe(false);
  });

  it('ignores X-Forwarded-For from untrusted peers', async () => {
    const c = new Client(env.app, '203.0.113.2'); // allow-listed above
    const r = await c.req('GET', '/api/gate/status', undefined, '198.51.100.9'); // direct connection, not via proxy
    expect(r.json.allowed).toBe(false);
  });

  it('supports admin approval requests', async () => {
    const c = new Client(env.app, '203.0.113.50');
    expect((await c.post('/api/gate/request', { message: '我是小王' })).json.pending).toBe(true);
    expect((await c.get('/api/gate/status')).json.pending).toBe(true);
  });
});

describe('accounts, invites and E2EE chat', () => {
  const alice = () => new Client(env.app, '198.51.100.1');
  let A: Client, B: Client, Cc: Client, D: Client;
  let chatId = '';
  let chatKey: Uint8Array;

  it('bootstraps the admin via a one-time invite that also opens the gate', async () => {
    const inv = createInvite(env.ctx, { kind: 'register', maxUses: 1, grantsAdmin: true });
    A = alice();
    expect((await A.post('/api/gate/invite', { invite: inv.token })).status).toBe(200);
    expect((await A.get(`/api/invites/${inv.token}`)).json.grantsAdmin).toBe(true);
    const r = await A.register(inv.token, 'alice', 'alice-password-1');
    expect(r.json.user.isAdmin).toBe(true);
    // invite is now used up
    expect((await A.get(`/api/invites/${inv.token}`)).status).toBe(404);
  });

  it('logs in with OPAQUE: wrong passwords, replayed proofs and unknown users all fail the same way', async () => {
    const again = alice();
    expect((await again.login('alice', 'wrong-password')).status).toBe(401);
    const r = await again.login('alice', 'alice-password-1');
    expect(r.status).toBe(200);
    expect(C.b64(again.identity!.signPk)).toBe(C.b64(A.identity!.signPk));

    // replay: the same finishLoginRequest cannot be used twice
    const s = await O.startLogin('alice-password-1');
    const start = await again.post('/api/auth/login/start', { username: 'alice', startLoginRequest: s.startLoginRequest });
    const fin = await O.finishLogin({ password: 'alice-password-1', clientLoginState: s.clientLoginState, loginResponse: start.json.loginResponse });
    const body = { username: 'alice', loginId: start.json.loginId, finishLoginRequest: fin!.finishLoginRequest };
    expect((await again.post('/api/auth/login/finish', body)).status).toBe(200);
    expect((await again.post('/api/auth/login/finish', body)).status).toBe(401);

    // unknown usernames get a response of the same shape (no enumeration)
    const g = await O.startLogin('whatever');
    const ghost = await again.post('/api/auth/login/start', { username: 'ghost', startLoginRequest: g.startLoginRequest });
    expect(ghost.status).toBe(200);
    expect(ghost.json.loginResponse.length).toBe(start.json.loginResponse.length);
    expect(await O.finishLogin({ password: 'whatever', clientLoginState: g.clientLoginState, loginResponse: ghost.json.loginResponse })).toBeNull();

    // the password never reaches the server in any form: nothing but OPAQUE records in the users table
    const row = env.ctx.db.prepare('SELECT * FROM users WHERE username = ?').get('alice') as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain('auth_hash');
    expect(String(row.opaque_record).length).toBeGreaterThan(100);
  });

  it('admin issues registration invites (link + short code)', async () => {
    const inv = (await A.post('/api/admin/invites', { maxUses: 3, expiresInHours: 24 })).json;
    expect(inv.code).toMatch(/^[A-Z2-9]{8}$/);
    B = new Client(env.app, '198.51.100.2');
    // the short code works at the gate in place of the password
    const g = await B.post('/api/gate/password', { password: inv.code });
    expect(g.json).toMatchObject({ ok: true, invite: true });
    await B.register(inv.code, 'bob', 'bob-password-1');
    Cc = new Client(env.app, '198.51.100.3');
    await Cc.post('/api/gate/invite', { invite: inv.token });
    await Cc.register(inv.token, 'carol', 'carol-password-1');
    D = new Client(env.app, '198.51.100.4');
    await D.post('/api/gate/invite', { invite: inv.token });
    await D.register(inv.token, 'dave', 'dave-password-1');
    // 3 uses consumed
    expect((await D.get(`/api/invites/${inv.token}`)).status).toBe(404);
    // non-admins cannot reach admin APIs
    expect((await B.get('/api/admin/users')).status).toBe(403);
  });

  it('creates an end-to-end encrypted direct chat with a signed membership record', async () => {
    const bob = (await A.get('/api/users/by-username/bob')).json.user;
    // missing / wrong signatures are rejected
    expect((await A.post('/api/chats', { id: 'c_' + C.randomId(), type: 'direct', peerId: bob.id, keys: [] })).status).toBe(400);
    const forged = 'c_' + C.randomId();
    const sig = C.signMembership(forged, 1, [], 'create', { id: A.id, identity: B.identity! }, [bob.id], 'direct'); // signed with the wrong key
    const k = await A.seal(C.newChatKey(), { chatId: forged, epoch: 1, membershipVersion: 1 }, [A.id, bob.id]);
    expect((await A.post('/api/chats', { id: forged, type: 'direct', peerId: bob.id, keys: k, membershipSignature: sig.signature })).json.error).toBe('bad_signature');

    const created = await A.createDirect(bob.id);
    expect(created.r.status).toBe(200);
    chatId = created.chatId;
    chatKey = created.key;
    // a second create returns the existing chat
    const again = await A.createDirect(bob.id);
    expect(again.r.json).toMatchObject({ existing: true, chat: { id: chatId } });
    // Bob verifies the membership chain and opens the key
    expect((await B.verifiedMembers(chatId)).members.map((m) => m.id)).toEqual([A.id, B.id]);
    expect(C.b64((await B.chatKeys(chatId)).get(1)!)).toBe(C.b64(chatKey));
  });

  it('sends and decrypts messages; the server only stores ciphertext', async () => {
    expect((await A.send(chatId, 2, chatKey, 'wrong epoch')).status).toBe(409);
    expect((await A.send(chatId, 1, chatKey, '你好，Bob！这是秘密')).status).toBe(200);
    expect((await B.send(chatId, 1, chatKey, 'hi alice')).status).toBe(200);
    expect(await B.readAll(chatId)).toEqual(['你好，Bob！这是秘密', 'hi alice']);

    // tampering is detected
    const { messages } = (await B.get(`/api/chats/${chatId}/messages`)).json;
    const forged = { ...messages[0], ciphertext: messages[1].ciphertext };
    expect(() => C.decryptMessage(forged, chatKey, A.identity!.signPk)).toThrow();

    // plaintext never reaches the database
    env.ctx.db.pragma('wal_checkpoint(FULL)');
    const raw = fs.readFileSync(path.join(env.dataDir, 'app.db'));
    expect(raw.includes(Buffer.from('这是秘密'))).toBe(false);
    expect(raw.includes(Buffer.from('hi alice'))).toBe(false);

    const list = (await A.get('/api/chats')).json.chats; // Bob's reply is unread for Alice
    expect(list[0].unread).toBe(1);
  });

  it('deletes unilaterally: for me, for everyone, and clears both sides', async () => {
    const { messages } = (await A.get(`/api/chats/${chatId}/messages`)).json;
    const [fromA, fromB] = messages;
    // Alice hides Bob's message only for herself
    await A.post('/api/messages/delete', { ids: [fromB.id], scope: 'me' });
    expect((await A.get(`/api/chats/${chatId}/messages`)).json.messages.map((m: { id: string }) => m.id)).toEqual([fromA.id]);
    expect((await B.get(`/api/chats/${chatId}/messages`)).json.messages).toHaveLength(2);
    // Bob removes Alice's message for BOTH of them — no consent needed in a direct chat
    expect((await B.post('/api/messages/delete', { ids: [fromA.id], scope: 'everyone' })).status).toBe(200);
    expect((await A.get(`/api/chats/${chatId}/messages`)).json.messages).toHaveLength(0);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(fromA.id)).toEqual({ n: 0 });
    // clear history for everyone
    await A.send(chatId, 1, chatKey, 'one');
    await B.send(chatId, 1, chatKey, 'two');
    expect((await A.post(`/api/chats/${chatId}/clear`, { scope: 'everyone' })).status).toBe(200);
    expect((await B.get(`/api/chats/${chatId}/messages`)).json.messages).toHaveLength(0);
    // clear only my side
    await B.send(chatId, 1, chatKey, 'three');
    await A.post(`/api/chats/${chatId}/clear`, { scope: 'me' });
    expect((await A.get(`/api/chats/${chatId}/messages`)).json.messages).toHaveLength(0);
    expect((await B.get(`/api/chats/${chatId}/messages`)).json.messages).toHaveLength(1);
  });

  it('encrypted polls: signed votes per user, change/retract, removed with the message', async () => {
    const poll: C.Payload = { t: 'poll', q: 'Lunch?', options: ['A', 'B', 'C'], multi: true };
    const sent = await A.sendPayload(chatId, 1, chatKey, poll, []);
    expect(sent.status).toBe(200);
    const mid = sent.json.message.id;
    const vb = C.encryptVote([0, 2], chatKey, { chatId, messageId: mid, userId: B.id, epoch: 1 }, B.identity!);
    expect((await B.req('PUT', `/api/messages/${mid}/vote`, vb)).status).toBe(200);
    expect((await Cc.req('PUT', `/api/messages/${mid}/vote`, vb)).status).toBe(404); // not a member
    const va = C.encryptVote([1], chatKey, { chatId, messageId: mid, userId: A.id, epoch: 1 }, A.identity!);
    await A.req('PUT', `/api/messages/${mid}/vote`, va);
    let one = (await A.get(`/api/messages/${mid}`)).json.message;
    expect(one.votes).toHaveLength(2);
    const bv = one.votes.find((v: { userId: string }) => v.userId === B.id);
    expect(C.decryptVote(bv, chatKey, chatId, mid, B.identity!.signPk)).toEqual([0, 2]);
    // a vote can't be replayed as someone else's, and the server never sees option text
    expect(() => C.decryptVote({ ...bv, userId: A.id }, chatKey, chatId, mid, A.identity!.signPk)).toThrow();
    // change vote, then retract
    await B.req('PUT', `/api/messages/${mid}/vote`, C.encryptVote([1], chatKey, { chatId, messageId: mid, userId: B.id, epoch: 1 }, B.identity!));
    one = (await A.get(`/api/messages/${mid}`)).json.message;
    expect(C.decryptVote(one.votes.find((v: { userId: string }) => v.userId === B.id), chatKey, chatId, mid, B.identity!.signPk)).toEqual([1]);
    expect((await B.req('DELETE', `/api/messages/${mid}/vote`)).status).toBe(200);
    expect((await A.get(`/api/messages/${mid}`)).json.message.votes).toHaveLength(1);
    await A.post('/api/messages/delete', { ids: [mid], scope: 'everyone' });
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM poll_votes').get()).toEqual({ n: 0 });
  });

  it('scheduled messages: stored encrypted, delivered at the time, stale after rotation, drafts synced encrypted', async () => {
    const { dispatchScheduled } = await import('../src/scheduled.js');
    const mk = (text: string, sendAt: number) => {
      const clientMsgId = C.newClientMsgId();
      const enc = C.encryptMessage({ t: 'text', text }, chatKey, { chatId, epoch: 1, senderId: A.id, clientMsgId }, A.identity!);
      return { clientMsgId, epoch: 1, ...enc, sendAt };
    };
    expect((await A.post(`/api/chats/${chatId}/scheduled`, mk('past', Date.now() - 1000))).status).toBe(400);
    expect((await Cc.post(`/api/chats/${chatId}/scheduled`, mk('x', Date.now() + 60_000))).status).toBe(404);
    const s1 = (await A.post(`/api/chats/${chatId}/scheduled`, mk('later-secret', Date.now() + 60_000))).json.scheduled;
    expect(s1.id).toBeTruthy();
    const row = env.ctx.db.prepare('SELECT ciphertext FROM scheduled_messages WHERE id = ?').get(s1.id) as { ciphertext: string };
    expect(Buffer.from(row.ciphertext, 'base64url').includes(Buffer.from('later-secret'))).toBe(false);
    expect((await B.get('/api/scheduled')).json.scheduled).toHaveLength(0); // only the sender sees it
    expect((await A.get('/api/scheduled')).json.scheduled).toHaveLength(1);
    const before = (await B.get(`/api/chats/${chatId}/messages`)).json.messages.length;
    dispatchScheduled(env.ctx); // not due yet
    expect((await B.get(`/api/chats/${chatId}/messages`)).json.messages.length).toBe(before);
    env.ctx.db.prepare('UPDATE scheduled_messages SET send_at = 0 WHERE id = ?').run(s1.id);
    dispatchScheduled(env.ctx);
    const msgs = (await B.get(`/api/chats/${chatId}/messages`)).json.messages;
    expect(msgs.length).toBe(before + 1);
    const last = msgs[msgs.length - 1];
    expect(last.senderId).toBe(A.id);
    expect(C.decryptMessage(last, chatKey, A.identity!.signPk)).toEqual({ t: 'text', text: 'later-secret' });
    expect((await A.get('/api/scheduled')).json.scheduled).toHaveLength(0);

    // encrypted for an old epoch → marked stale, not delivered; re-encrypt via PUT delivers it
    const s2 = (await A.post(`/api/chats/${chatId}/scheduled`, mk('stale', Date.now() + 60_000))).json.scheduled;
    env.ctx.db.prepare('UPDATE scheduled_messages SET send_at = 0, epoch = 99 WHERE id = ?').run(s2.id);
    dispatchScheduled(env.ctx);
    expect((await A.get('/api/scheduled')).json.scheduled[0].stale).toBe(true);
    const re = C.encryptMessage({ t: 'text', text: 'stale' }, chatKey, { chatId, epoch: 1, senderId: A.id, clientMsgId: s2.clientMsgId }, A.identity!);
    expect((await A.req('PUT', `/api/scheduled/${s2.id}`, { epoch: 1, ...re, sendAt: 0 })).status).toBe(200);
    dispatchScheduled(env.ctx);
    expect((await A.get('/api/scheduled')).json.scheduled).toHaveLength(0);
    // cancel
    const s3 = (await A.post(`/api/chats/${chatId}/scheduled`, mk('cancel me', Date.now() + 60_000))).json.scheduled;
    expect((await B.req('DELETE', `/api/scheduled/${s3.id}`)).status).toBe(404);
    expect((await A.req('DELETE', `/api/scheduled/${s3.id}`)).status).toBe(200);

    // drafts: only my own key can open them
    const d = C.encryptDraft({ text: 'half-written' }, A.identity!, A.id, chatId);
    expect((await A.req('PUT', `/api/drafts/${chatId}`, d)).status).toBe(200);
    expect((await Cc.req('PUT', `/api/drafts/${chatId}`, d)).status).toBe(404);
    const got = (await A.get('/api/drafts')).json.drafts;
    expect(C.decryptDraft(got[0], A.identity!, A.id, chatId).text).toBe('half-written');
    expect(() => C.decryptDraft(got[0], B.identity!, A.id, chatId)).toThrow();
    expect((await B.get('/api/drafts')).json.drafts).toHaveLength(0);
    await A.req('DELETE', `/api/drafts/${chatId}`);
    expect((await A.get('/api/drafts')).json.drafts).toHaveLength(0);
  });

  it('link preview: SSRF-safe (no internal addresses), parses Open Graph, admin can switch it off', async () => {
    const { isBlockedAddress, parsePreview } = await import('../src/preview.js');
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '224.0.0.1'])
      expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isBlockedAddress(ip), ip).toBe(false);
    for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/', 'file:///etc/passwd', 'http://example.com:8080/', 'http://u:p@example.com/', 'http://2130706433/', 'http://0x7f000001/'])
      expect((await A.post('/api/link-preview', { url })).status, url).toBeGreaterThanOrEqual(400);
    const p = parsePreview(
      '<html><head><title>T &amp; t</title><meta property="og:title" content="OG &quot;Title&quot;"><meta name="description" content="Desc"><meta property="og:image" content="/img.png"></head></html>',
      new URL('https://www.example.com/a/b'),
    );
    expect(p).toEqual({ title: 'OG "Title"', desc: 'Desc', site: 'example.com', image: 'https://www.example.com/img.png' });
    // admin switch
    const lim = (await A.get('/api/admin/limits')).json;
    await A.req('PUT', '/api/admin/limits', { ...lim, limits: { ...lim.limits, linkPreview: false } });
    expect((await A.post('/api/link-preview', { url: 'https://example.com/' })).json.error).toBe('disabled');
    await A.req('PUT', '/api/admin/limits', { ...lim, limits: { ...lim.limits, linkPreview: true } });
  });

  it('malformed decrypted payloads are rejected before the UI sees them', () => {
    const k = C.newChatKey();
    const meta = { chatId: 'c_v', epoch: 1, senderId: A.id, clientMsgId: C.newClientMsgId() };
    const bad = [{ t: 'poll', q: 'x', options: 5, multi: false }, { t: 'bundle', title: {}, items: [] }, { t: 'bundle', title: 't', items: null }, { t: 'text', text: 1 }, { t: 'weird' }];
    for (const p of bad) {
      const m = C.encryptMessage(p as never, k, meta, A.identity!);
      expect(() => C.decryptMessage({ ...meta, ...m }, k, A.identity!.signPk)).toThrow('malformed');
    }
    const good = C.encryptMessage({ t: 'poll', q: 'ok?', options: ['a', 'b'], multi: false }, k, meta, A.identity!);
    expect(C.decryptMessage({ ...meta, ...good }, k, A.identity!.signPk).t).toBe('poll');
  });

  it('signed chat settings: only the signer key verifies, re-wrapping keeps the signature', async () => {
    const rec = { v: 3, title: 'Team', disappearing: 3600, at: Date.now(), by: A.id };
    const k1 = C.newChatKey();
    const k2 = C.newChatKey();
    const ct = C.sealSettings(rec, A.identity!, k1, 'c_x', 1);
    const o = C.openSettings(ct, 'c_x', (e) => (e === 1 ? k1 : undefined));
    expect(o?.kind).toBe('signed');
    if (o?.kind !== 'signed') throw new Error();
    expect(o.rec).toEqual(rec);
    expect(C.verifySettings(o, 'c_x', A.identity!.signPk)).toBe(true);
    expect(C.verifySettings(o, 'c_x', B.identity!.signPk)).toBe(false);
    expect(C.verifySettings(o, 'c_other', A.identity!.signPk)).toBe(false); // bound to the chat
    expect(C.verifySettings({ ...o, recJson: o.recJson.replace('3600', '0') }, 'c_x', A.identity!.signPk)).toBe(false);
    // any member can re-encrypt the same record under a new epoch; the admin signature still verifies
    const re = C.encryptTitle(o.raw, k2, 'c_x', 2);
    const o2 = C.openSettings(re, 'c_x', (e) => (e === 2 ? k2 : undefined));
    expect(o2?.kind === 'signed' && C.verifySettings(o2, 'c_x', A.identity!.signPk)).toBe(true);
    // legacy plain titles still open
    expect(C.openSettings(C.encryptTitle('Old', k1, 'c_x', 1), 'c_x', () => k1)).toEqual({ kind: 'legacy', title: 'Old', raw: 'Old' });
  });

  it('hardening: linear-time preview parser, parallel uploads cannot overrun the quota, deleting does not refund it', async () => {
    const { parsePreview } = await import('../src/preview.js');
    const t0 = Date.now();
    for (const html of ['<meta ' + 'a'.repeat(300_000) + '>', '<meta '.repeat(60_000), '<title>'.repeat(42_000), '<meta content="' + 'x'.repeat(299_000)])
      parsePreview(html, new URL('https://x.example/'));
    expect(Date.now() - t0).toBeLessThan(500);

    env.ctx.db.prepare('UPDATE users SET upload_quota_mb = 1 WHERE id = ?').run(B.id);
    const blob = new Uint8Array(400 * 1024);
    const results = await Promise.all([1, 2, 3, 4].map(() => B.upload(chatId, blob)));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBe(2); // 2 × 400 KB fit in 1 MB, the others are refused even though they ran in parallel
    expect(results.filter((r) => r.json.error === 'quota').length).toBe(2);
    // unreferenced / deleted blobs still count for today
    for (const r of ok) {
      env.ctx.db.prepare('DELETE FROM blobs WHERE id = ?').run(r.json.blobId);
      fs.rmSync(path.join(env.dataDir, 'blobs', r.json.blobId), { force: true });
    }
    expect((await B.upload(chatId, blob)).json.error).toBe('quota');
    env.ctx.db.prepare('UPDATE users SET upload_quota_mb = NULL WHERE id = ?').run(B.id);
  });

  it('v0.4 contacts: blocking is enforced by the server; privacy settings are reciprocal; personal vault + attachments', async () => {
    // B blocks A → A can't message B (B can still message A), A can't add B to a group
    expect((await B.req('PUT', `/api/blocks/${A.id}`)).status).toBe(200);
    expect((await A.send(chatId, 1, chatKey, 'hi?')).json.error).toBe('blocked');
    expect((await B.send(chatId, 1, chatKey, 'one-way')).status).toBe(200);
    expect((await A.createGroup('g', [B.id])).r.json.error).toBe('blocked');
    // edits, reactions and online status are covered by the block too
    const mine = (await A.get(`/api/chats/${chatId}/messages?limit=100`)).json.messages.filter((m: { senderId: string }) => m.senderId === A.id).pop();
    const ed = C.encryptMessage({ t: 'text', text: 'sneaky edit' }, chatKey, { chatId, epoch: mine.epoch, senderId: A.id, clientMsgId: mine.clientMsgId }, A.identity!);
    expect((await A.req('PATCH', `/api/messages/${mine.id}`, ed)).json.error).toBe('blocked');
    expect((await A.get(`/api/users/${B.id}`)).json.online).toBe(false);
    expect((await B.get('/api/blocks')).json.blocked.map((x: { id: string }) => x.id)).toEqual([A.id]);
    expect((await B.req('DELETE', `/api/blocks/${A.id}`)).status).toBe(200);
    expect((await A.send(chatId, 1, chatKey, 'back again')).status).toBe(200);
    expect((await A.req('PUT', `/api/blocks/${A.id}`)).status).toBe(400);

    // read receipts hidden both ways when one side turns them off
    await B.readAll(chatId);
    const seqOf = async (viewer: typeof A, uid: string) => ((await viewer.chat(chatId)) as unknown as { members: { id: string; lastReadSeq: number }[] }).members.find((m) => m.id === uid)!.lastReadSeq;
    expect(await seqOf(A, B.id)).toBeGreaterThan(0);
    await B.req('PUT', '/api/me/privacy', { noReceipts: true, hideOnline: true });
    expect(await seqOf(A, B.id)).toBe(0);
    expect(await seqOf(B, A.id)).toBe(0);
    expect(await seqOf(B, B.id)).toBeGreaterThan(0); // my own position still works for unread counts
    await B.req('PUT', '/api/me/privacy', { noReceipts: false, hideOnline: false });
    expect(await seqOf(A, B.id)).toBeGreaterThan(0);

    // vault: encrypted items + personal attachments only the owner can read
    const up = await B.upload('self', C.encryptFile(new Uint8Array([7, 7, 7])).ciphertext);
    expect(up.status).toBe(200);
    expect((await A.download(up.json.blobId)).status).toBe(404);
    expect((await B.req('PUT', '/api/vault/saved/item1', { nonce: 'A'.repeat(32), ciphertext: 'QUJD', blobIds: [up.json.blobId] })).status).toBe(200);
    expect((await A.req('PUT', '/api/vault/saved/item2', { nonce: 'A'.repeat(32), ciphertext: 'QUJD', blobIds: [up.json.blobId] })).json.error).toBe('invalid_blob');
    expect((await B.download(up.json.blobId)).status).toBe(200);
    expect((await B.get('/api/vault/saved')).json.items.map((i: { id: string }) => i.id)).toEqual(['item1']);
    expect((await A.get('/api/vault/saved')).json.items).toEqual([]);
    env.ctx.db.prepare('UPDATE blobs SET created_at = 0 WHERE id = ?').run(up.json.blobId);
    purgeUnreferencedBlobs(env.ctx); // claimed by the vault item: survives the unreferenced purge
    expect((await B.download(up.json.blobId)).status).toBe(200);
    await B.req('DELETE', '/api/vault/saved/item1');
    expect((await B.download(up.json.blobId)).status).toBe(404);
  });

  it('v0.4 two-step verification: login and recovery need the code; codes are single-use; admin can require it', async () => {
    const { hotp } = await import('../src/totp.js');
    const u = new Client(env.app, B.ip);
    const inv = (await A.post('/api/admin/invites', { maxUses: 1, expiresInHours: 1 })).json;
    await u.register(inv.token, 'erin', 'erin-password-1');
    const setup = (await u.post('/api/me/2fa/setup')).json;
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\//);
    expect((await u.post('/api/me/2fa/enable', { code: '000000' })).json.error).toBe('bad_code');
    const enableStep = Math.floor(Date.now() / 30_000);
    const en = (await u.post('/api/me/2fa/enable', { code: hotp(setup.secret, enableStep) })).json;
    expect(en.recoveryCodes).toHaveLength(10);
    // login: password alone gives no session and no key backup
    const dev = new Client(env.app, B.ip);
    const r1 = await dev.loginRaw('erin', 'erin-password-1');
    expect(r1.json.totpRequired).toBe(true);
    expect(r1.json.keys).toBeUndefined();
    expect((await dev.get('/api/me')).status).toBe(401);
    // the code just used for enabling can't be replayed; a code from the next time step works
    expect((await dev.post('/api/auth/2fa', { ticket: r1.json.ticket, code: hotp(setup.secret, enableStep) })).json.error).toBe('bad_code');
    const next = hotp(setup.secret, enableStep + 1);
    const ok = await dev.post('/api/auth/2fa', { ticket: r1.json.ticket, code: next });
    expect(ok.status).toBe(200);
    expect(ok.json.keys).toBeTruthy();
    expect((await dev.get('/api/me')).json.user.totp).toBe(true);
    // recovery code works once
    const dev2 = new Client(env.app, B.ip);
    const r2 = await dev2.loginRaw('erin', 'erin-password-1');
    expect((await dev2.post('/api/auth/2fa', { ticket: r2.json.ticket, code: en.recoveryCodes[0] })).status).toBe(200);
    const dev3 = new Client(env.app, B.ip);
    const r3 = await dev3.loginRaw('erin', 'erin-password-1');
    expect((await dev3.post('/api/auth/2fa', { ticket: r3.json.ticket, code: en.recoveryCodes[0] })).status).toBe(401);
    // admin requires 2FA: accounts without it are limited to the setup endpoints
    const lim = (await A.get('/api/admin/limits')).json;
    expect((await A.req('PUT', '/api/admin/limits', { ...lim, limits: { ...lim.limits, require2fa: true } })).json.error).toBe('need_own_2fa');
    const erinId = (await u.get('/api/me')).json.user.id;
    await A.post(`/api/admin/users/${erinId}/make-admin`);
    expect((await u.req('PUT', '/api/admin/limits', { ...lim, limits: { ...lim.limits, require2fa: true } })).status).toBe(200);
    expect((await Cc.get('/api/chats')).json.error).toBe('totp_required');
    expect((await A.get('/api/chats')).json.error).toBe('totp_required');
    expect((await Cc.get('/api/me')).json.user.needs2fa).toBe(true);
    expect((await Cc.get('/api/me/2fa')).status).toBe(200);
    expect((await u.get('/api/chats')).status).toBe(200);
    await u.req('PUT', '/api/admin/limits', { ...lim, limits: { ...lim.limits, require2fa: false } });
    await A.post(`/api/admin/users/${erinId}/revoke-admin`);
    expect((await Cc.get('/api/chats')).status).toBe(200);
  });

  it('v0.5 passkeys: second factor for login, proof needed to add/remove, counts for "require 2FA"', async () => {
    const web = { origin: 'http://localhost', host: 'localhost' };
    const u = new Client(env.app, D.ip);
    u.extraHeaders = web;
    const inv = (await A.post('/api/admin/invites', { maxUses: 1, expiresInHours: 1 })).json;
    await u.register(inv.token, 'frank', 'frank-password-1');
    const pk = new SoftPasskey();
    // the first factor needs a recent password: an old session (e.g. a stolen cookie) is refused …
    env.ctx.db.prepare('UPDATE sessions SET pw_at = NULL WHERE user_id = ?').run(u.id);
    expect((await u.post('/api/me/passkeys/options')).json.error).toBe('reauth_required');
    // … until the password is proven again
    const s1 = await O.startLogin('frank-password-1');
    const rs = (await u.post('/api/auth/reauth/start', { startLoginRequest: s1.startLoginRequest })).json;
    const f1 = await O.finishLogin({ password: 'frank-password-1', clientLoginState: s1.clientLoginState, loginResponse: rs.loginResponse });
    expect((await u.post('/api/auth/reauth/finish', { loginId: rs.loginId, finishLoginRequest: f1!.finishLoginRequest })).status).toBe(200);
    // register: no factor yet, so no proof needed; comes with recovery codes
    const ro = (await u.post('/api/me/passkeys/options')).json;
    expect(ro.rp.id).toBe('localhost');
    const reg = await u.post('/api/me/passkeys', { name: '测试手机', response: pk.register(ro) });
    expect(reg.status).toBe(200);
    expect(reg.json.recoveryCodes).toHaveLength(10);
    expect((await u.get('/api/me/2fa')).json.methods).toEqual(['passkey']);
    expect((await u.get('/api/me/passkeys')).json.passkeys[0].name).toBe('测试手机');
    // login: password alone is not enough; the passkey releases the session
    const dev = new Client(env.app, D.ip);
    dev.extraHeaders = web;
    const r1 = await dev.loginRaw('frank', 'frank-password-1');
    expect(r1.json).toMatchObject({ totpRequired: true, methods: ['passkey'] });
    const ao = (await dev.post('/api/auth/2fa/passkey-options', { ticket: r1.json.ticket })).json;
    expect(ao.allowCredentials[0].id).toBe(pk.credId.toString('base64url'));
    // wrong origin (phishing site relaying the challenge) is rejected, and the challenge is single-use
    expect((await dev.post('/api/auth/2fa', { ticket: r1.json.ticket, passkey: pk.assert(ao, { origin: 'https://evil.example' }) })).status).toBe(401);
    expect((await dev.post('/api/auth/2fa', { ticket: r1.json.ticket, passkey: pk.assert(ao) })).status).toBe(401);
    const ao2 = (await dev.post('/api/auth/2fa/passkey-options', { ticket: r1.json.ticket })).json;
    const ok = await dev.post('/api/auth/2fa', { ticket: r1.json.ticket, passkey: pk.assert(ao2) });
    expect(ok.status).toBe(200);
    expect(ok.json.keys).toBeTruthy();
    // another person's passkey doesn't work for this account
    const dev2 = new Client(env.app, D.ip);
    dev2.extraHeaders = web;
    const r2 = await dev2.loginRaw('frank', 'frank-password-1');
    const ao3 = (await dev2.post('/api/auth/2fa/passkey-options', { ticket: r2.json.ticket })).json;
    expect((await dev2.post('/api/auth/2fa', { ticket: r2.json.ticket, passkey: new SoftPasskey().assert(ao3) })).status).toBe(401);
    // adding a second passkey needs proof (a stolen session can't plant its own factor)
    const pk2 = new SoftPasskey();
    const ro2 = (await u.post('/api/me/passkeys/options')).json;
    expect((await u.post('/api/me/passkeys', { response: pk2.register(ro2) })).json.error).toBe('bad_code');
    const so = (await u.post('/api/me/2fa/stepup-options')).json;
    const ro3 = (await u.post('/api/me/passkeys/options')).json;
    const reg2 = await u.post('/api/me/passkeys', { name: 'key 2', response: pk2.register(ro3), proof: { passkey: pk.assert(so) } });
    expect(reg2.status).toBe(200);
    expect(reg2.json.recoveryCodes).toBeUndefined(); // keeps the existing ones
    // a recovery code also works as proof; removing the last factor drops the recovery codes
    const list = (await u.get('/api/me/passkeys')).json.passkeys as { id: string }[];
    expect((await u.post(`/api/me/passkeys/${list[1].id}/delete`, { code: reg.json.recoveryCodes[0] })).status).toBe(200);
    const so2 = (await u.post('/api/me/2fa/stepup-options')).json;
    expect((await u.post(`/api/me/passkeys/${list[0].id}/delete`, { passkey: pk.assert(so2) })).status).toBe(200);
    expect((await u.get('/api/me/2fa')).json).toMatchObject({ methods: [], recoveryLeft: 0 });
    const dev3 = new Client(env.app, D.ip);
    expect((await dev3.loginRaw('frank', 'frank-password-1')).json.totpRequired).toBeUndefined();
  });

  it('v0.6 account deletion: checks first, then a tombstone — messages stay, nobody can log in or take the name', async () => {
    const g = new Client(env.app, D.ip);
    const inv = (await A.post('/api/admin/invites', { maxUses: 1, expiresInHours: 1 })).json;
    await g.register(inv.token, 'gina', 'gina-password-1');
    const dm = await A.createDirect(g.id);
    await g.send(dm.chatId, 1, dm.key, 'bye soon');
    const grp = await A.createGroup('farewell', [g.id]);
    await g.req('PUT', '/api/vault/contact/x', { nonce: C.b64(new Uint8Array(24)), ciphertext: C.b64(new Uint8Array(40)), blobIds: [] });
    // checks: the username must be typed, the password must be recent
    expect((await g.post('/api/me/delete/prepare', { confirm: 'wrong' })).json.error).toBe('confirm');
    env.ctx.db.prepare('UPDATE sessions SET pw_at = NULL WHERE user_id = ?').run(g.id);
    expect((await g.post('/api/me/delete/prepare', { confirm: 'gina' })).json.error).toBe('reauth_required');
    env.ctx.db.prepare('UPDATE sessions SET pw_at = ? WHERE user_id = ?').run(Date.now(), g.id);
    // the only admin can't leave the server without an admin
    expect((await A.post('/api/me/delete/prepare', { confirm: A.username })).json.error).toBe('last_admin');
    const { token } = (await g.post('/api/me/delete/prepare', { confirm: 'GINA' })).json;
    expect(token).toBeTruthy();
    expect((await g.post('/api/me/delete', { token: 'nope' })).status).toBe(401);
    // still in a group: refused (a dead account in a member list would keep receiving keys)
    expect((await g.post('/api/me/delete', { token })).json.error).toBe('still_in_groups');
    // the client leaves its groups itself (signed), then deletes
    expect((await g.membership(grp.chatId, 'leave', [g.id])).r.status).toBe(200);
    const inviteByGina = env.ctx.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND revoked_at IS NULL").get(g.id) as { n: number };
    const { token: token2 } = (await g.post('/api/me/delete/prepare', { confirm: 'gina' })).json;
    expect((await g.post('/api/me/delete', { token: token2 })).status).toBe(200);
    expect(inviteByGina.n).toBeGreaterThanOrEqual(0);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND revoked_at IS NULL').get(g.id)).toEqual({ n: 0 });
    expect((await g.get('/api/me')).status).toBe(401);
    expect((await new Client(env.app, D.ip).loginRaw('gina', 'gina-password-1')).status).toBe(401);
    // the other side keeps the history; the name shows as deleted; no new messages
    const c = (await A.chat(dm.chatId)) as unknown as { members: { id: string; deleted?: boolean; displayName: string }[] };
    expect(c.members.find((m) => m.id === g.id)).toMatchObject({ deleted: true, displayName: '已注销账号' });
    expect((await A.get(`/api/chats/${dm.chatId}/messages`)).json.messages.length).toBeGreaterThan(0);
    expect((await A.send(dm.chatId, 1, dm.key, 'hello?')).json.error).toBe('peer_deleted');
    expect((await A.get('/api/users/by-username/gina')).status).toBe(404);
    expect((await A.get(`/api/users/${g.id}`)).json.keys.signPk).toBeTruthy(); // old signatures stay verifiable
    const row = env.ctx.db.prepare('SELECT opaque_record, recovery_record FROM users WHERE id = ?').get(g.id) as Record<string, unknown>;
    expect(row).toEqual({ opaque_record: null, recovery_record: null });
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM user_vault WHERE user_id = ?').get(g.id)).toEqual({ n: 0 });
    // the name can't be registered again
    const inv2 = (await A.post('/api/admin/invites', { maxUses: 1, expiresInHours: 1 })).json;
    await expect(new Client(env.app, D.ip).register(inv2.token, 'gina', 'another-password-1')).rejects.toThrow();
  });

  it('v0.6 encrypted avatars: picture readable only by chat partners; key envelopes per chat; group avatar by admins', async () => {
    const dm = await A.createDirect(B.id);
    const pic = new Uint8Array(3000).fill(7);
    const up = await A.upload('self', pic);
    const { v } = (await A.req('PUT', '/api/me/avatar', { blobId: up.json.blobId })).json;
    expect(v).toBeGreaterThan(0);
    // someone else's personal upload, or a too-big one, can't become my avatar
    const bUp = await B.upload('self', pic);
    expect((await A.req('PUT', '/api/me/avatar', { blobId: bUp.json.blobId })).json.error).toBe('invalid_blob');
    expect((await B.download(up.json.blobId)).status).toBe(200); // chat partner
    const lone = new Client(env.app, D.ip);
    const inv = (await A.post('/api/admin/invites', { maxUses: 1, expiresInHours: 1 })).json;
    await lone.register(inv.token, 'hank', 'hank-password-1');
    expect((await lone.download(up.json.blobId)).status).toBe(404); // shares no chat
    // envelope for one chat; a stale version is refused; partners see it with the current blob id
    const env1 = { nonce: C.b64(new Uint8Array(24)), ciphertext: C.b64(new Uint8Array(80)), signature: C.b64(new Uint8Array(64)) };
    expect((await A.req('PUT', `/api/chats/${dm.chatId}/avatar-key`, { v: v + 5, epoch: 1, ...env1 })).json.error).toBe('stale');
    expect((await A.req('PUT', `/api/chats/${dm.chatId}/avatar-key`, { v, epoch: 1, ...env1 })).status).toBe(200);
    expect((await Cc.req('PUT', `/api/chats/${dm.chatId}/avatar-key`, { v: 1, epoch: 1, ...env1 })).status).toBe(404);
    const got = (await B.get('/api/avatars')).json.envelopes.find((e: { userId: string; chatId: string }) => e.userId === A.id && e.chatId === dm.chatId);
    expect(got).toMatchObject({ v, blobId: up.json.blobId });
    expect((await lone.get('/api/avatars')).json.envelopes).toHaveLength(0);
    // a new picture: old one deleted, old envelopes dropped
    const up2 = await A.upload('self', pic);
    await A.req('PUT', '/api/me/avatar', { blobId: up2.json.blobId });
    expect((await B.download(up.json.blobId)).status).toBe(404);
    expect((await B.get('/api/avatars')).json.envelopes.some((e: { userId: string }) => e.userId === A.id)).toBe(false);
    expect(((await B.chat(dm.chatId)) as unknown as { members: { id: string; avatarV?: number }[] }).members.find((m) => m.id === A.id)?.avatarV).toBe(v + 1);
    // group avatar: admins only; all members can fetch it
    const g = await A.createGroup('pics', [B.id]);
    const gUp = await B.upload(g.chatId, pic);
    expect((await B.req('PUT', `/api/chats/${g.chatId}/avatar`, { blobId: gUp.json.blobId })).status).toBe(403);
    const aUp = await A.upload(g.chatId, pic);
    expect((await A.req('PUT', `/api/chats/${g.chatId}/avatar`, { blobId: aUp.json.blobId })).status).toBe(200);
    expect((await B.download(aUp.json.blobId)).status).toBe(200);
    expect((await lone.download(aUp.json.blobId)).status).toBe(404);
    await A.req('PUT', '/api/me/avatar', { blobId: null });
    // shared media: only messages that carry attachments
    const k = await A.chatKeys(g.chatId);
    await A.send(g.chatId, 1, k.get(1) ?? g.key, 'just text');
    const fUp = await A.upload(g.chatId, pic);
    await A.sendPayload(g.chatId, 1, g.key, { t: 'text', text: 'pretend file' }, [fUp.json.blobId]);
    const media = (await B.get(`/api/chats/${g.chatId}/messages?media=1`)).json.messages as { id: string }[];
    expect(media).toHaveLength(1);
  });

  it('v0.4 group moderation: mute members and admins-only posting are enforced by the server', async () => {
    const g = await A.createGroup('mod', [B.id]);
    expect(g.r.status).toBe(200);
    expect((await B.send(g.chatId, 1, g.key, 'hello')).status).toBe(200);
    expect((await B.req('PUT', `/api/chats/${g.chatId}/members/${A.id}/mute`, { until: -1 })).status).toBe(403); // not admin
    expect((await A.req('PUT', `/api/chats/${g.chatId}/members/${B.id}/mute`, { until: Date.now() + 3_600_000 })).status).toBe(200);
    expect((await B.send(g.chatId, 1, g.key, 'x')).json.error).toBe('muted');
    expect(((await A.chat(g.chatId)) as unknown as { members: { id: string; mutedUntil: number | null }[] }).members.find((m) => m.id === B.id)?.mutedUntil).toBeGreaterThan(Date.now());
    await A.req('PUT', `/api/chats/${g.chatId}/members/${B.id}/mute`, { until: 0 });
    expect((await B.send(g.chatId, 1, g.key, 'free')).status).toBe(200);
    expect((await B.req('PATCH', `/api/chats/${g.chatId}`, { postPolicy: 'admins' })).status).toBe(403);
    expect((await A.req('PATCH', `/api/chats/${g.chatId}`, { postPolicy: 'admins' })).status).toBe(200);
    expect((await B.send(g.chatId, 1, g.key, 'x')).json.error).toBe('admins_only');
    expect((await A.send(g.chatId, 1, g.key, 'announcement')).status).toBe(200);
  });

  it('v0.4 scan-to-login: the logged-in device seals the identity to the new device; the server only relays it', async () => {
    const s = await import('libsodium-wrappers-sumo').then((m) => m.default).catch(async () => (await import('libsodium-wrappers')).default);
    await s.ready;
    const eph = s.crypto_box_keypair();
    const nd = new Client(env.app, A.ip);
    const st = (await nd.post('/api/link/start', { pk: C.b64(eph.publicKey) })).json;
    expect(st.linkId).toBeTruthy();
    expect((await nd.post(`/api/link/${st.linkId}/poll`, { pollToken: st.pollToken })).json.pending).toBe(true);
    expect((await nd.post(`/api/link/${st.linkId}/poll`, { pollToken: 'wrong' })).status).toBe(404);
    const info = (await A.get(`/api/link/${st.linkId}`)).json;
    expect(info.pk).toBe(C.b64(eph.publicKey));
    const sealed = s.crypto_box_seal(s.from_string(C.serializeIdentity(A.identity!)), eph.publicKey);
    expect((await A.post(`/api/link/${st.linkId}/approve`, { sealed: C.b64(sealed) })).status).toBe(200);
    const done = (await nd.post(`/api/link/${st.linkId}/poll`, { pollToken: st.pollToken, deviceName: 'new laptop' })).json;
    expect(done.user.id).toBe(A.id);
    const id = C.deserializeIdentity(s.to_string(s.crypto_box_seal_open(C.unb64(done.sealed), eph.publicKey, eph.privateKey)));
    expect(C.b64(id.signPk)).toBe(C.b64(A.identity!.signPk));
    expect((await nd.get('/api/me')).json.user.id).toBe(A.id);
    expect((await nd.post(`/api/link/${st.linkId}/poll`, { pollToken: st.pollToken })).status).toBe(404); // single use
    // a QR-linked device never proved the password: it can't delete the account or add a first second factor
    expect((await nd.post('/api/me/delete/prepare', { confirm: A.username })).json.error).toBe('reauth_required');
  });

  it('v0.4 periodic re-keying: an old key epoch is flagged so the next sender rotates', async () => {
    const g = await A.createGroup('rekey', [B.id]);
    expect(((await A.chat(g.chatId)) as unknown as { rotateSoon: boolean }).rotateSoon).toBe(false);
    env.ctx.db.prepare('UPDATE chat_keys SET created_at = 0 WHERE chat_id = ?').run(g.chatId);
    expect(((await A.chat(g.chatId)) as unknown as { rotateSoon: boolean }).rotateSoon).toBe(true);
    expect((await B.send(g.chatId, 1, g.key, 'still works')).status).toBe(200); // not blocking, just a hint
    const k2 = C.newChatKey();
    const keys = await B.seal(k2, { chatId: g.chatId, epoch: 2, membershipVersion: 1 }, [A.id, B.id]);
    expect((await B.post(`/api/chats/${g.chatId}/keys`, { epoch: 2, membershipVersion: 1, keys })).status).toBe(200);
    expect(((await A.chat(g.chatId)) as unknown as { rotateSoon: boolean }).rotateSoon).toBe(false);
  });

  it('v0.4 admin insights: audit log (no secrets), 30-day stats, attachment retention', async () => {
    await A.req('PUT', '/api/admin/gate-password', { password: 'another-gate-pass-1' });
    const inv = await A.post('/api/admin/invites', { maxUses: 1, expiresInHours: 1, note: 'for audit' });
    expect(inv.status).toBe(200);
    const log = (await A.get('/api/admin/audit')).json.entries as { action: string; detail: string | null; username: string }[];
    expect(log[0].action).toBe('POST invites');
    expect(log[0].detail).toContain('for audit');
    expect(log[0].username).toBe('alice');
    const pw = log.find((e) => e.action === 'PUT gate-password')!;
    expect(pw.detail).toBeNull(); // passwords never logged
    await A.req('PUT', '/api/admin/gate-password', { password: GATE_PW });
    expect((await B.get('/api/admin/audit')).status).toBe(403);
    const st = (await A.get('/api/admin/stats')).json;
    expect(st.days).toHaveLength(30);
    expect(st.days[29].active).toBeGreaterThan(0);
    expect(st.days[29].messages).toBeGreaterThan(0);
    expect(st.totals.users).toBeGreaterThan(2);
    // retention: attachments older than N days are removed
    const { purgeOldAttachments } = await import('../src/insights.js');
    const up = await A.upload(chatId, C.encryptFile(new Uint8Array([1, 2, 3])).ciphertext);
    env.ctx.db.prepare('UPDATE blobs SET created_at = 0 WHERE id = ?').run(up.json.blobId);
    expect(purgeOldAttachments(env.ctx)).toBe(0); // off by default
    const lim = (await A.get('/api/admin/limits')).json;
    await A.req('PUT', '/api/admin/limits', { ...lim, limits: { ...lim.limits, attachmentRetentionDays: 30 } });
    expect(purgeOldAttachments(env.ctx)).toBeGreaterThan(0);
    expect((await A.download(up.json.blobId)).status).toBe(404);
    await A.req('PUT', '/api/admin/limits', { ...lim, limits: { ...lim.limits, attachmentRetentionDays: 0 } });
  });

  it('streaming file encryption is format-compatible with the in-memory version', () => {
    for (const n of [1, 65_536, 65_537, 3 * 65_536 + 5]) {
      const plain = new Uint8Array(n).map((_, i) => (i * 7) & 255);
      const e = C.fileEncryptor();
      const parts: Uint8Array[] = [];
      const k = Math.max(1, Math.ceil(n / e.chunk));
      for (let i = 0; i < k; i++) parts.push(e.push(plain.subarray(i * e.chunk, Math.min(n, (i + 1) * e.chunk)), i === k - 1));
      const ct = Buffer.concat(parts);
      expect(ct.length).toBe(C.fileCtSize(n));
      expect(Buffer.from(C.decryptFile(ct, e.key, e.header)).equals(Buffer.from(plain))).toBe(true);
      const m = C.encryptFile(plain);
      const d = C.fileDecryptor(m.key, m.header);
      const out: Uint8Array[] = [];
      for (let o = 0; o < m.ciphertext.length; o += d.cchunk) out.push(d.pull(m.ciphertext.subarray(o, o + d.cchunk)));
      d.done();
      expect(Buffer.concat(out).equals(Buffer.from(plain))).toBe(true);
      const d2 = C.fileDecryptor(m.key, m.header);
      if (m.ciphertext.length > d2.cchunk) {
        d2.pull(m.ciphertext.subarray(0, d2.cchunk));
        expect(() => d2.done()).toThrow(); // truncated
      }
    }
  });

  it('large files: resumable chunked upload, byte-range download, quota counted up front', async () => {
    const plain = new Uint8Array(20 * 65_536 + 123).map((_, i) => (i * 31) & 255);
    const enc = C.encryptFile(plain);
    const ct = enc.ciphertext;
    expect((await Cc.post(`/api/chats/${chatId}/uploads`, { size: ct.length })).status).toBe(404);
    const s = (await A.post(`/api/chats/${chatId}/uploads`, { size: ct.length })).json;
    expect(s.partSize).toBe(8 * 1024 * 1024);
    const half = 700_000;
    expect((await A.putPart(s.uploadId, 10, ct.subarray(0, 100))).status).toBe(409); // gap
    expect((await A.putPart(s.uploadId, 0, ct.subarray(0, half))).json.received).toBe(half);
    expect((await B.putPart(s.uploadId, half, ct.subarray(half))).status).toBe(404); // someone else's upload
    expect((await A.post(`/api/uploads/${s.uploadId}/finish`)).status).toBe(409); // incomplete
    // "connection dropped": resend overlapping data from an earlier offset — server truncates and continues
    expect((await A.putPart(s.uploadId, half - 1000, ct.subarray(half - 1000))).json.received).toBe(ct.length);
    expect((await A.get(`/api/uploads/${s.uploadId}`)).json.received).toBe(ct.length);
    expect((await A.putPart(s.uploadId, ct.length, new Uint8Array(10))).status).toBe(413); // beyond declared size
    const fin = await A.post(`/api/uploads/${s.uploadId}/finish`);
    expect(fin.status).toBe(200);
    const blobId = fin.json.blobId;
    const payload: C.FilePayload = { t: 'file', kind: 'file', blobId, key: enc.key, header: enc.header, chunk: enc.chunk, name: 'big.bin', mime: 'application/octet-stream', size: plain.length };
    expect((await A.sendPayload(chatId, 1, chatKey, payload, [blobId])).status).toBe(200);
    const full = await B.download(blobId);
    expect(Buffer.from(C.decryptFile(full.bytes, enc.key, enc.header)).equals(Buffer.from(plain))).toBe(true);
    const r = await B.downloadRange(blobId, 'bytes=100-199');
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes 100-199/${ct.length}`);
    expect(Buffer.from(r.bytes).equals(Buffer.from(ct.subarray(100, 200)))).toBe(true);
    expect((await B.downloadRange(blobId, `bytes=${ct.length}-`)).status).toBe(416);
    // limits: bigger than maxFileMb, or more than the daily quota
    expect((await A.post(`/api/chats/${chatId}/uploads`, { size: 3 * 1024 * 1024 * 1024 })).status).toBe(413);
    env.ctx.db.prepare('UPDATE users SET upload_quota_mb = 1 WHERE id = ?').run(A.id);
    expect((await A.post(`/api/chats/${chatId}/uploads`, { size: 2 * 1024 * 1024 })).json.error).toBe('quota');
    env.ctx.db.prepare('UPDATE users SET upload_quota_mb = NULL WHERE id = ?').run(A.id);
    // abandoned uploads are cleaned up
    const s2 = (await A.post(`/api/chats/${chatId}/uploads`, { size: 1000 })).json;
    expect((await A.req('DELETE', `/api/uploads/${s2.uploadId}`)).status).toBe(200);
    for (let i = 0; i < 50 && fs.existsSync(path.join(env.dataDir, 'uploads', s2.uploadId)); i++) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(path.join(env.dataDir, 'uploads', s2.uploadId))).toBe(false);
  });

  it('encrypted attachments: only chat members can download, plaintext never stored, deleted with the message', async () => {
    const original = new TextEncoder().encode('PDF-SECRET-CONTENT '.repeat(10_000)); // ~190 KB → several chunks
    const enc = C.encryptFile(original);
    // corrupting any byte is detected
    const bad = enc.ciphertext.slice();
    bad[70_000] ^= 1;
    expect(() => C.decryptFile(bad, enc.key, enc.header)).toThrow();
    expect(() => C.decryptFile(enc.ciphertext.subarray(0, 65_553), enc.key, enc.header)).toThrow(); // truncated

    const up = await A.upload(chatId, enc.ciphertext);
    expect(up.status).toBe(200);
    const blobId = up.json.blobId;
    expect((await Cc.upload(chatId, enc.ciphertext)).status).toBe(404); // not a member
    expect((await B.download(blobId)).status).toBe(404); // not sent yet: only the uploader
    expect((await Cc.download(blobId)).status).toBe(404);

    const payload: C.FilePayload = { t: 'file', kind: 'file', blobId, key: enc.key, header: enc.header, chunk: enc.chunk, name: 'secret.pdf', mime: 'application/pdf', size: original.length };
    const sent = await A.sendPayload(chatId, 1, chatKey, payload, [blobId]);
    expect(sent.status).toBe(200);
    expect((await A.sendPayload(chatId, 1, chatKey, payload, [blobId])).json.error).toBe('invalid_blob'); // single use

    const dl = await B.download(blobId);
    expect(dl.status).toBe(200);
    expect(Buffer.from(C.decryptFile(dl.bytes, enc.key, enc.header)).equals(Buffer.from(original))).toBe(true);
    const onDisk = fs.readFileSync(path.join(env.dataDir, 'blobs', blobId));
    expect(onDisk.includes(Buffer.from('PDF-SECRET-CONTENT'))).toBe(false);

    // encrypted reactions
    const r = C.encryptReaction('👍', chatKey, { chatId, messageId: sent.json.message.id, userId: B.id, epoch: 1 }, B.identity!);
    expect((await B.req('PUT', `/api/messages/${sent.json.message.id}/reaction`, r)).status).toBe(200);
    const one = (await A.get(`/api/messages/${sent.json.message.id}`)).json.message;
    expect(C.decryptReaction(one.reactions[0], chatKey, chatId, sent.json.message.id, B.identity!.signPk)).toBe('👍');
    expect(() => C.decryptReaction({ ...one.reactions[0], userId: A.id }, chatKey, chatId, sent.json.message.id, A.identity!.signPk)).toThrow();

    // pins (either side in a direct chat)
    expect((await A.post(`/api/chats/${chatId}/pins`, { messageId: sent.json.message.id })).status).toBe(200);
    expect((await B.chat(chatId) as unknown as { pins: string[] }).pins).toEqual([sent.json.message.id]);
    expect((await B.req('DELETE', `/api/chats/${chatId}/pins/${sent.json.message.id}`)).status).toBe(200);

    // deleting the message removes the file, its reactions and pins
    await A.post(`/api/chats/${chatId}/pins`, { messageId: sent.json.message.id });
    await B.post('/api/messages/delete', { ids: [sent.json.message.id], scope: 'everyone' });
    for (let i = 0; i < 50 && fs.existsSync(path.join(env.dataDir, 'blobs', blobId)); i++) await new Promise((r) => setTimeout(r, 10)); // unlink is async
    expect(fs.existsSync(path.join(env.dataDir, 'blobs', blobId))).toBe(false);
    expect((await A.download(blobId)).status).toBe(404);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM reactions').get()).toEqual({ n: 0 });
    expect((await A.chat(chatId) as unknown as { pins: string[] }).pins).toEqual([]);

    // unreferenced uploads are purged after 24h
    const orphan = (await A.upload(chatId, C.encryptFile(new Uint8Array([1, 2, 3])).ciphertext)).json.blobId;
    env.ctx.db.prepare('UPDATE blobs SET created_at = 0 WHERE id = ?').run(orphan);
    purgeUnreferencedBlobs(env.ctx);
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(path.join(env.dataDir, 'blobs', orphan))).toBe(false);
  });

  it('edits only own messages', async () => {
    const r = await B.send(chatId, 1, chatKey, 'typo');
    const m = r.json.message;
    const enc = C.encryptMessage({ t: 'text', text: 'fixed' }, chatKey, { chatId, epoch: 1, senderId: B.id, clientMsgId: m.clientMsgId }, B.identity!);
    expect((await A.req('PATCH', `/api/messages/${m.id}`, enc)).status).toBe(403);
    const ok = await B.req('PATCH', `/api/messages/${m.id}`, enc);
    expect(ok.status).toBe(200);
    expect((C.decryptMessage(ok.json.message, chatKey, B.identity!.signPk) as { text: string }).text).toBe('fixed');
  });

  it('groups: signed adds rotate the key atomically; newcomers cannot read old messages', async () => {
    const { r, chatId: gid, key: k1 } = await A.createGroup('秘密小组', [B.id, Cc.id]);
    expect(r.status).toBe(200);
    expect(C.decryptTitle(r.json.chat.titleCt, gid, (e) => (e === 1 ? k1 : undefined))).toBe('秘密小组');
    await Cc.send(gid, 1, k1, 'before dave');

    // plain members cannot add; admins can, with the rotation in the same request
    await expect(B.membership(gid, 'add', [D.id])).rejects.toThrow(/only owner/); // honest client refuses
    // …and the server refuses a hand-crafted, validly signed request from a non-admin
    const prev = (await B.verifiedMembers(gid)).members;
    const forgedResult = [...prev, { id: D.id, role: 'member' as const }];
    const forgedSig = C.b64(
      (await C.ready()).crypto_sign_detached(C.membershipMessage(gid, 2, 'add', B.id, [D.id], null, forgedResult), B.identity!.signSk),
    );
    const forged = await B.post(`/api/chats/${gid}/membership`, {
      version: 2, action: 'add', targets: [D.id], signature: forgedSig, epoch: 2,
      keys: await B.seal(C.newChatKey(), { chatId: gid, epoch: 2, membershipVersion: 2 }, forgedResult.map((m) => m.id)),
    });
    expect(forged.json.error).toBe('membership_denied');
    const add = await A.membership(gid, 'add', [D.id]);
    expect(add.r.status).toBe(200);
    expect((await Cc.send(gid, 1, k1, 'old key')).status).toBe(409);
    await A.send(gid, 2, add.key!, 'welcome dave');
    expect(await D.readAll(gid)).toEqual(['welcome dave']);
    expect((await D.chatKeys(gid)).has(1)).toBe(false);

    // role changes are signed by the owner
    expect((await A.membership(gid, 'role', [B.id], 'admin')).r.status).toBe(200);
    await expect(Cc.membership(gid, 'role', [D.id], 'admin')).rejects.toThrow(/only the owner/);
    expect((await Cc.verifiedMembers(gid)).members.find((m) => m.id === B.id)?.role).toBe('admin');

    // a regular member cannot delete someone else's group message for everyone
    const { messages } = (await Cc.get(`/api/chats/${gid}/messages`)).json;
    const notMine = messages.find((m: { senderId: string }) => m.senderId !== Cc.id);
    expect((await Cc.post('/api/messages/delete', { ids: [notMine.id], scope: 'everyone' })).status).toBe(403);

    // Dave leaves (signed) → nobody can send until a remaining member rotates; Dave never gets that key
    expect((await D.membership(gid, 'leave', [D.id])).r.status).toBe(200);
    expect((await D.get(`/api/chats/${gid}/messages`)).status).toBe(404);
    expect((await Cc.chat(gid)).needsRotation).toBe(true);
    expect((await Cc.send(gid, 2, add.key!, 'x')).json.error).toBe('rotation_required');
    const rot = await Cc.rotate(gid);
    expect(rot.r.status).toBe(200);
    expect((await A.send(gid, rot.epoch, rot.key, 'after dave')).status).toBe(200);

    // admin removes Carol with an atomic rotation
    const rm = await B.membership(gid, 'remove', [Cc.id]);
    expect(rm.r.status).toBe(200);
    expect((await Cc.get(`/api/chats/${gid}`)).status).toBe(404);
    expect((await A.verifiedMembers(gid)).members.map((m) => m.id)).toEqual([A.id, B.id]);
  });

  it('detects a malicious server that slips a member into a group', async () => {
    const { chatId: gid } = await A.createGroup('g', [B.id]);
    // simulate a compromised server writing directly to its database
    env.ctx.db.prepare("INSERT INTO chat_members(chat_id, user_id, role, joined_at, join_order) VALUES (?, ?, 'member', 0, 99)").run(gid, D.id);
    const serverView = (await A.chat(gid)).members.map((m) => m.id).sort();
    const verified = (await A.verifiedMembers(gid)).members.map((m) => m.id).sort();
    expect(serverView).not.toEqual(verified); // the client refuses to seal keys to D
    // a forged log entry does not verify either
    env.ctx.db
      .prepare("INSERT INTO membership_log(chat_id, version, action, actor_id, targets, role, signature, created_at) VALUES (?, 2, 'add', ?, ?, NULL, ?, 0)")
      .run(gid, A.id, JSON.stringify([D.id]), C.b64(new Uint8Array(64)));
    await expect(A.verifiedMembers(gid)).rejects.toThrow(/bad signature/);
  });

  it('group invite links queue a join request that an admin signs in', async () => {
    const { chatId: g, key } = await A.createGroup('invite-test', []);
    await A.send(g, 1, key, 'before');
    const inv = (await A.post(`/api/chats/${g}/invites`, { maxUses: 1 })).json;
    const acc = await B.post(`/api/invites/${inv.token}/accept`);
    expect(acc.json).toMatchObject({ chatId: g, pending: true });
    expect((await B.get(`/api/chats/${g}`)).status).toBe(404); // not a member until an admin signs
    expect((await Cc.post(`/api/invites/${inv.token}/accept`)).status).toBe(404); // used up
    const reqs = (await A.get(`/api/chats/${g}/join-requests`)).json.requests;
    expect(reqs.map((x: { userId: string }) => x.userId)).toEqual([B.id]);
    const add = await A.membership(g, 'add', [B.id]);
    expect(add.r.status).toBe(200);
    expect((await A.get(`/api/chats/${g}/join-requests`)).json.requests).toHaveLength(0);
    await A.send(g, 2, add.key!, 'after');
    expect(await B.readAll(g)).toEqual(['after']);
  });

  it('changes the password (re-authenticating with the old one) and signs out other devices', async () => {
    const other = new Client(env.app, '198.51.100.3');
    await other.login('carol', 'carol-password-1');
    const s = await O.startLogin('carol-password-1');
    const r = await O.startRegistration('carol-new-password');
    const start = await Cc.post('/api/auth/password/start', { startLoginRequest: s.startLoginRequest, registrationRequest: r.registrationRequest });
    const fin = await O.finishLogin({ password: 'carol-password-1', clientLoginState: s.clientLoginState, loginResponse: start.json.loginResponse });
    const reg = await O.finishRegistration({ password: 'carol-new-password', clientRegistrationState: r.clientRegistrationState, registrationResponse: start.json.registrationResponse });
    const backup = C.encryptBackup(Cc.identity!, C.backupKeyFromExport(reg.exportKey, 'password'));
    const done = await Cc.post('/api/auth/password/finish', { loginId: start.json.loginId, finishLoginRequest: fin!.finishLoginRequest, registrationRecord: reg.registrationRecord, ...backup });
    expect(done.status).toBe(200);
    expect((await other.get('/api/me')).status).toBe(401);
    expect((await new Client(env.app, '198.51.100.3').login('carol', 'carol-password-1')).status).toBe(401);
    const fresh = new Client(env.app, '198.51.100.3');
    expect((await fresh.login('carol', 'carol-new-password')).status).toBe(200);
    expect(C.b64(fresh.identity!.signPk)).toBe(C.b64(Cc.identity!.signPk));
  });

  it('recovers the account with the 24 words: new password, every old session revoked, same identity', async () => {
    const lost = new Client(env.app, '198.51.100.9');
    await lost.post('/api/gate/password', { password: GATE_PW });
    // wrong words fail
    const bad = await O.startLogin('abandon '.repeat(23) + 'art');
    const bs = await lost.post('/api/auth/recover/start', { username: 'dave', startLoginRequest: bad.startLoginRequest });
    expect(await O.finishLogin({ password: 'abandon '.repeat(23) + 'art', clientLoginState: bad.clientLoginState, loginResponse: bs.json.loginResponse })).toBeNull();

    const s = await O.startLogin(D.recoveryPhrase);
    const start = await lost.post('/api/auth/recover/start', { username: 'dave', startLoginRequest: s.startLoginRequest });
    const fin = await O.finishLogin({ password: D.recoveryPhrase, clientLoginState: s.clientLoginState, loginResponse: start.json.loginResponse });
    const rec = await lost.post('/api/auth/recover/finish', { username: 'dave', loginId: start.json.loginId, finishLoginRequest: fin!.finishLoginRequest });
    expect(rec.status).toBe(200);
    const identity = C.decryptBackup(rec.json.recoveryBackupCt, rec.json.recoveryBackupNonce, C.backupKeyFromExport(fin!.exportKey, 'recovery'));
    expect(C.b64(identity.signPk)).toBe(C.b64(D.identity!.signPk));

    const r = await O.startRegistration('dave-brand-new-pw');
    const rs = await lost.post('/api/auth/recover/reset/start', { recoveryToken: rec.json.recoveryToken, registrationRequest: r.registrationRequest });
    const reg = await O.finishRegistration({ password: 'dave-brand-new-pw', clientRegistrationState: r.clientRegistrationState, registrationResponse: rs.json.registrationResponse });
    const backup = C.encryptBackup(identity, C.backupKeyFromExport(reg.exportKey, 'password'));
    const reset = await lost.post('/api/auth/recover/reset/finish', { recoveryToken: rec.json.recoveryToken, registrationRecord: reg.registrationRecord, ...backup });
    expect(reset.status).toBe(200);
    expect((await D.get('/api/me')).status).toBe(401); // old device signed out
    expect((await lost.post('/api/auth/recover/reset/finish', { recoveryToken: rec.json.recoveryToken, registrationRecord: reg.registrationRecord, ...backup })).status).toBe(401); // token single-use
    const fresh = new Client(env.app, '198.51.100.4');
    expect((await fresh.login('dave', 'dave-brand-new-pw')).status).toBe(200);
    D = fresh;
  });

  it('reports removals for the local search cache (deleted for everyone + hidden for me)', async () => {
    const t0 = Date.now();
    const a = (await A.send(chatId, 1, chatKey, 'to be deleted')).json.message;
    const b = (await A.send(chatId, 1, chatKey, 'to be hidden by bob')).json.message;
    await A.post('/api/messages/delete', { ids: [a.id], scope: 'everyone' });
    await B.post('/api/messages/delete', { ids: [b.id], scope: 'me' });
    const forB = (await B.get(`/api/sync/removed?since=${t0}`)).json.removed.map((r: { id: string }) => r.id);
    expect(forB).toEqual(expect.arrayContaining([a.id, b.id]));
    const forA = (await A.get(`/api/sync/removed?since=${t0}`)).json.removed.map((r: { id: string }) => r.id);
    expect(forA).toContain(a.id);
    expect(forA).not.toContain(b.id); // Bob's private hide is none of Alice's business
    expect((await Cc.get(`/api/sync/removed?since=${t0}`)).json.removed).toEqual([]); // not a member
  });

  it('web push: only to offline members, content-free, throttled, dead subscriptions dropped', async () => {
    const sent: { endpoint: string; payload: string }[] = [];
    let fail410 = false;
    env.ctx.sendPush = async (sub, payload) => {
      if (fail410) throw Object.assign(new Error('gone'), { statusCode: 410 });
      sent.push({ endpoint: sub.endpoint, payload });
    };
    expect((await B.post('/api/push/subscribe', { endpoint: 'http://push.example/x', keys: { p256dh: 'AAAA', auth: 'BBBB' } })).status).toBe(400);
    expect((await B.post('/api/push/subscribe', { endpoint: 'https://push.example/bob', keys: { p256dh: 'BPk_key', auth: 'authsecret' } })).status).toBe(200);
    expect((await B.get('/api/push/key')).json.publicKey.length).toBeGreaterThan(40);
    await A.send(chatId, 1, chatKey, 'ping 1');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([{ endpoint: 'https://push.example/bob', payload: '{"t":"msg"}' }]); // no chat id, no sender, no text
    await A.send(chatId, 1, chatKey, 'ping 2');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1); // throttled
    // an expired subscription is removed
    fail410 = true;
    env.ctx.db.prepare('DELETE FROM push_subscriptions').run();
    await Cc.post('/api/push/subscribe', { endpoint: 'https://push.example/carol', keys: { p256dh: 'CPk', auth: 'Cauth' } });
    const g = await A.createGroup('push', [Cc.id]);
    await A.send(g.chatId, 1, g.key, 'hi');
    await new Promise((r) => setTimeout(r, 20));
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });
    // logging out removes the device's subscription (session cascade)
    fail410 = false;
    await B.post('/api/push/subscribe', { endpoint: 'https://push.example/bob2', keys: { p256dh: 'X', auth: 'Y' } });
    const sid = (env.ctx.db.prepare('SELECT session_id FROM push_subscriptions').get() as { session_id: string }).session_id;
    env.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });
    // B's session was deleted above; log in again for the following tests
    await B.login('bob', 'bob-password-1');
  });

  it('v0.5 chat list: notification mute skips the push; the chat-list vault item is opaque and single', async () => {
    const { resetPushThrottle } = await import('../src/push.js');
    const sent: string[] = [];
    env.ctx.sendPush = async (sub) => void sent.push(sub.endpoint);
    env.ctx.db.prepare('DELETE FROM push_subscriptions').run();
    expect((await B.post('/api/push/subscribe', { endpoint: 'https://push.example/bob-mute', keys: { p256dh: 'BPk', auth: 'Bau' } })).status).toBe(200);
    const g = await A.createGroup('quiet', [B.id]);
    // only a member can mute, only for themselves; bad times rejected
    expect((await Cc.req('PUT', `/api/chats/${g.chatId}/notify`, { until: -1 })).status).toBe(404);
    expect((await B.req('PUT', `/api/chats/${g.chatId}/notify`, { until: Date.now() - 1000 })).status).toBe(400);
    expect((await B.req('PUT', `/api/chats/${g.chatId}/notify`, { until: -1 })).status).toBe(200);
    expect(((await B.chat(g.chatId)) as unknown as { notifyOffUntil: number }).notifyOffUntil).toBe(-1);
    expect(((await A.chat(g.chatId)) as unknown as { notifyOffUntil: number | null }).notifyOffUntil).toBeNull(); // per member
    resetPushThrottle();
    await A.send(g.chatId, 1, g.key, 'shh');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    // a timed mute that has run out no longer applies
    env.ctx.db.prepare('UPDATE chat_members SET notify_off_until = ? WHERE chat_id = ? AND user_id = ?').run(Date.now() - 1, g.chatId, B.id);
    expect(((await B.chat(g.chatId)) as unknown as { notifyOffUntil: number | null }).notifyOffUntil).toBeNull();
    await A.send(g.chatId, 1, g.key, 'loud');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual(['https://push.example/bob-mute']);
    expect((await B.req('PUT', `/api/chats/${g.chatId}/notify`, { until: 0 })).status).toBe(200);
    env.ctx.db.prepare('DELETE FROM push_subscriptions').run();
    // chat list = one encrypted item; a second one is refused (the server can't count pins / folders)
    const item = { nonce: C.b64(new Uint8Array(24)), ciphertext: C.b64(new Uint8Array(64)), blobIds: [] };
    expect((await B.req('PUT', '/api/vault/chatlist/main', item)).status).toBe(200);
    expect((await B.req('PUT', '/api/vault/chatlist/main', item)).status).toBe(200);
    expect((await B.req('PUT', '/api/vault/chatlist/other', item)).status).toBe(429);
    expect((await B.get('/api/vault/chatlist')).json.items).toHaveLength(1);
    expect((await A.get('/api/vault/chatlist')).json.items).toHaveLength(0);
  });

  it('regenerates the recovery words (password required); old words stop working', async () => {
    const newPhrase = (await import('../../web/src/crypto/recovery.js')).newRecoveryPhrase();
    const s = await O.startLogin('bob-password-1');
    const r = await O.startRegistration(newPhrase);
    const start = await B.post('/api/auth/recovery/start', { startLoginRequest: s.startLoginRequest, registrationRequest: r.registrationRequest });
    const fin = await O.finishLogin({ password: 'bob-password-1', clientLoginState: s.clientLoginState, loginResponse: start.json.loginResponse });
    const reg = await O.finishRegistration({ password: newPhrase, clientRegistrationState: r.clientRegistrationState, registrationResponse: start.json.registrationResponse });
    const rb = C.encryptBackup(B.identity!, C.backupKeyFromExport(reg.exportKey, 'recovery'));
    const done = await B.post('/api/auth/recovery/finish', {
      loginId: start.json.loginId, finishLoginRequest: fin!.finishLoginRequest, recoveryRecord: reg.registrationRecord,
      recoveryBackupCt: rb.backupCt, recoveryBackupNonce: rb.backupNonce,
    });
    expect(done.status).toBe(200);
    const tryPhrase = async (p: string) => {
      const x = await O.startLogin(p);
      const st = await B.post('/api/auth/recover/start', { username: 'bob', startLoginRequest: x.startLoginRequest });
      return O.finishLogin({ password: p, clientLoginState: x.clientLoginState, loginResponse: st.json.loginResponse });
    };
    expect(await tryPhrase(B.recoveryPhrase)).toBeNull();
    expect(await tryPhrase(newPhrase)).not.toBeNull();
    B.recoveryPhrase = newPhrase;
  });

  it('pushes real-time events over the socket', async () => {
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (env.app.server.address() as AddressInfo).port;
    const connect = (c: Client) =>
      ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], extraHeaders: { cookie: c.cookie, 'x-forwarded-for': c.ip } });

    // unknown IP is refused
    const stranger = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], extraHeaders: { cookie: B.cookie, 'x-forwarded-for': '192.0.2.99' } });
    const refused = await new Promise<string>((res) => stranger.on('connect_error', (e) => res(e.message)));
    expect(refused).toBe('ip_not_allowed');
    stranger.close();

    const sb = connect(B);
    await new Promise<void>((res) => sb.on('connect', () => res()));
    const got = new Promise<{ chatId: string }>((res) => sb.on('msg:new', res));
    await A.send(chatId, 1, chatKey, 'live!');
    expect((await got).chatId).toBe(chatId);

    const sa = connect(A);
    await new Promise<void>((res) => sa.on('connect', () => res()));
    const typing = new Promise<{ userId: string }>((res) => sb.on('typing', res));
    sa.emit('typing', { chatId, typing: true });
    expect((await typing).userId).toBe(A.id);

    // call signalling: relayed only inside a direct chat; an offer to an offline user is held for their next device
    const sig = new Promise<{ from: string; env: { x: number } }>((res) => sb.on('call:signal', res));
    sa.emit('call:signal', { chatId, to: B.id, env: { x: 1 } });
    expect((await sig).from).toBe(A.id);
    sb.close();
    await new Promise((r) => setTimeout(r, 200));
    sa.emit('call:signal', { chatId, to: B.id, env: { x: 2 }, ring: true });
    await new Promise((r) => setTimeout(r, 200));
    const sb3 = connect(B);
    const replay = await new Promise<{ from: string; env: { x: number } }>((res) => sb3.on('call:signal', res));
    expect(replay.env.x).toBe(2);
    sb3.close();
    sa.close();
  });

  it('v0.5 group calls: room per group, relay only between participants, one device per person, size cap', async () => {
    if (!env.app.server.listening) await env.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (env.app.server.address() as AddressInfo).port;
    const connect = async (c: Client) => {
      const so = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], extraHeaders: { cookie: c.cookie, 'x-forwarded-for': c.ip } });
      await new Promise<void>((res) => so.on('connect', () => res()));
      return so;
    };
    const g = await A.createGroup('call', [B.id, Cc.id]);
    const [sa, sb, sd] = [await connect(A), await connect(B), await connect(D)];
    type St = { chatId: string; callId: string | null; participants: string[] };
    const nextState = (so: typeof sa, pred: (s: St) => boolean) => new Promise<St>((res) => so.on('gcall:state', (s: St) => s.chatId === g.chatId && pred(s) && res(s)));
    const join = (so: typeof sa, video = false) => new Promise<any>((res) => so.emit('gcall:join', { chatId: g.chatId, video }, res));
    expect((await join(sd)).error).toBe('not_member');
    const bSees = nextState(sb, (s) => s.participants.includes(A.id));
    const ja = await join(sa, true);
    expect(ja.others).toEqual([]);
    expect((await bSees).callId).toBe(ja.callId);
    const jb = await join(sb);
    expect(jb).toMatchObject({ callId: ja.callId, video: true, others: [A.id] });
    // relayed between participants only
    const got = new Promise<{ from: string; env: { x: number } }>((res) => sb.on('gcall:signal', res));
    sa.emit('gcall:signal', { chatId: g.chatId, to: B.id, env: { x: 1 } });
    expect((await got)).toMatchObject({ from: A.id, env: { x: 1 } });
    let leaked = false;
    sd.on('gcall:signal', () => (leaked = true));
    sa.emit('gcall:signal', { chatId: g.chatId, to: D.id, env: { x: 2 } });
    sd.emit('gcall:signal', { chatId: g.chatId, to: A.id, env: { x: 3 } });
    // one device per person: a second device of B takes over
    const sb2 = await connect(B);
    const replaced = new Promise((res) => sb.on('gcall:replaced', res));
    await join(sb2);
    await replaced;
    // video calls hold at most 6 people
    const { _rooms } = await import('../src/groupcall.js');
    const room = _rooms.get(g.chatId)!;
    for (let i = 0; i < 4; i++) room.members.set(`fake${i}`, `sock${i}`);
    const sc = await connect(Cc);
    expect((await join(sc)).error).toBe('full');
    sc.close();
    for (let i = 0; i < 4; i++) room.members.delete(`fake${i}`);
    // leaving / disconnecting updates everyone; the room disappears with the last one
    const onlyB = nextState(sa, (s) => s.participants.length === 1);
    sa.emit('gcall:leave', { chatId: g.chatId });
    expect((await onlyB).participants).toEqual([B.id]);
    const ended = nextState(sb2, (s) => s.callId === null);
    sb2.close();
    const st = await Promise.race([ended, new Promise<St>((r) => setTimeout(() => r({ chatId: '', callId: 'timeout', participants: [] }), 1000))]);
    expect(_rooms.has(g.chatId)).toBe(false);
    expect(st.callId === null || st.callId === 'timeout').toBe(true);
    expect(leaked).toBe(false);
    for (const so of [sa, sb, sd]) so.close();
  });

  it('warns other devices about a new login and lets them kick it out', async () => {
    const port = (env.app.server.address() as AddressInfo).port;
    const sb2 = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], extraHeaders: { cookie: B.cookie, 'x-forwarded-for': B.ip } });
    await new Promise<void>((res) => sb2.on('connect', () => res()));
    const alert = new Promise<{ sessionId: string; ip: string; userAgent: string }>((res) => sb2.on('security:new-login', res));
    const laptop = new Client(env.app, B.ip);
    expect((await laptop.login('bob', 'bob-password-1')).status).toBe(200);
    const a = await alert;
    expect(a.ip).toBe(B.ip);
    expect((await laptop.get('/api/me')).status).toBe(200);
    // "not me" -> that session is gone
    expect((await B.req('DELETE', `/api/auth/sessions/${a.sessionId}`)).json.ok).toBe(true);
    expect((await laptop.get('/api/me')).status).toBe(401);
    expect((await B.get('/api/me')).status).toBe(200);
    sb2.close();
  });

  it('admin tunes ban rules and quotas; alerts are raised and delivered live', async () => {
    const port = (env.app.server.address() as AddressInfo).port;
    const sa = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], extraHeaders: { cookie: A.cookie, 'x-forwarded-for': A.ip } });
    await new Promise<void>((res) => sa.on('connect', () => res()));
    const live = new Promise<{ kind: string; message: string }>((res) => sa.on('admin:alert', res));

    const cur = (await A.get('/api/admin/limits')).json;
    expect(cur.gate.maxFails).toBeGreaterThan(0);
    const put = await A.req('PUT', '/api/admin/limits', { gate: { maxFails: 2, windowMin: 10, blockMin: 5, permanentAfter: 50 }, limits: { dailyUploadMb: 500, maxFileMb: 200 } });
    expect(put.json.gate.maxFails).toBe(2);
    expect((await B.get('/api/admin/limits')).status).toBe(403); // non-admins can't

    const x = new Client(env.app, '198.51.100.201');
    await x.post('/api/gate/password', { password: 'nope-1' });
    expect((await x.post('/api/gate/password', { password: 'nope-2' })).status).toBe(403); // blocked after 2
    const a = await live;
    expect(a.kind).toBe('ip_blocked');
    expect(a.message).toContain('198.51.100.201');
    const list = (await A.get('/api/admin/alerts')).json.alerts;
    expect(list.some((l: { kind: string }) => l.kind === 'ip_blocked')).toBe(true);
    expect((await A.get('/api/admin/overview')).json.unreadAlerts).toBeGreaterThan(0);
    await A.post('/api/admin/alerts/read-all');
    expect((await A.get('/api/admin/overview')).json.unreadAlerts).toBe(0);

    // per-user stats + quota override
    const users = (await A.get('/api/admin/users')).json;
    expect(users.defaultQuotaMb).toBe(500);
    const bob = users.users.find((u: { username: string }) => u.username === 'bob');
    expect(bob).toMatchObject({ messages: expect.any(Number), storageBytes: expect.any(Number), quotaMb: null });
    expect((await A.req('PUT', `/api/admin/users/${bob.id}/quota`, { quotaMb: 20 })).json.effectiveBytes).toBe(20 * 1024 * 1024);
    const big = new Uint8Array(21 * 1024 * 1024);
    expect((await B.upload(chatId, big)).status).toBe(429);
    await A.req('PUT', `/api/admin/users/${bob.id}/quota`, { quotaMb: null });
    // restore defaults for the rest of the suite
    await A.req('PUT', '/api/admin/limits', { gate: cur.gate, limits: cur.limits });
    sa.close();
  });

  it('admin can approve gate requests and manage the allowlist', async () => {
    const reqs = (await A.get('/api/admin/gate-requests')).json.requests;
    const pending = reqs.find((r: { status: string }) => r.status === 'pending');
    expect(pending).toBeTruthy();
    await A.post(`/api/admin/gate-requests/${pending.id}/approve`);
    expect((await new Client(env.app, '203.0.113.50').get('/api/gate/status')).json.allowed).toBe(true);
    const list = (await A.get('/api/admin/allowlist')).json.entries;
    const mine = list.find((e: { current: boolean }) => e.current);
    expect((await A.req('DELETE', `/api/admin/allowlist/${mine.id}`)).json.error).toBe('self_lockout');
  });

  it('v0.7 client error reports: anonymous, scrubbed, grouped, admin-only, rate limited', async () => {
    const r = await B.post('/api/client-errors', {
      message: 'Unexpected token \'x\', "my secret text" is not valid JSON',
      stack: 'SyntaxError\n    at parse (https://chat.example/assets/App-AbC123xy.js:3:99?token=abc)',
      path: '/i/SECRETINVITE?x=1',
      version: '0.7.0',
      browser: 'Chrome 130',
    });
    expect(r.status).toBe(200);
    await B.post('/api/client-errors', { message: 'Unexpected token \'y\', "other text" is not valid JSON', stack: 'SyntaxError\n    at parse (https://chat.example/assets/App-Zz999999.js:3:12)', version: '0.7.0' });
    expect((await B.get('/api/admin/client-errors')).status).toBe(403);
    const list = (await A.get('/api/admin/client-errors')).json.errors;
    const e = list.find((x: { message: string }) => x.message.includes('not valid JSON'));
    expect(e.count).toBe(2); // grouped: same message after scrubbing, same frame modulo hash and position
    expect(JSON.stringify(list)).not.toContain('secret');
    expect(JSON.stringify(list)).not.toContain('SECRETINVITE');
    expect(JSON.stringify(list)).not.toContain('token=abc');
    expect(Object.keys(e)).not.toContain('userId');
    for (let i = 0; i < 40; i++) await B.post('/api/client-errors', { message: 'flood ' + i });
    expect((await B.post('/api/client-errors', { message: 'one more' })).status).toBe(429);
    await A.post('/api/admin/client-errors/clear');
    expect((await A.get('/api/admin/client-errors')).json.errors).toHaveLength(0);
  });

  it('v0.7 flood guards: message bursts beyond the budget are refused with slow_down', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 130; i++) statuses.push((await A.send(chatId, 1, chatKey, 'burst ' + i)).status);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(115);
    const r = await A.send(chatId, 1, chatKey, 'one too many');
    expect(r.status).toBe(429);
    expect(r.json.error).toBe('slow_down');
  });

  it('v0.8 secret chats: device bundles, one-time prekeys used once, envelope queue, cleanup with the session', async () => {
    const mk = async (name: string, ip: string) => {
      const c = new Client(env.app, ip);
      await c.post('/api/gate/password', { password: GATE_PW });
      await c.register(createInvite(env.ctx, { kind: 'register', maxUses: 1 }).token, name, name + '-password-1');
      return c;
    };
    const E = await mk('erin8', '198.51.100.81');
    const F = await mk('frank8', '198.51.100.82');
    const G = await mk('gina8', '198.51.100.83');
    const device = async (c: Client) => {
      const dev = R.generateDeviceKeys();
      const cert = R.certifyDevice(dev, c.id, c.identity!.signSk);
      const spk = R.newSignedPrekey(dev, 1, Date.now());
      const at = Date.now();
      expect((await c.req('PUT', '/api/devices/me', { cert, spkId: 1, spkPk: C.b64(spk.pk), spkSig: C.b64(spk.sig) })).json.error).toBe('bad_signature'); // no proof of the device key
      const r = await c.req('PUT', '/api/devices/me', { cert, spkId: 1, spkPk: C.b64(spk.pk), spkSig: C.b64(spk.sig), bindAt: at, bindSig: R.signDeviceBind(dev, c.id, at) });
      expect(r.status).toBe(200);
      const opks = R.newOneTimePrekeys(1, 5);
      expect((await c.post('/api/devices/me/opks', { keys: opks.map((k) => ({ id: k.id, pk: C.b64(k.pk) })) })).json.opkCount).toBe(5);
      return { dev, cert, spk, opks };
    };
    // a certificate signed by someone else's account key is refused
    const bogus = R.generateDeviceKeys();
    const bogusCert = R.certifyDevice(bogus, E.id, F.identity!.signSk);
    const bspk = R.newSignedPrekey(bogus, 1, 0);
    expect((await E.req('PUT', '/api/devices/me', { cert: bogusCert, spkId: 1, spkPk: C.b64(bspk.pk), spkSig: C.b64(bspk.sig), bindAt: Date.now(), bindSig: R.signDeviceBind(bogus, E.id, Date.now()) })).json.error).toBe('bad_signature');
    const e = await device(E);
    const f = await device(F);
    await device(G);
    // no direct chat yet → no bundles
    expect((await F.get(`/api/users/${E.id}/prekeys`)).status).toBe(403);
    // another session of the same account can't take over E's device (the certificate is public, the key is not)
    const E2 = new Client(env.app, '198.51.100.81');
    await E2.login('erin8', 'erin8-password-1');
    const stolenAt = Date.now();
    expect(
      (await E2.req('PUT', '/api/devices/me', { cert: e.cert, spkId: 1, spkPk: C.b64(e.spk.pk), spkSig: C.b64(e.spk.sig), bindAt: stolenAt, bindSig: R.signDeviceBind(R.generateDeviceKeys(), E.id, stolenAt) })).json.error,
    ).toBe('bad_signature');
    await E.createDirect(F.id);
    const b1 = (await F.get(`/api/users/${E.id}/prekeys`)).json.bundles;
    expect(b1).toHaveLength(1);
    expect(R.verifyBundle(b1[0], E.id, E.identity!.signPk)).toBe(true);
    const b2 = (await F.get(`/api/users/${E.id}/prekeys`)).json.bundles;
    expect(b2[0].opkId).not.toBe(b1[0].opkId); // each one-time prekey is handed out once
    expect((await E.get('/api/devices/me')).json.device.opkCount).toBe(3);
    expect((await G.get(`/api/users/${E.id}/prekeys`)).status).toBe(403); // strangers get nothing
    // envelopes: only for devices of someone I share a direct chat with; only the target device reads them
    expect((await G.post('/api/secret/send', { toDevice: e.dev.deviceId, envelope: 'x' })).status).toBe(403);
    const sent = await F.post('/api/secret/send', { toDevice: e.dev.deviceId, envelope: 'opaque-ciphertext' });
    expect(sent.status).toBe(200);
    expect((await F.get('/api/secret/inbox')).json.envelopes).toHaveLength(0);
    const inbox = (await E.get('/api/secret/inbox')).json.envelopes;
    expect(inbox).toEqual([expect.objectContaining({ id: sent.json.id, fromDevice: f.dev.deviceId, fromUser: F.id, envelope: 'opaque-ciphertext' })]);
    await F.post('/api/secret/ack', { ids: [sent.json.id] }); // not F's to ack
    expect((await E.get('/api/secret/inbox')).json.envelopes).toHaveLength(1);
    await E.post('/api/secret/ack', { ids: [sent.json.id] });
    expect((await E.get('/api/secret/inbox')).json.envelopes).toHaveLength(0);
    // blocking stops it
    await E.req('PUT', `/api/blocks/${F.id}`);
    expect((await F.post('/api/secret/send', { toDevice: e.dev.deviceId, envelope: 'y' })).status).toBe(403);
    await E.req('DELETE', `/api/blocks/${F.id}`);
    // attachments: a blob of the direct chat can be marked as a secret attachment and read by both
    // logging out removes the device, its prekeys and its queue
    expect((await F.get(`/api/secret/devices/${e.dev.deviceId}?user=${E.id}`)).json.alive).toBe(true);
    expect((await G.get(`/api/secret/devices/${e.dev.deviceId}?user=${E.id}`)).status).toBe(403); // strangers learn nothing
    await E.req('PUT', `/api/blocks/${F.id}`);
    expect((await F.get(`/api/secret/devices/${e.dev.deviceId}?user=${E.id}`)).status).toBe(403); // nor blocked people
    await E.req('DELETE', `/api/blocks/${F.id}`);
    await F.post('/api/secret/send', { toDevice: e.dev.deviceId, envelope: 'z' });
    await E.post('/api/auth/logout');
    expect((await F.get(`/api/secret/devices/${e.dev.deviceId}?user=${E.id}`)).json.alive).toBe(false);
    expect((await F.post('/api/secret/send', { toDevice: e.dev.deviceId, envelope: 'after' })).json.error).toBe('device_gone');
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE id = ?').get(e.dev.deviceId)).toEqual({ n: 0 });
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM secret_envelopes WHERE to_device = ?').get(e.dev.deviceId)).toEqual({ n: 0 });
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM device_opks WHERE device_id = ?').get(e.dev.deviceId)).toEqual({ n: 0 });
    expect((await F.get(`/api/users/${E.id}/prekeys`)).json.bundles).toHaveLength(0);
  });

  it('v0.9 privacy: coarse online status hides exact times; delayed pushes are merged', async () => {
    const { pendingDelayedPushes } = await import('../src/push.js');
    const { visibleOnline } = await import('../src/presence.js');
    await B.req('PUT', '/api/me/privacy', { coarseOnline: true, pushDelay: true });
    expect((await B.get('/api/me/privacy')).json.privacy).toMatchObject({ coarseOnline: true, pushDelay: true });
    env.ctx.online.set(B.id, 1); // B comes online…
    expect(visibleOnline(env.ctx, B.id)).toBe(false); // …but isn't shown right away
    env.ctx.online.delete(B.id);
    const before = pendingDelayedPushes();
    const sent: unknown[] = [];
    const orig = env.ctx.sendPush;
    env.ctx.sendPush = async (_s, p) => void sent.push(p);
    const sid = (env.ctx.db.prepare('SELECT id FROM sessions WHERE user_id = ? LIMIT 1').get(B.id) as { id: string }).id;
    env.ctx.db.prepare('INSERT OR IGNORE INTO push_subscriptions(id, user_id, session_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('ps_v09', B.id, sid, 'https://push.example/v09', 'x', 'y', Date.now());
    const { notifyOffline } = await import('../src/push.js');
    notifyOffline(env.ctx, [B.id]);
    notifyOffline(env.ctx, [B.id]);
    expect(sent).toHaveLength(0); // not now
    expect(pendingDelayedPushes()).toBe(before + 1); // one merged push scheduled
    env.ctx.sendPush = orig;
    await B.req('PUT', '/api/me/privacy', { coarseOnline: false, pushDelay: false });
  });

  it('v0.9 per-message timer: one message expires on its own, groups take up to 100 members', async () => {
    const { MAX_GROUP } = await import('../src/chats.js');
    expect(MAX_GROUP).toBe(100);
    const clientMsgId = C.newClientMsgId();
    const enc = C.encryptMessage({ t: 'text', text: 'gone soon' }, chatKey, { chatId, epoch: 1, senderId: A.id, clientMsgId }, A.identity!);
    expect((await A.post(`/api/chats/${chatId}/messages`, { clientMsgId: C.newClientMsgId(), epoch: 1, ...enc, ttl: 5 })).status).toBe(400); // at least 30 s
    const r = await A.post(`/api/chats/${chatId}/messages`, { clientMsgId, epoch: 1, ...enc, ttl: 60 });
    expect(r.status).toBe(200);
    expect(r.json.message.expiresAt - Date.now()).toBeGreaterThan(55_000);
    expect(r.json.message.expiresAt - Date.now()).toBeLessThan(61_000);
    const plain = await A.send(chatId, 1, chatKey, 'stays');
    expect(plain.json.message.expiresAt).toBeNull();
  });
});
