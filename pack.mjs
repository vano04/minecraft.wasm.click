import { publicTcpTarget } from './public-target.mjs';

export const MAX_PACK_BYTES = 512 * 1024 * 1024;
export const PACK_CHUNK_BYTES = 32768;

export function packUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw Error('Invalid resource-pack URL');
  let url;
  try { url = new URL(value); } catch { throw Error('Invalid resource-pack URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !publicTcpTarget(url.hostname, 443)) throw Error('Resource packs require a public HTTPS URL');
  url.hash = '';
  return url;
}

export async function fetchPack(value, { fetchImpl = fetch, signal, followRedirects = true } = {}) {
  let url = packUrl(value);
  for (let redirects = 0; ; redirects++) {
    const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal,
      headers: { accept: 'application/zip,application/octet-stream,*/*', 'user-agent': 'Minecraft Java (minecraft.wasm.click)' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (!followRedirects || redirects >= 3 || !response.headers.get('location')) throw Error('Resource-pack redirect refused');
      url = packUrl(new URL(response.headers.get('location'), url).href);
      continue;
    }
    if (Number(response.headers.get('content-length')) > MAX_PACK_BYTES) {
      await response.body?.cancel();
      throw Error('Resource pack exceeds 512 MiB');
    }
    return response;
  }
}

// One download per authenticated socket, with at most eight chunks in flight.
export function servePack(socket, { fetchImpl = fetch, timeoutMs = 180000, maxBytes = MAX_PACK_BYTES } = {}) {
  const abort = new AbortController();
  let opened = false, closed = false, reading = false, reader, pending, received = 0, credits = 0;
  const send = value => {
    if (socket.bufferedAmount > 1024 * 1024) throw Error('Resource-pack receiver is too slow');
    socket.send(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    abort.abort();
    void reader?.cancel().catch(() => {});
    pending = null;
    try { socket.close(1000, 'Resource-pack stream closed'); } catch {}
  };
  const fail = message => {
    if (closed) return;
    try { send({ error: message }); } catch {}
    close();
  };
  const timer = setTimeout(() => fail('Resource-pack download timed out'), timeoutMs);
  socket.addEventListener('close', close);
  socket.addEventListener('error', close);
  socket.addEventListener('message', event => {
    if (closed) return;
    void (async () => {
      if (typeof event.data !== 'string' || event.data.length > 8192) throw Error('Invalid resource-pack request');
      let message;
      try { message = JSON.parse(event.data); } catch { throw Error('Invalid resource-pack request'); }
      if (!opened) {
        opened = true;
        if (typeof message.url !== 'string' || ![true, false, undefined].includes(message.followRedirects)) throw Error('Invalid resource-pack request');
        const response = await fetchPack(message.url, { fetchImpl, signal: abort.signal, followRedirects: message.followRedirects });
        if (closed) { await response.body?.cancel(); return; }
        reader = response.body?.getReader();
        // Fetch may decode the response, so do not forward its wire length.
        send({ status: response.status });
        if (!reader) { send({ eof: true }); close(); }
        return;
      }
      if (message.cancel === true) return close();
      const count = message.pull === true ? 1 : message.pull;
      if (!Number.isInteger(count) || count < 1 || count > 8 || credits + count > 8 || !reader) throw Error('Invalid resource-pack pull');
      credits += count;
      if (reading) return;
      reading = true;
      try {
        while (credits && !closed) {
          const chunk = new Uint8Array(PACK_CHUNK_BYTES);
          let length = 0, eof = false;
          while (length < chunk.length) {
            if (!pending?.byteLength) {
              const part = await reader.read();
              if (closed) return;
              if (part.done) { eof = true; break; }
              if (!(part.value instanceof Uint8Array) || part.value.byteLength > 1024 * 1024) throw Error('Resource-pack upstream chunk exceeds limit');
              received += part.value.byteLength;
              if (received > maxBytes) throw Error('Resource pack exceeds 512 MiB');
              pending = part.value;
            }
            const count = Math.min(chunk.length - length, pending.length);
            chunk.set(pending.subarray(0, count), length);
            length += count;
            pending = pending.subarray(count);
          }
          credits--;
          if (length) send(chunk.subarray(0, length));
          if (eof) { send({ eof: true }); close(); return; }
        }
      } finally { reading = false; }
    })().catch(error => fail(error.message));
  });
  return close;
}
