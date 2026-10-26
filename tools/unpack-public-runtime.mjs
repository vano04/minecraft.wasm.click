#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 512;
const HASH = /^[a-f0-9]{64}$/;
const DEVELOPMENT_MODULES = new Set(['serve.mjs', 'mc-relay.mjs']);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`public-runtime: ${message}`); };

export function runtimePath(path) {
  if (typeof path !== 'string' || !path || path.length > 240 || path.includes('\\')
      || path.split('/').some(part => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part)
        || part === '.' || part === '..')) fail('Unsafe runtime path');
  if (DEVELOPMENT_MODULES.has(path.split('/').at(-1))) fail('Development server module in public runtime');
  return path;
}

export function scanPublicBytes(bytes, label = 'runtime file') {
  const text = Buffer.from(bytes).toString('latin1');
  // /home/web_user is Emscripten's virtual home directory, not a build host.
  const withoutVirtualHome = text.replaceAll('/home/web_user', '/virtual-home');
  if (/\/(?:home|Users)\/[^/\s]+\//.test(withoutVirtualHome)
      || /[A-Za-z]:[\\/]Users[\\/][^/\\\s]+[\\/]/.test(withoutVirtualHome)) {
    fail(`Private host path in ${label}`);
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function validateManifest(manifest) {
  if (!plainObject(manifest) || manifest.schema !== 1 || manifest.kind !== 'public-browser-runtime'
      || !plainObject(manifest.files) || !plainObject(manifest.archive)
      || manifest.archive.path !== 'runtime.tar.gz' || !HASH.test(manifest.archive.sha256)
      || !Number.isSafeInteger(manifest.archive.bytes) || manifest.archive.bytes < 20
      || manifest.archive.bytes >= MAX_ARCHIVE_BYTES) fail('Invalid public runtime manifest');
  const entries = Object.entries(manifest.files);
  if (!entries.length || entries.length > MAX_FILES) fail('Invalid runtime file count');
  let filesBytes = 0, tarBytes = 1024;
  for (const [path, record] of entries) {
    runtimePath(path);
    if (!plainObject(record) || !HASH.test(record.sha256) || !Number.isSafeInteger(record.bytes)
        || record.bytes < 0 || record.bytes > MAX_FILE_BYTES) fail('Invalid runtime file record');
    filesBytes += record.bytes;
    tarBytes += 512 + Math.ceil(record.bytes / 512) * 512;
  }
  if (filesBytes > MAX_FILES_BYTES || manifest.archive.filesBytes !== filesBytes
      || manifest.archive.tarBytes !== tarBytes) fail('Invalid runtime byte totals');
  return { entries, filesBytes, tarBytes };
}

function field(header, start, size) {
  const bytes = header.subarray(start, start + size);
  const zero = bytes.indexOf(0);
  const value = zero < 0 ? bytes : bytes.subarray(0, zero);
  if ([...value].some(byte => byte < 32 || byte > 126)) fail('Non-ASCII tar field');
  if (zero >= 0 && bytes.subarray(zero).some(byte => byte !== 0)) fail('Malformed tar field');
  return value.toString('ascii');
}

function octal(header, start, size) {
  const value = header.subarray(start, start + size).toString('ascii');
  if (!/^[0-7]+\0 ?$/.test(value) && !/^[0-7]+ $/.test(value)) fail('Invalid tar number');
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail('Invalid tar number');
  return number;
}

export function verifyRuntimeArchive(archive, manifest) {
  const { entries, tarBytes } = validateManifest(manifest);
  if (archive.length !== manifest.archive.bytes || sha256(archive) !== manifest.archive.sha256) {
    fail('Archive checksum or size mismatch');
  }
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: tarBytes }); }
  catch { fail('Invalid or oversized gzip archive'); }
  if (tar.length !== tarBytes) fail('Tar size mismatch');
  const expected = new Map(entries), files = new Map();
  let offset = 0, previous = '';
  while (offset < tar.length - 1024) {
    const header = tar.subarray(offset, offset + 512);
    if (header.length !== 512 || header.every(byte => byte === 0)) fail('Premature tar terminator');
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== octal(header, 148, 8)) fail('Invalid tar header checksum');
    if (header.subarray(257, 263).toString('binary') !== 'ustar\0'
        || header.subarray(263, 265).toString('ascii') !== '00'
        || (header[156] !== 0 && header[156] !== 48)
        || field(header, 157, 100) !== '') fail('Unsupported tar entry type');
    const prefix = field(header, 345, 155), name = field(header, 0, 100);
    const path = runtimePath(prefix ? `${prefix}/${name}` : name);
    if (path <= previous || files.has(path)) fail('Unsorted or duplicate tar entry');
    previous = path;
    const record = expected.get(path), bytes = octal(header, 124, 12);
    if (!record || bytes !== record.bytes || octal(header, 100, 8) !== 0o644
        || octal(header, 108, 8) !== 0 || octal(header, 116, 8) !== 0
        || octal(header, 136, 12) !== 0 || field(header, 265, 32) !== ''
        || field(header, 297, 32) !== '') fail('Unexpected tar entry metadata');
    const start = offset + 512, end = start + bytes;
    offset = start + Math.ceil(bytes / 512) * 512;
    if (offset > tar.length - 1024 || tar.subarray(end, offset).some(byte => byte !== 0)) fail('Invalid tar padding');
    const body = tar.subarray(start, end);
    if (sha256(body) !== record.sha256) fail(`Runtime file checksum mismatch: ${path}`);
    scanPublicBytes(body, path);
    files.set(path, body);
  }
  if (offset !== tar.length - 1024 || tar.subarray(offset).some(byte => byte !== 0)
      || files.size !== expected.size) fail('Missing runtime files or invalid tar terminator');
  return files;
}

async function rejectSymlinkParents(path) {
  let current = resolve(path);
  for (;;) {
    const stat = await lstat(current).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('Linked or non-directory destination parent');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function unpackPublicRuntime({ archivePath = join(ROOT, 'artifacts/runtime.tar.gz'),
  manifestPath = join(ROOT, 'artifacts/runtime.json'), destination, verifyOnly = false } = {}) {
  for (const path of [archivePath, manifestPath]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) fail('Artifact input must be a regular file');
    if (info.size > (path === manifestPath ? 1024 * 1024 : MAX_ARCHIVE_BYTES)) fail('Artifact input is too large');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const files = verifyRuntimeArchive(await readFile(archivePath), manifest);
  if (verifyOnly) return { files: files.size, bytes: manifest.archive.filesBytes };
  if (typeof destination !== 'string' || !destination) fail('Destination is required');
  const output = resolve(destination), parent = dirname(output);
  await rejectSymlinkParents(parent);
  if (await lstat(output).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })) fail('Destination already exists');
  // No destination writes occur until the complete archive has passed validation.
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.public-runtime-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const [path, bytes] of files) {
      const target = join(temporary, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    }
    await chmod(temporary, 0o755);
    await rename(temporary, output);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { files: files.size, bytes: manifest.archive.filesBytes, destination: output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--verify-only') options.verifyOnly = true;
    else if (arg === '--manifest' && process.argv[i + 1]) options.manifestPath = resolve(process.argv[++i]);
    else if (arg === '--archive' && process.argv[i + 1]) options.archivePath = resolve(process.argv[++i]);
    else if (!arg.startsWith('-') && !options.destination) options.destination = arg;
    else throw new Error('Usage: node tools/unpack-public-runtime.mjs DESTINATION [--manifest FILE] [--archive FILE] [--verify-only]');
  }
  console.log(JSON.stringify(await unpackPublicRuntime(options)));
}
