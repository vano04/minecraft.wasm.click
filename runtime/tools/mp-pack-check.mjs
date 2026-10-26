// Optional original-pack acceptance through Minecraft's own confirmation and
// pause screens. The caller keeps the ordinary terrain/flight gate afterwards.
import { join } from "node:path";

export function createServerPackCheck({ page, canvas, out, getScreen, getWidgets, clickWidget, expectLabel }) {
  if (!expectLabel || expectLabel === "Disconnect" || expectLabel.length > 120 || /[\r\n\u0000-\u001f]/.test(expectLabel))
    throw new Error("pack check requires a unique original fixture label, different from Disconnect");
  if (!page || !canvas || !out || !getScreen || !getWidgets || !clickWidget)
    throw new Error("pack check requires the actual page, screen/widget observations and output path");
  const evidence = { expectedLabel: expectLabel };
  const shot = (name) => page.locator(canvas).screenshot({ path: join(out, name + ".png") });
  const wait = async (predicate, seconds, what) => {
    const until = Date.now() + seconds * 1000;
    let nextNote = Date.now() + 15_000;
    while (Date.now() < until) {
      if (await predicate()) return;
      if (Date.now() >= nextNote) {
        console.log(`pack: waiting for ${what}, screen=${await getScreen()}`);
        nextNote += 15_000;
      }
      await page.waitForTimeout(100);
    }
    throw new Error(`timed out waiting for ${what}, screen=${await getScreen()}`);
  };
  const isPrompt = (screen) => /(?:^|\$)PackConfirmScreen$/.test(screen);
  const handlePrompt = async () => {
    const screen = await getScreen();
    if (!isPrompt(screen)) return false;
    if (evidence.acceptedAt) throw new Error("unexpected additional server-pack confirmation");
    evidence.promptScreen = screen;
    evidence.promptAt = Date.now();
    await wait(() => getWidgets().some((widget) => ["Yes", "Proceed"].includes(widget.label)), 15, "native pack confirmation button");
    // Optional packs use Yes/No; required packs Proceed/Disconnect.
    // These are Mojang's buttons, not an alternate pack protocol.
    const button = getWidgets().find((widget) => ["Yes", "Proceed"].includes(widget.label));
    evidence.acceptedButton = button.label;
    await shot("pack-confirm");
    await clickWidget([button.label]);
    await wait(async () => !isPrompt(await getScreen()), 30, "pack confirmation to close");
    evidence.acceptedAt = Date.now();
    evidence.promptScreenshot = "pack-confirm.png";
    console.log(`pack: accepted native ${button.label} confirmation`);
    return true;
  };
  const confirmApplied = async () => {
    if (!evidence.acceptedAt) throw new Error("expected actual server-pack confirmation was not observed");
    if (await getScreen() !== "<none>") throw new Error("pack label check requires the active game");
    await page.keyboard.press("Escape");
    await wait(async () => (await getScreen()).split(".").pop() === "PauseScreen", 30, "native pause screen");
    try {
      await wait(() => getWidgets().some((widget) => widget.label === expectLabel), 120, "applied original pack label");
      await shot("pack-applied");
      evidence.appliedAt = Date.now();
      evidence.observedLabel = expectLabel;
      evidence.appliedScreenshot = "pack-applied.png";
      console.log("pack: applied label observed in native PauseScreen: " + expectLabel);
    } finally {
      await page.keyboard.press("Escape");
    }
    await wait(async () => await getScreen() === "<none>", 15, "return to game after pack check");
    return evidence;
  };
  return { handlePrompt, confirmApplied, evidence };
}
