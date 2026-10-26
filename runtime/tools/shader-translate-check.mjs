#!/usr/bin/env node
// shader-translate-check - the node half of the shader checks (docs/SHADERS.md):
// prepare every pipeline in the local shader corpus exactly as the host does
// (shader-glue.js prepareTranslated: glue, translate, vertex buffers by the
// shader's input locations, bind-group layout entries), and report which
// fail and why. Validation on a real WebGPU device is the browser half.
//
//   java -cp <26.3 jar>:<libs> tools/shader-corpus/DumpShaderCorpus.java build/shader-corpus-26.3
//   tools/naga-wasm/build.sh
//   node tools/shader-translate-check.mjs [build/shader-corpus-26.3] [--out build/shader-wgsl] [--cap 4]
//
// Prints names, counts and translator messages, never shader text. --out
// writes the WGSL (derived from Mojang's shaders) and the host's layouts
// under build/, gitignored, for the browser check to load.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MC_VERSION } from "./mc-version.mjs";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : fallback; };
const corpus = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"))
  || join(ROOT, `build/shader-corpus-${MC_VERSION}`);
const out = opt("out", null);
const cap = Number(opt("cap", "4"));

const scope = {};
new Function("globalThis", readFileSync(join(ROOT, "web/shader-glue.js"), "utf8")).call(scope, scope);
const G = scope.mcWebShaderGlue;
// The host's own vertex-format table, so the check follows webgpu-host.js.
const HOST = readFileSync(join(ROOT, "web/webgpu-host.js"), "utf8");
const tableStart = HOST.indexOf("const VERTEX_GPU_FORMATS = ");
const VERTEX_GPU_FORMATS = new Function(`${HOST.slice(tableStart, HOST.indexOf("};", tableStart) + 2)} return VERTEX_GPU_FORMATS;`)();
const wasm = join(ROOT, "build/naga/nagamin.wasm");
if (!existsSync(wasm)) { console.error("build the translator first: tools/naga-wasm/build.sh"); process.exit(2); }
if (!existsSync(join(corpus, "pipelines.json"))) { console.error(`no corpus at ${corpus}: run tools/shader-corpus/DumpShaderCorpus.java`); process.exit(2); }
const { exports: x } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasm)), {});
const translate = (source, stage) => {
  const bytes = new TextEncoder().encode(source);
  const p = x.alloc(bytes.length);
  new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
  const status = x.translate(p, bytes.length, stage === "vertex" ? 0 : 1);
  x.dealloc(p, bytes.length);
  return { status, text: new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len())) };
};

const pipelines = JSON.parse(readFileSync(join(corpus, "pipelines.json"), "utf8"));
const text = (hash) => readFileSync(join(corpus, hash + ".glsl"), "utf8");
if (out) mkdirSync(out, { recursive: true });
let ok = 0;
const failures = [];
const notes = new Map();
const t0 = performance.now();
const results = [];
for (const p of pipelines) {
  const spec = { ...p, vertexSource: text(p.vertexSource), fragmentSource: text(p.fragmentSource) };
  const r = G.prepareTranslated(spec, translate, { cap, vertexTable: VERTEX_GPU_FORMATS });
  if (!r.ok) {
    failures.push(`${p.location}: ${r.stage}: ${r.message}`);
    continue;
  }
  for (const n of r.notes) {
    const key = n.replace(/\b[A-Z]\w+\b/g, "X");
    notes.set(key, (notes.get(key) || 0) + 1);
  }
  ok++;
  // buffers and entries are what the host builds the pipeline with.
  results.push({ location: p.location, vs: r.vs, fs: r.fs, vertexFormats: p.vertexFormats, bindGroups: p.bindGroups,
    buffers: r.buffers, entries: r.entries, colorTargets: p.colorTargets, depthStencil: p.depthStencil, topology: p.topology });
}
const ms = performance.now() - t0;
console.log(`translated ${ok}/${pipelines.length} pipelines in ${ms.toFixed(0)} ms (cap ${cap})`);
for (const f of failures) console.log("FAIL " + f);
console.log("glue rules applied: " + [...notes].map(([n, c]) => `${n} x${c}`).join("; "));
if (out) {
  writeFileSync(join(out, "wgsl.json"), JSON.stringify(results));
  console.log(`WGSL for ${results.length} pipelines -> ${join(out, "wgsl.json")} (derived; never commit)`);
}
process.exit(failures.length ? 1 : 0);
