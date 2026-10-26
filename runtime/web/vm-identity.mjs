const JVM_PATHS = ['/jdk/bin/libjvm.so', '/jdk/lib/zero/libjvm.so'];

// Hash the selected external VM before startup, then compare mounted bytes
// synchronously in Emscripten's initialization hook, before Java main runs.
export async function prepareVmIdentity(record, { ios = false, modules,
  baseURL = globalThis.location?.href, release = '', fetchImpl = fetch,
  report = value => { globalThis.__mcWebVmIdentity = value; } } = {}) {
  if (!record || !Number.isSafeInteger(record.bytes) || record.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Invalid JVM identity record');
  let expected = null, module;
  if (ios) {
    if (!(modules?.['libjvm.so'] instanceof WebAssembly.Module))
      throw new Error('The pinned iPhone JVM module was not compiled');
  } else {
    const url = new URL('libjvm.so', baseURL);
    if (release) url.searchParams.set('release', release);
    const response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Could not verify the selected JVM');
    expected = new Uint8Array(await response.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', expected)),
      value => value.toString(16).padStart(2, '0')).join('');
    if (expected.length !== record.bytes || sha256 !== record.sha256)
      throw new Error('Selected JVM differs from its release identity');
  }
  return Object.freeze({
    preRun(value) { module = value; },
    onRuntimeInitialized() {
      const checkedPaths = [];
      if (!ios) {
        if (!module?.FS?.readFile || !expected) throw new Error('JVM identity hook ran before MEMFS');
        for (const path of JVM_PATHS) {
          const actual = module.FS.readFile(path);
          if (actual.length !== expected.length) throw new Error('Packaged JVM identity differs: ' + path);
          for (let i = 0; i < expected.length; i++) {
            if (actual[i] !== expected[i]) throw new Error('Packaged JVM identity differs: ' + path);
          }
          checkedPaths.push(path);
        }
        expected = null;
      }
      report({ ...record, accepted: true, checkedPaths,
        mechanism: ios ? 'ios-pinned-external-libjvm-module' : 'desktop-vfs-byte-readback' });
    }
  });
}
