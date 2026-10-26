#!/usr/bin/env node
import release from "../testing/release.json" with { type: "json" };

export function mobileTerrainClass(bytes, massager) {
  const result = new Uint8Array(bytes);
  const view = new DataView(result.buffer);
  const { pool } = massager.readConstantPool(result);
  const sizes = new Map([[134217728, 16777216], [33554432, 4194304], [102760448, 8388608]]);
  const found = new Set();
  for (const entry of pool) {
    if (entry?.tag !== 3) continue;
    const value = view.getInt32(entry.at + 1, false);
    if (!sizes.has(value)) continue;
    if (found.has(value)) throw new Error('Unexpected duplicate terrain buffer size');
    found.add(value);
    view.setInt32(entry.at + 1, sizes.get(value), false);
  }
  if (found.size !== sizes.size) throw new Error('Unexpected pinned terrain buffer sizes');
  return result;
}

export async function mobileClientJar(bytes, massager = globalThis.mcWebJarMassage) {
  const entry = 'net/minecraft/client/renderer/chunk/SectionRenderDispatcher.class';
  const original = await massager.readEntry(bytes, entry);
  if (!original) throw new Error('The pinned client is missing its terrain allocator');
  const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)),
    b => b.toString(16).padStart(2, '0')).join('');
  if (await digest(original) !== 'b2f89fd98f312a4c9ae786a387c11ed8a55f107745e36dd481539031efffbcbc') {
    throw new Error('The mobile terrain allocator failed its release checksum');
  }
  const patched = mobileTerrainClass(original, massager);
  if (await digest(patched) !== '40e1a82eab600aea31d00de8f3d26c2e71a29814a37fa23bea19d161610ff581') {
    throw new Error('The mobile terrain allocator failed its derived checksum');
  }
  const manifest = await massager.readEntry(bytes, 'META-INF/MANIFEST.MF');
  if (!manifest || manifest.length !== 5072373 ||
      await digest(manifest) !== '09bba44b7c18dcd70789ef7bedf4fbc58984b773e84fec2dacc9ffda6fa3e448') {
    throw new Error('The mobile client manifest failed its release checksum');
  }
  // The derived JAR is already unsigned. Its remaining sections contain only
  // signature digests; retain the pinned main attributes, including Main-Class.
  const unsignedManifest = manifest.slice(0, 64);
  if (await digest(unsignedManifest) !== '135accdbc99ebeeb5d0ac7f5c7d94e1e7e3fdf66debe321106e6aa665659a45f') {
    throw new Error('The mobile client manifest failed its derived checksum');
  }
  return massager.massageJar(bytes, undefined, new Map([
    [entry, patched], ['META-INF/MANIFEST.MF', unsignedManifest],
  ])).bytes;
}

export async function mobileRuntimeModules(loaderURL, records, fetchModule = fetch, compile = WebAssembly.compile) {
  const modules = Object.create(null);
  const pin = new URL(loaderURL).searchParams.get('release');
  for (const [name, record] of records) {
    const url = new URL(name, loaderURL);
    if (pin) url.searchParams.set('release', pin);
    const response = await fetchModule(url);
    if (!response.ok) throw new Error('Could not load the iPhone runtime library: ' + name);
    const bytes = await response.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      value => value.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== record.bytes || hash !== record.sha256) {
      throw new Error('The iPhone runtime library failed its release checksum: ' + name);
    }
    modules[name] = await compile(bytes);
  }
  return modules;
}

export function mobileRuntimeSource(source, loaderURL, search = '') {
  const pool = 'var pthreadPoolSize = 32;';
  const script = 'var _scriptName = globalThis.document?.currentScript?.src;';
  const gpu = 'new Worker("gpu-rpc-worker.js" + location.search)';
  const mount = 'FS.writeFile("/app/mcweb/" + j.name, bytes);';
  const cache = 'var sharedModules = {};';
  for (const marker of [pool, script, gpu, mount, cache]) {
    if (source.split(marker).length !== 2) throw new Error('Unexpected pinned mobile runtime loader');
  }
  const workerURL = new URL(loaderURL);
  const requestedDistance = Number(new URLSearchParams(search).get('mcweb_render_distance'));
  const distance = Number.isInteger(requestedDistance) && requestedDistance >= 2 && requestedDistance <= 8
    ? requestedDistance : 2;
  const pin = workerURL.searchParams.get('release');
  workerURL.search = search;
  if (pin) workerURL.searchParams.set('release', pin);
  workerURL.searchParams.set('mcweb_render_distance', String(distance));
  return source.replace(pool, 'var pthreadPoolSize = 2;')
    .replace(cache, 'var sharedModules = globalThis.__mcWebMobileModules || {};')
    .replace(mount, 'FS.writeFile("/app/mcweb/" + j.name, j.name === "minecraft-26.3-client.jar" ? await globalThis.__mcWebMobileClientJar(bytes) : bytes, { canOwn: true });')
    .replace(script, 'var _scriptName = ' + JSON.stringify(workerURL.href) + ';')
    .replace(gpu, `new Worker((() => {
      const url = new URL('gpu-rpc-worker.js', location.href);
      url.search = location.search;
      url.searchParams.set('mcweb_render_distance', ${JSON.stringify(String(distance))});
      return url.href;
    })())`);
}

