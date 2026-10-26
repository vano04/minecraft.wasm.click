"use strict";

/**
 * Remote-server transport: the page's half of multiplayer.
 *
 * A browser cannot open TCP, so the app origin serves a WebSocket gateway
 * (tools/mc-relay.mjs, embedded by the bundle's serve.mjs) that terminates
 * Minecraft's VarInt framing, encryption and login compression, and speaks
 * whole packet bodies: one binary WebSocket message per packet.
 *
 * Java runs Mojang's own Connection over a Netty channel
 * (dev.mcweb.graal.net.WebSocketChannel). Its IO thread cannot reach this
 * object - only the client thread's RPC proxy can - so the client thread's
 * frame pump (BrowserSocketPump) carries everything across in one call per
 * frame: `exchange(request)` opens, writes and closes sockets, and returns each
 * socket's state and the packets that arrived since the last call. The
 * sockets live here, on the GPU worker, whose event loop keeps turning while
 * the JVM thread is parked.
 *
 *   request  {"ops":[{"op":"open","id":1,"host":"h","port":25565},
 *                    {"op":"send","id":1,"data":"<base64 body>"},
 *                    {"op":"keepAlive","id":1,"clientbound":38,"serverbound":27,"length":9},
 *                    {"op":"close","id":1}]}
 * A socket is "open" once the gateway reports the server reached (a text
 * frame {"connected":true}); before that it is "connecting", and a failure
 * then is a failed connect.
 *
 *   response {"sockets":{"1":{"state":"connecting|open|closed|error",
 *                             "error":"...", "in":"<base64 blob>"}}}
 *
 * `in` is the packets in arrival order, each as a 4-byte big-endian length and
 * the body. A socket is reported once more after it closes, with its last
 * packets, and then forgotten.
 */
