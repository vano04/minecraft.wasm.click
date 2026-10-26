import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import WebSocket from 'ws';
import { createGateway } from './gateway.mjs';

const profile = { id: '0123456789abcdef0123456789abcdef', name: 'VerifiedPlayer' };
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const challenge = id => ({ connectionId: id, serverId: '',
  publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), verifyToken: 'AQIDBA==' });
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

async function fixture(options = {}) {
  const sessions = new Map(['a', 'b'].map(id => [id, Object.freeze({ token: 'private-token-' + id,
    ...profile, expiresAt: Date.now() + 60000 })]));
  const bound = new Map();
  const auth = {
    sessionId(request) { return /^mcweb_session=([ab])$/.exec(request.headers.cookie || '')?.[1] || null; },
    credentials(request) { return sessions.get(this.sessionId(request)) || null; },
    session(request) { const value = this.credentials(request); return value ? { authenticated: true, profile } : null; },
    trackSocket(request, ws) { bound.set(ws, this.sessionId(request)); ws.once('close', () => bound.delete(ws)); },
    revoke(id) { sessions.delete(id); for (const [ws, session] of bound) if (session === id) ws.close(4401, 'Session expired'); },
  };
  let gateway;
  const server = createServer((req, res) => {
    void gateway.handleHttp(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { res.writeHead(500); res.end(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  gateway = createGateway({ auth, origin, resolveSrvImpl: async () => [], dial: async () => {
    let input, finish;
    return { opened: Promise.resolve(), closed: new Promise(resolve => { finish = resolve; }),
      readable: new ReadableStream({ start(controller) { input = controller; } }),
      writable: new WritableStream({ write() {} }),
      close: async () => { try { input.close(); } catch {} finish(); },
    };
  }, ...options });
  server.on('upgrade', gateway.handleUpgrade);
  const clients = [];
  async function connect(path = '/mcweb/tcp/?host=8.8.8.8&port=25565', { session = 'a', requestOrigin = origin } = {}) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + path, { headers: {
      ...(session ? { cookie: 'mcweb_session=' + session } : {}), origin: requestOrigin,
    } });
    clients.push(ws); ws.inbox = []; ws.on('message', (bytes, binary) => ws.inbox.push({ bytes, binary }));
    ws.on('error', () => {});
    const result = await Promise.race([
      once(ws, 'open').then(() => ({ ws })),
      once(ws, 'unexpected-response').then(([, response]) => { response.resume(); return { ws, status: response.statusCode }; }),
    ]);
    return result;
  }
  async function request(path, { session = 'a', method = 'GET', body, headers = {} } = {}) {
    return fetch(origin + path, { method, headers: {
      ...(session ? { cookie: 'mcweb_session=' + session } : {}),
      ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...headers,
    }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  }
  async function close() {
    for (const ws of clients) ws.terminate();
    gateway.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  return { origin, auth, gateway, connect, request, close };
}
async function message(ws, predicate) {
  const end = Date.now() + 3000;
  for (;;) {
    const index = ws.inbox.findIndex(predicate);
    if (index >= 0) return ws.inbox.splice(index, 1)[0];
    if (Date.now() > end) throw Error('Expected WebSocket message did not arrive');
    await pause();
  }
}
const text = value => !value.binary && JSON.parse(value.bytes.toString());
async function connectedStream(f, session = 'a') {
  const { ws } = await f.connect('/mcweb/tcp/?host=8.8.8.8&port=25565', { session });
  const metadata = JSON.parse((await message(ws, value => Boolean(text(value)?.minecraft))).bytes.toString()).minecraft;
  const hello = await message(ws, value => Boolean(text(value)?.relay));
  assert.equal(text(hello).relay.windowBytes, 1048576);
  ws.send(JSON.stringify({ connect: { host: metadata.target.hostname, port: metadata.target.port } }));
  await message(ws, value => Boolean(text(value)?.connected));
  return { ws, metadata };
}

test('gateway requires a browser session and exact origin before accepting public TCP or pack sockets', { timeout: 10000 }, async () => {
  let dialled = 0;
  const f = await fixture({ dial: async () => { dialled++; throw Error('must not dial'); } });
  try {
    assert.equal((await f.request('/mcweb/config.json', { session: null })).status, 401);
    assert.equal((await f.connect(undefined, { session: null })).status, 401);
    assert.equal((await f.connect(undefined, { requestOrigin: 'https://evil.example' })).status, 403);
    assert.equal((await f.connect('/mcweb/tcp/?host=127.0.0.1&port=25565')).status, 403);
    assert.equal((await f.connect('/pack/', { session: null })).status, 401);
    assert.equal((await f.connect('/pack/', { requestOrigin: 'https://evil.example' })).status, 403);
    assert.equal((await f.connect('/mcweb/local/control?host=8.8.8.8&port=25565')).status, 404);
    assert.equal((await f.request('/mcweb/local/control')).status, 404);
    assert.equal((await f.request('/mcweb/identity', { method: 'HEAD' })).status, 405);
    const response = await f.request('/mcweb/config.json'), config = await response.json();
    assert.equal(config.gateway.transport, 'tcp'); assert.equal(config.auth.interactive, false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await (await f.request('/mcweb/identity')).json(), { available: true, ...profile });
    assert.equal(JSON.stringify(config).includes('private-token'), false);
    assert.equal(dialled, 0);
  } finally { await f.close(); }
});

test('direct TCP forwards exact bytes with authenticated metadata and closes its TCP stream on logout', { timeout: 10000 }, async () => {
  const written = []; let input, stopped = false;
  const f = await fixture({ fetchImpl: async url => {
    assert.equal(url, 'https://sessionserver.mojang.com/session/minecraft/join');
    return new Response(null, { status: 204 });
  }, dial: async target => {
    assert.deepEqual(target, { hostname: '8.8.8.8', port: 25565 });
    return { opened: Promise.resolve(), closed: new Promise(() => {}),
      readable: new ReadableStream({ start(controller) { input = controller; } }),
      writable: new WritableStream({ write(bytes) { written.push(Buffer.from(bytes)); } }),
      close: async () => { stopped = true; try { input.close(); } catch {} },
    };
  } });
  try {
    const { ws } = await f.connect();
    const metadata = JSON.parse((await message(ws, value => Boolean(text(value)?.minecraft))).bytes.toString()).minecraft;
    assert.deepEqual(metadata.profile, profile);
    assert.deepEqual(metadata.target, { hostname: '8.8.8.8', port: 25565 });
    assert.equal(JSON.stringify(metadata).includes('private-token'), false);
    assert.equal((await f.request('/mcweb/minecraft/join', { method: 'POST', body: challenge(metadata.connectionId) })).status, 409);
    const hello = await message(ws, value => Boolean(text(value)?.relay));
    assert.equal(text(hello).relay.windowBytes, 1048576);
    ws.send(JSON.stringify({ connect: { host: '8.8.8.8', port: 25565 } }));
    await message(ws, value => Boolean(text(value)?.connected));
    assert.equal((await f.request('/mcweb/minecraft/join', { method: 'POST', body: challenge(metadata.connectionId) })).status, 200);
    input.enqueue(Uint8Array.from([7, 8, 9]));
    assert.deepEqual((await message(ws, value => value.binary)).bytes, Buffer.from([7, 8, 9]));
    ws.send(JSON.stringify({ received: 3 })); ws.send(Buffer.from([1, 2, 3]));
    await message(ws, value => Boolean(text(value)?.written));
    assert.deepEqual(Buffer.concat(written), Buffer.from([1, 2, 3]));
    const closed = once(ws, 'close'); f.auth.revoke('a'); assert.equal((await closed)[0], 4401);
    for (let at = 0; !stopped && at < 50; at++) await pause();
    assert.equal(stopped, true);
  } finally { await f.close(); }
});

test('Minecraft joins require a live same-session connection and run once without disclosing credentials', { timeout: 10000 }, async () => {
  let joins = 0;
  const f = await fixture({ fetchImpl: async (url, options) => {
    assert.equal(url, 'https://sessionserver.mojang.com/session/minecraft/join');
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(JSON.parse(options.body).accessToken, 'private-token-a');
    joins++; return new Response(null, { status: 204 });
  } });
  try {
    const { ws, metadata } = await connectedStream(f), body = challenge(metadata.connectionId);
    assert.equal((await f.request('/mcweb/minecraft/join', { session: 'b', method: 'POST', body })).status, 409);
    assert.equal((await f.request('/mcweb/minecraft/join', { method: 'POST', body, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await f.request('/mcweb/minecraft/join', { method: 'POST', body: 'x'.repeat(4097) })).status, 413);
    assert.equal((await f.request('/mcweb/minecraft/join', { method: 'POST', body: '{' })).status, 400);
    const response = await f.request('/mcweb/minecraft/join', { method: 'POST', body }), material = await response.json();
    assert.equal(response.status, 200); assert.equal(Buffer.from(material.secret, 'base64').length, 16);
    assert.ok(Buffer.from(material.response, 'base64').length > 256);
    assert.equal(JSON.stringify(material).includes('private-token'), false);
    assert.equal((await f.request('/mcweb/minecraft/join', { method: 'POST', body })).status, 409);
    assert.equal(joins, 1);
    const other = await connectedStream(f), gone = once(other.ws, 'close'); other.ws.close(); await gone;
    assert.equal((await f.request('/mcweb/minecraft/join', { method: 'POST', body: challenge(other.metadata.connectionId) })).status, 409);
    ws.close();
  } finally { await f.close(); }
});

test('logout during an upstream Minecraft join discards the returned game material', { timeout: 10000 }, async () => {
  let started, release;
  const joining = new Promise(resolve => { started = resolve; });
  const upstream = new Promise(resolve => { release = resolve; });
  const f = await fixture({ fetchImpl: async () => { started(); await upstream; return new Response(null, { status: 204 }); } });
  try {
    const { metadata } = await connectedStream(f);
    const response = f.request('/mcweb/minecraft/join', { method: 'POST', body: challenge(metadata.connectionId) });
    await joining; f.auth.revoke('a'); release();
    const result = await response; assert.equal(result.status, 401);
    assert.equal((await result.text()).includes('secret'), false);
  } finally { release(); await f.close(); }
});

test('signed own-profile and property verification use the fixed public-key endpoint and redact extra fields', { timeout: 10000 }, async () => {
  const value = Buffer.from(JSON.stringify({ profileId: profile.id, profileName: profile.name,
    textures: { SKIN: { url: 'http://textures.minecraft.net/texture/' + 'a'.repeat(64) } } })).toString('base64');
  const property = { name: 'textures', value, signature: sign('RSA-SHA1', Buffer.from(value), key.privateKey).toString('base64') };
  let mismatch = false;
  const f = await fixture({ fetchImpl: async (url, options) => {
    assert.equal(new Headers(options.headers).has('authorization'), false);
    assert.equal(options.redirect, 'manual');
    if (url === 'https://api.minecraftservices.com/publickeys') return Response.json({ profilePropertyKeys: [
      { publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }) },
    ] });
    assert.equal(url, 'https://sessionserver.mojang.com/session/minecraft/profile/' + profile.id + '?unsigned=false');
    return Response.json({ ...profile, ...(mismatch ? { name: 'OtherPlayer' } : {}), properties: [property], secret: 'strip-me' });
  } });
  try {
    assert.deepEqual(await (await f.request('/mcweb/auth/minecraft/profile')).json(), { ...profile, properties: [property] });
    assert.deepEqual(await (await f.request('/mcweb/verify-profile-property', { method: 'POST', body: property })).json(), { valid: true });
    assert.deepEqual(await (await f.request('/mcweb/verify-profile-property', { method: 'POST', body: { ...property, value: value + 'a' } })).json(), { valid: false });
    assert.equal((await f.request('/mcweb/auth/minecraft/profile?id=' + 'f'.repeat(32))).status, 400);
    mismatch = true;
    const bad = await f.request('/mcweb/auth/minecraft/profile'); assert.equal(bad.status, 502);
    assert.deepEqual(await bad.json(), { error: 'Signed player profile unavailable', code: 'profile-identity-mismatch' });
  } finally { await f.close(); }
});

test('authenticated pack sockets stream only the requested public pack and stop on logout', { timeout: 10000 }, async () => {
  let downloads = 0;
  const f = await fixture({ packFetch: async (url, options) => {
    assert.equal(url, 'https://packs.example/pack.zip');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    downloads++; return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
  } });
  try {
    const { ws } = await f.connect('/pack/');
    ws.send(JSON.stringify({ url: 'https://packs.example/pack.zip' }));
    assert.equal(text(await message(ws, value => text(value)?.status === 200)).status, 200);
    ws.send(JSON.stringify({ pull: 1 }));
    assert.deepEqual((await message(ws, value => value.binary)).bytes, Buffer.from([1, 2, 3]));
    assert.equal(downloads, 1);
    const other = await f.connect('/pack/'), closed = once(other.ws, 'close');
    f.auth.revoke('a'); assert.equal((await closed)[0], 4401);
  } finally { await f.close(); }
});

test('pending DNS resolution reserves capacity and rechecks the session before upgrading', { timeout: 10000 }, async () => {
  let entered, release;
  const resolving = new Promise(resolve => { entered = resolve; });
  const answer = new Promise(resolve => { release = resolve; });
  const f = await fixture({ maxConnections: 1, resolveSrvImpl: async name => {
    assert.equal(name, '_minecraft._tcp.game.example'); entered(); return answer;
  } });
  try {
    const first = f.connect('/mcweb/tcp/?host=game.example&port=25565');
    await resolving;
    assert.equal((await f.connect('/pack/', { session: 'b' })).status, 429);
    f.auth.revoke('a'); release([]);
    assert.equal((await first).status, 401);
    const replacement = await f.connect('/pack/', { session: 'b' });
    assert.equal(replacement.status, undefined);
  } finally { release([]); await f.close(); }
});
