// Static server with the cross-origin isolation headers SharedArrayBuffer (and
// therefore Emscripten pthreads, and therefore this JVM) requires.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import {
  handleMinecraftGatewayHttp,
  handleMinecraftGatewayUpgrade,
} from "../../tools/mc-relay.mjs";

// MCWEB_ROOT serves another directory the same way (the Playwright config
// serves web/'s isolation pages with it).
const ROOT = process.env.MCWEB_ROOT
  ? join(process.cwd(), process.env.MCWEB_ROOT, "/")
  : new URL(".", import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8099);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
                ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json",
                ".wasm": "application/wasm",
                ".data": "application/octet-stream", ".jar": "application/java-archive" };

const server = createServer(async (req, res) => {
  // Multiplayer needs a WebSocket/TCP bridge, exactly as the app lane's
  // dev-server provides one. Same endpoint, same relay module, so a join from
  // this harness exercises the shipped gateway rather than a second one.
  if (await handleMinecraftGatewayHttp(req, res)) return;
  const path = join(ROOT, normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  let file = path;
  try { if ((await stat(file)).isDirectory()) file = join(file, "index.html"); }
  catch { res.writeHead(404).end("not found"); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
    }).end(body);
  } catch { res.writeHead(404).end("not found"); }
});

// A browser gateway is a same-origin capability; mc-relay's allowlist is the
// second boundary.
server.on("upgrade", (request, socket) => {
  if (new URL(request.url, "http://localhost").pathname !== "/mcweb/socket") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  let sameOrigin = false;
  try {
    const parsed = new URL(String(request.headers.origin));
    sameOrigin = (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.host === request.headers.host;
  } catch { /* opaque origin: reject */ }
  if (!sameOrigin) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  handleMinecraftGatewayUpgrade(request, socket);
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT} on http://localhost:${PORT}`);
  console.log(`minecraft gateway: ws://localhost:${PORT}/mcweb/socket`);
});
