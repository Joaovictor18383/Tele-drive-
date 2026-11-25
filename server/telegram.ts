import { randomBytes, createHash, createHmac } from 'node:crypto';
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import { Raw } from 'telegram/events/Raw.js';
import { CustomFile } from 'telegram/client/uploads.js';
import QRCode from 'qrcode';
import type { QrState, SrpChallenge } from '../shared/auth';
import { indexLimit, journalRecord, limitParts, smallUpload, wireBlock, wireLength, type Header, type JournalRecord, type Profile, type RemoteRecord } from '../shared/protocol';
import { ApiError, errorCode, translateTelegramError } from './errors';
import { equal, sameTelegramAccount, token } from './security';
import type { SiteSession } from './sessions';

const self = new Api.InputPeerSelf();
const deviceModel = 'CloudVault Web';
const indexMarker = 'CloudVaultIndexV1';
const headerMarker = 'CloudVaultHeaderV1';
const fileMarker = 'CloudVaultFileV1';
const randomLong = () => bigInt(randomBytes(8).readBigInt64BE().toString());

type Pending = {
  client: TelegramClient; expires: number; state?: QrState; busy?: Promise<QrState>;
  establishing?: Promise<Profile>;
  changed: boolean; user?: Api.User; event: Raw; onUpdate: (update: unknown) => void; listeners: Set<() => void>;
};
type Connection = { client: TelegramClient; touched: number; parts?: number };
type Upload = {
  owner: string; size: number; parts: number; next: number; touched: number;
  fileId: bigInt.BigInteger; sendId: bigInt.BigInteger; name: string;
  md5?: ReturnType<typeof createHash>; checksum?: string; result?: number; busy: boolean; lastDigest?: string;
};

export class Telegram {
  private readonly pending = new Map<string, Pending>();
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly uploads = new Map<string, Upload>();
  private readonly docs = new Map<string, { doc: Api.Document; expires: number }>();
  private readonly cooldowns = new Map<string, { until: number; code: string }>();
  private readonly activeRequests = new Map<string, number>();
  private readonly journalRecent = new Map<string, { id: number; touched: number }>();
  private readonly journalDocs = new Map<string, RemoteRecord>();
  private readonly headerLock = new Set<string>();

  constructor(private readonly apiId: number, private readonly apiHash: string) {}

  protected makeClient(session = '') {
    return new TelegramClient(new StringSession(session), this.apiId, this.apiHash, {
      connectionRetries: 2, requestRetries: 2, retryDelay: 800, timeout: 12,
      floodSleepThreshold: 0, deviceModel, appVersion: '1.0.0',
      baseLogger: new Logger(LogLevel.NONE)
    });
  }

  private async rpc<T>(account: string, task: () => Promise<T>) {
    const cooldown = this.cooldowns.get(account);
    if (cooldown && cooldown.until > Date.now()) {
      throw new ApiError(429, cooldown.code, Math.ceil((cooldown.until - Date.now()) / 1000));
    }
    const active = this.activeRequests.get(account) ?? 0;
    if (active >= 10) throw new ApiError(429, 'TELEGRAM_BUSY', 3);
    this.activeRequests.set(account, active + 1);
    try { return await task(); }
    catch (e) {
      const error = translateTelegramError(e);
      if (error.retryAfter) this.cooldowns.set(account, { code: error.code, until: Date.now() + error.retryAfter * 1000 });
      throw error;
    } finally {
      const remaining = (this.activeRequests.get(account) ?? 1) - 1;
      if (remaining) this.activeRequests.set(account, remaining);
      else this.activeRequests.delete(account);
    }
  }

