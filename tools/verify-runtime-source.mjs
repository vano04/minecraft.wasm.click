#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const rootDefault = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fail = message => { throw new Error(`verify-runtime-source: ${message}`); };

export function sourcePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/')
      || path.split('/').some(part => !part || part === '.' || part === '..')) fail(`unsafe source path: ${path}`);
  return path;
}

// These outputs may exist after a local build or test, but cannot enter Git.
const generatedDirectories = [
  'build', 'dist', 'node_modules', 'test-results', 'playwright-report', 'private',
  'test-server', 'minecraft', 'mcweb', 'probe-out', 'logs', 'tests/tmp-shots',
  'OpenJDK/work', 'OpenJDK/mcweb/classes', 'OpenJDK/mcweb/shim-classes',
  'OpenJDK/tests/classes', 'OpenJDK/tests/jarclasses', 'tools/naga-wasm/target',
  'OpenJDK/native-policy/dist',
  'src/graal/resources/assets', 'web/assets',
];
const generatedFiles = new Set([
  'OpenJDK/browser/runtime-manifest.json', 'OpenJDK/mcweb/jsbridge-report.txt',
  'OpenJDK/mcweb/jsbridge.c', 'OpenJDK/mcweb/port-build.json',
  'OpenJDK/native-policy/classpath.txt', 'OpenJDK/native-policy/current.json',
]);
export function isRuntimeGenerated(path) {
  return generatedDirectories.some(dir => path === dir || path.startsWith(`${dir}/`))
    || generatedFiles.has(path)
    || /^OpenJDK\/browser\/(?:javavm(?:-debug)?\.(?:js|wasm|data)|[^/]+\.so)$/.test(path)
    || /^OpenJDK\/mcweb\/(?:mcweb-port\.jar|libmcwebjs\.so)$/.test(path)
    || /^OpenJDK\/tests\/plugin\.jar$/.test(path)
    || /^measure-out-[^/]+(?:\/|$)/.test(path)
    || /(?:^|\/)\S+\.(?:log|profraw)$/.test(path);
}

async function regularFile(root, path) {
  sourcePath(path);
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const at = parts.slice(0, i).join('/');
    const info = await lstat(resolve(root, at)).catch(() => null);
    if (!info || info.isSymbolicLink() || (i < parts.length ? !info.isDirectory() : !info.isFile())) {
      fail(`missing, linked or non-regular source: ${at}`);
    }
  }
  return readFile(resolve(root, path));
}

export async function verifyRuntimeSource({ root = rootDefault, checkGit = true, requireReleaseMatch = false } = {}) {
  const load = async path => JSON.parse(await regularFile(root, path));
  const [lock, provenance, release] = await Promise.all([
    load('testing/runtime-source.json'), load('testing/source-provenance.json'), load('testing/release.json'),
  ]);
  if (lock.schema !== 1 || lock.kind !== 'in-repository-runtime-source' || lock.sourceRoot !== 'runtime'
      || lock.sourceOnly !== true || lock.generatedOutputsIncluded !== false
      || lock.mojangCodeOrAssetsIncluded !== false) fail('invalid integration lock');
  const publicSource = await load('testing/public-source.json').catch(error => {
    if (error.message?.includes('missing, linked or non-regular source: testing/public-source.json')) return null;
    throw error;
  });
  const files = provenance.files;
  if (!Array.isArray(files) || !files.length) fail('empty source manifest');
  const treeHash = hash(JSON.stringify(canonical(files)));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (treeHash !== provenance.sourceTreeSha256 || treeHash !== lock.upstream.sourceTreeSha256
      || files.length !== lock.selectedSourceFiles || totalBytes !== lock.selectedSourceBytes
      || provenance.baseRevision !== lock.upstream.baseRevision
      || JSON.stringify(provenance.patch) !== JSON.stringify(lock.upstream.sourcePatch)) fail('source provenance disagrees with integration lock');
  if (requireReleaseMatch && (treeHash !== release.build.sourceTreeSha256
      || files.length !== release.build.selectedSourceFiles || provenance.baseRevision !== release.build.baseRevision
      || provenance.patch.path !== release.build.sourcePatch || provenance.patch.sha256 !== release.build.sourcePatchSha256)) {
    fail('source differs from selected release; build and review a matching runtime before staging');
  }
  const patch = await regularFile(root, provenance.patch.path);
  const patchRecord = publicSource?.historicalPatch || provenance.patch;
  if (publicSource && (publicSource.schema !== 1 || publicSource.kind !== 'public-runtime-source'
      || publicSource.baseSourceTreeSha256 !== treeHash || patchRecord.baseSha256 !== provenance.patch.sha256
      || patchRecord.path !== provenance.patch.path || !Array.isArray(publicSource.files))) fail('invalid public source derivation');
  if (patch.length !== patchRecord.bytes || hash(patch) !== patchRecord.sha256) fail('historical source patch mismatch');
  for (const notice of [...(lock.dependencyNotices || []), ...(lock.projectNotice ? [lock.projectNotice] : [])]) {
    const bytes = await regularFile(root, notice.path);
    if (bytes.length !== notice.bytes || hash(bytes) !== notice.sha256) fail(`dependency notice mismatch: ${notice.path}`);
  }

  const expected = new Set();
  const selected = publicSource?.files || files;
  const selectedHash = publicSource ? hash(JSON.stringify(canonical(selected))) : treeHash;
  if (publicSource && selectedHash !== publicSource.sourceTreeSha256) fail('public source checksum mismatch');
  for (const file of selected) {
    sourcePath(file.path);
    if (expected.has(file.path) || isRuntimeGenerated(file.path)) fail(`duplicate or generated source input: ${file.path}`);
    expected.add(file.path);
    const path = `runtime/${file.path}`;
    const bytes = await regularFile(root, path);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail(`source checksum mismatch: ${path}`);
    const info = await lstat(resolve(root, path));
    if ((info.mode & 0o111) !== (file.mode === '100755' ? 0o111 : 0)) fail(`source executable mode mismatch: ${path}`);
  }
  for (const path of lock.runtimeSourceExtras.filter(path => !expected.has(path))) {
    sourcePath(path);
    if (expected.has(path) || isRuntimeGenerated(path)) fail(`invalid source extra: ${path}`);
    expected.add(path);
    await regularFile(root, `runtime/${path}`);
  }
  async function walk(path = '') {
    for (const entry of await readdir(resolve(root, 'runtime', path), { withFileTypes: true })) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (isRuntimeGenerated(child)) continue;
      if (entry.isDirectory()) await walk(child);
      else if (!entry.isFile() || !expected.has(child)) fail(`unexpected runtime source entry: ${child}`);
    }
  }
  await walk();
  if (checkGit) {
    const { stdout } = await exec('git', ['ls-files', '-z', '--', 'runtime/'], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    for (const path of stdout.split('\0').filter(Boolean)) {
      if (!expected.has(path.slice('runtime/'.length))) fail(`non-source runtime file is tracked: ${path}`);
    }
  }
  return { sourceTreeSha256: selectedHash, selectedSourceFiles: selected.length, selectedSourceBytes: selected.reduce((sum,file)=>sum+file.bytes,0),
    noticePaths: (lock.dependencyNotices || []).map(notice => notice.path),
    runtimePaths: [...expected].map(path => `runtime/${path}`).sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { runtimePaths, ...result } = await verifyRuntimeSource();
  console.log(JSON.stringify(result, null, 2));
}
