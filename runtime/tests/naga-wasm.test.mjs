// The GLSL->WGSL translator the GPU worker loads (tools/naga-wasm), driven
// through its C ABI exactly as the worker will. MC-Web-written GLSL only: no
// Mojang shader text belongs in this repo (docs/SHADERS-PLAN.md).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WASM = join(fileURLToPath(new URL("..", import.meta.url)), "build/naga/nagamin.wasm");

function translator() {
  const { exports: x } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), {});
  return (source, stage) => {
    const bytes = new TextEncoder().encode(source);
    const p = x.alloc(bytes.length);
    new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
    const status = x.translate(p, bytes.length, stage);
    x.dealloc(p, bytes.length);
    const text = new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len()));
    return { status, text };
  };
}

const skip = !existsSync(WASM) && "build/naga/nagamin.wasm not built (tools/naga-wasm/build.sh)";

test("a vertex and a fragment stage translate to WGSL", { skip }, () => {
  const t = translator();
  const vs = t(`#version 450
layout(std140, set = 0, binding = 0) uniform Camera { mat4 ViewProj; vec4 Tint; };
layout(location = 0) in vec3 Pos;
layout(location = 1) in vec2 Uv;
layout(location = 0) out vec2 vUv;
void main() { vUv = Uv; gl_Position = ViewProj * vec4(Pos, 1.0); }`, 0);
  assert.equal(vs.status, 0, vs.text);
  assert.match(vs.text, /@vertex/);
  assert.match(vs.text, /@group\(0\) @binding\(0\)/);
  const fs = t(`#version 450
layout(set = 0, binding = 1) uniform texture2D Tex;
layout(set = 0, binding = 2) uniform sampler Smp;
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 color;
void main() { color = texture(sampler2D(Tex, Smp), vUv); if (color.a < 0.1) discard; }`, 1);
  assert.equal(fs.status, 0, fs.text);
  assert.match(fs.text, /@fragment/);
  assert.match(fs.text, /textureSample/);
});

test("errors come back as a message, not a trap", { skip }, () => {
  const t = translator();
  const bad = t(`#version 450\nvoid main() { undefined_thing = 1; }`, 1);
  assert.notEqual(bad.status, 0);
  assert.match(bad.text, /undefined_thing|Unknown variable/i);
});
