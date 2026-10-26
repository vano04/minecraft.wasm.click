// web/shader-glue.js, rule by rule, on MC-Web-written GLSL shaped like the
// game's (GL 330, std140 blocks, combined samplers, a texel buffer, sampler
// parameters) - never Mojang's shader text (docs/SHADERS-PLAN.md). Each glued
// stage is also translated by the real translator when it is built.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const scope = {};
new Function("globalThis", readFileSync(join(ROOT, "web/shader-glue.js"), "utf8")).call(scope, scope);
const G = scope.mcWebShaderGlue;

const WASM = join(ROOT, "build/naga/nagamin.wasm");
const naga = existsSync(WASM) ? (() => {
  const { exports: x } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), {});
  return (source, stage) => {
    const bytes = new TextEncoder().encode(source);
    const p = x.alloc(bytes.length);
    new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
    const status = x.translate(p, bytes.length, stage === "vertex" ? 0 : 1);
    x.dealloc(p, bytes.length);
    return { status, text: new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len())) };
  };
})() : null;
const translates = (src, stage) => {
  if (!naga) return;
  const r = naga(src, stage);
  assert.equal(r.status, 0, `${stage} did not translate:\n${r.text}\n--- glued source ---\n${src}`);
  return r.text;
};

const SPEC = {
  bindGroups: [
    { uniforms: [{ name: "Frame", type: "UNIFORM_BUFFER", format: null }],
      samplers: ["Atlas", "Light"] },
    { uniforms: [{ name: "Bits", type: "TEXEL_BUFFER", format: "R8_SINT" },
      { name: "Unused", type: "UNIFORM_BUFFER", format: null }], samplers: [] },
  ],
};

// Shaped like the game's 26.3 stages: explicit locations on every interface
// variable, the separate-shader-objects extension, Vulkan's gl_VertexIndex.
const VS = `#version 330
#extension GL_ARB_separate_shader_objects : require
// a comment that mentions uniform sampler2D Fake; and must not match
layout(std140) uniform Frame { mat4 Proj; vec4 Tint; };
uniform sampler2D Light;
uniform isamplerBuffer Bits;
layout(location = 0) in vec3 Pos;
layout(location = 1) in vec2 Tex0;
layout(location = 2) in vec4 Shade;
layout(location = 3) in ivec2 Light2;
layout(location = 0) out vec2 uv;
layout(location = 1) out vec4 shade;
layout(location = 2) flat out int faceBits;
const vec3 OFFSETS[] = vec3[](vec3(0.0), vec3(1.0), vec3(2.0));
vec4 lit(sampler2D lightMap, ivec2 uv) { return texture(lightMap, vec2(uv) / 256.0); }
void main() {
    int corner = gl_VertexIndex % 3;
    gl_Position = Proj * vec4(Pos + OFFSETS[corner], 1.0);
    uv = Tex0;
    shade = Shade * lit(Light, Light2);
    faceBits = texelFetch(Bits, gl_VertexIndex).x;
}`;

const FS = `#version 330
#extension GL_ARB_separate_shader_objects : require
layout(std140) uniform Frame { mat4 Proj; vec4 Tint; };
uniform sampler2D Atlas;
layout(location = 0) in vec2 uv;
layout(location = 1) in vec4 shade;
layout(location = 2) flat in int faceBits;
layout(location = 0) out vec4 outColor;
void main() {
    vec4 c = texture(Atlas, uv) * shade * Tint;
    if (c.a < 0.1 || faceBits < 0) discard;
    outColor = c;
}`;

const ctxFor = (groups = []) => ({ layout: G.computeLayout(groups, 4), notes: [] });

test("layout: uniforms first, then two bindings per sampler, per group", () => {
  const l = G.computeLayout(SPEC.bindGroups, 4);
  assert.deepEqual([l.uniforms.get("Frame").g, l.uniforms.get("Frame").b], [0, 0]);
  assert.deepEqual([l.samplers.get("Atlas").g, l.samplers.get("Atlas").b], [0, 1]);
  assert.deepEqual([l.samplers.get("Light").g, l.samplers.get("Light").b], [0, 3]);
  assert.deepEqual([l.uniforms.get("Bits").g, l.uniforms.get("Bits").b], [1, 0]);
  // Folded into the last group when the device allows fewer groups.
  const folded = G.computeLayout(SPEC.bindGroups, 1);
  assert.equal(folded.K, 1);
  assert.deepEqual([folded.uniforms.get("Bits").g, folded.uniforms.get("Bits").b], [0, 1]);
  assert.ok(folded.samplers.get("Atlas").b >= 2, "samplers come after every merged uniform");
});

