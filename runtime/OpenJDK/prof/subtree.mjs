#!/usr/bin/env node
// Where the time goes under one part of a program: the samples of a
// .cpuprofile whose stack contains a frame matching <root-regex>, taken with
// -XX:+ZeroWasmJITNames (JIT frames carry Java names).
//
//   node OpenJDK/prof/subtree.mjs <file.cpuprofile> <root-regex> [top=40]
//
// Prints, as a share of those samples: self time per frame; non-Java leaves
// (zwc_invoke, the interpreter, ...) charged to the nearest compiled Java
// caller; and inclusive time per compiled Java method.
import { readFileSync } from "node:fs";

const [file, rootRe, topArg] = process.argv.slice(2);
const TOP = Number(topArg || 40);
const p = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const nm = (id) => byId.get(id).callFrame.functionName || "(anon)";
const isJit = (s) => /^(frame> )?[a-z][\w$]*(\.[\w$]+)+\.[\w$<>+]+( \[fl\])?$/.test(s);
const re = new RegExp(rootRe);
let n = 0;
const self = new Map(), pair = new Map(), incl = new Map();
const add = (m, k) => m.set(k, (m.get(k) || 0) + 1);
for (const sid of p.samples) {
  const chain = [];
  for (let id = sid; id != null; id = parent.get(id)) chain.push(nm(id));
  if (!chain.some((s) => re.test(s))) continue;
  n++;
  const leaf = chain[0];
  add(self, leaf);
  if (!isJit(leaf)) add(pair, (chain.slice(1).find(isJit) || "?") + "  ->  " + leaf);
  const seen = new Set();
  for (const s of chain) if (isJit(s) && !seen.has(s)) { seen.add(s); add(incl, s); }
}
const pc = (c) => ((100 * c) / n).toFixed(1).padStart(5) + "%";
const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, TOP);
console.log(`${n} samples under ${rootRe}`);
console.log("-- self");
for (const [k, c] of top(self)) console.log(pc(c), k.slice(0, 140));
console.log("-- non-JIT leaf, charged to nearest JIT caller");
for (const [k, c] of top(pair)) console.log(pc(c), k.slice(0, 170));
console.log("-- inclusive");
for (const [k, c] of top(incl)) console.log(pc(c), k.slice(0, 140));
