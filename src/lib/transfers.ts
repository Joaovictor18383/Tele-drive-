import { chunkCount, cipherSize, plainBlock, wireLength, type FileEntry } from '../../shared/protocol';
import { api, RequestError, wait } from './api';
import { bytes, to64 } from './crypto';
import type { Destination } from './io';
import type { Vault } from './vault';

export type Stage = 'queued' | 'hashing' | 'encrypting' | 'uploading' | 'decrypting' | 'downloading' | 'saving' | 'paused' | 'waiting' | 'done' | 'error' | 'cancelling' | 'cancelled' | 'duplicate';
export type Transfer = {
  id: string; name: string; size: number; direction: 'upload' | 'download'; stage: Stage;
  done: number; speed: number; eta?: number; error?: string; retryAt?: number;
};
type Task = {
  row: Transfer;
  run: (ctx: Context) => Promise<void>;
  ctrl: AbortController;
  paused: boolean;
  allowDuplicate: boolean;
  retryCleanup?: () => Promise<void>;
  abortCleanup?: () => Promise<void>;
  resume?: () => void;
};
type Context = {
  signal: AbortSignal; allowDuplicate: boolean;
  checkpoint: () => Promise<void>;
  stage: (stage: Stage) => void;
  progress: (done: number) => void;
  retrying: <T>(fn: () => Promise<T>, stage: Stage) => Promise<T>;
  cleanup: (abort: () => Promise<void>, retry?: () => Promise<void>) => void;
};
type Source = { name: string; size: number; mime: string; hash?: string; read: (part: number, ctx: Context) => Promise<ArrayBuffer> };

const finished = new Set<Stage>(['done', 'error', 'cancelled', 'duplicate']);
const isRetryable = (error: unknown) =>
  error instanceof RequestError && [0, 429, 500, 502, 503, 504].includes(error.status);

export class Transfers {
  private readonly tasks = new Map<string, Task>();
  private readonly listeners = new Set<() => void>();
  private rows: Transfer[] = [];
  private running = false;
  private current?: Task;
  private disposed = false;

  constructor(private readonly vault: Vault) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  getSnapshot = () => this.rows;

  private emit() {
    this.rows = [...this.tasks.values()].map(t => t.row);
    this.listeners.forEach(fn => fn());
  }
  private set(task: Task, patch: Partial<Transfer>) {
    task.row = { ...task.row, ...patch };
    this.emit();
  }
  private queue(name: string, size: number, direction: Transfer['direction'], run: Task['run']) {
    if (this.disposed) return;
    const id = crypto.randomUUID();
    this.tasks.set(id, { row: { id, name, size, direction, stage: 'queued', done: 0, speed: 0 }, run, ctrl: new AbortController(), paused: false, allowDuplicate: false });
    this.emit();
    void this.drain();
  }

  addFile(file: File, parent: string | null, max: number, name = file.name) {
    this.addSource({
      name, size: file.size, mime: file.type,
      read: (part) => file.slice(part * plainBlock, (part + 1) * plainBlock).arrayBuffer()
    }, parent, max);
  }

  copy(file: FileEntry, name: string, parent: string | null, max: number) {
    const job = crypto.randomUUID();
    this.addSource({ ...file, name, read: async (part, ctx) => {
      if (part === 0) await this.vault.worker.call('fileOpen', job, file.key);
      try {
        const block = await this.readBlock(file, part, job, ctx.signal, request => ctx.retrying(request, 'downloading'));
        if (part + 1 === chunkCount(file.size)) await this.vault.worker.call('fileClose', job);
        return block;
      } catch (e) { await this.vault.worker.call('fileClose', job).catch(() => undefined); throw e; }
    } }, parent, max, true, () => this.vault.worker.call('fileClose', job).catch(() => undefined));
  }

