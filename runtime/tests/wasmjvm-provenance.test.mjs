import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  auditJarEntries, auditShaderText, authoredShadowClasses, findShaderFragments, isMojangOwnedLibrary,
  jarTools, licenseFiles, numericRuns, shaderFragments,
} from "../tools/wasmjvm-provenance.mjs";

test("Mojang ownership is decided by maven group, with the path as fallback", () => {
  assert.equal(isMojangOwnedLibrary({ name: "com.mojang:authlib:6.0.58" }), true);
  assert.equal(isMojangOwnedLibrary({ name: "com.mojang:brigadier:1.3.10" }), true);
  assert.equal(isMojangOwnedLibrary({ name: "net.minecraft:launchwrapper:1.12" }), true);
  assert.equal(isMojangOwnedLibrary({ name: "org.lwjgl:lwjgl:3.3.3" }), false);
  assert.equal(isMojangOwnedLibrary({ name: "com.mojangx:thing:1" }), false);
  assert.equal(isMojangOwnedLibrary({ name: null, relative: "com/mojang/jtracy/1.0.36/jtracy-1.0.36.jar" }), true);
  assert.equal(isMojangOwnedLibrary({ name: null, relative: "io/netty/netty-buffer/4.2.7/x.jar" }), false);
});

test("MC-Web's own shadows are recognised from source, and only those", () => {
  const shadows = authoredShadowClasses();
  assert.ok(shadows.has("com/mojang/text2speech/Narrator"));
  assert.ok(shadows.has("net/minecraft/client/sounds/SoundManager"));
  // Deleted shadows stop being recognised, so their classes would be flagged.
  assert.ok(!shadows.has("com/mojang/authlib/HttpAuthenticationService"));
  assert.ok(![...shadows].some((s) => s.startsWith("dev/")), "only Mojang namespaces are listed");

  const names = [
    "com/mojang/text2speech/Narrator.class",
    "com/mojang/text2speech/Narrator$1.class",
    "com/mojang/text2speech/NarratorX.class",       // not ours: prefix is not a stem
    "com/mojang/authlib/GameProfile.class",
    "net/minecraft/client/Minecraft.class",
    "dev/mcweb/graal/BrowserGpu.class",
    "assets/minecraft/textures/block/stone.png",
    "assets/mcweb/icon.png",
    "data/minecraft/recipe/stick.json",
    "version.json",
    "META-INF/MOJANGCS.SF",
    "META-INF/MANIFEST.MF",
    "sounds/ambient.ogg",
    "assets/",
  ];
  assert.deepEqual(auditJarEntries(names, { allowedShadows: shadows }).map((v) => v.entry), [
    "com/mojang/text2speech/NarratorX.class",
    "com/mojang/authlib/GameProfile.class",
    "net/minecraft/client/Minecraft.class",
    "assets/minecraft/textures/block/stone.png",
    "data/minecraft/recipe/stick.json",
    "version.json",
    "META-INF/MOJANGCS.SF",
    "sounds/ambient.ogg",
  ]);
  // A third-party jar gets no shadow allowance at all.
  assert.ok(auditJarEntries(["com/mojang/text2speech/Narrator.class"]).length === 1);
});

test("licence files are found wherever libraries put them", () => {
  assert.deepEqual(licenseFiles([
    "META-INF/LICENSE", "META-INF/LICENSE.txt", "LICENSE", "META-INF/NOTICE.md",
    "META-INF/versions/9/module-info.class", "META-INF/", "org/lwjgl/LICENSEKEY.class",
    "META-INF/licenses/", "META-INF/licenses/asm.txt",
  ]), ["META-INF/LICENSE", "META-INF/LICENSE.txt", "LICENSE", "META-INF/NOTICE.md"]);
});

// ------------------------------------------------------------ shader text
// A synthetic "client jar" with a synthetic shader. Every line of it is
// written for this test; none comes from the game.