  async qr(id: string, profile: Profile | undefined, start: boolean) {
    return this.rpc(profile?.id ?? 'desktop-login', async () => {
      let pending = this.pending.get(id);
      if (!pending && !start) throw new ApiError(404, 'QR_EXPIRED');
      if (!pending) {
        if (this.pending.size >= 50) throw new ApiError(503, 'QR_BUSY');
        const client = this.makeClient();
        const p: Pending = {
          client, expires: Date.now() + 5 * 60_000, changed: false, event: new Raw({}), listeners: new Set(),
          onUpdate: (update: unknown) => {
            if (!(update instanceof Api.UpdateLoginToken)) return;
            p.changed = true;
            p.listeners.forEach(wake => wake());
          }
        };
        client.addEventHandler(p.onUpdate, p.event);
        this.pending.set(id, p);
        pending = p;
      }
      if (pending.expires <= Date.now()) {
        await this.abandon(id);
        throw new ApiError(404, 'QR_EXPIRED');
      }
      if (pending.busy) return pending.busy;
      if (pending.state?.stage === 'srp' || pending.state?.stage === 'connected') return pending.state;
      if (pending.state?.stage === 'qr' && pending.state.expires * 1000 > Date.now() && !pending.changed) return pending.state;
      const current = pending;
      current.busy = this.advanceQr(id, profile, current);
      try { return await current.busy; }
      finally { current.busy = undefined; }
    });
  }

  async waitForQr(id: string, profile: Profile | undefined, signal: AbortSignal) {
    const pending = this.pending.get(id);
    if (pending?.state?.stage === 'qr' && !pending.changed && !pending.busy) {
      const remaining = Math.min(pending.state.expires * 1000, pending.expires) - Date.now();
      if (remaining > 0 && !signal.aborted) {
        await new Promise<void>(resolve => {
          const wake = () => {
            clearTimeout(timeout);
            pending.listeners.delete(wake);
            signal.removeEventListener('abort', wake);
            resolve();
          };
          const timeout = setTimeout(wake, Math.min(remaining, 15_000));
          pending.listeners.add(wake);
          signal.addEventListener('abort', wake, { once: true });
        });
      }
    }
    if (signal.aborted) throw new ApiError(499, 'QR_REQUEST_CLOSED');
    return this.qr(id, profile, false);
  }

  private async advanceQr(id: string, profile: Profile | undefined, p: Pending): Promise<QrState> {
    p.changed = false;
    const client = p.client;
    try {
      if (!client.connected) await client.connect();
      let result = await client.invoke(new Api.auth.ExportLoginToken({ apiId: this.apiId, apiHash: this.apiHash, exceptIds: [] }));
      if (result instanceof Api.auth.LoginTokenMigrateTo) {
        await client._switchDC(result.dcId);
        result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
      }
      if (result instanceof Api.auth.LoginToken) {
        const url = 'tg://login?token=' + result.token.toString('base64url');
        p.state = { stage: 'qr', image: await QRCode.toDataURL(url, { width: 256, margin: 2 }), expires: result.expires };
        return p.state;
      }
      if (result instanceof Api.auth.LoginTokenSuccess && result.authorization instanceof Api.auth.Authorization) {
        return this.accept(id, profile, p, result.authorization.user);
      }
      throw new ApiError(502, 'QR_FAILED');
    } catch (e) {
      if (errorCode(e) !== 'SESSION_PASSWORD_NEEDED') throw e;
      p.state = { stage: 'srp', challenge: await this.readSrp(client) };
      return p.state;
    }
  }

  private async readSrp(client: TelegramClient): Promise<SrpChallenge> {
    const { currentAlgo, srpId, srp_B: srpB } = await client.invoke(new Api.account.GetPassword());
    if (!(currentAlgo instanceof Api.PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow) || !srpId || !srpB) {
      throw new ApiError(422, 'TELEGRAM_2FA_UNSUPPORTED');
    }
    return {
      id: srpId.toString(), p: currentAlgo.p.toString('base64url'), g: currentAlgo.g, b: srpB.toString('base64url'),
      salt1: currentAlgo.salt1.toString('base64url'), salt2: currentAlgo.salt2.toString('base64url')
    };
  }

