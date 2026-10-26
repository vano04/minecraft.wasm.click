import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRelay } from './server.mjs';
import { fetchPack, packUrl, servePack, MAX_PACK_BYTES } from './pack.mjs';

const token = 'test-only-resource-pack-token'.repeat(2);
const origin = 'https://minecraft.wasm.click';

test('fragmented upstream bytes become full 32 KiB chunks within the eight-chunk receive window', async () => {
  class Socket extends EventTarget {
    sent = [];
    send(value) { this.sent.push(typeof value === 'string' ? JSON.parse(value) : value); }
    close() { this.dispatchEvent(new Event('close')); }
    receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  }
  const socket = new Socket();
  const expected = Uint8Array.from({ length: 9 * 32768 }, (_, i) => i % 251);
  servePack(socket, { fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    for (let at = 0; at < expected.length; at += 4096) controller.enqueue(expected.slice(at, at + 4096));
    controller.close();
  } })) });
  socket.receive({ url: 'https://packs.example/window.zip' });
  await new Promise(setImmediate);
  assert.deepEqual(socket.sent.shift(), { status: 200 });
  socket.receive({ pull: 8 });
  await new Promise(setImmediate);
  assert.equal(socket.sent.length, 8);
  assert.ok(socket.sent.every(value => value instanceof Uint8Array && value.length === 32768));
  const chunks = socket.sent.slice();
  socket.sent.length = 0;
  await new Promise(setImmediate);
  assert.equal(socket.sent.length, 0);
  socket.receive({ pull: 2 });
  await new Promise(setImmediate);
  assert.equal(socket.sent[0].length, 32768);
  assert.deepEqual(socket.sent[1], { eof: true });
  chunks.push(socket.sent[0]);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(expected));
});

test('pack URLs and every redirect require public HTTPS without credentials or custom ports', async () => {
  for (const value of ['http://packs.example/a.zip', 'https://user:secret@packs.example/a.zip',
    'https://packs.example:444/a.zip', 'https://127.0.0.1/a.zip', 'https://2130706433/a.zip',
    'https://[::ffff:127.0.0.1]/a.zip', 'https://metadata/a.zip', 'https://service.internal/a.zip']) {
    assert.throws(() => packUrl(value), /resource-pack|Resource packs/);
  }
  assert.equal(packUrl('https://packs.example/a.zip#hash').href, 'https://packs.example/a.zip');
  const calls = [];
  await assert.rejects(fetchPack('https://packs.example/a.zip', { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  } }), /public HTTPS/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(Object.keys(calls[0].options.headers).sort(), ['accept', 'user-agent']);
  let redirects = 0;
  await assert.rejects(fetchPack('https://packs.example/a.zip', { fetchImpl: async () => {
    redirects++;
    return new Response(null, { status: 302, headers: { location: '/loop.zip' } });
  } }), /redirect refused/);
  assert.equal(redirects, 4);
});

test('pack downloads reject declared sizes above the limit and preserve ordinary HTTP failures', async () => {
  let cancelled = false;
  await assert.rejects(fetchPack('https://packs.example/a.zip', { fetchImpl: async () => new Response(
    new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(MAX_PACK_BYTES + 1) } }) }), /512 MiB/);
  assert.equal(cancelled, true);
  assert.equal((await fetchPack('https://packs.example/missing.zip', { fetchImpl: async () => new Response(null, { status: 404 }) })).status, 404);
});

test('the real Node relay authenticates pack sockets and streams exact bytes only on pull', { timeout: 10000 }, async () => {
  let fetches = 0;
  const body = Uint8Array.from({ length: 128 * 1024 + 17 }, (_, i) => i % 251);
  const relay = createRelay({ token, packFetch: async (url, options) => {
    fetches++;
    assert.equal(url, 'https://packs.example/original.zip');
    assert.deepEqual(Object.keys(options.headers).sort(), ['accept', 'user-agent']);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(body.slice()); controller.close(); } }));
  } });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const endpoint = 'ws://127.0.0.1:' + relay.address().port + '/pack/';
  let socket;
  try {
    const denied = new WebSocket(endpoint, { origin });
    assert.match(String((await once(denied, 'error'))[0]), /403/);
    assert.equal(fetches, 0);
    socket = new WebSocket(endpoint + '?token=' + token, { origin });
    socket.binaryType = 'arraybuffer';
    const messages = [], waiting = [];
    socket.on('message', (data, binary) => {
      const value = binary ? new Uint8Array(data) : JSON.parse(String(data));
      if (waiting.length) waiting.shift()(value); else messages.push(value);
    });
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiting.push(resolve));
    await once(socket, 'open');
    socket.send(JSON.stringify({ url: 'https://packs.example/original.zip#hash' }));
    assert.deepEqual(await next(), { status: 200 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(messages.length, 0, 'No pack body arrives without pull credit');
    const chunks = [];
    for (;;) {
      socket.send('{"pull":true}');
      const value = await next();
      if (value.eof) break;
      assert.ok(value instanceof Uint8Array && value.length <= 32768);
      chunks.push(value);
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(body));
    assert.equal(fetches, 1);
  } finally {
    socket?.terminate();
    await new Promise(resolve => relay.close(resolve));
  }
});
