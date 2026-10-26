import { playerStorageTestingPage } from './game-storage-launcher.mjs';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const authPolicy = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; manifest-src 'self'; worker-src 'self'";
const launcherTitle = '<h1 class="testing-title"><span class="title-edition">Web Launcher</span> <span class="title-launcher">For Minecraft: Java Edition</span></h1>';
const notice = `<dialog id="launcher-notice" class="launcher-dialog" aria-labelledby="notice-title" aria-describedby="notice-description">
<h2 id="notice-title" tabindex="-1" autofocus>About minecraft.wasm.click</h2>
<div id="notice-description"><p>minecraft.wasm.click is an experimental browser launcher for Minecraft: Java Edition. It runs a port of OpenJDK using WebAssembly so the Java game can run in your browser.</p>
<p>The launcher does not include Minecraft. Your browser downloads the Minecraft client from Mojang. This site supplies the Java runtime and other launcher libraries. Sounds and panorama images use Mojang's asset host with a GitHub raw-file fallback. The browser checks those files against Mojang's asset index. Installed files stay on this device.</p>
<p>Import the active account JSON from PrismLauncher. This server verifies its unexpired Minecraft token, game ownership and profile before the game can load. The file and refresh tokens are not stored.</p>
<p>This is an independent, non-commercial project. Minecraft belongs to Mojang and Microsoft. This is not an official Minecraft product or service and is not approved by or associated with Mojang or Microsoft.</p></div>
<form method="dialog"><label class="notice-read"><input id="notice-read" type="checkbox" required><span class="pixel-check" aria-hidden="true"></span><span>I have read this notice.</span></label><button id="notice-continue" class="pixel-button pixel-button-red" disabled>CONTINUE</button></form>
<a href="/privacy">Read the privacy statement</a></dialog>`;
const noticeLink = '<a href="https://github.com/vano04/minecraft.wasm.click" target="_blank" rel="noopener noreferrer">GitHub</a><a href="/contact/">Contact</a><button class="text-button" type="button" data-open-notice>About this project</button>';
const uiScript = '<script src="/auth/launcher-ui.js?v=public-json1"></script><script src="/pwa.js?v=20261021-pwa1" defer></script>';
const pwaHead = '<link rel="icon" href="/mcweb-icon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#f7f7f4"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="minecraft.wasm.click"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">';
export function installablePage(html) {
  return html.includes('</head>') ? html.replace('</head>', pwaHead + '</head>')
    : html.replace('</title>', '</title>' + pwaHead);
}
export function accountImportPage() {
  return installablePage(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>minecraft.wasm.click | Import account</title><link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/auth/testing.css"></head>
<body><main class="privacy-page dev-page"><div class="privacy-shell dev-shell">${launcherTitle}
<section class="privacy-card dev-card"><h2>Import your Minecraft account</h2><p>Choose your PrismLauncher accounts.json file. The active account must own Minecraft: Java Edition and have an unexpired Minecraft token.</p><form id="account-import"><label for="account-file" class="account-file-label">Account JSON</label><input id="account-file" name="account" type="file" accept=".json,application/json" required aria-describedby="account-help"><p id="account-help">Only the selected Minecraft token and profile go to this server. Your file and Microsoft refresh tokens stay out of server storage.</p><button id="login-button" class="pixel-button pixel-button-red" type="submit">IMPORT ACCOUNT JSON</button></form><p id="account-status" class="dev-status" role="status" aria-live="polite">Refresh the account in PrismLauncher first if its Minecraft token has expired.</p></section>
<nav class="privacy-links"><a href="/privacy">Privacy</a><a href="/notices/">Licenses and source</a>${noticeLink}</nav><p class="privacy-disclaimer">NOT AN OFFICIAL MINECRAFT PRODUCT OR SERVICE. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.</p></div></main>${notice}${uiScript}<script type="module" src="/auth/login.js"></script></body></html>`);
}
export function launcherPage(html, session, config) {
  if (html.includes('    await createJavaVM({')) html = playerStorageTestingPage(html);
  const profile = session.profile;
  const controls = html.match(/<span id="launch-options"><\/span>[\s\S]*?(?=<\/div>)/)?.[0] || '';
  let header = `<main id="testing-launcher" class="privacy-page dev-page"><div class="privacy-shell dev-shell"><div class="launcher-toolbar">${launcherTitle}<button id="settings-button" class="pixel-button icon-button" type="button" aria-label="Settings" title="Settings" aria-haspopup="dialog" aria-controls="launcher-settings"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="4"/><g fill="currentColor"><rect x="10" y="1" width="4" height="5" rx=".5" transform="rotate(0 12 12)"/><rect x="10" y="1" width="4" height="5" rx=".5" transform="rotate(45 12 12)"/><rect x="10" y="1" width="4" height="5" rx=".5" transform="rotate(90 12 12)"/><rect x="10" y="1" width="4" height="5" rx=".5" transform="rotate(135 12 12)"/><rect x="10" y="1" width="4" height="5" rx=".5" transform="rotate(180 12 12)"/><rect x="10" y="1" width="4" height="5" rx=".5" transform="rotate(225 12 12)"/><rect x="10" y="1" width="4" height="5" rx=".5" transform="rotate(270 12 12)"/><rect x="10" y="1" width="4" height="5" rx=".5" transform="rotate(315 12 12)"/></g></svg></button></div>
<section class="privacy-card dev-card"><div class="launcher-account-row"><p class="game-version">Game Version: 26.3</p><details id="account-menu" class="testing-account account-menu"><summary aria-label="Account for ${escape(profile.name)}"><img src="/mcweb/auth/minecraft/skin" width="64" height="64" alt=""><strong>${escape(profile.name)}</strong><span class="account-chevron" aria-hidden="true">▾</span></summary><div class="account-dropdown"><button id="logout-button" class="text-button" type="button">Sign out</button></div></details></div><p>Install the game from Mojang once, then launch it from this browser.</p><div class="auth-actions"><button id="install" class="pixel-button" type="button">INSTALL</button><button id="play" class="pixel-button pixel-button-red" type="button" disabled>PLAY</button></div><p id="status" class="dev-status" role="status" aria-live="polite">Checking this browser…</p></section><nav class="privacy-links"><a href="/privacy">Privacy</a><a href="/notices/">Licenses and source</a>${noticeLink}</nav></div></main>`;
  const before = /<header>[\s\S]*?<\/header>\s*<div class="bar">[\s\S]*?<\/div>/;
  if (!before.test(html) || !html.includes('playButton.onclick = async () => {') || !html.includes('installButton.onclick = async () => {')) throw new Error('Unexpected testing launcher');
  const memoryPanel = html.match(/<details id="memory-profile">[\s\S]*?<\/details>/)?.[0];
  if (memoryPanel) {
    html = html.replace(memoryPanel, '');
  }
  const runtimeLog = html.match(/<details id="runtime-log">[\s\S]*?<\/details>/)?.[0] || '';
  html = html.replace(runtimeLog, '');
  header += `<dialog id="launcher-settings" class="launcher-dialog" aria-labelledby="settings-title"><div class="dialog-heading"><h2 id="settings-title">Settings</h2><form method="dialog"><button class="pixel-button icon-button" aria-label="Close settings" autofocus><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5 2L10 7L15 2L18 5L13 10L18 15L15 18L10 13L5 18L2 15L7 10L2 5Z" fill="currentColor"/></svg></button></form></div>`
    + '<section class="testing-controls"><h3>Multiplayer</h3><p>This server supplies the authenticated Minecraft connection. The browser encrypts game traffic. The server can reach public Minecraft destinations; private network addresses are blocked.</p></section>'
    + (controls ? '<section class="testing-controls"><h3>Play settings</h3>' + controls + '</section>' : '')
    + (memoryPanel?.replace('Profile memory (optional, separate from Play)', 'Memory settings') || '')
    + runtimeLog
    + '</dialog>' + notice + uiScript;
  const state = JSON.stringify({ session, config }).replaceAll('<', '\\u003c');
  html = html.replace(/<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/auth/testing.css">')
    .replace(before, header)
    .replace(/<title>[\s\S]*?<\/title>/, '<title>minecraft.wasm.click | For Minecraft: Java Edition</title>')
    .replace('<script>', `<script src="/auth/browser-auth.js"></script><script>globalThis.__mcWebVerified = ${state};globalThis.mcWebConfig = __mcWebVerified.config;</script><script src="/auth/account.js"></script><script>`)
    .replace('installButton.onclick = async () => {', "installButton.onclick = async () => {\n  await globalThis.mcWebAuthGate.getSession();")
    .replace("'--version', '26.3', '--accessToken', '0', '--userType', 'legacy',", "'--version', '26.3', '--username', __mcWebVerified.session.profile.name, '--uuid', __mcWebVerified.session.profile.id, '--accessToken', '0', '--userType', 'msa',")
    .replace("    status.textContent = mobile.usesIOSRuntime() ?", "    document.body.dataset.launcherState = 'game';\n    status.textContent = mobile.usesIOSRuntime() ?")
    .replace("    status.textContent = usesIOSRuntime() ?", "    document.body.dataset.launcherState = 'game';\n    status.textContent = usesIOSRuntime() ?");
  html = html.replace('      print: t => {', "      print: t => {\n        if (t === '[MCWEB-OPEN-RESOURCEPACKS]') globalThis.mcWebOpenResourcePacks?.();\n        if (t === '[MC-STAGE] lifecycle:quit-handed-to-page') void globalThis.mcWebQuitToLauncher?.().catch(() => {});");
  const fullscreen = 'if (fullscreenOnPlay.checked) gameControls.enterFullscreen();';
  html = html.includes(fullscreen)
    ? html.replace(fullscreen, fullscreen + '\n  await globalThis.mcWebAuthGate.getSession();')
    : html.replace('playButton.onclick = async () => {', 'playButton.onclick = async () => {\n  await globalThis.mcWebAuthGate.getSession();');
  html = html.replace('holder.replaceWith(canvas);', "holder.replaceWith(canvas);\n  document.body.dataset.launcherState = 'game';");
  return installablePage(html).replace('<script src="/auth/launcher-ui.js', '<script src="/auth/game-library.js?v=20261021-library1"></script><script src="/auth/launcher-ui.js');
}
export function authenticatedGpuWorker(source) {
  const marker = '  async function bootHost() {';
  const pack = 'createBrowserPackHttp({ fetchImpl: createPlayerTextureFetch() })';
  if (source.split(marker).length !== 2 || source.split(pack).length !== 2) throw new Error('Unexpected GPU worker');
  return source.replace('importScripts("mc-wisp-socket.js", "mc-net.js");', 'importScripts("/auth/tcp-socket.js", "/auth/tcp-net.js");').replace(pack, 'createBrowserPackHttp({ fetchImpl: createRelayPackFetch({ fetchImpl: createPlayerTextureFetch() }) })')
    .replace(marker, marker + `
    const { createRelayPackFetch } = await import('/auth/relay-pack.mjs');
    const configResponse = await fetch('/mcweb/config.json', { cache: 'no-store', credentials: 'same-origin' });
    const sessionResponse = await fetch('/mcweb/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    if (!configResponse.ok || !sessionResponse.ok) throw new Error('Import a fresh Minecraft account JSON file');
    const config = await configResponse.json(), session = await sessionResponse.json();
    if (config.auth?.mode !== 'online' || session.authenticated !== true || session.expiresAt <= Date.now()) throw new Error('Verified Minecraft session required');
    globalThis.mcWebConfig = config;
    globalThis.mcWebAuthGate = { session: () => session };
`);
}

export function relayPackHttp(source) {
  const message = 'The pack host must permit CORS for browser downloads. ';
  if (source.split(message).length !== 2) throw new Error('Unexpected resource-pack HTTP adapter');
  return source.replace(message, 'Check the pack URL and the selected relay. ');
}
