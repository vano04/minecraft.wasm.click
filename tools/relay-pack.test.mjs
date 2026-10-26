import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createRelay } from '../relay-service/server.mjs';
import { createRelayPackFetch, createPackRelay } from '../public/auth/relay-pack.mjs';
import { readFile } from 'node:fs/promises';
import { relayPackHttp } from '../server/launcher.mjs';

const { WebSocket } = createRequire(new URL('../package.json', import.meta.url))('ws');
const origin = 'https://minecraft.wasm.click';

test('the served pack adapter explains relay failures without claiming CORS is the only option', async () => {
  const source = await readFile(new URL('../runtime/web/pack-http.js', import.meta.url), 'utf8');
  const transformed = relayPackHttp(source);
  const { createBrowserPackHttp } = await import('data:text/javascript;base64,' + Buffer.from(transformed).toString('base64'));
  const http = createBrowserPackHttp({ fetchImpl: async () => { throw Error('Selected relay is unavailable'); } });
  const exchange = (ops = []) => JSON.parse(http.exchange(JSON.stringify({ ops }))).requests;
  exchange([{ op: 'open', id: 1, url: 'https://packs.example/a.zip' }]);
  await new Promise(setImmediate);
  assert.match(exchange()[1].error, /Check the pack URL and the selected relay.*Selected relay is unavailable/);
  assert.throws(() => relayPackHttp('unexpected'), /Unexpected resource-pack HTTP adapter/);
  assert.throws(() => relayPackHttp(source + source), /Unexpected resource-pack HTTP adapter/);
});

test('a browser pack fetch falls back through its selected relay and retains bounded BYOB reads', { timeout: 10000 }, async () => {
  const expected = Uint8Array.from({ length: 150000 }, (_, i) => i % 239);
  const token = 'test-only-browser-relay-token'.repeat(2);
  let direct = 0, opened = 0;
  const relay = createRelay({ token, packFetch: async url => {
    assert.equal(url, 'https://packs.example/original.zip');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(expected.slice()); controller.close(); } }));
  } });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const channel = new MessageChannel();
  const bridge = createPackRelay({ send: (value, transfer = []) => channel.port1.postMessage(value, transfer),
    openChannel() {
      opened++;
      return { channel: new WebSocket('ws://127.0.0.1:' + relay.address().port + '/pack/?token=' + token, { origin }) };
    } });
  channel.port1.onmessage = ({ data }) => bridge.receive(data);
  const fetchPack = createRelayPackFetch({ port: channel.port2, origin, fetchImpl: async () => { direct++; throw TypeError('CORS denied'); } });
  try {
    const response = await fetchPack('https://packs.example/original.zip#hash', { headers: { Authorization: 'never-forward-this' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), null);
    const reader = response.body.getReader({ mode: 'byob' });
    const chunks = [];
    for (;;) {
      const { value, done } = await reader.read(new Uint8Array(65536));
      if (value?.length) { assert.ok(value.length <= 32768); chunks.push(value); }
      if (done) break;
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(expected));
    assert.equal(direct, 1); assert.equal(opened, 1);
    for (const url of [origin + '/mcweb/auth/session', 'https://textures.minecraft.net/texture/' + 'a'.repeat(64), 'https://mcweb-profile-verifier.invalid/verify']) {
      await assert.rejects(fetchPack(url), /CORS denied/);
    }
    assert.equal(opened, 1, 'Identity and texture requests never use the pack relay');
  } finally {
    bridge.closeAll(); channel.port1.close(); channel.port2.close();
    await new Promise(resolve => relay.close(resolve));
  }
});

test('successful direct downloads and aborted requests never open a pack relay', async () => {
  const channel = new MessageChannel();
  let messages = 0;
  channel.port1.onmessage = () => messages++;
  try {
    const direct = createRelayPackFetch({ port: channel.port2, origin, fetchImpl: async () => new Response('direct') });
    assert.equal(await (await direct('https://packs.example/a.zip')).text(), 'direct');
    const abort = new AbortController(); abort.abort();
    const failed = createRelayPackFetch({ port: channel.port2, origin, fetchImpl: async () => { throw Error('aborted'); } });
    await assert.rejects(failed('https://packs.example/a.zip', { signal: abort.signal }), /aborted/);
    await new Promise(setImmediate);
    assert.equal(messages, 0);
  } finally { channel.port1.close(); channel.port2.close(); }
});

test('cancelling a browser pack read closes the relay stream and cancels its upstream', { timeout: 10000 }, async () => {
  const token = 'test-only-cancel-relay-token'.repeat(2);
  let cancelled = false;
  const relay = createRelay({ token, packFetch: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })) });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const channel = new MessageChannel();
  const bridge = createPackRelay({ send: (value, transfer = []) => channel.port1.postMessage(value, transfer),
    openChannel: () => ({ channel: new WebSocket('ws://127.0.0.1:' + relay.address().port + '/pack/?token=' + token, { origin }) }) });
  channel.port1.onmessage = ({ data }) => bridge.receive(data);
  try {
    const fetchPack = createRelayPackFetch({ port: channel.port2, origin, fetchImpl: async () => { throw TypeError('CORS denied'); } });
    const abort = new AbortController();
    const response = await fetchPack('https://packs.example/a.zip', { signal: abort.signal });
    const pending = response.body.getReader({ mode: 'byob' }).read(new Uint8Array(65536));
    abort.abort();
    await assert.rejects(pending, /abort/i);
    const deadline = Date.now() + 2000;
    while (!cancelled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cancelled, true);
  } finally {
    bridge.closeAll(); channel.port1.close(); channel.port2.close();
    await new Promise(resolve => relay.close(resolve));
  }
});
