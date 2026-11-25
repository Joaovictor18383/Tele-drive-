export class RequestError extends Error {
  constructor(public readonly status: number, code: string, public readonly retryAfter?: number) { super(code); }
}

let activeAccount: string | undefined;
export function setApiAccount(account?: string) { activeAccount = account; }

export async function api<T>(path: string, options: { method?: string; data?: unknown; signal?: AbortSignal; binary?: boolean } = {}) {
  const { method = 'GET', data, signal, binary } = options;
  const headers = new Headers();
  if (data !== undefined) headers.set('Content-Type', data instanceof ArrayBuffer ? 'application/octet-stream' : 'application/json');
  if (activeAccount && (/^\/(storage|telegram)\//.test(path) || path === '/auth/logout')) headers.set('X-CloudVault-Account', activeAccount);
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(45_000);
    response = await fetch('/api' + path, {
      method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, credentials: 'same-origin', cache: 'no-store',
      headers,
      body: data === undefined ? undefined : data instanceof ArrayBuffer ? data : JSON.stringify(data)
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new RequestError(0, (error as Error)?.name === 'TimeoutError' ? 'NETWORK_TIMEOUT' : 'NETWORK_OFFLINE');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new RequestError(response.status, body.code ?? 'INTERNAL_ERROR', body.retryAfter);
  }
  return (binary ? await response.arrayBuffer() : await response.json()) as T;
}

export function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