globalThis.mcWebNet = globalThis.mcWebNet || (() => {
  let launcherIdentity = null;

  function readVarIntAt(bytes, start) {
    let value = 0;
    let shift = 0;
    let offset = start;
    while (offset < bytes.length) {
      const byte = bytes[offset++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return { value: value >>> 0, next: offset };
      shift += 7;
      if (shift > 35) break;
    }
    return null;
  }

  async function inflate(bytes, expected) {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream("deflate"));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    if (out.length !== expected) {
      throw new Error(`packet inflated to ${out.length} bytes, expected ${expected}`);
    }
    return out;
  }

  function configuredRelayOverride() {
    return new URLSearchParams(globalThis.location?.search || "")
      .get("mcweb_relay");
  }

  function sameOriginGatewayUrl() {
    const socketPath = globalThis.mcWebConfig?.gateway?.socketPath || "/mcweb/socket";
    const url = new URL(socketPath, globalThis.location?.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  function gatewayUrl() {
    const configured = configuredRelayOverride();
    return configured ? new URL(configured, globalThis.location?.href).toString()
      : sameOriginGatewayUrl();
  }

  function targetKey(host, port) {
    const normalizedHost = String(host ?? "").trim().toLowerCase();
    const normalizedPort = Number(port);
    if (!normalizedHost || /[\u0000-\u0020/?#]/.test(normalizedHost)
        || !Number.isInteger(normalizedPort)
        || normalizedPort < 1 || normalizedPort > 65535) {
      return null;
    }
    return `${normalizedHost}:${normalizedPort}`;
  }

  /** Mirrors the serving process's advertised policy for immediate UI feedback. */
  function targetAllowed(host, port) {
    const target = targetKey(host, port);
    if (!target) return false;
    const gateway = globalThis.mcWebConfig?.gateway;
    if (gateway?.allowAnyTarget === true) return true;
    if (Array.isArray(gateway?.allowedTargets)) {
      return gateway.allowedTargets.some((entry) =>
        String(entry).trim().toLowerCase() === target);
    }
    // Fail closed to the historical browser scope when served without the
    // standard config endpoint. The gateway still performs the real check.
    const normalizedHost = String(host).trim().toLowerCase();
    return normalizedHost === "localhost" || normalizedHost === "::1"
      || normalizedHost === "[::1]" || /^127\./.test(normalizedHost);
  }

  function relayHttpUrl(legacyPath) {
    const configured = configuredRelayOverride();
    const url = new URL(configured || globalThis.location?.href, globalThis.location?.href);
    const sameOrigin = url.host === globalThis.location?.host;
    const loopback = url.hostname === "localhost"
      || url.hostname === "127.0.0.1"
      || url.hostname === "::1"
      || url.hostname === "[::1]"
      || /^127\./.test(url.hostname);
    if ((!sameOrigin && !loopback)
        || !["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
      throw new Error(`refusing cross-origin gateway metadata URL: ${url.origin}`);
    }
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    url.pathname = configured ? legacyPath : `/mcweb${legacyPath}`;
    url.search = "";
    url.hash = "";
    return url;
  }

  function socketUrl(relayUrl, host, port) {
    const url = new URL(relayUrl || gatewayUrl(), globalThis.location?.href);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error(`invalid Minecraft gateway protocol: ${url.protocol}`);
    }
    if (!targetAllowed(host, port)) {
      throw new Error(`Minecraft server target is not allowed: ${host}:${port}`);
    }
    url.searchParams.set("host", String(host));
    url.searchParams.set("port", String(Number(port)));
    return url.toString();
  }

  async function loadLauncherIdentity() {
    // Offline mode is an intentional prototyping identity, not a failed online
    // lookup. Avoid an expected 404 (and its noisy console entry) entirely.
    if (globalThis.mcWebConfig?.auth?.mode !== "online") return null;
    const authSession = globalThis.mcWebAuthGate?.session?.();
    const authenticated = authSession?.authenticated === true ? authSession.profile : null;
    if (authSession?.cached) return null;
    if (authenticated) {
      const id = String(authenticated.id || "").replace(/-/g, "").toLowerCase();
      const name = String(authenticated.name || "");
      if (/^[0-9a-f]{32}$/.test(id) && name.length >= 1 && name.length <= 16) {
        launcherIdentity = { name, id };
        console.log(`[mcweb-net] authenticated profile ${name}`);
        return launcherIdentity;
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 200);
    try {
      const response = await fetch(relayHttpUrl("/identity"), {
        mode: "cors",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const value = await response.json();
      const name = typeof value?.name === "string" ? value.name : "";
      const id = typeof value?.id === "string"
        ? value.id.replace(/-/g, "").toLowerCase()
        : "";
      if (!value?.available || !/^[0-9a-f]{32}$/.test(id)
          || name.length < 1 || name.length > 16) {
        return null;
      }
      launcherIdentity = { name, id };
      console.log(`[mcweb-net] authenticated profile ${name}`);
      return launcherIdentity;
    } catch {
      // Offline prototyping uses Minecraft's ordinary offline User.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Start while WebGPU initialises. webgpu-host awaits this bounded promise
  // immediately before loading the Web Image script, so GameConfig sees the
  // authenticated UUID without adding more than 200 ms when no relay exists.
  const launcherIdentityReady = loadLauncherIdentity();

  function bytesToBase64(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  }

  function base64ToBytes(base64) {
    const text = atob(String(base64));
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  }

  // -------------------------------------------------------------------------
  // Sockets, one per Netty channel
  // -------------------------------------------------------------------------

  const sockets = new Map();
  let opened = 0;

  function openSocket(id, host, port) {
    const s = {
      id, host: String(host), port: Number(port), state: "connecting", error: "",
      ws: null, outbound: [], inbound: [], inboundBytes: 0,
      // Minecraft's zlib layer, once the gateway hands it over (a text frame
      // as the connection enters play): the gateway forwards the server's own
      // compressed frames, and they are inflated here, where
      // DecompressionStream is native code. Inflation is async; the chain
      // keeps packets in arrival order, and `pending` holds the close report
      // back until the last one is queued.
      compression: -1, chain: Promise.resolve(), pending: 0, decodeFailed: false,
      discarded: false,
      wasOpen: false, reportedOpen: false, sent: 0, received: 0,
    };
    sockets.set(id, s);
    opened++;
    const fail = (why) => {
      if (s.state === "closed" || s.state === "error") return;
      s.error = String(why || "connection failed");
      s.state = "error";
      try { s.ws?.close(); } catch { /* already closing */ }
    };
    try {
      if (['wisp', 'local'].includes(globalThis.mcWebConfig?.gateway?.transport)) {
        if (!targetAllowed(host, port)) throw Error('Minecraft server target is not allowed');
        s.ws = new MinecraftWispSocket(String(host), Number(port), globalThis.mcWebConfig.gateway.wispPath);
      } else s.ws = new WebSocket(socketUrl(null, host, port));
    } catch (error) {
      fail(error?.message || error);
      return;
    }
    const ws = s.ws;
    ws.binaryType = "arraybuffer";
    // The WebSocket opening only reaches the gateway; the socket is open once
    // the gateway says the server is reached (its {"connected":true} text
    // frame), so a refused server fails the connect as it would over TCP.
    const connected = () => {
      if (s.state !== "connecting") return;
      s.state = "open";
      s.wasOpen = true;
      for (const body of s.outbound) { ws.send(body); s.sent++; }
      s.outbound.length = 0;
      console.log(`[mcweb-net] socket ${id} open via ${new URL(ws.url).origin} to ${s.host}:${s.port}`);
    };
    ws.onmessage = (event) => {
      if (s.discarded || s.decodeFailed) return;
      // Text frames are the gateway's control channel: the server is reached,
      // and, as the connection enters play, the hand-over of compression.
      if (typeof event.data === "string") {
        try {
          const control = JSON.parse(event.data);
          if (control?.connected === true) connected();
          if (control?.compression !== undefined) s.compression = Number(control.compression);
        } catch (error) {
          console.warn("[mcweb-net] unreadable gateway control frame", error);
        }
        return;
      }
      const frame = new Uint8Array(event.data);
      s.received++;
      if (s.compression < 0) { queue(s, () => frame); return; }
      // One compressed frame: the uncompressed size, then the body; zero
      // means it was under the threshold and is stored raw.
      queue(s, () => {
        const size = readVarIntAt(frame, 0);
        if (!size) throw new Error("truncated compressed packet");
        const body = frame.subarray(size.next);
        return size.value === 0 ? body : inflate(body, size.value);
      });
    };
    ws.onerror = () => fail("websocket error");
    ws.onclose = (event) => {
      // The gateway closes with a reason for platform failures (a denied
      // target, an online-mode server in offline mode); Minecraft shows it.
      const reason = String(event.reason || "").trim();
      if (reason) fail(reason);
      else if (s.state === "connecting") fail("closed before connecting");
      else if (s.state === "open") s.state = "closed";
      console.log(`[mcweb-net] socket ${id} closed code=${event.code}`
        + `${reason ? ` reason=${reason}` : ""} sent=${s.sent} received=${s.received}`);
    };
  }

  function queue(s, decode) {
    s.pending++;
    // Start decoding only when the preceding packet has finished. Eager
    // inflate promises could reject before the chain attached their handler.
    s.chain = s.chain.then(async () => {
      if (s.decodeFailed || s.discarded) return;
      const bytes = await decode();
      if (s.discarded) return;
      if (['wisp', 'local'].includes(globalThis.mcWebConfig?.gateway?.transport) && s.inboundBytes + bytes.length > 32 * 1024 * 1024) {
        throw Error('Minecraft receive buffer exceeded while the game was busy');
      }
      s.inbound.push(bytes);
      s.inboundBytes += bytes.length + 4;
    }).catch((error) => {
      if (s.discarded) return;
      s.decodeFailed = true;
      s.error = String(error?.message ?? error);
      s.state = "error";
      try { s.ws?.close(); } catch { /* already closing */ }
    }).finally(() => { s.pending--; });
  }

  function send(s, base64) {
    const body = base64ToBytes(base64);
    if (s.state === "open") { s.ws.send(body); s.sent++; }
    else if (s.state === "connecting") s.outbound.push(body);
  }

  function drain(s) {
    const blob = new Uint8Array(s.inboundBytes);
    let offset = 0;
    for (const packet of s.inbound) {
      new DataView(blob.buffer).setUint32(offset, packet.length, false);
      blob.set(packet, offset + 4);
      offset += packet.length + 4;
    }
    s.inbound.length = 0;
    s.inboundBytes = 0;
    return bytesToBase64(blob);
  }

  /** The client thread's one call per frame; see the header. */
  function exchange(requestJson) {
    const request = requestJson ? JSON.parse(String(requestJson)) : {};
    for (const op of request.ops || []) {
      const s = sockets.get(op.id);
      if (op.op === "open") {
        if (!s) openSocket(op.id, op.host, op.port);
      } else if (op.op === "send") {
        if (s) send(s, op.data);
      } else if (op.op === "keepAlive") {
        // The gateway answers keep-alives for a client stalled on a big
        // resource pack; it needs the play phase's ids, which only Java has.
        if (s?.state === "open") {
          s.ws.send(JSON.stringify({ keepAlive: {
            clientbound: op.clientbound, serverbound: op.serverbound, length: op.length } }));
        }
      } else if (op.op === "close") {
        if (s) {
          s.discarded = true;
          if (s.state === "connecting" || s.state === "open") s.state = "closed";
          try { s.ws?.close(); } catch { /* already closing */ }
          sockets.delete(op.id);
        }
      }
    }
    const report = {};
    for (const [id, s] of sockets) {
      const ended = s.state === "closed" || s.state === "error";
      // Report the end only once every packet before it is handed over, and
      // never before Java has seen the socket open: a socket that opened and
      // closed within one frame is a short connection, not a failed connect.
      const settled = !ended || (s.pending === 0 && (s.reportedOpen || !s.wasOpen));
      const entry = { state: settled ? s.state : "open" };
      if (entry.state === "open") s.reportedOpen = true;
      if (settled && s.error) entry.error = s.error;
      if (s.inbound.length) entry.in = drain(s);
      report[id] = entry;
      if (ended && settled) sockets.delete(id);
    }
    return JSON.stringify({ sockets: report });
  }

  /**
   * Asks the client to join a server (console or harness:
   * globalThis.__mcWebJoin on the page). The Java side polls this from its
   * frame pump and joins through Mojang's ConnectScreen.
   */
  let pendingJoin = null;
  function join(relay, host, port, name) {
    pendingJoin = JSON.stringify({
      host: String(host ?? "127.0.0.1"),
      port: Number(port ?? 25565),
      name: String(name ?? "WebPlayer")
    });
    return { ok: true };
  }
  function consumeJoin() {
    const request = pendingJoin;
    pendingJoin = null;
    return request;
  }

  function info() {
    return {
      opened, gateway: gatewayUrl(), launcherIdentity,
      sockets: [...sockets.values()].map((s) => ({
        id: s.id, target: `${s.host}:${s.port}`, state: s.state, error: s.error,
        sent: s.sent, received: s.received, queued: s.inbound.length, compression: s.compression })),
    };
  }

  return { exchange, join, consumeJoin, info,
    gatewayUrl, targetAllowed,
    identity: () => launcherIdentity,
    identityReady: () => launcherIdentityReady };
})();
