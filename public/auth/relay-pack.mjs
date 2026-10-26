const MAX_CHUNK = 32768;
const MAX_BYTES = 512 * 1024 * 1024;

// GPU worker: preserve direct downloads, then ask the selected player relay.
export function createRelayPackFetch({ fetchImpl = fetch, port = globalThis.mcWebLocalRelayPort,
  origin = globalThis.location?.origin, timeoutMs = 180000 } = {}) {
  if (!port && origin && typeof WebSocket === 'function') {
    const channel = new MessageChannel();
    const relay = createPackRelay({
      send: (value, transfer) => channel.port2.postMessage(value, transfer),
      openChannel() {
        const endpoint = new URL('/pack/', origin);
        endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
        return { channel: new WebSocket(endpoint) };
      },
    });
    channel.port2.addEventListener('message', event => relay.receive(event.data));
    channel.port2.start();
    port = channel.port1;
  }
  const requests = new Map();
  const send = (packId, type, extra = {}) => port.postMessage({ packId, type, ...extra });
  const finish = (request, error, cancel = false) => {
    if (!requests.delete(request.id)) return;
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
    if (cancel) send(request.id, 'pack-cancel');
    if (error) {
      request.reject(error);
      request.controller?.error(error);
    }
  };
  port?.addEventListener('message', ({ data }) => {
    const request = requests.get(data?.packId);
    if (!request) return;
    try {
      if (data.type === 'pack-meta') {
        if (request.controller || !Number.isInteger(data.status) || data.status < 200 || data.status > 599) throw Error('Invalid resource-pack response');
        if ([204, 205, 304].includes(data.status)) {
          request.resolve(new Response(null, { status: data.status }));
          finish(request, null, true);
          return;
        }
        const body = new ReadableStream({ type: 'bytes',
          start(controller) { request.controller = controller; },
          pull() { if (!request.pulling) { request.pulling = true; send(request.id, 'pack-pull'); } },
          cancel() { finish(request, null, true); },
        });
        request.resolve(new Response(body, { status: data.status,
          headers: { 'content-type': 'application/zip', 'content-encoding': 'identity' } }));
      } else if (data.type === 'pack-data') {
        const bytes = new Uint8Array(data.bytes);
        if (!request.pulling || !request.controller || !bytes.length || bytes.length > MAX_CHUNK) throw Error('Invalid resource-pack chunk');
        request.total += bytes.length;
        if (request.total > MAX_BYTES) throw Error('Resource pack exceeds 512 MiB');
        request.pulling = false;
        request.controller.enqueue(bytes);
      } else if (data.type === 'pack-end') {
        if (!request.controller) throw Error('Resource-pack response ended before its headers');
        const byob = request.controller.byobRequest;
        request.controller.close();
        byob?.respond(0);
        finish(request);
      } else if (data.type === 'pack-error') throw Error(data.error || 'Relay resource-pack download failed');
    } catch (error) { finish(request, error, true); }
  });
  port?.start();
  return async (input, options = {}) => {
    try { return await fetchImpl(input, options); }
    catch (error) {
      const url = new URL(input);
      if (!port || options.signal?.aborted || url.protocol !== 'https:' || url.origin === origin
          || url.username || url.password || url.port
          || ['textures.minecraft.net', 'mcweb-profile-verifier.invalid'].includes(url.hostname)) throw error;
      url.hash = '';
      if (requests.size >= 4) throw Error('Too many relay resource-pack downloads');
      return new Promise((resolve, reject) => {
        const request = { id: crypto.randomUUID(), resolve, reject, signal: options.signal, total: 0, pulling: false };
        request.abort = () => finish(request, options.signal.reason || new DOMException('Download cancelled', 'AbortError'), true);
        request.timer = setTimeout(() => finish(request, Error('Relay resource-pack download timed out'), true), timeoutMs);
        requests.set(request.id, request);
        options.signal?.addEventListener('abort', request.abort, { once: true });
        send(request.id, 'pack-open', { url: url.href, followRedirects: options.redirect !== 'error' });
        if (options.signal?.aborted) request.abort();
      });
    }
  };
}

