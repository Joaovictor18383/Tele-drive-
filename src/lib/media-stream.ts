type ReadRange = (start: number, end: number, signal: AbortSignal) => ReadableStream<Uint8Array<ArrayBuffer>>;

export async function openMedia(type: string, size: number, source: ReadRange, signal: AbortSignal) {
  const controller = navigator.serviceWorker?.controller;
  if (!controller || size === 0) throw new Error('BROWSER_SAVE_LIMIT');
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const { port1, port2 } = new MessageChannel();
  const transfers = new Set<() => void>();
  const receive = (event: MessageEvent) => {
    const { data } = event;
    const port = event.ports[0];
    if (event.source !== controller || data?.type !== 'cloudvault-range' || data.id !== id || !port) return;
    const { start, end } = data;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size || signal.aborted) {
      port.postMessage({ error: true });
      port.close();
      return;
    }
    const cancel = new AbortController();
    const reader = source(start, end, cancel.signal).getReader();
    const finish = () => {
      transfers.delete(finish);
      cancel.abort();
      void reader.cancel().catch(() => undefined);
      port.close();
    };
    transfers.add(finish);
    port.onmessage = async ({ data: msg }) => {
      if (msg.cancel) { finish(); return; }
      if (!msg.pull) return;
      try {
        const next = await reader.read();
        if (next.done) { port.postMessage({ done: true }); finish(); }
        else port.postMessage({ block: next.value.buffer }, [next.value.buffer]);
      } catch { port.postMessage({ error: true }); finish(); }
    };
  };
  const close = () => {
    navigator.serviceWorker.removeEventListener('message', receive);
    signal.removeEventListener('abort', close);
    controller.postMessage({ type: 'cloudvault-media-close', id });
    for (const end of transfers) end();
    port1.close();
  };
  navigator.serviceWorker.addEventListener('message', receive);
  signal.addEventListener('abort', close, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', interrupt);
        port1.close();
      };
      const interrupt = () => { finish(); reject(signal.reason); };
      const timer = setTimeout(() => { finish(); reject(new Error('BROWSER_SAVE_LIMIT')); }, 5000);
      signal.addEventListener('abort', interrupt, { once: true });
      port1.onmessage = ({ data }) => { if (data.ready) { finish(); resolve(); } };
      controller.postMessage({ type: 'cloudvault-media', id, size, mime: type }, [port2]);
    });
    return { url: '/__cloudvault-media/' + id, close };
  } catch (error) { close(); throw error; }
}
