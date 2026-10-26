import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyRuntimeSource } from './verify-runtime-source.mjs';
import { buildPlan, expectedPortStop, verifyEmscripten } from './build-runtime.mjs';
import { stageRuntimeNotices } from './stage-runtime-notices.mjs';
import { stagePublic } from './stage-public.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'mcweb-source-test-'));
  try {
    await mkdir(join(root, 'runtime/web'), { recursive: true });
    await mkdir(join(root, 'testing/patches'), { recursive: true });
    const body = 'export const value = 1;\n', patch = 'retained source diff\n';
    const files = [{ path: 'web/host.js', bytes: Buffer.byteLength(body), sha256: hash(body), mode: '100644', change: 'unchanged' }];
    const sourceTreeSha256 = hash(JSON.stringify(canonical(files)));
    const sourcePatch = { path: 'testing/patches/source.patch', bytes: Buffer.byteLength(patch), sha256: hash(patch) };
    const provenance = { files, sourceTreeSha256, baseRevision: 'revision', patch: sourcePatch };
    const lock = { schema: 1, kind: 'in-repository-runtime-source', sourceRoot: 'runtime',
      sourceOnly: true, generatedOutputsIncluded: false, mojangCodeOrAssetsIncluded: false,
      selectedSourceFiles: 1, selectedSourceBytes: Buffer.byteLength(body), runtimeSourceExtras: ['README.md'],
      upstream: { sourceTreeSha256, baseRevision: 'revision', sourcePatch } };
    const release = { build: { sourceTreeSha256, baseRevision: 'revision', selectedSourceFiles: 1,
      sourcePatch: sourcePatch.path, sourcePatchSha256: sourcePatch.sha256 } };
    await writeFile(join(root, 'runtime/web/host.js'), body, { mode: 0o644 });
    await chmod(join(root, 'runtime/web/host.js'), 0o644);
    await writeFile(join(root, 'runtime/README.md'), 'Source fixture.\n');
    await writeFile(join(root, sourcePatch.path), patch);
    await writeFile(join(root, 'testing/runtime-source.json'), JSON.stringify(lock));
    await writeFile(join(root, 'testing/source-provenance.json'), JSON.stringify(provenance));
    await writeFile(join(root, 'testing/release.json'), JSON.stringify(release));
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('accepts the pinned source and ignores only declared local generated output', () => fixture(async root => {
  await mkdir(join(root, 'runtime/build/local'), { recursive: true });
  await writeFile(join(root, 'runtime/build/local/game.jar'), Buffer.from([0x50, 0x4b, 3, 4]));
  const result = await verifyRuntimeSource({ root, checkGit: false });
  assert.equal(result.selectedSourceFiles, 1);
  assert.deepEqual(result.runtimePaths, ['runtime/README.md', 'runtime/web/host.js']);
}));

test('refuses changed bytes, executable mode and a source-file symlink', () => fixture(async root => {
  const file = join(root, 'runtime/web/host.js');
  const original = await readFile(file);
  await writeFile(file, 'export const value = 2;\n');
  await assert.rejects(verifyRuntimeSource({ root, checkGit: false }), /checksum mismatch/);
  await writeFile(file, original);
  await chmod(file, 0o755);
  await assert.rejects(verifyRuntimeSource({ root, checkGit: false }), /executable mode mismatch/);
  await chmod(file, 0o644);
  await writeFile(join(root, 'outside.js'), original);
  await rm(file);
  await symlink(join(root, 'outside.js'), file);
  await assert.rejects(verifyRuntimeSource({ root, checkGit: false }), /linked or non-regular/);
}));

test('refuses unlisted inputs, escaped manifest paths and release/source drift', () => fixture(async root => {
  const extra = join(root, 'runtime/web/extra.jar');
  await writeFile(extra, 'unlisted');
  await assert.rejects(verifyRuntimeSource({ root, checkGit: false }), /unexpected runtime source entry/);
  await rm(extra);
  const path = join(root, 'testing/source-provenance.json');
  const original = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...original, sourceTreeSha256: 'changed' }));
  await assert.rejects(verifyRuntimeSource({ root, checkGit: false }), /source provenance disagrees/);
  const escaped = { ...original, files: [{ ...original.files[0], path: '../outside.js' }] };
  escaped.sourceTreeSha256 = hash(JSON.stringify(canonical(escaped.files)));
  const lockPath = join(root, 'testing/runtime-source.json'), releasePath = join(root, 'testing/release.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8')), release = JSON.parse(await readFile(releasePath, 'utf8'));
  lock.upstream.sourceTreeSha256 = escaped.sourceTreeSha256;
  release.build.sourceTreeSha256 = escaped.sourceTreeSha256;
  await writeFile(path, JSON.stringify(escaped));
  await writeFile(lockPath, JSON.stringify(lock));
  await writeFile(releasePath, JSON.stringify(release));
  await assert.rejects(verifyRuntimeSource({ root, checkGit: false }), /unsafe source path/);
}));

