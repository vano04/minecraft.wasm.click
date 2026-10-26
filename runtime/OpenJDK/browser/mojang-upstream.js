// Where the browser gets Mojang's files from, when Mojang's CDN will not hand
// them to a web page.
//
// A published bundle serves no Mojang-owned bytes (tools/wasmjvm-provenance.mjs
// enforces it). The payload manifest names each Mojang file by URL, size and
// SHA-1 instead, and Install (installPayload, below) fetches and verifies it.
// That works for the client jar, because piston-data.mojang.com sends CORS
// headers. It does not work for libraries.minecraft.net or
// resources.download.minecraft.net, which send none: a page's fetch of them
// fails before any byte arrives, and no credential or header a page can set
// changes that.
//
// Mojang is the only source, and nothing comes from the player's device. For
// those two hosts this file asks, in order:
//
//   1. Mojang's dedicated-server jar, which piston-data.mojang.com serves with
//      CORS and which bundles most of Mojang's libraries (META-INF/libraries):
//      the entry alone is read with range requests, ~1 MB instead of 60;
//   2. Mojang directly, in case the host has started sending CORS headers.
//
// Nothing here is trusted for integrity. Every candidate is checked against
// Mojang's SHA-1 and size before it is accepted; and pre.js checks the cached
// result again, against the manifest's SHA-256, before mounting.
//
// Kept out of pre.js on purpose. pre.js is inlined into javavm.js at link
// time; this file is loaded by the page, so sources can change without a
// relink. pre.js calls the global fetch at call time, so the page installs
// this as a scoped wrapper that only answers Mojang upstream URLs.

