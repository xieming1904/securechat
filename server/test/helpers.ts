import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import * as C from '../../web/src/crypto/core.js';
import * as O from '../../web/src/crypto/opaqueClient.js';
import { newRecoveryPhrase } from '../../web/src/crypto/recovery.js';

export { C, O };

export async function makeApp(extra: Record<string, unknown> = {}) {
  await C.ready();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
  const r = await buildApp({ dataDir, trustProxy: 'loopback', cookieSecure: false, webDist: '/nonexistent', ...extra });
  return { ...r, dataDir };
}

export interface ChatInfo {
  id: string;
  type: 'direct' | 'group';
  currentEpoch: number;
  membershipVersion: number;
  needsRotation: boolean;
  members: { id: string; role: C.Role }[];
}

/** A scripted client that does everything the browser does (OPAQUE, key backup, signing, sealing). */
export class Client {
  cookie = '';
  id = '';
  username = '';
  recoveryPhrase = '';
  identity?: C.Identity;
  /** e.g. { origin, host } for WebAuthn requests */
  extraHeaders: Record<string, string> = {};
  constructor(public app: FastifyInstance, public ip: string) {}

  async req(method: string, url: string, body?: unknown, remoteAddress = '127.0.0.1') {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      payload: body as object,
      remoteAddress,
      headers: { 'x-forwarded-for': this.ip, ...(this.cookie ? { cookie: this.cookie } : {}), ...this.extraHeaders },
    });
    const sc = res.headers['set-cookie'];
    if (sc) {
      const first = (Array.isArray(sc) ? sc : [sc]).find((c) => c.startsWith('sid='));
      if (first) this.cookie = first.split(';')[0];
    }
    let json: any = undefined;
    try {
      json = res.json();
    } catch {
      /* not json */
    }
    return { status: res.statusCode, json, body: res.body, headers: res.headers };
  }
  async upload(chatId: string, bytes: Uint8Array) {
    const res = await this.app.inject({
      method: 'POST',
      url: `/api/chats/${chatId}/blobs`,
      payload: Buffer.from(bytes),
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/octet-stream', 'x-forwarded-for': this.ip, cookie: this.cookie },
    });
    return { status: res.statusCode, json: res.statusCode < 300 ? res.json() : res.json() };
  }
  async putPart(uploadId: string, offset: number, bytes: Uint8Array) {
    const res = await this.app.inject({
      method: 'PUT',
      url: `/api/uploads/${uploadId}?offset=${offset}`,
      payload: Buffer.from(bytes),
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/octet-stream', 'x-forwarded-for': this.ip, cookie: this.cookie },
    });
    return { status: res.statusCode, json: res.json() };
  }
  async downloadRange(blobId: string, range: string) {
    const res = await this.app.inject({ method: 'GET', url: `/api/blobs/${blobId}`, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': this.ip, cookie: this.cookie, range } });
    return { status: res.statusCode, headers: res.headers, bytes: new Uint8Array(res.rawPayload) };
  }
  async download(blobId: string) {
    const res = await this.app.inject({ method: 'GET', url: `/api/blobs/${blobId}`, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': this.ip, cookie: this.cookie } });
    return { status: res.statusCode, bytes: new Uint8Array(res.rawPayload) };
  }
  async sendPayload(chatId: string, epoch: number, key: Uint8Array, payload: C.Payload, blobIds: string[] = []) {
    const clientMsgId = C.newClientMsgId();
    const enc = C.encryptMessage(payload, key, { chatId, epoch, senderId: this.id, clientMsgId }, this.identity!);
    return this.post(`/api/chats/${chatId}/messages`, { clientMsgId, epoch, ...enc, blobIds });
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b: unknown = {}) => this.req('POST', u, b);

  // ------------------------------------------------------------ accounts
  async register(invite: string, username: string, password: string) {
    const phrase = newRecoveryPhrase();
    const pw = await O.startRegistration(password);
    const rc = await O.startRegistration(phrase);
    const start = await this.post('/api/auth/register/start', {
      invite,
      username,
      registrationRequest: pw.registrationRequest,
      recoveryRegistrationRequest: rc.registrationRequest,
    });
    if (start.status !== 200) throw new Error(`register/start ${start.status} ${start.body}`);
    const pwDone = await O.finishRegistration({ password, clientRegistrationState: pw.clientRegistrationState, registrationResponse: start.json.registrationResponse });
    const rcDone = await O.finishRegistration({ password: phrase, clientRegistrationState: rc.clientRegistrationState, registrationResponse: start.json.recoveryRegistrationResponse });
    const id = C.generateIdentity();
    const backup = C.encryptBackup(id, C.backupKeyFromExport(pwDone.exportKey, 'password'));
    const rbackup = C.encryptBackup(id, C.backupKeyFromExport(rcDone.exportKey, 'recovery'));
    const r = await this.post('/api/auth/register/finish', {
      invite,
      username,
      displayName: username.toUpperCase(),
      registrationRecord: pwDone.registrationRecord,
      recoveryRecord: rcDone.registrationRecord,
      signPk: C.b64(id.signPk),
      boxPk: C.b64(id.boxPk),
      ...backup,
      recoveryBackupCt: rbackup.backupCt,
      recoveryBackupNonce: rbackup.backupNonce,
    });
    if (r.status !== 200) throw new Error(`register failed ${r.status} ${r.body}`);
    this.id = r.json.user.id;
    this.username = username;
    this.identity = id;
    this.recoveryPhrase = phrase;
    return r;
  }

  async login(username: string, password: string) {
    const s = await O.startLogin(password);
    const start = await this.post('/api/auth/login/start', { username, startLoginRequest: s.startLoginRequest });
    if (start.status !== 200) return start;
    const fin = await O.finishLogin({ password, clientLoginState: s.clientLoginState, loginResponse: start.json.loginResponse });
    if (!fin) return { status: 401, json: { error: 'bad_credentials' }, body: '', headers: {} };
    const r = await this.post('/api/auth/login/finish', { username, loginId: start.json.loginId, finishLoginRequest: fin.finishLoginRequest });
    if (r.status === 200 && !r.json.totpRequired) {
      this.id = r.json.user.id;
      this.username = username;
      this.identity = C.decryptBackup(r.json.keys.backupCt, r.json.keys.backupNonce, C.backupKeyFromExport(fin.exportKey, 'password'));
    }
    return r;
  }

  loginRaw = (u: string, p: string) => this.login(u, p);

  async userKeys(userId: string) {
    const k = (await this.get(`/api/users/${userId}`)).json.keys;
    return { signPk: C.unb64(k.signPk), boxPk: C.unb64(k.boxPk) };
  }

  // ------------------------------------------------------------ chats
  async chat(chatId: string): Promise<ChatInfo> {
    return (await this.get(`/api/chats/${chatId}`)).json.chat;
  }

  async verifiedMembers(chatId: string) {
    const { log } = (await this.get(`/api/chats/${chatId}/membership`)).json;
    return C.verifyMembershipChain(chatId, log, async (uid) => (await this.userKeys(uid)).signPk);
  }

  async seal(key: Uint8Array, ctx: Omit<C.KeyContext, 'distributorId'>, memberIds: string[]) {
    const out = [];
    for (const m of memberIds) out.push(C.sealChatKey(key, { ...ctx, distributorId: this.id }, m, (await this.userKeys(m)).boxPk, this.identity!));
    return out;
  }

  async createDirect(peerId: string) {
    const chatId = 'c_' + C.randomId();
    const key = C.newChatKey();
    const { signature, result } = C.signMembership(chatId, 1, [], 'create', { id: this.id, identity: this.identity! }, [peerId], 'direct');
    const keys = await this.seal(key, { chatId, epoch: 1, membershipVersion: 1 }, result.map((m) => m.id));
    const r = await this.post('/api/chats', { id: chatId, type: 'direct', peerId, keys, membershipSignature: signature });
    return { r, chatId: r.json?.chat?.id ?? chatId, key };
  }

  async createGroup(title: string, memberIds: string[]) {
    const chatId = 'c_' + C.randomId();
    const key = C.newChatKey();
    const { signature, result } = C.signMembership(chatId, 1, [], 'create', { id: this.id, identity: this.identity! }, memberIds, 'group');
    const keys = await this.seal(key, { chatId, epoch: 1, membershipVersion: 1 }, result.map((m) => m.id));
    const r = await this.post('/api/chats', {
      id: chatId,
      type: 'group',
      memberIds,
      titleCt: C.encryptTitle(title, key, chatId, 1),
      keys,
      membershipSignature: signature,
    });
    return { r, chatId, key };
  }

  /** Signed membership change (+ atomic rotation for add/remove). Returns the new key if rotated. */
  async membership(chatId: string, action: 'add' | 'remove' | 'leave' | 'role', targets: string[], role?: string) {
    const chat = await this.chat(chatId);
    const { members } = await this.verifiedMembers(chatId);
    const version = chat.membershipVersion + 1;
    const { signature, result } = C.signMembership(chatId, version, members, action, { id: this.id, identity: this.identity! }, targets, role);
    const body: Record<string, unknown> = { version, action, targets, role, signature };
    let key: Uint8Array | undefined;
    if (action === 'add' || action === 'remove') {
      key = C.newChatKey();
      body.epoch = chat.currentEpoch + 1;
      body.keys = await this.seal(key, { chatId, epoch: chat.currentEpoch + 1, membershipVersion: version }, result.map((m) => m.id));
    }
    const r = await this.post(`/api/chats/${chatId}/membership`, body);
    return { r, key };
  }

  async rotate(chatId: string) {
    const chat = await this.chat(chatId);
    const key = C.newChatKey();
    const epoch = chat.currentEpoch + 1;
    const keys = await this.seal(key, { chatId, epoch, membershipVersion: chat.membershipVersion }, chat.members.map((m) => m.id));
    const r = await this.post(`/api/chats/${chatId}/keys`, { epoch, membershipVersion: chat.membershipVersion, keys });
    return { r, key, epoch };
  }

  /** Open every sealed key addressed to me, checking the distributor was a member at that membership version. */
  async chatKeys(chatId: string) {
    const { history } = await this.verifiedMembers(chatId);
    const { keys } = (await this.get(`/api/chats/${chatId}/keys`)).json;
    const map = new Map<number, Uint8Array>();
    for (const k of keys) {
      const members = history.get(k.membershipVersion);
      if (!members?.some((m) => m.id === k.distributorId)) throw new Error('distributor was not a member');
      map.set(k.epoch, C.openChatKey(k, chatId, this.id, this.identity!, (await this.userKeys(k.distributorId)).signPk));
    }
    return map;
  }

  async send(chatId: string, epoch: number, key: Uint8Array, text: string) {
    const clientMsgId = C.newClientMsgId();
    const enc = C.encryptMessage({ t: 'text', text }, key, { chatId, epoch, senderId: this.id, clientMsgId }, this.identity!);
    return this.post(`/api/chats/${chatId}/messages`, { clientMsgId, epoch, ...enc });
  }

  async readAll(chatId: string) {
    const keys = await this.chatKeys(chatId);
    const { messages } = (await this.get(`/api/chats/${chatId}/messages`)).json;
    const out: string[] = [];
    for (const m of messages) {
      const k = keys.get(m.epoch);
      if (!k) {
        out.push('<no key>');
        continue;
      }
      const p = C.decryptMessage(m, k, (await this.userKeys(m.senderId)).signPk);
      out.push((p as { text: string }).text);
    }
    return out;
  }
}

// ------------------------------------------------------------------ software passkey (WebAuthn authenticator) for tests
import nodeCrypto from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | Buffer) => nodeCrypto.createHash('sha256').update(b).digest();
export class SoftPasskey {
  private kp = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  credId = nodeCrypto.randomBytes(16);
  counter = 0;
  constructor(public origin = 'http://localhost') {}
  private cose() {
    const jwk = this.kp.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
      ]),
    );
  }
  private authData(rpID: string, flags: number, attested?: Uint8Array) {
    const cnt = Buffer.alloc(4);
    cnt.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(Buffer.from(rpID)), Buffer.from([flags]), cnt, ...(attested ? [Buffer.from(attested)] : [])]);
  }
  register(opts: { challenge: string; rp: { id: string } }) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opts.challenge, origin: this.origin, crossOrigin: false }));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credId.length);
    const attested = Buffer.concat([Buffer.alloc(16), len, this.credId, Buffer.from(this.cose())]);
    const authData = this.authData(opts.rp.id, 0x45, attested);
    const attObj = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]) as never);
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attObj), transports: ['internal'] },
      clientExtensionResults: {},
    };
  }
  assert(opts: { challenge: string; rpId: string }, override?: { origin?: string }) {
    this.counter++;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin: override?.origin ?? this.origin, crossOrigin: false }));
    const authData = this.authData(opts.rpId, 0x05);
    const sig = nodeCrypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.kp.privateKey);
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(sig) },
      clientExtensionResults: {},
    };
  }
}
