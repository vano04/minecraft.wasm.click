#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createContext, Script } from 'node:vm';
import { auditBundle } from '../runtime/tools/wasmjvm-provenance.mjs';
import { MC_CLIENT_SHA256, MC_VERSION } from '../runtime/tools/mc-version.mjs';
import { MAX_ARCHIVE_BYTES, runtimePath, scanPublicBytes, sha256, verifyRuntimeArchive } from './unpack-public-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED = new Set(['serve.mjs', 'mc-relay.mjs']);
const BUILD_PREFIX = /\/(?:home|Users)\/[^\s\0"'`<>]+?\/runtime\//g;

export function neutralizeBuildPaths(bytes, { sameLength = false } = {}) {
  const input = Buffer.from(bytes), text = input.toString('latin1');
  const prefixes = [...new Set(text.match(BUILD_PREFIX) || [])].sort();
  let output = Buffer.from(input);
  const operations = [];
  for (const prefix of prefixes) {
    const replacement = sameLength
      ? '/build/' + 'public-source'.padEnd(prefix.length - '/build//runtime/'.length, '_') + '/runtime/'
      : '/build/runtime/';
    if (sameLength && replacement.length !== prefix.length) throw new Error('Cannot neutralize build prefix without changing its length');
    const source = Buffer.from(prefix, 'latin1'), target = Buffer.from(replacement, 'ascii');
    let at = 0, count = 0;
    const chunks = [];
    for (;;) {
      const next = output.indexOf(source, at);
      if (next < 0) break;
      chunks.push(output.subarray(at, next), target);
      at = next + source.length;
      count++;
    }
    if (count) {
      chunks.push(output.subarray(at));
      output = Buffer.concat(chunks);
      operations.push({ operation: 'neutralize-build-prefix', replacement, count,
        sameLength, originalPrefixBytes: source.length, replacementPrefixBytes: target.length });
    }
  }
  return { bytes: output, operations };
}

function writeText(header, offset, size, value) {
  const bytes = Buffer.from(value, 'ascii');
  if (bytes.length > size) throw new Error('Tar field is too long');
  bytes.copy(header, offset);
}
function writeOctal(header, offset, size, number) {
  const value = number.toString(8).padStart(size - 1, '0') + '\0';
  if (value.length !== size) throw new Error('Tar number overflow');
  header.write(value, offset, size, 'ascii');
}

export function createRuntimeArchive(files) {
  const blocks = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    runtimePath(path);
    let name = path, prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const split = path.lastIndexOf('/');
      prefix = path.slice(0, split); name = path.slice(split + 1);
    }
    const header = Buffer.alloc(512);
    writeText(header, 0, 100, name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, bytes.length);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    writeText(header, 345, 155, prefix);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(header, bytes);
    if (bytes.length % 512) blocks.push(Buffer.alloc(512 - bytes.length % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(blocks);
  return { bytes: gzipSync(tar, { level: 6 }), tarBytes: tar.length };
}

export function translateNaga(bytes, source, stage) {
  const { exports: wasm } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const encoded = new TextEncoder().encode(source), pointer = wasm.alloc(encoded.length);
  new Uint8Array(wasm.memory.buffer, pointer, encoded.length).set(encoded);
  const status = wasm.translate(pointer, encoded.length, stage);
  wasm.dealloc(pointer, encoded.length);
  return { status, text: new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.out_ptr(), wasm.out_len())) };
}

const TRANSLATION_CASES = [
  { stage: 0, source: '#version 450\nlayout(location=0) in vec3 position; void main() { gl_Position=vec4(position,1.0); }' },
  { stage: 1, source: '#version 450\nlayout(location=0) out vec4 color; void main() { color=vec4(1.0,0.0,0.0,1.0); }' },
];

function verifyNagaDerivation(original, derived) {
  for (const sample of TRANSLATION_CASES) {
    const before = translateNaga(original, sample.source, sample.stage);
    const after = translateNaga(derived, sample.source, sample.stage);
    if (before.status !== 0 || JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Naga path replacement changed shader translation');
    }
  }
}

