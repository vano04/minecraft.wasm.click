// Where time goes under one frame, by kind: JIT bodies (framed, frameless),
// the call path (zwc_*), the interpreter, JS and other natives.
//   node OpenJDK/prof/subtree-cats.mjs <file.cpuprofile> <root-regex>
import { readFileSync } from "node:fs";
const [file, rootRe] = process.argv.slice(2);
const p = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const nm = (id) => byId.get(id).callFrame.functionName || "(anon)";
const re = new RegExp(rootRe);
const cnt = new Map(); for (const s of p.samples) cnt.set(s, (cnt.get(s) || 0) + 1);
const cat = {}; let tot = 0;
for (const [id, c] of cnt) {
  let ok = false; for (let x = id; x != null; x = parent.get(x)) if (re.test(nm(x))) { ok = true; break; }
  if (!ok) continue; tot += c;
  const f = nm(id);
  const k = /^(frame> )?[a-z][\w$]*(\.[\w$]+)+\.[\w$<>+]+( \[fl\])?$/.test(f) ? (f.startsWith("frame> ") ? "jit framed body" : f.endsWith("[fl]") ? "jit frameless body" : "jit body")
    : /^zwc_|cache_find|zwc_enter/.test(f) ? "call path (zwc_*)"
    : /BytecodeInterpreter|ZeroInterpreter|InterpreterRuntime|Interpreter/.test(f) ? "interpreter"
    : /^_?emscripten|^js|^\(/.test(f) ? "js/runtime" : "other native";
  cat[k] = (cat[k] || 0) + c;
  if (k === "other native") cat["  " + f] = (cat["  " + f] || 0) + c;
}
console.log(tot, "samples");
for (const [k, v] of Object.entries(cat).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log((100 * v / tot).toFixed(1).padStart(6) + "% " + k);
