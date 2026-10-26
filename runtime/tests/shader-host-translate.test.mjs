// The host half of the shader translate path (docs/SHADERS-PLAN.md S5),
// without a GPU: what web/webgpu-host.js gets from shader-glue.js's
// prepareTranslated (layout entries, sampler kinds, vertex buffers, the GL Y
// wrapper) and the binding agreement between the glue and the host's own
// remap, which ensureBindGroups binds by. MC-Web-written GLSL only. When the
// local corpus exists (build/shader-corpus-<version>, gitignored, never
// committed), every pipeline in it is also prepared; only names and counts
// are asserted.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MC_VERSION } from "../tools/mc-version.mjs";

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
const skip = !naga && "build/naga/nagamin.wasm not built (tools/naga-wasm/build.sh)";

// The host's own vertex-format table, read from webgpu-host.js so the test
// follows it; and its bind-group remap, evaluated as written there.
const HOST = readFileSync(join(ROOT, "web/webgpu-host.js"), "utf8");
const hostConst = (name, cap) => {
  const start = HOST.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `${name} not found in webgpu-host.js`);
  let depth = 0;
  let i = HOST.indexOf("{", start);
  for (; i < HOST.length; i++) {
    if (HOST[i] === "{") depth++;
    else if (HOST[i] === "}" && --depth === 0) break;
  }
  return new Function("GROUP_CAP", `${HOST.slice(start, i + 1)}; return ${name};`)(cap);
};
const VERTEX_GPU_FORMATS = hostConst("VERTEX_GPU_FORMATS");

