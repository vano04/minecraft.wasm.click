import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const manifestPath = 'licenses/dependency-notices.json';
const hash = body => createHash('sha256').update(body).digest('hex');
const identity = row => `${row.crate}@${row.version}`;

async function sourceFile(root, path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')
      || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe dependency notice path');
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const stat = await lstat(join(root, ...parts.slice(0, i)));
    if (stat.isSymbolicLink() || (i === parts.length ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Non-regular dependency notice: ${path}`);
    }
  }
  return readFile(join(root, path));
}

// Local, checksum-only verification: neither audit nor packaging downloads notices.
export async function verifyDependencyNotices({ root, thirdParty } = {}) {
  const manifestBytes = await sourceFile(root, manifestPath);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schema !== 1 || manifest.kind !== 'pinned-dependency-notices' || manifest.artifact !== 'nagamin.wasm'
      || manifest.lockPath !== 'runtime/tools/naga-wasm/Cargo.lock' || !Array.isArray(manifest.components)
      || !manifest.components.length) throw new Error('Invalid dependency notice manifest');
  const lock = await sourceFile(root, manifest.lockPath);
  if (hash(lock) !== manifest.lockSha256) throw new Error('Dependency notices do not match Cargo.lock');
  const packages = new Map(lock.toString('utf8').split('[[package]]').slice(1).map(block => {
    const field = name => new RegExp(`^${name} = "([^"]+)"$`, 'm').exec(block)?.[1];
    return [`${field('name')}@${field('version')}`, field('checksum')];
  }));
  const records = [];
  const components = new Set(), paths = new Set();
  for (const component of manifest.components) {
    const id = identity(component);
    if (components.has(id) || !/^[a-zA-Z0-9_-]+$/.test(component.crate)
        || !/^[a-zA-Z0-9.+_-]+$/.test(component.version) || !component.license
        || packages.get(id) !== component.archiveSha256 || !Array.isArray(component.files) || !component.files.length) {
      throw new Error(`Invalid pinned crate notice: ${id}`);
    }
    components.add(id);
    for (const record of component.files) {
      const prefix = `licenses/Rust/${component.crate}-${component.version}/`;
      if (!record.path?.startsWith(prefix) || !record.path.endsWith('.txt') || paths.has(record.path)
          || record.publicPath !== record.path.replace(/^licenses\//, '/notices/')) throw new Error('Invalid dependency notice destination');
      const body = await sourceFile(root, record.path);
      if (body.length !== record.bytes || hash(body) !== record.sha256) throw new Error(`Dependency notice checksum mismatch: ${record.path}`);
      paths.add(record.path);
      records.push({ ...record, component: `${id} (${component.license})` });
    }
  }
  for (const component of manifest.jarComponents || []) {
    if (!/^[a-zA-Z0-9.+_-]+$/.test(component.name) || !component.license
        || !Array.isArray(component.jars) || !component.jars.length || !Array.isArray(component.files) || !component.files.length
        || (component.revision && !/^[0-9a-f]{40}$/.test(component.revision))
        || (component.source && (!component.source.url?.startsWith('https://') || !/^[0-9a-f]{64}$/.test(component.source.sha256)))) {
      throw new Error('Invalid Java dependency notice component');
    }
    for (const record of component.files) {
      if (!record.path?.startsWith(`licenses/Java/${component.name}/`) || !record.path.endsWith('.txt') || paths.has(record.path)
          || record.publicPath !== record.path.replace(/^licenses\//, '/notices/')) throw new Error('Invalid Java dependency notice destination');
      const body = await sourceFile(root, record.path);
      if (body.length !== record.bytes || hash(body) !== record.sha256) throw new Error(`Dependency notice checksum mismatch: ${record.path}`);
      paths.add(record.path);
      records.push({ ...record, component: `${component.name} (${component.license})` });
    }
  }
  if (thirdParty) {
    const inventory = typeof thirdParty === 'object' && !ArrayBuffer.isView(thirdParty) ? thirdParty : JSON.parse(thirdParty);
    const artifacts = inventory.wasm?.filter(row => row.artifact === manifest.artifact);
    if (artifacts?.length !== 1 || !Array.isArray(artifacts[0].crates)) throw new Error('Missing packaged Rust dependency graph');
    const actual = artifacts[0].crates;
    if (actual.length !== components.size || new Set(actual.map(identity)).size !== actual.length
        || actual.some(row => !components.has(identity(row)) || manifest.components.find(item => identity(item) === identity(row)).license !== row.license)) {
      throw new Error('Packaged Rust graph differs from pinned dependency notices');
    }
    for (const component of manifest.jarComponents || []) {
      for (const expected of component.jars) {
        const matches = inventory.libraries?.filter(row => row.maven === expected.maven && row.file === expected.file);
        if (matches?.length !== 1 || matches[0].sha256 !== expected.sha256) {
          throw new Error(`Packaged JAR differs from pinned dependency notices: ${expected.maven}`);
        }
      }
    }
    const coveredJars = new Set((manifest.jarComponents || []).flatMap(row => row.jars.map(jar => jar.maven)));
    const uncovered = inventory.libraries?.filter(row => row.maven && !row.licenseFiles?.length && !coveredJars.has(row.maven));
    if (uncovered?.length) throw new Error(`Packaged JAR lacks embedded or supplemental notices: ${uncovered.map(row => row.maven).join(', ')}`);
  }
  records.push({ path: manifestPath, publicPath: '/notices/dependency-notices.json', component: 'Dependency notice provenance',
    bytes: manifestBytes.length, sha256: hash(manifestBytes) });
  return records;
}

export async function dependencyNoticePaths(root) {
  return (await verifyDependencyNotices({ root })).map(row => row.path);
}

export async function stageDependencyNotices({ root, site, thirdParty }) {
  const records = await verifyDependencyNotices({ root, thirdParty });
  for (const record of records) {
    const destination = join(site, record.publicPath.slice(1));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await sourceFile(root, record.path));
  }
  return records;
}

// Packaging may obtain a pinned open-source source artifact. Verification above is
// always offline; generated source downloads never become checked-in inputs.
export async function stageDependencySources({ root, site, cache = join(root, 'build/dependency-sources'), allowDownloads = false }) {
  await verifyDependencyNotices({ root });
  const manifest = JSON.parse(await sourceFile(root, manifestPath));
  const records = [];
  for (const component of manifest.jarComponents || []) {
    const source = component.source;
    if (!source?.accompanyBinary) continue;
    if (!/^[a-zA-Z0-9.+_-]+$/.test(component.name) || !Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > 1024 * 1024
        || source.publicPath !== `/notices/sources/${component.name}-sources.jar` || !source.url.startsWith('https://')) {
      throw new Error('Invalid accompanying dependency source');
    }
    const filename = `${component.name}-sources.jar`;
    let body;
    try { body = await sourceFile(cache, filename); }
    catch (error) {
      if (error.code !== 'ENOENT' || !allowDownloads) throw error;
      const response = await fetch(source.url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Dependency source download failed: ${response.status}`);
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > source.bytes) throw new Error('Dependency source exceeds pinned size');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      body = Buffer.concat(chunks);
      if (body.length !== source.bytes || hash(body) !== source.sha256) throw new Error('Dependency source checksum mismatch');
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, filename), body, { flag: 'wx' });
    }
    if (body.length !== source.bytes || hash(body) !== source.sha256) throw new Error('Dependency source checksum mismatch');
    const destination = join(site, source.publicPath.slice(1));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, body);
    records.push({ path: source.url, publicPath: source.publicPath, component: `${component.name}: corresponding LGPL library source`, bytes: body.length, sha256: hash(body) });
  }
  return records;
}
