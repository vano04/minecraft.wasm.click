#!/usr/bin/env node
// Check the public import and authenticated launcher markup.
// Browser rendering and physical touch input require separate device checks.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { accountImportPage, launcherPage } from '../server/launcher.mjs';

const root = new URL('../', import.meta.url);
const [siteCss, testingCss, manifestText, controls] = await Promise.all([
  readFile(new URL('public/site.css', root), 'utf8'),
  readFile(new URL('public/auth/testing.css', root), 'utf8'),
  readFile(new URL('public/manifest.webmanifest', root), 'utf8'),
  readFile(new URL('runtime/web/game-controls.js', root), 'utf8'),
]);
const runtime = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Runtime</title><style></style></head><body>
<header>Runtime</header><div class="bar"><span id="launch-options"></span><label>Resolution<select><option>Default</option></select></label></div>
<details id="memory-profile"><summary>Profile memory (optional, separate from Play)</summary></details>
<details id="runtime-log"><summary>Runtime log</summary></details><canvas id="game-canvas"></canvas>
<script>playButton.onclick = async () => {};installButton.onclick = async () => {};holder.replaceWith(canvas);</script></body></html>`;
const launcher = launcherPage(runtime, { profile: { id: '0'.repeat(32), name: 'VerifiedPlayer' } }, { auth: { mode: 'online' } });
for (const html of [accountImportPage(), launcher]) {
  assert.match(html, /name="viewport" content="width=device-width,initial-scale=1"/);
  assert.match(html, /href="\/site\.css"/);
  assert.match(html, /href="\/auth\/testing\.css"/);
  assert.match(html, /href="\/manifest\.webmanifest"/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1|Rotate your device|screen\.orientation\.lock/);
}
assert.match(accountImportPage(), /id="login-button"/);
assert.match(launcher, /id="settings-button"[^>]*aria-controls="launcher-settings"/);
const settings = launcher.match(/<dialog id="launcher-settings"[\s\S]*?<\/dialog>/)?.[0];
assert.ok(settings);
for (const id of ['launch-options', 'memory-profile', 'runtime-log']) assert.ok(settings.includes('id="' + id + '"'));
assert.match(launcher, /document\.body\.dataset\.launcherState = 'game'/);
assert.match(launcher, /await globalThis\.mcWebAuthGate\.getSession\(\)/);
assert.match(siteCss, /min-height:\s*100dvh/);
assert.match(siteCss, /overflow-x:\s*hidden/);
assert.match(testingCss, /touch-action:\s*manipulation/);
assert.match(testingCss, /min-height:\s*44px/);
assert.match(testingCss, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
assert.match(testingCss, /max-height:\s*calc\(100dvh - 32px\)/);
assert.match(testingCss, /@media\s*\(max-width:\s*600px\)/);
assert.match(testingCss, /body\[data-launcher-state=game\] #mcweb-game-stage/);
assert.match(testingCss, /#game-canvas\s*\{[^}]*display:none/);
for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
  assert.ok(controls.includes('addEventListener("' + event + '"'), 'Touch controls must handle ' + event);
}
const manifest = JSON.parse(manifestText);
assert.equal(manifest.start_url, '/');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.orientation, undefined);
console.log('test-mobile-layout: pass');
