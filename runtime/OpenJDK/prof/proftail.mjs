// proftail.mjs <dir> <seconds>: self time over the last N seconds of the busiest Java thread
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [dir, secs] = [process.argv[2], Number(process.argv[3] || 10)];
let best = null;
for (const f of readdirSync(dir).filter(f => f.endsWith(".cpuprofile"))) {
  const p = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const byId = new Map(p.nodes.map(n => [n.id, n]));
  let t = p.startTime; const times = p.timeDeltas.map(d => (t += d));
  const end = times[times.length - 1], from = end - secs * 1e6;
  const counts = new Map(); let total = 0, busy = 0;
  p.samples.forEach((s, i) => { if (times[i] < from) return; total++;
    const cf = byId.get(s).callFrame, w = /^wasm-function\[(\d+)\]$/.exec(cf.functionName || ""); const n = w && Number(w[1]) <= 3 ? "<gen>" : (cf.functionName || "?"); if (!["(idle)","(program)","_do_futex_wait","emscripten_futex_wait","(garbage collector)"].includes(n) && !/^wasm-function\[/.test(n)) busy++;
    counts.set(n, (counts.get(n) || 0) + 1); });
  if (!best || busy > best.busy) best = { f, busy, total, counts };
}
console.log(best.f, "samples", best.total);
for (const [k, c] of [...best.counts].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(((100 * c) / best.total).toFixed(1).padStart(5) + "% " + k.slice(0, 130));
