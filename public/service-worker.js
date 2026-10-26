'use strict';
// Protected HTML, authentication, game files and player data always use the network.
// An installed app can show a useful offline screen without caching a session.
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || request.mode !== 'navigate' || url.origin !== self.location.origin
      || !['/', '/play', '/play/'].includes(url.pathname)) return;
  event.respondWith(fetch(request).catch(() => new Response(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>minecraft.wasm.click · Offline</title><style>body{font:18px system-ui;margin:0;background:#f7f7f4;color:#222;display:grid;min-height:100vh;place-items:center}main{max-width:32rem;padding:2rem}a{color:#a12027}</style></head>
<body><main><h1>You are offline</h1><p>Connect to the internet to sign in and play. Your saved worlds remain in this browser's storage.</p><a href="/">Try again</a><p>minecraft.wasm.click is an independent project, not approved by or associated with Mojang or Microsoft. <a href="/contact/">Contact</a> · <a href="https://github.com/vano04/minecraft.wasm.click" target="_blank" rel="noopener noreferrer">GitHub</a></p></main></body></html>`, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'X-Content-Type-Options': 'nosniff' },
  })));
});
