import { randomBytes } from 'node:crypto';
import { resolveSrv } from 'node:dns/promises';
import { isIP } from 'node:net';
import { WebSocketServer } from 'ws';
import { publicDial } from '../relay-service/server.mjs';
import { publicTcpTarget } from '../relay-service/public-target.mjs';
import { openTcp } from '../relay-service/transport.mjs';
import { servePack } from '../relay-service/pack.mjs';
import { nodePackFetch } from '../relay-service/pack-node.mjs';
import { DEFAULT_PUBLIC_KEYS_URL, ProfilePropertyVerifier } from '../runtime/tools/profile-property-verifier.mjs';
import { minecraftJoin } from './minecraft-join.mjs';
import { ownProfile, ownProfileDiagnostic } from './own-profile.mjs';

const paths = new Map([
  ['/mcweb/config.json', 'GET'], ['/mcweb/identity', 'GET'],
  ['/mcweb/auth/minecraft/profile', 'GET'], ['/mcweb/verify-profile-property', 'POST'],
  ['/mcweb/minecraft/join', 'POST'], ['/mcweb/tcp/', 'GET'], ['/pack/', 'GET'],
]);
const upgradePaths = new Set(['/mcweb/tcp/', '/pack/']);
function reply(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
  response.end(JSON.stringify(body));
}
function rejected(socket, status = 403) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
const bodyError = status => Object.assign(new Error('Invalid JSON request'), { status });
function readJson(request, maximum) {
  if (Number(request.headers['content-length']) > maximum) {
    request.resume();
    return Promise.reject(bodyError(413));
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => {
      request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', failed);
    };
    const failed = () => { cleanup(); reject(bodyError(400)); };
    const data = chunk => {
      size += chunk.length;
      if (size > maximum) { cleanup(); request.resume(); reject(bodyError(413)); }
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(bodyError(400)); }
    };
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', failed);
  });
}
async function limitedJson(response, maximum) {
  if (!response.body) throw Error('Upstream JSON unavailable');
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > maximum) throw Error('Upstream JSON limit exceeded');
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
async function resolveTarget(target, resolver) {
  if (target.port !== 25565 || isIP(target.hostname)) return target;
  let timer;
  try {
    const records = await Promise.race([
      resolver('_minecraft._tcp.' + target.hostname),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('SRV timeout')), 3000); timer.unref(); }),
    ]);
    const first = records.filter(record => Number.isInteger(record.priority)
      && publicTcpTarget(record.name, record.port)).sort((a, b) => a.priority - b.priority)[0];
    return first ? publicTcpTarget(first.name, first.port) : target;
  } catch { return target; }
  finally { clearTimeout(timer); }
}