  private addSource(source: Source, parent: string | null, max: number, copy = false, onAbort?: () => Promise<void>) {
    const { size, name, mime } = source;
    let upload: string | undefined;
    let file: FileEntry | undefined;
    let indexing = false;
    let id = crypto.randomUUID();
    let nonce = to64(bytes(8));
    let key = to64(bytes(32));
    let next = 0;
    let hash = source.hash;
    const total = chunkCount(size);
    const reset = async () => {
      if (upload) await api('/storage/upload/' + upload, { method: 'DELETE' }).catch(() => undefined);
      upload = undefined;
      id = crypto.randomUUID();
      nonce = to64(bytes(8));
      key = to64(bytes(32));
      next = 0;
    };
    this.queue(name, size, 'upload', async ctx => {
      ctx.cleanup(async () => {
        await onAbort?.();
        if (file && !indexing) {
          await api('/storage/file/' + file.remote, { method: 'DELETE' }).catch(() => undefined);
          file = undefined;
        }
        if (!file) await reset();
      }, !copy ? undefined : async () => { if (!file) await reset(); });
      if (cipherSize(size) > max) throw new Error('FILE_TOO_LARGE');
      await ctx.checkpoint();
      const worker = this.vault.worker;
      const job = crypto.randomUUID();
      try {
        if (!hash) {
          ctx.stage('hashing');
          await worker.call('hashStart', job);
          for (let part = 0; part < total; part++) {
            await ctx.checkpoint();
            await worker.call('hashPart', job, await source.read(part, ctx));
          }
          hash = await worker.call('hashEnd', job);
        }
        if (!file && !copy && !ctx.allowDuplicate && [...this.vault.state.entries.values()].some(entry =>
          entry.kind === 'file' && !entry.trash && entry.hash === hash)) throw new Error('DUPLICATE');
        for (let attempt = 0; !file; attempt++) {
          try {
            upload ??= (await ctx.retrying(() => api<{ id: string }>('/storage/upload', {
              method: 'POST', data: { size: cipherSize(size) }, signal: ctx.signal
            }), 'uploading')).id;
            await worker.call('fileOpen', job, key);
            while (next < total) {
              await ctx.checkpoint();
              const part = next;
              ctx.stage('encrypting');
              const data = await worker.call('encrypt', job, nonce, id, part, size, await source.read(part, ctx));
              const { next: ack } = await ctx.retrying(() => api<{ next: number }>(`/storage/upload/${upload}/${part}`, {
                method: 'PUT', data, signal: ctx.signal
              }), 'uploading');
              if (ack !== part + 1) throw new Error('CHUNK_INVALID');
              next = ack;
              ctx.progress(Math.min(size, next * plainBlock));
            }
            const { remote } = await ctx.retrying(() => api<{ remote: number }>(`/storage/upload/${upload}/complete`, {
              method: 'POST', signal: ctx.signal
            }), 'saving');
            const now = Date.now();
            file = { id, kind: 'file', name, parent, size, mime, hash, remote, key, nonce, contentId: id, created: now, updated: now, trash: null, favorite: false };
          } catch (e) {
            if (attempt || !(e instanceof Error) || e.message !== 'UPLOAD_EXPIRED') throw e;
            await reset();
            ctx.progress(0);
          }
        }
        ctx.stage('saving');
        indexing = true;
        await this.vault.mutate([{ type: 'put', entry: file }]);
      } finally { await worker.call('fileClose', job).catch(() => undefined); }
    });
  }

  private async readBlock(file: FileEntry, part: number, job: string, signal: AbortSignal, request: <T>(fn: () => Promise<T>) => Promise<T>) {
    const data = await request(() => api<ArrayBuffer>(`/storage/file/${file.remote}/${part}`, { binary: true, signal }));
    if (data.byteLength !== wireLength(cipherSize(file.size), part)) throw new Error('SIZE_MISMATCH');
    return this.vault.worker.call('decrypt', job, file.nonce, file.contentId, part, file.size, data)
      .catch(error => { if (signal.aborted) throw signal.reason; throw new Error('INTEGRITY'); });
  }

