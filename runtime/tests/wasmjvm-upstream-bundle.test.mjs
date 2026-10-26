// End-to-end check of `build-wasmjvm` packaging, without the wasm JVM and
// without Minecraft.
//
// The builder runs for real, in a scratch copy of the tools, against a
// synthetic launcher installation whose "Mojang" classes are compiled here by
// javac. The runtime files are placeholders: packaging only copies them. What
// is under test is the rule a published bundle has to keep - it serves no
// Mojang-owned bytes, and still tells the browser how to get every one of
// them - plus the audit that enforces it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MASSAGE_PLAN } from "../tools/wasmjvm-massage-plan.mjs";
import { MC_VERSION } from "../tools/mc-version.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const hasJavac = spawnSync("javac", ["-version"]).status === 0;
// The JDK whose javac is on PATH: the builder's port check runs its javac.
const pathJdk = (() => {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const javac = join(dir, "javac");
    if (existsSync(javac)) return dirname(dirname(realpathSync(javac)));
  }
  return null;
})();
const sha = (algorithm, data) => createHash(algorithm).update(data).digest("hex");

const loadScript = (path) => {
  const scope = {};
  new Function("globalThis", readFileSync(path, "utf8")).call(scope, scope);
  return scope;
};
const { mcWebJarMassage: zip } = loadScript(join(REPO, "OpenJDK/browser/jar-massage.js"));
const EMPTY_ZIP = (() => {
  const bytes = new Uint8Array(22);
  new DataView(bytes.buffer).setUint32(0, 0x06054b50, true);
  return bytes;
})();
/** A STORED jar from {name: bytes|string}, via the browser's own zip writer. */
const makeJar = (entries) => Buffer.from(zip.massageJar(EMPTY_ZIP, () => false, new Map(),
  new Map(Object.entries(entries).map(([k, v]) =>
    [k, typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v)]))).bytes);