export function createGateway({ auth, origin, fetchImpl = fetch, dial = publicDial,
  verifier, maxConnections = 64, resolveSrvImpl = resolveSrv, packFetch = nodePackFetch } = {}) {
  const expectedOrigin = new URL(origin).origin;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 1024) throw Error('Invalid connection limit');
  const profiles = verifier || new ProfilePropertyVerifier({ fetchImpl: async url => {
    if (url !== DEFAULT_PUBLIC_KEYS_URL) throw Error('Invalid signing-key endpoint');
    const response = await fetchImpl(url, { headers: { accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!response.ok) { await response.body?.cancel(); throw Error('Signing keys unavailable'); }
    return Response.json(await limitedJson(response, 128 * 1024));
  } });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 65541, perMessageDeflate: false });
  const connections = new Map(), socketSessions = new Map();
  let pending = 0, closed = false;
  const config = {
    version: 1,
    auth: { mode: 'online', required: true, online: true, serverProxy: true, interactive: false,
      sessionPath: '/mcweb/auth/session', loginPath: '/mcweb/auth/import', skinPath: '/mcweb/auth/minecraft/skin' },
    gateway: { transport: 'tcp', socketPath: '/mcweb/tcp/',
      identityPath: '/mcweb/identity', httpPathPrefix: '/mcweb',
      profileVerificationPath: '/mcweb/verify-profile-property', packProxyPath: '/pack/',
      allowAnyTarget: true, allowedTargets: ['*'] },
  };
  const unchanged = (request, credential) => auth.credentials(request) === credential;
  async function handleHttp(request, response) {
    const url = new URL(request.url, expectedOrigin), method = paths.get(url.pathname);
    if (!method) return false;
    if (request.method !== method) { reply(response, 405, { error: 'Method not allowed' }, { allow: method }); return true; }
    const credential = auth.credentials(request);
    if (!credential) { reply(response, 401, { authenticated: false }); return true; }
    if (method === 'POST' && (request.headers.origin !== expectedOrigin
      || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''))) {
      reply(response, 403, { error: 'Request rejected' }); return true;
    }
    if (upgradePaths.has(url.pathname)) { reply(response, 426, { error: 'WebSocket upgrade required' }); return true; }
    if (url.pathname === '/mcweb/config.json') reply(response, 200, config);
    else if (url.pathname === '/mcweb/identity') reply(response, 200, { available: true, id: credential.id, name: credential.name });
    else if (url.pathname === '/mcweb/auth/minecraft/profile') {
      if (url.search) { reply(response, 400, { error: 'Invalid profile request' }); return true; }
      try {
        const profile = await ownProfile(credential, profiles, fetchImpl);
        if (!unchanged(request, credential)) reply(response, 401, { error: 'Session expired' });
        else reply(response, 200, profile);
      } catch (error) { reply(response, 502, { error: 'Signed player profile unavailable', ...ownProfileDiagnostic(error) }); }
    } else if (url.pathname === '/mcweb/verify-profile-property') {
      try {
        const property = await readJson(request, 1024 * 1024);
        if (typeof property?.value !== 'string' || property.value.length > 65536
          || typeof property?.signature !== 'string' || property.signature.length > 8192) throw bodyError(400);
        const valid = await profiles.verify(property.value, property.signature);
        if (!unchanged(request, credential)) reply(response, 401, { valid: false });
        else reply(response, 200, { valid });
      } catch (error) { reply(response, error.status === 413 ? 413 : 400, { valid: false }); }
    } else if (url.pathname === '/mcweb/minecraft/join') {
      let challenge;
      try { challenge = await readJson(request, 4096); }
      catch (error) { reply(response, error.status === 413 ? 413 : 400, { error: 'Invalid Minecraft challenge' }); return true; }
      const state = connections.get(challenge?.connectionId);
      if (!unchanged(request, credential)) { reply(response, 401, { error: 'Session expired' }); return true; }
      if (!state || state.session !== auth.sessionId(request) || state.credential !== credential
        || state.joined || state.socket.readyState !== 1 || !state.connected) {
        reply(response, 409, { error: 'Minecraft connection is unavailable' }); return true;
      }
      state.joined = true;
      try {
        const material = await minecraftJoin(challenge, credential, fetchImpl);
        if (!unchanged(request, credential) || state.socket.readyState !== 1) reply(response, 401, { error: 'Minecraft session changed' });
        else reply(response, 200, material);
      } catch (error) {
        const code = /^minecraft-join-(challenge|key|provider|encryption)$/.test(error.code) ? error.code : 'minecraft-join-unavailable';
        reply(response, 502, { error: 'Minecraft session join failed', code,
          ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}) });
      }
    }
    return true;
  }
  async function upgrade(request, socket, head) {
    const url = new URL(request.url, expectedOrigin);
    if (!upgradePaths.has(url.pathname)) return rejected(socket, 404);
    if (closed || request.method !== 'GET' || request.headers.origin !== expectedOrigin) return rejected(socket);
    const credential = auth.credentials(request), session = auth.sessionId(request);
    if (!credential || !session) return rejected(socket, 401);
    if (sockets.clients.size + pending >= maxConnections
      || [...socketSessions.values()].filter(value => value === session).length >= 12) return rejected(socket, 429);
    let target;
    if (url.pathname !== '/pack/') {
      target = publicTcpTarget(url.searchParams.get('host'), url.searchParams.get('port'));
      if (!target) return rejected(socket);
    }
    pending++;
    try {
      if (target) target = await resolveTarget(target, resolveSrvImpl);
      if (closed || socket.destroyed || !unchanged(request, credential)) return rejected(socket, 401);
      if (sockets.clients.size >= maxConnections
        || [...socketSessions.values()].filter(value => value === session).length >= 12) return rejected(socket, 429);
      sockets.handleUpgrade(request, socket, head, ws => {
        try {
          socketSessions.set(ws, session);
          ws.once('close', () => socketSessions.delete(ws));
          if (!unchanged(request, credential) || auth.trackSocket(request, ws) === false) return ws.close(4401, 'Session expired');
          ws.accept = () => {};
          if (url.pathname === '/pack/') { servePack(ws, { fetchImpl: packFetch }); return; }
          const id = randomBytes(24).toString('hex');
          const state = { id, socket: ws, session, credential, target, joined: false, connected: false };
          connections.set(id, state); ws.once('close', () => connections.delete(id));
          const metadata = { connectionId: id, profile: { id: credential.id, name: credential.name }, target };
          const connect = selected => {
            const pendingSocket = Promise.resolve().then(() => dial(selected));
            let reader;
            const opened = pendingSocket.then(async value => { await value.opened; state.connected = true; });
            opened.catch(() => {});
            return { opened, closed: pendingSocket.then(value => value.closed),
              readable: new ReadableStream({ async pull(controller) {
                try {
                  reader ||= (await pendingSocket).readable.getReader();
                  const next = await reader.read(); if (next.done) controller.close(); else controller.enqueue(next.value);
                } catch (error) { controller.error(error); }
              }, async cancel() { if (reader) await reader.cancel(); } }, { highWaterMark: 0 }),
              writable: new WritableStream({ async write(bytes) {
                const value = await pendingSocket, writer = value.writable.getWriter();
                try { await writer.write(bytes); } finally { writer.releaseLock(); }
              } }), close: async () => { const value = await pendingSocket; await value.close(); } };
          };
          openTcp(target, metadata, ws, connect, { pair: () => [null, ws], response: () => undefined });
        } catch { ws.close(1011, 'Minecraft gateway unavailable'); }
      });
    } finally { pending--; }
  }
  return { config, handleHttp,
    handleUpgrade(request, socket, head) { void upgrade(request, socket, head).catch(() => rejected(socket)); },
    close() { closed = true; for (const ws of sockets.clients) ws.terminate(); connections.clear(); sockets.close(); },
  };
}
