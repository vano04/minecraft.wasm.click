// Where test Chrome draws: a private headless Weston on its own Wayland socket
// (tools/test-display.sh), never the desktop session. Every tool that launches
// a headed Chrome goes through launchTestChrome, so WebGPU gets the real GPU
// (Vulkan) without a window on the developer's screen and without an X server.
//
//   tools/test-display.sh            # start the private display (idempotent)
//   node tools/compare-lanes.mjs ... # then any tool picks it up
//
// A headless Weston has no pointer device, and Chrome crashes when a page
// requests pointer lock there (so does Xwayland when the grab ends). Game
// drivers therefore add testQuery() to the page URL: ?mcweb_fakePointerLock=1
// makes the page grant the lock itself (tools/build-wasmjvm.mjs playPage).
// MCWEB_WAYLAND names the socket (default "mcweb-weston"). If it is not up,
// the first launch starts it (tools/test-display.sh) and fails if it cannot.
// It never falls back to $DISPLAY: that is the developer's desktop session,
// where a test Chrome window lands on their screen. An X server is used only
// when named on purpose with MCWEB_TEST_X11 (e.g. MCWEB_TEST_X11=:99).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WAYLAND_SOCKET = process.env.MCWEB_WAYLAND || "mcweb-weston";

/** {env, args, query} for a headed test Chrome on the private display if it is up. */
export function testDisplay() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
  if (process.env.MCWEB_TEST_X11) {
    const env = { ...process.env, DISPLAY: process.env.MCWEB_TEST_X11 };
    delete env.WAYLAND_DISPLAY;
    return { env, args: [], query: "", where: `x11:${process.env.MCWEB_TEST_X11}` };
  }
  if (!existsSync(join(runtime, WAYLAND_SOCKET))) {
    const script = join(dirname(fileURLToPath(import.meta.url)), "test-display.sh");
    try {
      execFileSync("sh", [script], { stdio: ["ignore", "inherit", "inherit"] });
    } catch (failure) {
      throw new Error(`no test display: ${script} failed (${failure.message})`);
    }
  }
  if (existsSync(join(runtime, WAYLAND_SOCKET))) {
    const env = { ...process.env, WAYLAND_DISPLAY: WAYLAND_SOCKET, XDG_RUNTIME_DIR: runtime };
    delete env.DISPLAY;   // never the desktop's X server either
    return { env, args: ["--ozone-platform=wayland"], query: "mcweb_fakePointerLock=1",
      where: `wayland:${WAYLAND_SOCKET}` };
  }
  throw new Error(`no test display: wayland socket ${WAYLAND_SOCKET} missing after tools/test-display.sh`);
}

/** Query flags a game page needs on this display ("" or "mcweb_fakePointerLock=1"). */
export function testQuery() {
  return testDisplay().query;
}

/** Append testQuery() to a query string (without the "?"). */
export function withTestQuery(query) {
  const extra = testQuery();
  return extra && !query.includes(extra) ? (query ? query + "&" : "") + extra : query;
}

/**
 * chromium.launch with the test display added; same options otherwise. Test
 * tabs are muted: they run beside the developer's own work, and game audio
 * from an unattended run is only noise.
 */
export function launchTestChrome(chromium, options = {}) {
  const display = testDisplay();
  console.log(`test display: ${display.where}`);
  return chromium.launch({
    ...options,
    env: { ...display.env, ...(options.env || {}) },
    args: [...(options.args || []), ...display.args, "--mute-audio"],
  });
}
