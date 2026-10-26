import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { deflateRawSync, gzipSync } from 'node:zlib';

const source = await readFile(new URL('../public/auth/game-library.js', import.meta.url), 'utf8');
let running = false;
const rows = new Map();
const store = {
  ready: async () => true,
  status: () => ({ available: true, running }),
  list: async () => [...rows].map(([path, bytes]) => ({ path, bytes: bytes.length })),
  read: async path => rows.get(path).slice(), flush: async () => {},
  importFiles: async files => {
    for (const file of files) if (rows.has(file.path)) throw new Error('Conflict');
    for (const file of files) rows.set(file.path, file.bytes.slice());
  },
  removeTree: async prefix => { for (const path of rows.keys()) if (path.startsWith(prefix + '/')) rows.delete(path); },
  exportTree: async prefix => [...rows].filter(([path]) => path.startsWith(prefix + '/')).map(([path, bytes]) => ({ path, bytes: bytes.slice() })),
};
const context = vm.createContext({ mcWebGameStorage: store, TextDecoder, TextEncoder, Uint8Array, Uint32Array, DataView, Blob, DecompressionStream });
vm.runInContext(source, context);
const library = context.mcWebGameLibrary;
const bytes = text => new TextEncoder().encode(text);
const file = async (entries, name = 'Example.zip') => {
  const blob = library.zip(entries.map(([path, value]) => ({ path, bytes: typeof value === 'string' ? bytes(value) : value })));
  return new File([blob], name);
};
const pack = await file([['Wrapper/pack.mcmeta', '{"pack":{"pack_format":80,"description":"Example"}}'], ['Wrapper/assets/test/textures/test.png', 'texture bytes']]);
const slicedOnly = { name: pack.name, size: pack.size, slice: pack.slice.bind(pack), arrayBuffer: () => { throw new Error('Do not read the entire archive'); } };
assert.equal((await library.unzip(slicedOnly)).length, 2, 'Importer only reads Blob slices, never the full archive');
assert.throws(() => library.zip([{ path: 'large', bytes: { length: library.limits.bytes } }]), /512 MiB export limit/, 'ZIP headers count toward a roundtrippable export bound before allocation');
const installed = await library.importZip('pack', pack);
assert.equal(installed.name, 'Wrapper');
assert.deepEqual([...rows.keys()], ['resourcepacks/Wrapper/pack.mcmeta', 'resourcepacks/Wrapper/assets/test/textures/test.png']);
assert.equal((await library.importZip('pack', pack)).name, 'Wrapper (2)');
const backup = await library.exportZip('pack', 'Wrapper');
const exported = await library.unzip(backup);
assert.deepEqual(Array.from(exported, row => row.path), ['pack.mcmeta', 'assets/test/textures/test.png']);
assert.equal(new TextDecoder().decode(exported[1].bytes), 'texture bytes');
await library.remove('pack', 'Wrapper');
assert.equal((await library.list('pack')).length, 1);
const world = await file([['World/level.dat', new Uint8Array(gzipSync(Uint8Array.of(10, 0, 0, 0)))], ['World/region/r.0.0.mca', 'region bytes'], ['World/session.lock', 'discard']]);
await library.importZip('world', world);
assert.ok(rows.has('saves/World/region/r.0.0.mca'));
assert.ok(!rows.has('saves/World/session.lock'));
const worldBackup = await library.exportZip('world', 'World');
assert.equal((await library.unzip(worldBackup)).length, 2);
const before = rows.size;
await assert.rejects(library.importZip('world', await file([['level.dat', 'Bedrock header']])), /Java Edition/);
await assert.rejects(library.importZip('world', await file([['readme.txt', 'bad']])), /level.dat/);
await assert.rejects(library.importZip('pack', await file([['pack.mcmeta', '{}']])), /does not describe/);
await assert.rejects(library.importZip('pack', await file([['pack.mcmeta', ' '.repeat(1024 * 1024 + 1)]])), /metadata limit/);
assert.equal(rows.size, before, 'Invalid archives never write player files');
running = true;
await assert.rejects(library.importZip('world', world), /Exit the game/);
await assert.rejects(library.exportZip('world', 'World'), /Exit the game/);
await assert.rejects(library.remove('pack', 'Wrapper (2)'), /Exit the game/);
assert.equal((await library.importZip('pack', pack)).name, 'Wrapper');
running = false;
// Corruption and unsafe central/local names are rejected before any commit.
const corrupt = new Uint8Array(await pack.arrayBuffer());
corrupt[30 + new TextEncoder().encode('Wrapper/pack.mcmeta').length] ^= 1;
await assert.rejects(library.importZip('pack', new File([corrupt], 'bad.zip')), /damaged/);
const traversal = new Uint8Array(await (await file([['aa/level.dat', 'bad']])).arrayBuffer());
for (let i = 0; i < traversal.length - 12; i++) {
  if (new TextDecoder().decode(traversal.subarray(i, i + 12)) === 'aa/level.dat') traversal.set(bytes('../level.dat'), i);
}
await assert.rejects(library.unzip(new Blob([traversal])), /unsafe/);
// A real DEFLATE ZIP fixture, independent of our STORE exporter.
const raw = bytes('deflated resource pack'.repeat(100));
const compressed = deflateRawSync(raw), name = bytes('test.txt');
const header = new Uint8Array(30 + name.length), hv = new DataView(header.buffer);
hv.setUint32(0, 0x04034b50, true); hv.setUint16(4, 20, true); hv.setUint16(8, 8, true);
hv.setUint32(14, library.crc32(raw), true); hv.setUint32(18, compressed.length, true); hv.setUint32(22, raw.length, true); hv.setUint16(26, name.length, true); header.set(name, 30);
const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
cv.setUint32(0, 0x02014b50, true); cv.setUint16(6, 20, true); cv.setUint16(10, 8, true); cv.setUint32(16, library.crc32(raw), true); cv.setUint32(20, compressed.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, name.length, true); central.set(name, 46);
const end = new Uint8Array(22), ev = new DataView(end.buffer);
ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, central.length, true); ev.setUint32(16, header.length + compressed.length, true);
const fixture = new Blob([header, compressed, central, end]);
assert.deepEqual((await library.unzip(fixture))[0].bytes, raw);
console.log('Game library: ZIP pack/world roundtrips, DEFLATE, conflict suffix, corruption, traversal, invalid metadata and running-game restrictions passed.');
