'use strict';
// ZIP import/export stays local to this browser. Storage commits a complete,
// validated archive in one transaction; existing names always get a new suffix.
globalThis.mcWebGameLibrary = (() => {
  const MAX_BYTES = 512 * 1024 * 1024;
  const MAX_FILES = 65535;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
    for (let bit = 0; bit < 8; bit++) i = (i >>> 1) ^ ((i & 1) ? 0xedb88320 : 0);
    return i >>> 0;
  });
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
  }
  function validPath(path) {
    return typeof path === 'string' && path.length > 0 && path.length <= 1024
      && !/[\\\u0000-\u001f\u007f:]/.test(path) && !path.startsWith('/')
      && path.split('/').every(part => part && part !== '.' && part !== '..');
  }
  function safeName(value) {
    const name = String(value).replace(/\.zip$/i, '').replace(/[\\/:\u0000-\u001f\u007f]/g, '_').trim().slice(0, 160);
    return name && name !== '.' && name !== '..' ? name : 'Imported';
  }
  function rootFor(kind) {
    if (kind === 'world') return 'saves';
    if (kind === 'pack') return 'resourcepacks';
    throw new Error('Unknown library type');
  }
  async function storage() {
    const store = globalThis.mcWebGameStorage;
    if (!store) throw new Error('Game storage is still loading. Reload the launcher and try again.');
    await store.ready();
    if (!store.status().available) throw new Error('Browser storage is unavailable. Files have not been changed.');
    return store;
  }
  function checkWorld(store, kind) {
    if (kind === 'world' && store.status().running) throw new Error('Exit the game and reload the launcher before managing worlds.');
  }
  async function inflate(blob, expected) {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot unzip this file. Update your browser or use a ZIP with uncompressed entries.');
    let reader;
    try { reader = blob.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(); }
    catch { throw new Error('This browser does not support ZIP decompression. Update your browser or use an uncompressed ZIP.'); }
    // One bounded destination avoids retaining every stream chunk alongside a
    // second full-size concatenated copy on memory-constrained devices.
    const result = new Uint8Array(expected);
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.length > expected) throw new Error('The ZIP expands beyond its declared size.');
        result.set(value, length);
        length += value.length;
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    if (length !== expected) throw new Error('The ZIP contains a truncated compressed file.');
    return result;
  }
  async function unzip(input, onProgress = () => {}) {
    if (!Number.isSafeInteger(input.size) || input.size > MAX_BYTES) throw new Error('ZIP files must be smaller than 512 MiB.');
    if (typeof input.slice !== 'function') throw new Error('Choose a ZIP file from this device.');
    // Read metadata and individual payload slices, not the whole archive. A
    // 512 MiB stored ZIP then needs one payload copy rather than retaining a
    // full archive ArrayBuffer through storage's transactional commit as well.
    const tailOffset = Math.max(0, input.size - 65557);
    const tail = new Uint8Array(await input.slice(tailOffset).arrayBuffer());
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tailView.getUint32(offset, true) === 0x06054b50 && offset + 22 + tailView.getUint16(offset + 20, true) === tail.length) { end = offset; break; }
    }
    if (end < 0) throw new Error('That file is not a complete ZIP archive.');
    const t16 = offset => tailView.getUint16(end + offset, true), t32 = offset => tailView.getUint32(end + offset, true);
    if (t16(4) || t16(6) || t16(8) !== t16(10)) throw new Error('Split ZIP archives are not supported.');
    const count = t16(10), centralSize = t32(12), centralOffset = t32(16);
    if (count === 65535 || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported. Export a standard ZIP smaller than 512 MiB.');
    if (!count || count > MAX_FILES || centralOffset + centralSize > tailOffset + end) throw new Error('The ZIP directory is damaged or empty.');
    if (centralSize > 16 * 1024 * 1024) throw new Error('The ZIP file directory exceeds 16 MiB.');
    const bytes = new Uint8Array(await input.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = offset => view.getUint16(offset, true), u32 = offset => view.getUint32(offset, true);
    const entries = [], names = new Set();
    let offset = 0, total = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > centralSize || u32(offset) !== 0x02014b50) throw new Error('The ZIP directory is damaged.');
      const flags = u16(offset + 8), method = u16(offset + 10), crc = u32(offset + 16);
      const compressed = u32(offset + 20), size = u32(offset + 24), nameLength = u16(offset + 28);
      const extraLength = u16(offset + 30), commentLength = u16(offset + 32), local = u32(offset + 42);
      if (offset + 46 + nameLength + extraLength + commentLength > centralSize) throw new Error('The ZIP entry is damaged.');
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
      let path;
      try { path = decoder.decode(nameBytes); } catch { throw new Error('ZIP file names must use UTF-8.'); }
      const directory = path.endsWith('/');
      const normalized = directory ? path.slice(0, -1) : path;
      if (!validPath(normalized)) throw new Error('The ZIP contains an unsafe file path.');
      if (names.has(path)) throw new Error('The ZIP contains duplicate file names.');
      names.add(path);
      const unixType = (u32(offset + 38) >>> 16) & 0xf000;
      if (unixType && unixType !== 0x8000 && unixType !== 0x4000) throw new Error('Links and special files cannot be imported.');
      if (flags & 1 || method !== 0 && method !== 8) throw new Error('Encrypted ZIPs and this compression method are not supported.');
      if (local + 30 + nameLength > centralOffset) throw new Error('The ZIP file header is damaged.');
      const localHeader = new Uint8Array(await input.slice(local, local + 30 + nameLength).arrayBuffer());
      const lv = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength);
      if (localHeader.length !== 30 + nameLength || lv.getUint32(0, true) !== 0x04034b50) throw new Error('The ZIP file header is damaged.');
      const localNameLength = lv.getUint16(26, true), localExtraLength = lv.getUint16(28, true);
      const start = local + 30 + localNameLength + localExtraLength;
      if (lv.getUint16(8, true) !== method || lv.getUint16(6, true) !== flags || start + compressed > centralOffset
          || localNameLength !== nameLength || nameBytes.some((byte, j) => localHeader[30 + j] !== byte)) throw new Error('The ZIP file headers do not match.');
      if (!directory) {
        total += size;
        if (total > MAX_BYTES) throw new Error('The ZIP expands beyond 512 MiB.');
        entries.push({ path, method, size, compressed, crc, start });
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    if (offset !== centralSize) throw new Error('The ZIP directory size does not match.');
    for (const entry of entries) {
      const parts = entry.path.split('/');
      for (let n = 1; n < parts.length; n++) {
        if (names.has(parts.slice(0, n).join('/'))) throw new Error('The ZIP contains a file where a folder is required.');
      }
    }
    const files = [];
    for (const [index, entry] of entries.entries()) {
      if ((entry.path === 'pack.mcmeta' || entry.path.endsWith('/pack.mcmeta')) && entry.size > 1024 * 1024) throw new Error('pack.mcmeta exceeds the 1 MiB metadata limit.');
      const source = input.slice(entry.start, entry.start + entry.compressed);
      const content = entry.method === 0 ? new Uint8Array(await source.arrayBuffer()) : await inflate(source, entry.size);
      if (content.length !== entry.size || crc32(content) !== entry.crc) throw new Error('The ZIP contains a damaged file: ' + entry.path);
      files.push({ path: entry.path, bytes: content });
      onProgress(index + 1, entries.length);
    }
    return files;
  }
  function unwrap(files, marker) {
    const candidates = files.filter(file => file.path === marker || file.path.endsWith('/' + marker));
    if (candidates.length !== 1) throw new Error('Import one ' + (marker === 'level.dat' ? 'Java Edition world with level.dat' : 'resource pack with pack.mcmeta') + ' per ZIP.');
    const prefix = candidates[0].path.slice(0, -marker.length);
    return { prefix, files: files.filter(file => file.path.startsWith(prefix)).map(file => ({ ...file, path: file.path.slice(prefix.length) })) };
  }
  async function list(kind) {
    const store = await storage(), root = rootFor(kind) + '/';
    const groups = new Map();
    for (const file of await store.list()) {
      if (!file.path.startsWith(root)) continue;
      const name = file.path.slice(root.length).split('/')[0];
      if (!name) continue;
      const item = groups.get(name) || { name, bytes: 0, files: 0 };
      item.bytes += file.bytes;
      item.files++;
      groups.set(name, item);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async function importZip(kind, file, onProgress) {
    const store = await storage();
    checkWorld(store, kind);
    if (!/\.zip$/i.test(file.name)) throw new Error('Choose a .zip file.');
    const parsed = unwrap(await unzip(file, onProgress), kind === 'world' ? 'level.dat' : 'pack.mcmeta');
    if (kind === 'world') {
      const level = parsed.files.find(row => row.path === 'level.dat').bytes;
      if (level.length < 3 || level[0] !== 0x1f || level[1] !== 0x8b || level[2] !== 8) throw new Error('level.dat is not a gzip-compressed Java Edition world. Bedrock worlds are not supported.');
    }
    if (kind === 'pack') {
      const metadataBytes = parsed.files.find(row => row.path === 'pack.mcmeta').bytes;
      if (metadataBytes.length > 1024 * 1024) throw new Error('pack.mcmeta exceeds the 1 MiB metadata limit.');
      let metadata;
      try { metadata = JSON.parse(decoder.decode(metadataBytes)); } catch { throw new Error('pack.mcmeta is not valid JSON.'); }
      if (!metadata?.pack || typeof metadata.pack !== 'object' || Array.isArray(metadata.pack)) throw new Error('pack.mcmeta does not describe a resource pack.');
    }
    // session.lock describes the exporting process; the imported game must own a new one.
    const files = parsed.files.filter(row => row.path !== 'session.lock');
    const existing = new Set((await list(kind)).map(row => row.name));
    const base = safeName(parsed.prefix ? parsed.prefix.split('/').filter(Boolean).pop() : file.name);
    let name = base;
    for (let n = 2; existing.has(name); n++) name = base + ' (' + n + ')';
    const prefix = rootFor(kind) + '/' + name + '/';
    checkWorld(store, kind);
    await store.importFiles(files.map(row => ({ path: prefix + row.path, bytes: row.bytes })));
    return { name, files: files.length, bytes: files.reduce((total, row) => total + row.bytes.length, 0) };
  }
  function zip(files) {
    if (files.length >= MAX_FILES) throw new Error('Too many files for a standard ZIP.');
    const archiveBytes = files.reduce((total, row) => total + row.bytes.length + 76 + encoder.encode(row.path).length * 2, 22);
    if (archiveBytes > MAX_BYTES) throw new Error('This ZIP exceeds the 512 MiB export limit.');
    const local = [], central = [];
    let offset = 0;
    for (const file of files) {
      if (!validPath(file.path)) throw new Error('Unsafe export path.');
      const name = encoder.encode(file.path), bytes = file.bytes;
      const header = new Uint8Array(30 + name.length), view = new DataView(header.buffer);
      const crc = crc32(bytes);
      view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
      view.setUint32(14, crc, true); view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true);
      view.setUint16(26, name.length, true); header.set(name, 30);
      local.push(header, bytes);
      const record = new Uint8Array(46 + name.length), cv = new DataView(record.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); record.set(name, 46);
      central.push(record); offset += header.length + bytes.length;
    }
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, central.reduce((total, row) => total + row.length, 0), true); ev.setUint32(16, offset, true);
    return new Blob([...local, ...central, end], { type: 'application/zip' });
  }
  async function exportZip(kind, name) {
    const store = await storage();
    checkWorld(store, kind);
    if (!validPath(name) || name.includes('/')) throw new Error('Invalid item name.');
    await store.flush();
    const prefix = rootFor(kind) + '/' + name + '/';
    const selected = await store.exportTree(prefix.slice(0, -1), { maxBytes: MAX_BYTES, maxFiles: MAX_FILES - 1 });
    const files = selected.filter(row => row.path !== prefix + 'session.lock')
      .map(row => ({ path: row.path.slice(prefix.length), bytes: row.bytes }));
    if (!files.length) throw new Error('This item no longer exists.');
    return zip(files);
  }
  async function remove(kind, name) {
    const store = await storage();
    checkWorld(store, kind);
    if (store.status().running) throw new Error('Exit the game and reload the launcher before deleting resource packs.');
    if (!validPath(name) || name.includes('/')) throw new Error('Invalid item name.');
    await store.removeTree(rootFor(kind) + '/' + name);
  }
  return { list, importZip, exportZip, remove, unzip, zip, crc32, limits: { bytes: MAX_BYTES, files: MAX_FILES } };
})();