  async prove(id: string, profile: Profile | undefined, proof: { id: string; a: string; m1: string }) {
    return this.rpc(profile?.id ?? 'desktop-login', async () => {
      const p = this.pending.get(id);
      if (!p || p.state?.stage !== 'srp' || p.expires <= Date.now()) throw new ApiError(404, 'QR_EXPIRED');
      if (p.busy) throw new ApiError(409, 'QR_BUSY');
      if (p.state.challenge.id !== proof.id) throw new ApiError(409, 'TELEGRAM_2FA_INVALID');
      p.busy = (async () => {
        try {
          const result = await p.client.invoke(new Api.auth.CheckPassword({
            password: new Api.InputCheckPasswordSRP({
              srpId: bigInt(proof.id), A: Buffer.from(proof.a, 'base64url'), M1: Buffer.from(proof.m1, 'base64url')
            })
          }));
          if (!(result instanceof Api.auth.Authorization)) throw new ApiError(502, 'QR_FAILED');
          return this.accept(id, profile, p, result.user);
        } catch (e) {
          if (/PASSWORD_HASH_INVALID|SRP_ID_INVALID/.test(errorCode(e))) {
            p.state = { stage: 'srp', challenge: await this.readSrp(p.client) };
          }
          throw e;
        }
      })();
      try { return await p.busy; }
      finally { p.busy = undefined; }
    });
  }

  private async accept(id: string, profile: Profile | undefined, p: Pending, user: Api.TypeUser): Promise<QrState> {
    if (!(user instanceof Api.User) || (profile && !sameTelegramAccount(profile, user.id.toString()))) {
      await p.client.invoke(new Api.auth.LogOut()).catch(() => undefined);
      await this.abandon(id);
      throw new ApiError(403, 'ACCOUNT_MISMATCH');
    }
    if (!this.pending.has(id)) {
      await p.client.invoke(new Api.auth.LogOut()).catch(() => undefined);
      throw new ApiError(404, 'QR_EXPIRED');
    }
    p.user = user;
    p.state = { stage: 'connected' };
    return p.state;
  }

  async establish(id: string, save: (mtproto: string, profile: Profile) => Promise<void>) {
    const pending = this.pending.get(id);
    if (!pending?.user || pending.state?.stage !== 'connected') throw new ApiError(409, 'QR_FAILED');
    if (pending.establishing) return pending.establishing;
    const user = pending.user;
    const profile = {
      id: user.id.toString(),
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Telegram',
      username: user.username,
      picture: user.photo instanceof Api.UserProfilePhoto ? '/api/telegram/photo' : undefined
    };
    pending.establishing = (async () => {
      await save((pending.client.session as StringSession).save(), profile);
      pending.client.removeEventHandler(pending.onUpdate, pending.event);
      this.pending.delete(id);
      this.connections.set(id, Promise.resolve({ client: pending.client, touched: Date.now() }));
      return profile;
    })();
    try { return await pending.establishing; }
    catch (error) { pending.establishing = undefined; throw error; }
  }

  async abandon(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.listeners.forEach(wake => wake());
    if (p.user || p.state?.stage === 'srp') await p.client.invoke(new Api.auth.LogOut()).catch(() => undefined);
    await p.client.destroy().catch(() => undefined);
  }

  private async connection(id: string, s: SiteSession) {
    if (!s.mtproto) throw new ApiError(401, 'TELEGRAM_NOT_CONNECTED');
    let opening = this.connections.get(id);
    if (!opening) {
      if (this.connections.size >= 100) throw new ApiError(503, 'TELEGRAM_BUSY');
      const client = this.makeClient(s.mtproto);
      opening = client.connect().then(() => ({ client, touched: Date.now() })).catch(async error => {
        this.connections.delete(id);
        await client.destroy().catch(() => undefined);
        throw error;
      });
      this.connections.set(id, opening);
    }
    const connection = await opening;
    connection.touched = Date.now();
    return connection;
  }

  async close(id: string, session: SiteSession | undefined, revoke: boolean) {
    if (revoke && session?.mtproto) {
      try { await this.rpc(session.profile.id, async () => (await this.connection(id, session)).client.invoke(new Api.auth.LogOut())); }
      catch (e) { if (!(e instanceof ApiError) || e.code !== 'SESSION_REVOKED') throw e; }
    }
    const opening = this.connections.get(id);
    this.connections.delete(id);
    if (opening) await (await opening.catch(() => undefined))?.client.destroy().catch(() => undefined);
    await this.abandon(id);
    for (const [key, upload] of this.uploads) if (upload.owner === id) this.uploads.delete(key);
    for (const key of this.docs.keys()) if (key.startsWith(id + '/')) this.docs.delete(key);
  }