const SYNTHETIC_SHADER = `#version 330

layout(std140) uniform TestBlock {
    mat4 TestViewMatrix;
    vec4 TestTint;
    vec2 TestWobble;
    float TestFade;
    int TestMode;
};

const vec3 TEST_PALETTE[3] = vec3[](vec3(0.137, 0.271, 0.913), vec3(0.5, 0.5, 0.5), vec3(1.0, 0.0, 0.0));

in vec2 testCoord;
out vec4 fragColor;

void main() {
    vec2 wobbled = testCoord + TestWobble * sin(testCoord.yx * 31.0);
    fragColor = vec4(TEST_PALETTE[TestMode].rgb * TestTint.rgb, TestFade);
}
`;

const EMPTY_ZIP = (() => {
  const empty = new Uint8Array(22);
  new DataView(empty.buffer).setUint32(0, 0x06054b50, true);
  return empty;
})();
const syntheticJar = () => jarTools().massageJar(EMPTY_ZIP, () => false, new Map(), new Map([
  ["assets/testpack/shaders/core/synthetic.fsh", new TextEncoder().encode(SYNTHETIC_SHADER)],
  ["assets/testpack/textures/not-a-shader.txt", new TextEncoder().encode("vec2 wobbled = testCoord + TestWobble * sin(testCoord.yx * 31.0);")],
  ["net/example/Thing.class", new TextEncoder().encode("not a shader")],
])).bytes;

