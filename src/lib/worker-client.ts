import type { Commands } from './worker';

export class CryptoWorker {
  private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private readonly requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private id = 0;
  private closed = false;

  constructor() {
    this.worker.onmessage = ({ data }) => {
      const request = this.requests.get(data.id);
      if (!request) return;
      this.requests.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = () => this.close(new Error('WORKER_FAILED'));
  }

  call<K extends keyof Commands>(method: K, ...args: Parameters<Commands[K]>): Promise<Awaited<ReturnType<Commands[K]>>> {
    if (this.closed) return Promise.reject(new Error('LOCKED'));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.requests.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.worker.postMessage({ id, method, args }, args.filter((v): v is ArrayBuffer => v instanceof ArrayBuffer));
      } catch (e) { this.requests.delete(id); reject(e); }
    });
  }

  close(error = new Error('LOCKED')) {
    this.closed = true;
    this.worker.terminate();
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
  }
}
