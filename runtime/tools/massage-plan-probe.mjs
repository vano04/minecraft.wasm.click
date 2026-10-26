// Usage: node tools/massage-plan-probe.mjs <client.jar> [<client.jar> ...]
// Applies every massage-plan rule ON ITS OWN to each jar and prints OK or why
// it missed, so a new Minecraft version shows all mismatches at once instead
// of the first one prepareClientJar throws on. Give the known-good jar first
// as the control.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { MASSAGE_PLAN: plan } = await import(P + "/tools/wasmjvm-massage-plan.mjs");
const { jarTools } = await import(P + "/tools/wasmjvm-provenance.mjs");
const T = jarTools(P);
const jars = process.argv.slice(2);
const loaded = [];
for (const j of jars) loaded.push(new Uint8Array(await readFile(j)));
const cache = jars.map(() => new Map());
async function cls(i, name) {
  if (!cache[i].has(name)) cache[i].set(name, await T.readEntry(loaded[i], name));
  const b = cache[i].get(name);
  return b ? new Uint8Array(b) : null;
}
const rows = [];
async function check(label, entry, fn) {
  const res = [];
  for (let i = 0; i < jars.length; i++) {
    const b = await cls(i, entry);
    if (!b) { res.push("NO-CLASS"); continue; }
    try { res.push(fn(b)); } catch (e) { res.push("ERR " + e.message.replace(/^[^:]*: /, "").slice(0, 90)); }
  }
  rows.push([label, ...res]);
}
for (const r of plan.redirect) await check(`redirect ${r.entry.split("/").pop()} ${r.in || "*"}: ${r.name}`, r.entry,
  (b) => (T.redirectReferences(b, [r]).changed > 0 ? "OK" : "0 changed"));
for (const r of plan.intArg || []) await check(`intArg ${r.entry.split("/").pop()} ${r.in}`, r.entry,
  (b) => (T.patchIntArgs(b, [r]).changed > 0 ? "OK" : "0 changed"));
for (const r of plan.patchCode || []) await check(`patchCode ${r.entry.split("/").pop()} ${r.name}`, r.entry,
  (b) => (T.patchMethodCode(b, [r]).changed > 0 ? "OK" : "0 changed"));
for (const r of plan.stub || []) await check(`stub ${r.entry.split("/").pop()} ${r.name}`, r.entry,
  (b) => (T.stubMethods(b, [r]).changed > 0 ? "OK" : "MISS (no such method)"));
for (const w of plan.widen || []) await check(`widen ${w.entry.split("/").pop()} ${w.kind || "method"} ${w.name}`, w.entry,
  (b) => (T.widenMembers(b, [w]).changed > 0 ? "OK" : "MISS/already-public"));
for (const t of plan.targets || []) await check(`retarget ${t.split("/").pop()}`, t,
  (b) => { const r = T.retargetMethodOwners(b, plan.rules); return r.changed ? "OK " + r.changed : "0 changed"; });
console.log(`rules=${rows.length}  jars=${jars.map((j) => j.split("/").pop()).join(" | ")}`);
for (const r of rows) {
  const flag = r.slice(1).every((x) => String(x).startsWith("OK")) ? "  " : "!!";
  console.log(flag, r[0], " => ", r.slice(1).join("  |  "));
}