const withBundle = async (files, body) => {
  const dir = mkdtempSync(join(tmpdir(), "mcweb-shader-audit-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// MC-Web-written host code of the kind the bundle legitimately ships.
const CLEAN_HOST = `const corner = [-1, -1, 3, -1, -1, 3];
function composite(pass) {
  // void main() { } and #version 330 are generic and never flag.
  pass.draw(3);
}
`;

test("shader-text audit: a served file with a line of the jar's shaders fails the build", async () => {
  const jar = syntheticJar();
  await withBundle({
    "webgpu-host.js": CLEAN_HOST
      // One line of the shader, reformatted: whitespace does not hide it.
      + "const port = `\n  vec2  wobbled = testCoord+TestWobble * sin( testCoord.yx * 31.0 );\n`;\n",
    "payload/manifest.json": "{}",
    "index.html": "<!doctype html><title>x</title>",
  }, async (dir) => {
    const audit = await auditShaderText(jar, dir);
    assert.equal(audit.shaderFiles, 1, "only assets/*/shaders/** is read");
    assert.equal(audit.scanned, 3);
    assert.equal(audit.violations.length, 1, audit.violations.join("\n"));
    assert.match(audit.violations[0],
      /^webgpu-host\.js: \[line\] .*TestWobble.*\(from assets\/testpack\/shaders\/core\/synthetic\.fsh\)$/);
  });
});

test("shader-text audit: MC-Web's own text passes", async () => {
  await withBundle({
    "webgpu-host.js": CLEAN_HOST,
    "shader-glue.js": "const glue = (src) => src.replace(/void main/, 'void _main');\n",
    "payload/manifest.json": JSON.stringify({ jars: [{ name: "a.jar" }] }),
  }, async (dir) => {
    const audit = await auditShaderText(syntheticJar(), dir);
    assert.deepEqual(audit.violations, []);
    assert.equal(audit.scanned, 3);
  });
});

test("shader-text audit: copied constant tables and restated uniform blocks fail in any syntax", () => {
  const fragments = shaderFragments({ "synthetic.fsh": SYNTHETIC_SHADER });
  // WGSL constructors, JS arrays: the same numbers in the same order.
  const wgsl = "const P = array<vec3<f32>, 3>(vec3<f32>(0.137, 0.271, 0.913), vec3<f32>(0.5,0.5,0.5), vec3<f32>(1.0,0.0,0.0));";
  assert.deepEqual(findShaderFragments(wgsl, fragments).map((f) => f.kind), ["numbers"]);
  assert.deepEqual(findShaderFragments("const p = [0.137, 0.271, 0.913, 0.5, 0.5, 0.5, 1, 0, 0];", fragments)
    .map((f) => f.kind), ["numbers"]);
  // A partial table is not the table; nor is the same table reordered.
  assert.deepEqual(findShaderFragments("const p = [0.137, 0.271, 0.913];", fragments), []);
  assert.deepEqual(findShaderFragments("const p = [0.271, 0.137, 0.913, 0.5, 0.5, 0.5, 1, 0, 0];", fragments), []);
  // The block restated member by member, WGSL style, with padding between.
  const struct = "struct T { TestViewMatrix: mat4x4<f32>, TestTint: vec4<f32>, _pad0: f32, TestWobble: vec2<f32>, TestFade: f32 }";
  assert.deepEqual(findShaderFragments(struct, fragments).map((f) => f.kind), ["members"]);
  // Naming three of them, or all of them in a sentence, is not a restated block.
  assert.deepEqual(findShaderFragments("bind(TestViewMatrix); bind(TestTint); bind(TestWobble);", fragments), []);
});

test("numeric runs: values compare by value and sign, separated by type names and punctuation", () => {
  assert.deepEqual(numericRuns("vec3(1.0, -0.5f, 2u) + x * 3"), [["1", "-0.5", "2"]]);
  assert.deepEqual(numericRuns("vec3<f32>(0x10, 1e1, .5)"), [["16", "10", "0.5"]]);
  assert.deepEqual(numericRuns("a = 1 - 2 - 3"), []);
  assert.deepEqual(numericRuns("f(1, 2) + g(3, 4)"), []);
});

test("shader-text audit: annotating, splitting or trimming a copy does not hide it", () => {
  // Test-written: a long table and a block, as a shader might hold them.
  const shader = `layout(std140) uniform TestBlock {
    mat4 TestViewMatrix;
    vec4 TestTint;
    vec2 TestWobble;
    float TestFade;
};
const float TEST_TABLE[12] = float[](0.0131, 0.0247, 0.0389, 0.0412, 0.0566, 0.0673,
    0.0718, 0.0829, 0.0934, 0.1047, 0.1151, 0.1263);
`;
  const fragments = shaderFragments({ "synthetic.fsh": shader });
  const kinds = (text) => findShaderFragments(text, fragments).map((f) => f.kind);
  // Rows annotated with comments, and a six-value slice of the table.
  assert.deepEqual(kinds("const t = [0.0131, 0.0247, 0.0389, // row 0\n 0.0412, 0.0566, 0.0673, // row 1\n];"), ["numbers"]);
  assert.deepEqual(kinds("const t = [0.0566, 0.0673, 0.0718, 0.0829, 0.0934, 0.1047];"), ["numbers"]);
  // Reported once per source table, not once per matching slice.
  assert.equal(findShaderFragments(`const t = [${"0.0131, 0.0247, 0.0389, 0.0412, 0.0566, 0.0673, 0.0718, 0.0829, 0.0934, 0.1047, 0.1151, 0.1263"}];`, fragments).length, 1);
  // The block restated with WGSL attributes, or with offsets in a comment.
  assert.deepEqual(kinds("struct T { @align(16) TestViewMatrix: mat4x4<f32>, @size(16) TestTint: vec4<f32>, TestWobble: vec2<f32>, TestFade: f32 }"), ["members"]);
  assert.deepEqual(kinds("// mat4 TestViewMatrix @0, vec4 TestTint @64, vec2 TestWobble @80, float TestFade @88"), ["members"]);
  assert.deepEqual(kinds("// TestViewMatrix\n// TestTint\n// TestWobble\n// TestFade\n"), ["members"]);
});

test("shader-text audit: tables any graphics code holds name no source", () => {
  const shader = `const vec2 QUAD[6] = vec2[](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1), vec2(1, 0), vec2(1, 1));
const vec2 STRIP[4] = vec2[](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(1, 1));
const mat4 ID = mat4(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
const vec3 FACE[4] = vec3[](vec3(0, 0, 0), vec3(1, 0, 0), vec3(1, 0, 1), vec3(0, 0, 1));
`;
  const fragments = shaderFragments({ "synthetic.vsh": shader });
  const own = `const quad = [0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]; const strip = [0, 0, 1, 0, 0, 1, 1, 1];
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; const w = [0.299, 0.587, 0.114];`;
  assert.deepEqual(findShaderFragments(own, fragments), []);
  // A 3-D corner table of the same length is not a quad, and still counts.
  assert.deepEqual(findShaderFragments("const f = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];", fragments)
    .map((f) => f.kind), ["numbers"]);
});
