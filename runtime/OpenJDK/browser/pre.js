// Emscripten resolves a side module's dependencies by basename against the
// current directory, and libjli derives java.home from argv[0]. Both have to be
// arranged before the runtime starts.
if (typeof ENVIRONMENT_IS_NODE === 'undefined' || !ENVIRONMENT_IS_NODE) {
  Module.thisProgram = '/jdk/bin/javalauncher';
}
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  // With PROXY_TO_PTHREAD this script is also evaluated on the worker that runs
  // main(). The filesystem lives only on the main thread — worker syscalls are
  // proxied to it — so this must not run twice. NODERAWFS runs map the real
  // filesystem, which also has none of the packaged content.
  if ((typeof ENVIRONMENT_IS_PTHREAD !== 'undefined' && ENVIRONMENT_IS_PTHREAD)
      || (typeof ENVIRONMENT_IS_NODE !== 'undefined' && ENVIRONMENT_IS_NODE)) return;

  FS.chdir('/jdk/bin');

  // libjli resolves argv[0] and insists it names an existing *executable*
  // regular file, from which it derives java.home by stripping "/bin/". The
  // file packager does not carry permission bits and its files appear after
  // preRun, so create this marker here instead of packaging one.
  FS.writeFile('/jdk/bin/javalauncher', 'argv[0] marker; the launcher is the wasm module itself\n');
  FS.chmod('/jdk/bin/javalauncher', 0o755);

  if (Module.userJar) {
    FS.mkdirTree('/app');
    FS.writeFile('/app/user.jar', Module.userJar);
  }
});

function out(text) {
  if (typeof Module !== 'undefined' && Module.print) Module.print(text);
  else console.log(text);
}
globalThis.__mcWebOut = out;

// ---------------------------------------------------------------------------
// Browser seams live on a dedicated GPU Worker; the JVM Worker proxies to it.
//
// The JVM runs on a Worker (PROXY_TO_PTHREAD), and an EM_JS body executes in
// the global scope of whichever thread calls it, so the seam objects must be
// reachable from that Worker. They cannot LIVE there: an OffscreenCanvas can
// be transferred only once, and the thread driving WebGPU frames on it must
// keep turning its event loop for the browser to commit frames. A JVM pthread
// parks in Atomics.wait (Thread.sleep, proxied calls) and never commits a
// frame. A parked worker leaves a black canvas. A worker that spins or yields
// presents frames. So:
//
//   - gpu-rpc-worker.js hosts web/webgpu-host.js on its own Worker with the
//     transferred OffscreenCanvas, and serves the host objects over a
//     synchronous request/response RPC (MessagePort + SharedArrayBuffer, the
//     client parks in Atomics.wait exactly like Emscripten's own proxied
//     calls).
//   - The page spawns the GPU Worker with the canvas, and hands the JVM's
//     ThreadJavaMain worker (CMD_RUN #2) the client end of the channel.
//
// CMD_RUN #1 is the launcher thread spawned synchronously from callMain();
// CMD_RUN #2 (libjli's ThreadJavaMain) is dispatched through the pthread
// proxy and its spawn stack no longer contains callMain. That stack
// difference is the only observable discriminator - the messages are
// otherwise identical - so the page hook skips the first and attaches on the
// next.
// ---------------------------------------------------------------------------