export function mobileRuntimeArguments(args) {
  return ['-Xmx384m', '-Xms96m', '-XX:MetaspaceSize=64m', '-XX:+UseSerialGC', '-Xrs',
    '-Dmcweb.maxFps=20', '-Dmcweb.sectionPacks=2', '-Dmcweb.serverThreads=0',
    '-Dmcweb.runtimeMode=WASMLM_INLINE',
    '-Dmcweb.simulationDistance=5', '-Dmcweb.lookAhead=0', ...args.filter(arg =>
      arg !== '-Xrs' && !/^-Xm[xs]/.test(arg) &&
      !/^-XX:(?:MetaspaceSize=|ParallelGCThreads=|[+-]Use(?:Parallel|Serial)GC|[+-]?(?:UnlockExperimentalVMOptions|UseZeroWasmJIT|ZeroWasmJIT))/.test(arg) &&
      !/^-Dmcweb\.(?:serverThreads|sectionPacks|maxFps|simulationDistance|lookAhead|runtimeMode)=/.test(arg))];
}

export function mobileTestingPage(html) {
  const launch = 'await createJavaVM({';
  const args = 'arguments: args,';
  const ready = "    status.textContent = 'running';";
  const query = 'const query = new URLSearchParams(location.search);';
  const print = 'print: t => write(t),';
  const width = 'canvas.width = 1280;';
  const height = 'canvas.height = 720;';
  const command = "write('$ java ' + args.join(' '));";
  for (const marker of [launch, args, ready, query, print, width, height, command]) {
    if (html.split(marker).length !== 2) throw new Error('Unexpected pinned mobile launch markup');
  }
  const libraries = ['libjli.so', 'libjvm.so', 'libjimage.so', 'libjava.so',
    'libnet.so', 'libnio.so', 'libzip.so', 'libverify.so', 'libmcwebjs.so']
    .map(name => [name, release.files[name]]);
  const setup = `function usesIOSRuntime() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
${mobileRuntimeSource.toString()}
${mobileRuntimeArguments.toString()}
${mobileTerrainClass.toString()}
${mobileClientJar.toString()}
${mobileRuntimeModules.toString()}
let mobileRuntimeReady;
async function prepareMobileRuntime() {
  if (!usesIOSRuntime()) return;
  return mobileRuntimeReady ||= (async () => {
    const url = new URL('javavm.js?release=${release.commit}', location.href).href;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not load the iPhone runtime loader: HTTP ' + response.status);
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== '${release.files['javavm.js'].sha256}') throw new Error('The iPhone runtime loader failed its release checksum');
    globalThis.__mcWebMobileModules = await mobileRuntimeModules(url, ${JSON.stringify(libraries)});
    globalThis.__mcWebMobileClientJar = async bytes => {
      const derived = await mobileClientJar(bytes);
      write('[mobile] verified terrain buffers: 16 MB vertex, 4 MB index, 8 MB staging');
      return derived;
    };
    (0, eval)(mobileRuntimeSource(new TextDecoder().decode(bytes), url, location.search));
  })();
}
`;
  return html.replace(query, setup + '\n' + query)
    .replace(width, 'canvas.width = usesIOSRuntime() ? 640 : 1280;')
    .replace(height, 'canvas.height = usesIOSRuntime() ? 360 : 720;')
    .replace(command, "const runtimeArgs = usesIOSRuntime() ? mobileRuntimeArguments(args) : args;\n  write('$ java ' + runtimeArgs.join(' '));")
    .replace(launch, 'await prepareMobileRuntime();\n    ' + launch)
    .replace(args, 'arguments: runtimeArgs,')
    .replace(ready, "    status.textContent = usesIOSRuntime() ? 'loading Minecraft — this may take several minutes on iPhone' : 'running';")
    .replace(print, "print: t => { write(t); if (usesIOSRuntime() && t.startsWith('[MC-FRAMES]')) status.textContent = 'running'; },");
}

