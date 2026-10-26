"use strict";

// The portable JVM proxies filesystem calls to the page's MEMFS. Keep player
// files here; the runtime/payload caches have a separate lifetime and database.
globalThis.mcWebGameStorage = (() => {
  const DB_NAME = "mcweb-portable-player-data";
  const LOCK_NAME = "mcweb-portable-player-data-writer";
  const ROOT = "/tmp/mcgame";
  const FILES = "files";
  let db, fs, readyPromise, prepared, sessionLock;
  let writing = Promise.resolve();
  let management = Promise.resolve();
  let timer = null;
  let lastError = null;
  let lastSavedAt = null;
  let generation = 0;
  let observing = 0;
  let boundaryQueued = false;
  const dirty = new Map();

  function validPath(path) {
    return typeof path === "string" && path.length > 0 && path.length <= 2048
      && !/[\\\u0000-\u001f]/.test(path)
      && path.split("/").every(part => part && part !== "." && part !== "..")
      && (path.startsWith("saves/") || path.startsWith("resourcepacks/")
        || ["options.txt", "optionsof.txt", "servers.dat", "servers.dat_old", "hotbar.nbt"].includes(path))
      && !path.endsWith("/session.lock");
  }

  const requestValue = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not read browser player storage"));
  });
  const transactionDone = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("Could not commit browser player storage"));
  });

  function status() {
    return { available: Boolean(db), running: Boolean(sessionLock), attached: Boolean(fs),
      pending: dirty.size, lastError, lastSavedAt };
  }
  function publish() {
    if (typeof globalThis.CustomEvent === "function") {
      globalThis.dispatchEvent?.(new CustomEvent("mcweb-storage-status", { detail: status() }));
    }
  }
  function failed(error) {
    lastError = String(error?.message || error);
    console.error("[player-storage]", lastError);
    publish();
  }

  function ready() {
    return readyPromise ||= (async () => {
      if (!globalThis.indexedDB) throw new Error("Browser storage is unavailable. Allow site storage before playing.");
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(FILES, { keyPath: "path" });
      db = await requestValue(request);
      db.onversionchange = () => { db.close(); db = null; failed(new Error("Player storage changed in another tab. Reload before playing.")); };
      return true;
    })().catch(error => { failed(error); throw error; });
  }

  async function withWriter(action) {
    await ready();
    if (sessionLock) return action();
    if (!navigator.locks?.request) throw new Error("This browser cannot safely lock player storage. Update your browser before playing.");
    return navigator.locks.request(LOCK_NAME, { mode: "exclusive", ifAvailable: true }, lock => {
      if (!lock) throw new Error("Minecraft player storage is open in another tab. Close that game first.");
      return action();
    });
  }
  function managed(action) {
    const operation = management.then(() => withWriter(action));
    management = operation.catch(() => {});
    return operation;
  }

  async function rows() {
    await ready();
    const transaction = db.transaction(FILES, "readonly");
    const done = transactionDone(transaction);
    const result = await requestValue(transaction.objectStore(FILES).getAll());
    await done;
    return result.filter(row => validPath(row.path) && row.data instanceof Uint8Array);
  }

  async function list() {
    await flush();
    const transaction = db.transaction(FILES, "readonly");
    const done = transactionDone(transaction);
    const result = [];
    // A cursor releases each binary value before reading the next. Merely
    // opening Settings must not clone all region files into one JS array.
    await new Promise((resolve, reject) => {
      const request = transaction.objectStore(FILES).openCursor();
      request.onerror = () => reject(request.error || new Error("Could not list player files"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        const row = cursor.value;
        if (validPath(row.path) && row.data instanceof Uint8Array) result.push({ path: row.path, bytes: row.data.byteLength });
        cursor.continue();
      };
    });
    await done;
    return result;
  }
  async function read(path) {
    if (!validPath(path)) throw new Error("Invalid player file path");
    await flush();
    const transaction = db.transaction(FILES, "readonly");
    const done = transactionDone(transaction);
    const row = await requestValue(transaction.objectStore(FILES).get(path));
    await done;
    if (!row) throw new Error("Player file no longer exists: " + path);
    return row.data;
  }

  async function frameArguments(search = "") {
    await ready();
    const transaction = db.transaction(FILES, "readonly");
    const done = transactionDone(transaction);
    const row = await requestValue(transaction.objectStore(FILES).get("options.txt"));
    await done;
    const values = new Map();
    if (row?.data instanceof Uint8Array) {
      for (const line of new TextDecoder().decode(row.data).split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon > 0) values.set(line.slice(0, colon), line.slice(colon + 1));
      }
    }
    const query = new URLSearchParams(search), args = ["-Dmcweb.pageOwnedStorage=true"];
    // The portable Java bootstrap otherwise overwrites the restored video
    // options with uncapped defaults. Insert these after runtime policy flags;
    // explicit FPS queries must survive the mobile runtime filter too.
    if (!query.has("mcweb_vsync")) args.push("-Dmcweb.vsync=" + (values.get("enableVsync") !== "false"));
    const fps = Number(query.has("mcweb_max_fps") ? query.get("mcweb_max_fps") : values.get("maxFps"));
    if (Number.isInteger(fps) && fps >= 10 && fps <= 260)
      args.push("-Dmcweb.maxFps=" + fps);
    return args;
  }

  async function prepare() {
    await ready();
    await management;
    if (prepared) return;
    if (!navigator.locks?.request) throw new Error("This browser cannot safely lock player storage. Update your browser before playing.");
    let acquired, rejected;
    const result = new Promise((resolve, reject) => { acquired = resolve; rejected = reject; });
    // Hold this lock until the document closes, including JVM startup failures.
    // Releasing it while Java threads can still write would let a second game
    // overwrite the same world from a stale filesystem snapshot.
    void navigator.locks.request(LOCK_NAME, { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) throw new Error("Minecraft is already open in another tab. Close that game before playing here.");
      sessionLock = lock;
      try { prepared = await rows(); acquired(); publish(); }
      catch (error) { sessionLock = null; throw error; }
      await new Promise(() => {});
    }).catch(rejected);
    await result;
    void navigator.storage?.persist?.().catch(() => false);
  }

  function relative(path) {
    try {
      if (typeof path !== "string") path = fs.getPath(path);
      const absolute = path.startsWith("/") ? path : fs.cwd() + "/" + path;
      const normalized = [];
      for (const part of absolute.split("/")) {
        if (part === "..") normalized.pop();
        else if (part && part !== ".") normalized.push(part);
      }
      const full = "/" + normalized.join("/");
      const result = full.startsWith(ROOT + "/") ? full.slice(ROOT.length + 1) : "";
      return validPath(result) ? result : null;
    } catch { return null; }
  }
  function mark(path) {
    if (observing) return;
    const key = relative(path);
    if (!key) return;
    dirty.set(key, ++generation);
    if (!timer) timer = setTimeout(() => { timer = null; void flush().catch(failed); }, 1000);
  }
  function saveBoundary() {
    if (boundaryQueued) return;
    boundaryQueued = true;
    void Promise.resolve().then(flush).catch(failed).finally(() => { boundaryQueued = false; });
  }
  function walk(path) {
    try {
      const stat = fs.stat(path);
      if (fs.isDir(stat.mode)) {
        return fs.readdir(path).filter(name => name !== "." && name !== "..")
          .flatMap(name => walk(path + "/" + name));
      }
      return fs.isFile(stat.mode) ? [path] : [];
    } catch { return []; }
  }
  function attach(module) {
    if (!prepared || !sessionLock) throw new Error("Player storage must be prepared before starting Java");
    if (fs) throw new Error("Player storage is already attached to a JVM");
    fs = module.FS;
    fs.mkdirTree(ROOT);
    for (const row of prepared) {
      const path = ROOT + "/" + row.path;
      fs.mkdirTree(path.slice(0, path.lastIndexOf("/")));
      fs.writeFile(path, row.data, { canOwn: true });
      row.data = null;
    }
    prepared = [];
    // JVM pthread syscalls resolve these methods on the page. Observe the
    // underlying write seam, including files kept open (region files), rather
    // than relying on Java's old Graal snapshot bridge or a page-unload timer.
    for (const name of ["write", "close", "truncate", "unlink", "rmdir", "rename", ...(fs.doTruncate ? ["doTruncate"] : [])]) {
      const original = fs[name];
      if (typeof original !== "function") throw new Error("Runtime is missing filesystem method " + name);
      fs[name] = function (...args) {
        let path = null;
        try {
          path = (name === "write" || name === "close") ? fs.getPath(args[0].node)
            : name === "doTruncate" ? fs.getPath(args[1]) : args[0];
        } catch { /* sockets and JVM-internal descriptors need no player journal */ }
        const before = (name === "rename" || name === "rmdir") ? walk(path) : [];
        const result = original.apply(this, args);
        if (name !== "close" || args[0].flags === undefined || (args[0].flags & 3) !== 0) mark(path);
        before.forEach(mark);
        if (name === "rename") { mark(args[1]); walk(args[1]).forEach(mark); }
        const changed = relative(name === "rename" ? args[1] : path);
        if (!observing && changed && ((name === "close" && changed === "options.txt")
            || (name === "rename" && /^saves\/[^/]+\/level\.dat$/.test(changed)))) saveBoundary();
        return result;
      };
    }
    // The generated WASI fd_sync awaits a mount's syncfs callback, so Java's
    // FileDescriptor.sync now waits for IndexedDB instead of acknowledging a
    // MEMFS-only write. The portable runtime does not ship IDBFS.
    const mount = fs.lookupPath?.(ROOT)?.node?.mount;
    if (mount?.type && !mount.type.syncfs) {
      mount.type.syncfs = (_mount, populate, callback) => {
        if (populate) return callback(new Error("Player files restore before JVM startup"));
        void flush().then(() => callback(null), callback);
      };
    }
    globalThis.addEventListener?.("pagehide", () => { void flush().catch(failed); });
    globalThis.document?.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void flush().catch(failed);
    });
    publish();
    console.log("[player-storage] restored player files; automatic persistence enabled");
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const operation = writing.then(async () => {
      await ready();
      if (!fs || !dirty.size) return;
      const batch = [...dirty];
      const changes = batch.map(([path]) => {
        const full = ROOT + "/" + path;
        let stat;
        try {
          stat = fs.stat(full);
        } catch (error) {
          // A missing path is a deletion. An allocation or filesystem error
          // must never turn a still-existing world into a durable deletion.
          if (error?.errno !== 44 && error?.code !== "ENOENT" && error?.message !== "ENOENT") throw error;
        }
        if (stat && fs.isFile(stat.mode)) {
          observing++;
          try { return { path, data: fs.readFile(full) }; }
          finally { observing--; }
        }
        return { path, data: null };
      });
      const transaction = db.transaction(FILES, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(FILES);
      // Structured-cloning several region files in one task stalls the page
      // and the JVM's proxied filesystem. Keep one atomic transaction, but
      // enqueue the next file from the previous request's success task so the
      // browser can render between clones. The synchronous snapshot above
      // still captures all bytes and generations before other writers run.
      let next = 0, enqueueFailure = null;
      const enqueueNext = () => {
        if (next === changes.length) return;
        const row = changes[next++];
        try {
          const request = row.data === null ? store.delete(row.path) : store.put(row);
          request.onsuccess = enqueueNext;
        } catch (error) {
          enqueueFailure = error;
          // A synchronous clone/quota failure must not commit earlier files
          // from this save while reporting that the whole save failed.
          try { transaction.abort(); } catch { /* already ending */ }
        }
      };
      enqueueNext();
      await done.catch(error => { throw enqueueFailure || error; });
      if (enqueueFailure) throw enqueueFailure;
      for (const [path, version] of batch) if (dirty.get(path) === version) dirty.delete(path);
      lastError = null;
      lastSavedAt = Date.now();
      publish();
    });
    writing = operation.catch(error => { failed(error); });
    return operation;
  }

  async function importFiles(input) {
    if (!Array.isArray(input) || !input.length) throw new Error("No player files were selected");
    const names = new Set();
    const batch = input.map(row => {
      if (!validPath(row.path) || !(row.bytes instanceof Uint8Array) || names.has(row.path)) {
        throw new Error("Invalid or duplicate player file path");
      }
      if (sessionLock && !row.path.startsWith("resourcepacks/")) throw new Error("Close the game before importing worlds");
      names.add(row.path);
      return { path: row.path, data: row.bytes.slice() };
    });
    for (const path of names) {
      const parts = path.split("/");
      while (parts.length > 1) {
        parts.pop();
        if (names.has(parts.join("/"))) throw new Error("A player file cannot also be a folder");
      }
    }
    const root = path => /^(saves|resourcepacks)\//.test(path) ? path.split("/").slice(0, 2).join("/") : path;
    return managed(async () => {
      if (sessionLock && batch.some(row => !row.path.startsWith("resourcepacks/"))) throw new Error("Close the game before importing worlds");
      if (sessionLock && !fs) throw new Error("Wait until Minecraft finishes starting before importing resource packs");
      await flush();
      const existing = new Set((await list()).map(row => root(row.path)));
      if (batch.some(row => existing.has(root(row.path)))) throw new Error("A world or resource pack with this name already exists. Choose another name.");
      let staging = null, durable = false;
      const removeStaging = path => {
        if (fs.isDir(fs.stat(path).mode)) {
          for (const name of fs.readdir(path)) if (name !== "." && name !== "..") removeStaging(path + "/" + name);
          fs.rmdir(path);
        } else fs.unlink(path);
      };
      try {
        // Minecraft watches resourcepacks. Build a complete tree outside its
        // game directory, so a rescan cannot read pack.mcmeta before the last
        // texture has arrived. A ZIP follows the same atomic rename path.
        if (fs) {
          staging = "/tmp/mcweb-player-import-" + Date.now() + "-" + (++generation);
          fs.mkdirTree(staging);
          for (const row of batch) {
            const path = staging + "/" + row.path.slice("resourcepacks/".length);
            fs.mkdirTree(path.slice(0, path.lastIndexOf("/")));
            fs.writeFile(path, row.data);
          }
        }
        const transaction = db.transaction(FILES, "readwrite");
        const done = transactionDone(transaction);
        for (const row of batch) transaction.objectStore(FILES).add(row);
        await done;
        durable = true;
        if (fs) {
          fs.mkdirTree(ROOT + "/resourcepacks");
          observing++;
          try {
            for (const name of new Set(batch.map(row => row.path.split("/")[1]))) {
              fs.rename(staging + "/" + name, ROOT + "/resourcepacks/" + name);
            }
          } finally { observing--; }
        }
      } catch (error) {
        if (durable) throw new Error("Resource pack saved in browser storage; reload this page to activate it. " + (error?.message || error));
        throw error;
      } finally {
        if (staging) {
          try { removeStaging(staging); }
          catch (error) { console.warn?.("[player-storage] could not remove temporary pack staging", error); }
        }
      }
      publish();
    });
  }

  async function removeTree(prefix) {
    if (sessionLock) throw new Error("Close the game before deleting player files");
    if (!validPath(prefix + "/placeholder") && !validPath(prefix)) throw new Error("Invalid player folder");
    if (prefix === "saves" || prefix === "resourcepacks") throw new Error("Select one world or resource pack");
    return managed(async () => {
      if (sessionLock) throw new Error("Close the game before deleting player files");
      const selected = (await list()).filter(row => row.path === prefix || row.path.startsWith(prefix + "/"));
      const transaction = db.transaction(FILES, "readwrite");
      const done = transactionDone(transaction);
      for (const row of selected) transaction.objectStore(FILES).delete(row.path);
      await done;
      publish();
    });
  }

  async function exportTree(prefix, { maxBytes = 512 * 1024 * 1024, maxFiles = 65534 } = {}) {
    if (!validPath(prefix + "/placeholder") && !validPath(prefix)) throw new Error("Invalid player folder");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("Invalid export size limit");
    const byteLimit = Math.min(maxBytes, 512 * 1024 * 1024);
    const fileLimit = Math.min(maxFiles, 65534);
    if (sessionLock && prefix.startsWith("saves/")) throw new Error("Close the game before exporting worlds");
    return managed(async () => {
      if (sessionLock && prefix.startsWith("saves/")) throw new Error("Close the game before exporting worlds");
      await flush();
      const transaction = db.transaction(FILES, "readonly");
      const done = transactionDone(transaction);
      const result = [];
      let total = 0;
      await new Promise((resolve, reject) => {
        const range = globalThis.IDBKeyRange?.bound(prefix, prefix + "\uffff");
        const request = transaction.objectStore(FILES).openCursor(range);
        request.onerror = () => reject(request.error || new Error("Could not export player files"));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          const row = cursor.value;
          if (validPath(row.path) && row.data instanceof Uint8Array
              && (row.path === prefix || row.path.startsWith(prefix + "/"))) {
            total += row.data.byteLength;
            if (total > byteLimit) return reject(new Error("This export exceeds the browser size limit (at most 512 MiB)"));
            if (result.length >= fileLimit) return reject(new Error("This export contains too many files for a standard ZIP"));
            // IndexedDB already cloned the bytes. Retaining that owned value
            // avoids an extra world-sized copy while the ZIP is assembled.
            result.push({ path: row.path, bytes: row.data });
          }
          cursor.continue();
        };
      });
      await done;
      return result;
    });
  }

  return Object.freeze({ ready, prepare, attach, list, read, importFiles, removeTree, exportTree, flush, status, frameArguments });
})();
