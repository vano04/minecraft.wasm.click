// HTTP boundary for vanilla HttpUtil resource-pack downloads. The Java client
// pump exchanges JSON; async fetch
// stays on the GPU worker, and IO pthreads never need a JS event loop.
export function createBrowserPackHttp({
  fetchImpl = globalThis.fetch.bind(globalThis),
  chunkBytes = 64 * 1024,
  maxRequests = 8,
  origin = globalThis.location?.origin,
} = {}) {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 64 * 1024
      || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 8)
    throw new Error("invalid server-pack HTTP bounds");
  const requests = new Map();
  const errorText = (error) => String(error?.message || error).slice(0, 1000);
  const current = (request) => requests.get(request.id) === request && !request.cancelled;
  const cancelBody = (response) => {
    try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
  };
  const releaseReader = (request, cancel) => {
    if (!request.reader) return;
    const reader = request.reader;
    request.reader = null;
    if (cancel) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} }
    else { try { reader.releaseLock(); } catch {} }
  };
  const cancel = (request) => {
    if (!request || request.cancelled) return;
    request.cancelled = true;
    try { request.controller.abort(); } catch {}
    releaseReader(request, true);
    request.data = null;
    requests.delete(request.id);
  };
  const fail = (request, error) => {
    if (!current(request)) return;
    request.error = errorText(error);
    request.state = "error";
    try { request.controller.abort(); } catch {}
    releaseReader(request, true);
    request.data = null;
  };
  const encode = (bytes) => {
    let text = "";
    // Avoid spreading a potentially large native chunk on the JS stack.
    for (let at = 0; at < bytes.length; at += 8192)
      text += String.fromCharCode(...bytes.subarray(at, at + 8192));
    return btoa(text);
  };
  const pull = async (request) => {
    if (!current(request) || !request.reader || !request.credit || request.reading || request.data !== null) return;
    request.reading = true;
    try {
      let emptyReads = 0;
      while (true) {
        // Fetch's byte-stream BYOB reader bounds the allocation independently
        // of network/native chunk sizes. A producer's large chunk is split by
        // the Streams API, not rejected as an invalid HTTP response.
        const part = await request.reader.read(new Uint8Array(chunkBytes));
        if (!current(request)) return;
        if (part.done) {
          request.state = "eof";
          request.credit = false;
          releaseReader(request, false);
        }
        if (part.done && !part.value?.byteLength) return;
        if (!(part.value instanceof Uint8Array) || part.value.byteLength > chunkBytes)
          throw new Error("server-pack fetch violated bounded byte-stream read");
        if (!part.value.byteLength) {
          if (++emptyReads >= 16) throw new Error("server-pack fetch repeatedly supplied empty chunks");
          continue;
        }
        request.data = encode(part.value);
        request.credit = false;
        return;
      }
    } catch (error) {
      fail(request, error);
    } finally {
      request.reading = false;
    }
  };
  const open = (op) => {
    const request = { id: op.id, state: "opening", controller: new AbortController(),
      cancelled: false, reader: null, data: null,
      credit: false, reading: false };
    requests.set(op.id, request);
    if (requests.size > maxRequests) { fail(request, "too many active server-pack HTTP requests"); return; }
    // Start in a Promise so synchronous validation/fetch exceptions are handled
    // identically to a rejected fetch; no detached rejection is left behind.
    Promise.resolve().then(async () => {
      if (!current(request)) return;
      const url = new URL(op.url);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password)
        throw new Error("server-pack fetch requires HTTP(S) without URL credentials");
      // Fragments never travel over HTTP; vanilla retains the original URL
      // and its independent pack hash/cache validation on the Java side.
      url.hash = "";
      const headers = new Headers(op.headers || {});
      // Cross-origin downloads use a simple GET. Optional vanilla client
      // metadata would force preflight even when the pack's GET permits CORS.
      // Same-origin endpoints may receive public metadata; never credentials.
      for (const name of [...headers.keys()]) {
        const value = headers.get(name);
        const safeValue = value.length <= 128 && (name === "accept-language"
          ? /^[0-9A-Za-z *,.;=\-]*$/.test(value)
          : name === "accept" && /^[\x20-\x7e]*$/.test(value) && !/["():<>?@\[\]\\{}]/.test(value));
        const publicMetadata = url.origin === origin
          && /^(?:x-)?minecraft-(?:username|uuid|version|version-id|pack-format)$/.test(name);
        if (!safeValue && !publicMetadata) headers.delete(name);
      }
      let response;
      try {
        response = await fetchImpl(url.href, { method: "GET", headers,
          credentials: "omit", mode: "cors", redirect: op.followRedirects === false ? "error" : "follow",
          signal: request.controller.signal });
      } catch (error) {
        // Login/profile verification and player textures own their errors.
        // Server-pack failures remain ordinary vanilla download failures.
        if (!request.controller.signal.aborted && url.protocol === "https:"
            && url.origin !== origin
            && !["textures.minecraft.net", "mcweb-profile-verifier.invalid"].includes(url.hostname))
          throw new Error("Server resource-pack download failed. The pack host must permit CORS for browser downloads. " + errorText(error));
        throw error;
      }
      if (!current(request)) { cancelBody(response); return; }
      if (response.status < 100 || response.status > 599)
        throw new Error("server-pack fetch returned an opaque or invalid HTTP status");
      request.status = response.status;
      const length = response.headers.get("content-length");
      const encoding = response.headers.get("content-encoding");
      // Fetch decodes Content-Encoding before exposing the body. A CORS
      // response can hide that header while exposing Content-Length, so its
      // length is unknown too unless identity was explicitly exposed.
      const identity = encoding?.trim().toLowerCase() === "identity";
      const decoded = encoding !== null && !identity || response.type === "cors" && !identity;
      // Preserve the exact decimal header (including >2^53) for Java's long.
      request.contentLength = !decoded && length !== null && /^\d{1,19}$/.test(length) ? length : null;
      if (!response.body) request.state = "eof";
      else {
        try { request.reader = response.body.getReader({ mode: "byob" }); }
        catch {
          cancelBody(response);
          throw new Error("server-pack fetch requires bounded byte-stream BYOB reads");
        }
        request.state = "streaming";
        void pull(request);
      }
    }).catch((error) => fail(request, error));
  };

  return {
    exchange(json) {
      const input = JSON.parse(json);
      if (!Array.isArray(input.ops) || input.ops.length > 64) throw new Error("invalid server-pack HTTP operation batch");
      for (const op of input.ops) {
        if (!Number.isSafeInteger(op.id) || op.id <= 0) throw new Error("invalid server-pack HTTP request id");
        if (op.op === "open") {
          if (requests.has(op.id)) throw new Error("duplicate server-pack HTTP request id");
          open(op);
        } else if (op.op === "cancel") cancel(requests.get(op.id));
        else if (op.op === "pull") {
          const request = requests.get(op.id);
          if (request && request.state !== "error" && request.state !== "eof") {
            if (request.credit || request.reading || request.data !== null)
              throw new Error("duplicate server-pack HTTP pull credit");
            request.credit = true;
            void pull(request);
          }
        } else throw new Error("unknown server-pack HTTP operation");
      }
      const replies = {};
      for (const [id, request] of requests) {
        const reply = { state: request.state };
        if (request.status !== undefined) {
          reply.status = request.status;
          reply.contentLength = request.contentLength;
        }
        if (request.data !== null) { reply.data = request.data; request.data = null; }
        if (request.error) reply.error = request.error;
        replies[id] = reply;
        // Terminal metadata/error is delivered once. Java retains the EOF or
        // error, and late async work is ignored by the request identity check.
        if (request.state === "eof" || request.state === "error") requests.delete(id);
      }
      return JSON.stringify({ requests: replies });
    },
  };
}
