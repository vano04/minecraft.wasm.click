// profruns.mjs <file.cpuprofile> <stack-regex> <secs>: contiguous episodes of samples under a frame
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [file, re, secs] = process.argv.slice(2);
const nm0 = (cf) => { const m = /^wasm-function\[(\d+)\]$/.exec(cf.functionName || ""); return m && Number(m[1]) <= 3 ? "<gen>" : (cf.functionName || "?"); };
const nm = nm0;
const p = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const rx = new RegExp(re); const memo = new Map();
const has = (id) => { if (memo.has(id)) return memo.get(id); const r = rx.test(nm(byId.get(id).callFrame)) || (parent.has(id) && has(parent.get(id))); memo.set(id, r); return r; };
let t = p.startTime; const times = p.timeDeltas.map(d => (t += d)); const from = times.at(-1) - Number(secs) * 1e6;
let runs = [], cur = null;
p.samples.forEach((s, i) => { if (times[i] < from) return; if (has(s)) { if (!cur) cur = { start: times[i], n: 0 }; cur.n++; cur.end = times[i]; } else if (cur) { runs.push(cur); cur = null; } });
if (cur) runs.push(cur);
console.log("episodes", runs.length, "samples", runs.reduce((a, r) => a + r.n, 0));
for (const r of runs.slice(0, 40)) console.log(((r.start - from) / 1e3).toFixed(0).padStart(6) + "ms  dur " + ((r.end - r.start) / 1e3).toFixed(1) + "ms  n=" + r.n);
