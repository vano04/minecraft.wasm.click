import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserPackHttp } from "../web/pack-http.js";
import { MC_VERSION } from "../tools/mc-version.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const exchange = (http, ops = []) => JSON.parse(http.exchange(JSON.stringify({ ops }))).requests;
const open = (id, extra = {}) => ({ op: "open", id, url: "https://packs.test/own.zip", followRedirects: true,
  headers: { "Minecraft-Version": MC_VERSION }, ...extra });
function response(parts, { status = 200, headers = {}, type = "basic", cancelRejects = false } = {}) {
  const stats = { reads: 0, producerPulls: 0, cancels: 0, cancelCalls: 0, releases: 0 };
  const stream = new ReadableStream({ type: "bytes",
    async pull(controller) {
      stats.producerPulls++;
      const part = await (parts.shift() ?? { done: true });
      if (part.done) {
        const pending = controller.byobRequest;
        controller.close();
        pending?.respond(0);
      } else controller.enqueue(part.value);
    },
    cancel() { stats.cancels++; return cancelRejects ? Promise.reject(new Error("cancel failed")) : Promise.resolve(); },
  }, { highWaterMark: 0 });
  const body = { getReader(options) {
    assert.equal(options.mode, "byob");
    const reader = stream.getReader(options);
    return {
      read(view) { stats.reads++; assert.ok(view.byteLength <= 64 * 1024); return reader.read(view); },
      cancel() { stats.cancelCalls++; return reader.cancel(); },
      releaseLock() { stats.releases++; reader.releaseLock(); },
    };
  } };
  return { response: { status, type, headers: new Headers(headers), body }, stats };
}
const bytes = (...values) => ({ done: false, value: Uint8Array.from(values) });
const unpack = (reply) => [...Buffer.from(reply.data, "base64")];

test("pack HTTP streams one bounded chunk per credit and releases EOF", async () => {
  const fixture = response([bytes(1, 2, 3, 4, 5, 6)], { headers: { "content-length": "6" } });
  let options;
  const http = createBrowserPackHttp({ chunkBytes: 2, origin: "https://packs.test", fetchImpl: async (url, init) => {
    assert.equal(url, "https://packs.test/own.zip"); options = init; return fixture.response;
  } });
  exchange(http, [open(1)]);
  await turn();
  const metadata = exchange(http)[1];
  assert.equal(metadata.status, 200);
  assert.equal(metadata.contentLength, "6");
  assert.equal(options.headers.get("Minecraft-Version"), MC_VERSION);
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "follow");
  assert.equal(fixture.stats.reads, 0, "metadata alone must not consume the body");
  for (const expected of [[1, 2], [3, 4], [5, 6]]) {
    exchange(http, [{ op: "pull", id: 1 }]); await turn();
    assert.deepEqual(unpack(exchange(http)[1]), expected);
    assert.equal(exchange(http)[1].data, undefined, "a delivered chunk is not replayed");
    assert.equal(fixture.stats.producerPulls, 1, "large producer remainder is handled by bounded BYOB reads");
  }
  exchange(http, [{ op: "pull", id: 1 }]); await turn();
  assert.equal(exchange(http)[1].state, "eof");
  assert.deepEqual(exchange(http), {});
  assert.equal(fixture.stats.releases, 1);
});

test("pack HTTP preserves HTTP error bodies and independent concurrent streams", async () => {
  const blocked = deferred();
  const first = response([blocked.promise]);
  const second = response([bytes(9, 8)], { status: 404 });
  let calls = 0;
  const http = createBrowserPackHttp({ fetchImpl: async () => (++calls === 1 ? first : second).response });
  exchange(http, [open(1), open(2)]); await turn();
  const metadata = exchange(http);
  assert.equal(metadata[2].status, 404, "HTTP status failures remain readable by vanilla getErrorStream");
  exchange(http, [{ op: "pull", id: 1 }, { op: "pull", id: 2 }]); await turn();
  assert.deepEqual(unpack(exchange(http)[2]), [9, 8]);
  blocked.reject(new Error("body transport failed")); await turn();
  const failed = exchange(http);
  assert.match(failed[1].error, /body transport failed/);
  assert.equal(failed[1].state, "error");
  assert.equal(exchange(http)[1], undefined);
  exchange(http, [{ op: "pull", id: 2 }]); await turn();
  assert.equal(exchange(http)[2].state, "eof");
  assert.deepEqual(exchange(http), {});
  assert.equal(first.stats.cancelCalls, 1, "the failed reader receives cleanup");
  assert.equal(first.stats.cancels, 0, "an already errored stream does not call its underlying source cancel hook");
});