// Launcher page: bridge only pack messages to a paired or self-hosted relay.
export function createPackRelay({ send, openChannel }) {
  const streams = new Map();
  const refill = entry => {
    const count = 8 - entry.queue.length - entry.credits;
    if (!entry.eof && count >= 4) {
      entry.credits += count;
      entry.channel.send(JSON.stringify({ pull: count }));
    }
  };
  const flush = (id, entry) => {
    if (entry.demand && entry.queue.length) {
      entry.demand = false;
      const bytes = entry.queue.shift();
      send({ packId: id, type: 'pack-data', bytes }, [bytes]);
    }
    if (entry.eof && !entry.queue.length) {
      send({ packId: id, type: 'pack-end' });
      close(id);
    } else refill(entry);
  };
  const close = (id, error) => {
    const entry = streams.get(id);
    if (!entry) return;
    streams.delete(id);
    clearTimeout(entry.timer);
    if (error) send({ packId: id, type: 'pack-error', error });
    try { entry.channel.close(); } catch {}
  };
  return {
    closeAll(reason = 'Relay disconnected') { for (const id of streams.keys()) close(id, reason); },
    receive(data) {
      const id = data.packId;
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return;
      if (data.type === 'pack-open') {
        if (streams.has(id) || streams.size >= 4 || typeof data.url !== 'string' || data.url.length > 4096) {
          send({ packId: id, type: 'pack-error', error: 'Invalid resource-pack request' }); return;
        }
        let opened;
        try { opened = openChannel(); }
        catch (error) { send({ packId: id, type: 'pack-error', error: error.message }); return; }
        const { channel, auth } = opened;
        const entry = { channel, metadata: false, demand: false, eof: false, credits: 0, queue: [] };
        streams.set(id, entry);
        entry.timer = setTimeout(() => close(id, 'Relay resource-pack download timed out'), 180000);
        channel.binaryType = 'arraybuffer';
        channel.onopen = () => {
          if (auth) channel.send(JSON.stringify(auth));
          channel.send(JSON.stringify({ url: data.url, followRedirects: data.followRedirects !== false }));
        };
        channel.onmessage = ({ data: value }) => {
          if (!streams.has(id)) return;
          try {
            if (typeof value === 'string') {
              if (value.length > 4096) throw Error('Invalid resource-pack response');
              const message = JSON.parse(value);
              if (message.error) throw Error(String(message.error).slice(0, 1000));
              if (Number.isInteger(message.status) && message.status >= 200 && message.status <= 599 && !entry.metadata) {
                entry.metadata = true;
                send({ packId: id, type: 'pack-meta', status: message.status });
                refill(entry);
              } else if (message.eof === true && entry.metadata) {
                entry.eof = true;
                flush(id, entry);
              } else throw Error('Invalid resource-pack response');
            } else {
              if (!entry.metadata || entry.credits < 1 || !(value instanceof ArrayBuffer) || !value.byteLength || value.byteLength > MAX_CHUNK) throw Error('Invalid resource-pack chunk');
              entry.credits--;
              entry.queue.push(value);
              flush(id, entry);
            }
          } catch (error) { close(id, error.message); }
        };
        channel.onclose = () => { if (!entry.eof) close(id, 'Relay resource-pack download interrupted. Update the relay if it does not support pack downloads.'); };
        channel.onerror = () => close(id, 'Relay resource-pack connection failed');
      } else if (data.type === 'pack-cancel') close(id);
      else if (data.type === 'pack-pull') {
        const entry = streams.get(id);
        if (!entry) return;
        if (!entry.metadata || entry.demand) { close(id, 'Invalid resource-pack pull'); return; }
        entry.demand = true;
        try { flush(id, entry); } catch { close(id, 'Relay resource-pack connection failed'); }
      }
    },
  };
}