  async listSessions(id: string, session: SiteSession) {
    return this.rpc(session.profile.id, async () => {
      const { client } = await this.connection(id, session);
      const list = await client.invoke(new Api.account.GetAuthorizations());
      return list.authorizations.filter(a => a.apiId === this.apiId && a.deviceModel === deviceModel)
        .map(a => ({ id: a.hash.toString(), current: !!a.current, location: [a.region, a.country].filter(Boolean).join(', '), active: a.dateActive * 1000 }));
    });
  }

  async profilePhoto(id: string, session: SiteSession) {
    return this.rpc(session.profile.id, async () => {
      const { client } = await this.connection(id, session);
      const image = await client.downloadProfilePhoto('me', { isBig: false });
      if (!Buffer.isBuffer(image) || !image.length) throw new ApiError(404, 'FILE_UNAVAILABLE');
      return image;
    });
  }

  async revokeOther(id: string, session: SiteSession, hash: string) {
    return this.rpc(session.profile.id, async () => {
      const { client } = await this.connection(id, session);
      const list = await client.invoke(new Api.account.GetAuthorizations());
      const match = list.authorizations.find(a => !a.current && a.apiId === this.apiId && a.deviceModel === deviceModel && a.hash.toString() === hash);
      if (!match) throw new ApiError(404, 'SESSION_NOT_FOUND');
      await client.invoke(new Api.account.ResetAuthorization({ hash: match.hash }));
    });
  }

  async maxBytes(id: string, s: SiteSession) {
    return this.rpc(s.profile.id, async () => {
      const connection = await this.connection(id, s);
      if (!connection.parts) {
        const me = await connection.client.getMe();
        const premium = me instanceof Api.User && !!me.premium;
        const config = await connection.client.invoke(new Api.help.GetAppConfig({ hash: 0 })).catch(() => undefined);
        const key = 'upload_max_fileparts_' + (premium ? 'premium' : 'default');
        const json = config instanceof Api.help.AppConfig && config.config instanceof Api.JsonObject ? config.config.value : [];
        const part = json.find(prop => prop.key === key)?.value;
        connection.parts = limitParts(part instanceof Api.JsonNumber ? part.value : 0, premium);
      }
      return connection.parts * wireBlock;
    });
  }

  private caption(marker: string, account: string, name: string) {
    const signature = createHmac('sha256', this.apiHash).update(`${marker}/${account}/${name}`).digest('hex');
    return `${marker} ${signature}`;
  }

  private owned(message: Api.Message | undefined, marker: string, account: string) {
    if (!(message instanceof Api.Message) || message.fwdFrom || !(message.peerId instanceof Api.PeerUser) ||
        message.peerId.userId.toString() !== account || !(message.document instanceof Api.Document)) return;
    const doc = message.document;
    const filename = doc.attributes.find(attr => attr instanceof Api.DocumentAttributeFilename);
    const name = filename instanceof Api.DocumentAttributeFilename ? filename.fileName : '';
    if (!/^[a-f0-9]{32}\.enc$/.test(name) || !equal(message.message, this.caption(marker, account, name))) return;
    return doc;
  }

  private async readRecord(client: TelegramClient, message: Api.Message): Promise<JournalRecord> {
    const buffer = await client.downloadMedia(message);
    if (!Buffer.isBuffer(buffer)) throw new ApiError(502, 'INDEX_UNAVAILABLE');
    try { return journalRecord.parse(JSON.parse(buffer.toString('utf8'))); }
    catch { throw new ApiError(502, 'INDEX_CORRUPT'); }
  }