export function mobileConfig(files) {
  const match = /const mobileRuntimeConfig = (\{[^\n]+\});/.exec(files.get('index.html').toString('utf8'));
  if (!match) throw new Error('Missing mobile runtime integrity configuration');
  return JSON.parse(match[1]);
}

export async function verifyMobileRuntime(files, config = mobileConfig(files)) {
  const requests = [];
  const context = createContext({
    navigator: { userAgent: 'iPhone AppleWebKit/605.1', platform: 'iPhone', maxTouchPoints: 5 },
    location: new URL('https://public.example/testing/'),
    URL, URLSearchParams, Uint8Array, DataView, TextDecoder, crypto: webcrypto,
    WebAssembly, setTimeout, clearTimeout,
    document: { visibilityState: 'visible', addEventListener() {} },
    addEventListener() {},
    fetch: async value => {
      const path = new URL(value).pathname.split('/').at(-1), bytes = files.get(path);
      if (!bytes) throw new Error('Unexpected mobile runtime request');
      requests.push(path);
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
  });
  new Script(files.get('mobile-runtime.js').toString('utf8')).runInContext(context);
  await context.mcWebMobileRuntime.prepareMobileRuntime(config);
  if (typeof context.createJavaVM !== 'function'
      || Object.keys(context.__mcWebMobileModules).length !== config.libraries.length
      || requests.length !== config.libraries.length + 1) throw new Error('Mobile runtime preparation did not load the declared factory and libraries');
  return { loaderChecksum: true, compiledLibraries: config.libraries.length, factoryEvaluated: true };
}

function updateLoaderMetadata(files, records, original) {
  const loader = records['javavm.js'];
  const index = files.get('index.html').toString('utf8'), config = mobileConfig(files);
  if (config.loader.bytes !== loader.baseBytes || config.loader.sha256 !== loader.baseSha256) {
    throw new Error('Base mobile loader integrity record disagrees with the selected release');
  }
  config.loader = { bytes: loader.bytes, sha256: loader.sha256 };
  const nextIndex = Buffer.from(index.replace(/const mobileRuntimeConfig = \{[^\n]+\};/,
    'const mobileRuntimeConfig = ' + JSON.stringify(config) + ';'));
  files.set('index.html', nextIndex);
  records['index.html'] = { bytes: nextIndex.length, sha256: sha256(nextIndex),
    baseBytes: original.get('index.html').length, baseSha256: sha256(original.get('index.html')),
    operations: [{ operation: 'update-loader-integrity-record', target: 'javavm.js', count: 1 }] };
  const metadata = JSON.parse(files.get('wasmjvm-manifest.json'));
  if (metadata.runtime.javavmJsSha256 !== loader.baseSha256) throw new Error('Base JVM metadata has an unexpected loader hash');
  metadata.runtime.javavmJsSha256 = loader.sha256;
  const nextMetadata = Buffer.from(JSON.stringify(metadata, null, 2) + '\n');
  files.set('wasmjvm-manifest.json', nextMetadata);
  records['wasmjvm-manifest.json'] = { bytes: nextMetadata.length, sha256: sha256(nextMetadata),
    baseBytes: original.get('wasmjvm-manifest.json').length, baseSha256: sha256(original.get('wasmjvm-manifest.json')),
    operations: [{ operation: 'update-loader-sha256', target: 'javavm.js', count: 1 }] };
  for (const [path, bytes] of files) {
    if (bytes.includes(Buffer.from(loader.baseSha256))) throw new Error(`Stale loader hash in derived runtime: ${path}`);
  }
}

const ZIP_SCAN = String.raw`
import json, pathlib, re, sys, zipfile
spec=json.load(sys.stdin)
home=re.compile(rb'/(?:home|Users)/[^/\s]+/|[A-Za-z]:[\\/]Users[\\/][^/\\\s]+[\\/]',re.I)
operator=[value.encode() for value in spec['operatorHomePrefixes']]
vendor=set(spec['vendorArchives'])
references=[]
total=entries=archives=0
for path in spec['paths']:
    if pathlib.Path(path).suffix.lower() not in ('.jar','.zip'): continue
    archives+=1
    with zipfile.ZipFile(path) as archive:
        seen=set()
        for entry in archive.infolist():
            if entry.filename in seen: raise ValueError('Duplicate ZIP member')
            seen.add(entry.filename)
            if entry.is_dir(): continue
            entries+=1
            total+=entry.file_size
            if entry.file_size>64*1024*1024 or total>1024*1024*1024 or entries>100000: raise ValueError('ZIP scan exceeds its byte or entry limit')
            if entry.flag_bits & 1: raise ValueError('Encrypted ZIP member')
            body=archive.read(entry)
            checked=body.replace(b'/home/web_user',b'/virtual-home')
            if any(prefix in checked for prefix in operator): raise ValueError('Private build path in '+pathlib.Path(path).name+':'+entry.filename)
            count=len(home.findall(checked))
            if count:
                if pathlib.Path(path).name not in vendor or not re.search(r'\.(?:a|so|dll|jnilib|dylib)$',entry.filename,re.I): raise ValueError('Unexpected home-path reference in '+pathlib.Path(path).name+':'+entry.filename)
                references.append({'archive':pathlib.Path(path).name,'entry':entry.filename,'occurrences':count})
print(json.dumps({'archives':archives,'entries':entries,'uncompressedBytes':total,'unchangedVendorNativeHomeReferences':references}))
`;

async function scanZipEntries(spec) {
  const stdout = execFileSync('python3', ['-c', ZIP_SCAN], {
    input: JSON.stringify(spec), encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 90_000,
  });
  return JSON.parse(stdout);
}

async function regularInput(source, path) {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const stat = await lstat(join(source, ...parts.slice(0, i)));
    if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Runtime input is linked or non-regular');
    }
  }
  return readFile(join(source, path));
}