const entriesOf = (path) => zip.listEntries(new Uint8Array(readFileSync(path)));

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** Compiles the handful of classes the massage plan patches. */
function compileClient(dir) {
  const sources = {
    "net/minecraft/client/Minecraft.java": `package net.minecraft.client;
      public class Minecraft {
        private static Minecraft instance; private boolean isLocalServer;
        private long lastTime; private Object pendingConnection;
        private void runTick(boolean b) { java.lang.management.ManagementFactory.getMemoryMXBean(); }
      }`,
    "net/minecraft/client/renderer/GameRenderer.java": `package net.minecraft.client.renderer;
      public class GameRenderer { private void tryTakeScreenshotIfNeeded() { System.out.println(1); } }`,
    "net/minecraft/SystemReport.java": `package net.minecraft;
      public class SystemReport { void f() { java.lang.management.ManagementFactory.getRuntimeMXBean(); } }`,
    "net/minecraft/client/gui/components/debug/DebugEntryMemory.java":
      `package net.minecraft.client.gui.components.debug;
      public class DebugEntryMemory { static class AllocationRateCalculator {
        void f() { java.lang.management.ManagementFactory.getGarbageCollectorMXBeans(); } } }`,
    "net/minecraft/client/gui/components/debug/DebugEntryDetailedMemory.java":
      `package net.minecraft.client.gui.components.debug;
      public class DebugEntryDetailedMemory {
        void f() { java.lang.management.ManagementFactory.getMemoryMXBean(); } }`,
  };
  const src = join(dir, "src");
  for (const [path, body] of Object.entries(sources)) write(join(src, path), body);
  const out = join(dir, "classes");
  execFileSync("javac", ["--release", "17", "-nowarn", "-d", out,
    ...Object.keys(sources).map((p) => join(src, p))], { stdio: "pipe" });
  const classes = {};
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, name.name);
      if (name.isDirectory()) walk(path);
      else classes[path.slice(out.length + 1).split("\\").join("/")] = readFileSync(path);
    }
  };
  walk(out);
  return classes;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mcweb-upstream-bundle-"));
  const project = join(root, "project");
  cpSync(join(REPO, "tools"), join(project, "tools"), { recursive: true });
  cpSync(join(REPO, "OpenJDK/browser"), join(project, "OpenJDK/browser"), { recursive: true });
  // The bundle takes MC-Web's host from web/, its only source.
  for (const name of ["webgpu-host.js", "render-command-stream.js", "webgpu-texture-lifetime.js",
    "mc-net.js", "audio-host.js", "shader-glue.js", "pack-http.js", "mobile-runtime.js",
    "mc-wisp-socket.js", "mc-wisp-worker.js", "aes-js.js", "aes-js.LICENSE.txt",
    "player-textures.mjs", "frame-backpressure.mjs", "vm-identity.mjs",
    "launch-display.js", "memory-profile.js", "memory-profile-worker.js",
    "game-controls.js", "game-controls.css"]) {
    cpSync(join(REPO, "web", name), join(project, "web", name));
  }
  // The shader translator the GPU worker loads, and its licence list.
  write(join(project, "build/naga/nagamin.wasm"), "placeholder translator\n");
  write(join(project, "build/naga/THIRD-PARTY.json"),
    JSON.stringify({ artifact: "nagamin.wasm", crates: [{ crate: "naga", version: "0", license: "MIT OR Apache-2.0" }] }));
  // The fake client has the classes the plan's first edits name, not the
  // sites its later rules count (redirect, intArg, patchCode, and the widened
  // server members), which would fail the massage by design. The fixture's
  // plan keeps the rest of the real one.
  const plan = {
    mobile: MASSAGE_PLAN.mobile,
    assetIndex: MASSAGE_PLAN.assetIndex,
    targets: MASSAGE_PLAN.targets,
    stub: MASSAGE_PLAN.stub,
    widen: MASSAGE_PLAN.widen.filter((w) => w.entry === "net/minecraft/client/Minecraft.class"),
    rules: MASSAGE_PLAN.rules,
  };
  write(join(project, "tools/wasmjvm-massage-plan.mjs"),
    `export const MASSAGE_PLAN = ${JSON.stringify(plan, null, 2)};\n`);
  // The builder compiles the port against the massaged jar. The real port
  // needs the real game, so the fixture's port is one class that uses what
  // the plan widens, plus the source of the ABI shadow the port jar below
  // carries (the audit keeps a Mojang-package class only if MC-Web wrote it).
  write(join(project, "src/graal/java/com/mojang/blaze3d/platform/Window.java"),
    `package com.mojang.blaze3d.platform;
    public class Window { public static class WindowInitFailed extends RuntimeException {} }`);
  write(join(project, "src/graal/java/dev/mcweb/graal/PortProbe.java"), `package dev.mcweb.graal;
    final class PortProbe {
      static boolean tick() {
        net.minecraft.client.Minecraft mc = net.minecraft.client.Minecraft.instance;
        mc.runTick(mc.isLocalServer);
        return mc.pendingConnection != null && mc.lastTime > 0;
      }
    }`);
  for (const part of ["shim-src", "boot-src", "jsbridge.c.shims.js", "gen-jsbridge.mjs"]) {
    cpSync(join(REPO, "OpenJDK/mcweb", part), join(project, "OpenJDK/mcweb", part), { recursive: true });
  }
  cpSync(join(REPO, "OpenJDK/build-mcweb.sh"), join(project, "OpenJDK/build-mcweb.sh"));

  // Placeholder runtime: packaging copies these and checks the baked inputs.
  const browser = join(project, "OpenJDK/browser");
  for (const name of ["javavm.wasm", "javavm.data", "libjvm.so"]) {
    write(join(browser, name), `placeholder ${name}\n`);
  }
  // The loader lists what javavm.data packs; the builder audits that list.
  write(join(browser, "javavm.js"), loaderListing(["/jdk/lib/modules", "/app/bridge/libmcwebjs.so"]));
  write(join(project, "OpenJDK/mcweb/libmcwebjs.so"), "placeholder bridge\n");
  const inputs = {};
  for (const [name, path] of Object.entries({
    "pre.js": join(browser, "pre.js"),
    "jsbridge.c.shims.js": join(project, "OpenJDK/mcweb/jsbridge.c.shims.js"),
    "libmcwebjs.so": join(project, "OpenJDK/mcweb/libmcwebjs.so"),
  })) inputs[name] = sha("sha256", readFileSync(path));
  write(join(browser, "runtime-manifest.json"),
    JSON.stringify({ schema: 1, linkedAt: "test", inputs }));

  const policy = makeJar({ "oshi/SystemInfo.class": "policy" });
  const policyName = `mcweb-native-policy-${sha("sha256", policy)}.jar`;
  write(join(project, "OpenJDK/native-policy/dist", policyName), policy);
  write(join(project, "OpenJDK/native-policy/current.json"), JSON.stringify({
    schema: 1, name: policyName, sha256: sha("sha256", policy), bytes: policy.length,
  }));

  // The port jar as build-mcweb.sh builds it: MC-Web's classes, one of its
  // ABI shadows in a Mojang package, and the SLF4J service file.
  write(join(project, "src/graal/resources/META-INF/services/org.slf4j.spi.SLF4JServiceProvider"), "x");
  writePortJar(project, {
    "dev/mcweb/graal/BrowserMinecraftMain.class": "port",
    "com/mojang/blaze3d/platform/Window.class": "shadow",
    "com/mojang/blaze3d/platform/Window$WindowInitFailed.class": "shadow",
    "META-INF/services/org.slf4j.spi.SLF4JServiceProvider": "x",
  });

  // A vanilla launcher layout.
  const mc = join(root, "minecraft");
  const client = makeJar({
    ...compileClient(join(root, "javac")),
    "assets/minecraft/textures/gui/title/background/panorama_0.png": "1x1",
    "assets/fixture/shaders/core/original.fsh": "#version 330\nvoid main() { fixtureShade = originalFixtureHue * originalFixtureLight; }\n",
    "version.json": "{}",
    "META-INF/MOJANGCS.SF": "sig", "META-INF/MOJANGCS.RSA": "sig",
  });
  write(join(mc, `versions/${MC_VERSION}/${MC_VERSION}.jar`), client);
  const bodies = {};
  const library = (name, relative, contents) => {
    const body = makeJar(contents);
    write(join(mc, "libraries", relative), body);
    bodies[name] = { relative, body };
    return {
      name,
      downloads: { artifact: {
        path: relative, url: `https://libraries.minecraft.net/${relative}`,
        sha1: sha("sha1", body), size: body.length,
      } },
    };
  };
  const libraries = [
    library("org.lwjgl:lwjgl:3.3.3", "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar",
      { "org/lwjgl/Version.class": "lwjgl", "META-INF/LICENSE": "BSD" }),
    library("com.mojang:authlib:6.0.58", "com/mojang/authlib/6.0.58/authlib-6.0.58.jar",
      { "com/mojang/authlib/GameProfile.class": "authlib" }),
    library("com.mojang:brigadier:1.3.10", "com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar",
      { "com/mojang/brigadier/CommandDispatcher.class": "brigadier" }),
  ];
  // Mojang's dedicated-server jar bundles Mojang's libraries
  // (META-INF/libraries.list); the page reads them out of it. The builder
  // finds it in its download cache.
  const bundled = ["com.mojang:authlib:6.0.58", "com.mojang:brigadier:1.3.10"];
  const server = makeJar({
    "META-INF/libraries.list": bundled.map((m) =>
      `${sha("sha256", bodies[m].body)}\t${m}\t${bodies[m].relative}`).join("\n") + "\n",
    ...Object.fromEntries(bundled.map((m) =>
      ["META-INF/libraries/" + bodies[m].relative, bodies[m].body])),
  });
  write(join(project, "build/mojang-cache/server", `server-${sha("sha1", server)}.jar`), server);
  write(join(mc, `versions/${MC_VERSION}/${MC_VERSION}.json`), JSON.stringify({
    id: MC_VERSION,
    downloads: {
      client: {
        url: `https://piston-data.mojang.com/v1/objects/${sha("sha1", client)}/client.jar`,
        sha1: sha("sha1", client), size: client.length,
      },
      server: {
        url: `https://piston-data.mojang.com/v1/objects/${sha("sha1", server)}/server.jar`,
        sha1: sha("sha1", server), size: server.length,
      },
    },
    libraries,
  }));
  const fx = { root, project, mc, client, server, plan };
  await recordPortBuild(fx);
  return fx;
}

