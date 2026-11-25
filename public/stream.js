/* The service worker forwards plaintext chunks in memory to the browser's download manager. */
const pendingDownloads = new Map();
const previews = new Map();

self.addEventListener('message', event => {
  const data = event.data;
  const owner = event.source;
  if (!/^[0-9a-f-]{36}$/.test(data?.id) || !owner?.url?.startsWith(self.location.origin + '/')) return;
  if (data.type === 'cloudvault-media-close' && previews.get(data.id)?.owner === owner.id) {
    previews.delete(data.id);
    return;
  }
  const port = event.ports[0];
  if (data.type !== 'cloudvault-media' || !port || !Number.isSafeInteger(data.size) || data.size < 1 ||
      !/^(audio|video)\/[a-z0-9.+-]+$/.test(data.mime)) return;
  if (previews.size >= 60) previews.delete(previews.keys().next().value);
  previews.set(data.id, { owner: owner.id, size: data.size, mime: data.mime });
  port.postMessage({ ready: true });
  port.close();
});

self.addEventListener('message', event => {
  const data = event.data;
  const port = event.ports[0];
  if (data?.type !== 'cloudvault-download' || !port ||
      !/^[0-9a-f-]{36}$/.test(data.id) || typeof data.name !== 'string' ||
      !event.source?.url?.startsWith(self.location.origin + '/')) return;
  const timer = setTimeout(() => {
    pendingDownloads.delete(data.id);
    port.close();
  }, 20_000);
  pendingDownloads.set(data.id, { name: data.name, port, timer });
  port.postMessage({ ready: true });
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const prefix = '/__cloudvault-download/';
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
  const id = url.pathname.slice(prefix.length);
  const item = pendingDownloads.get(id);
  if (!item) { event.respondWith(new Response(null, { status: 404 })); return; }
  pendingDownloads.delete(id);
  clearTimeout(item.timer);
  const filename = encodeURIComponent(item.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
  event.respondWith(new Response(readFromPort(item.port), {
    headers: {
      'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + filename,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    }
  }));
});

function readFromPort(port) {
  let unblock;
  return new ReadableStream({
    start(controller) {
      port.onmessage = ({ data }) => {
        if (data.error) controller.error(new Error('Interrupted'));
        else if (data.done) controller.close();
        else if (data.block) controller.enqueue(new Uint8Array(data.block));
        unblock?.();
        if (data.done || data.error) port.close();
      };
    },
    pull() {
      port.postMessage({ pull: true });
      return new Promise(resolve => { unblock = resolve; });
    },
    cancel() {
      port.postMessage({ cancel: true });
      port.close();
      unblock?.();
    }
  }, { highWaterMark: 0 });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const prefix = '/__cloudvault-media/';
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
  const id = url.pathname.slice(prefix.length);
  event.respondWith((async () => {
    const item = previews.get(id);
    if (!item || item.owner !== event.clientId || !['GET', 'HEAD'].includes(event.request.method)) return new Response(null, { status: 404 });
    const client = await self.clients.get(item.owner);
    if (!client) { previews.delete(id); return new Response(null, { status: 404 }); }
    const range = event.request.headers.get('Range');
    let start = 0;
    let end = item.size - 1;
    const headers = {
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Type': item.mime, 'X-Content-Type-Options': 'nosniff'
    };
    if (range) {
      const match = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + item.size } });
      if (match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      } else start = Math.max(0, item.size - Number(match[2]));
      if (start > end) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + item.size } });
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + item.size;
    }
    headers['Content-Length'] = String(end - start + 1);
    if (event.request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
    const { port1, port2 } = new MessageChannel();
    client.postMessage({ type: 'cloudvault-range', id, start, end }, [port2]);
    return new Response(readFromPort(port1), { status: range ? 206 : 200, headers });
  })());
});
