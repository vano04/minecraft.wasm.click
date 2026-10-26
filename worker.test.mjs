import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
const origin = 'https://minecraft.wasm.click', token = 'test-only-owner-token-'.repeat(3);

async function workerFixture({ port, pack = false } = {}) {
  let entry = await readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
  if (port) entry = entry.replace("import { connect } from 'cloudflare:sockets';",
    "import {connect as rawConnect} from 'cloudflare:sockets'; const connect=()=>rawConnect({hostname:'127.0.0.1',port:" + port + "});");
  if (pack) entry = entry.replace('servePack(server);', `servePack(server, { fetchImpl: async (url, options) => {
    if (url !== 'https://packs.example/original.zip' || options.headers.authorization || options.headers.cookie) throw Error('Invalid pack request');
    return new Response(Uint8Array.of(80, 75, 3, 4));
  } });`);
  const built = await build({ stdin: { contents: entry, resolveDir: new URL('.', import.meta.url).pathname },
    bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*', 'cloudflare:*'] });
  const config = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
  const durableObjects = Object.fromEntries(config.durable_objects.bindings.map(binding => [binding.name,
    { className: binding.class_name, useSQLite: config.migrations.some(m => m.new_sqlite_classes?.includes(binding.class_name)) }]));
  return new Miniflare({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects, bindings: { RELAY_TOKEN: token } });
}
function messages(socket) {
  const queued = [], waiting = [];
  socket.addEventListener('message', ({ data }) => {
    const value = typeof data === 'string' ? JSON.parse(data) : Buffer.from(data);
    const index = waiting.findIndex(item => item.match(value));
    if (index >= 0) waiting.splice(index, 1)[0].resolve(value); else queued.push(value);
  });
  return (match = () => true) => {
    const index = queued.findIndex(match);
    return index >= 0 ? Promise.resolve(queued.splice(index, 1)[0]) : new Promise(resolve => waiting.push({ match, resolve }));
  };
}
const sendConnect = socket => socket.send(JSON.stringify({ connect: { host: 'mc.example.com', port: 25565 } }));

test('Worker pack downloads require owner token and Origin and preserve exact ZIP bytes', { timeout: 20000 }, async () => {
  const mf = await workerFixture({ pack: true }); let socket;
  try {
    const request = (query = '', from = origin) => mf.dispatchFetch('https://relay.example/pack/' + query,
      { headers: { Upgrade: 'websocket', Origin: from } });
    assert.equal((await request()).status, 403);
    assert.equal((await request('?token=' + token, 'https://other.example')).status, 403);
    const response = await request('?token=' + token); assert.equal(response.status, 101);
    socket = response.webSocket; socket.accept(); const next = messages(socket);
    socket.send('{"url":"https://packs.example/original.zip"}'); assert.deepEqual(await next(), { status: 200 });
    socket.send('{"pull":true}'); assert.deepEqual(await next(), Buffer.from([80, 75, 3, 4]));
    socket.send('{"pull":true}'); assert.deepEqual(await next(), { eof: true });
  } finally { try { socket?.close(); } catch {} await mf.dispose(); }
});

test('Worker checks access before TCP and forwards raw bytes without protocol headers', { timeout: 20000 }, async () => {
  const tcp = createServer(socket => socket.on('data', bytes => socket.write(bytes)));
  tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  const mf = await workerFixture({ port: tcp.address().port }); let socket;
  const request = (query, from = origin) => mf.dispatchFetch('https://relay.example/tcp/?' + query,
    { headers: { Upgrade: 'websocket', Origin: from } });
  try {
    const health = await mf.dispatchFetch('https://relay.example/healthz');
    assert.equal(health.status, 200); assert.equal((await health.json()).protocol, 'tcp');
    assert.equal((await request('host=mc.example.com&port=25565')).status, 403);
    assert.equal((await request('host=127.0.0.1&port=25565&token=' + token)).status, 403);
    assert.equal((await request('host=3000%3A%3A1&port=25565&token=' + token)).status, 403);
    assert.equal((await request('host=mc.example.com&port=25565&token=' + token, 'https://other.example')).status, 403);
    const response = await request('host=mc.example.com&port=25565&token=' + token); assert.equal(response.status, 101);
    socket = response.webSocket; socket.accept(); const next = messages(socket);
    assert.deepEqual(await next(), { relay: { version: 1, windowBytes: 1048576 } });
    sendConnect(socket); assert.deepEqual(await next(), { connected: true });
    const bytes = Buffer.from([0, 1, 2, 3, 4, 255, 0, 127]); socket.send(bytes);
    assert.deepEqual(await next(Buffer.isBuffer), bytes);
    assert.deepEqual(await next(value => value.written), { written: bytes.length });
  } finally { try { socket?.close(); } catch {} await mf.dispose(); tcp.close(); }
});

test('Worker isolates simultaneous connections and releases only the disconnected TCP socket', { timeout: 20000 }, async () => {
  const connections = new Set();
  const tcp = createServer(socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket)); socket.on('data', bytes => socket.write(bytes));
  });
  tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  const mf = await workerFixture({ port: tcp.address().port }); const sockets = [];
  try {
    const open = async () => {
      const response = await mf.dispatchFetch('https://relay.example/tcp/?host=mc.example.com&port=25565&token=' + token,
        { headers: { Upgrade: 'websocket', Origin: origin } });
      assert.equal(response.status, 101); const socket = response.webSocket; socket.accept(); sockets.push(socket);
      const next = messages(socket); await next(value => value.relay); sendConnect(socket); await next(value => value.connected);
      return { socket, next };
    };
    const [first, second] = await Promise.all([open(), open()]);
    for (const stream of [first, second]) { const bytes = Buffer.from('independent stream'); stream.socket.send(bytes); assert.deepEqual(await stream.next(Buffer.isBuffer), bytes); }
    assert.equal(connections.size, 2); first.socket.close();
    const deadline = Date.now() + 3000;
    while (connections.size > 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(connections.size, 1);
    for (let index = 0; index < 32; index++) {
      const bytes = Buffer.from('continuing stream ' + index); second.socket.send(bytes);
      assert.deepEqual(await second.next(Buffer.isBuffer), bytes); second.socket.send(JSON.stringify({ received: bytes.length }));
    }
    second.socket.close();
    const closedDeadline = Date.now() + 3000;
    while (connections.size && Date.now() < closedDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(connections.size, 0);
  } finally {
    for (const socket of sockets) { try { socket.close(); } catch {} }
    await mf.dispose(); for (const socket of connections) socket.destroy(); tcp.close();
  }
});