  stream(file: FileEntry, ctx?: Context, external?: AbortSignal, onBytes?: (count: number) => void) {
    const job = crypto.randomUUID();
    const worker = this.vault.worker;
    const signal = ctx?.signal ?? external ?? this.vault.signal;
    let part = 0;
    let read = 0;
    const close = () => worker.call('fileClose', job).catch(() => undefined);
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      start: async () => {
        await worker.call('fileOpen', job, file.key);
        await worker.call('hashStart', job);
      },
      pull: async controller => {
        try {
          await ctx?.checkpoint();
          signal.throwIfAborted();
          ctx?.stage('downloading');
          const data = await this.readBlock(file, part, job, signal, fn => ctx ? ctx.retrying(fn, 'downloading') : fn());
          ctx?.stage('decrypting');
          await worker.call('hashPart', job, data.slice(0));
          read += data.byteLength;
          if (++part === chunkCount(file.size)) {
            if (await worker.call('hashEnd', job) !== file.hash || read !== file.size) throw new Error('INTEGRITY');
            if (data.byteLength) controller.enqueue(new Uint8Array(data));
            onBytes?.(data.byteLength);
            controller.close();
            await close();
          } else {
            controller.enqueue(new Uint8Array(data));
            onBytes?.(data.byteLength);
          }
        } catch (e) { await close(); controller.error(e); }
      },
      cancel: close
    }, { highWaterMark: 0 });
  }

  range(file: FileEntry, start: number, end: number, signal: AbortSignal) {
    const job = crypto.randomUUID();
    const worker = this.vault.worker;
    const close = () => worker.call('fileClose', job).catch(() => undefined);
    let offset = start;
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      start: () => worker.call('fileOpen', job, file.key),
      pull: async controller => {
        try {
          signal.throwIfAborted();
          const part = Math.floor(offset / plainBlock);
          const left = offset - part * plainBlock;
          const data = await this.readBlock(file, part, job, signal, request => request());
          const right = Math.min(data.byteLength, left + end - offset + 1);
          if (right <= left) throw new Error('SIZE_MISMATCH');
          controller.enqueue(new Uint8Array(data.slice(left, right)));
          offset += right - left;
          if (offset > end) { controller.close(); await close(); }
        } catch (error) { await close(); controller.error(error); }
      },
      cancel: close
    }, { highWaterMark: 0 });
  }

  download(file: FileEntry, target: Destination) {
    this.queue(file.name, file.size, 'download', async ctx => {
      let done = 0;
      await target.save(this.stream(file, ctx, undefined, count => ctx.progress(done += count)), ctx.signal);
    });
  }

  zip(name: string, folders: string[], files: { file: FileEntry; path: string }[], target: Destination) {
    this.queue(name, files.reduce((sum, item) => sum + item.file.size, 0), 'download', async ctx => {
      const { ZipWriter } = await import('@zip.js/zip.js');
      const pair = new TransformStream<Uint8Array<ArrayBuffer>>();
      const writer = new ZipWriter(pair.writable, { zip64: true, bufferedWrite: false, level: 0, useWebWorkers: false });
      const abort = new AbortController();
      const signal = AbortSignal.any([ctx.signal, abort.signal]);
      const readable = pair.readable.pipeThrough(new TransformStream(), { signal });
      const saved = target.save(readable, signal);
      void saved.catch(() => undefined);
      let done = 0;
      try {
        for (const folder of folders) {
          await ctx.checkpoint();
          await writer.add(folder + '/', undefined, { directory: true, signal });
        }
        for (const { file, path } of files) {
          await ctx.checkpoint();
          await writer.add(path, this.stream(file, ctx, undefined, count => ctx.progress(done += count)), { signal });
        }
        await writer.close();
        await saved;
      } catch (error) {
        abort.abort(error);
        await saved.catch(() => undefined);
        throw error;
      }
    });
  }

  pause(id: string) {
    const task = this.tasks.get(id);
    if (!task || finished.has(task.row.stage) || task.row.stage === 'saving') return;
    if (task.paused) { task.paused = false; task.resume?.(); }
    else { task.paused = true; this.set(task, { stage: 'paused', speed: 0, eta: undefined }); }
    void this.drain();
  }

  cancel(id: string) {
    const task = this.tasks.get(id);
    if (!task || finished.has(task.row.stage) || task.row.stage === 'saving') return;
    task.ctrl.abort(new Error('CANCELLED'));
    task.resume?.();
    this.set(task, { stage: task === this.current ? 'cancelling' : 'cancelled', speed: 0, eta: undefined });
  }

  async retry(id: string) {
    const task = this.tasks.get(id);
    if (!task || !['error', 'cancelled', 'duplicate'].includes(task.row.stage)) return;
    task.allowDuplicate ||= task.row.stage === 'duplicate';
    task.ctrl = new AbortController();
    task.paused = false;
    await task.retryCleanup?.();
    this.set(task, { stage: 'queued', done: 0, speed: 0, eta: undefined, error: undefined, retryAt: undefined });
    void this.drain();
  }

  clearFinished() {
    for (const [id, task] of this.tasks) if (task.row.stage === 'done') this.tasks.delete(id);
    this.emit();
  }

  private async drain() {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed) {
        const task = [...this.tasks.values()].find(t => (t.row.stage === 'queued' || t.row.stage === 'paused') && !t.paused);
        if (!task) break;
        this.current = task;
        const signal = AbortSignal.any([task.ctrl.signal, this.vault.signal]);
        let baseline = performance.now();
        let lastBytes = 0;
        let stage: Stage = 'queued';
        const checkpoint = async () => {
          signal.throwIfAborted();
          if (task.paused) {
            this.set(task, { stage: 'paused', speed: 0, eta: undefined });
            await new Promise<void>(resolve => { task.resume = resolve; });
            task.resume = undefined;
            signal.throwIfAborted();
            baseline = performance.now();
            lastBytes = task.row.done;
            this.set(task, { stage });
          }
        };
        const showStage = (value: Stage) => { stage = value; if (!task.paused && !signal.aborted) this.set(task, { stage: value }); };
        const context: Context = {
          signal, checkpoint, stage: showStage, allowDuplicate: task.allowDuplicate,
          cleanup: (abort, retry) => { task.abortCleanup = abort; task.retryCleanup = retry; },
          progress: done => {
            if (signal.aborted) return;
            const elapsed = (performance.now() - baseline) / 1000;
            const speed = elapsed > 0.2 ? Math.max(0, (done - lastBytes) / elapsed) : task.row.speed;
            if (elapsed > 0.8) { baseline = performance.now(); lastBytes = done; }
            this.set(task, { done, speed, eta: speed > 0 ? Math.ceil((task.row.size - done) / speed) : undefined });
          },
          retrying: async (fn, current) => {
            for (let failures = 0; ; failures++) {
              await checkpoint();
              showStage(current);
              try { return await fn(); }
              catch (e) {
                if (!isRetryable(e) || failures >= 3 || signal.aborted) throw e;
                const requested = e instanceof RequestError ? e.retryAfter : undefined;
                const delay = requested ? requested * 1000 : 1000 * 2 ** failures;
                this.set(task, { stage: 'waiting', retryAt: Date.now() + delay, error: (e as Error).message, speed: 0 });
                await wait(delay, signal);
              }
            }
          }
        };
        try {
          await task.run(context);
          signal.throwIfAborted();
          this.set(task, { stage: 'done', done: task.row.size, speed: 0, eta: 0, error: undefined });
          task.run = async () => undefined;
          task.abortCleanup = undefined;
          task.retryCleanup = undefined;
        } catch (e) {
          const error = e instanceof Error ? e.message : 'TRANSFER_FAILED';
          if (signal.aborted) {
            await task.abortCleanup?.();
            task.retryCleanup = undefined;
            if (!this.disposed) this.set(task, { stage: 'cancelled', error: undefined, speed: 0 });
          } else {
            this.set(task, { stage: error === 'DUPLICATE' ? 'duplicate' : 'error', error, speed: 0 });
          }
        }
      }
    } finally { this.current = undefined; this.running = false; }
  }

  dispose() {
    this.disposed = true;
    for (const task of this.tasks.values()) { task.ctrl.abort(new Error('LOCKED')); task.resume?.(); }
    this.tasks.clear();
    this.emit();
  }
}
