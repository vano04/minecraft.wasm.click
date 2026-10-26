import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
import { allowed } from './access.mjs';
import { publicTcpTarget } from './public-target.mjs';
import { openTcp } from './transport.mjs';
import { servePack } from './pack.mjs';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') {
      const ready = typeof env.RELAY_TOKEN === 'string' && env.RELAY_TOKEN.length >= 32 && env.RELAY_TOKEN.length <= 256;
      return Response.json({ status: ready ? 'ok' : 'missing-token', protocol: 'tcp' },
        { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } });
    }
    if (!['/tcp/', '/pack/'].includes(url.pathname) || request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
        || !allowed(request, env.RELAY_TOKEN, env.ALLOWED_ORIGINS)) return new Response('Relay unavailable', { status: 403 });
    if (url.pathname === '/tcp/' && !publicTcpTarget(url.searchParams.get('host'), url.searchParams.get('port'))) return new Response('Invalid target', { status: 403 });
    if (!env.RELAY_CONNECTIONS) return new Response('Relay unavailable', { status: 503 });
    const id = env.RELAY_CONNECTIONS.newUniqueId();
    const internal = new URL(request.url);
    internal.searchParams.delete('token');
    return env.RELAY_CONNECTIONS.get(id).fetch(new Request(internal, request));
  },
};

// An active TCP socket keeps this object awake. Incoming WebSocket messages
// renew its CPU budget; no account data or connection state is written to disk.
export class RelayConnection extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Relay unavailable', { status: 403 });
    if (url.pathname === '/pack/') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      servePack(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    const target = url.pathname === '/tcp/' && publicTcpTarget(url.searchParams.get('host'), url.searchParams.get('port'));
    if (!target) return new Response('Invalid target', { status: 403 });
    const control = { accept() {}, addEventListener() {}, close() {} };
    return openTcp(target, { relay: true }, control, connect);
  }
}
