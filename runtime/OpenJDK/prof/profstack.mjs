// profstack.mjs <dir> <secs> <leaf-regex> [depth]: caller chains of matching leaves, busiest thread
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [dir, secs, re, depthArg] = process.argv.slice(2);
const depth = Number(depthArg || 6);
const nm0 = (cf) => { const m = /^wasm-function\[(\d+)\]$/.exec(cf.functionName || ""); return m && Number(m[1]) <= 3 ? "<gen>" : (cf.functionName || "?"); };
const nm = (cf) => nm0(cf).replace(/\(.*$/, "").slice(0, 70);
let best = null;
for (const f of readdirSync(dir).filter(f => f.endsWith(".cpuprofile")).filter(f => !process.env.PF || f === process.env.PF)) {
  const p = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const byIdF = new Map(p.nodes.map(n => [n.id, n.callFrame.functionName]));
  const idle = new Set(["(idle)", "(program)", "_do_futex_wait", "emscripten_futex_wait", "(garbage collector)"]);
  p.busy = p.samples.filter(s => !idle.has(byIdF.get(s)) && !/^wasm-function\[([4-9]|\d\d)/.test(byIdF.get(s) || "")).length;
  if (!best || p.busy > best.busy) best = p;
}
const p = best, byId = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
let t = p.startTime; const times = p.timeDeltas.map(d => (t += d)); const from = times.at(-1) - Number(secs) * 1e6;
const chains = new Map(); let total = 0, hit = 0; const rx = new RegExp(re);
p.samples.forEach((s, i) => { if (times[i] < from) return; total++;
  const leaf = byId.get(s); if (!rx.test(nm(leaf.callFrame))) return; hit++;
  const parts = []; let id = s; for (let k = 0; k < depth && id != null; k++) { parts.push(nm(byId.get(id).callFrame)); id = parent.get(id); }
  const key = parts.join(" < "); chains.set(key, (chains.get(key) || 0) + 1); });
console.log(`matched ${hit}/${total} (${(100*hit/total).toFixed(1)}%)`);
for (const [k, c] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(((100 * c) / total).toFixed(1).padStart(5) + "% " + k);
