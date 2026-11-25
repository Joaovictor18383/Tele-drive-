import { header, operation, type Change, type Entry, type Header, type JournalRecord, type RemoteRecord } from '../../shared/protocol';
import { applyChanges, type Entries } from '../../shared/tree';
import { api, RequestError } from './api';
import { cachedJournal, cacheJournal, clearCache } from './cache';
import { aes, from64, openJson, sealJson, to64 } from './crypto';
import { CryptoWorker } from './worker-client';

type Snapshot = { entries: Entries; header?: Header; journalBytes: number; busy: boolean; offline: boolean; unlocked: boolean; recoveryRequired: boolean };
const fresh = (): Snapshot => ({ entries: new Map(), journalBytes: 0, busy: true, offline: false, unlocked: false, recoveryRequired: false });
type Page = { records: RemoteRecord[]; cursor: number };

export class Vault {
  private snapshot = fresh();
  private readonly listeners = new Set<() => void>();
  private readonly records = new Map<number, JournalRecord>();
  private readonly pendingPurge = new Set<number>();
  private key?: CryptoKey;
  private raw?: Uint8Array<ArrayBuffer>;
  private syncPromise?: Promise<void>;
  private changes: Promise<void> = Promise.resolve();
  private decoded = new Map<number, Change[]>();
  private lastApplied = 0;
  private cacheEnabled = true;
  private storedAt = 0;
  private fullSyncAt = Date.now();
  private headerId = 0;
  private indexBytes = 0;
  private signalController = new AbortController();
  private cryptoWorker?: CryptoWorker;
  private closed = false;

  constructor(readonly account: string) {}
  get state() { return this.snapshot; }
  get worker() { return this.cryptoWorker ??= new CryptoWorker(); }
  get signal() { return this.signalController.signal; }
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  private update(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(fn => fn());
  }

  private rows() {
    return [...this.records].sort((a, b) => a[0] - b[0]).map(([id, record]) => ({ id, record }));
  }
  private track(row: RemoteRecord) {
    const old = this.records.get(row.id);
    if (old) this.indexBytes -= JSON.stringify(old).length;
    this.indexBytes += JSON.stringify(row.record).length;
    this.records.set(row.id, row.record);
    if (row.record.kind === 'header') this.headerId = row.id;
  }
  private async persist(force = false) {
    if (!this.cacheEnabled || (!force && this.storedAt >= Date.now() - 3000)) return;
    this.storedAt = Date.now();
    await cacheJournal(this.account, this.rows()).catch(() => undefined);
  }

  async init() {
    const cached = await cachedJournal(this.account).catch(() => []);
    if (this.closed) return;
    for (const row of cached) this.track(row);
    await this.replay();
    try { await this.sync(cached.length === 0); }
    finally { this.update({ busy: false }); }
  }

  async sync(full = Date.now() - this.fullSyncAt > 6 * 60 * 60_000) {
    if (this.closed) return;
    if (this.syncPromise) return this.syncPromise;
    const signal = this.signal;
    this.syncPromise = (async () => {
      try {
        const knownIds = this.rows().map(row => row.id);
        const latest = knownIds.at(-1) ?? 0;
        const after = full ? 0 : Math.max(0, latest - 100);
        let before = 0;
        let changed = false;
        const remoteHeader = await api<RemoteRecord | null>('/storage/header?known=' + this.headerId, { signal });
        if (remoteHeader && JSON.stringify(this.records.get(remoteHeader.id)) !== JSON.stringify(remoteHeader.record)) {
          this.track(remoteHeader);
          changed = true;
        }
        do {
          const known = knownIds.filter(id => id > after && (!before || id < before)).slice(-100).join(',');
          const page: Page = await api<Page>(`/storage/journal?after=${after}&before=${before}${known ? '&known=' + known : ''}`, { signal });
          for (const entry of page.records) { this.track(entry); changed = true; }
          if (!page.cursor) break;
          if (before && page.cursor >= before) throw new Error('INDEX_UNAVAILABLE');
          before = page.cursor;
        } while (before > after + 1);
        if (full) this.fullSyncAt = Date.now();
        if (changed) await this.replay();
        this.update({ offline: false });
        if (changed) await this.persist();
      } catch (error) {
        if (signal.aborted) return;
        this.update({ offline: true });
        if (error instanceof RequestError && error.status === 401) throw error;
        if (!this.snapshot.header || !(error instanceof RequestError) || ![0, 429, 502, 503].includes(error.status)) throw error;
      }
    })().finally(() => { this.syncPromise = undefined; });
    return this.syncPromise;
  }

  private async replay() {
    const sorted = this.rows();
    let active: Header | undefined;
    for (const { record } of sorted) {
      if (record.kind === 'header' && (!active || active.vault === record.value.vault)) active = record.value;
    }
    if (!active) return;
    if (this.snapshot.header && this.snapshot.header.vault !== active.vault) this.lock();
    const key = this.key;
    if (!key) { this.update({ header: active, journalBytes: this.indexBytes }); return; }
    const state = new Map<string, Entry>();
    for (const { id, record } of sorted) {
      if (record.kind !== 'op' || record.vault !== active.vault) continue;
      let decoded = this.decoded.get(id);
      if (!decoded) {
        decoded = operation.parse(await openJson(key, record.value, 'cv1/op/' + active.vault)).changes;
        if (this.key !== key) return;
        this.decoded.set(id, decoded);
      }
      applyChanges(state, decoded);
    }
    this.lastApplied = sorted.at(-1)?.id ?? 0;
    if (this.key === key) this.update({ entries: state, header: active, unlocked: true, journalBytes: this.indexBytes });
  }

