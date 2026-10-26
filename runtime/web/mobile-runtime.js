// Mobile Safari profile for the source-built 26.3 JVM. No game bytes or relay.
globalThis.mcWebMobileRuntime = (() => {
  // Launch memory on the iPhone/iPad runtime. Without an applied bound Play
  // uses the fixed defaults. A bound comes only from a memory profile the
  // player chose to apply (memory-profile.js): memoryBudgetLimits takes the
  // profile's last fully filled amount and subtracts a fixed 32 MiB recovery
  // headroom; that is the bound. From the bound it keeps a reserve of
  // max(256 MiB, 20%) for memory outside WebAssembly, and the rest caps the
  // game's WebAssembly memory.
  //
  // What the cap enforces: WebAssembly.Memory's maximum. The browser refuses
  // to grow the game's linear memory past it, so the Java heap (-Xmx, which
  // sits inside it) and everything the JVM allocates natively (class
  // metadata, JIT tables, thread stacks, malloc, LWJGL buffers, which are
  // Java arrays here) stay under it: they fail with an out-of-memory error
  // instead. It is an allocation limit: pages count toward the tab's
  // resident footprint only once touched, and linear memory never shrinks.
  // What it does not enforce: everything outside linear memory (the
  // in-memory file system with the game files and worlds, JavaScript and
  // Worker heaps, compiled Wasm code, audio, and GPU memory in the browser's
  // separate GPU process). No control here bounds those; the reserve is a
  // policy assumption, not calibrated against them, so the tab as a whole can
  // exceed the bound.
  //
  // Split: the WebAssembly maximum is the bound less the reserve, rounded
  // down to 64 MiB, between the loader's fixed 512 MiB initial memory and its
  // compiled 4 GiB maximum (both checked against the pinned loader). The Java
  // heap keeps the defaults' 448:1152 share of it, rounded down to 32 MiB and
  // at most the 1536 MiB desktop Play uses; -Xms stays 96 MiB. 32 MiB is the
  // JVM's heap alignment on this runtime (its card table: 512-byte cards times
  // the 64 KiB WebAssembly page, cardTable.cpp ct_max_alignment_constraint),
  // and the JVM rounds -Xmx up to it (gcArguments.cpp): a -Xmx496m reserved
  // 512 MiB. A multiple of it is the heap the JVM actually reserves. A cap
  // below the defaults shrinks the game rather than using the larger
  // defaults; one below 512 MiB cannot hold the loader and is refused.
  const MiB = 1048576;
  const MOBILE_MEMORY_DEFAULTS = Object.freeze({ wasmMaxMiB: 1152, javaMaxMiB: 448, javaInitialMiB: 96 });
  const RECOVERY_HEADROOM_MIB = 32;
  const LOADER_INITIAL_MIB = 512;
  const LOADER_MAXIMUM_MIB = 4096;
  const JAVA_CEILING_MIB = 1536;
  const JAVA_HEAP_ALIGNMENT_MIB = 32;
  const MEMORY_POLICY = 'bound-profile-minus32.reserve-max256-20pct.wasm-floor64-min512-max4096.java-448of1152-floor32-max1536.v3';
  // Entries applied with the Java heap rounded down to 16 MiB only: the same
  // bound, reserve and WebAssembly cap, a -Xmx the JVM rounded up past it.
  const V2_MEMORY_POLICY = 'bound-profile-minus32.reserve-max256-20pct.wasm-floor64-min512-max4096.java-448of1152-floor16-max1536.v2';
  // Entries applied before the 32 MiB headroom (the same reserve taken from
  // the profile amount itself). appliedMemoryLimits re-derives both earlier
  // kinds under this policy, which never gives the same profile larger caps.
  const LEGACY_MEMORY_POLICY = 'reserve-max256-20pct.wasm-floor64-max4096.java-448of1152-floor16-max1536.v1';
  /** The Java heap share of a WebAssembly maximum (MiB), rounded down to granule MiB. */
  const javaShare = (wasmMaxMiB, granule) => Math.min(JAVA_CEILING_MIB,
    Math.floor(wasmMaxMiB * MOBILE_MEMORY_DEFAULTS.javaMaxMiB / MOBILE_MEMORY_DEFAULTS.wasmMaxMiB / granule) * granule);
  /** The caps for one WebAssembly maximum (MiB), or the defaults for null; throws on a maximum the loader cannot take. */
  function memoryLimits(wasmMaxMiB = null) {
    if (wasmMaxMiB === null) return { ...MOBILE_MEMORY_DEFAULTS, belowDefaults: false, policy: MEMORY_POLICY };
    if (!Number.isInteger(wasmMaxMiB) || wasmMaxMiB % 64 || wasmMaxMiB < LOADER_INITIAL_MIB || wasmMaxMiB > LOADER_MAXIMUM_MIB) {
      throw new Error('A WebAssembly maximum of ' + wasmMaxMiB + ' MiB is not a multiple of 64 MiB from '
        + LOADER_INITIAL_MIB + ' to ' + LOADER_MAXIMUM_MIB + ' MiB.');
    }
    const javaMaxMiB = javaShare(wasmMaxMiB, JAVA_HEAP_ALIGNMENT_MIB);
    return { wasmMaxMiB, javaMaxMiB, javaInitialMiB: MOBILE_MEMORY_DEFAULTS.javaInitialMiB,
      belowDefaults: wasmMaxMiB < MOBILE_MEMORY_DEFAULTS.wasmMaxMiB, policy: MEMORY_POLICY };
  }
  /** The launch bound, reserve and caps for a profile's last fully filled amount (MiB). */
  function memoryBudgetLimits(profileMiB) {
    if (!Number.isInteger(profileMiB) || profileMiB <= 0) return { ok: false, reason: 'The profile amount must be a whole number of MiB.' };
    const boundMiB = profileMiB - RECOVERY_HEADROOM_MIB;
    const reserveMiB = Math.max(256, Math.ceil(boundMiB * 0.2));
    const wasmMaxMiB = Math.min(LOADER_MAXIMUM_MIB, Math.floor((boundMiB - reserveMiB) / 64) * 64);
    if (wasmMaxMiB < LOADER_INITIAL_MIB) {
      return { ok: false, reason: 'A ' + profileMiB + ' MiB profile leaves a ' + Math.max(0, boundMiB) + ' MiB bound after the '
        + RECOVERY_HEADROOM_MIB + ' MiB recovery headroom and ' + Math.max(0, wasmMaxMiB) + ' MiB of WebAssembly memory after the '
        + reserveMiB + ' MiB reserve, less than the ' + LOADER_INITIAL_MIB
        + ' MiB the game\'s loader creates at startup, so the game cannot run inside it.' };
    }
    return { ok: true, limits: { profileMiB, headroomMiB: RECOVERY_HEADROOM_MIB, boundMiB, reserveMiB, ...memoryLimits(wasmMaxMiB) } };
  }
  /**
   * The caps a stored launch-memory entry stands for, re-derived from its
   * profile amount: { ok, limits, legacy } or { ok: false }. A current entry
   * must equal this policy's plan. A v2 entry must equal the plan v2 made for
   * its profile (the same bound, reserve and WebAssembly cap, the Java heap
   * rounded to 16 MiB); it is re-derived under this policy, which keeps those
   * and rounds the Java heap down to 32 MiB. A v1 entry is re-derived too.
   * Neither ever gets larger caps than it was applied with.
   */
  function appliedMemoryLimits(entry) {
    const plan = memoryBudgetLimits(entry?.basis?.stableMiB);
    const stored = entry?.limits;
    if (!plan.ok || !stored) return { ok: false };
    const same = (expected) => JSON.stringify(stored) === JSON.stringify(expected);
    if (stored.policy === MEMORY_POLICY) return same(plan.limits) ? { ok: true, limits: plan.limits, legacy: false } : { ok: false };
    if (stored.policy === V2_MEMORY_POLICY) {
      const v2 = { ...plan.limits, javaMaxMiB: javaShare(plan.limits.wasmMaxMiB, 16), policy: V2_MEMORY_POLICY };
      return same(v2) ? { ok: true, legacy: true, limits: { ...plan.limits, migratedFrom: V2_MEMORY_POLICY } } : { ok: false };
    }
    if (stored.policy !== LEGACY_MEMORY_POLICY || entry.budgetMiB !== plan.limits.profileMiB) return { ok: false };
    return { ok: true, legacy: true, limits: { ...plan.limits, migratedFrom: LEGACY_MEMORY_POLICY } };
  }
  function usesIOSRuntime() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function usesIPadRuntime() {
    if (/iPhone|iPod/.test(navigator.userAgent)) return false;
    return /iPad/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function usesDesktopWebKitRuntime() {
    return !usesIOSRuntime() && /AppleWebKit\//.test(navigator.userAgent)
      && !/(?:Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent);
  }
  // Runtime allocation/compilation capability, independent of touch UI or wake locks.
  function usesBoundedRuntime() {
    return usesIOSRuntime() || usesDesktopWebKitRuntime();
  }
  const CAPTURED_RENDER_JIT_ROOTS = [
    'net.minecraft', 'com.mojang.blaze3d', 'com.mojang.math', 'com.mojang.brigadier',
    'dev.mcweb', 'org.lwjgl', 'org.joml', 'it.unimi.dsi.fastutil', 'com.google', 'io.netty',
    'java.util', 'java.nio', 'sun.nio', 'jdk.internal', 'java.lang.String', 'java.lang.Math',
    'java.lang.Float', 'java.lang.Double', 'java.lang.Integer', 'java.lang.Long',
    'java.lang.Short', 'java.lang.Byte', 'java.lang.Boolean', 'java.lang.Character',
    'java.lang.Object', 'java.lang.System', 'java.lang.Thread', 'java.lang.Enum',
    'java.lang.Iterable', 'java.lang.Comparable', 'java.lang.ref', 'java.lang.runtime',
    'com.mojang.renderpearl', 'java.lang.invoke.DirectMethodHandle.internalMemberName',
  ].join(',');
  function mobileRuntimeSource(source, loaderURL, search = '', clientJar, wasmMaxMiB = null) {
    const limits = memoryLimits(wasmMaxMiB);
    if (typeof clientJar !== 'string' || !clientJar) throw new Error('Missing mobile client plan');
    const pool = 'var pthreadPoolSize = 32;';
    const script = 'var _scriptName = globalThis.document?.currentScript?.src;';
    const gpu = 'new Worker("gpu-rpc-worker.js" + location.search)';
    const mount = 'FS.writeFile("/app/mcweb/" + j.name, bytes);';
    const cache = 'var sharedModules = {};';
    // The loader's own memory sizes, which memoryLimits' range assumes.
    const initial = 'var INITIAL_MEMORY = ' + LOADER_INITIAL_MIB * MiB + ';';
    const memory = '"maximum": ' + LOADER_MAXIMUM_MIB * 16 + ',';
    for (const marker of [pool, script, gpu, mount, cache, initial, memory]) {
      if (source.split(marker).length !== 2) throw new Error('Unexpected pinned mobile runtime loader');
    }
    const workerURL = new URL(loaderURL);
    const requestedDistance = Number(new URLSearchParams(search).get('mcweb_render_distance'));
    const distance = Number.isInteger(requestedDistance) && requestedDistance >= 2 && requestedDistance <= 8
      ? requestedDistance : 8;
    const pin = workerURL.searchParams.get('release');
    workerURL.search = search;
    if (pin) workerURL.searchParams.set('release', pin);
    workerURL.searchParams.set('mcweb_render_distance', String(distance));
    workerURL.searchParams.set('mcweb_lazy_depth', '1');
    workerURL.searchParams.set('mcweb_lazy_pipeline', '1');
    workerURL.searchParams.set('mcweb_bindgroup_cache', 'pass');
    return source.replace(pool, 'var pthreadPoolSize = 2;')
      .replace(memory, '"maximum": ' + limits.wasmMaxMiB * 16 + ',')
      .replace(cache, 'var sharedModules = globalThis.__mcWebMobileModules || {};')
      .replace(mount, `FS.writeFile("/app/mcweb/" + j.name, j.name === ${JSON.stringify(clientJar)} ? await globalThis.__mcWebMobileClientJar(bytes) : bytes, { canOwn: true });`)
      .replace(script, 'var _scriptName = ' + JSON.stringify(workerURL.href) + ';')
      .replace(gpu, `new Worker((() => {
        const url = new URL('gpu-rpc-worker.js', location.href);
        url.search = location.search;
        if (${JSON.stringify(pin)}) url.searchParams.set('release', ${JSON.stringify(pin)});
        url.searchParams.set('mcweb_render_distance', ${JSON.stringify(String(distance))});
        url.searchParams.set('mcweb_lazy_depth', '1');
        url.searchParams.set('mcweb_lazy_pipeline', '1');
        url.searchParams.set('mcweb_bindgroup_cache', 'pass');
        return url.href;
      })())`);
  }
  function mobileRuntimeArguments(args, wasmMaxMiB = null, renderProfile = usesIPadRuntime()) {
    const jit = args.includes('-XX:+UseZeroWasmJIT');
    const limits = memoryLimits(wasmMaxMiB);
    return ['-Xmx' + limits.javaMaxMiB + 'm', '-Xms' + limits.javaInitialMiB + 'm', '-XX:MetaspaceSize=64m', '-XX:+UseSerialGC', '-Xrs',
      '-XX:NewRatio=15', '-XX:MinHeapFreeRatio=10', '-XX:MaxHeapFreeRatio=20',
      ...(jit ? ['-XX:+UnlockExperimentalVMOptions', '-XX:+UseZeroWasmJIT',
        '-XX:ZeroWasmJITOnly=' + (renderProfile ? CAPTURED_RENDER_JIT_ROOTS : 'net.minecraft'),
        ...(renderProfile ? ['-XX:+ZeroWasmJITNames', '-XX:ZeroWasmJITFramePad=2048', '-XX:ZeroWasmInterpreterFramePad=320'] : []),
        ...(renderProfile && args.includes('-XX:ZeroWasmJITDisable=524288') ? ['-XX:ZeroWasmJITDisable=524288'] : [])] : []),
      '-Dmcweb.maxFps=' + (renderProfile ? 120 : 20), '-Dmcweb.sectionPacks=2', '-Dmcweb.serverThreads=' + (renderProfile ? 2 : 0),
      '-Dmcweb.runtimeMode=WASMLM_THREADED',
      ...(renderProfile ? ['-Dmcweb.gpuOnlyShadowLimitMB=4', '-Dmcweb.serverInlineTrampoline=true'] : []),
      '-Dmcweb.simulationDistance=5', '-Dmcweb.lookAhead=0', ...args.filter(arg =>
        arg !== '-Xrs' && !/^-Xm[xs]/.test(arg) &&
        !(renderProfile && arg.startsWith('-XX:ZeroWasmInterpreterFramePad=')) &&
        !/^-XX:(?:MetaspaceSize=|ParallelGCThreads=|NewRatio=|MinHeapFreeRatio=|MaxHeapFreeRatio=|[+-]Use(?:Parallel|Serial)GC|[+-]?(?:UnlockExperimentalVMOptions|UseZeroWasmJIT|ZeroWasmJIT))/.test(arg) &&
        !/^-Dmcweb\.(?:serverThreads|sectionPacks|maxFps|simulationDistance|lookAhead|runtimeMode|gpuOnlyShadowLimitMB|serverInlineTrampoline)=/.test(arg))];
  }
  function mobileTerrainClass(bytes, massager, plan) {
    const result = new Uint8Array(bytes);
    const view = new DataView(result.buffer);
    const { pool } = massager.readConstantPool(result);
    const sizes = new Map(plan.constants);
    const found = new Map();
    for (const entry of pool) {
      if (entry?.tag !== 3) continue;
      const value = view.getInt32(entry.at + 1, false);
      if (!sizes.has(value)) continue;
      const count = (found.get(value) || 0) + 1;
      if (count > plan.expectEach) throw new Error('Unexpected duplicate terrain buffer size');
      found.set(value, count);
      view.setInt32(entry.at + 1, sizes.get(value), false);
    }
    if (found.size !== sizes.size || [...found.values()].some(count => count !== plan.expectEach))
      throw new Error('Unexpected pinned terrain buffer sizes');
    return result;
  }
  async function mobileClientJar(bytes, massager = globalThis.mcWebJarMassage, plan) {
    const entry = plan.terrain.entry;
    const original = await massager.readEntry(bytes, entry);
    if (!original) throw new Error('The pinned client is missing its terrain allocator');
    const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)),
      b => b.toString(16).padStart(2, '0')).join('');
    if (await digest(original) !== plan.terrain.sourceSha256) {
      throw new Error('The mobile terrain allocator failed its release checksum');
    }
    const patched = mobileTerrainClass(original, massager, plan.terrain);
    if (await digest(patched) !== plan.terrain.derivedSha256) {
      throw new Error('The mobile terrain allocator failed its derived checksum');
    }
    const manifest = await massager.readEntry(bytes, plan.manifest.entry);
    if (!manifest || manifest.length !== plan.manifest.sourceBytes ||
        await digest(manifest) !== plan.manifest.sourceSha256) {
      throw new Error('The mobile client manifest failed its release checksum');
    }
    // The derived JAR is already unsigned. Its remaining sections contain only
    // signature digests; retain the pinned main attributes, including Main-Class.
    const unsignedManifest = manifest.slice(0, plan.manifest.prefixBytes);
    if (await digest(unsignedManifest) !== plan.manifest.derivedSha256) {
      throw new Error('The mobile client manifest failed its derived checksum');
    }
    return massager.massageJar(bytes, undefined, new Map([
      [entry, patched], [plan.manifest.entry, unsignedManifest],
    ])).bytes;
  }
  async function mobileRuntimeModules(loaderURL, records, fetchModule = fetch, compile = WebAssembly.compile) {
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

  function runtimeArguments(args, wasmMaxMiB = null) {
    if (!usesBoundedRuntime()) return args;
    // A saved iPhone/iPad memory budget never changes desktop Safari's defaults.
    return mobileRuntimeArguments(args, usesIOSRuntime() ? wasmMaxMiB : null,
      usesIPadRuntime() || usesDesktopWebKitRuntime());
  }
  let mobileRuntimeReady;
  let mobileRuntimeWasmMax;
  let mobileRuntimeEvaluationStarted = false;
  // wasmMaxMiB must be the one runtimeArguments got: the loader's WebAssembly
  // maximum and the -Xmx come from the same memoryLimits(wasmMaxMiB). The
  // loader is evaluated once per page, so a second call with another maximum
  // is refused.
  async function prepareMobileRuntime(config, write = () => {}, wasmMaxMiB = null) {
    if (!usesBoundedRuntime()) return;
    if (!usesIOSRuntime()) wasmMaxMiB = null;
    if (mobileRuntimeReady && mobileRuntimeWasmMax !== wasmMaxMiB) {
      const failure = new Error('The launch memory changed after the runtime was prepared. Reload this page before trying Play again.');
      failure.code = 'MCWEB_RUNTIME_RELOAD_REQUIRED';
      throw failure;
    }
    const limits = memoryLimits(wasmMaxMiB);
    mobileRuntimeWasmMax = wasmMaxMiB;
    return mobileRuntimeReady ||= (async () => {
      const url = new URL('javavm.js', location.href);
      if (config.cacheKey) url.searchParams.set('release', config.cacheKey);
      const response = await fetch(url.href);
      if (!response.ok) throw new Error('Could not load the iPhone runtime loader: HTTP ' + response.status);
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== config.loader.bytes || hash !== config.loader.sha256)
        throw new Error('The iPhone runtime loader failed its release checksum');
      globalThis.__mcWebMobileModules = await mobileRuntimeModules(url.href, config.libraries);
      globalThis.__mcWebMobileClientJar = async bytes => {
        const derived = await mobileClientJar(bytes, globalThis.mcWebJarMassage, config.mobileJarPlan);
        write('[mobile] verified terrain buffers: 16 MB vertex, 4 MB index, 8 MB staging');
        return derived;
      };
      const source = mobileRuntimeSource(new TextDecoder().decode(bytes), url.href, location.search, config.mobileJarPlan.clientJar, wasmMaxMiB);
      write('[memory] WebAssembly maximum ' + limits.wasmMaxMiB + ' MiB (enforced cap on the game\'s linear memory), Java -Xmx'
        + limits.javaMaxMiB + 'm -Xms' + limits.javaInitialMiB + 'm (' + (wasmMaxMiB === null ? 'defaults' : 'applied launch bound') + ')');
      mobileRuntimeEvaluationStarted = true;
      (0, eval)(source);
    })().catch(cause => {
      if (!mobileRuntimeEvaluationStarted) {
        mobileRuntimeReady = undefined;
        mobileRuntimeWasmMax = undefined;
        throw cause;
      }
      const failure = new Error('Runtime initialization failed. Reload this page before trying Play again.', { cause });
      failure.code = 'MCWEB_RUNTIME_RELOAD_REQUIRED';
      throw failure;
    });
  }
  let runtimeSupport;
  function unsupported(message) {
    const failure = new Error(message);
    failure.code = 'MCWEB_RUNTIME_UNSUPPORTED';
    return failure;
  }
  function requireRuntimeSupport() {
    return runtimeSupport ||= (async () => {
      if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
        throw unsupported('This browser cannot run the threaded game. Open the game directly in a supported browser.');
      }
      if (!navigator.gpu) throw unsupported('WebGPU is unavailable. This game needs a WebGPU-capable browser and device. The iOS Simulator cannot play it.');
      let timer;
      const adapter = navigator.gpu && await Promise.race([
        navigator.gpu.requestAdapter().catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
      ]).finally(() => clearTimeout(timer));
      if (!adapter) {
        throw new Error('WebGPU is unavailable. This game needs a WebGPU-capable browser and device. The iOS Simulator cannot play it.');
      }
      if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function') {
        throw unsupported('Offscreen canvas is unavailable. Update to a supported browser to play.');
      }
      try {
        await navigator.storage.getDirectory();
      } catch (cause) {
        throw new Error('Browser storage is unavailable. Allow site storage and use a regular browsing window. Safari Private Browsing cannot install this game.', { cause });
      }
    })().catch(failure => {
      runtimeSupport = undefined;
      throw failure;
    });
  }

  function createScreenWakeLock(write = () => {}) {
    let mobileWakeActive = false;
    let mobileWakePending = null;
    let mobileWakeSentinel = null;
    let mobileWakeSuspended = false;
    function releaseMobileScreenWakeLock() {
      mobileWakePending = null;
      const sentinel = mobileWakeSentinel;
      mobileWakeSentinel = null;
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
    }
    async function acquireMobileScreenWakeLock() {
      if (!mobileWakeActive || mobileWakeSuspended || mobileWakePending ||
          document.visibilityState !== 'visible' ||
          (mobileWakeSentinel && !mobileWakeSentinel.released) || !navigator.wakeLock) return;
      const request = {};
      mobileWakePending = request;
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (mobileWakePending !== request || !mobileWakeActive || mobileWakeSuspended ||
            document.visibilityState !== 'visible') {
          await sentinel.release();
          return;
        }
        mobileWakeSentinel = sentinel;
        sentinel.addEventListener('release', () => {
          if (mobileWakeSentinel === sentinel) mobileWakeSentinel = null;
        });
        write('[awake] screen wake lock active while playing');
      } catch (error) {
        if (mobileWakePending === request) write('[awake] screen wake lock unavailable: ' + error.name);
      } finally {
        if (mobileWakePending === request) mobileWakePending = null;
      }
    }
    function stopMobileScreenWakeLock() {
      mobileWakeActive = false;
      mobileWakeSuspended = false;
      releaseMobileScreenWakeLock();
    }
    function startMobileScreenWakeLock() {
      mobileWakeActive = usesIOSRuntime();
      mobileWakeSuspended = false;
      void acquireMobileScreenWakeLock();
    }
    const state = () => ({active:mobileWakeActive,pending:!!mobileWakePending,
      supported:!!navigator.wakeLock,held:!!mobileWakeSentinel && !mobileWakeSentinel.released,
      suspended:mobileWakeSuspended,visibility:document.visibilityState});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void acquireMobileScreenWakeLock();
      else releaseMobileScreenWakeLock();
    });
    document.addEventListener('pointerdown', () => {
      if (mobileWakeActive && !mobileWakeSentinel) void acquireMobileScreenWakeLock();
    });
    addEventListener('pagehide', event => {
      if (event.persisted) {
        mobileWakeSuspended = true;
        releaseMobileScreenWakeLock();
      } else stopMobileScreenWakeLock();
    });
    addEventListener('pageshow', () => {
      mobileWakeSuspended = false;
      void acquireMobileScreenWakeLock();
    });


    return { start: startMobileScreenWakeLock, stop: stopMobileScreenWakeLock, state };
  }
  return { usesIOSRuntime, usesBoundedRuntime, runtimeArguments, mobileRuntimeArguments, mobileRuntimeSource,
    mobileTerrainClass, mobileClientJar, mobileRuntimeModules, prepareMobileRuntime,
    requireRuntimeSupport, createScreenWakeLock, memoryBudgetLimits, memoryLimits, appliedMemoryLimits };
})();
