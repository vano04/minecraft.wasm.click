import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { JsonAccountAuth, JsonAuthError } from './json-auth.mjs';
import { createGateway } from './gateway.mjs';
import { accountImportPage, launcherPage } from './launcher.mjs';
import { isWebKit, webkitRuntimePage } from './runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
const policy = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; manifest-src 'self'; connect-src 'self'; worker-src 'self'";
const runtimePolicy = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self' blob: 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https: wss:; media-src 'self' blob: https://resources.download.minecraft.net; worker-src 'self' blob:; manifest-src 'self'";
const notFound = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/site.css"><link rel="icon" href="/mcweb-icon.svg"><title>Page not found | minecraft.wasm.click</title></head><body><main class="launcher not-found-page"><div class="launcher-panel"><div class="launcher-view"><p class="kicker">minecraft.wasm.click</p><p class="not-found-code" aria-label="Error 404">404</p><h1>Page not found</h1><p class="launcher-copy">This page may have moved, or the link may be incorrect.</p><a class="pixel-button pixel-button-red" href="/">BACK TO HOME</a></div></div><footer class="not-found-footer"><nav class="privacy-links" aria-label="Site links"><a href="/privacy/">Privacy</a><a href="/contact/">Contact</a><a href="/notices/">Licenses and source</a></nav><p class="privacy-disclaimer">NOT AN OFFICIAL MINECRAFT PRODUCT OR SERVICE. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.</p></footer></main></body></html>`;

export function publicOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !['http:', 'https:'].includes(url.protocol)) throw Error('PUBLIC_ORIGIN must be an HTTP or HTTPS origin.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw Error('Use HTTPS for a public host. HTTP is supported only on localhost.');
  }
  return url.origin;
}

export async function readBody(request, maximum) {
  if (Number(request.headers['content-length']) > maximum) throw Object.assign(Error('Request too large'), { status: 413 });
  const parts = []; let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > maximum) throw Object.assign(Error('Request too large'), { status: 413 });
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}