  async journal(id: string, s: SiteSession, after: number, before: number, known: Set<number>) {
    return this.rpc(s.profile.id, async () => {
      const { client } = await this.connection(id, s);
      const result = new Map<number, RemoteRecord>();
      let cursor = 0;
      const options = { search: indexMarker, filter: new Api.InputMessagesFilterDocument(), minId: after, maxId: before };
      const read = async (message: Api.Message) => {
        if (known.has(message.id) || result.has(message.id)) return;
        const doc = this.owned(message, indexMarker, s.profile.id);
        if (!doc || doc.size.greater(indexLimit)) return;
        const key = s.profile.id + '/' + message.id;
        let row = this.journalDocs.get(key);
        if (!row) {
          row = { id: message.id, record: await this.readRecord(client, message) };
          if (this.journalDocs.size >= 128) this.journalDocs.delete(this.journalDocs.keys().next().value!);
          this.journalDocs.set(key, row);
        }
        result.set(row.id, row);
      };
      if (!before) {
        // Search can briefly lag behind a newly saved document.
        for await (const message of client.iterMessages(self, { minId: after, limit: 24 })) await read(message);
      }
      for await (const message of client.iterMessages(self, { ...options, limit: 25 })) {
        cursor = message.id;
        await read(message);
      }
      return { records: [...result.values()], cursor };
    });
  }

  private async findHeader(client: TelegramClient, account: string, known = 0) {
    const read = async (message: Api.Message | undefined) => {
      const doc = this.owned(message, headerMarker, account);
      if (!message || !doc || doc.size.greater(4096)) return;
      const record = await this.readRecord(client, message);
      if (record.kind !== 'header') throw new ApiError(502, 'INDEX_CORRUPT');
      return { id: message.id, record };
    };
    if (known) {
      const [message] = await client.getMessages(self, { ids: [known] });
      const header = await read(message);
      if (header) return header;
    }
    for await (const message of client.iterMessages(self, { search: headerMarker, limit: 12 })) {
      const header = await read(message);
      if (header) return header;
    }
    // Recent history covers the interval before Telegram adds a new document to search.
    for await (const message of client.iterMessages(self, { limit: 25 })) {
      const header = await read(message);
      if (header) return header;
    }
  }

  async getHeader(id: string, s: SiteSession, known: number) {
    return this.rpc(s.profile.id, async () => await this.findHeader((await this.connection(id, s)).client, s.profile.id, known) ?? null);
  }

  private async withHeader<T>(account: string, task: () => Promise<T>) {
    if (this.headerLock.has(account)) throw new ApiError(409, 'HEADER_CONFLICT');
    this.headerLock.add(account);
    try { return await this.rpc(account, task); }
    finally { this.headerLock.delete(account); }
  }

  async saveHeader(id: string, s: SiteSession, next: Header, before?: Header, known?: number) {
    return this.withHeader(s.profile.id, async () => {
      const { client } = await this.connection(id, s);
      const current = await this.findHeader(client, s.profile.id, known);
      const data = Buffer.from(JSON.stringify({ kind: 'header', value: next }));
      const name = randomBytes(16).toString('hex') + '.enc';
      const caption = this.caption(headerMarker, s.profile.id, name);
      const file = new CustomFile(name, data.length, '', data);
      if (current && JSON.stringify(current.record.value) === JSON.stringify(next)) return current.id;
      if (!before) {
        if (current) throw new ApiError(409, 'VAULT_EXISTS');
        return (await client.sendFile(self, { file, caption, forceDocument: true, workers: 1 })).id;
      }
      if (!current || current.id !== known || current.record.value.vault !== next.vault ||
          JSON.stringify(current.record.value) !== JSON.stringify(before)) throw new ApiError(409, 'HEADER_CONFLICT');
      const uploaded = await client.uploadFile({ file, workers: 1 });
      await client.invoke(new Api.messages.EditMessage({
        peer: self, id: current.id, message: caption, media: new Api.InputMediaUploadedDocument({
          forceFile: true, mimeType: 'application/octet-stream', file: uploaded,
          attributes: [new Api.DocumentAttributeFilename({ fileName: name })]
        })
      }));
      return current.id;
    });
  }

