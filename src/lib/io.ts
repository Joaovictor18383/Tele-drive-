export const fallbackLimit = 64 * 1024 * 1024;

export async function readLimited(stream: ReadableStream<Uint8Array<ArrayBuffer>>, max: number, type: string) {
  const reader = stream.getReader();
  const pieces: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return new Blob(pieces, { type });
      size += value.length;
      if (size > max) throw new Error('BROWSER_SAVE_LIMIT');
      pieces.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

type Picker = (options: { suggestedName: string }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array<ArrayBuffer>>> }>;
const picker = () => (window as typeof window & { showSaveFilePicker?: Picker }).showSaveFilePicker;
export type Destination = { save: (stream: ReadableStream<Uint8Array<ArrayBuffer>>, signal: AbortSignal) => Promise<void>; reusable: boolean };

export async function destination(name: string, size: number): Promise<Destination> {
  if (size > fallbackLimit) {
    const select = picker();
    if (select) {
      const handle = await select.call(window, { suggestedName: name });
      return { reusable: true, save: async (stream, signal) => {
        const writer = await handle.createWritable();
        await stream.pipeTo(writer, { signal });
      } };
    }
    if (navigator.serviceWorker?.controller) {
      return { reusable: true, save: (stream, signal) => streamToBrowser(stream, name, signal) };
    }
    throw new Error('BROWSER_SAVE_LIMIT');
  }
  return { reusable: true, save: async (stream, signal) => {
    const blob = await readLimited(stream, fallbackLimit, 'application/octet-stream');
    signal.throwIfAborted();
    saveBlob(blob, name);
  } };
}

async function streamToBrowser(stream: ReadableStream<Uint8Array<ArrayBuffer>>, name: string, signal: AbortSignal) {
  const controller = navigator.serviceWorker.controller;
  if (!controller) throw new Error('BROWSER_SAVE_LIMIT');
  signal.throwIfAborted();
  const { port1, port2 } = new MessageChannel();
  const id = crypto.randomUUID();
  const reader = stream.getReader();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve, reject) => {
    const end = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      port1.close();
      void reader.cancel(error).catch(() => undefined);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => { port1.postMessage({ error: true }); end(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => end(new Error('BROWSER_SAVE_LIMIT')), 15_000);
    port1.onmessage = async ({ data }) => {
      if (data.ready) {
        const link = document.createElement('a');
        link.href = '/__cloudvault-download/' + id;
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
      }
      if (data.cancel) { end(new Error('CANCELLED')); return; }
      if (!data.pull) return;
      clearTimeout(timer);
      try {
        const next = await reader.read();
        if (next.done) { port1.postMessage({ done: true }); end(); }
        else port1.postMessage({ block: next.value.buffer }, [next.value.buffer]);
      } catch (e) { port1.postMessage({ error: true }); end(e); }
    };
    controller.postMessage({ type: 'cloudvault-download', id, name }, [port2]);
  });
}