/** A placeholder javavm.js whose file-packager listing names these paths. */
function loaderListing(paths) {
  return `loadPackage({ "files": [${paths.map((p) => `{ "filename": "${p}", "start": 0, "end": 1 }`).join(", ")}] });\n`;
}

function writePortJar(project, entries) {
  write(join(project, "OpenJDK/mcweb/mcweb-port.jar"), makeJar(entries));
}

/** The digest build-wasmjvm.mjs takes over the port's sources (treeHash). */
function portSourcesSha(project) {
  const hash = createHash("sha256");
  for (const root of [join(project, "src/graal/java"),
    join(project, "src/graal/resources/META-INF/services"),
    join(project, "OpenJDK/mcweb/boot-src"), join(project, "OpenJDK/mcweb/shim-src"),
    join(project, "OpenJDK/mcweb/gen-jsbridge.mjs"), join(project, "OpenJDK/build-mcweb.sh")]) {
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p);
      }
    };
    if (statSync(root).isFile()) files.push(root); else walk(root);
    for (const p of files.sort()) {
      hash.update(relative(project, p)).update("\0").update(readFileSync(p)).update("\0");
    }
  }
  return hash.digest("hex");
}

/**
 * What a full build leaves for --skip-build: the record that the port jar was
 * compiled from these sources against this exact massaged jar.
 */
