import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dependencyNoticePaths, stageDependencyNotices, stageDependencySources, verifyDependencyNotices } from './dependency-notices.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mcweb-dependency-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(source, 'licenses'), join(root, 'licenses'), { recursive: true });
  await mkdir(join(root, 'runtime/tools/naga-wasm'), { recursive: true });
  await cp(join(source, 'runtime/tools/naga-wasm/Cargo.lock'), join(root, 'runtime/tools/naga-wasm/Cargo.lock'));
  const manifest = JSON.parse(await readFile(join(root, 'licenses/dependency-notices.json')));
  const thirdParty = { libraries: manifest.jarComponents.flatMap(row => row.jars), wasm: [{ artifact: 'nagamin.wasm', crates: manifest.components.map(({ crate, version, license }) => ({ crate, version, license })) }] };
  return { root, manifest, thirdParty };
}

test('publishes unchanged notice texts for the complete packaged Rust graph', async t => {
  const { root, manifest, thirdParty } = await fixture(t);
  const site = join(root, 'site');
  const records = await stageDependencyNotices({ root, site, thirdParty: Buffer.from(JSON.stringify(thirdParty)) });
  assert.equal(thirdParty.wasm[0].crates.length, 32);
  assert.equal(records.length, 1 + manifest.components.reduce((sum, row) => sum + row.files.length, 0) + manifest.jarComponents.reduce((sum, row) => sum + row.files.length, 0));
  assert.deepEqual(await dependencyNoticePaths(root), records.map(row => row.path));
  for (const row of records) assert.deepEqual(await readFile(join(site, row.publicPath.slice(1))), await readFile(join(root, row.path)));
  const libm = records.find(row => row.path.includes('/libm-'));
  assert.match(await readFile(join(site, libm.publicPath.slice(1)), 'utf8'), /Copyright \(c\) 2018 Jorge Aparicio/);
  assert.ok(records.some(row => row.path.includes('LICENSE-UNICODE')));
  assert.ok(records.some(row => row.path.includes('COPYRIGHT')));
  assert.ok(records.some(row => row.path.includes('/Netty-') && row.path.includes('NOTICE.txt')));
  assert.ok(records.some(row => row.path.includes('/LWJGL-') && row.path.includes('LICENSE.md')));
  assert.ok(records.some(row => row.path.includes('/JOrbis-') && row.path.includes('COPYING.LIB')));
});

test('rejects substituted and missing JARs covered by the supplied notice sets', async t => {
  const { root, thirdParty } = await fixture(t);
  const changed = structuredClone(thirdParty);
  changed.libraries[0].sha256 = '0'.repeat(64);
  await assert.rejects(verifyDependencyNotices({ root, thirdParty: changed }), /Packaged JAR differs/);
  changed.libraries.shift();
  await assert.rejects(verifyDependencyNotices({ root, thirdParty: changed }), /Packaged JAR differs/);
  const uncovered = structuredClone(thirdParty);
  uncovered.libraries.push({ maven: 'fixture:unreviewed:1', file: 'unreviewed.jar', sha256: '0'.repeat(64), licenseFiles: [] });
  await assert.rejects(verifyDependencyNotices({ root, thirdParty: uncovered }), /lacks embedded or supplemental/);
});

test('ships verified corresponding library source from a local cache and rejects altered input', async t => {
  const { root, manifest } = await fixture(t);
  const component = manifest.jarComponents.find(row => row.source?.accompanyBinary);
  const body = Buffer.from('application-owned source-download fixture');
  component.source.bytes = body.length;
  component.source.sha256 = createHash('sha256').update(body).digest('hex');
  await writeFile(join(root, 'licenses/dependency-notices.json'), JSON.stringify(manifest));
  const cache = join(root, 'source-cache'), site = join(root, 'site');
  await mkdir(cache);
  const input = join(cache, `${component.name}-sources.jar`);
  await assert.rejects(stageDependencySources({ root, site, cache }), { code: 'ENOENT' });
  await writeFile(input, body);
  const records = await stageDependencySources({ root, site, cache });
  assert.equal(records.length, 1);
  assert.deepEqual(await readFile(join(site, records[0].publicPath.slice(1))), body);
  await writeFile(input, 'altered source');
  await assert.rejects(stageDependencySources({ root, site, cache }), /checksum mismatch/);
});

test('rejects newly added, removed and relicensed packaged crates', async t => {
  const { root, thirdParty } = await fixture(t);
  for (const mutate of [
    crates => crates.push({ crate: 'unreviewed', version: '1.0.0', license: 'MIT' }),
    crates => crates.pop(),
    crates => { crates[0].license = 'Unreviewed'; },
  ]) {
    const changed = structuredClone(thirdParty);
    mutate(changed.wasm[0].crates);
    await assert.rejects(verifyDependencyNotices({ root, thirdParty: changed }), /graph differs/);
  }
  await assert.rejects(verifyDependencyNotices({ root, thirdParty: { wasm: [] } }), /Missing packaged/);
});

test('rejects modified notice text, symlinks and a changed Cargo lock', async t => {
  const { root, manifest, thirdParty } = await fixture(t);
  const row = manifest.components[0].files[0];
  const original = await readFile(join(root, row.path));
  await writeFile(join(root, row.path), 'changed');
  await assert.rejects(verifyDependencyNotices({ root, thirdParty }), /checksum mismatch/);
  await rm(join(root, row.path));
  await symlink(join(source, row.path), join(root, row.path));
  await assert.rejects(verifyDependencyNotices({ root, thirdParty }), /Non-regular/);
  await rm(join(root, row.path));
  await writeFile(join(root, row.path), original);
  await writeFile(join(root, manifest.lockPath), '# changed lock');
  await assert.rejects(verifyDependencyNotices({ root, thirdParty }), /do not match Cargo.lock/);
});