test("a pipeline's two stages glue and translate, keeping the shader's own locations", () => {
  const { vs, fs, notes } = G.gluePipeline(VS, FS, SPEC, 4);
  assert.match(vs, /^#version 450/);
  assert.match(vs, /#extension GL_ARB_separate_shader_objects/, "naga takes the extension line as it is");
  assert.doesNotMatch(vs, /Fake/, "comments are stripped before rewriting");
  assert.match(vs, /layout\(std140, set=0, binding=0\) uniform Frame/);
  assert.match(vs, /uniform sampler Light_mcs;.*uniform texture2D Light_mct;/);
  assert.match(vs, /readonly buffer Bits_buf/);
  assert.match(vs, /_mcweb_fetch_Bits\(\s*int\(gl_VertexIndex\)\)/);
  assert.match(vs, /OFFSETS\[3\]/, "unsized const array sized from its initialiser");
  assert.match(vs, /lit\(Light_mct, Light_mcs, Light2\)/, "sampler argument split at the call");
  assert.match(vs, /textureLod/, "vertex texture() samples level 0");
  for (const decl of ["layout(location = 3) in ivec2 Light2;", "layout(location = 2) flat out int faceBits;"]) {
    assert.ok(vs.includes(decl), `${decl} left as declared`);
  }
  assert.ok(fs.includes("layout(location = 0) out vec4 outColor;"));
  assert.ok(notes.some((n) => /texel buffer Bits/.test(n)), notes.join("\n"));
  translates(vs, "vertex");
  const wgsl = translates(fs, "fragment");
  if (wgsl) assert.match(wgsl, /@fragment/);
});

test("gl_VertexIndex is read as int, as the game's GLSL expects", () => {
  const ctx = ctxFor();
  const out = G.glue(`#version 330
layout(location = 0) out vec2 uv;
void main() {
    int corner = gl_VertexIndex & 3;
    uv = vec2(corner >> 1, corner & 1);
    gl_Position = vec4(uv, 0.0, 1.0);
}`, "vertex", ctx);
  assert.match(out, /int corner = int\(gl_VertexIndex\) & 3;/);
  assert.ok(ctx.notes.includes("gl_VertexIndex -> int"));
  assert.doesNotMatch(G.glue("#version 330\nvoid main() { gl_Position = vec4(0.0); }", "vertex", ctxFor()),
    /gl_VertexIndex/, "a stage that never reads it is unchanged");
  translates(out, "vertex");
});

test("a const int used as an array size is inlined there, up to its next declaration", () => {
  const ctx = ctxFor();
  const out = G.glue(`#version 330
#define LANES 8
layout(location = 0) out vec4 outColor;
float first() {
    const int n = LANES / 4;
    float a[n];
    for (int i = 0; i < n; i++) a[i] = float(i);
    return a[n - 1];
}
float second() {
    const int n = 3;
    float b[n];
    b[0] = 1.0;
    return b[0];
}
void main() { outColor = vec4(first(), second(), 0.0, 1.0); }`, "fragment", ctx);
  assert.match(out, /float a\[\(LANES \/ 4\)\];/);
  assert.match(out, /float b\[\(3\)\];/, "each size takes the declaration in scope before it");
  assert.match(out, /a\[n - 1\]/, "indexing is not an array size and keeps the name");
  assert.ok(ctx.notes.includes("const int n inlined as array size"));
  translates(out, "fragment");
});

test("a fragment output with no colour target becomes a private variable", () => {
  const FS2 = `#version 330
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 extra;
void main() { outColor = vec4(uv, 0.0, 1.0); extra = outColor; }`;
  const depthOnly = { bindGroups: [], colorTargets: [], depthStencil: { depthTest: "ALWAYS_PASS", writeDepth: true } };
  const { fs, notes } = G.gluePipeline(VS, FS2, { ...SPEC, ...depthOnly }, 4);
  assert.match(fs, /^vec4 outColor;$/m);
  assert.match(fs, /^vec4 extra;$/m);
  assert.ok(notes.includes("FS output outColor has no colour target"), notes.join("\n"));
  const wgsl = translates(fs, "fragment");
  if (wgsl) assert.doesNotMatch(wgsl, /FragmentOutput/, "the stage writes no colour output");
  // One target: only the output at location 1 is dropped. Without a spec
  // list (or with neither targets nor depth) every output stays.
  const one = G.gluePipeline(VS, FS2, { ...SPEC, colorTargets: [{ format: "RGBA8_UNORM" }] }, 4).fs;
  assert.ok(one.includes("layout(location = 0) out vec4 outColor;"));
  assert.match(one, /^vec4 extra;$/m);
  for (const spec of [SPEC, { ...SPEC, colorTargets: [] }]) {
    assert.ok(G.gluePipeline(VS, FS2, spec, 4).fs.includes("layout(location = 1) out vec4 extra;"));
  }
});

test("a block or sampler the layout lacks is parked, not dropped", () => {
  const ctx = ctxFor();
  const out = G.glue(`#version 330\nlayout(std140) uniform Extra { vec4 x; };\nuniform sampler2D Stray;\nlayout(location = 0) out vec4 outColor;\nvoid main(){ outColor = vec4(1.0); }`,
    "fragment", ctx);
  assert.match(out, /binding=64\) uniform Extra/);
  assert.ok(ctx.notes.includes("block Extra not in layout"));
  assert.ok(ctx.notes.includes("opaque Stray not in layout"));
  translates(out, "fragment");
});

test("what the glue cannot express is an error, not a silent rewrite", () => {
  const ctx = ctxFor();
  assert.throws(() => G.glue(`#version 330\nuniform sampler3D Volume;\nvoid main(){}`, "fragment", ctx), /sampler3D unsupported/);
  assert.throws(() => G.glue(`void main(){}`, "fragment", ctx), /no #version/);
});