function recordPortBuild(fx) {
  const massaged = zip.prepareClientJar(new Uint8Array(fx.client), fx.plan);
  return Promise.resolve(massaged).then((m) => write(join(fx.project, "OpenJDK/mcweb/port-build.json"),
    JSON.stringify({
      schema: 1,
      compileJarSha256: sha("sha256", m.bytes),
      planSha256: sha("sha256", JSON.stringify(fx.plan)),
      sourcesSha256: portSourcesSha(fx.project),
      portJarSha256: sha("sha256", readFileSync(join(fx.project, "OpenJDK/mcweb/mcweb-port.jar"))),
    })));
}

function build(fx, out, ...flags) {
  return spawnSync(process.execPath, [
    join(fx.project, "tools/build-wasmjvm.mjs"),
    "--mc-dir", fx.mc, "--skip-build", "--allow-unknown-jar", "--out", out, ...flags,
  ], { encoding: "utf8", env: {
    ...process.env, ...(pathJdk && !process.env.BOOT_JDK ? { BOOT_JDK: pathJdk } : {}),
  } });
}

test("a bundle serves no Mojang bytes and names every one it needs",
  { skip: !hasJavac && "javac is not installed" }, async (t) => {
    const fx = await fixture();
    t.after(() => rmSync(fx.root, { recursive: true, force: true }));
    const out = join(fx.root, "dist");
    const run = build(fx, out);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /provenance audit: clean/);
    assert.match(run.stdout, /runtime data: +2 files, JDK image and bridge only/);
    const bundleManifest = JSON.parse(readFileSync(join(out, "wasmjvm-manifest.json"), "utf8"));
    assert.equal(bundleManifest.mojangCodeCompiled, false);

    // The port compiles against the jar the builder massaged, which is exactly
    // what the tab runs: the plan's widened members are reachable.
    const massagedJar = join(fx.project, `build/massaged/minecraft-${MC_VERSION}-massaged.jar`);
    const compile = spawnSync("javac", ["-nowarn", "-d", join(fx.root, "probe"), "-cp", massagedJar,
      join(fx.project, "src/graal/java/dev/mcweb/graal/PortProbe.java")], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);

    const manifest = JSON.parse(readFileSync(join(out, "payload/manifest.json"), "utf8"));
    assert.deepEqual(manifest.jars.map((j) => [j.name, j.role]), [
      [JSON.parse(readFileSync(join(fx.project, "OpenJDK/native-policy/current.json"))).name,
        "native-policy"],
      ["mcweb-port.jar", "private-classpath"],
      [`minecraft-${MC_VERSION}-client.jar`, "mojang-client-upstream"],
      // Launcher order is kept: which class wins depends on it.
      ["lwjgl-3.3.3.jar", "private-classpath"],
      ["authlib-6.0.58.jar", "mojang-library-upstream"],
      ["brigadier-1.3.10.jar", "mojang-library-upstream"],
    ]);

    const served = readdirSync(join(out, "payload/jar")).sort();
    assert.deepEqual(served, [manifest.jars[0].name, "lwjgl-3.3.3.jar", "mcweb-port.jar"].sort());

    const authlib = manifest.jars.find((j) => j.name === "authlib-6.0.58.jar");
    const authlibBytes = readFileSync(join(fx.mc,
      "libraries/com/mojang/authlib/6.0.58/authlib-6.0.58.jar"));
    assert.equal(authlib.url,
      "https://libraries.minecraft.net/com/mojang/authlib/6.0.58/authlib-6.0.58.jar");
    assert.equal(authlib.sourceSha1, sha("sha1", authlibBytes));
    assert.equal(authlib.sha256, sha("sha256", authlibBytes));
    assert.equal(authlib.maven, "com.mojang:authlib:6.0.58");

    // The port jar keeps MC-Web's own classes, shadows included.
    const port = entriesOf(join(out, "payload/jar/mcweb-port.jar"));
    assert.ok(port.includes("com/mojang/blaze3d/platform/Window.class"));
    assert.ok(port.includes("com/mojang/blaze3d/platform/Window$WindowInitFailed.class"));
    assert.ok(port.includes("dev/mcweb/graal/BrowserMinecraftMain.class"));
    assert.ok(!port.some((e) => e.startsWith("assets/")), port.join(", "));
    assert.equal(manifest.jars[1].sha256,
      sha("sha256", readFileSync(join(out, "payload/jar/mcweb-port.jar"))));

    const thirdParty = JSON.parse(readFileSync(join(out, "THIRD-PARTY.json"), "utf8"));
    assert.deepEqual(thirdParty.libraries.map((l) => [l.maven, l.licenseFiles]),
      [["org.lwjgl:lwjgl:3.3.3", ["META-INF/LICENSE"]]]);
    assert.equal(thirdParty.wasm[0].artifact, "nagamin.wasm");
    assert.ok(existsSync(join(out, "nagamin.wasm")) && existsSync(join(out, "shader-glue.js")));
    const bundle = JSON.parse(readFileSync(join(out, "wasmjvm-manifest.json"), "utf8"));
    assert.equal(bundle.servesMojangContent, false);

    const page = readFileSync(join(out, "index.html"), "utf8");
    assert.ok(existsSync(join(out, "mojang-upstream.js")));
    assert.ok(page.indexOf("mojang-upstream.js") < page.indexOf("javavm.js"),
      "the resolver must be installed before the JVM loader runs");
    // The page script is generated from a template literal; make sure the
    // escaping survived by parsing it (new Function compiles, it does not run).
    const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    // The page script, and the test-only pointer-lock shim before the loader.
    assert.equal(inline.length, 2);
    for (const script of inline) assert.doesNotThrow(() => new Function(script));
    assert.ok(page.indexOf("mcweb_fakePointerLock") < page.indexOf("javavm.js"));

    // The standalone audit agrees, and catches what a careless deploy adds.
    const audit = (dir) => spawnSync(process.execPath,
      [join(fx.project, "tools/audit-wasmjvm-bundle.mjs"), dir,
        "--client-jar", join(fx.mc, `versions/${MC_VERSION}/${MC_VERSION}.jar`)], { encoding: "utf8" });
    const clean = audit(out);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    cpSync(join(fx.mc, "libraries/com/mojang/authlib/6.0.58/authlib-6.0.58.jar"),
      join(out, "payload/jar/authlib-6.0.58.jar"));
    write(join(out, "panorama_0.png"), "png");
    const dirty = audit(out);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /payload\/jar\/authlib-6\.0\.58\.jar: served but not in the manifest/);
    assert.match(dirty.stderr, /panorama_0\.png: game-content file type/);
  });

