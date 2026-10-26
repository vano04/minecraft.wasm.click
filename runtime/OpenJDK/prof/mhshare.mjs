#!/usr/bin/env node
// Per busy thread of each window: its busy share, and the share of busy
// samples with a method-handle frame (LambdaForm, DirectMethodHandle,
// Invokers, VarHandle guards) on the stack -- the patterns the JIT runs as
// chains of framed calls.
//   node OpenJDK/prof/mhshare.mjs <outdir> [window-regex]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const [dir, winRe] = process.argv.slice(2);
const IDLE = /^\((idle|program)\)$|futex_wait|emscripten_futex|Atomics\.wait|thread_mailbox|cond_timedwait|cond_wait|__timedwait|_emscripten_yield/;
const MH = /LambdaForm\$|DirectMethodHandle|java\.lang\.invoke\.Invokers|VarHandleGuards|MethodHandleImpl|zwc_invoke_mh_basic/;
for (const w of readdirSync(dir).filter((d) => (!winRe || new RegExp(winRe).test(d)) && statSync(join(dir, d)).isDirectory()).sort()) {
  const rows = [];
  for (const f of readdirSync(join(dir, w)).filter((f) => f.endsWith(".cpuprofile"))) {
    const p = JSON.parse(readFileSync(join(dir, w, f), "utf8"));
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const memo = new Map();
    const hasMh = (id) => {
      if (id == null) return false;
      if (memo.has(id)) return memo.get(id);
      const r = MH.test(byId.get(id).callFrame.functionName || "") || hasMh(parent.get(id));
      memo.set(id, r);
      return r;
    };
    let busy = 0, mh = 0;
    for (const s of p.samples) {
      if (IDLE.test(byId.get(s).callFrame.functionName || "")) continue;
      busy++;
      if (hasMh(s)) mh++;
    }
    if (busy > p.samples.length * 0.2) rows.push([f, (100 * busy / p.samples.length).toFixed(0), (100 * mh / busy).toFixed(1)]);
  }
  console.log(w, rows.sort((a, b) => b[1] - a[1]).map((r) => `${r[0].replace(/\.cpuprofile$/, "")} busy ${r[1]}% mh ${r[2]}%`).join(" | "));
}