(function () {
  const NO_CORS_HOSTS = new Set(["libraries.minecraft.net", "resources.download.minecraft.net"]);
  const PAYLOAD_CACHE_DIR = "mcweb-payload";

  const hex = (buffer) => Array.from(new Uint8Array(buffer),
    (b) => b.toString(16).padStart(2, "0")).join("");
  const sha1 = async (bytes) => hex(await crypto.subtle.digest("SHA-1", bytes));
  const hostOf = (url) => { try { return new URL(url).host; } catch { return ""; } };
  const urlOf = (input) => typeof input === "string" ? input
    : input instanceof URL ? input.href
    : (input && typeof input.url === "string") ? input.url : "";

  // ----------------------------------------------------------------- resolver

  function createResolver(options = {}) {
    const baseFetch = options.fetch || globalThis.fetch.bind(globalThis);
    const log = options.log || (() => {});
    const corsBlocked = new Set();    // hosts whose direct fetch already failed

    const accept = async (bytes, entry, from) => {
      if (!entry) return bytes;
      if (bytes.byteLength !== entry.sourceBytes) {
        log(`[upstream] ${entry.name}: ${from} has ${bytes.byteLength} bytes, `
          + `Mojang publishes ${entry.sourceBytes}; trying the next source`);
        return null;
      }
      const digest = await sha1(bytes);
      if (digest !== entry.sourceSha1) {
        log(`[upstream] ${entry.name}: ${from} SHA-1 ${digest} is not Mojang's `
          + `${entry.sourceSha1}; trying the next source`);
        return null;
      }
      return bytes;
    };

    const fromNetwork = async (target, url, entry, label) => {
      try {
        const response = await baseFetch(target, { cache: "no-store" });
        if (!response.ok) {
          log(`[upstream] ${entry?.name || url}: ${label} HTTP ${response.status}`);
          return null;
        }
        const bytes = await accept(new Uint8Array(await response.arrayBuffer()), entry, label);
        return bytes ? { bytes, source: label } : null;
      } catch (failure) {
        // A CORS refusal surfaces as a TypeError with no status. Remember it,
        // so forty libraries do not each pay for the same refusal.
        if (label === "Mojang") corsBlocked.add(hostOf(url));
        return null;
      }
    };

    // ---- Mojang's server jar, read by range: its central directory from the
    // tail, then one entry. A server that ignores Range sends the whole file;
    // that copy is then kept and every later entry comes from it.
    const serverJars = new Map();    // url -> Promise<{ entries, whole }>
    const rangeOf = async (jar, url, from, to) => {
      if (jar && jar.whole) return jar.whole.subarray(from, to + 1);
      const response = await baseFetch(url, { headers: { Range: `bytes=${from}-${to}` }, cache: "no-store" });
      if (response.status === 206) return new Uint8Array(await response.arrayBuffer());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const whole = new Uint8Array(await response.arrayBuffer());
      if (jar) jar.whole = whole;
      return whole.subarray(from, to + 1);
    };
    const serverJar = (bundled) => {
      if (!serverJars.has(bundled.url)) {
        serverJars.set(bundled.url, (async () => {
          const jar = { entries: new Map(), whole: null };
          const size = bundled.bytes;
          const tailFrom = Math.max(0, size - 65557);
          let tail = await rangeOf(jar, bundled.url, tailFrom, size - 1);
          if (jar.whole === null && tail.length === size) jar.whole = tail;
          let tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
          let eocd = -1;
          for (let i = tail.length - 22; i >= 0; i--) {
            if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
          }
          if (eocd < 0) throw new Error("no end of central directory");
          const cdSize = tv.getUint32(eocd + 12, true);
          const cdOffset = tv.getUint32(eocd + 16, true);
          const cd = cdOffset >= tailFrom
            ? tail.subarray(cdOffset - tailFrom, cdOffset - tailFrom + cdSize)
            : await rangeOf(jar, bundled.url, cdOffset, cdOffset + cdSize - 1);
          const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
          const decoder = new TextDecoder();
          for (let at = 0; at + 46 <= cd.length && view.getUint32(at, true) === 0x02014b50;) {
            const nameLength = view.getUint16(at + 28, true);
            const extraLength = view.getUint16(at + 30, true);
            const commentLength = view.getUint16(at + 32, true);
            jar.entries.set(decoder.decode(cd.subarray(at + 46, at + 46 + nameLength)), {
              method: view.getUint16(at + 10, true),
              compressedSize: view.getUint32(at + 20, true),
              localOffset: view.getUint32(at + 42, true),
              nameLength,
            });
            at += 46 + nameLength + extraLength + commentLength;
          }
          return jar;
        })().catch((failure) => { serverJars.delete(bundled.url); throw failure; }));
      }
      return serverJars.get(bundled.url);
    };
    const fromServerJar = async (url, entry) => {
      const bundled = entry && entry.bundled;
      if (!bundled) return null;
      try {
        const jar = await serverJar(bundled);
        const found = jar.entries.get(bundled.path);
        if (!found) {
          log(`[upstream] ${entry.name}: not in Mojang's server jar (${bundled.path})`);
          return null;
        }
        // The local header's extra field may differ from the central one:
        // read a little slack with the data and find the data by the header.
        const from = found.localOffset;
        const chunk = await rangeOf(jar, bundled.url, from,
          Math.min(bundled.bytes - 1, from + 30 + found.nameLength + 1024 + found.compressedSize));
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (view.getUint32(0, true) !== 0x04034b50) throw new Error("bad local header");
        const dataAt = 30 + view.getUint16(26, true) + view.getUint16(28, true);
        const raw = chunk.subarray(dataAt, dataAt + found.compressedSize);
        let bytes = raw;
        if (found.method === 8) {
          const stream = new Response(raw).body.pipeThrough(new DecompressionStream("deflate-raw"));
          bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        } else if (found.method !== 0) {
          throw new Error(`compression method ${found.method}`);
        }
        const accepted = await accept(bytes, entry, "Mojang's server jar");
        return accepted ? { bytes: accepted, source: "Mojang's server jar" } : null;
      } catch (failure) {
        log(`[upstream] ${entry.name}: Mojang's server jar: ${failure && failure.message || failure}`);
        return null;
      }
    };

    const fromMojang = (url, entry) => corsBlocked.has(hostOf(url))
      ? null : fromNetwork(url, url, entry, "Mojang");

    /**
     * Resolves one upstream URL to verified bytes, or null if no source has
     * it. Without its manifest entry only Mojang itself can be asked: the
     * entry names the server-jar path and the SHA-1 to check.
     */
    async function resolve(url, entry) {
      const order = NO_CORS_HOSTS.has(hostOf(url)) ? [fromServerJar, fromMojang] : [fromMojang];
      for (const source of order) {
        const found = await source(url, entry);
        if (found) return found;
      }
      return null;
    }

    // ---- assets (sounds): Mojang's asset index names each file by SHA-1 and
    // is served with CORS (piston-meta); Mojang serves the files themselves
    // only from resources.download.minecraft.net, which a page cannot read.
    // Only Mojang is a source: each file comes from this browser's cache
    // (OPFS, filled from Mojang earlier), Mojang directly, or a pass-through
    // to Mojang on the page's own origin if one answers (the bundle's
    // serve.mjs, for local development only; a deployed page has none), and
    // is checked against its hash. audio-host.js plays a
    // sound file it could not read straight from Mojang with an <audio>
    // element; sounds.json, the event table, has to be read. Answered here as
    // the same-origin /mcweb-audio/<name> requests audio-host.js makes;
    // without any source the game is silent, not broken.
    const ASSET_PREFIX = "/mcweb-audio/";
    const ASSET_CACHE_DIR = "mcweb-assets";
    let assetIndex = options.assetIndex || null;   // { id, url, sha1 }
    let assetObjects = null;
    const assetPath = (input) => {
      const url = urlOf(input);
      try {
        const parsed = new URL(url, globalThis.location && location.href);
        if (globalThis.location && parsed.origin !== location.origin) return null;
        if (!parsed.pathname.startsWith(ASSET_PREFIX)) return null;
        const name = decodeURIComponent(parsed.pathname.slice(ASSET_PREFIX.length));
        return name.split("/").some((p) => p === ".." || p === ".") ? null : name;
      } catch { return null; }
    };
    const opfsDir = async () => {
      try {
        return await (await navigator.storage.getDirectory())
          .getDirectoryHandle(ASSET_CACHE_DIR, { create: true });
      } catch { return null; }
    };
    const opfsRead = async (name) => {
      try {
        const file = await (await (await opfsDir()).getFileHandle(name)).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch { return null; }
    };
    const opfsWrite = async (name, bytes) => {
      try {
        const writable = await (await (await opfsDir()).getFileHandle(name, { create: true })).createWritable();
        await writable.write(bytes);
        await writable.close();
      } catch { /* a cache, nothing more */ }
    };
    const loadAssetObjects = () => {
      if (!assetObjects) {
        assetObjects = (async () => {
          if (!assetIndex) return null;
          const cacheName = `index-${assetIndex.sha1}.json`;
          let bytes = await opfsRead(cacheName);
          if (!bytes || await sha1(bytes) !== assetIndex.sha1) {
            bytes = null;
            try {
              const response = await baseFetch(assetIndex.url, { cache: "no-store" });
              if (response.ok) bytes = new Uint8Array(await response.arrayBuffer());
            } catch { /* reported below */ }
            if (!bytes || await sha1(bytes) !== assetIndex.sha1) {
              log(`[assets] Mojang's asset index ${assetIndex.id} is unavailable: no sounds`);
              return null;
            }
            opfsWrite(cacheName, bytes);
          }
          return JSON.parse(new TextDecoder().decode(bytes)).objects || null;
        })();
      }
      return assetObjects;
    };
    const assetBytes = async (name, input) => {
      const objects = await loadAssetObjects();
      const object = objects && objects[name];
      if (!object) return null;
      const hash = object.hash, rel = hash.slice(0, 2) + "/" + hash;
      const ok = async (bytes) => !!bytes && bytes.byteLength === object.size && await sha1(bytes) === hash;
      let bytes = await opfsRead(hash);
      if (await ok(bytes)) return bytes;
      const candidates = [];
      // Mojang itself first: its asset host sends no CORS headers today, so
      // this fails at once (remembered, one refusal per session); the day it
      // does, the pass-through below becomes unnecessary.
      const mojangHost = "resources.download.minecraft.net";
      if (!corsBlocked.has(mojangHost)) {
        candidates.push(async () => {
          try {
            const response = await baseFetch(`https://${mojangHost}/${rel}`, { cache: "no-store" });
            return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
          } catch (refused) {
            corsBlocked.add(mojangHost);
            return null;
          }
        });
      }
      candidates.push(async () => {   // the bundle's serve.mjs (local development)
        const response = await baseFetch(input, { cache: "no-store" });
        return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
      });
      for (const candidate of candidates) {
        try { bytes = await candidate(); } catch { bytes = null; }
        if (await ok(bytes)) {
          opfsWrite(hash, bytes);
          return bytes;
        }
      }
      return null;
    };

    return {
      /**
       * Mojang's own URL for an asset ("minecraft/sounds/ambient/cave/cave1.ogg"),
       * or null. A page cannot read it (no CORS), but an <audio> element can
       * play it when the page's embedder policy is credentialless.
       */
      async assetDirectUrl(name) {
        const objects = await loadAssetObjects();
        const object = objects && objects[name];
        return object
          ? `https://resources.download.minecraft.net/${object.hash.slice(0, 2)}/${object.hash}`
          : null;
      },
      get assetIndex() { return assetIndex; },
      set assetIndex(value) { assetIndex = value || null; assetObjects = null; },
      resolve,

      /** True for the requests this resolver answers instead of the network. */
      handles(input) {
        return NO_CORS_HOSTS.has(hostOf(urlOf(input)))
          || (!!assetIndex && assetPath(input) !== null);
      },

      /** fetch()-shaped: what the page installs in front of pre.js. */
      async fetch(input) {
        const url = urlOf(input);
        const asset = assetIndex ? assetPath(input) : null;
        if (asset !== null) {
          const found = await assetBytes(asset, input);
          return found
            ? new Response(found, { status: 200, headers: {
                "Content-Type": asset.endsWith(".json") ? "application/json" : "audio/ogg" } })
            : new Response("no source for this asset\n", { status: 404 });
        }
        const found = await resolve(url);
        if (!found) throw new TypeError(`no source a web page can read for ${url}`);
        return new Response(found.bytes, {
          status: 200,
          headers: { "Content-Type": "application/java-archive" },
        });
      },
    };
  }

  // ------------------------------------------------------------------ install
  //
  // The "Install" step: everything the game needs, fetched and verified now
  // and cached in OPFS under the names pre.js reads ("<sha256>-<name>"), so
  // "Play" starts from this browser's own copy. Mojang's files come from
  // Mojang only (the client jar from piston-data, Mojang's libraries out of
  // Mojang's server jar there) and the jar is patched here, in the tab. pre.js
  // re-checks every cached file (size and SHA-256) before the JVM sees it.

  const sha256hex = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));
  const payloadStore = async () =>
    (await navigator.storage.getDirectory()).getDirectoryHandle(PAYLOAD_CACHE_DIR, { create: true });
  const cachedValid = async (store, entry) => {
    try {
      const file = await (await store.getFileHandle(entry.sha256 + "-" + entry.name)).getFile();
      if (file.size !== entry.bytes) return false;
      return await sha256hex(new Uint8Array(await file.arrayBuffer())) === entry.sha256;
    } catch { return false; }
  };

  /** Which manifest jars this browser has not cached yet (verified copies only). */
  async function missingPayload(manifest) {
    const store = await payloadStore();
    const missing = [];
    for (const entry of manifest.jars || []) if (!await cachedValid(store, entry)) missing.push(entry);
    return missing;
  }

  /**
   * Fetches, verifies, patches and caches every jar the manifest names.
   * options: { base: the bundle's payload URL, resolver, onProgress(state) }.
   * Throws (and caches nothing unverified) if any file fails its checks.
   */
  async function installPayload(manifest, options = {}) {
    const resolver = options.resolver || installed || createResolver();
    const progress = options.onProgress || (() => {});
    const base = String(options.base || "./payload").replace(/\/$/, "");
    const store = await payloadStore();
    const jars = manifest.jars || [];
    const total = jars.reduce((sum, j) => sum + (j.sourceBytes || j.bytes), 0);
    let done = 0;
    for (const [index, entry] of jars.entries()) {
      const size = entry.sourceBytes || entry.bytes;
      progress({ index, count: jars.length, name: entry.name, done, total, phase: "checking" });
      if (await cachedValid(store, entry)) { done += size; continue; }
      let bytes;
      if (entry.url) {
        progress({ index, count: jars.length, name: entry.name, done, total,
          phase: "downloading from " + hostOf(entry.url) });
        let source;
        if (NO_CORS_HOSTS.has(hostOf(entry.url))) {
          const found = await resolver.resolve(entry.url, entry);
          if (!found) throw new Error(`${entry.name}: no Mojang source a web page can read`);
          source = found.bytes;
        } else {
          const response = await fetch(entry.url, { cache: "no-store" });
          if (!response.ok) throw new Error(`${entry.name}: HTTP ${response.status}`);
          source = new Uint8Array(await response.arrayBuffer());
        }
        if (source.byteLength !== entry.sourceBytes || await sha1(source) !== entry.sourceSha1) {
          throw new Error(`${entry.name}: not the file Mojang publishes (size or SHA-1)`);
        }
        if (entry.massagePlan) {
          progress({ index, count: jars.length, name: entry.name, done, total, phase: "patching" });
          const massager = globalThis.mcWebJarMassage;
          if (!massager) throw new Error("jar-massage.js is not loaded");
          const result = await massager.prepareClientJar(source, entry.massagePlan);
          if (result.missing && result.missing.length) {
            throw new Error(`${entry.name}: the patch plan names entries it lacks: ${result.missing.join(", ")}`);
          }
          bytes = result.bytes;
        } else {
          bytes = source;
        }
      } else {
        progress({ index, count: jars.length, name: entry.name, done, total, phase: "downloading" });
        const response = await fetch(base + "/jar/" + encodeURIComponent(entry.name), { cache: "no-store" });
        if (!response.ok) throw new Error(`${entry.name}: HTTP ${response.status}`);
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      if (bytes.byteLength !== entry.bytes || await sha256hex(bytes) !== entry.sha256) {
        throw new Error(`${entry.name}: failed its SHA-256 check`);
      }
      const writable = await (await store.getFileHandle(entry.sha256 + "-" + entry.name, { create: true }))
        .createWritable();
      await writable.write(bytes);
      await writable.close();
      done += size;
    }
    progress({ index: jars.length, count: jars.length, done: total, total, phase: "installed" });
  }

  let installed = null;
  /**
   * Installs one resolver in front of the page's fetch. Only URLs it handles
   * are diverted; every other request goes to the original fetch unchanged.
   */
  function install(options = {}) {
    if (installed) {
      if ("assetIndex" in options) installed.assetIndex = options.assetIndex;
      return installed;
    }
    const original = globalThis.fetch.bind(globalThis);
    const resolver = createResolver({ ...options, fetch: options.fetch || original });
    globalThis.fetch = (input, init) =>
      resolver.handles(input) ? resolver.fetch(input) : original(input, init);
    installed = resolver;
    return resolver;
  }

  const api = {
    createResolver, install, NO_CORS_HOSTS,
    get installed() { return installed; },
    installPayload, missingPayload,
  };
  if (typeof globalThis !== "undefined") globalThis.mcWebUpstream = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
