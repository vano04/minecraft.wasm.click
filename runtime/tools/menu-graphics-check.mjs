// Measures Minecraft's own screens. No setting, resource-pack selection or
// render-distance change is made. The caller owns the browser and native capture.
import {performance} from "node:perf_hooks";
import {captureGraphicsResourceCensus} from "./graphics-pack-fixture.mjs";

export async function runMenuGraphicsCheck({page, phase, getScreen, getWidgets,
  clickWidget, framesNow, captureNative, getNativeInputSequence, awaitNativeInputReady,
  sampleMs = 3000, capturePrefix = ""}) {
  if (!["title", "world"].includes(phase) || !page || !getScreen || !getWidgets
      || !clickWidget || !framesNow || !captureNative
      || !getNativeInputSequence || !awaitNativeInputReady
      || !Number.isFinite(sampleMs) || sampleMs < 1000 || sampleMs > 30000)
    throw new Error("menu graphics check requires a phase, live game observations and native capture");
  const leaf = (screen) => String(screen).split(".").pop();
  const starting = phase === "title" ? "TitleScreen" : "<none>";
  const matches = (screen, expected) => (Array.isArray(expected) ? expected : [expected]).includes(screen);
  const evidence = {phase, measurement: "client-produced frames per wall-clock second, not on-glass FPS",
    sampleMs, screens: [], transitions: []};
  const startBrowserCadence = () => page.evaluate(() => {
    const key = "__mcWebMenuCadence";
    const prior = globalThis[key];
    if (prior?.id) cancelAnimationFrame(prior.id);
    const state = {times: [], id: 0};
    const tick = (time) => {
      state.times.push(time);
      state.id = requestAnimationFrame(tick);
    };
    state.id = requestAnimationFrame(tick);
    globalThis[key] = state;
  });
  const stopBrowserCadence = () => page.evaluate(() => {
    const key = "__mcWebMenuCadence";
    const state = globalThis[key];
    if (!state) throw new Error("menu RAF cadence window was not started");
    cancelAnimationFrame(state.id);
    delete globalThis[key];
    const values = state.times.slice(1).map((time, i) => time - state.times[i]);
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    const round = (value) => Math.round(value * 100) / 100;
    return {
      measurement: "browser requestAnimationFrame cadence on the native compositor; not client callback cost",
      samples: values.length,
      intervalMs: {
        mean: round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
        p50: round(at(0.50)), p95: round(at(0.95)), p99: round(at(0.99)),
        max: round(sorted.at(-1) ?? 0),
      },
      longFrames: {
        over33: values.filter((value) => value > 33).length,
        over50: values.filter((value) => value > 50).length,
        over100: values.filter((value) => value > 100).length,
      },
    };
  });
  const waitFor = async (expected) => {
    const deadline = performance.now() + 45000;
    let observedFrame = null;
    while (performance.now() < deadline) {
      const screen = leaf(await getScreen());
      if (matches(screen, expected)) {
        const frame = await framesNow();
        if (observedFrame === null) observedFrame = frame;
        else if (frame > observedFrame) return;
      } else observedFrame = null;
      if (/PackConfirmScreen$/.test(screen))
        throw new Error("unexpected pack confirmation during read-only menu check");
      await page.waitForTimeout(100);
    }
    throw new Error(`menu transition expected ${expected}, observed ${await getScreen()}`);
  };
  const sample = async (name, expected) => {
    await waitFor(expected);
    const nativeInputReady = await awaitNativeInputReady({
      screen: expected, afterSequence: getNativeInputSequence(),
    });
    const resourcesBefore = await captureGraphicsResourceCensus(page);
    await startBrowserCadence();
    let before, started, after, elapsedMs, frameStability;
    try {
      before = await framesNow();
      started = performance.now();
      await page.waitForTimeout(sampleMs);
      after = await framesNow();
      elapsedMs = performance.now() - started;
    } finally {
      frameStability = await stopBrowserCadence();
    }
    if (!matches(leaf(await getScreen()), expected)) throw new Error(`screen changed during ${name}`);
    if (!(after > before)) throw new Error(`no client-produced frames during ${name}`);
    if (frameStability.samples < 2) throw new Error(`browser frame cadence unavailable during ${name}`);
    const resourcesAfter = await captureGraphicsResourceCensus(page);
    const file = `${capturePrefix}menu-${phase}-${name}`;
    // Capture after the timing window. The browser compositor's own image is
    // required; no injected canvas markers or replacement UI are accepted.
    const png = await captureNative(file);
    if (!png?.byteLength) throw new Error(`native capture returned no bytes for ${file}`);
    evidence.screens.push({name, screen: await getScreen(), widgets: (await getWidgets()).map((w) => w.label),
      before, after, elapsedMs, producedFramesPerSecond: (after - before) * 1000 / elapsedMs,
      averageProducedFrameIntervalMs: elapsedMs / (after - before), frameStability,
      screenshot: file + ".png", resourcesBefore, resourcesAfter, nativeInputReady});
  };
  const transition = async (name, expected, action) => {
    const from = await getScreen(), before = await framesNow(), started = performance.now();
    const afterSequence = getNativeInputSequence();
    await action();
    await waitFor(expected);
    const screenObservedElapsedMs = performance.now() - started;
    const nativeInputReady = await awaitNativeInputReady({ screen: expected, afterSequence });
    const elapsedMs = performance.now() - started;
    evidence.transitions.push({name, from, to: await getScreen(), elapsedMs,
      inputToScreenObservedMs: screenObservedElapsedMs, inputToRenderReadyMs: elapsedMs,
      before, after: await framesNow(), screenObservedElapsedMs, nativeInputReady});
  };
  const options = () => clickWidget(["Options...", "Options…", "Options"]);
  const done = () => clickWidget(["Done"]);
  await waitFor(starting);
  let failure;
  try {
    await sample("start", starting);
    if (phase === "world") {
      await transition("pause", "PauseScreen", () => page.keyboard.press("Escape"));
      await sample("pause", "PauseScreen");
    }
    await transition("options", "OptionsScreen", options);
    await sample("options", "OptionsScreen");
    await transition("video", "VideoSettingsScreen", () => clickWidget(["Video Settings...", "Video Settings…", "Video Settings"]));
    await sample("video", "VideoSettingsScreen");
    await transition("video-back", "OptionsScreen", done);
    await transition("packs", "PackSelectionScreen", () => clickWidget(["Resource Packs...", "Resource Packs…", "Resource Packs"]));
    await sample("packs", "PackSelectionScreen");
    await transition("packs-back", "OptionsScreen", done);
    // This is a performance route, not a Done-button acceptance result. Keep
    // earlier failed Done-return evidence separately rather than retrying it.
    evidence.optionsReturnAction = "Escape; Options Done-button return is not exercised by this route";
    await transition("options-back-escape", phase === "world" ? "PauseScreen" : "TitleScreen",
      () => page.keyboard.press("Escape"));
    if (phase === "world") {
      await transition("resume", "<none>", () => page.keyboard.press("Escape"));
      const inventory = ["InventoryScreen", "CreativeModeInventoryScreen"];
      await transition("inventory", inventory, () => page.keyboard.press("KeyE"));
      await sample("inventory", inventory);
      await transition("inventory-back", "<none>", () => page.keyboard.press("KeyE"));
    }
    await sample("restored", starting);
    return evidence;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    evidence.failure = {message: failure.message, screen: await getScreen(), frame: await framesNow(),
      screenshot: `${capturePrefix}menu-${phase}-failure.png`};
    try {
      const png = await captureNative(`${capturePrefix}menu-${phase}-failure`);
      if (!png?.byteLength) throw new Error("failure capture returned no bytes");
    } catch (captureError) {
      evidence.failure.captureError = String(captureError);
    }
    failure.menuGraphicsEvidence = evidence;
    throw failure;
  } finally {
    try {
      for (let attempt = 0; attempt < 6 && leaf(await getScreen()) !== starting; attempt++) {
        if (/PackConfirmScreen$/.test(leaf(await getScreen())))
          throw new Error("refusing to dismiss unexpected pack confirmation");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
      }
      if (leaf(await getScreen()) !== starting) throw new Error("menu check did not restore its starting screen");
    } catch (cleanupError) {
      const combined = failure ? new AggregateError([failure, cleanupError], "menu check and restoration failed") : cleanupError;
      combined.menuGraphicsEvidence = evidence;
      throw combined;
    }
  }
}
