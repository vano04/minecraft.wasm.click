import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { testingAssetResolver } from '../server/runtime-assets.mjs';

const original = await readFile(new URL('../runtime/OpenJDK/browser/mojang-upstream.js', import.meta.url), 'utf8');
const source = testingAssetResolver(original);
const names = [
  'minecraft/sounds.json',
  'minecraft/sounds/random/click.ogg',
  ...Array.from({ length: 6 }, (_, i) => `minecraft/textures/gui/title/background/panorama_${i}.png`),
  'minecraft/textures/gui/title/background/panorama_overlay.png',
];
const body = new TextEncoder().encode('verified asset fixture');
const sha1 = bytes => createHash('sha1').update(bytes).digest('hex');
const index = new TextEncoder().encode(JSON.stringify({ objects: Object.fromEntries(names.map(name => [name, { hash: sha1(body), size: body.length }])) }));
const assetIndex = { id: 'fixture', url: 'https://piston-meta.mojang.com/fixture.json', sha1: sha1(index) };

function resolver({ corrupt = false, mojangAvailable = false, githubAvailable = true } = {}) {
  const calls = [];
  const context = { URL, Response, TextDecoder, Uint8Array, crypto,
    location: { origin: 'https://launcher.example', href: 'https://launcher.example/testing/' },
    fetch: async (input, options) => {
      const url = String(input); calls.push({ url, options });
      if (url === assetIndex.url) return new Response(index);
      if (url.startsWith('https://resources.download.minecraft.net/')) {
        if (mojangAvailable) return new Response(body);
        throw new TypeError('CORS fixture');
      }
      assert.ok(url.startsWith('https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/26.3/assets/'), url);
      if (!githubAvailable) return new Response(null, { status: 404 });
      return new Response(corrupt ? new Uint8Array(body.length).fill(42) : body);
    } };
  vm.runInNewContext(source, context);
  return { api: context.mcWebUpstream.createResolver({ assetIndex }), calls };
}

test('Mojang is tried first and successful Mojang downloads never contact GitHub', async () => {
  const { api, calls } = resolver({ mojangAvailable: true });
  for (const name of names) {
    const response = await api.fetch('https://launcher.example/mcweb-audio/' + name);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(body));
  }
  assert.deepEqual(calls.map(call => call.url), [
    assetIndex.url,
    ...names.map(() => `https://resources.download.minecraft.net/${sha1(body).slice(0, 2)}/${sha1(body)}`),
  ]);
});

test('failed Mojang and GitHub downloads stop without contacting any other asset host', async () => {
  const { api, calls } = resolver({ githubAvailable: false });
  for (const name of names) {
    assert.equal((await api.fetch('https://launcher.example/mcweb-audio/' + name)).status, 404);
  }
  assert.deepEqual(calls.map(call => call.url), [
    assetIndex.url,
    `https://resources.download.minecraft.net/${sha1(body).slice(0, 2)}/${sha1(body)}`,
    ...names.map(name => 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/26.3/assets/' + name),
  ]);
});

test('sounds and all panorama images download from GitHub without credentials and retain Mojang integrity checks', async () => {
  const { api, calls } = resolver();
  for (const name of names) {
    const response = await api.fetch('https://launcher.example/mcweb-audio/' + name);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(body));
  }
  const mirrors = calls.filter(call => call.url.startsWith('https://raw.githubusercontent.com/'));
  assert.ok(calls.findIndex(call => call.url.startsWith('https://resources.download.minecraft.net/'))
    < calls.findIndex(call => call.url.startsWith('https://raw.githubusercontent.com/')));
  assert.equal(mirrors.length, names.length);
  for (const [i, call] of mirrors.entries()) {
    assert.equal(call.url, 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/26.3/assets/' + names[i]);
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.mode, 'cors');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.referrerPolicy, 'no-referrer');
    assert.equal(call.options.headers, undefined);
  }
  assert.ok(calls.every(call => !call.url.startsWith('https://launcher.example')));
  const tampered = resolver({ corrupt: true });
  for (const name of names) {
    assert.equal((await tampered.api.fetch('https://launcher.example/mcweb-audio/' + name)).status, 404);
  }
});

test('the deployment transform rejects missing or ambiguous runtime hooks', () => {
  assert.throws(() => testingAssetResolver('unexpected'), /Unexpected asset resolver/);
  assert.throws(() => testingAssetResolver(original + original), /Unexpected asset resolver/);
});