  async addRecord(id: string, s: SiteSession, record: JournalRecord) {
    if (record.kind === 'header') return this.saveHeader(id, s, record.value);
    const serialized = JSON.stringify(record);
    const data = Buffer.from(serialized);
    if (data.length > indexLimit) throw new ApiError(413, 'INDEX_TOO_LARGE');
    return this.rpc(s.profile.id, async () => {
      const key = s.profile.id + '/' + createHash('sha256').update(data).digest('hex');
      const recent = this.journalRecent.get(key);
      if (recent) return recent.id;
      const { client } = await this.connection(id, s);
      const name = randomBytes(16).toString('hex') + '.enc';
      const sent = await client.sendFile(self, {
        file: new CustomFile(name, data.length, '', data), caption: this.caption(indexMarker, s.profile.id, name),
        forceDocument: true, workers: 1
      });
      if (this.journalDocs.size >= 128) this.journalDocs.delete(this.journalDocs.keys().next().value!);
      this.journalDocs.set(s.profile.id + '/' + sent.id, { id: sent.id, record });
      this.journalRecent.set(key, { id: sent.id, touched: Date.now() });
      return sent.id;
    });
  }

  async startUpload(owner: string, s: SiteSession, size: number) {
    if (size > await this.maxBytes(owner, s)) throw new ApiError(413, 'FILE_TOO_LARGE');
    if (this.uploads.size >= 100 || [...this.uploads.values()].filter(u => u.owner === owner && !u.result).length >= 6) {
      throw new ApiError(429, 'UPLOAD_BUSY', 15);
    }
    const id = token();
    const now = Date.now();
    this.uploads.set(id, {
      owner, size, parts: Math.ceil(size / wireBlock), next: 0, touched: now,
      fileId: randomLong(), sendId: randomLong(), name: randomBytes(16).toString('hex') + '.enc',
      md5: size <= smallUpload ? createHash('md5') : undefined, busy: false
    });
    return id;
  }

  private upload(owner: string, id: string) {
    const upload = this.uploads.get(id);
    if (!upload || upload.owner !== owner || !upload.result && Date.now() - upload.touched > 15 * 60_000) throw new ApiError(409, 'UPLOAD_EXPIRED');
    return upload;
  }

  async putPart(owner: string, s: SiteSession, id: string, part: number, data: Buffer) {
    const u = this.upload(owner, id);
    const digest = createHash('sha256').update(data).digest('hex');
    if (part === u.next - 1 && digest === u.lastDigest) return u.next;
    if (u.result || part !== u.next || part >= u.parts || data.length !== wireLength(u.size, part)) throw new ApiError(409, 'CHUNK_INVALID');
    return this.rpc(s.profile.id, async () => {
      if (u.busy) throw new ApiError(409, 'UPLOAD_BUSY');
      u.busy = true;
      try {
        const { client } = await this.connection(owner, s);
        const fields = { fileId: u.fileId, filePart: part, bytes: data };
        const result = await client.invoke(u.md5
          ? new Api.upload.SaveFilePart(fields)
          : new Api.upload.SaveBigFilePart({ ...fields, fileTotalParts: u.parts }));
        if (!result) throw new ApiError(502, 'CHUNK_REJECTED');
        u.md5?.update(data);
        u.lastDigest = digest;
        u.touched = Date.now();
        return ++u.next;
      } finally { u.busy = false; }
    });
  }

  private async send(client: TelegramClient, media: Api.TypeInputMedia, message: string, randomId: bigInt.BigInteger) {
    const request = new Api.messages.SendMedia({ peer: self, media, message, randomId });
    const result = await client.invoke(request);
    if (result instanceof Api.UpdateShortSentMessage) return result.id;
    const sent = client._getResponseMessage(request, result, self);
    if (sent instanceof Api.Message) return sent.id;
    throw new ApiError(502, 'MESSAGE_UNAVAILABLE');
  }

