// Optional real-server acceptance check. The fixture owner executes only the
// read-only console commands in the request files; the browser breaks the
// block through Minecraft's ordinary crosshair input.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const MAX_LOG_BYTES = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const validTarget = (target) => target
  && [target.x, target.y, target.z].every(Number.isInteger)
  && Math.abs(target.x) <= 30_000_000 && Math.abs(target.z) <= 30_000_000
  && Math.abs(target.y) <= 4096
  && /^(?:minecraft:)?[a-z0-9_./-]+$/.test(target.block || "")
  && !/^(?:minecraft:)?(?:air|cave_air|void_air)$/.test(target.block);
const sameTarget = (a, b) => validTarget(a) && validTarget(b)
  && a.x === b.x && a.y === b.y && a.z === b.z && a.block === b.block;
const validLook = (look) => look && Number.isFinite(look.yaw) && Number.isFinite(look.pitch);
const yawDelta = (a, b) => ((a - b + 180) % 360 + 360) % 360 - 180;
const sameLook = (a, b) => validLook(a) && validLook(b)
  && Math.abs(yawDelta(a.yaw, b.yaw)) <= 0.5 && Math.abs(a.pitch - b.pitch) <= 0.5;

/**
 * readTarget returns the latest {x,y,z,block,at} vanilla gameplay-state target,
 * or null for MISS/entities. The caller has already focused the game canvas
 * and must call this only with no open screen. This fixture uses the overworld.
 * The fixture owner watches <prefix>.before.json and <prefix>.after.json and
 * sends each request's commands, in order, to its owned native-server console.
 */