test("pack HTTP cancellation discards late fetch/read completion and handles cancel rejection", async () => {
  const fetched = deferred();
  let signal, lateCancelled = 0;
  const http = createBrowserPackHttp({ fetchImpl: (url, init) => { signal = init.signal; return fetched.promise; } });
  exchange(http, [open(1)]); await turn();
  assert.deepEqual(exchange(http, [{ op: "cancel", id: 1 }]), {});
  assert.equal(signal.aborted, true);
  fetched.resolve({ body: { cancel() { lateCancelled++; return Promise.reject(new Error("late cancel failure")); } } });
  await turn();
  assert.equal(lateCancelled, 1);
  assert.deepEqual(exchange(http), {});

  const read = deferred();
  const fixture = response([read.promise], { cancelRejects: true });
  const reading = createBrowserPackHttp({ fetchImpl: async () => fixture.response });
  exchange(reading, [open(2)]); await turn();
  exchange(reading, [{ op: "pull", id: 2 }]); await turn();
  exchange(reading, [{ op: "cancel", id: 2 }]);
  read.resolve(bytes(1)); await turn();
  assert.equal(fixture.stats.cancels, 1);
  assert.deepEqual(exchange(reading), {});
});

test("pack HTTP caps active requests and splits a producer chunk larger than 64 KiB", async () => {
  const source = Uint8Array.from({ length: 150_000 }, (_, i) => i % 251);
  const expected = Buffer.from(source);
  const fixture = response([{ done: false, value: source }]);
  let calls = 0, signal;
  const http = createBrowserPackHttp({ maxRequests: 1,
    fetchImpl: async (url, init) => { calls++; signal = init.signal; return fixture.response; } });
  const opening = exchange(http, [open(1), open(2)]);
  assert.match(opening[2].error, /too many active/);
  await turn();
  assert.equal(calls, 1);
  const received = [];
  while (true) {
    exchange(http, [{ op: "pull", id: 1 }]); await turn();
    const reply = exchange(http)[1];
    if (reply.data) {
      const chunk = Buffer.from(reply.data, "base64");
      assert.ok(chunk.length <= 64 * 1024);
      received.push(chunk);
    }
    if (reply.state === "eof") break;
  }
  assert.deepEqual(Buffer.concat(received), expected);
  assert.equal(signal.aborted, false);
  assert.equal(fixture.stats.cancels, 0);
  assert.deepEqual(exchange(http), {});
});

test("pack HTTP explicitly rejects a body without bounded byte-stream BYOB support", async () => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } });
  const http = createBrowserPackHttp({ fetchImpl: async () => ({ status: 200, type: "basic", headers: new Headers(), body }) });
  exchange(http, [open(1)]); await turn();
  assert.match(exchange(http)[1].error, /requires bounded byte-stream BYOB/);
  assert.equal(cancelled, 1);
  assert.deepEqual(exchange(http), {});
});

test("pack HTTP reports unknown decoded/CORS lengths and preserves exact identity lengths", async () => {
  for (const [headers, type, expected] of [
    [{ "content-length": "12", "content-encoding": "gzip" }, "basic", null],
    [{ "content-length": "12" }, "cors", null],
    [{ "content-length": "9007199254740993", "content-encoding": "identity" }, "cors", "9007199254740993"],
  ]) {
    const fixture = response([], { headers, type });
    const http = createBrowserPackHttp({ fetchImpl: async () => fixture.response });
    exchange(http, [open(1)]); await turn();
    assert.equal(exchange(http)[1].contentLength, expected);
    exchange(http, [{ op: "cancel", id: 1 }]); await turn();
  }
});