  private async accept(raw: string, h: Header) {
    const secret = from64(raw);
    const key = await aes(secret);
    if (this.closed || this.signal.aborted) { secret.fill(0); throw new Error('LOCKED'); }
    this.raw?.fill(0);
    this.raw = secret;
    this.key = key;
    try {
      await this.replay();
      if (this.snapshot.header?.vault !== h.vault || !this.snapshot.unlocked) throw new Error('VAULT_CHANGED');
    } catch (e) { this.lock(); throw e; }
  }

  private async add(record: JournalRecord) {
    const { id } = await api<{ id: number }>('/storage/journal', { method: 'POST', data: record, signal: this.signal });
    this.track({ id, record });
    return id;
  }

  private async replaceHeader(before: Header, next: Header) {
    const { id } = await api<{ id: number }>('/storage/header/' + this.headerId, {
      method: 'PUT', data: { before, next }, signal: this.signal
    });
    this.track({ id, record: { kind: 'header', value: next } });
    this.update({ header: next, journalBytes: this.indexBytes });
    await this.persist(true);
  }

  async create(password: string) {
    await this.sync();
    if (this.snapshot.header) throw new Error('VAULT_EXISTS');
    const result = await this.worker.call('create', password);
    const h = header.parse(result.header);
    await this.add({ kind: 'header', value: h });
    await this.replay();
    await this.sync(true);
    await this.accept(result.raw, h);
    await this.persist(true);
    return result.recoveryCode;
  }

  async unlock(secret: string, recover: boolean) {
    const h = this.snapshot.header;
    if (!h) throw new Error('INDEX_UNAVAILABLE');
    const raw = await this.worker.call('unlock', h, secret, recover).catch(() => { throw new Error(recover ? 'RECOVERY_INVALID' : 'PASSWORD_INVALID'); });
    await this.accept(raw, h);
    this.update({ recoveryRequired: recover });
  }

  async changePassword(current: string, password: string) {
    await this.sync();
    const h = this.snapshot.header;
    if (!h || !this.raw) throw new Error('LOCKED');
    if (!this.snapshot.recoveryRequired) {
      await this.worker.call('unlock', h, current, false).catch(() => { throw new Error('PASSWORD_INVALID'); });
    }
    const wrap = await this.worker.call('wrap', to64(this.raw), h.vault, password);
    await this.replaceHeader(h, { ...h, ...wrap });
    this.update({ recoveryRequired: false });
  }

  async rotateRecovery(password: string) {
    await this.sync();
    const h = this.snapshot.header;
    if (!h || !this.raw) throw new Error('LOCKED');
    await this.worker.call('unlock', h, password, false).catch(() => { throw new Error('PASSWORD_INVALID'); });
    const { recovery, recoveryCode } = await this.worker.call('recovery', to64(this.raw), h.vault);
    await this.replaceHeader(h, { ...h, recovery });
    return recoveryCode;
  }

  mutate(changes: Change[]) {
    const signal = this.signal;
    const job = this.changes.then(async () => {
      signal.throwIfAborted();
      const key = this.key;
      const vault = this.snapshot.header?.vault;
      if (!key || !vault) throw new Error('LOCKED');
      for (let i = 0; i < changes.length; i += 100) {
        signal.throwIfAborted();
        const value = operation.parse({ changes: changes.slice(i, i + 100) });
        const op = await sealJson(key, value, 'cv1/op/' + vault);
        signal.throwIfAborted();
        const id = await this.add({ kind: 'op', vault, value: op });
        if (this.key !== key) return;
        if (id > this.lastApplied && !this.syncPromise) {
          this.decoded.set(id, value.changes);
          const entries = new Map(this.snapshot.entries);
          applyChanges(entries, value.changes);
          this.lastApplied = id;
          this.update({ entries, journalBytes: this.indexBytes });
        } else await this.replay();
      }
      await this.persist(true);
    });
    this.changes = job.catch(() => undefined);
    return job;
  }

  markPurge(id: number) { this.pendingPurge.add(id); }
  unmarkPurge(id: number) { this.pendingPurge.delete(id); }
  isPurging(id: number) { return this.pendingPurge.has(id); }

  encryptedExport() { return { format: 'cloudvault-journal-v1', records: this.rows() }; }

  async clearCache() {
    this.cacheEnabled = false;
    await clearCache(this.account);
  }

  lock() {
    this.signalController.abort(new Error('LOCKED'));
    this.signalController = new AbortController();
    this.cryptoWorker?.close();
    this.cryptoWorker = undefined;
    this.key = undefined;
    this.raw?.fill(0);
    this.raw = undefined;
    this.decoded.clear();
    this.lastApplied = 0;
    this.update({ entries: new Map(), unlocked: false, recoveryRequired: false });
  }

  close() {
    this.closed = true;
    this.lock();
    this.signalController.abort();
  }
}
