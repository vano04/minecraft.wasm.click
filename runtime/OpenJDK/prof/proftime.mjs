// proftime.mjs <file> <regex-anywhere-in-stack>: per-5s bucket share of samples whose stack contains a match
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [file, re] = process.argv.slice(2);
const nm0 = (cf) => { const m = /^wasm-function\[(\d+)\]$/.exec(cf.functionName || ""); return m && Number(m[1]) <= 3 ? "<gen>" : (cf.functionName || "?"); };
const nm = nm0;
const p = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const rx = new RegExp(re); const memo = new Map();
const has = (id) => { if (memo.has(id)) return memo.get(id); const n = byId.get(id); const r = rx.test(nm(n.callFrame)) || (parent.has(id) && has(parent.get(id))); memo.set(id, r); return r; };
let t = p.startTime; const times = p.timeDeltas.map(d => (t += d)); const b = new Map();
p.samples.forEach((s, i) => { const k = Math.floor((times[i] - p.startTime) / 5e6); const e = b.get(k) || [0, 0]; e[0]++; if (has(s)) e[1]++; b.set(k, e); });
for (const [k, [n, h]] of [...b].sort((a, c) => a[0] - c[0])) console.log(String(k * 5).padStart(4) + "s " + String(h).padStart(5) + "/" + n);
