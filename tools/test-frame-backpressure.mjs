#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { createFrameBackpressure } from '../public/auth/frame-backpressure.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
{
  const fences = [deferred(), deferred()];
  let releaseCount = 0, clock = 10;
  const errors = [];
  const gate = createFrameBackpressure({ getFence: () => fences.shift().promise,
    onError: error => errors.push(error), now: () => clock });
  const first = fences[0], second = fences[1];
  const armFirst = gate.retain(() => releaseCount++);
  assert.equal(gate.shouldPump(), true);
  const armSecond = gate.retain(() => releaseCount++);
  assert.equal(gate.shouldPump(), false);
  assert.throws(() => gate.retain(() => {}), /already occupied/);
  armFirst(); armFirst(); armSecond();
  assert.equal(releaseCount, 0, 'GPU completion must own both present slots');
  clock = 30;
  first.resolve();
  await turn();
  assert.equal(releaseCount, 1);
  assert.equal(gate.shouldPump(), true);
  second.reject(new Error('device lost'));
  await turn();
  assert.equal(releaseCount, 2);
  assert.equal(errors.length, 1);
  assert.deepEqual(gate.report(), { pending: 0, maximumPending: 2, submitted: 2,
    completed: 2, failed: 1, skippedPumps: 1, lastCompletionMs: 20,
    maximumCompletionMs: 20, limit: 2 });
}
{
  let released = 0;
  const gate = createFrameBackpressure({ getFence() { throw new Error('queue unavailable'); },
    onError() { throw new Error('reporting also failed'); } });
  gate.retain(() => released++)();
  assert.equal(released, 1, 'Synchronous fence/reporting errors must release the slot');
  assert.equal(gate.report().pending, 0);
}