test("pack HTTP catches sync fetch errors, rejects redirects when disabled, and validates credit", async () => {
  const failed = createBrowserPackHttp({ fetchImpl: () => { throw new Error("CORS failure"); } });
  exchange(failed, [open(1)]); await turn();
  assert.match(exchange(failed)[1].error, /CORS failure/);
  assert.deepEqual(exchange(failed), {});
  const fixture = response([deferred().promise]);
  let redirect;
  const http = createBrowserPackHttp({ fetchImpl: async (url, init) => { redirect = init.redirect; return fixture.response; } });
  exchange(http, [open(1, { followRedirects: false })]); await turn();
  assert.equal(redirect, "error");
  exchange(http, [{ op: "pull", id: 1 }]);
  assert.throws(() => exchange(http, [{ op: "pull", id: 1 }]), /duplicate.*credit/);
  exchange(http, [{ op: "cancel", id: 1 }]); await turn();
});

test("cross-origin direct packs strip fragments, credentials and preflight-triggering metadata", async () => {
  let seen;
  const fixture = response([]);
  const http = createBrowserPackHttp({ fetchImpl: async (url, options) => { seen = { url, options }; return fixture.response; } });
  exchange(http, [open(1, { url: 'https://opblocks.com/Texture-Pack261.zip#78496c68ea5de0cf366718d6566072d91d64797e',
    headers: { 'Minecraft-Version': MC_VERSION, 'X-Minecraft-Pack-Format': '97', 'User-Agent': 'native-client', Accept: 'application/zip', 'Accept-Language': 'en-US,en;q=0.9',
      Authorization: 'private-value', Cookie: 'private-cookie', 'Proxy-Authorization': 'private-proxy',
      'X-MCWeb-Edge-Key': 'private-edge' } })]);
  await turn();
  assert.equal(seen.url, 'https://opblocks.com/Texture-Pack261.zip');
  assert.equal(seen.options.credentials, 'omit'); assert.equal(seen.options.mode, 'cors');
  assert.equal(seen.options.headers.get('Minecraft-Version'), null);
  assert.equal(seen.options.headers.get('X-Minecraft-Pack-Format'), null);
  assert.deepEqual([...seen.options.headers.keys()].sort(), ['accept', 'accept-language']);
  exchange(http, [{ id: 1, op: 'cancel' }]);
});


test("failed external direct download reports CORS requirement without picker or retry", async () => {
  let calls = 0;
  const http = createBrowserPackHttp({ fetchImpl: async () => { calls++; throw TypeError("NetworkError"); } });
  exchange(http, [open(1)]); await turn();
  const failure = exchange(http)[1];
  assert.equal(failure.state, "error");
  assert.match(failure.error, /pack host must permit CORS/);
  assert.equal(calls, 1, "No secondary download endpoint or picker request is attempted");
  assert.deepEqual(exchange(http), {}, "Terminal download failure is delivered once");
  for (const url of ["https://textures.minecraft.net/texture/" + "a".repeat(64), "https://mcweb-profile-verifier.invalid/verify"]) {
    const player = createBrowserPackHttp({ fetchImpl: async () => { throw Error("original player error"); } });
    exchange(player, [open(1, { url })]); await turn();
    assert.equal(exchange(player)[1].error, "original player error");
  }
});


test("cross-origin header values remain safelisted while same-origin public metadata stays available", async () => {
  for (const origin of ["https://packs.test", "https://launcher.test"]) {
    let seen;
    const http = createBrowserPackHttp({ origin, fetchImpl: async (_url, options) => { seen = options.headers; return response([]).response; } });
    exchange(http, [open(1, { headers: { "Minecraft-Version": MC_VERSION, "Minecraft-UUID": "public-id",
      Accept: "application/zip; profile=\"requires-preflight\"", "Accept-Language": "x".repeat(129), Authorization: "private" } })]);
    await turn();
    assert.equal(seen.has("Authorization"), false);
    assert.equal(seen.has("Accept"), false); assert.equal(seen.has("Accept-Language"), false);
    assert.equal(seen.has("Minecraft-Version"), origin === "https://packs.test");
    assert.equal(seen.has("Minecraft-UUID"), origin === "https://packs.test");
    exchange(http, [{ id: 1, op: "cancel" }]);
  }
});