if (typeof ENVIRONMENT_IS_PTHREAD === 'undefined' || !ENVIRONMENT_IS_PTHREAD) {
  // Terminal ownership release only. The page awaits its player-file flush
  // before calling this API; discard itself never claims to save the world.
  let discardRequested = false, discardPromise = null, discardGpu = null;
  const ownedAudio = Module.mcWebCanvas ? globalThis.mcWebAudio : null;
  const discardState = {version: 1, phase: 'active', saved: false,
    usedPthreadTerminationRequests: 0, idlePthreadTerminationRequests: 0, gpu: null, audioClosed: false};
  const stopOwnedPthreads = () => {
    if (typeof PThread === 'undefined') return;
    discardState.usedPthreadTerminationRequests += Object.keys(PThread.pthreads).length;
    discardState.idlePthreadTerminationRequests += PThread.unusedWorkers.length;
    PThread.terminateAllThreads();
  };
  Module.mcWebRuntime = Object.freeze({version: 1,
    get state() { return {...discardState}; },
    discard() {
      if (discardPromise) return discardPromise;
      discardRequested = true;
      Module.noInitialRun = true;
      discardState.phase = 'discarding';
      // Schedule every owner even if another owner's release throws.
      const bounded = (operation, name) => {
        let timer;
        return Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(name + ' cleanup did not settle within 1000 ms')), 1000);
        })]).finally(() => clearTimeout(timer));
      };
      discardPromise = Promise.allSettled([
        Promise.resolve().then(stopOwnedPthreads),
        Promise.resolve().then(() => discardGpu?.() || {owned: false}).then(value => { discardState.gpu = value; }),
        bounded(() => ownedAudio?.dispose(), 'Audio').then(() => { discardState.audioClosed = true; }),
      ]).then(results => {
        discardGpu = null;
        Module.mcWebCanvas = Module.mcWebCanvasElement = null;
        if (globalThis.__mcWebOut === out) delete globalThis.__mcWebOut;
        const errors = results.filter(result => result.status === 'rejected').map(result => String(result.reason));
        if (discardState.gpu?.error) errors.push(discardState.gpu.error);
        errors.push(...(discardState.gpu?.resources?.errors || []));
        discardState.phase = errors.length ? 'discard-failed' : 'discarded';
        // All releases were requested. Native cleanup failure must not trap a
        // committed terminal document behind an unusable Return button.
        return {...discardState, errors};
      });
      return discardPromise;
    },
  });
  // Loading can still be resolving when the document leaves. Never start main
  // afterward, and terminate any owned pthreads created during that bootstrap.
  Module.preRun.push(() => { if (discardRequested) stopOwnedPthreads(); });
  const postRun = Module.postRun;
  Module.postRun = Array.isArray(postRun) ? postRun : postRun ? [postRun] : [];
  Module.postRun.push(() => { if (discardRequested) stopOwnedPthreads(); });
  if (Module.onMcWebRuntimeCreated?.(Module.mcWebRuntime) === false) {
    // A terminal page request preceded factory entry. No new owner may start
    // while the page finishes its flush-backed cleanup of this late Module.
    discardRequested = true;
    Module.noInitialRun = true;
  }
  // The game payload (access-widened client jar + pinned libraries) is a
  // download step: the harness serves only the OpenJDK runtime, a separate
  // payload server serves the jars. Fetch them into the virtual filesystem
  // before Java starts.
  if (typeof ENVIRONMENT_IS_NODE === 'undefined' && Module.mcWebPayload) {
    Module.preRun.push(() => {
      if (discardRequested) return;
      addRunDependency('mcweb-payload');
      (async () => {
        try {
          // Two shapes, one protocol. A payload *server* is given as an
          // origin and answers its manifest at "/"; a packaged bundle is a
          // static directory, where "/" would serve a page, so it names the
          // manifest file directly and the jars sit beside it under jar/.
          const configured = Module.mcWebPayload;
          const manifestUrl = /\.json$/.test(configured)
              ? configured
              : configured.replace(/\/$/, '') + '/';
          const base = /\.json$/.test(configured)
              ? configured.replace(/\/[^/]*$/, '')
              : configured.replace(/\/$/, '');
          const manifestResponse = await fetch(manifestUrl, { cache: 'no-store' });
          if (!manifestResponse.ok) {
            throw new Error('manifest HTTP ' + manifestResponse.status);
          }
          const manifest = await manifestResponse.json();
          if (manifest.schema !== 1 || !Array.isArray(manifest.jars)
              || manifest.jars.length === 0 || manifest.jars[0].role !== 'native-policy') {
            throw new Error('invalid payload manifest or native-policy jar is not first');
          }
          for (const j of manifest.jars) {
            if (!j || !/^[A-Za-z0-9._-]+\.jar$/.test(j.name)
                || !Number.isSafeInteger(j.bytes) || j.bytes <= 0
                || !/^[0-9a-f]{64}$/.test(j.sha256)) {
              throw new Error('invalid payload entry: ' + JSON.stringify(j));
            }
            // An upstream entry must carry everything needed to verify the
            // download before it is used, and may only come from Mojang.
            if (j.url) {
              const host = (() => { try { return new URL(j.url).host; } catch { return ''; } })();
              if (!/^https:/.test(j.url) || !/(^|\.)(mojang\.com|minecraft\.net)$/.test(host)
                  || !Number.isSafeInteger(j.sourceBytes) || j.sourceBytes <= 0
                  || !/^[0-9a-f]{40}$/.test(j.sourceSha1 || '')) {
                throw new Error('invalid upstream payload entry: ' + JSON.stringify(j));
              }
            }
          }

          const digest = async bytes => {
            if (!globalThis.crypto || !globalThis.crypto.subtle) {
              throw new Error('Web Crypto SHA-256 is unavailable');
            }
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
          };
          const validate = async (bytes, entry, source) => {
            if (bytes.byteLength !== entry.bytes) {
              throw new Error(source + ' length ' + bytes.byteLength
                  + ' does not match ' + entry.bytes + ' for ' + entry.name);
            }
            const actual = await digest(bytes);
            if (actual !== entry.sha256) {
              throw new Error(source + ' SHA-256 ' + actual
                  + ' does not match ' + entry.sha256 + ' for ' + entry.name);
            }
            return bytes;
          };
          const cacheName = entry => entry.sha256 + '-' + entry.name;

          const FS = Module.FS;
          FS.mkdirTree('/app/mcweb');

          // The jars remain separate, local/client-owned files. OPFS stores a
          // content-addressed copy, while the JVM continues to use MEMFS. Both
          // cached and fetched bytes must pass size plus SHA-256 before mount.
          let store = null;
          try {
            const root = await navigator.storage?.getDirectory?.();
            store = root ? await root.getDirectoryHandle('mcweb-payload', { create: true }) : null;
          } catch (unavailable) {
            out('[payload] OPFS unavailable (' + unavailable + '); fetching every run');
          }
          const cached = async entry => {
            if (!store) return null;
            try {
              const file = await (await store.getFileHandle(cacheName(entry))).getFile();
              return await validate(
                  new Uint8Array(await file.arrayBuffer()), entry, 'OPFS cache');
            } catch (missingOrInvalid) {
              return null;
            }
          };
          const writeClosed = async (name, bytes) => {
            const handle = await store.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            let closed = false;
            try {
              await writable.write(bytes);
              await writable.close();
              closed = true;
            } finally {
              if (!closed) {
                try { await writable.abort(); } catch (ignored) { /* best effort */ }
              }
            }
            return handle;
          };
          const store_ = async (entry, bytes) => {
            if (!store) return;
            const finalName = cacheName(entry);
            const nonce = Array.from(crypto.getRandomValues(new Uint32Array(2))).join('-');
            const partialName = finalName + '.partial-' + nonce;
            try {
              const partial = await writeClosed(partialName, bytes);
              const staged = new Uint8Array(await (await partial.getFile()).arrayBuffer());
              await validate(staged, entry, 'OPFS staged write');

              // move() is an atomic same-directory publish where supported.
              // The fallback still commits only on createWritable().close(),
              // then verifies the published content before treating it valid.
              let moved = false;
              if (typeof partial.move === 'function') {
                try { await partial.move(finalName); moved = true; } catch (unsupported) { /* fallback */ }
              }
              if (!moved) {
                const published = await writeClosed(finalName, bytes);
                await validate(
                    new Uint8Array(await (await published.getFile()).arrayBuffer()),
                    entry, 'OPFS committed write');
                try { await store.removeEntry(partialName); } catch (ignored) { /* best effort */ }
              }
            } catch (failed) {
              try { await store.removeEntry(partialName); } catch (ignored) { /* best effort */ }
              out('[payload] could not cache ' + entry.name + ': ' + failed);
            }
          };

          let hits = 0;
          let fetchedBytes = 0;
          for (const j of manifest.jars) {
            if (discardRequested) return;
            let bytes = await cached(j);
            if (bytes) {
              hits++;
            } else if (j.url) {
              // Fetched by the browser straight from Mojang, never from this
              // origin: the page holds no Minecraft bytes to serve. The
              // download is checked against Mojang's own published SHA-1, then
              // massaged locally, then checked again against the pinned digest
              // of the massaged result - so neither the network nor the
              // massaging can change what reaches the JVM unnoticed.
              out('[payload] fetching ' + j.name + ' from ' + new URL(j.url).host
                  + ' (' + (j.sourceBytes >> 20) + ' MB)');
              const response = await fetch(j.url, { cache: 'no-store' });
              if (!response.ok) {
                throw new Error(j.name + ' HTTP ' + response.status);
              }
              const source = new Uint8Array(await response.arrayBuffer());
              if (source.byteLength !== j.sourceBytes) {
                throw new Error(j.name + ' upstream length ' + source.byteLength
                    + ' does not match ' + j.sourceBytes);
              }
              const sha1 = Array.from(
                  new Uint8Array(await crypto.subtle.digest('SHA-1', source)),
                  (b) => b.toString(16).padStart(2, '0')).join('');
              if (sha1 !== j.sourceSha1) {
                throw new Error(j.name + ' upstream SHA-1 ' + sha1
                    + ' does not match ' + j.sourceSha1);
              }
              fetchedBytes += source.length;
              const massager = globalThis.mcWebJarMassage;
              if (j.massagePlan) {
                // The plan is data, carried in the manifest: which entries to
                // patch and which method owners to retarget. Keeping it out of
                // here means new patches need no relink of the runtime, which
                // matters because pre.js is inlined into javavm.js.
                if (!massager) throw new Error('jar-massage.js is not loaded');
                const started = Date.now();
                const result = await massager.prepareClientJar(source, j.massagePlan);
                if (result.missing && result.missing.length) {
                  throw new Error(j.name + ' massage plan names entries this jar '
                      + 'does not contain: ' + result.missing.join(', '));
                }
                out('[payload] massaged ' + j.name + ': dropped '
                    + (result.dropped.join(', ') || 'nothing') + ', patched '
                    + result.patched.length + ' classes, kept ' + result.kept
                    + ' entries in ' + (Date.now() - started) + ' ms');
                bytes = await validate(result.bytes, j, 'massaged jar');
              } else {
                bytes = await validate(source, j, 'upstream response');
              }
              await store_(j, bytes);
            } else {
              out('[payload] fetching ' + j.name + ' (' + (j.bytes >> 20) + ' MB)');
              const response = await fetch(
                  base + '/jar/' + encodeURIComponent(j.name), { cache: 'no-store' });
              if (!response.ok) {
                throw new Error(j.name + ' HTTP ' + response.status);
              }
              bytes = await validate(
                  new Uint8Array(await response.arrayBuffer()), j, 'HTTP response');
              fetchedBytes += bytes.length;
              await store_(j, bytes);
            }
            if (discardRequested) return;
            FS.writeFile('/app/mcweb/' + j.name, bytes);
          }
          out('[payload] ' + manifest.jars.length + ' jars mounted, ' + hits + ' from OPFS, '
              + (fetchedBytes >> 20) + ' MB downloaded; SHA-256 verified');
        } catch (failure) {
          out('[payload] failed closed: ' + (failure && failure.stack || failure));
          abort('MC-Web payload validation failed');
        } finally {
          removeRunDependency('mcweb-payload');
        }
      })();
    });
  }
  // Page side: one GPU Worker and one canvas per run (an OffscreenCanvas can
  // only be transferred once, and each module gets a fresh Worker pool).
  if (typeof ENVIRONMENT_IS_NODE === 'undefined' && Module.mcWebCanvas && !discardRequested) {
    // Carry the page's query string onto the Worker URL: the canonical host
    // reads its diagnostics (?mcweb_diag, ?mcweb_texdiag, …) from
    // location.search, and on a Worker that is the worker's own URL.
    const inputListeners = new AbortController();
    const listen = (target, type, callback, options) => target.addEventListener(type, callback,
      {...(typeof options === 'boolean' ? {capture: options} : options), signal: inputListeners.signal});
    let restoreWorkerMessages = null;
    let cursorWanted = () => {};   // set with the input forwarding below
    const gpuWorker = new Worker('gpu-rpc-worker.js' + location.search);
    globalThis.__mcWebFrames = 0;
    // Diagnostic-only finite display, readable through native accessibility.
    // It never takes focus, pointer capture, permissions or a network path.
    const installResourceCensus = () => {
      if (new URLSearchParams(location.search).get('mcweb_resource_census') !== '1') return null;
      const output = document.createElement('pre');
      output.id = 'mcweb-resource-census';
      output.setAttribute('aria-label', 'Bounded logical GPU resource census');
      output.style.cssText = 'position:fixed;right:4px;bottom:4px;z-index:2147483646;max-width:620px;max-height:180px;overflow:auto;background:#111e;color:#fff;font:11px monospace;white-space:pre-wrap;pointer-events:none;';
      document.body.appendChild(output);
      const times = [30, 60, 120, 180, 240], rows = times.map(time => time + 's: waiting for first positive frame');
      const timers = new Set(), pending = new Map();
      let active = true, started = false, finished = 0;
      const draw = () => {
        const chunks = [];
        for (const line of ['Logical ownership only; excludes physical process/native driver memory. Times are seconds after the first positive frame.', ...rows]) {
          const text = line + '\n';
          for (let offset = 0; offset < text.length; offset += 350) {
            const chunk = document.createElement('div');
            chunk.textContent = text.slice(offset, offset + 350);
            chunks.push(chunk);
          }
        }
        output.replaceChildren(...chunks);
      };
      const schedule = (callback, delay) => {
        const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
        timers.add(timer); return timer;
      };
      const cleanup = () => {
        active = false;
        for (const timer of timers) clearTimeout(timer);
        timers.clear(); pending.clear();
        removeEventListener('pagehide', cleanup);
      };
      const finish = (id, text) => {
        if (!active || !pending.has(id)) return;
        clearTimeout(pending.get(id)); timers.delete(pending.get(id)); pending.delete(id);
        rows[id - 1] = times[id - 1] + 's: ' + text.slice(0, 2048); finished++; draw();
        if (finished === 5) cleanup();
      };
      const scalars = value => Object.fromEntries(Object.entries(value || {}).slice(0, 32)
        .filter(([key, field]) => /^[A-Za-z][A-Za-z0-9]{0,47}$/.test(key)
          && (typeof field === 'boolean' || typeof field === 'number' && Number.isFinite(field))));
      const accept = reply => {
        if (!active || !reply || !Number.isInteger(reply.id) || !pending.has(reply.id)) return;
        if (reply.error === 'host-not-ready' || reply.error === 'census-failed') { finish(reply.id, reply.error); return; }
        if (!Number.isFinite(reply.atMs) || !reply.resources || !reply.frames || !reply.rpc || !reply.yield) return;
        finish(reply.id, JSON.stringify({atMs: reply.atMs, resources: scalars(reply.resources),
          frames: scalars(reply.frames), rpc: scalars(reply.rpc), yield: scalars(reply.yield)}));
      };
      const start = frames => {
        if (!active || started || !Number.isFinite(frames) || frames <= 0) return;
        started = true;
        times.forEach((time, index) => {
          rows[index] = time + 's: scheduled';
          schedule(() => {
            if (!active) return;
            const id = index + 1;
            pending.set(id, schedule(() => finish(id, 'timeout (worker did not reply)'), 10000));
            rows[index] = time + 's: waiting'; draw();
            try { gpuWorker.postMessage({mcwebResourceCensusRequest: id}); }
            catch { finish(id, 'worker message failed'); }
          }, time * 1000);
        });
        draw();
      };
      addEventListener('pagehide', cleanup, {once: true}); draw();
      return {accept, start, cleanup};
    };
    const resourceCensus = installResourceCensus();
    gpuWorker.onmessage = (e) => {
      const d = e.data;
      if (d && d.mcwebResourceCensus) resourceCensus?.accept(d.mcwebResourceCensus);
      if (d && d.mcwebLog) out(d.mcwebLog);
      if (d && typeof d.mcwebFrames === 'number') {
        globalThis.__mcWebFrames = d.mcwebFrames;
        resourceCensus?.start(d.mcwebFrames);
      }
      if (d && typeof d.mcwebCursorWanted === 'boolean') cursorWanted(d.mcwebCursorWanted);
      if (d && d.mcwebAudio) playAudio(d.mcwebAudio);

    };
    // Sound (see worker-env.js): the JVM's calls arrive from the GPU Worker
    // with its own handles; the real host plays them here, where WebAudio
    // exists, and finished sounds are reported back four times a second.
    const audioHandles = new Map();   // Worker handle -> host handle
    const audioScript = document.createElement('script');
    audioScript.src = 'audio-host.js';
    document.head.appendChild(audioScript);
    const playAudio = ({ m, a }) => {
      const host = globalThis.mcWebAudio;
      if (!host) return;
      try {
        if (m === 'playInstance') {
          const handle = host.playInstance(a[1], a[2], a[3], a[4], a[5]);
          if (handle) audioHandles.set(a[0], handle);
          else gpuWorker.postMessage({ mcwebAudioEnded: [a[0]] });
        } else if (m === 'positionInstance' || m === 'stopInstance') {
          const handle = audioHandles.get(a[0]);
          if (handle !== undefined) host[m](handle, ...a.slice(1));
          if (m === 'stopInstance') audioHandles.delete(a[0]);
        } else if (m === 'stopAll') {
          host.stopAll();
          audioHandles.clear();
        } else if (typeof host[m] === 'function') {
          host[m](...a);
        }
      } catch (e) {
        console.warn('[audio] ' + m + ': ' + (e && e.message || e));
      }
    };
    const audioInterval = setInterval(() => {
      const host = globalThis.mcWebAudio;
      if (!host || audioHandles.size === 0) return;
      const ended = [];
      for (const [worker, handle] of audioHandles) {
        if (!host.isPlaying(handle)) { ended.push(worker); audioHandles.delete(worker); }
      }
      if (ended.length) gpuWorker.postMessage({ mcwebAudioEnded: ended });
    }, 250);
    const localRelayPort = globalThis.mcWebLocalRelay?.attachWorker?.();
    gpuWorker.postMessage({ mcwebRpcInit: { canvas: Module.mcWebCanvas, localRelayPort } },
      [Module.mcWebCanvas, ...(localRelayPort ? [localRelayPort] : [])]);
    globalThis.__mcWebGpuWorker = gpuWorker;
    discardGpu = () => {
      clearInterval(audioInterval);
      resourceCensus?.cleanup();
      inputListeners.abort();
      audioHandles.clear();
      try { if (document.pointerLockElement === Module.mcWebCanvasElement) document.exitPointerLock(); } catch {}
      restoreWorkerMessages?.();
      if (globalThis.__mcWebGpuWorker === gpuWorker) {
        delete globalThis.__mcWebGpuWorker;
        delete globalThis.__mcWebJoin;
        delete globalThis.__mcWebRpcAttached;
      }
      gpuWorker.onmessage = null;
      return new Promise(resolve => {
        let settled = false, timer;
        const finish = acknowledgement => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          gpuWorker.removeEventListener('message', acknowledged);
          let terminationRequested = false, terminationError;
          try { gpuWorker.terminate(); terminationRequested = true; }
          catch (error) { terminationError = String(error); }
          resolve({owned: true, terminationRequested, ...acknowledgement,
            ...(terminationError ? {error: terminationError} : {})});
        };
        const acknowledged = event => {
          if (event.data?.mcwebDiscarded?.version === 1) {
            const value = event.data.mcwebDiscarded;
            finish({acknowledged: !value.error, resources: value.resources,
              ...(value.error ? {error: value.error} : {})});
          }
        };
        timer = setTimeout(() => finish({acknowledged: false}), 1000);
        gpuWorker.addEventListener('message', acknowledged);
        try { gpuWorker.postMessage({mcwebDiscard: {version: 1}}); }
        catch (error) { finish({acknowledged: false, error: String(error)}); }
      });
    };
    // Test/automation entry point for a multiplayer join, forwarded to the
    // Worker that owns mcWebNet.
    globalThis.__mcWebJoin = (host, port, name) =>
        gpuWorker.postMessage({ mcwebJoin: { host, port: Number(port), name: name || 'Tester' } });

    // Input lives on the page: the canvas element is here, the host that knows
    // how to read a DOM event is on the GPU Worker, and Java is a third thread
    // away. Only the fields the host reads are forwarded, with pointer
    // coordinates already converted to canvas pixels — the worker's
    // getBoundingClientRect reports the backing store, so its own conversion is
    // then the identity.
    const canvasElement = Module.mcWebCanvasElement;
    if (canvasElement) {
      globalThis.__mcWebDomForwarded = 0;
      const forward = (type, event, overrides = {}) => {
        globalThis.__mcWebDomForwarded++;
        const rect = canvasElement.getBoundingClientRect();
        const scaleX = rect.width > 0 ? canvasElement.width / rect.width : 1;
        const scaleY = rect.height > 0 ? canvasElement.height / rect.height : 1;
        const clientX = Number.isFinite(event.clientX) ? event.clientX : rect.left;
        const clientY = Number.isFinite(event.clientY) ? event.clientY : rect.top;
        gpuWorker.postMessage({ mcwebDom: { type, init: {
          clientX: (clientX - rect.left) * scaleX,
          clientY: (clientY - rect.top) * scaleY,
          movementX: (event.movementX || 0) * scaleX,
          movementY: (event.movementY || 0) * scaleY,
          button: event.button ?? 0, buttons: event.buttons ?? 0,
          code: event.code, key: event.key, repeat: Boolean(event.repeat),
          ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
          altKey: event.altKey, metaKey: event.metaKey,
          deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
          ...overrides,
        } } });
        if (type === 'contextmenu' || type === 'wheel') event.preventDefault();
      };
      let suppressCompatibilityMouseUntil = 0;
      const forwardMouse = (type, event) => {
        if (performance.now() < suppressCompatibilityMouseUntil
            && (type === 'mousemove' || type === 'mousedown' || type === 'mouseup')) return;
        forward(type, event);
      };
      for (const type of ['mousemove', 'mousedown', 'wheel', 'contextmenu']) {
        listen(canvasElement, type, (event) => forwardMouse(type, event),
            { passive: type === 'mousemove' });
      }
      // Safari does not synthesize compatibility mouse events for every
      // trusted touch. Forward a primary non-mouse pointer directly only when
      // the canvas owns the gesture. The listener runs at window bubble time:
      // the mobile controls overlay sees the event first and prevents it, so
      // its own mouse/key translation and this fallback can never both fire.
      // Cancelling an otherwise unhandled pointerdown suppresses a later
      // compatibility mouse pair.
      let directPointer = null;
      let directPoint = null;
      let directTouchIdentifier = null;
      const finishDirectPointer = (event) => {
        if (directPointer === null || event.pointerId !== directPointer) return;
        event.preventDefault();
        directPoint = event;
        forward('mouseup', event, { button: 0, buttons: 0 });
        directPointer = null;
      };
      if ('PointerEvent' in globalThis) {
        listen(globalThis, 'pointerdown', (event) => {
          if (event.target !== canvasElement || event.defaultPrevented
              || event.pointerType === 'mouse' || !event.isPrimary || directPointer !== null) return;
          event.preventDefault();
          directPointer = event.pointerId;
          directPoint = event;
          suppressCompatibilityMouseUntil = performance.now() + 1000;
          try { canvasElement.setPointerCapture(event.pointerId); } catch {}
          forward('mousedown', event, { button: 0, buttons: 1 });
        }, { passive: false });
        listen(globalThis, 'pointermove', (event) => {
          if (event.pointerId !== directPointer) return;
          event.preventDefault();
          directPoint = event;
          forward('mousemove', event, { button: 0, buttons: 1 });
        }, { passive: false });
        listen(globalThis, 'pointerup', finishDirectPointer, { passive: false });
        listen(globalThis, 'pointercancel', finishDirectPointer, { passive: false });
      } else {
        // Old WebKit fallback. Modern Safari takes the PointerEvent branch.
        const findTouch = (event) => Array.from(event.changedTouches || [])
            .find((touch) => touch.identifier === directTouchIdentifier);
        listen(canvasElement, 'touchstart', (event) => {
          if (directTouchIdentifier !== null || event.changedTouches.length !== 1) return;
          event.preventDefault();
          const touch = event.changedTouches[0];
          directTouchIdentifier = touch.identifier;
          suppressCompatibilityMouseUntil = performance.now() + 1000;
          directPoint = touch;
          forward('mousedown', touch, { button: 0, buttons: 1 });
        }, { passive: false });
        listen(canvasElement, 'touchmove', (event) => {
          const touch = findTouch(event);
          if (!touch) return;
          event.preventDefault();
          directPoint = touch;
          forward('mousemove', touch, { button: 0, buttons: 1 });
        }, { passive: false });
        const finishTouch = (event) => {
          const touch = findTouch(event);
          if (!touch) return;
          event.preventDefault();
          directPoint = touch;
          forward('mouseup', touch, { button: 0, buttons: 0 });
          directTouchIdentifier = null;
        };
        listen(globalThis, 'touchend', finishTouch, { passive: false });
        listen(globalThis, 'touchcancel', finishTouch, { passive: false });
      }
      listen(globalThis, 'blur', () => {
        if ((directPointer === null && directTouchIdentifier === null) || !directPoint) return;
        forward('mouseup', directPoint, { button: 0, buttons: 0 });
        directPointer = null;
        directTouchIdentifier = null;
      });
      // Pointer lock belongs to this page. Escape and native lock loss must
      // free it even if the GPU Worker or Java cannot process input yet.
      let wantLock = false;
      let requestedLock = false;
      let escapeReleasePending = false;
      const releasePagePointerLock = () => {
        wantLock = false;
        if (document.pointerLockElement === canvasElement) {
          try { document.exitPointerLock()?.catch?.(() => {}); } catch {}
        }
      };
      const lock = (event) => {
        if ((event && event.target !== canvasElement) || document.querySelector?.('dialog[open]')) return;
        if (!wantLock || document.pointerLockElement === canvasElement || !canvasElement.requestPointerLock) return;
        // A plain lock preserves the platform's ordinary pointer acceleration.
        try { canvasElement.requestPointerLock()?.catch?.(() => {}); } catch {}
      };
      cursorWanted = (want) => {
        const rising = want && !requestedLock;
        requestedLock = want;
        if (!want) releasePagePointerLock();
        else if (rising) {
          // After browser release a repeated/stale true cannot recapture.
          // A genuine false -> true request from the game rearms the lock.
          wantLock = true;
          if (!navigator.userActivation || navigator.userActivation.isActive) lock();
        }
      };
      // The host listens on the window because releases outside the canvas
      // still belong to the game. Release before forwarding Escape to Java.
      for (const type of ['keydown', 'keyup', 'mouseup']) {
        listen(globalThis, type, (event) => {
          if (type === 'keydown' && event.code === 'Escape'
              && (wantLock || document.pointerLockElement === canvasElement)) {
            escapeReleasePending = document.pointerLockElement === canvasElement;
            releasePagePointerLock();
          }
          forwardMouse(type, event);
        });
      }
      listen(globalThis, 'blur', releasePagePointerLock);
      listen(canvasElement, 'mousedown', lock);
      listen(document, 'pointerlockchange', () => {
        const locked = document.pointerLockElement === canvasElement;
        const escapeDispatched = !locked && escapeReleasePending;
        if (!locked) { wantLock = false; escapeReleasePending = false; }
        gpuWorker.postMessage({ mcwebDom: { type: 'pointerlockchange',
          init: { locked, escapeDispatched } } });
        // A request initiated before Escape can acquire after it was disarmed.
        if (locked && !wantLock) releasePagePointerLock();
      });
    }
    if (!Worker.prototype.__mcWebRpcPatched) {
      Worker.prototype.__mcWebRpcPatched = true;
      const realPostMessage = Worker.prototype.postMessage;
      const patchedPostMessage = function (msg, options) {
        if (globalThis.__mcWebGpuWorker && msg && msg.cmd === 2
            && !globalThis.__mcWebRpcAttached) {
          if ((new Error()).stack.includes('callMain')) {
            return realPostMessage.call(this, msg, options);
          }
          globalThis.__mcWebRpcAttached = true;
          const channel = new MessageChannel();
          const sab = new SharedArrayBuffer(1 << 25);
          // Input mailbox: the GPU worker appends each input event, Java
          // takes them with no round trip (see installMcWebRpcClient).
          const inputSab = new SharedArrayBuffer(1 << 16);
          globalThis.__mcWebGpuWorker.postMessage(
              { mcwebRpcPort: channel.port1, mcwebRpcSab: sab, mcwebInputSab: inputSab },
              [channel.port1]);
          msg.mcwebRpc = { port: channel.port2, sab, inputSab, search: location.search };
          const transfer = Array.isArray(options) ? options.slice()
            : options && options.transfer ? options.transfer.slice() : [];
          transfer.push(channel.port2);
          return realPostMessage.call(this, msg, transfer);
        }
        return realPostMessage.call(this, msg, options);
      };
      Worker.prototype.postMessage = patchedPostMessage;
      restoreWorkerMessages = () => {
        if (Worker.prototype.postMessage !== patchedPostMessage) return;
        Worker.prototype.postMessage = realPostMessage;
        delete Worker.prototype.__mcWebRpcPatched;
      };
    }
  }
} else if (typeof ENVIRONMENT_IS_NODE === 'undefined' || !ENVIRONMENT_IS_NODE) {
  // JVM Worker side. Registered at script evaluation, ahead of the
  // self.onmessage the loader assigns later, so this capture-phase listener
  // sees CMD_RUN #2 before handleMessage does and installs the gate the
  // loader awaits (patch-javavm.mjs).
  self.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.cmd !== 2 || !d.mcwebRpc || globalThis.__mcWebWorkerGate) return;
    globalThis.__mcWebWorkerGate = (async () => {
      try {
        installMcWebRpcClient(d.mcwebRpc.port, d.mcwebRpc.sab, d.mcwebRpc.search || '',
            d.mcwebRpc.inputSab || null);
        const ready = await new Promise((resolve, reject) => {
          const timer = setTimeout(
              () => reject(new Error('GPU worker not ready within 30 s')), 30000);
          d.mcwebRpc.port.onmessage = (e2) => {
            if (e2.data && e2.data.mcwebReady) { clearTimeout(timer); resolve(e2.data); return; }
            // The GPU worker posts frame ticks on this same port; the global
            // message listener never sees port messages, so dispatch here.
            if (e2.data && e2.data.mcwebEvent === 'pump' && globalThis.__mcWebFrameCallback) {
              try { globalThis.__mcWebFrameCallback(); } catch (err) {
                console.error('[mcweb] frame callback threw: ' + (err && err.stack || err));
              }
            }
          };
        });
        out('[gpu-host] worker host ready: ' + ready.adapter
            + ' (' + ready.width + 'x' + ready.height + ')');
      } catch (err) {
        out('[gpu-host] init failed: ' + (err && err.stack || err));
        throw err;
      }
    })();
  });

  // The GPU worker's pump loop posts this each vsync; deliver it to the Java
  // frame callback while the JVM worker's event loop is free (between frames).
  self.addEventListener('message', (e) => {
    if (e.data && e.data.mcwebEvent === 'pump' && globalThis.__mcWebFrameCallback) {
      try {
        globalThis.__mcWebFrameCallback();
      } catch (err) {
        console.error('[mcweb] frame callback threw: ' + (err && err.stack || err));
      }
    }
  });

  // Synchronous RPC client: park in Atomics.wait on the response flag while
  // the GPU Worker runs the host methods. Same mechanism Emscripten uses for
  // proxied main-thread calls, so it is safe from a pthread.
  //
  // Frame calls are batched: Chromium invalidates an unpresented current
  // swap-chain texture when the event loop turns, so acquire -> render ->
  // submit must execute in one task on the GPU Worker. The client buffers
  // from the first encoder/canvas-texture call of a frame until present().
  //
  // A batched call has to answer Java before the host has run it, so Java gets
  // a placeholder. The placeholder is then made real: the GPU Worker moves the
  // created object onto it (mcWebGpu.rekeyObject), so from the host's point of
  // view the placeholder IS the handle, for as long as the object lives.
  //
  // Everything else was tried first and is not worth reinventing. Batch
  // indices alias, because Java keeps handles far past the batch that made
  // them. A side table needs lifetimes, and getting one wrong frees a handle
  // Java still holds — which surfaces a thousand frames later as a raw
  // negative number in a draw call. Renaming the object needs no lifetimes at
  // all: the handle dies exactly when the object does, by the same
  // destroy/GC path as any other.
  const PLACEHOLDER_BASE = -1000000;
  function installMcWebRpcClient(port, sab, pageSearch, inputSab) {
    const i32 = new Int32Array(sab, 0, 16);
    // Input without a round trip. Java drains input once a frame, and as an
    // RPC that was the frame's first synchronous call: it waited for the GPU
    // worker to finish drawing the previous frame, so the two workers never
    // overlapped. The GPU worker appends each event's line to this mailbox
    // under a spin lock (int 0; int 1 = bytes used; text from byte 64).
    const inputDrain = inputSab ? (() => {
      const h = new Int32Array(inputSab, 0, 16);
      const bytes = new Uint8Array(inputSab, 64);
      const dec2 = new TextDecoder();
      return () => {
        while (Atomics.compareExchange(h, 0, 0, 1) !== 0) { /* the writer holds it briefly */ }
        const n = h[1];
        const text = n > 0 ? dec2.decode(bytes.slice(0, n)) : '';
        h[1] = 0;
        Atomics.store(h, 0, 0);
        return text.endsWith('\n') ? text.slice(0, -1) : text;
      };
    })() : null;
    const data = new Uint8Array(sab, 4096);
    // Two request slots, used in turn: a request waits only for the worker
    // to have taken the request before it in the same slot. With one slot,
    // present() -- async, nothing comes back -- still waited for the worker
    // to wake up and copy it out, ~1 ms of postMessage latency every frame
    // with the GPU worker 70% idle. i32[8 + slot] = 1 once the slot is free.
    const SLOT_BYTES = Math.floor(data.length / 2) & ~7;
    let nextSlot = 0;
    Atomics.store(i32, 8, 1);
    Atomics.store(i32, 9, 1);
    // Transport slots become free after copying. GPU completion owns separate
    // frame credits, so ordinary RPCs can reuse either slot during a frame.
    Atomics.store(i32, 10, 2);
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    // The JSON request goes below this, binary arguments above. A frame's
    // batch in a world is ~300 calls; at 64 KB it did not fit, was split, and
    // the first half went synchronously -- a ~1.9 ms wait every frame.
    const PAYLOAD_BASE = 1 << 20;
    let batch = null;      // null = send each call immediately
    // GPU calls whose return value Java never reads: every one is declared
    // void on the Java side, so deferring them costs nothing but ordering,
    // which the flush above preserves. Anything not listed here still goes
    // synchronously, so a mistake of omission is only a lost optimisation.
    const AUDIO_VOID = new Set(['positionInstance', 'setListener', 'setListenerPose', 'setVolume', 'setCategoryVolume']);
    const audioPlaying = new Set();
    const DEFERRABLE = new Set([
      'rpSetUniform', 'rpSetPipeline', 'rpBindTexture', 'rpDraw', 'rpDrawBatch',
      'rpDrawIndexed', 'rpDrawIndexedBatch', 'rpSetVertexBuffer',
      'rpSetIndexBuffer', 'rpEnd', 'rpScissor', 'rpDisableScissor',
      'rpPushDebugGroup', 'rpPopDebugGroup',
      'clearColorAndDepth', 'clearDepth', 'copyBuffer', 'submit',
      // Measured in the world (?mcweb_rpcstats): ~50 blocking round trips a
      // frame, each waiting for the GPU worker to drain everything queued
      // before it - 12-17% of the render thread. These five were nearly all
      // of them. The writes and the copy are void, and their bytes are copied
      // at call time (snapshotBinary). The pass and the encoder return a
      // handle Java only ever passes back, so a placeholder serves: the GPU
      // worker renames the object onto it when the call runs.
      'beginRenderPass', 'createCommandEncoder', 'writeBufferBytes', 'rpCommandStreamRaw',
      'writeTextureBytes', 'copyTexture',
    ]);
    // Host answers that cannot change during a session: asked once, cached.
    // drawBatchEnabled came once per render pass, as a round trip of its own.
    const CONSTANT = new Set(['drawBatchEnabled']);
    const constants = new Map();
    const missingObjects = new Set();
    // ?mcweb_nopipeline: present() waits for the GPU worker to finish the
    // frame, as it used to.
    const pipelineOff = (() => {
      try { return new URLSearchParams(pageSearch).has('mcweb_nopipeline'); } catch { return false; }
    })();
    let nextRef = PLACEHOLDER_BASE;
    const rpcStats = (() => {
      try { return new URLSearchParams(pageSearch).has('mcweb_rpcstats')
          ? { sync: new Map(), flushedBy: new Map(), at: Date.now(), waits: new Map(), waitAt: Date.now() } : null; }
      catch { return null; }
    })();
    // ?mcweb_rpcstats: time spent waiting for the GPU worker, by the call
    // that ended each request, every 10 s on runtime stdout, including the page log.
    const noteWait = (k, start) => {
      const ms = performance.now() - start;
      const w = rpcStats.waits.get(k) || { n: 0, ms: 0, max: 0 };
      w.n++; w.ms += ms; if (ms > w.max) w.max = ms;
      rpcStats.waits.set(k, w);
      if (Date.now() - rpcStats.waitAt > 10000) {
        rpcStats.waitAt = Date.now();
        out('[rpc-wait] ' + [...rpcStats.waits].sort((x, y) => y[1].ms - x[1].ms).slice(0, 10)
            .map(([key, v]) => key + ' n=' + v.n + ' ms=' + v.ms.toFixed(0) + ' avg=' + (v.ms / v.n).toFixed(2)
                + ' max=' + v.max.toFixed(1)).join(' | '));
        rpcStats.waits.clear();
      }
    };
    // Detach a binary argument from the wasm heap. One copy, taken while the
    // bytes are still valid; mapArg would have copied anyway, just too late.
    const snapshotBinary = (a) => {
      if (a instanceof ArrayBuffer) return a.slice(0);
      if (ArrayBuffer.isView(a)) {
        return new Uint8Array(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      }
      return a;
    };
    const mapArg = (a, off) => {
      if (ArrayBuffer.isView(a) || a instanceof ArrayBuffer) {
        const bytes = a instanceof ArrayBuffer ? new Uint8Array(a)
            : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        if (off.o + bytes.length > off.limit) throw new RangeError('rpc slot full');
        data.set(bytes, off.o);
        const marker = { __bin: off.o, len: bytes.length };
        off.o = (off.o + bytes.length + 3) & ~3;
        return marker;
      }
      // Large strings (base64 uploads) bypass JSON: UTF-8 into the payload.
      if (typeof a === 'string' && a.length > 2048) {
        const bytes = enc.encode(a);
        if (off.o + bytes.length > off.limit) throw new RangeError('rpc slot full');
        data.set(bytes, off.o);
        const marker = { __str: off.o, len: bytes.length };
        off.o = (off.o + bytes.length + 3) & ~3;
        return marker;
      }
      return a;
    };
    // A batch that does not fit is split, never dropped. Deferred calls are
    // void and run in order either way, and placeholders are renamed on the
    // host for good, so halves sent one after the other behave exactly like
    // the whole. Dropping one was how an atlas upload (thousands of sprite
    // draws: ~200 KB of JSON against the 64 KB header) lost its pass end,
    // which left Mojang's command encoder invalid for the rest of the session:
    // empty atlases, no GUI sprites, black terrain.
    const TOO_LARGE = Symbol('rpc batch too large');
    // async: wait only until the GPU worker has copied the request out, not
    // for it to run (present(): nothing comes back, and the next call that
    // needs an answer waits behind this batch anyway).
    const sendParts = (calls, async = false) => {
      const res = sendOnce(calls, async);
      if (res !== TOO_LARGE) return res;
      if (calls.length < 2) throw new Error('rpc request too large: one call ' + calls[0].o + '.' + calls[0].m);
      const mid = calls.length >> 1;
      // Halves of an async request stay async: the GPU worker runs requests
      // in order, so nothing needs the first half's results.
      return sendParts(calls.slice(0, mid), async).concat(sendParts(calls.slice(mid), async));
    };
    // Chatty progress markers (per packet, per frame): void, and nothing
    // waits on them, so they ride along with the next request of any kind
    // instead of each costing a synchronous round trip -- and a flush of the
    // frame's pending GPU batch -- of its own (~30 a second in a world,
    // mostly block-update packets). Delivery waits for the next request or
    // the 256-marker bound; within a pending render batch, markers precede
    // its GPU calls rather than retaining their interleaving with them.
    const CHATTY = /^(evt:|packet:|terrain:|gameplay-state:|threads:|chunk:|pumpslow:|levelload:|server:tick|flow:|framesplit:|entitytick:|frametime:)/;
    let pendingDiag = [];
    const send = (calls, async = false) => {
      if (!pendingDiag.length) return sendParts(calls, async);
      const diag = pendingDiag;
      pendingDiag = [];
      const res = sendParts(diag.concat(calls), async);
      return async ? res : res.slice(diag.length);
    };
    const sendOnce = (calls, async = false) => {
      const slot = nextSlot;
      const base = slot * SLOT_BYTES;
      // The worker still copying the last request out of this slot: wait.
      while (Atomics.load(i32, 8 + slot) !== 1) Atomics.wait(i32, 8 + slot, 0);
      const off = { o: base + PAYLOAD_BASE, limit: base + SLOT_BYTES };
      let mapped;
      try {
        mapped = calls.map((c) => ({
          o: c.o, m: c.m, r: c.r, a: (c.a || []).map((a) => mapArg(a, off)),
        }));
      } catch (e) {
        if (e instanceof RangeError) return TOO_LARGE;   // binary payload overflow
        throw e;
      }
      // enc.encodeInto straight into the slot's request area would avoid the
      // intermediate array, but Chrome refuses a view on a SharedArrayBuffer
      // ("must not be shared"), and this is the one buffer that is shared.
      const req = enc.encode(JSON.stringify(async ? { batch: mapped, async: true } : { batch: mapped }));
      if (req.length > PAYLOAD_BASE) return TOO_LARGE;
      const frameCredit = async && calls.some(c => c.o === 'gpu' && c.m === 'present');
      if (frameCredit) {
        for (;;) {
          const available = Atomics.load(i32, 10);
          if (available > 0 && Atomics.compareExchange(i32, 10, available, available - 1) === available) break;
          i32[5] = 0x1005; // waiting only at a present boundary
          Atomics.wait(i32, 10, 0);
        }
      }
      data.set(req, base);
      i32[2] = req.length;
      nextSlot = slot ^ 1;
      Atomics.store(i32, 8 + slot, 0);
      Atomics.store(i32, 1, 0);
      Atomics.store(i32, 4, 0);
      Atomics.add(i32, 6, 1); // send count
      const waitStart = rpcStats ? performance.now() : 0;

      try {
        port.postMessage({ rpc: 1, slot, base, len: req.length, frameCredit });
      } catch (error) {
        Atomics.store(i32, 8 + slot, 1);
        Atomics.notify(i32, 8 + slot);
        if (frameCredit) {
          Atomics.add(i32, 10, 1);
          Atomics.notify(i32, 10);
        }
        throw error;
      }
      i32[5] = 0x1111; // about to wait
      if (async) {
        // Nothing comes back, and the other slot is free for the next request.
        i32[5] = 0x2222;
        Atomics.add(i32, 7, 1); // done count
        if (rpcStats) noteWait('async:' + calls[calls.length - 1].o + '.' + calls[calls.length - 1].m, waitStart);
        return [];
      }
      Atomics.wait(i32, 1, 0);
      if (rpcStats) noteWait((calls.length > 1 ? 'batch-then:' : 'sync:') + calls[calls.length - 1].o + '.' + calls[calls.length - 1].m, waitStart);
      i32[5] = 0x2222; // woke
      Atomics.add(i32, 7, 1); // done count
      const respLen = i32[3];
      if (!respLen) throw new Error('rpc: empty response for ' + calls.map(c => c.o + '.' + c.m).join(','));
      // The copy out of the shared slot is not optional: TextDecoder.decode()
      // refuses a view on a SharedArrayBuffer ("must not be shared"), and the
      // RPC wire is exactly that.
      const resp = JSON.parse(dec.decode(data.subarray(base, base + respLen).slice()));
      if (resp.ae) for (const handle of resp.ae) audioPlaying.delete(handle);
      if (resp.e) throw new Error(resp.e);
      return resp.results;
    };
    const call = (objName, method, args) => send([{ o: objName, m: method, a: args }])[0];
    const lastCallView = new Uint8Array(sab, 64, 128);
    // The call names come from a fixed vocabulary (a few dozen methods), so
    // each is encoded once per RPC object and the marker is a copy from then
    // on: the previous version TextEncoded objName + '.' + method on every
    // call that waits, and cleared all 128 marker bytes before doing so. A
    // hang report reads the same marker either way.
    const callNames = new Map();
    const markCall = (objName, method) => {
      let perObject = callNames.get(objName);
      if (perObject === undefined) {
        callNames.set(objName, perObject = new Map());
      }
      let bytes = perObject.get(method);
      if (bytes === undefined) {
        bytes = enc.encode(objName + '.' + method);
        perObject.set(method, bytes);
      }
      const n = Math.min(bytes.length, 127);
      lastCallView.set(bytes.subarray(0, n), 0);
      // Terminate in place instead of zeroing the whole marker first: the
      // reader scans to the first NUL.
      lastCallView[n] = 0;
    };
    const proxy = (objName) => new Proxy({}, {
      // BrowserInputCompat.setCursorDisabled arms pointer lock by setting
      // mcWebInput.lockPointerOnNextClick. Here that object is this proxy, so
      // the write used to land on the proxy's empty target and the host never
      // saw it: the cursor was never captured on this lane. It is carried to
      // the host instead (worker-env.js), which also tells the page.
      set: (t, prop, value) => {
        if (objName === 'input' && prop === 'lockPointerOnNextClick') {
          call('input', 'setLockPointerOnNextClick', [Boolean(value)]);
        }
        return true;
      },
      get: (t, prop) => {
        return (...args) => {
          // A cached constant needs no round trip, and must not flush the batch.
          if (objName === 'gpu' && CONSTANT.has(prop) && constants.has(prop)) return constants.get(prop);
          if (objName === 'input' && prop === 'drain' && inputDrain) return inputDrain();
          if (objName === 'gpu' && prop === 'reportProgress' && typeof args[0] === 'string'
              && CHATTY.test(args[0])) {
            pendingDiag.push({ o: 'gpu', m: 'reportProgress', a: [args[0]] });
            if (pendingDiag.length >= 256) send([]);
            return undefined;
          }
          i32[5] = 0x1000; // marked
          // Acquiring the canvas texture is what starts the one-task window:
          // everything from there to present() has to run without the event
          // loop turning. Creating the encoder does not (and must not) open
          // it -- Minecraft creates its encoder long before the first frame.
          const opensFrame = objName === 'gpu' && prop === 'acquireCanvasTexture';
          // A frame that threw between createCommandEncoder and submit leaves
          // a dangling batch. Diagnostics carry no handles and are exactly what
          // the pump's failure path emits next, so flush there.
          const isDiag = objName === 'gpu'
              && (prop === 'reportProgress' || prop === 'reportSuccess' || prop === 'reportJavaFailure');
          if (batch && isDiag) {
            const dangling = batch;
            batch = null;
            try { send(dangling); } catch (flushError) {
              console.warn('[rpc] dangling batch flush failed: ' + flushError);
            }
          }
          if (opensFrame && !batch) batch = [];
          // Widen the window. Mojang acquires the canvas texture late, so
          // acquire->present covered almost nothing: measured 1.5 calls per
          // batch and ~1,830 synchronous round trips per second, with the GPU
          // worker idle 99.6% of the time. Render commands are void and their
          // results are never read, so they can accumulate instead, and the
          // batch is flushed the moment anything needs a real answer - which
          // keeps ordering exact.
          const deferrable = (objName === 'gpu' && DEFERRABLE.has(prop))
              || (objName === 'audio' && AUDIO_VOID.has(prop));
          if (deferrable && !batch) batch = [];
          if (batch && !deferrable && !opensFrame && prop !== 'present') {
            const pending = batch;
            batch = null;
            if (rpcStats) {
              const k = objName + '.' + String(prop);
              rpcStats.flushedBy.set(k, (rpcStats.flushedBy.get(k) || 0) + pending.length);
            }
            send(pending);
          }
          i32[5] = 0x1001; // batch-checked
          if (batch && objName === 'audio' && deferrable) {
            // A sound's position, the listener: void, and their order
            // against rendering does not matter, so they ride the batch.
            batch.push({ o: objName, m: prop, a: args });
            return undefined;
          }
          if (batch && objName === 'gpu') {
            // The placeholder the host will rename its object onto. Arguments
            // need no translation at all: a placeholder Java hands back is
            // already the host's handle for that object.
            const ref = nextRef--;
            // Binary arguments MUST be copied here, not at flush time. A
            // byte[] reaches this call as a view on the wasm heap, and the
            // generated JNI bridge calls ReleaseByteArrayElements the moment
            // the EM_JS body returns - so by the time send() runs mapArg over
            // a batched call, the view points at freed memory the JVM has
            // already reused. That is how "net/minecraft/client/rende..."
            // ended up inside the level camera projection UBO, which put every
            // terrain vertex outside clip space and left the world invisible.
            batch.push({ o: objName, m: prop, r: ref, a: args.map(snapshotBinary) });
            // present() ends the one-task window, not submit(): the canvas
            // texture is copied into after the frame's commands are submitted,
            // and closing at submit left present in a task of its own with a
            // texture Chromium had already invalidated.
            if (prop === 'present') {
              const sent = batch;
              batch = null;
              send(sent, !pipelineOff);
              return undefined;
            }
            return ref;
          }
          // The last synchronous call, for a hang report. Only calls that wait
          // are marked: marking every deferred one (~300 a frame) cost ~2%
          // of the render thread in TextEncoder alone.
          markCall(objName, String(prop));
          i32[5] = 0x1003; // entering call
          // ?mcweb_rpcstats: which calls cost a synchronous round trip, and
          // how many batched calls each one flushed. Every 10 s on runtime stdout.
          if (rpcStats) {
            const k = objName + '.' + String(prop);
            rpcStats.sync.set(k, (rpcStats.sync.get(k) || 0) + 1);
            if (Date.now() - rpcStats.at > 10000) {
              rpcStats.at = Date.now();
              out('[rpc-stats] sync ' + [...rpcStats.sync].sort((x, y) => y[1] - x[1]).slice(0, 14)
                  .map(([n, c]) => n + '=' + c).join(' ') + ' | flushedBy ' + [...rpcStats.flushedBy]
                  .sort((x, y) => y[1] - x[1]).slice(0, 8).map(([n, c]) => n + '=' + c).join(' '));
              rpcStats.sync.clear(); rpcStats.flushedBy.clear();
            }
          }
          // An object the GPU worker does not host (audio, when the bundle
          // stages none) fails the same way every time: skip the round trip.
          if (missingObjects.has(objName)) return undefined;
          let result;
          try {
            result = call(objName, prop, args);
          } catch (e) {
            if (String(e && e.message).startsWith('unknown rpc object: ')) missingObjects.add(objName);
            throw e;
          }
          if (objName === 'gpu' && CONSTANT.has(prop)) constants.set(prop, result);
          return result;
        };
      },
    });
    globalThis.mcWebRuntimeMode = 'WASMGC_COOPERATIVE';
    globalThis.mcWebGpu = proxy('gpu');
    // The render-command protocol (web/render-command-stream.js) is decoded on
    // the GPU Worker; declaring it here is what lets the port batch a whole
    // render pass into one command stream (BrowserGpu.queryRenderPassMode,
    // rpCommandStreamBytes) instead of a call per command.
    globalThis.mcWebRenderCommands = { VERSION: 1 };
    // The pump callback re-enters Java; it cannot cross the RPC boundary as a
    // function. register() keeps the Java callback locally and the GPU-side
    // pump loop is wired to it when the Minecraft step lands.
    globalThis.mcWebPump = {
      register: (cb) => { globalThis.__mcWebFrameCallback = cb; },
      configure: (...a) => call('pump', 'configure', a),
      // Void and once a frame: as a call of its own it cost a synchronous
      // round trip every frame (~1.8-3.5 ms, ?mcweb_rpcstats). It rides with
      // the frame's batch instead, which present() sends.
      frameReported: (...a) => {
        if (!batch) batch = [];
        batch.push({ o: 'pump', m: 'frameReported', a });
      },
    };
    globalThis.mcWebInput = proxy('input');
    // Sound: isPlaying is asked for every sound every tick, and as an RPC it
    // was a synchronous round trip that also flushed the frame's GPU batch
    // (~60 a second in a world). The handles playInstance returns are kept
    // here, and finished ones come back on every RPC answer (resp.ae), so it
    // is answered locally.
    const audioProxy = proxy('audio');
    globalThis.mcWebAudio = new Proxy(audioProxy, {
      get: (t, prop) => {
        if (prop === 'isPlaying') return (handle) => audioPlaying.has(handle);
        if (prop === 'playInstance') {
          return (...args) => {
            const handle = audioProxy.playInstance(...args);
            if (handle) audioPlaying.add(handle);
            return handle;
          };
        }
        if (prop === 'stopInstance') return (handle) => { audioPlaying.delete(handle); return audioProxy.stopInstance(handle); };
        if (prop === 'stopAll') return () => { audioPlaying.clear(); return audioProxy.stopAll(); };
        return audioProxy[prop];
      },
    });
    // Multiplayer transport. Its whole surface is JSON-safe (one exchange per
    // frame, packets as base64; web/mc-net.js), so it proxies like the rest.
    globalThis.mcWebNet = proxy('net');
    // Resource-pack IO threads enqueue bounded pulls; the client frame pump
    // alone calls this JSON-safe browser HTTP exchange.
    globalThis.mcWebPackHttp = proxy('packHttp');
  }
} else {
  // Node worker side (run-mcweb.sh): no browser exists, but the boot path can
  // still enumerate which seams Minecraft reaches. A recording stub stands in
  // for the host objects; unimplemented methods log once and return a neutral
  // value so one run catalogues every gap the boot path touches.
  if (!globalThis.mcWebGpu) {
    let nextHandle = 1;
    const handle = () => nextHandle++;
    const seen = {};
    globalThis.mcWebRuntimeMode = 'WASMGC_COOPERATIVE';
    globalThis.mcWebGpu = new Proxy({
      isReady: () => true,
      canvasWidth: () => 1280,
      canvasHeight: () => 720,
      adapterName: () => 'node stub host',
      reportProgress: (stage) => out('[MC-STAGE] ' + stage),
      reportSuccess: (argb, backend, path) => out('[MC-SUCCESS] ' + backend + ' ' + path),
      reportJavaFailure: (stage, type, message) => out('[MC-FAILURE] ' + stage + ': ' + type + ': ' + message),
      createTexture: () => handle(),
      createTextureView: () => handle(),
      createSamplerJson: () => handle(),
      createBuffer: () => handle(),
      createCommandEncoder: () => handle(),
      createPipeline: () => handle(),
      beginRenderPass: () => handle(),
      acquireCanvasTexture: () => handle(),
    }, {
      get(target, prop) {
        if (typeof prop !== 'string') return target[prop];
        if (prop in target) return target[prop];
        if (!seen[prop]) { seen[prop] = true; out('[node-host] mcWebGpu.' + prop + ' not implemented (noop)'); }
        return () => {};
      }
    });
    globalThis.mcWebPump = {
      register: () => out('[node-host] mcWebPump.register (frame loop not driven under node)'),
      configure: () => {},
      frameReported: () => {},
    };
    globalThis.mcWebInput = { register: () => {} };
    globalThis.mcWebAudio = new Proxy({}, {
      get: (t, prop) => (typeof prop === 'string' ? () => 0 : undefined)
    });
  }
}

// Runs without a canvas (Hello, JarLoad, BridgeProbe) keep this recording
// stand-in: enough of the seam surface to prove the generated bridge with no
// WebGPU device and no Minecraft involved. A canvas run replaces it in the
// worker before Java starts.
if (!globalThis.mcWebGpu) {
  globalThis.mcWebGpu = {
    isReady: () => true,
    canvasWidth: () => 1280,
    canvasHeight: () => 720,
    adapterName: () => 'stub-adapter (no device)',
    reportProgress: (stage) => { globalThis.__mcWebLastStage = stage; },
    _next: 41,
    createTexture(label, usage, format, w, h, depth, mips) {
      out('  [host] createTexture(' + JSON.stringify(label) + ', ' + usage + ', '
          + JSON.stringify(format) + ', ' + w + 'x' + h + 'x' + depth + ', mips=' + mips + ')');
      return ++this._next;
    },
    destroyTexture(handle) { out('  [host] destroyTexture(' + handle + ')'); },
  };
}
