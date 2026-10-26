import assert from 'node:assert/strict';
import { createPlayerTextureFetch } from '../public/auth/player-textures.mjs';
import { readFile } from 'node:fs/promises';
const origin = 'https://minecraft.wasm.click';
const hash = 'a'.repeat(64);
const sentinel = (value = 'base64+/', signature = 'signature+/') => 'https://mcweb-profile-verifier.invalid/verify?' + new URLSearchParams({ value, signature });
const calls = [];
let valid = true;
const fetcher = createPlayerTextureFetch({ origin, fetchImpl: async (url, options) => {
  calls.push({ url, options });
  return Response.json({ valid });
} });
for (const result of [true, false, 'true', 1, null]) {
  valid = result;
  const response = await fetcher(sentinel());
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [result === true ? 1 : 0]);
  assert.equal(response.headers.get('content-length'), '1');
}
assert.equal(calls[0].url, origin + '/mcweb/verify-profile-property');
assert.equal(calls[0].options.method, 'POST');
assert.equal(calls[0].options.credentials, 'same-origin');
assert.equal(calls[0].options.redirect, 'error');
assert.deepEqual(JSON.parse(calls[0].options.body), { value: 'base64+/', signature: 'signature+/' });
assert.ok(!calls.some(call => call.url.includes('invalid') || call.url.includes('signature')), 'Signed profile data stays out of network URLs');
for (const url of [sentinel() + '&extra=1', sentinel('', 'signature'), sentinel('x'.repeat(65537)), sentinel().replace('/verify?', '/wrong?'), sentinel().replace('https:', 'http:'), sentinel().replace('invalid/', 'invalid:444/')]) await assert.rejects(fetcher(url), /Invalid profile verification/);
for (const response of [new Response('bad JSON'), Response.json({ valid: true }, { status: 403 }), new Response('a'.repeat(1025))]) {
  const boundary = createPlayerTextureFetch({ origin, fetchImpl: async () => response });
  try { assert.deepEqual([...new Uint8Array(await (await boundary(sentinel())).arrayBuffer())], [0]); }
  catch (error) { assert.match(String(error), /JSON|too large|Unexpected/); }
}
let cdnCall;
const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const textures = createPlayerTextureFetch({ origin, fetchImpl: async (url, options) => {
  cdnCall = { url, options }; return new Response(png);
} });
const texture = await textures('http://textures.minecraft.net/texture/' + hash, { headers: { test: 'yes' }, credentials: 'include' });
assert.equal(cdnCall.url, 'https://textures.minecraft.net/texture/' + hash);
assert.equal(cdnCall.options.credentials, 'omit');
assert.equal(cdnCall.options.redirect, 'error');
assert.deepEqual(new Uint8Array(await texture.arrayBuffer()), png);
for (const url of ['https://textures.minecraft.net/texture/' + hash + '?x=1', 'https://textures.minecraft.net:444/texture/' + hash, 'https://user:pass@textures.minecraft.net/texture/' + hash, 'https://textures.minecraft.net/not-a-texture']) await assert.rejects(textures(url), /Invalid Minecraft/);
let cancelled = false;
const overlong = createPlayerTextureFetch({ origin, fetchImpl: async () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; },
})) });
await assert.rejects((await overlong('https://textures.minecraft.net/texture/' + hash)).arrayBuffer(), /exceeds 4 MiB/);
assert.equal(cancelled, true);
const source = await readFile(new URL('../public/auth/player-textures.mjs', import.meta.url), 'utf8');
assert.ok(!source.includes('accessToken') && !source.includes('Bearer'), 'No provider credentials in browser adapter');
console.log('Player textures: same-origin signature POST, exact boolean, malformed/oversized fail-closed replies, HTTPS CDN, bounded PNG, URL validation and credential isolation passed.');
if (process.argv[2]) {
  const { pathToFileURL } = await import('node:url');
  const { createBrowserPackHttp } = await import(pathToFileURL(process.argv[2]));
  const http = createBrowserPackHttp({ fetchImpl: createPlayerTextureFetch({ origin, fetchImpl: async () => Response.json({ valid: true }) }) });
  const exchange = ops => JSON.parse(http.exchange(JSON.stringify({ ops }))).requests;
  let replies = exchange([{ id: 1, op: 'open', url: sentinel(), headers: {} }]);
  const deadline = Date.now() + 2000;
  while (replies[1]?.state === 'opening' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 1)); replies = exchange([]); }
  assert.equal(replies[1].status, 200);
  assert.equal(replies[1].contentLength, '1');
  let reply = exchange([{ id: 1, op: 'pull' }])[1];
  while (!reply?.data && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 1)); reply = exchange([])[1]; }
  assert.equal(reply.data, 'AQ==', 'Verifier exact one-byte reply survives actual bounded BYOB transport');
  reply = exchange([{ id: 1, op: 'pull' }])[1];
  while (reply?.state !== 'eof' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 1)); reply = exchange([])[1]; }
  assert.equal(reply.state, 'eof');
  const pngHttp = createBrowserPackHttp({ fetchImpl: createPlayerTextureFetch({ origin, fetchImpl: async () => new Response(png) }) });
  const pngExchange = ops => JSON.parse(pngHttp.exchange(JSON.stringify({ ops }))).requests;
  let pngReply = pngExchange([{ id: 2, op: 'open', url: 'http://textures.minecraft.net/texture/' + hash, headers: {} }])[2];
  const pngDeadline = Date.now() + 2000;
  while (pngReply?.state === 'opening' && Date.now() < pngDeadline) { await new Promise(resolve => setTimeout(resolve, 1)); pngReply = pngExchange([])[2]; }
  assert.equal(pngReply.status, 200);
  pngReply = pngExchange([{ id: 2, op: 'pull' }])[2];
  while (!pngReply?.data && Date.now() < pngDeadline) { await new Promise(resolve => setTimeout(resolve, 1)); pngReply = pngExchange([])[2]; }
  assert.deepEqual(Buffer.from(pngReply.data, 'base64'), Buffer.from(png));
  pngReply = pngExchange([{ id: 2, op: 'pull' }])[2];
  while (pngReply?.state !== 'eof' && Date.now() < pngDeadline) { await new Promise(resolve => setTimeout(resolve, 1)); pngReply = pngExchange([])[2]; }
  assert.equal(pngReply.state, 'eof', 'PNG BYOB stream must close a pending read after delivering its last bytes');
  console.log('Player textures: real release BrowserPackHttp BYOB open/pull/data/eof roundtrip passed.');
}