export async function preparePublicRuntime({ source, referenceClient, root = ROOT,
  output = join(root, 'artifacts') } = {}) {
  if (!source || !referenceClient) throw new Error('Provide the verified runtime directory and original client reference');
  source = resolve(source);
  const releaseBytes = await readFile(join(root, 'testing/release.json'));
  const release = JSON.parse(releaseBytes), original = new Map();
  for (const [path, record] of Object.entries(release.files)) {
    const body = await regularInput(source, path);
    if (body.length !== record.bytes || sha256(body) !== record.sha256) throw new Error(`Base release mismatch: ${path}`);
    original.set(path, body);
  }
  const expectedPaths = new Set(Object.keys(release.files));
  async function checkSourceDirectory(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await checkSourceDirectory(join(directory, entry.name), path + '/');
      else if (!entry.isFile() || !expectedPaths.has(path)) throw new Error('Extraneous or linked base runtime input');
    }
  }
  await checkSourceDirectory(source);
  const auditOptions = { projectRoot: join(root, 'runtime'),
    clientJarBytes: await readFile(referenceClient), expectedClientSha256: MC_CLIENT_SHA256, version: MC_VERSION };
  const baseAudit = await auditBundle(source, auditOptions);
  if (baseAudit.violations.length) throw new Error(`Base runtime publication audit failed: ${baseAudit.violations.join('; ')}`);
  const files = new Map(), records = {};
  for (const [path, body] of [...original].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (EXCLUDED.has(path)) continue;
    runtimePath(path);
    const result = path === 'javavm.js' ? neutralizeBuildPaths(body)
      : path === 'nagamin.wasm' ? neutralizeBuildPaths(body, { sameLength: true })
        : { bytes: body, operations: [] };
    scanPublicBytes(result.bytes, path);
    files.set(path, result.bytes);
    records[path] = { bytes: result.bytes.length, sha256: sha256(result.bytes),
      baseBytes: body.length, baseSha256: sha256(body), operations: result.operations };
  }
  for (const path of ['javavm.js', 'nagamin.wasm']) {
    if (!records[path]?.operations.length) throw new Error(`No expected build-path labels found in ${path}`);
  }
  updateLoaderMetadata(files, records, original);
  new Script(files.get('javavm.js').toString('utf8'), { filename: 'javavm.js' });
  new WebAssembly.Module(files.get('javavm.wasm'));
  verifyNagaDerivation(original.get('nagamin.wasm'), files.get('nagamin.wasm'));
  const mobilePreparation = await verifyMobileRuntime(files);
  const temporary = await mkdtemp(join(tmpdir(), 'public-runtime-audit-'));
  let zipAudit, derivedAudit;
  try {
    for (const [path, body] of files) {
      await mkdir(dirname(join(temporary, path)), { recursive: true });
      await writeFile(join(temporary, path), body);
    }
    const operatorHomePrefixes = [...new Set(['javavm.js','nagamin.wasm'].flatMap(path =>
      (original.get(path).toString('latin1').match(BUILD_PREFIX) || [])
        .map(prefix => /^\/(?:home|Users)\/[^/]+\//.exec(prefix)?.[0]).filter(Boolean)))];
    const thirdParty = JSON.parse(files.get('THIRD-PARTY.json'));
    zipAudit = await scanZipEntries({ paths: [...files.keys()].map(path => join(temporary, path)),
      operatorHomePrefixes, vendorArchives: thirdParty.libraries.map(library => library.file) });
    derivedAudit = await auditBundle(temporary, auditOptions);
    if (derivedAudit.violations.length) throw new Error(`Derived runtime publication audit failed: ${derivedAudit.violations.join('; ')}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  const archive = createRuntimeArchive(files);
  if (archive.bytes.length >= MAX_ARCHIVE_BYTES) throw new Error('Public runtime archive exceeds 100 MiB');
  const summary = audit => ({ violations: audit.violations.length, servedJars: audit.served.length,
    upstreamJars: audit.upstream.length, preloadFiles: audit.preload.files, shaders: audit.shader });
  const manifest = { schema: 1, kind: 'public-browser-runtime', version: release.version,
    base: { release: release.commit, manifestSha256: sha256(releaseBytes), sourceTreeSha256: release.build.sourceTreeSha256 },
    archive: { path: 'runtime.tar.gz', bytes: archive.bytes.length, sha256: sha256(archive.bytes),
      filesBytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0), tarBytes: archive.tarBytes },
    excluded: [...EXCLUDED].sort().map(path => ({ path, ...release.files[path], reason: 'development server module' })),
    files: records,
    validation: { basePublicationAudit: summary(baseAudit), derivedPublicationAudit: summary(derivedAudit),
      zipPrivacyScan: zipAudit, nagaTranslationsMatchBase: TRANSLATION_CASES.length,
      mobilePreparation,
      loaderSyntax: true, wasmModulesCompiled: ['javavm.wasm', 'nagamin.wasm'] } };
  scanPublicBytes(Buffer.from(JSON.stringify({ ...manifest, excluded: undefined })), 'public runtime receipt');
  verifyRuntimeArchive(archive.bytes, manifest);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'runtime.tar.gz'), archive.bytes);
  await writeFile(join(output, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--reference-client' && process.argv[i + 1]) options.referenceClient = resolve(process.argv[++i]);
    else if (arg === '--output' && process.argv[i + 1]) options.output = resolve(process.argv[++i]);
    else if (!arg.startsWith('-') && !options.source) options.source = arg;
    else throw new Error('Usage: node tools/prepare-public-runtime.mjs BUNDLE --reference-client ORIGINAL_CLIENT.jar [--output DIRECTORY]');
  }
  const manifest = await preparePublicRuntime(options);
  console.log(JSON.stringify({ archive: manifest.archive, files: Object.keys(manifest.files).length, validation: manifest.validation }));
}
