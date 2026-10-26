#!/usr/bin/env node
// Where does a busy JVM thread's time go, by Java method? For profiles taken
// with -XX:+ZeroWasmJITNames (JIT frames carry Java names).
//
//   node OpenJDK/prof/browser-attrib.mjs <outdir> <window-regex> [top=25] [thread-regex]
//
// Per window-matching busiest thread (merged across windows by target):
//  - self time of compiled Java methods (jit:...),
//  - overhead (zwc_invoke, the interpreter, frame builds, method handles, ...)
//    charged to the nearest compiled Java method below it on the stack, i.e.
//    the compiled caller that paid it, and
//  - inclusive time per compiled Java method.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const [dir, winRe, topArg, threadArg] = process.argv.slice(2);
const TOP = Number(topArg || 25);
const IDLE = /^\((idle|program)\)$|futex_wait|emscripten_futex|Atomics\.wait|thread_mailbox|cond_timedwait|cond_wait|__timedwait|_emscripten_yield/;
const name = (cf) => {
  const url = cf.url || "", fn = cf.functionName || "";
  if (/^(js-to-wasm|wasm-to-js)/.test(fn)) return fn;
  // Generated code is named after its Java method (package.Class.method, or
  // "frame> ..." for a framed helper); libjvm's own functions can come from a
  // wasm:// URL too (a --profiling-funcs build), and are not Java.
  if (/^wasm:\/\/wasm\/[0-9a-f]+$/.test(url)) {
    if (/^wasm-function\[/.test(fn)) return "jit:?";
    return /^(frame> )?[a-z][\w$]*(\.[\w$]+)+\.[\w$<>+]+( \[fl\])?$/.test(fn) ? "jit:" + fn : fn;
  }
  return fn || "(anon)";
};

const perThread = new Map();   // target -> {self, charged, incl, busy, total}
for (const w of readdirSync(dir).filter((d) => new RegExp(winRe).test(d) && statSync(join(dir, d)).isDirectory())) {
  for (const f of readdirSync(join(dir, w)).filter((f) => f.endsWith(".cpuprofile"))) {
    const p = JSON.parse(readFileSync(join(dir, w, f), "utf8"));
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const key = f.replace(/^worker-\d+-/, "").replace(/^page-\d+-/, "page-");
    const t = perThread.get(key) || { self: new Map(), charged: new Map(), incl: new Map(), busy: 0, total: 0 };
    perThread.set(key, t);
    for (const sid of p.samples || []) {
      t.total++;
      const leaf = name(byId.get(sid).callFrame);
      if (IDLE.test(leaf)) continue;
      t.busy++;
      t.self.set(leaf, (t.self.get(leaf) || 0) + 1);
      // Walk to the root: nearest compiled Java frame, and every distinct
      // compiled Java frame for inclusive time.
      let id = sid, nearest = null;
      const seen = new Set();
      while (id != null) {
        const nm = name(byId.get(id).callFrame);
        if (nm.startsWith("jit:")) {
          if (nearest == null && id !== sid) nearest = nm;
          if (!seen.has(nm)) { seen.add(nm); t.incl.set(nm, (t.incl.get(nm) || 0) + 1); }
        }
        id = parent.get(id);
      }
      if (!leaf.startsWith("jit:")) {
        const k = `${nearest || "(no compiled caller)"}  ->  ${leaf}`;
        t.charged.set(k, (t.charged.get(k) || 0) + 1);
      }
    }
  }
}

const pct = (c, t) => ((100 * c) / t).toFixed(1).padStart(5) + "%";
// A third argument picks threads by profile name (a regex), for a thread
// that is not among the two busiest.
const threadRe = threadArg ? new RegExp(threadArg) : null;
for (const [key, t] of [...perThread].filter(([k]) => !threadRe || threadRe.test(k))
    .sort((a, b) => b[1].busy - a[1].busy).slice(0, 2)) {
  if (t.busy < t.total * 0.2) continue;
  console.log(`\n##### ${key}: busy ${pct(t.busy, t.total)} of ${t.total} samples`);
  const jitSelf = [...t.self].filter(([k]) => k.startsWith("jit:")).reduce((a, [, c]) => a + c, 0);
  console.log(`compiled Java self time: ${pct(jitSelf, t.busy)} of busy`);
  console.log(`\n-- self time, compiled Java methods (share of busy)`);
  for (const [k, c] of [...t.self].filter(([k]) => k.startsWith("jit:")).sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`${pct(c, t.busy)}  ${k.slice(4, 130)}`);
  console.log(`\n-- overhead, charged to the nearest compiled caller (share of busy)`);
  for (const [k, c] of [...t.charged].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`${pct(c, t.busy)}  ${k.slice(0, 150)}`);
  console.log(`\n-- inclusive, compiled Java methods (share of busy)`);
  for (const [k, c] of [...t.incl].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`${pct(c, t.busy)}  ${k.slice(4, 130)}`);
}