test("the page can source every no-CORS Mojang file from Mojang's server jar",
  { skip: !hasJavac && "javac is not installed" }, async (t) => {
    const fx = await fixture();
    t.after(() => rmSync(fx.root, { recursive: true, force: true }));
    const out = join(fx.root, "dist");
    const run = build(fx, out);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const manifest = JSON.parse(readFileSync(join(out, "payload/manifest.json"), "utf8"));

    // piston-data sends CORS and honours Range; the no-CORS hosts refuse.
    const serverUrl = JSON.parse(readFileSync(join(fx.mc, `versions/${MC_VERSION}/${MC_VERSION}.json`), "utf8"))
      .downloads.server.url;
    const mojang = async (url, init = {}) => {
      if (String(url) !== serverUrl) throw new TypeError("Failed to fetch");
      const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range || "");
      return range
        ? new Response(fx.server.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 })
        : new Response(fx.server);
    };
    const { mcWebUpstream } = loadScript(join(out, "mojang-upstream.js"));
    const resolver = mcWebUpstream.createResolver({ fetch: mojang });

    // What Install then does with each upstream entry: size, Mojang's SHA-1,
    // the manifest's SHA-256, and for the client the in-tab massage.
    for (const entry of manifest.jars.filter((j) => j.url)) {
      const bytes = entry.massagePlan
        ? new Uint8Array(fx.client)
        : (await resolver.resolve(entry.url, entry))?.bytes;
      assert.ok(bytes, `${entry.name}: no source`);
      assert.equal(bytes.byteLength, entry.sourceBytes, entry.name);
      assert.equal(sha("sha1", bytes), entry.sourceSha1, entry.name);
      const final = entry.massagePlan
        ? (await loadScript(join(out, "jar-massage.js")).mcWebJarMassage
          .prepareClientJar(bytes, entry.massagePlan)).bytes
        : bytes;
      assert.equal(sha("sha256", final), entry.sha256, entry.name);
    }
  });

