import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { allowed } from './access.mjs';
import { publicTcpTarget } from './public-target.mjs';
import { openTcp } from './transport.mjs';
import { publicDial } from './tcp.mjs';
export { publicDial } from './tcp.mjs';
import { servePack } from './pack.mjs';
import { nodePackFetch } from './pack-node.mjs';
export function createRelay({ token, origins = 'https://minecraft.wasm.click', dial = publicDial, packFetch = nodePackFetch, maxConnections = 64 } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw Error('Set RELAY_TOKEN to at least 32 random characters');
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/healthz' ? 200 : 404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); response.end(request.url === '/healthz' ? 'ok' : 'Not found');
  });
  server.headersTimeout = 10000; server.requestTimeout = 10000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    let url, target;
    try {
      url = new URL(request.url, 'https://relay.invalid'); target = publicTcpTarget(url.searchParams.get('host'), url.searchParams.get('port'));
      if (!['/tcp/', '/pack/'].includes(url.pathname) || (url.pathname === '/tcp/' && !target) || sockets.clients.size >= maxConnections
          || !allowed(new Request(url, { headers: { Origin: request.headers.origin || '' } }), token, origins)) throw Error('Rejected');
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, ws => {
      ws.accept = () => {};
      if (url.pathname === '/pack/') { servePack(ws, { fetchImpl: packFetch }); return; }
      const control = { accept() {}, addEventListener() {}, close() {} };
      // Cloudflare's connect() returns stream handles synchronously. Hold the
      // write and read endpoints until Node DNS validation and connect finish.
      const connect = target => {
        const pending = dial(target); let reader;
        return { opened: pending.then(value => value.opened), closed: pending.then(value => value.closed),
          readable: new ReadableStream({ async pull(controller) {
            try { reader ||= (await pending).readable.getReader(); const value = await reader.read();
              if (value.done) controller.close(); else controller.enqueue(value.value);
            } catch (error) { controller.error(error); }
          }, async cancel() { if (reader) await reader.cancel(); } }, { highWaterMark: 0 }),
          writable: new WritableStream({ async write(bytes) { const value = await pending; const writer = value.writable.getWriter(); try { await writer.write(bytes); } finally { writer.releaseLock(); } } }),
          close: async () => { const value = await pending; await value.close(); } };
      };
      openTcp(target, { relay: true }, control, connect, { pair: () => [null, ws], response: () => undefined });
    });
  });
  server.on('close', () => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createRelay({ token: process.env.RELAY_TOKEN, origins: process.env.ALLOWED_ORIGINS,
    maxConnections: Number(process.env.MAX_CONNECTIONS) || 64 });
  server.listen(Number(process.env.PORT) || 8080, process.env.HOST || '127.0.0.1', () => console.log('minecraft.wasm.click relay listening; credentials and targets are not logged.'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
