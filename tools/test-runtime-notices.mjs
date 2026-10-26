import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishableSourcePath, repositoryState, runtimeNoticePage, sourceArchive } from './stage-runtime-notices.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(join(root, 'testing/runtime-source.json'), 'utf8'));
const release = JSON.parse(await readFile(join(root, 'testing/release.json'), 'utf8'));

test('source manifest state binds the staged tree to the workflow revision', async () => {
  const revision = 'a'.repeat(40);
  const clean = await repositoryState({ root: '/checkout', environment: { GITHUB_SHA: revision },
    run: async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? `${revision}\n` : '' }) });
  assert.deepEqual(clean, { revision, dirty: false });
  const dirty = await repositoryState({ root: '/checkout', environment: {},
    run: async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? `${revision}\n` : ' M server/app.mjs\n' }) });
  assert.deepEqual(dirty, { revision, dirty: true });
  await assert.rejects(repositoryState({ root: '/checkout', environment: { GITHUB_SHA: 'b'.repeat(40) },
    run: async () => ({ stdout: `${revision}\n` }) }), /GITHUB_SHA does not match/);
});

test('source download is deterministic, preserves source and executable mode, and rejects changed bytes', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'mcweb-source-offer-'));
  try {
    await mkdir(join(fixture, 'runtime/OpenJDK'), { recursive: true });
    const bodies = new Map([['LICENSE', 'fixture license\n'], ['runtime/OpenJDK/setup.sh', '#!/bin/sh\nexit 0\n']]);
    const entries = [];
    for (const [path, body] of bodies) {
      await writeFile(join(fixture, path), body);
      await chmod(join(fixture, path), path.endsWith('.sh') ? 0o755 : 0o644);
      entries.push({ path, bytes: Buffer.byteLength(body), sha256: hash(body) });
    }
    const a = await sourceArchive({ root: fixture, output: join(fixture, 'first.tar.gz'), entries });
    const b = await sourceArchive({ root: fixture, output: join(fixture, 'second.tar.gz'), entries: [...entries].reverse() });
    assert.equal(a.sha256, b.sha256);
    const unpacked = JSON.parse(execFileSync('python3', ['-c',
      'import json,sys,tarfile; t=tarfile.open(sys.argv[1]); print(json.dumps([{ "path":m.name,"mode":m.mode,"uid":m.uid,"mtime":m.mtime,"body":t.extractfile(m).read().decode()} for m in t.getmembers()]))', join(fixture, 'first.tar.gz')], { encoding: 'utf8' }));
    assert.deepEqual(unpacked.map(row => row.path), [...bodies.keys()]);
    for (const row of unpacked) {
      assert.equal(row.body, bodies.get(row.path));
      assert.equal(row.mode, row.path.endsWith('.sh') ? 0o755 : 0o644);
      assert.equal(row.uid, 0); assert.equal(row.mtime, 0);
    }
    await writeFile(join(fixture, 'LICENSE'), 'changed');
    await assert.rejects(sourceArchive({ root: fixture, output: join(fixture, 'bad.tar.gz'), entries }), /Source changed after audit/);
    await rm(join(fixture, 'LICENSE'));
    await symlink(join(fixture, 'runtime/OpenJDK/setup.sh'), join(fixture, 'LICENSE'));
    await assert.rejects(sourceArchive({ root: fixture, output: join(fixture, 'linked.tar.gz'), entries }), /symbolic links/i);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('source offer refuses caches, credentials, worlds, binaries and escaping paths', () => {
  for (const path of ['../secret', '/tmp/secret', 'runtime\\secret', '.env', 'gateway/.env.production',
    'runtime/build/mojang-cache/client.jar', 'runtime/OpenJDK/work/private.c', 'site/testing/javavm.js',
    'runtime/private/session.json', 'runtime/test-server/world.dat', 'player/worlds/level.dat',
    'gateway/cert.pem', 'gateway/client.key', 'runtime/node_modules/example.js', 'runtime/game.wasm']) {
    assert.throws(() => publishableSourcePath(path), /unsafe source path|Forbidden source-archive path/);
  }
  assert.equal(publishableSourcePath('runtime/OpenJDK/patches/0026-zero-wasm-jit-no-replayed-volatile-stores.patch'),
    'runtime/OpenJDK/patches/0026-zero-wasm-jit-no-replayed-volatile-stores.patch');
});

test('the source notice page names every pinned license and the source offer', async () => {
  const records = [...lock.dependencyNotices, lock.projectNotice];
  const source = { runtime: release.files['libjvm.so'], sourceTreeSha256: lock.upstream.sourceTreeSha256 };
  const template = await readFile(join(root, 'public/notices/index.html'), 'utf8');
  const page = runtimeNoticePage({ template, records, source });
  assert.ok(!page.includes('{{'));
  assert.ok(page.includes('/notices/corresponding-source.tar.gz'));
  assert.ok(page.includes('/notices/source.json'));
  assert.ok(page.includes(source.runtime.sha256));
  assert.ok(page.includes('GPL version 2'));
  const assets = new Map([['/notices/index.html', Buffer.from(page)]]);
  for (const record of records) {
    const bytes = await readFile(join(root, record.path));
    assert.equal(bytes.length, record.bytes); assert.equal(hash(bytes), record.sha256);
    assets.set(record.publicPath, bytes);
    assert.ok(page.includes(record.publicPath));
  }
  assert.throws(() => runtimeNoticePage({ template: template + '{{NOTICE_LINKS}}', records, source }), /Unexpected runtime notice page/);
});
