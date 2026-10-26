#!/usr/bin/env node
// A thread's self time by kind: compiled Java (bodies, framed helpers,
// frameless bodies), the call path (zwc_*), the interpreter, GPU RPC, JS.
//   node OpenJDK/prof/categories.mjs <outdir> <window-regex> <thread-regex> [top=25]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const [dir, winRe, thrRe, topArg] = process.argv.slice(2);
const TOP = Number(topArg || 25);
const tot = new Map(); let n = 0;
for (const w of readdirSync(dir).filter((d) => new RegExp(winRe).test(d) && statSync(join(dir, d)).isDirectory())) {
  for (const f of readdirSync(join(dir, w)).filter((f) => new RegExp(thrRe).test(f))) {
    const p = JSON.parse(readFileSync(join(dir, w, f), "utf8"));
    const byId = new Map(p.nodes.map((x) => [x.id, x]));
    for (const s of p.samples) {
      const fn = byId.get(s).callFrame.functionName || "(anon)";
      n++;
      const k = /^(frame> )?[a-z][\w$]*(\.[\w$]+)+\.[\w$<>+]+( \[fl\])?$/.test(fn)
        ? (fn.startsWith("frame>") ? "[JIT framed helper]" : fn.endsWith("[fl]") ? "[JIT frameless]" : "[JIT body]") : fn;
      tot.set(k, (tot.get(k) || 0) + 1);
    }
  }
}
for (const [k, v] of [...tot].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log((100 * v / n).toFixed(1).padStart(5) + "%", k.slice(0, 110));