const derived = process.argv[2] === '--derived';
const bundle = process.argv[derived ? 3 : 2];
if ((process.argv[2] && !derived) || (derived && !bundle)) throw new Error('Usage: node tools/test-frame-backpressure.mjs [--derived BUNDLE [PROVENANCE]]');
if (bundle) {
  const output = resolve(bundle);
  {
    let provenance;
    if (derived) {
      const explicit = process.argv[4];
      const recorded = new URL('../testing/frame-backpressure.json', import.meta.url);
      let bytes;
      try { bytes = await readFile(explicit ? resolve(explicit) : recorded); }
      catch (error) {
        if (explicit || error.code !== 'ENOENT') throw error;
        bytes = await readFile(join(output, 'frame-backpressure-provenance.json'));
      }
      provenance = JSON.parse(bytes);
      assert.equal(provenance.schema, 1);
      assert.equal(provenance.frameLimit, 2);
      assert.deepEqual(provenance.outputs.map(row => row.path).sort(),
        ['frame-backpressure.mjs', 'gpu-rpc-worker.js', 'webgpu-host.js']);
      for (const row of provenance.outputs) {
        const artifact = await readFile(join(output, row.path));
        assert.equal(artifact.length, row.bytes, 'Release artifact size differs: ' + row.path);
        assert.equal(createHash('sha256').update(artifact).digest('hex'), row.sha256,
          'Release artifact hash differs: ' + row.path);
      }
      assert.deepEqual(await readFile(join(output, 'frame-backpressure.mjs')),
        await readFile(new URL('../public/auth/frame-backpressure.mjs', import.meta.url)),
        'The release must execute the tested frame-credit helper');
    }
    assert.equal(provenance.outputs.length, 3);
    const source = await readFile(join(output, 'gpu-rpc-worker.js'), 'utf8');
    // Exercise the exact RPC handler with shared slots and a controlled queue.
    // Current clients reserve separate GPU credits; legacy clients retain slots.
    const start = source.indexOf('  function handle(msg) {');
    const end = source.indexOf('\n  const describeArg', start);
    assert.ok(start >= 0 && end > start);
    const separatedCredits = source.includes('const { slot, base, len: reqLen, frameCredit } = msg;');
    if (separatedCredits) {
      const client = await readFile(join(output, 'javavm.js'), 'utf8');
      assert.match(client, /Atomics\.store\(i32,\s*10,\s*2\)/,
        'The packaged client must initialize the separate two-frame credit pool');
      assert.match(client, /Atomics\.compareExchange\(i32,\s*10,\s*available,\s*available - 1\)/,
        'The packaged client must reserve a GPU credit before sending a present');
      assert.match(client, /port\.postMessage\(\{[\s\S]*?frameCredit[\s\S]*?\}\)/,
        'The packaged client must send its credit reservation to the handler');
    }
    const sab = new SharedArrayBuffer(16384);
    const i32 = new Int32Array(sab, 0, 16);
    const data = new Uint8Array(sab, 4096);
    i32[8] = i32[9] = 1;
    if (separatedCredits) i32[10] = 2;
    const fences = [], events = [], logs = [];
    const gate = createFrameBackpressure({ getFence() {
      events.push('fence');
      const fence = deferred(); fences.push(fence); return fence.promise;
    } });
    const context = { i32, data, discarded: false, rpcCount: 0, decoder: new TextDecoder(), encoder: new TextEncoder(),
      Atomics, performance, frameBackpressure: gate, log: value => logs.push(value),
      runBatch(batch) {
        for (const call of batch) {
          events.push(call.m);
          if (call.m === 'throw') throw new Error('render failed');
        }
        return ['answer'];
      } };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end) + '\nglobalThis.testHandle = handle;', context);
    const request = (slot, batch, async) => {
      assert.equal(Atomics.load(i32, 8 + slot), 1, 'Client must own its slot before writing');
      const base = slot * 4096;
      const bytes = new TextEncoder().encode(JSON.stringify({ batch, ...(async ? { async: true } : {}) }));
      const frameCredit = separatedCredits && Boolean(async)
        && batch.some(call => call.o === 'gpu' && call.m === 'present');
      if (frameCredit) {
        assert.ok(Atomics.load(i32, 10) > 0, 'A present requires an available GPU frame credit');
        Atomics.sub(i32, 10, 1);
      }
      data.set(bytes, base);
      i32[8 + slot] = 0; i32[1] = 0;
      context.testHandle({ slot, base, len: bytes.length, ...(separatedCredits ? { frameCredit } : {}) });
    };
    request(0, [{ o: 'gpu', m: 'acquireCanvasTexture' }, { o: 'gpu', m: 'present' }], true);
    assert.deepEqual(events, ['acquireCanvasTexture', 'present', 'fence']);
    assert.equal(i32[8], separatedCredits ? 1 : 0,
      separatedCredits ? 'A copied present must release its transport slot immediately'
        : 'The legacy present batch must retain its shared slot');
    if (separatedCredits) assert.equal(i32[10], 1, 'GPU completion owns the separate frame credit');
    request(1, [{ o: 'input', m: 'drain' }], false);
    assert.equal(i32[9], 1);
    assert.equal(i32[1], 1, 'Ordinary synchronous input must respond while a frame fence is pending');
    const response = JSON.parse(new TextDecoder().decode(data.slice(4096, 4096 + i32[3])));
    assert.deepEqual(response.results, ['answer']);
    request(1, [{ o: 'gpu', m: 'present' }], true);
    assert.equal(i32[9], separatedCredits ? 1 : 0);
    assert.equal(gate.report().pending, 2);
    if (separatedCredits) {
      assert.equal(i32[10], 0, 'Both pending GPU frames consume their credits');
      request(0, [{ o: 'input', m: 'drain' }], false);
      assert.equal(i32[1], 1, 'Synchronous input must respond with two GPU frames pending');
      assert.deepEqual([i32[8], i32[9], i32[10]], [1, 1, 0]);
      assert.equal(gate.report().pending, 2, 'Ordinary input cannot release a GPU frame');
    }
    fences[0].resolve(); await turn();
    assert.equal(i32[8], 1);
    assert.equal(i32[9], separatedCredits ? 1 : 0);
    if (separatedCredits) assert.equal(i32[10], 1, 'Each frame releases only its own GPU credit');
    fences[1].reject(new Error('device lost')); await turn();
    assert.equal(i32[9], 1);
    if (separatedCredits) assert.equal(i32[10], 2, 'A rejected GPU fence must refund its credit');
    request(0, [{ o: 'gpu', m: 'writeBufferRaw' }], true);
    assert.equal(i32[8], 1, 'Split/ordinary async batches remain immediate');
    assert.equal(fences.length, 2, 'Only complete presents create queue fences');
    request(1, [{ o: 'gpu', m: 'throw' }, { o: 'gpu', m: 'present' }], true);
    assert.equal(i32[9], separatedCredits ? 1 : 0,
      'A partially submitted failed batch retains only its completion reservation');
    if (separatedCredits) assert.equal(i32[10], 1);
    assert.ok(logs.some(line => line.includes('async batch failed: render failed')));
    fences[2].resolve(); await turn();
    assert.equal(i32[9], 1);
    assert.equal(gate.report().pending, 0);
    if (separatedCredits) {
      assert.equal(i32[10], 2);
      Atomics.sub(i32, 10, 1);
      i32[8] = 0;
      data[0] = 123; // Malformed JSON after a client has reserved a credit.
      context.testHandle({ slot: 0, base: 0, len: 1, frameCredit: true });
      assert.deepEqual([i32[8], i32[9], i32[10]], [1, 1, 2],
        'Malformed requests must release their transport slot and reserved GPU credit');
      assert.equal(gate.report().pending, 0);
      assert.equal(gate.report().maximumPending, 2);
    }
    console.log('Derived RPC ' + (separatedCredits ? 'separate-credit' : 'legacy shared-slot')
      + ', ordering, ordinary input and error tests passed');
  }
}
console.log('Frame backpressure lifecycle tests passed');
