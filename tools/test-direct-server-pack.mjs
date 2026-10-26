import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const launcher = await readFile(new URL('../server/game-storage-launcher.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(launcher, /server-pack-file|mcWebServerPackFile/, 'Accept must not inject a file-picker helper');
const library = await readFile(new URL('../public/auth/launcher-ui.js', import.meta.url), 'utf8');
assert.match(library, /mcWebOpenResourcePacks/, 'User-opened resource-pack management remains available');
console.log('PASS server-pack Accept has no picker injection; user-opened file management remains available');

if (process.argv[2]) {
  const bundle = resolve(process.argv[2]);
  const worker = await readFile(bundle + '/gpu-rpc-worker.js', 'utf8');
  const loader = await readFile(bundle + '/javavm.js', 'utf8');
  assert.doesNotMatch(worker + loader, /mcwebServerPackFile|mcWebServerPackFile|server-pack-file\.mjs/,
    'Pack Accept must have no automatic file-dialog message route');
  assert.match(worker, /createBrowserPackHttp\(\{ fetchImpl: createPlayerTextureFetch\(\) \}\)/);
  const { createBrowserPackHttp } = await import(pathToFileURL(bundle + '/pack-http.js'));
  const turn = () => new Promise(setImmediate);
  const exchange = (http, ops = []) => JSON.parse(http.exchange(JSON.stringify({ ops }))).requests;
  const open = { id: 1, op: 'open', url: 'https://packs.test/original.zip#expected-hash',
    headers: { Authorization: 'private-not-for-pack', 'Minecraft-Version': '26.3' } };
  let calls = 0, downloaded = 0;
  const http = createBrowserPackHttp({ chunkBytes: 2, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://packs.test/original.zip');
    assert.equal(options.credentials, 'omit'); assert.equal(options.mode, 'cors');
    assert.equal(options.headers.has('Authorization'), false);
    assert.equal(options.headers.has('Minecraft-Version'), false, 'Cross-origin pack GET does not force metadata preflight');
    return new Response(new ReadableStream({ type: 'bytes', start(controller) {
      controller.enqueue(Uint8Array.of(80, 75, 3, 4)); controller.close();
    } }), { headers: { 'content-length': '4', 'content-encoding': 'identity' } });
  } });
  exchange(http, [open]); await turn();
  assert.equal(exchange(http)[1].contentLength, '4');
  const bytes = [];
  for (let count = 0; count < 10; count++) {
    exchange(http, [{ id: 1, op: 'pull' }]); await turn();
    const state = exchange(http)[1];
    if (state.data) { const chunk = Buffer.from(state.data, 'base64'); assert.ok(chunk.length <= 2); bytes.push(...chunk); downloaded += chunk.length; }
    if (state.state === 'eof') break;
  }
  assert.deepEqual(bytes, [80, 75, 3, 4]); assert.equal(downloaded, 4); assert.equal(calls, 1);
  assert.deepEqual(exchange(http), {});
  const denied = createBrowserPackHttp({ fetchImpl: async () => { calls++; throw TypeError('CORS denied'); } });
  exchange(denied, [open]); await turn();
  assert.match(exchange(denied)[1].error, /pack host must permit CORS/);
  assert.equal(calls, 2, 'Without a selected relay, a failed direct request does not retry');
  assert.deepEqual(exchange(denied), {}, 'Failure is settled once and removed');
  for (const url of ['https://textures.minecraft.net/texture/' + 'a'.repeat(64), 'https://mcweb-profile-verifier.invalid/verify']) {
    const protectedRequest = createBrowserPackHttp({ fetchImpl: async () => { throw Error('original player error'); } });
    exchange(protectedRequest, [{ ...open, url }]); await turn();
    assert.equal(exchange(protectedRequest)[1].error, 'original player error');
  }
  console.log('PASS automatic direct HTTPS bytes/EOF, credential filtering, CORS failure settlement and player-texture/verifier isolation');
}