  async completeUpload(owner: string, s: SiteSession, id: string) {
    const u = this.upload(owner, id);
    if (u.result) return u.result;
    if (u.next !== u.parts || u.busy) throw new ApiError(409, 'UPLOAD_INCOMPLETE');
    return this.rpc(s.profile.id, async () => {
      u.busy = true;
      try {
        const { client } = await this.connection(owner, s);
        u.checksum ??= u.md5?.digest('hex');
        const fileInfo = { id: u.fileId, parts: u.parts, name: u.name };
        const file = u.checksum ? new Api.InputFile({ ...fileInfo, md5Checksum: u.checksum }) : new Api.InputFileBig(fileInfo);
        const media = new Api.InputMediaUploadedDocument({
          forceFile: true, file, mimeType: 'application/octet-stream', attributes: [new Api.DocumentAttributeFilename({ fileName: u.name })]
        });
        const caption = this.caption(fileMarker, s.profile.id, u.name);
        try { u.result = await this.send(client, media, caption, u.sendId); }
        catch (e) {
          if (!/RANDOM_ID_DUPLICATE|MESSAGE_UNAVAILABLE/.test(errorCode(e))) throw e;
          for await (const m of client.iterMessages(self, { limit: 50 })) {
            if (m.message === caption && this.owned(m, fileMarker, s.profile.id)) { u.result = m.id; break; }
          }
          if (!u.result) throw e;
        }
        u.touched = Date.now();
        return u.result;
      } finally { u.busy = false; }
    });
  }

  cancelUpload(owner: string, id: string) {
    const u = this.uploads.get(id);
    if (u?.owner === owner && !u.result && !u.busy) this.uploads.delete(id);
  }

  private async document(id: string, s: SiteSession, client: TelegramClient, messageId: number, refresh = false) {
    const key = id + '/' + messageId;
    const cached = this.docs.get(key);
    if (cached && cached.expires > Date.now() && !refresh) return cached.doc;
    const [message] = await client.getMessages(self, { ids: [messageId] });
    const doc = this.owned(message, fileMarker, s.profile.id);
    if (!doc) throw new ApiError(404, 'FILE_UNAVAILABLE');
    if (this.docs.size >= 600) this.docs.delete(this.docs.keys().next().value!);
    this.docs.set(key, { doc, expires: Date.now() + 60_000 });
    return doc;
  }

  async part(id: string, s: SiteSession, messageId: number, part: number) {
    return this.rpc(s.profile.id, async () => {
      const { client } = await this.connection(id, s);
      const read = async (doc: Api.Document) => {
        const length = wireLength(doc.size.toJSNumber(), part);
        if (length <= 0) throw new ApiError(416, 'CHUNK_INVALID');
        const file = new Api.InputDocumentFileLocation({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '' });
        for await (const block of client.iterDownload({
          file, offset: bigInt(part * wireBlock), requestSize: wireBlock, chunkSize: wireBlock, limit: 1, fileSize: doc.size, dcId: doc.dcId
        })) {
          if (block.length !== length) throw new ApiError(502, 'CHUNK_INVALID');
          return block;
        }
        throw new ApiError(502, 'CHUNK_INVALID');
      };
      try { return await read(await this.document(id, s, client, messageId)); }
      catch (e) {
        if (!/FILE_REFERENCE/.test(errorCode(e))) throw e;
        return read(await this.document(id, s, client, messageId, true));
      }
    });
  }

  async remove(id: string, s: SiteSession, messageId: number) {
    return this.rpc(s.profile.id, async () => {
      const { client } = await this.connection(id, s);
      try { await this.document(id, s, client, messageId, true); }
      catch (e) { if (e instanceof ApiError && e.status === 404) return; throw e; }
      await client.deleteMessages(self, [messageId], { revoke: true });
      this.docs.delete(id + '/' + messageId);
    });
  }

  async sweep() {
    const now = Date.now();
    for (const [id, u] of this.uploads) if (!u.busy && now - u.touched > 15 * 60_000) this.uploads.delete(id);
    for (const [id, p] of this.pending) if (p.expires <= now && !p.busy) await this.abandon(id);
    for (const [id, d] of this.docs) if (d.expires <= now) this.docs.delete(id);
    for (const [id, c] of this.cooldowns) if (c.until <= now) this.cooldowns.delete(id);
    for (const [id, j] of this.journalRecent) if (now - j.touched > 10 * 60_000) this.journalRecent.delete(id);
    for (const [id, opening] of this.connections) {
      const c = await opening.catch(() => undefined);
      if (c && now - c.touched > 30 * 60_000) await this.close(id, undefined, false);
    }
  }
}
