import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Script } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { createRuntimeArchive, mobileConfig, neutralizeBuildPaths, translateNaga, verifyMobileRuntime } from './prepare-public-runtime.mjs';
import { MAX_ARCHIVE_BYTES, scanPublicBytes, sha256, unpackPublicRuntime, validateManifest, verifyRuntimeArchive } from './unpack-public-runtime.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pythonArchive = String.raw`
import base64,gzip,io,json,tarfile,sys
spec=json.load(sys.stdin)
out=io.BytesIO()
with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as archive:
    for entry in spec['entries']:
        info=tarfile.TarInfo(entry['path'])
        body=base64.b64decode(entry['body'])
        info.size=len(body)
        info.mode=0o644
        if entry.get('type')=='symlink': info.type=tarfile.SYMTYPE;info.linkname='outside';info.size=0
        if entry.get('type')=='hardlink': info.type=tarfile.LNKTYPE;info.linkname='outside';info.size=0
        archive.addfile(info,io.BytesIO(body))
sys.stdout.buffer.write(gzip.compress(out.getvalue()[:spec['tarBytes']],mtime=0))
`;

function fixture(entries = [['asset.txt', Buffer.from('verified runtime fixture')]], tarEntries = null) {
  const files = Object.fromEntries(entries.map(([path, body]) => [path, { bytes: body.length, sha256: sha256(body) }]));
  const tarBytes = 1024 + entries.reduce((sum, [, body]) => sum + 512 + Math.ceil(body.length / 512) * 512, 0);
  const archive = execFileSync('python3', ['-c', pythonArchive], {
    timeout: 10_000, input: JSON.stringify({ tarBytes, entries: (tarEntries || entries.map(([path, body]) => ({ path, body })))
      .map(entry => ({ ...entry, body: entry.body.toString('base64') })) }),
  });
  return { archive, manifest: { schema: 1, kind: 'public-browser-runtime', files,
    archive: { path: 'runtime.tar.gz', bytes: archive.length, sha256: sha256(archive), tarBytes,
      filesBytes: entries.reduce((sum, [, body]) => sum + body.length, 0) } } };
}

function withArchive(fixture, archive) {
  return { archive, manifest: { ...fixture.manifest, archive: { ...fixture.manifest.archive,
    bytes: archive.length, sha256: sha256(archive) } } };
}

test('verifies a standard-library tar fixture and creates deterministic archives', () => {
  const original = fixture();
  assert.equal(verifyRuntimeArchive(original.archive, original.manifest).get('asset.txt').toString(), 'verified runtime fixture');
  const files = new Map([['b.txt', Buffer.from('b')], ['a.txt', Buffer.from('a')]]);
  const one = createRuntimeArchive(files), two = createRuntimeArchive(new Map([...files].reverse()));
  assert.deepEqual(one.bytes, two.bytes);
  assert.equal(one.tarBytes, 3072);
});

test('rejects hostile manifests and unsafe names before parsing an archive', () => {
  const original = fixture();
  for (const path of ['../outside', '/absolute', 'dir/../outside', 'dir\\outside', '.hidden', 'dir//asset', 'serve.mjs', 'mc-relay.mjs']) {
    const manifest = structuredClone(original.manifest);
    manifest.files = { [path]: original.manifest.files['asset.txt'] };
    assert.throws(() => validateManifest(manifest), /Unsafe|Development/);
  }
  for (const change of [
    manifest => { manifest.schema = 2; },
    manifest => { manifest.files['asset.txt'].sha256 = 'bad'; },
    manifest => { manifest.files['asset.txt'].bytes = 2 ** 31; },
    manifest => { manifest.archive.bytes = MAX_ARCHIVE_BYTES; },
    manifest => { manifest.archive.path = '../runtime.tar.gz'; },
    manifest => { manifest.archive.filesBytes++; },
    manifest => { manifest.archive.tarBytes++; },
    manifest => { manifest.files = Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`f${i}`, {bytes:0,sha256:sha256(Buffer.alloc(0))}])); },
  ]) {
    const manifest = structuredClone(original.manifest); change(manifest);
    assert.throws(() => validateManifest(manifest), /Invalid/);
  }
});

test('rejects changed bytes, unexpected files, duplicate order and archive links', () => {
  const original = fixture();
  const changedArchive = Buffer.from(original.archive); changedArchive[changedArchive.length - 1] ^= 1;
  assert.throws(() => verifyRuntimeArchive(changedArchive, original.manifest), /checksum or size/);
  const wrongFile = structuredClone(original.manifest); wrongFile.files['asset.txt'].sha256 = '0'.repeat(64);
  assert.throws(() => verifyRuntimeArchive(original.archive, wrongFile), /file checksum/);
  const unlisted = fixture([['asset.txt', Buffer.from('body')]], [{path:'other.txt',body:Buffer.from('body')}]);
  assert.throws(() => verifyRuntimeArchive(unlisted.archive, unlisted.manifest), /metadata/);
  const entries = [['a.txt', Buffer.from('a')], ['b.txt', Buffer.from('b')]];
  for (const paths of [['b.txt','a.txt'], ['a.txt','a.txt']]) {
    const hostile = fixture(entries, paths.map(path => ({path,body:Buffer.from(path[0])})));
    assert.throws(() => verifyRuntimeArchive(hostile.archive, hostile.manifest), /Unsorted|duplicate|checksum/);
  }
  for (const type of ['symlink','hardlink']) {
    const hostile = fixture([['asset.txt',Buffer.alloc(0)]], [{path:'asset.txt',body:Buffer.alloc(0),type}]);
    assert.throws(() => verifyRuntimeArchive(hostile.archive, hostile.manifest), /entry type/);
  }
  const bomb = withArchive(original, gzipSync(Buffer.alloc(original.manifest.archive.tarBytes + 1)));
  assert.throws(() => verifyRuntimeArchive(bomb.archive, bomb.manifest), /oversized/);
});

test('validates every member before creating the destination and refuses existing or linked destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-runtime-test-'));
  try {
    const valid = fixture();
    const archivePath = join(root, 'runtime.tar.gz'), manifestPath = join(root, 'runtime.json');
    await writeFile(archivePath, valid.archive);
    const bad = structuredClone(valid.manifest); bad.files['asset.txt'].sha256 = '0'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(bad));
    const destination = join(root, 'not-created/runtime');
    await assert.rejects(unpackPublicRuntime({archivePath,manifestPath,destination}), /checksum/);
    assert.equal(await stat(dirname(destination)).catch(() => null), null);
    await writeFile(manifestPath, JSON.stringify(valid.manifest));
    const verified = await unpackPublicRuntime({archivePath,manifestPath,verifyOnly:true});
    assert.deepEqual(verified, {files:1,bytes:24});
    await unpackPublicRuntime({archivePath,manifestPath,destination});
    assert.equal(await readFile(join(destination,'asset.txt'),'utf8'), 'verified runtime fixture');
    await assert.rejects(unpackPublicRuntime({archivePath,manifestPath,destination}), /already exists/);
    await symlink(dirname(destination), join(root,'linked-parent'));
    await assert.rejects(unpackPublicRuntime({archivePath,manifestPath,destination:join(root,'linked-parent/new')}), /Linked/);
    await symlink(archivePath,join(root,'linked-archive'));
    await assert.rejects(unpackPublicRuntime({archivePath:join(root,'linked-archive'),manifestPath,destination:join(root,'another')}), /regular file/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('path neutralization changes only build-prefix bytes and keeps Wasm offsets intact', () => {
  const prefix = ['', 'home', 'fixture-user', 'checkout', 'runtime', ''].join('/');
  const input = Buffer.from(`before\0${prefix}src/lib.rs\0middle\0${prefix}tools/lib.rs\0after`);
  const binary = neutralizeBuildPaths(input,{sameLength:true});
  assert.equal(binary.bytes.length,input.length);
  assert.equal(binary.operations.length,1);
  assert.equal(binary.operations[0].count,2);
  const replacement = binary.operations[0].replacement;
  assert.deepEqual(binary.bytes,Buffer.from(input.toString().replaceAll(prefix,replacement)));
  assert.throws(() => scanPublicBytes(input), /Private/);
  scanPublicBytes(binary.bytes);
  const loader = neutralizeBuildPaths(input);
  assert.deepEqual(loader.bytes,Buffer.from(input.toString().replaceAll(prefix,'/build/runtime/')));
  scanPublicBytes(Buffer.from('/home/web_user'));
});

test('the packaged runtime is complete, private-path free and compiles the affected modules', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT,'artifacts/runtime.json'),'utf8'));
  const files = verifyRuntimeArchive(await readFile(join(ROOT,'artifacts/runtime.tar.gz')),manifest);
  assert.equal(files.size,102);
  assert.deepEqual(Object.keys(manifest.files).filter(path => manifest.files[path].baseSha256 !== manifest.files[path].sha256).sort(), ['index.html','javavm.js','nagamin.wasm','wasmjvm-manifest.json']);
  assert.ok(manifest.files['javavm.js'].bytes < manifest.files['javavm.js'].baseBytes);
  assert.equal(manifest.files['nagamin.wasm'].bytes,manifest.files['nagamin.wasm'].baseBytes);
  for (const path of ['serve.mjs','mc-relay.mjs']) assert.equal(files.has(path),false);
  new Script(files.get('javavm.js').toString('utf8'));
  new WebAssembly.Module(files.get('javavm.wasm'));
  new WebAssembly.Module(files.get('nagamin.wasm'));
  const translated = translateNaga(files.get('nagamin.wasm'), '#version 450\nlayout(location=0) in vec3 position; void main() { gl_Position=vec4(position,1.0); }', 0);
  assert.equal(translated.status,0);
  assert.match(translated.text,/@vertex/);
  assert.equal(manifest.validation.basePublicationAudit.violations,0);
  assert.equal(manifest.validation.derivedPublicationAudit.violations,0);
  assert.equal(manifest.validation.nagaTranslationsMatchBase,2);
  assert.ok(manifest.validation.zipPrivacyScan.entries>1000);
  const config = mobileConfig(files);
  assert.deepEqual(config.loader, {bytes:files.get('javavm.js').length,sha256:sha256(files.get('javavm.js'))});
  assert.equal(JSON.parse(files.get('wasmjvm-manifest.json')).runtime.javavmJsSha256, config.loader.sha256);
  const prepared = await verifyMobileRuntime(files);
  assert.deepEqual(prepared, {loaderChecksum:true,compiledLibraries:config.libraries.length,factoryEvaluated:true});
  await assert.rejects(verifyMobileRuntime(files, {...config,loader:{bytes:manifest.files['javavm.js'].baseBytes,sha256:manifest.files['javavm.js'].baseSha256}}), /release checksum/);
});