export async function confirmNativeBlockBreak({
  page, readTarget, getTarget, getLook, getScreen, requestPrefix, serverLog, canvas = "canvas", shot,
  timeoutMs = 30_000,
}) {
  readTarget ??= getTarget;
  if (!requestPrefix || !serverLog || typeof readTarget !== "function" || typeof getLook !== "function")
    throw new Error("native block check requires requestPrefix, serverLog, readTarget and getLook");
  const paths = { before: requestPrefix + ".before.json", after: requestPrefix + ".after.json" };
  if (Object.values(paths).some(existsSync)) throw new Error("block-check request paths must be fresh");
  const readLog = () => {
    if (statSync(serverLog).size > MAX_LOG_BYTES) throw new Error("block-check server log exceeds 1 MiB");
    return readFileSync(serverLog, "utf8");
  };
  readLog(); // Fail before sending input if the evidence source is unavailable.
  if (getScreen && await getScreen() !== "<none>") throw new Error("block check requires the game with no open screen");
  const box = await page.locator(canvas).boundingBox();
  if (!box) throw new Error("block-check canvas has no bounding box");
  const initialLook = getLook();
  if (!validLook(initialLook)) throw new Error("block check requires measured initial vanilla yaw/pitch");
  const cx = box.x + box.width / 2;
  let mouseY = box.y + box.height / 2;
  await page.mouse.move(cx, mouseY);
  let target = readTarget();
  // Find a natural terrain target using actual look input. No teleport, world
  // mutation, fabricated hit result or synthetic network packet is involved.
  for (let attempt = 0; !validTarget(target) && attempt < 12; attempt++) {
    mouseY += 24;
    await page.mouse.move(cx, mouseY);
    await sleep(500);
    target = readTarget();
  }
  if (!validTarget(target)) throw new Error("no natural non-air crosshair block for native confirmation");
  const blockLook = getLook();
  target = { x: target.x, y: target.y, z: target.z, block: target.block };
  const block = target.block.startsWith("minecraft:") ? target.block : "minecraft:" + target.block;
  const tag = "MCWEB_C3_" + randomUUID().replaceAll("-", "");
  const check = async (phase, expected) => {
    const from = readLog().length;
    const positiveTag = tag + "_" + phase.toUpperCase() + "_OK";
    const negativeTag = tag + "_" + phase.toUpperCase() + "_FAIL";
    const completionTag = tag + "_" + phase.toUpperCase() + "_DONE";
    const predicate = `block ${target.x} ${target.y} ${target.z} ${expected}`;
    const commands = [
      `execute in minecraft:overworld if ${predicate} run say ${positiveTag}`,
      `execute in minecraft:overworld unless ${predicate} run say ${negativeTag}`,
      `say ${completionTag}`,
    ];
    const requestedAt = Date.now();
    writeFileSync(paths[phase], JSON.stringify({ action: "check-block", phase,
      dimension: "minecraft:overworld", target, expected, positiveTag, negativeTag, completionTag,
      commands, at: requestedAt }) + "\n", { flag: "wx" });
    console.log(`block ${phase} confirmation requested: ${paths[phase]}`);
    while (Date.now() - requestedAt < timeoutMs) {
      const text = readLog();
      if (text.length < from) throw new Error("block-check server log was truncated or replaced");
      const lines = text.slice(from).split("\n");
      // Require the native console's say broadcast, not a logged input command
      // or a player's chat message that happens to contain the tag.
      const says = (value) => lines.find((line) => line.trimEnd().endsWith("[Server] " + value));
      const rejected = says(negativeTag);
      if (rejected) throw new Error(`native block ${phase} predicate failed: ${rejected.slice(0, 500)}`);
      const evidence = says(positiveTag);
      if (evidence && says(completionTag)) return { request: paths[phase], requestedAt, confirmedAt: Date.now(), evidence: evidence.slice(0, 500) };
      await sleep(100);
    }
    throw new Error(`timed out waiting for fresh native block ${phase} confirmation`);
  };
  if (shot) await shot("block-before");
  const before = await check("before", block);
  if (!sameTarget(target, readTarget())) throw new Error("crosshair target changed during native BEFORE confirmation");
  if (getScreen && await getScreen() !== "<none>") throw new Error("screen opened during native BEFORE confirmation");
  const attackedAt = Date.now();
  try {
    await page.mouse.down({ button: "left" });
    await sleep(150);
  } finally {
    await page.mouse.up({ button: "left" });
  }
  // Wait for Minecraft to process the input before asking the native server.
  // This client observation is only a readiness signal; AFTER still requires
  // the independent server predicate at the original coordinates.
  const settleUntil = Date.now() + 3000;
  while (sameTarget(target, readTarget()) && Date.now() < settleUntil) await sleep(100);
  if (sameTarget(target, readTarget())) throw new Error("client crosshair target did not change within 3 s of attack");
  const after = await check("after", "minecraft:air");
  if (shot) await shot("block-after");
  // Reverse the actual look-input displacement before ordinary flight. The
  // next flight focus click is at this same center, so it adds no extra turn.
  // Verify vanilla's measured angles rather than assuming mouse sensitivity
  // or assigning a synthetic player/camera orientation.
  const restoreAt = Date.now();
  await page.mouse.move(cx, box.y + box.height / 2);
  const lookedDown = mouseY !== box.y + box.height / 2;
  const restoreUntil = Date.now() + 5000;
  let restoredLook;
  while (Date.now() < restoreUntil) {
    restoredLook = getLook();
    if (sameLook(initialLook, restoredLook) && (!lookedDown || restoredLook.at >= restoreAt)) break;
    await sleep(100);
  }
  if (!sameLook(initialLook, restoredLook) || lookedDown && restoredLook.at < restoreAt)
    throw new Error("block check could not restore initial yaw/pitch through mouse input: "
      + JSON.stringify({ initialLook, blockLook, restoredLook }));
  return { target, dimension: "minecraft:overworld", before, attackedAt, after,
    look: { initial: initialLook, block: blockLook, restored: restoredLook, toleranceDegrees: 0.5 },
    input: "actual crosshair left mouse press/release" };
}