test('candidate source can be built while staging still requires the selected release source', () => fixture(async root => {
  const releasePath = join(root, 'testing/release.json');
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  release.build.sourceTreeSha256 = 'previous-reviewed-source';
  await writeFile(releasePath, JSON.stringify(release));
  assert.equal((await verifyRuntimeSource({ root, checkGit: false })).selectedSourceFiles, 1);
  await assert.rejects(verifyRuntimeSource({ root, checkGit: false, requireReleaseMatch: true }),
    /source differs from selected release/);
}));

test('staging and source publication reject a candidate before writing release output', () => fixture(async root => {
  const releasePath = join(root, 'testing/release.json');
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  release.build.sourceTreeSha256 = 'previous-reviewed-source';
  await writeFile(releasePath, JSON.stringify(release));
  const site = join(root, 'site');
  await assert.rejects(stageRuntimeNotices({ root, site, thirdParty: Buffer.from('{}') }),
    /source differs from selected release/);
  assert.equal(await stat(site).catch(() => null), null);
  await assert.rejects(stagePublic({directory:root}), /source differs from selected release/);
  assert.equal(await stat(site).catch(() => null), null);
}));

test('refuses generated artifacts even if force-added to Git', () => fixture(async root => {
  execFileSync('git', ['init', '-q'], { cwd: root });
  await mkdir(join(root, 'runtime/build'), { recursive: true });
  await writeFile(join(root, 'runtime/build/game.jar'), 'not source');
  execFileSync('git', ['add', '-f', '--', 'runtime/build/game.jar'], { cwd: root });
  await assert.rejects(verifyRuntimeSource({ root }), /non-source runtime file is tracked/);
}));

test('port bootstrap accepts only the exact incomplete-runtime stop', () => {
  const output = '\nbuild-wasmjvm: the wasm JVM runtime is incomplete in /checkout/runtime/OpenJDK/browser\n  missing: javavm.js, javavm.wasm\n';
  assert.equal(expectedPortStop({ code: 1, output, runtimePath: '/checkout/runtime' }), true);
  for (const bad of [{ code: 0, output }, { code: 2, output }, { code: 1, output: 'port compilation failed' },
    { code: 1, output: output.replace('/checkout/runtime', '/other/runtime') }]) {
    assert.equal(expectedPortStop({ ...bad, runtimePath: '/checkout/runtime' }), false);
  }
  const plan = buildPlan({ jobs: 4, mcDir: '/input/game', platform: 'linux' });
  assert.equal(plan.find(step => step.id === 'jdk').args.includes('JOBS=4'), true);
  assert.deepEqual(plan.find(step => step.id === 'package').args.slice(1), ['--mc-dir', '/input/game']);
  assert.throws(() => buildPlan({ jobs: 0 }), /--jobs/);
});

test('verifies an extracted SDK compiler without inheriting a parent Git revision', async () => {
  const emsdk = await mkdtemp(join(tmpdir(), 'mcweb-emsdk-test-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: emsdk });
    await mkdir(join(emsdk, 'upstream/emscripten'), { recursive: true });
    const source = 'compiler fixture\n';
    await writeFile(join(emsdk, 'upstream/emscripten/emcc.py'), source);
    const pin = { emsdk, version: '6.0.10', commit: 'compiler-revision', emccPySha256: hash(source) };
    const calls = [];
    const runCommand = async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'emcc (Emscripten compiler) 6.0.10 (compiler-revision)\nCopyright\n' };
    };
    await verifyEmscripten({ ...pin, runCommand });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, join(emsdk, 'upstream/emscripten/emcc'));
    assert.deepEqual(calls[0].args, ['--version']);
    assert.equal(calls[0].options.env.EM_CONFIG, join(emsdk, '.emscripten'));
    await assert.rejects(verifyEmscripten({ ...pin, runCommand: async () => ({ stdout: '6.0.10 (sdk-manager-revision)' }) }), /compiler version/);
    await writeFile(join(emsdk, 'upstream/emscripten/emcc.py'), 'modified compiler');
    await assert.rejects(verifyEmscripten({ ...pin, runCommand }), /emcc.py source/);
  } finally { await rm(emsdk, { recursive: true, force: true }); }
});