// Element order differs from the shader's locations on purpose (the game's
// text and item formats do this), and buffer 1 is per instance.
const SPEC = {
  label: "test/pipeline",
  bindGroups: [
    { uniforms: [{ name: "Frame", type: "UNIFORM_BUFFER", format: null }], samplers: ["Atlas"] },
    { uniforms: [], samplers: ["Sky"] },
    { uniforms: [{ name: "Bits", type: "TEXEL_BUFFER", format: "R8_SINT" }], samplers: ["Resolved"] },
  ],
  vertexFormats: [{ stride: 28, stepRate: 0, elements: [
    { name: "Pos", offset: 0, format: "RGB32_FLOAT" },
    { name: "Shade", offset: 12, format: "RGBA8_UNORM" },
    { name: "Tex0", offset: 16, format: "RG32_FLOAT" },
    { name: "Light2", offset: 24, format: "RG16_SINT" },
  ] }, { stride: 16, stepRate: 1, elements: [
    { name: "Origin", offset: 0, format: "RGB32_SINT" },
    { name: "Fade", offset: 12, format: "R32_FLOAT" },
  ] }],
  vertexSource: `#version 330
#extension GL_ARB_separate_shader_objects : require
layout(std140) uniform Frame { mat4 Proj; vec4 Tint; };
uniform sampler2D Atlas;
uniform isamplerBuffer Bits;
layout(location = 0) in vec3 Pos;
layout(location = 1) in vec2 Tex0;
layout(location = 2) in vec4 Shade;
layout(location = 3) in ivec2 Light2;
#ifdef PER_INSTANCE
layout(location = 4) in ivec3 Origin;
layout(location = 5) in float Fade;
#endif
layout(location = 0) out vec2 uv;
layout(location = 1) out vec4 shade;
void main() {
    vec3 at = Pos;
#ifdef PER_INSTANCE
    at += vec3(Origin) * Fade;
#endif
    gl_Position = Proj * vec4(at, 1.0);
    uv = Tex0;
    shade = Shade * texture(Atlas, vec2(Light2) / 256.0) * float(texelFetch(Bits, gl_VertexIndex).x);
}`,
  fragmentSource: `#version 330
#extension GL_ARB_separate_shader_objects : require
layout(std140) uniform Frame { mat4 Proj; vec4 Tint; };
uniform sampler2D Atlas;
uniform samplerCube Sky;
uniform sampler2D Resolved;
layout(location = 0) in vec2 uv;
layout(location = 1) in vec4 shade;
layout(location = 0) out vec4 outColor;
void main() {
    float d = texelFetch(Resolved, ivec2(gl_FragCoord.xy), 0).r;
    outColor = texture(Atlas, uv) * shade * Tint + texture(Sky, vec3(uv, d));
}`,
};
const withInstance = (spec) => ({ ...spec,
  vertexSource: spec.vertexSource.replace(/^(#extension[^\n]*\n)/m, "$1#define PER_INSTANCE\n") });

const prepare = (spec, opts = {}) => G.prepareTranslated(spec, naga, { cap: 4, vertexTable: VERTEX_GPU_FORMATS, ...opts });

test("WGSL binding declarations and texture types", () => {
  const d = G.wgslBindings("@group(1) @binding(3)\nvar Sky_mct: texture_cube<f32>;\n@group(0) @binding(0)\nvar<uniform> global: Frame;\n");
  assert.deepEqual(d.get("1:3"), { space: "", name: "Sky_mct", type: "texture_cube<f32>" });
  assert.equal(d.get("0:0").space, "uniform");
  assert.deepEqual(G.textureBinding("texture_2d<f32>"), { sampleType: "float", viewDimension: "2d" });
  assert.deepEqual(G.textureBinding("texture_cube<f32>"), { sampleType: "float", viewDimension: "cube" });
  assert.deepEqual(G.textureBinding("texture_2d<i32>"), { sampleType: "sint", viewDimension: "2d" });
  assert.deepEqual(G.textureBinding("texture_depth_2d"), { sampleType: "depth", viewDimension: "2d" });
  assert.deepEqual(G.textureBinding("texture_2d_array<u32>"), { sampleType: "uint", viewDimension: "2d-array" });
  assert.equal(G.textureBinding("sampler"), null);
});

test("vertex formats: exact where the host's table reads past the element", () => {
  const T = VERTEX_GPU_FORMATS;
  assert.equal(G.vertexFormat({ name: "P", offset: 0, format: "RGB32_FLOAT" }, 12, T), "float32x3");
  assert.equal(G.vertexFormat({ name: "C", offset: 12, format: "RGBA8_UNORM" }, 16, T), T.RGBA8_UNORM.gpu);
  assert.equal(G.vertexFormat({ name: "N", offset: 0, format: "RGB8_SNORM" }, 4, T), "snorm8x4");
  assert.throws(() => G.vertexFormat({ name: "N", offset: 12, format: "RGB8_SNORM" }, 15, T), /no exact WebGPU format/);
  assert.throws(() => G.vertexFormat({ name: "X", offset: 0, format: "NOPE" }, 4, T), /no WebGPU mapping/);
});

test("vertex inputs come from the WGSL entry point, with naga's digit suffix undone", () => {
  const wgsl = "fn main_1() {}\n@vertex \nfn main(@location(0) Pos: vec3<f32>, @location(2) Tex0_: vec2<f32>, "
    + "@builtin(vertex_index) gl_VertexIndex: u32, @location(4) Origin: vec3<i32>) -> VertexOutput {\n}\n";
  assert.deepEqual(G.vertexInputs(wgsl), [{ location: 0, name: "Pos" }, { location: 2, name: "Tex0" },
    { location: 4, name: "Origin" }]);
  assert.deepEqual(G.vertexInputs("@fragment fn main() {}"), []);
});

test("vertex buffers: each consumed element at its input's location, in whichever buffer it lives", () => {
  const T = VERTEX_GPU_FORMATS;
  const inputs = [{ location: 0, name: "Pos" }, { location: 1, name: "Tex0" }, { location: 2, name: "Shade" },
    { location: 3, name: "Light2" }, { location: 4, name: "Origin" }, { location: 5, name: "Fade" }];
  const [b0, b1] = G.vertexBuffers(SPEC.vertexFormats, T, inputs);
  assert.deepEqual(b0.attributes.map((a) => [a.shaderLocation, a.offset, a.format]),
    [[0, 0, "float32x3"], [2, 12, "unorm8x4"], [1, 16, "float32x2"], [3, 24, "sint16x2"]]);
  assert.equal(b0.stepMode, "vertex");
  assert.deepEqual(b1.attributes.map((a) => [a.shaderLocation, a.offset, a.format]), [[4, 0, "sint32x3"], [5, 12, "float32"]]);
  assert.equal(b1.stepMode, "instance", "step rate 1 is per instance");
  // Elements the stage does not read get no attribute; unbound slots stay
  // null and trailing ones are dropped (the spec may pad to the slot count).
  const few = G.vertexBuffers([null, SPEC.vertexFormats[0], null, null], T, inputs.slice(0, 1));
  assert.equal(few.length, 2);
  assert.equal(few[0], null);
  assert.deepEqual(few[1].attributes.map((a) => a.shaderLocation), [0]);
  assert.throws(() => G.vertexBuffers(SPEC.vertexFormats.slice(0, 1), T, inputs), /input Origin \(location 4\) has no vertex element/);
  assert.throws(() => G.vertexBuffers([{ ...SPEC.vertexFormats[1], stepRate: 2 }], T, []), /step rate 2/);
});

test("textures read only texel by texel are told apart from filtered ones", () => {
  const wgsl = ["var A_mct: texture_2d<f32>;\nvar B_mct: texture_2d<f32>;\nvar C_mct: texture_2d<f32>;\n"
    + "let x = textureLoad(A_mct, p, 0i); let s = textureDimensions(A_mct);\n"
    + "let y = textureSample(B_mct, B_mcs, uv);\nlet z = helper(C_mct, C_mcs, uv);\n",
  "var B_mct: texture_2d<f32>;\nlet w = textureLoad(B_mct, p, 0i);\n"];
  assert.deepEqual([...G.loadOnlyTextures(wgsl)], ["A"], "a texture handed to a function counts as filtered");
});

test("GL Y wrapper negates clip Y after the shader's own main", () => {
  const out = G.negateClipY("#version 450\nvoid main() { gl_Position = vec4(1.0); }");
  assert.match(out, /void _mcweb_main\(\)/);
  assert.match(out, /void main\(\) \{ _mcweb_main\(\); gl_Position\.y = -gl_Position\.y; \}/);
  assert.throws(() => G.negateClipY("void f() {}"), /expected one main/);
});

test("text hash keys modules by content", () => {
  assert.equal(G.textHash("abc"), G.textHash("abc"));
  assert.notEqual(G.textHash("abc"), G.textHash("abd"));
  assert.match(G.textHash("abc"), /^[0-9a-f]{16}:3$/);
});

test("the glue's bindings are the host remap's, at every cap", () => {
  for (const cap of [1, 2, 3, 4, 8]) {
    const remapFn = hostConst("computeBindGroupRemap", cap);
    const { map, K } = remapFn(SPEC.bindGroups);
    const layout = G.computeLayout(SPEC.bindGroups, cap);
    assert.equal(layout.K, K, `cap ${cap}`);
    const mergedU = new Array(K).fill(0);
    SPEC.bindGroups.forEach((g, gi) => { mergedU[map[gi].ng] += g.uniforms.length; });
    SPEC.bindGroups.forEach((g, gi) => {
      g.uniforms.forEach((u, ui) => assert.deepEqual([layout.uniforms.get(u.name).g, layout.uniforms.get(u.name).b],
        [map[gi].ng, map[gi].baseU + ui], `cap ${cap} ${u.name}`));
      const base = Math.max(map[gi].baseS, mergedU[map[gi].ng]);
      g.samplers.forEach((s, si) => assert.deepEqual([layout.samplers.get(s).g, layout.samplers.get(s).b],
        [map[gi].ng, base + si * 2], `cap ${cap} ${s}`));
    });
  }
});

test("a pipeline prepares: layout entries typed from the translated shaders", { skip }, () => {
  const r = prepare(SPEC);
  assert.equal(r.ok, true, r.message);
  assert.match(r.vs, /@vertex/);
  assert.match(r.fs, /@fragment/);
  const all = r.entries.flat();
  assert.ok(all.every((e) => e.visibility === 3), "every binding visible to VERTEX|FRAGMENT");
  for (const group of r.entries) {
    const bindings = group.map((e) => e.binding);
    assert.equal(new Set(bindings).size, bindings.length, "bindings unique within a group");
  }
  const at = (name) => r.layout.samplers.get(name);
  const entry = (g, b) => r.entries[g].find((e) => e.binding === b);
  assert.deepEqual(entry(at("Sky").g, at("Sky").b + 1).texture, { sampleType: "float", viewDimension: "cube" });
  assert.deepEqual(entry(at("Atlas").g, at("Atlas").b + 1).texture, { sampleType: "float", viewDimension: "2d" });
  // Read texel by texel only: an unfilterable slot, which also takes depth
  // and 32-bit float targets.
  const resolved = at("Resolved");
  assert.deepEqual(entry(resolved.g, resolved.b + 1).texture, { sampleType: "unfilterable-float", viewDimension: "2d" });
  assert.deepEqual(entry(resolved.g, resolved.b).sampler, { type: "non-filtering" });
  assert.deepEqual(entry(at("Atlas").g, at("Atlas").b).sampler, { type: "filtering" });
  const bits = r.layout.uniforms.get("Bits");
  assert.deepEqual(entry(bits.g, bits.b).buffer, { type: "read-only-storage" });
  assert.deepEqual(r.samplerKinds.get("Resolved"), { nonFiltering: true, sampleType: "unfilterable-float", viewDimension: "2d" });
  assert.equal(r.samplerKinds.get("Sky").viewDimension, "cube");
  // Without PER_INSTANCE the stage reads nothing from buffer 1.
  assert.deepEqual(r.buffers.map((b) => b.attributes.map((a) => a.shaderLocation)), [[0, 2, 1, 3], []]);
  assert.deepEqual(prepare(withInstance(SPEC)).buffers[1].attributes.map((a) => a.shaderLocation), [4, 5]);
  // The GL Y policy is not optional: the vertex stage is always wrapped.
  assert.match(r.vs, /_mcweb_main/);
});

test("failures name the stage, first line only, so the host can log them", { skip }, () => {
  const glue = prepare({ ...SPEC, fragmentSource: "void main() {}" });
  assert.deepEqual([glue.ok, glue.stage], [false, "glue"]);
  const fs = prepare({ ...SPEC, fragmentSource: "#version 330\nout vec4 outColor;\nvoid main() { outColor = undefinedThing; }" });
  assert.deepEqual([fs.ok, fs.stage], [false, "fragment"]);
  assert.doesNotMatch(fs.message, /\n/);
  const fmt = prepare({ ...SPEC, vertexFormats: [{ stride: 15, elements: [{ name: "Pos", offset: 12, format: "RGB8_SNORM" }] }] });
  assert.deepEqual([fmt.ok, fmt.stage], [false, "vertex-format"]);
  const unfed = prepare(withInstance({ ...SPEC, vertexFormats: SPEC.vertexFormats.slice(0, 1) }));
  assert.deepEqual([unfed.ok, unfed.stage], [false, "vertex-format"]);
});

// The local corpus (tools/shader-corpus/DumpShaderCorpus.java), or another
// directory named by MCWEB_SHADER_CORPUS.
const CORPUS = process.env.MCWEB_SHADER_CORPUS || join(ROOT, `build/shader-corpus-${MC_VERSION}`);
const corpusSkip = skip || (!existsSync(join(CORPUS, "pipelines.json")) && "no local shader corpus (tools/shader-corpus)");
test("every pipeline in the local corpus prepares, at caps 4 and 8", { skip: corpusSkip }, () => {
  const pipelines = JSON.parse(readFileSync(join(CORPUS, "pipelines.json"), "utf8"));
  const text = (hash) => readFileSync(join(CORPUS, hash + ".glsl"), "utf8");
  for (const cap of [4, 8]) {
    const failures = [];
    for (const p of pipelines) {
      const spec = { ...p, label: p.location, vertexSource: text(p.vertexSource), fragmentSource: text(p.fragmentSource) };
      const r = G.prepareTranslated(spec, naga, { cap, vertexTable: VERTEX_GPU_FORMATS });
      if (!r.ok) { failures.push(`${p.location} ${r.stage}: ${r.message}`); continue; }
      for (const group of r.entries) {
        const b = group.map((e) => e.binding);
        if (new Set(b).size !== b.length) failures.push(`${p.location}: duplicate binding`);
      }
    }
    assert.deepEqual(failures, [], `cap ${cap}`);
  }
});

test("a failed pipeline paints its target once per pass, whatever the game draws", () => {
  const errorShaderDraw = hostConst("errorShaderDraw");
  const pass = () => ({ calls: [], draw(n) { this.calls.push(n); } });
  const a = { pipeline: {} };
  const b = { pipeline: {} };
  const first = { pass: pass(), pipeline: a };
  for (let i = 0; i < 1000; i++) errorShaderDraw(first);
  first.pipeline = b;
  errorShaderDraw(first);
  errorShaderDraw(first);
  assert.deepEqual(first.pass.calls, [3, 3], "one cover triangle per pipeline in a pass");
  const next = { pass: pass(), pipeline: a };
  errorShaderDraw(next);
  assert.deepEqual(next.pass.calls, [3], "a new pass paints again");
});

// A fullscreen depth copy: one colour target, and a fragment stage that
// writes gl_FragDepth, with depth state declared (always, writing).
const DEPTH_SPEC = {
  label: "test/depth-copy",
  bindGroups: [{ uniforms: [], samplers: ["Source"] }],
  vertexFormats: [],
  colorTargets: [{ format: "RGBA32_FLOAT", writeMask: 0 }],
  depthStencil: { depthTest: "ALWAYS_PASS", writeDepth: true, biasScale: 0, biasConstant: 0 },
  vertexSource: `#version 330
#extension GL_ARB_separate_shader_objects : require
layout(location = 0) out vec2 uv;
void main() {
    vec2 corner = vec2(float((gl_VertexIndex << 1) & 2), float(gl_VertexIndex & 2));
    gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
    uv = corner;
}`,
  fragmentSource: `#version 330
#extension GL_ARB_separate_shader_objects : require
uniform sampler2D Source;
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 outColor;
void main() {
    float d = texture(Source, uv).r;
    outColor = vec4(d);
    gl_FragDepth = d;
}`,
};

test("a fragment stage that writes depth is never built without depth state", { skip }, () => {
  const writesFragDepth = hostConst("wgslWritesFragDepth");
  const depthVariants = hostConst("pipelineDepthVariants");
  const r = prepare(DEPTH_SPEC);
  assert.equal(r.ok, true, r.message);
  assert.equal(writesFragDepth(r.fs), true, "naga's frag_depth output is seen");
  assert.equal(writesFragDepth(prepare(SPEC).fs), false);
  assert.match(HOST, /fragDepth: wgslWritesFragDepth\(prep\.fs\)/, "translatePipeline hands the flag to buildVariants");
  // buildPipeline's argument: undefined is the main target's depth32float,
  // null a pass with no depth attachment (no depth state at all).
  const resolved = (v) => (v === undefined ? "depth32float" : v);
  const withColour = depthVariants(DEPTH_SPEC, false, true);
  assert.deepEqual(withColour.map(resolved), ["depth32float"], "base on the main depth target, no no-depth variant");
  const noState = depthVariants({ ...DEPTH_SPEC, depthStencil: null }, false, true);
  assert.deepEqual(noState, ["depth32float"], "without declared depth, the synthesized never-write state");
  // Every other pipeline keeps the variants it had.
  assert.deepEqual(depthVariants(DEPTH_SPEC, false, false), [undefined, null]);
  assert.deepEqual(depthVariants(DEPTH_SPEC, true, false), [undefined]);
  assert.deepEqual(depthVariants(DEPTH_SPEC, true, true), [undefined]);
  assert.deepEqual(depthVariants({ ...DEPTH_SPEC, depthStencil: null }, false, false), [null, "depth32float"]);
  assert.deepEqual(depthVariants({ ...DEPTH_SPEC, depthStencil: null }, true, false), [null, "depth32float"]);
});
