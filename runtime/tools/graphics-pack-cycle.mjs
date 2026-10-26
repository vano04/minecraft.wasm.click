import {performance} from "node:perf_hooks";
import {GRAPHICS_PACK_NAME, GRAPHICS_PACK_MARKER, readGraphicsPackSelection,
  graphicsPipelineRevision, captureGraphicsResourceCensus} from "./graphics-pack-fixture.mjs";
import {runMenuGraphicsCheck} from "./menu-graphics-check.mjs";

// Uses native Minecraft widgets/keyboard navigation. It never writes options,
// selects a pack through Java internals, creates a world, or accepts a dialog.
// Call in a freshly created/owned test world, with the fixture mounted pre-boot.
export async function runGraphicsPackCycle({page, getScreen, getWidgets, clickWidget,
  framesNow, captureNative, getNativeInputSequence, awaitNativeInputReady,
  timeoutMs = 60000, measureMenus = false, fixtureName = GRAPHICS_PACK_NAME,
  fixtureMarker = GRAPHICS_PACK_MARKER,
  fixtureScope = "original folder pack; not the unavailable user pack or server-pack HTTP transport"}) {
  const evidence = {fixture: fixtureName, phases: [], scope: fixtureScope};
  const screenIs = (screen, name) => name === "<none>" ? !screen || screen === "<none>" :
    typeof screen === "string" && (screen === name || screen.endsWith("." + name));
  async function until(description, predicate) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("native pack cycle timed out: " + description);
  }
  async function settledScreen(name, afterSequence = -1) {
    await until(name, async () => screenIs(await getScreen(), name));
    const frame = await framesNow();
    await until("fresh client frame on " + name, async () => (await framesNow()) > frame);
    if (!screenIs(await getScreen(), name)) throw new Error("screen changed after settling " + name);
    await awaitNativeInputReady({ screen: name, afterSequence });
  }
  async function click(labels, expected) {
    const afterSequence = getNativeInputSequence();
    await clickWidget(labels);
    await settledScreen(expected, afterSequence);
  }
  async function capture(name) {
    const bytes = await captureNative(name);
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("native capture did not return PNG bytes: " + name);
    return {name, bytes: bytes.length, screen: await getScreen()};
  }
  async function state() {
    const selection = await readGraphicsPackSelection(page);
    return {...selection, pipelineRevision: await graphicsPipelineRevision(page),
      resources: await captureGraphicsResourceCensus(page)};
  }
  async function changePack(enable) {
    await page.keyboard.press("Escape"); await settledScreen("PauseScreen");
    await click(["Options...", "Options…", "Options"], "OptionsScreen");
    await click(["Resource Packs...", "Resource Packs…", "Resource Packs"], "PackSelectionScreen");
    const widgets = await getWidgets();
    const search = widgets.find((widget) => widget.label === "EditBox");
    const lists = widgets.filter((widget) => widget.label === "TransferableSelectionList").sort((a, b) => a.x - b.x);
    if (!search || lists.length !== 2) throw new Error("unexpected native pack search/list widgets: " + JSON.stringify(widgets));
    await clickWidget(["EditBox"]);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(fixtureName);
    // Native init order is search -> available list -> selected list. With a
    // fresh profile the fixture is the sole searched result. ArrowDown moves
    // from the list heading onto that PackEntry; Enter invokes its real transfer.
    await page.keyboard.press("Tab");
    if (!enable) await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const listCapture = await capture(enable ? "pack-enable-selection" : "pack-disable-selection");
    await click(["Done"], "OptionsScreen");
    const selection = await until("native persisted pack selection " + enable, async () => {
      const value = await readGraphicsPackSelection(page);
      return value.selected.some((id) => id.includes(fixtureName)) === enable ? value : null;
    });
    await page.keyboard.press("Escape"); await settledScreen("PauseScreen");
    const markerPresent = fixtureMarker
      ? (await getWidgets()).some((widget) => widget.label === fixtureMarker) : null;
    if (fixtureMarker && markerPresent !== enable)
      throw new Error("native translated Pause widget does not match selected pack");
    const pauseCapture = await capture(enable ? "pack-enabled-pause" : "pack-disabled-pause");
    await page.keyboard.press("Escape"); await settledScreen("<none>");
    return {selection, markerPresent, listCapture, pauseCapture};
  }
  try {
    await settledScreen("<none>");
    const initial = await state();
    if (initial.selected.some((id) => id.includes(fixtureName)))
      throw new Error("pack cycle requires the fixture initially disabled in an owned fresh profile");
    evidence.phases.push({phase: "baseline", ...initial, capture: await capture("pack-baseline-world")});
    const enabled = await changePack(true);
    await until("real GPU pipeline creation after pack apply", async () =>
      (await graphicsPipelineRevision(page)) > initial.pipelineRevision);
    evidence.phases.push({phase: "enabled", ...enabled, ...await state(), capture: await capture("pack-enabled-world")});
    if (measureMenus) {
      evidence.enabledMenus = await runMenuGraphicsCheck({
        page, phase: "world", getScreen, getWidgets, clickWidget, framesNow, captureNative,
        getNativeInputSequence, awaitNativeInputReady,
        capturePrefix: "pack-enabled-",
      });
    }
    const beforeReload = await graphicsPipelineRevision(page);
    const reloadSequence = getNativeInputSequence();
    await page.keyboard.down("F3");
    try { await page.keyboard.press("t"); } finally { await page.keyboard.up("F3"); }
    await until("real GPU pipeline creation after native F3+T reload", async () =>
      (await graphicsPipelineRevision(page)) > beforeReload);
    await settledScreen("<none>", reloadSequence);
    await page.keyboard.press("Escape"); await settledScreen("PauseScreen");
    if (fixtureMarker && !(await getWidgets()).some((widget) => widget.label === fixtureMarker))
      throw new Error("native pack marker disappeared after F3+T reload");
    const reloadPause = await capture("pack-reloaded-pause");
    await page.keyboard.press("Escape"); await settledScreen("<none>");
    evidence.phases.push({phase: "reloaded", ...await state(), reloadPause,
      capture: await capture("pack-reloaded-world")});
    const disabled = await changePack(false);
    evidence.phases.push({phase: "disabled", ...disabled, ...await state(), capture: await capture("pack-disabled-world")});
    return evidence;
  } catch (error) {
    if (error.menuGraphicsEvidence) evidence.enabledMenus = error.menuGraphicsEvidence;
    try { evidence.failure = await capture("pack-cycle-failure"); }
    catch (captureError) { evidence.captureError = String(captureError); }
    error.graphicsPackEvidence = evidence;
    throw error;
  }
}
