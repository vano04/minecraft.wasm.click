#!/usr/bin/env node
// Mojang's client jar with only the networking rules of the massage plan
// applied (docs/NET-MIGRATION.md, stage 3), for WebSocketLinkProbe on the host
// JVM: the full plan also routes Mojang's executors through port classes
// that need the page, so the probe runs Mojang's jar plus exactly these rules.
//
//   node OpenJDK/tests/net/stage3-jar.mjs <client.jar> <out.jar>
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MASSAGE_PLAN } from "../../../tools/wasmjvm-massage-plan.mjs";
import { jarTools } from "../../../tools/wasmjvm-provenance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: stage3-jar.mjs <client.jar> <out.jar>");
  process.exit(2);
}
const net = "dev/mcweb/graal/net/BrowserNet";
const plan = {
  targets: [], stub: [], patchCode: [], rules: [],
  redirect: MASSAGE_PLAN.redirect.filter((r) => r.newOwner === net && r.newName !== "refuseLanDetection"
    && r.newName !== "refuseTcpListener"),
  widen: MASSAGE_PLAN.widen.filter((w) => w.entry === "net/minecraft/server/network/EventLoopGroupHolder.class"),
  intArg: MASSAGE_PLAN.intArg,
};
const result = await jarTools(ROOT).prepareClientJar(new Uint8Array(await readFile(input)), plan);
if (result.missing.length) throw new Error("missing entries: " + result.missing.join(", "));
await writeFile(output, result.bytes);
console.log(`${output}: ${plan.redirect.length} redirects, ${plan.widen.length} widen, ${plan.intArg.length} intArg; `
  + `${result.patched.length} classes patched`);