export function capabilityTestingPage(html) {
  const refresh = 'async function refreshInstalled() {';
  const install = 'installButton.onclick = async () => {';
  const play = 'playButton.onclick = async () => {';
  const failed = "  write('could not read the payload manifest: ' + failure, 'err');\n  status.textContent = 'bundle unavailable';";
  for (const marker of [refresh, install, play, failed]) {
    if (html.split(marker).length !== 2) throw new Error('Unexpected upstream storage setup');
  }
  return html.replace(refresh, `let runtimeSupport;
function requireRuntimeSupport() {
  return runtimeSupport ||= (async () => {
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      throw new Error('This browser cannot run the threaded game. Open testing directly in a supported browser.');
    }
    const adapter = navigator.gpu && await Promise.race([
      navigator.gpu.requestAdapter().catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!adapter) {
      throw new Error('WebGPU is unavailable. This game needs a WebGPU-capable browser and device. The iOS Simulator cannot play it.');
    }
    if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function') {
      throw new Error('Offscreen canvas is unavailable. Update to a supported browser to play.');
    }
    try {
      await navigator.storage.getDirectory();
    } catch (cause) {
      throw new Error('Browser storage is unavailable. Allow site storage and use a regular browsing window. Safari Private Browsing cannot install this game.', { cause });
    }
  })();
}
function unsupportedBrowser(failure) {
  write('could not prepare this browser: ' + failure, 'err');
  status.textContent = failure.message || 'bundle unavailable - see the log';
  installButton.disabled = playButton.disabled = true;
}
${refresh}
  await requireRuntimeSupport();`)
    .replace(install, `${install}\n  try { await requireRuntimeSupport(); } catch (failure) { unsupportedBrowser(failure); return; }`)
    .replace(play, `${play}\n  try { await requireRuntimeSupport(); } catch (failure) { unsupportedBrowser(failure); return; }`)
    .replace(failed, '  unsupportedBrowser(failure);');
}

export function portableTestingPage(html) {
  for (const marker of ['const mobile = globalThis.mcWebMobileRuntime;',
    'if (runtimeLog.open) log.scrollTop = log.scrollHeight;',
    '<details id="runtime-log">']) {
    if (!html.includes(marker)) throw new Error('Unexpected portable testing launcher: ' + marker);
  }
  const memoryVariants = ['', ', memoryBudgetMiB', ', memoryWasmMaxMiB'].map(argument => [
    'const runtimeArgs = mobile.runtimeArguments(args' + argument + ');',
    'await mobile.prepareMobileRuntime(mobileRuntimeConfig, write' + argument + ');',
  ]);
  for (const index of [0, 1]) {
    const count = memoryVariants.reduce((total, markers) => total + html.split(markers[index]).length - 1, 0);
    if (count !== 1) throw new Error('Unexpected portable runtime memory wiring');
  }
  if (!memoryVariants.some(markers => markers.every(marker => html.includes(marker)))) {
    throw new Error('Unexpected portable runtime memory wiring: budget arguments differ');
  }
  return html;
}

export function testingPage(html) {
  const marker = '<pre id="log"></pre>';
  if (html.split(marker).length !== 2) throw new Error("Unexpected upstream log markup");
  const launch = 'await createJavaVM({';
  if (html.split(launch).length !== 2) throw new Error("Unexpected upstream runtime factory");
  return html.replace(/<script src="([^"]+)"><\/script>/g,
    (_, file) => `<script src="${file}?release=${release.commit}"></script>`)
    .replace('<title>', '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>')
    .replace(launch, `${launch}\n      locateFile: (file, prefix) => prefix + file + '?release=${release.commit}',`)
    .replace(marker,
    '<details id="runtime-log"><summary>Runtime log</summary><pre id="log"></pre></details>')
    .replace('</style>', '  #runtime-log { margin: 0 20px 20px; border: 1px solid #303747; border-radius: 6px; }\n  #runtime-log summary { cursor: pointer; padding: 10px 14px; }\n  footer { margin: 16px 20px; color: var(--dim); font-size: 11px; }\n  @media (max-width: 600px) { .bar { flex-wrap: wrap; gap: 8px; } .bar #status { flex-basis: 100%; } button, #runtime-log summary { min-height: 44px; box-sizing: border-box; } }\n</style>')
    .replace('<script>', '<footer>NOT AN OFFICIAL MINECRAFT PRODUCT OR SERVICE. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.</footer>\n<script>');
}
