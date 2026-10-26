import { publicTcpTarget } from './public-target.mjs';

const WINDOW_BYTES = 1024 * 1024, MAX_FRAME = 65536;

// One WebSocket carries one TCP connection. Binary messages contain only TCP
// bytes; JSON messages open the target and acknowledge bounded byte windows.
export function openTcp(target, metadata, control, connect, adapter = {}) {
  const [client, server] = adapter.pair ? adapter.pair() : Object.values(new WebSocketPair());
  server.binaryType = 'arraybuffer';
  server.accept(); control.accept();
  let socket, writer, closed = false, queued = 0, outstanding = 0, resume;
  let writes = Promise.resolve();
  const shutdown = (code = 1000, reason = 'Connection closed') => {
    if (closed) return;
    closed = true; clearTimeout(startup);
    let boundedReason = String(reason);
    while (new TextEncoder().encode(boundedReason).length > 123) boundedReason = boundedReason.slice(0, -1);
    try { server.close(code, boundedReason); } catch {}
    try { control.close(1000, 'Connection closed'); } catch {}
    resume?.(); resume = null;
    if (socket) void socket.close().catch(() => {});
  };
  const send = data => {
    if (closed) return;
    if (server.bufferedAmount > WINDOW_BYTES * 4) throw Error('Minecraft receiver is too slow');
    server.send(data);
  };
  const json = value => send(JSON.stringify(value));
  control.addEventListener('close', event => shutdown(event.code === 4401 ? 4401 : 1011,
    event.code === 4401 ? 'Signed out or session expired; sign in again' : 'Authentication connection closed'));
  control.addEventListener('error', () => shutdown(1011, 'Authentication connection failed'));
  const startup = setTimeout(() => shutdown(1008, 'Minecraft connection timed out'), 15000);
  server.addEventListener('close', () => shutdown());
  server.addEventListener('error', () => shutdown(1011, 'TCP relay transport failed'));
  server.addEventListener('message', event => {
    try {
      if (typeof event.data === 'string') {
        if (event.data.length > 1024) throw Error('Invalid relay control message');
        const message = JSON.parse(event.data);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('Invalid relay control message');
        if (Object.hasOwn(message, 'connect')) {
          if (socket) throw Error('Only one Minecraft TCP connection is permitted');
          const requested = publicTcpTarget(message.connect?.host, message.connect?.port);
          if (!requested || requested.hostname !== target.hostname || requested.port !== target.port) throw Error('Minecraft target mismatch');
          socket = connect({ hostname: target.hostname, port: target.port });
          writer = socket.writable.getWriter();
          void socket.closed.catch(() => shutdown(1011, 'Minecraft TCP connection failed'));
          writes = socket.opened.then(() => { clearTimeout(startup); json({ connected: true }); })
            .catch(() => shutdown(1011, 'Minecraft server could not be reached'));
          void (async () => {
            try {
              await socket.opened;
              const reader = socket.readable.getReader();
              try {
                for (;;) {
                  const { value, done } = await reader.read();
                  if (done || closed) break;
                  for (let at = 0; at < value.length;) {
                    while (outstanding >= WINDOW_BYTES && !closed) await new Promise(resolve => { resume = resolve; });
                    if (closed) break;
                    const count = Math.min(MAX_FRAME, value.length - at, WINDOW_BYTES - outstanding);
                    const part = value.subarray(at, at + count); at += count;
                    outstanding += count; send(part);
                  }
                }
                if (!closed) shutdown();
              } finally { reader.releaseLock(); }
            } catch { shutdown(1011, 'Minecraft TCP connection failed'); }
          })();
        } else {
          const received = message.received;
          if (!Number.isInteger(received) || received < 1 || received > outstanding) throw Error('Invalid receive acknowledgement');
          outstanding -= received;
          if (outstanding < WINDOW_BYTES) { resume?.(); resume = null; }
        }
        return;
      }
      if (!socket || typeof event.data?.byteLength !== 'number' || event.data.byteLength < 1 || event.data.byteLength > MAX_FRAME) throw Error('Invalid TCP relay message');
      const payload = new Uint8Array(event.data).slice();
      queued += payload.length;
      if (queued > WINDOW_BYTES) throw Error('Minecraft send buffer exceeded');
      writes = writes.then(async () => {
        if (closed) return;
        await writer.write(payload); queued -= payload.length;
        json({ written: payload.length });
      }).catch(() => shutdown(1011, 'Minecraft write failed'));
    } catch (error) { shutdown(1008, error.message); }
  });
  if (metadata?.profile) json({ minecraft: metadata });
  json({ relay: { version: 1, windowBytes: WINDOW_BYTES } });
  return adapter.response ? adapter.response() : new Response(null, { status: 101, webSocket: client });
}