test("the build refuses what a published bundle must not contain",
  { skip: !hasJavac && "javac is not installed" }, async (t) => {
    const fx = await fixture();
    t.after(() => rmSync(fx.root, { recursive: true, force: true }));

    // Retired lanes fail loudly instead of quietly building something else.
    for (const retired of [["--local-jar"], ["--upstream-client"], ["--cdn-relay", "https://relay.example"]]) {
      const run = build(fx, join(fx.root, "dist-retired"), ...retired);
      assert.notEqual(run.status, 0, retired.join(" "));
      assert.match(run.stderr, /unknown option/);
    }

    // A port jar carrying a Mojang asset is a regression, not something to strip.
    writePortJar(fx.project, {
      "dev/mcweb/graal/BrowserMinecraftMain.class": "port",
      "assets/minecraft/textures/gui/title/background/panorama_0.png": "MOJANG-PNG",
    });
    await recordPortBuild(fx);
    const dirty = build(fx, join(fx.root, "dist-dirty"));
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /port jar contains Mojang-owned entries/);

    // A port jar from other sources than these is refused under --skip-build.
    writePortJar(fx.project, { "dev/mcweb/graal/BrowserMinecraftMain.class": "port" });
    await recordPortBuild(fx);
    write(join(fx.project, "src/graal/java/dev/mcweb/graal/Edited.java"), "class Edited {}");
    const stale = build(fx, join(fx.root, "dist-stale"));
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /was not built from these sources/);
    rmSync(join(fx.project, "src/graal/java/dev/mcweb/graal/Edited.java"));

    // The builder's consolidated audit also applies the shader reference
    // rule to served host text, using this fixture's original synthetic GLSL.
    write(join(fx.project, "web/webgpu-host.js"),
      "const copied = 'void main() { fixtureShade = originalFixtureHue * originalFixtureLight; }';\n");
    const copiedShader = build(fx, join(fx.root, "dist-copied-shader"));
    assert.notEqual(copiedShader.status, 0);
    assert.match(copiedShader.stderr, /webgpu-host\.js: \[line\].*originalFixtureHue/);
    cpSync(join(REPO, "web/webgpu-host.js"), join(fx.project, "web/webgpu-host.js"));

    // An empty listing is refused before any runtime data is published too.
    write(join(fx.project, "OpenJDK/browser/javavm.js"), loaderListing([]));
    const emptyRuntime = build(fx, join(fx.root, "dist-empty-runtime"));
    assert.notEqual(emptyRuntime.status, 0);
    assert.match(emptyRuntime.stderr, /lists no packaged files/);
    assert.ok(!existsSync(join(fx.root, "dist-empty-runtime", "javavm.data")));

    // javavm.data may pack the JDK and the bridge, nothing else.
    write(join(fx.project, "OpenJDK/browser/javavm.js"),
      loaderListing(["/jdk/lib/modules", "/app/classes/Hello.class"]));
    const fixtures = build(fx, join(fx.root, "dist-fixtures"));
    assert.notEqual(fixtures.status, 0);
    assert.match(fixtures.stderr, /not the JDK or the bridge:\n +\/app\/classes\/Hello\.class/);
    assert.ok(!existsSync(join(fx.root, "dist-fixtures", "javavm.data")),
      "unsafe runtime must be refused before copying data into served output");
  });
