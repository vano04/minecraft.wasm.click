import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareVmIdentity } from '../public/auth/vm-identity.mjs';

const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const record = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const paths = ['/jdk/bin/libjvm.so', '/jdk/lib/zero/libjvm.so'];
const options = { baseURL: 'https://minecraft.wasm.click/testing/',
  fetchImpl: async url => { assert.equal(url.pathname, '/testing/libjvm.so'); return new Response(bytes); } };
let identity;
const gate = await prepareVmIdentity(record, { ...options, report: value => { identity = value; } });
assert.throws(() => gate.onRuntimeInitialized(), /before MEMFS/);
const checked = [];
gate.preRun({ FS: { readFile(path) { checked.push(path); return bytes.slice(); } } });
gate.onRuntimeInitialized();
assert.deepEqual(checked, paths);
assert.equal(identity.accepted, true);
for (const wrongPath of paths) {
  const mismatch = await prepareVmIdentity(record, options);
  mismatch.preRun({ FS: { readFile(path) { const result = bytes.slice(); if (path === wrongPath) result[7] = 1; return result; } } });
  assert.throws(() => mismatch.onRuntimeInitialized(), /Packaged JVM identity differs/);
}
await assert.rejects(prepareVmIdentity({ ...record, sha256: '0'.repeat(64) }, options), /release identity/);
await assert.rejects(prepareVmIdentity(record, { ios: true, modules: {} }), /not compiled/);
const mobileGate = await prepareVmIdentity(record, { ios: true,
  modules: { 'libjvm.so': await WebAssembly.compile(bytes) },
  fetchImpl: () => { throw new Error('iOS must use the existing pinned module gate'); },
  report: value => { identity = value; } });
mobileGate.onRuntimeInitialized();
assert.equal(identity.mechanism, 'ios-pinned-external-libjvm-module');
assert.deepEqual(identity.checkedPaths, []);
console.log('PASS JVM identity: both packaged paths, mismatched VM rejection before main, pinned iOS module prerequisite');
