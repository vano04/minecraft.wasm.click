import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../OpenJDK/browser/pre.js', import.meta.url), 'utf8');
// The last is BrowserTextInput's report for the native keyboard: sent at the
// end of every frame whose text-input state changed, so it must ride the next
// request rather than cost a round trip or split a frame's render batch.
const markers = ['flow: client=118', 'framesplit: frames=1', 'entitytick: tick=60', 'frametime: n=1 max=900ms',
  'evt:text-input 1 1 412 306 1 21 1 400 300 480 40 1'];

// Run the actual pthread pre-js entry point. The port double services the wire
// immediately, so Atomics.wait sees an answered request without another Worker.
async function harness(execute = () => null) {
  const listeners = [], requests = [], delivered = [], warnings = [];
  const sab = new SharedArrayBuffer(4096 + 2 * (2 << 20));
  const i32 = new Int32Array(sab, 0, 16), data = new Uint8Array(sab, 4096);
  const enc = new TextEncoder(), dec = new TextDecoder();
  const port = {
    postMessage({ slot, base, len }) {
      const request = JSON.parse(dec.decode(data.slice(base, base + len)));
      requests.push(request);
      Atomics.store(i32, 8 + slot, 1);
      let response;
      try {
        response = { results: request.batch.map(call => {
          delivered.push(call);
          return execute(call);
        }) };
      } catch (error) {
        response = { e: error.message };
      }
      if (!request.async) {
        const bytes = enc.encode(JSON.stringify(response));
        data.set(bytes, base);
        i32[3] = bytes.length;
        Atomics.store(i32, 1, 1);
      }
    },
  };
  const context = vm.createContext({
    Module: { print() {} }, ENVIRONMENT_IS_PTHREAD: true, ENVIRONMENT_IS_NODE: false,
    self: { addEventListener(name, listener) { if (name === 'message') listeners.push(listener); } },
    SharedArrayBuffer, TextEncoder, TextDecoder, URLSearchParams, setTimeout, clearTimeout,
    console: { warn(message) { warnings.push(message); }, error() {}, log() {} },
  });
  vm.runInContext(source, context, { filename: 'pre.js' });
  for (const listener of listeners) listener({ data: { cmd: 2, mcwebRpc: { port, sab } } });
  port.onmessage({ data: { mcwebReady: true, adapter: 'test', width: 1, height: 1 } });
  await context.__mcWebWorkerGate;
  return { gpu: context.mcWebGpu, requests, delivered, warnings };
}

for (const marker of markers) {
  test(`${marker.split(':')[0]} waits for the next request and keeps its result aligned`, async () => {
    const h = await harness(call => call.m === 'canvasWidth' ? 1280 : null);
    assert.equal(h.gpu.reportProgress(marker), undefined);
    assert.equal(h.requests.length, 0);
    assert.equal(h.gpu.canvasWidth(), 1280);
    assert.deepEqual(h.requests.map(r => r.batch.map(c => [c.m, c.a])), [
      [['reportProgress', [marker]], ['canvasWidth', []]],
    ]);
    assert.equal(h.gpu.canvasWidth(), 1280);
    assert.equal(h.requests[1].batch.length, 1, 'markers are delivered only once');
  });
}

test('markers retain order, leave rendering deferred, and ride an asynchronous present', async () => {
  const h = await harness(call => call.m === 'canvasHeight' ? 720 : null);
  h.gpu.createCommandEncoder();
  for (const marker of markers) h.gpu.reportProgress(marker);
  assert.equal(h.requests.length, 0, 'markers must not flush pending render commands');
  h.gpu.submit(1);
  h.gpu.present(2);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].async, true);
  assert.deepEqual(h.delivered.filter(c => c.m === 'reportProgress').map(c => c.a[0]), markers);
  assert.deepEqual(h.delivered.filter(c => c.m !== 'reportProgress').map(c => c.m),
    ['createCommandEncoder', 'submit', 'present']);
  assert.equal(h.gpu.canvasHeight(), 720);
  assert.equal(h.requests[1].batch.length, 1);
});

test('the 256-marker bound flushes in order and the remaining tail rides the next request', async () => {
  const h = await harness(call => call.m === 'canvasWidth' ? 1280 : null);
  const expected = Array.from({ length: 257 }, (_, i) => `${markers[i % markers.length]} sample=${i}`);
  for (const marker of expected.slice(0, 255)) h.gpu.reportProgress(marker);
  assert.equal(h.requests.length, 0);
  h.gpu.reportProgress(expected[255]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].batch.length, 256);
  assert.equal(h.requests[0].async, undefined);
  h.gpu.reportProgress(expected[256]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.gpu.canvasWidth(), 1280);
  assert.equal(h.requests[1].batch.length, 2);
  assert.deepEqual(h.delivered.filter(c => c.m === 'reportProgress').map(c => c.a[0]), expected);
});

for (const [method, args] of [
  ['reportProgress', ['pump:failed']],
  ['reportSuccess', [0xff000000, 'test', 'test-path']],
  ['reportJavaFailure', ['frame-pump', 'Error', 'test failure']],
]) {
  test(`${method} immediately flushes a dangling render batch and pending markers`, async () => {
    const h = await harness();
    h.gpu.createCommandEncoder();
    for (const marker of markers) h.gpu.reportProgress(marker);
    h.gpu[method](...args);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[0].batch.map(c => c.m), [...markers.map(() => 'reportProgress'), 'createCommandEncoder']);
    assert.deepEqual(h.requests[1].batch, [{ o: 'gpu', m: method, a: args }]);
    assert.ok(h.requests.every(r => !r.async));
    assert.equal(h.warnings.length, 0);
  });
}

test('a failed dangling flush still delivers reportJavaFailure immediately', async () => {
  const h = await harness(call => {
    if (call.m === 'createCommandEncoder') throw new Error('render flush rejected');
    return null;
  });
  h.gpu.createCommandEncoder();
  h.gpu.reportProgress(markers[3]);
  h.gpu.reportJavaFailure('frame-pump', 'Error', 'original failure');
  assert.equal(h.requests.length, 2);
  assert.match(h.warnings[0], /dangling batch flush failed: Error: render flush rejected/);
  assert.equal(h.delivered.at(-1).m, 'reportJavaFailure');
  assert.deepEqual(h.delivered.at(-1).a, ['frame-pump', 'Error', 'original failure']);
  assert.equal(h.requests[1].async, undefined);
});

test('an ordinary synchronous RPC error still reaches the caller after queued markers', async () => {
  const h = await harness(call => {
    if (call.m === 'canvasWidth') throw new Error('query failed');
    return null;
  });
  h.gpu.reportProgress(markers[0]);
  assert.throws(() => h.gpu.canvasWidth(), /query failed/);
  assert.deepEqual(h.delivered.map(c => c.m), ['reportProgress', 'canvasWidth']);
});