export function createApp({ origin = 'http://localhost:8080', site = resolve(root, 'site'),
  fetchImpl = fetch, auth = new JsonAccountAuth({ origin, fetchImpl }), gatewayOptions = {} } = {}) {
  origin = publicOrigin(origin);
  const host = new URL(origin).host;
  const gateway = createGateway({ auth, origin, fetchImpl, ...gatewayOptions });
  let imports = 0;
  function headers(request, runtime = false) {
    return { 'Cache-Control': runtime ? 'private, no-store' : 'no-store',
      'Content-Security-Policy': runtime ? runtimePolicy : policy,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': runtime && !isWebKit(request) ? 'credentialless' : 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=()',
      ...(runtime ? { Vary: 'Cookie, User-Agent, Accept-Encoding' } : {}),
      ...(origin.startsWith('https:') ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}) };
  }
  function send(request, response, status, body, type = 'text/html; charset=utf-8', extra = {}, runtime = false) {
    response.writeHead(status, { ...headers(request, runtime), 'Content-Type': type, ...extra });
    response.end(request.method === 'HEAD' ? undefined : body);
  }
  const json = (request, response, status, value, extra = {}) => send(request, response, status,
    JSON.stringify(value), 'application/json; charset=utf-8', extra);
  async function asset(request, response, name, runtime = false) {
    const path = resolve(site, name);
    if (!path.startsWith(resolve(site) + '/') || !(await lstat(path).catch(() => null))?.isFile()) return false;
    const info = await lstat(path);
    response.writeHead(200, { ...headers(request, runtime), 'Content-Type': mime[extname(path)] || 'application/octet-stream',
      'Content-Length': info.size });
    if (request.method === 'HEAD') response.end();
    else await pipeline(createReadStream(path), response);
    return true;
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/healthz' && ['GET', 'HEAD'].includes(request.method)) {
        return send(request, response, 200, 'ok', 'text/plain; charset=utf-8');
      }
      if (request.headers.host !== host) return json(request, response, 421, { error: 'Unknown host' });
      const url = new URL(request.url, origin), path = url.pathname;
      if (url.origin !== origin || /%|\\|\/\//.test(path)) return send(request, response, 404, notFound);
      if (path === '/mcweb/auth/import') {
        if (request.method !== 'POST') return json(request, response, 405, { error: 'Use POST' }, { Allow: 'POST' });
        if (request.headers.origin !== origin || request.headers['content-type']?.split(';')[0] !== 'application/json') {
          return json(request, response, 403, { error: 'Request rejected' });
        }
        if (imports >= 8) return json(request, response, 429, { error: 'Too many account verification requests. Try again later.' });
        imports++;
        try {
          const result = await auth.importAccount(await readBody(request, 1024 * 1024));
          const old = auth.sessionId(request);
          if (old) auth.revoke(old);
          return json(request, response, 200, result.session, { 'Set-Cookie': auth.cookie(result.sessionId) });
        } finally { imports--; }
      }
      if (path === '/mcweb/auth/session') {
        if (!['GET', 'HEAD'].includes(request.method)) return json(request, response, 405, { error: 'Use GET' }, { Allow: 'GET, HEAD' });
        const session = auth.session(request);
        return json(request, response, session ? 200 : 401, session || { authenticated: false });
      }
      if (path === '/mcweb/auth/logout') {
        if (request.method !== 'POST') return json(request, response, 405, { error: 'Use POST' }, { Allow: 'POST' });
        if (request.headers.origin !== origin) return json(request, response, 403, { error: 'Request rejected' });
        auth.revoke(auth.sessionId(request));
        return json(request, response, 200, { authenticated: false }, { 'Set-Cookie': auth.clearCookie() });
      }
      if (path === '/mcweb/config.json') {
        if (request.method !== 'GET') return json(request, response, 405, { error: 'Use GET' }, { Allow: 'GET' });
        if (!auth.session(request)) return json(request, response, 401, { error: 'Import your Minecraft account first.' });
        return json(request, response, 200, gateway.config);
      }
      if (path === '/mcweb/auth/minecraft/skin' && ['GET', 'HEAD'].includes(request.method)) {
        const credential = auth.credentials(request);
        if (!credential) return json(request, response, 401, { error: 'Minecraft session required' });
        if (!credential.skinUrl) return json(request, response, 404, { error: 'No skin' });
        const upstream = await fetchImpl(credential.skinUrl, { redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!upstream.ok || !upstream.headers.get('content-type')?.startsWith('image/png')) {
          await upstream.body?.cancel(); return json(request, response, 502, { error: 'Skin unavailable' });
        }
        const reader = upstream.body.getReader(), chunks = []; let size = 0;
        try {
          for (;;) { const {done,value}=await reader.read(); if(done)break; size+=value.length;
            if(size>1024*1024)throw Error('Skin exceeds limit'); chunks.push(value); }
        } finally { await reader.cancel(); }
        if (auth.credentials(request) !== credential) return json(request, response, 401, { error: 'Minecraft session expired' });
        return send(request, response, 200, Buffer.concat(chunks), 'image/png');
      }
      if (await gateway.handleHttp(request, response)) return;
      if (!['GET', 'HEAD'].includes(request.method)) return json(request, response, 405, { error: 'Use GET' }, { Allow: 'GET, HEAD' });
      if (['/', '/index.html', '/auth', '/auth/'].includes(path)) {
        if (auth.session(request)) return send(request, response, 303, '', 'text/plain', { Location: '/play/' });
        return send(request, response, 200, accountImportPage());
      }
      if (path === '/play') return send(request, response, 308, '', 'text/plain', { Location: '/play/' });
      if (path.startsWith('/play/')) {
        const session = auth.session(request);
        if (!session) {
          if (['/play/', '/play/index.html'].includes(path)) return send(request, response, 200, accountImportPage());
          return json(request, response, 401, { error: 'Import your Minecraft account first.' });
        }
        if (['/play/', '/play/index.html'].includes(path)) {
          let html = await readFile(resolve(site, 'play/index.html'), 'utf8');
          if (isWebKit(request)) html = webkitRuntimePage(html);
          return send(request, response, 200, launcherPage(html, session, gateway.config), 'text/html; charset=utf-8', {}, true);
        }
        const files = JSON.parse(await readFile(resolve(site, 'runtime-files.json'), 'utf8'));
        const name = path.slice('/play/'.length);
        if (Object.hasOwn(files, name) && await asset(request, response, 'play/' + name, true)) return;
      }
      const aliases = { '/privacy':'privacy/index.html', '/privacy/':'privacy/index.html', '/contact':'contact/index.html',
        '/contact/':'contact/index.html', '/notices':'notices/index.html', '/notices/':'notices/index.html' };
      const publicFiles = JSON.parse(await readFile(resolve(site, 'public-files.json'), 'utf8'));
      const name = aliases[path] || path.slice(1);
      if (publicFiles.includes(name) && await asset(request, response, name)) return;
      return send(request, response, 404, notFound, 'text/html; charset=utf-8', { 'X-Robots-Tag':'noindex, nofollow, noarchive' });
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const exposed = error instanceof JsonAuthError;
      const status = exposed ? error.status : error.status === 413 ? 413 : 500;
      json(request, response, status, { error: exposed ? error.message : status === 413 ? 'Request too large' : 'Request could not be completed.',
        ...(exposed ? { code:error.code } : {}) });
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000;
  server.on('upgrade', gateway.handleUpgrade);
  server.auth = auth; server.gateway = gateway;
  server.shutdown = () => { auth.close(); gateway.close(); return new Promise(resolve => server.close(resolve)); };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT must be between 1 and 65535.');
  const origin = publicOrigin(process.env.PUBLIC_ORIGIN || 'http://localhost:8080');
  const app = createApp({ origin });
  app.listen(port, process.env.HOST || '127.0.0.1', () => console.log('Launcher listening at ' + origin));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void app.shutdown(); });
}
