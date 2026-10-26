#!/usr/bin/env node
// build-wasmjvm - build the browser bundle: MC-Web's page, MC-Web's port, the
// open-source libraries, and OpenJDK 25 (HotSpot Zero) compiled to wasm. No
// proprietary toolchain is involved.
//
//   node tools/build-wasmjvm.mjs                 # auto-detect an installation
//   node tools/build-wasmjvm.mjs --mc-dir ~/...  # point at one explicitly
//   node tools/build-wasmjvm.mjs --download      # fetch game files from Mojang
//   node tools/build-wasmjvm.mjs --dry-run       # resolve inputs, do not build
//   node tools/build-wasmjvm.mjs --skip-build    # repackage existing outputs
//
// The bundle carries nothing of Mojang's. The page fetches Mojang's client jar
// and libraries from Mojang, checks them against Mojang's SHA-1s, patches the
// jar in the tab (OpenJDK/browser/jar-massage.js running the data in
// tools/wasmjvm-massage-plan.mjs) and caches the result in OPFS; the player
// needs nothing but the browser. Mojang's code is never compiled.
//
// The installation this script reads supplies three things: the digests the
// page checks, the open-source libraries it serves, and the API MC-Web's port
// is compiled against. The port is compiled against exactly the jar the tab
// produces - this script runs the same massager over the same plan first - so
// a member the port needs and the plan does not provide is a compile error
// here, not an IllegalAccessError in the browser.
//
// Output: dist/wasmjvm/. Use the repository's Node server, which supplies
// the cross-origin isolation headers required by SharedArrayBuffer.
//
// The wasm JVM itself (javavm.js/.wasm/.data) holds no Mojang bytes: the JDK
// image and the @JS bridge only. It is built by OpenJDK/setup.sh +
// make-image.sh + link-browser.sh, and relinked only when the bridge changes.
import { MASSAGE_PLAN } from "./wasmjvm-massage-plan.mjs";
import { MC_CLIENT_SHA256, MC_VERSION } from "./mc-version.mjs";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInstallationResolver, exists, fileHash, run } from "./mc-installation.mjs";
import {
  auditBundle, auditJarEntries, auditRuntimePreloads, authoredShadowClasses, isMojangOwnedLibrary,
  jarTools, licenseFiles, MOJANG_HOST,
} from "./wasmjvm-provenance.mjs";

const VERSION = MC_VERSION;
const EXPECTED_CLIENT_SHA256 = MC_CLIENT_SHA256;
// fileURLToPath, not URL.pathname: a checkout under a path with spaces percent-encodes.
const PROJECT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNTIME_DIR = join(PROJECT, "OpenJDK", "browser");
// Mojang files the build reads or downloads (never packaged).
const CACHE_DIR = join(PROJECT, "build", "mojang-cache");

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
// Retired options (--local-jar, --upstream-client, --cdn-relay) must fail
// loudly rather than quietly build something else.
const KNOWN_FLAGS = new Set(["version", "mc-dir", "download", "cache-dir", "dry-run",
  "skip-build", "out", "allow-unknown-jar"]);
for (const arg of argv) {
  if (arg.startsWith("--") && !KNOWN_FLAGS.has(arg.slice(2))) {
    console.error(`build-wasmjvm: unknown option ${arg}`);
    process.exit(2);
  }
}

const version = flag("version", VERSION);
const dryRun = has("dry-run");
const skipBuild = has("skip-build");
const outDir = resolve(flag("out", join(PROJECT, "dist", "wasmjvm")));

const say = (...a) => console.log(...a);
const die = (msg) => { console.error(`\nbuild-wasmjvm: ${msg}`); process.exit(1); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const { locateInstallation, resolveLibraries, clientJarPath } =
  createInstallationResolver({ version, say, die, noAudio: true });




// ------------------------------------------------------------------- runtime
//
// The prebuilt wasm JVM. These files are Minecraft-free and player-independent:
// the JVM, its packaged JDK image, and the browser host that stands in for
// LWJGL. A player who already has them never rebuilds them.

// The loader instantiates its NEEDED shared libraries over HTTP before the
// packaged filesystem is mounted, so every .so must sit beside javavm.js as
// well as inside javavm.data. See OpenJDK/link-browser.sh.
const RUNTIME_FILES = [
  "javavm.js", "javavm.wasm", "javavm.data",
  "gpu-rpc-worker.js", "worker-env.js",
  "runtime-manifest.json", "jar-massage.js", "mojang-upstream.js",
];
// MC-Web's browser host, shared with the app lane. web/ is the only source:
// the copies link-browser.sh leaves in OpenJDK/browser are for its dev server
// and are not tracked, so a host-only edit reaches the bundle without a relink.
const HOST_DIR = join(PROJECT, "web");
const HOST_FILES = [
  "webgpu-host.js", "render-command-stream.js", "webgpu-texture-lifetime.js",
  "mc-net.js", "audio-host.js", "shader-glue.js", "pack-http.js", "mobile-runtime.js",
  "mc-wisp-socket.js", "mc-wisp-worker.js", "aes-js.js", "aes-js.LICENSE.txt",
  "player-textures.mjs", "frame-backpressure.mjs", "vm-identity.mjs",
  // The play page's own controls: launch resolution, the opt-in memory
  // profile, and touch/controller input with full screen (see the template).
  "launch-display.js", "memory-profile.js", "memory-profile-worker.js",
  "game-controls.js", "game-controls.css",
];
// The GLSL->WGSL translator the GPU worker loads (tools/naga-wasm/build.sh):
// the game's shaders are translated in the tab, from the player's jar, and
// never shipped (docs/SHADERS-PLAN.md). Its crate licences come with it.
const NAGA_DIR = join(PROJECT, "build", "naga");

/** [name, source path] for every runtime file the bundle ships. */
async function runtimeSet() {
  const names = await readdir(RUNTIME_DIR).catch(() => null);
  if (!names) die(`no wasm JVM runtime at ${RUNTIME_DIR}`);
  // The loose libraries are the JDK's (link-browser.sh copies them here). The
  // bridge is added from where build-mcweb.sh writes it, never from a stale
  // copy in this directory.
  const shared = names.filter((name) => name.endsWith(".so") && name !== "libmcwebjs.so");
  const missing = RUNTIME_FILES.filter((name) => !names.includes(name));
  if (missing.length || shared.length === 0) {
    die(`the wasm JVM runtime is incomplete in ${RUNTIME_DIR}\n`
      + `  missing: ${[...missing, ...(shared.length ? [] : ["*.so"])].join(", ")}\n`
      + `  Build it once with:\n`
      + `    OpenJDK/setup.sh && OpenJDK/make-image.sh && OpenJDK/link-browser.sh`);
  }
  for (const name of HOST_FILES) {
    if (!(await exists(join(HOST_DIR, name)))) die(`missing host file ${join(HOST_DIR, name)}`);
  }
  // System.load("/app/bridge/libmcwebjs.so") reads javavm.data, but the
  // loader also fetches the side module by its bare name beside javavm.js
  // (measured: without this copy the fetch 404s and the 9-byte error page is
  // "a truncated dynamic library"; Boot dies with UnsatisfiedLinkError).
  for (const name of ["nagamin.wasm", "THIRD-PARTY.json"]) {
    if (!(await exists(join(NAGA_DIR, name)))) die(`missing ${join(NAGA_DIR, name)} (run tools/naga-wasm/build.sh)`);
  }
  const bridge = join(PROJECT, "OpenJDK", "mcweb", "libmcwebjs.so");
  if (!(await exists(bridge))) die(`missing ${bridge} (run OpenJDK/build-mcweb.sh)`);
  return [
    ...[...RUNTIME_FILES, ...shared.sort()].map((name) => [name, join(RUNTIME_DIR, name)]),
    ["libmcwebjs.so", bridge],
    ["nagamin.wasm", join(NAGA_DIR, "nagamin.wasm")],
    ...HOST_FILES.map((name) => [name, join(HOST_DIR, name)]),
  ];
}

// ----------------------------------------------------------------------- main

const install = await locateInstallation({
  download: has("download"),
  cacheDir: flag("cache-dir", CACHE_DIR),
  mcDir: flag("mc-dir"),
});
say(`installation:   ${install.root}`);
say(`manifest:       ${install.manifest}`);

const { manifest, jars, records, missing } = await resolveLibraries(install);
if (missing.length) {
  die(`${missing.length} library jar(s) referenced by the manifest are not downloaded, e.g.\n`
    + `    ${missing.slice(0, 3).join("\n    ")}\n`
    + `  Launch ${version} once in your launcher so it fetches them, then re-run.`);
}
say(`libraries:      ${jars.length}`);

const clientJar = clientJarPath(install, manifest);
if (!(await exists(clientJar))) die(`client jar not found: ${clientJar}`);
const clientSha = await fileHash("sha256", clientJar);
say(`client jar:     ${clientJar}`);
say(`client sha256:  ${clientSha}${clientSha === EXPECTED_CLIENT_SHA256 ? `  (matches known ${VERSION})` : "  (UNRECOGNISED)"}`);
if (clientSha !== EXPECTED_CLIENT_SHA256 && !has("allow-unknown-jar")) {
  die(`this jar is not the ${VERSION} client this port was built against.\n`
    + `  The massage plan is version-specific and will almost certainly fail.\n`
    + `  Re-run with --allow-unknown-jar to try anyway.`);
}

// One flat directory of the classpath jars, so the build gets an explicit,
// ordered set rather than re-deriving it from launcher logs. One per version:
// a shared directory let a build for one version break the next build for
// another, which compiled against whatever was staged last.
const stagedLibs = join(PROJECT, "build", `wasmjvm-libraries-${version}`);
say(`\nstaging ${jars.length} libraries -> ${stagedLibs}`);
if (!dryRun) {
  await rm(stagedLibs, { recursive: true, force: true });
  await mkdir(stagedLibs, { recursive: true });
  for (const jar of jars) {
    const dest = join(stagedLibs, basename(jar));
    await symlink(jar, dest).catch(async () => { await copyFile(jar, dest); });
  }
}

if (dryRun) {
  say("\n--dry-run: inputs resolved, stopping before the build.");
  process.exit(0);
}

// ------------------------------------------------------------------- massage
//
// The jar the tab will run, produced by the tab's own massager over the plan
// the manifest carries. Its digest is pinned in the manifest (the page checks
// its own result against it), and it is what the port is compiled against.
const massagedJar = join(PROJECT, "build", "massaged", `minecraft-${version}-massaged.jar`);
const massaged = await massageJarLocally(await readFile(clientJar), MASSAGE_PLAN);
const massagedSha = sha256(massaged);
const planSha = sha256(JSON.stringify(MASSAGE_PLAN));
await mkdir(join(PROJECT, "build", "massaged"), { recursive: true });
await writeFile(massagedJar + ".tmp", massaged);
await rename(massagedJar + ".tmp", massagedJar);
say(`massaged jar:   ${massagedJar} (${massagedSha.slice(0, 16)}…)`);

// ------------------------------------------------------------------- compile
//
// Two steps, neither of which compiles anything of Mojang's:
//   1. build-mcweb.sh - MC-Web's port against the massaged jar's API, and the
//                       @JS -> JNI/EM_JS bridge generated from its sources
//   2. native-policy  - the OSHI/JNA shadow, kept first on the classpath

const portJar = join(PROJECT, "OpenJDK", "mcweb", "mcweb-port.jar");
const portBuild = join(PROJECT, "OpenJDK", "mcweb", "port-build.json");
// What the port jar and its bridge are built from: the sources, the one
// resource it packs, Boot and the annotation shims (both packed too), and the
// build script and bridge generator.
const PORT_SOURCES = [join(PROJECT, "src", "graal", "java"),
  join(PROJECT, "src", "graal", "resources", "META-INF", "services"),
  join(PROJECT, "OpenJDK", "mcweb", "boot-src"), join(PROJECT, "OpenJDK", "mcweb", "shim-src"),
  join(PROJECT, "OpenJDK", "mcweb", "gen-jsbridge.mjs"), join(PROJECT, "OpenJDK", "build-mcweb.sh")];
const buildEnv = {
  ...process.env,
  MCWEB_LIBRARIES_DIR: stagedLibs,
  MCWEB_COMPILE_JAR: massagedJar,
  MCWEB_COMPILE_JAR_SHA256: massagedSha,
  MCWEB_MASSAGE_PLAN_SHA256: planSha,
  MCWEB_OSHI_JAR: join(stagedLibs, "oshi-core-6.9.0.jar"),
};

if (skipBuild) {
  say("\n--skip-build: reusing the existing port jar and native policy");
  if (!(await exists(portJar)) || !(await exists(portBuild))) {
    die(`--skip-build, but ${portJar} or ${portBuild} does not exist`);
  }
} else {
  say(`\nbuilding the port and the @JS bridge\n  OpenJDK/build-mcweb.sh`);
  await run(join(PROJECT, "OpenJDK", "build-mcweb.sh"), [], { cwd: PROJECT, env: buildEnv })
    .catch(() => die(`the port does not compile against Mojang's jar as the tab patches it.\n`
      + `  Widen or redirect what it needs in tools/wasmjvm-massage-plan.mjs, or move the fix into port code.`));
  await writeFile(portBuild, JSON.stringify({
    schema: 1,
    compileJarSha256: massagedSha,
    planSha256: planSha,
    sourcesSha256: await treeHash(PORT_SOURCES),
    portJarSha256: await fileHash("sha256", portJar),
  }, null, 2) + "\n");

  say(`\nbuilding the native-policy support jar`);
  await run(join(PROJECT, "OpenJDK", "build-native-policy-support.sh"), [],
    { cwd: PROJECT, env: buildEnv });
}

// The port jar must have been compiled against this exact massaged jar, from
// these exact sources; a stale one would link against members the tab's jar
// does not have.
{
  const record = JSON.parse(await readFile(portBuild, "utf8"));
  if (record.schema !== 1 || record.compileJarSha256 !== massagedSha
      || record.planSha256 !== planSha || record.sourcesSha256 !== await treeHash(PORT_SOURCES)
      || record.portJarSha256 !== await fileHash("sha256", portJar)) {
    die(`${portJar} was not built from these sources against this massaged jar;\n`
      + `  rebuild without --skip-build.`);
  }
  say(`port jar:       compiled against the massaged jar`);
}

const runtime = await runtimeSet();
say(`runtime:        ${runtime.length} files from ${RUNTIME_DIR} and ${HOST_DIR}`);

// Everything that gets *baked into* the runtime is checked here. pre.js is
// inlined into javavm.js and libmcwebjs.so is packaged into javavm.data, so
// editing either one changes nothing until link-browser.sh runs again - and
// the browser would then fail at a stale native call or a stale loader rather
// than here. Emscripten reformats the inlined JS, so the bytes cannot be
// recovered from javavm.js; link-browser.sh records their hashes instead.
const runtimeManifestPath = join(RUNTIME_DIR, "runtime-manifest.json");
if (!(await exists(runtimeManifestPath))) {
  die(`the packaged runtime has no runtime-manifest.json.\n`
    + `  Relink it so its inputs are recorded:\n`
    + `    OpenJDK/link-browser.sh`);
}
const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
if (runtimeManifest.schema !== 1) die("unsupported runtime-manifest schema");
const bakedInputs = {
  "pre.js": join(RUNTIME_DIR, "pre.js"),
  "jsbridge.c.shims.js": join(PROJECT, "OpenJDK", "mcweb", "jsbridge.c.shims.js"),
  "libmcwebjs.so": join(PROJECT, "OpenJDK", "mcweb", "libmcwebjs.so"),
};
for (const [name, path] of Object.entries(bakedInputs)) {
  const recorded = runtimeManifest.inputs?.[name];
  if (!recorded) die(`runtime-manifest.json does not record ${name}`);
  if (!(await exists(path))) die(`missing runtime input ${path}`);
  const actual = await fileHash("sha256", path);
  if (actual !== recorded) {
    die(`${name} has changed since the wasm JVM was linked.\n`
      + `    now:    ${actual}\n`
      + `    linked: ${recorded}  (${runtimeManifest.linkedAt})\n`
      + `  It is baked into the runtime, so the runtime has to be relinked:\n`
      + `    OpenJDK/make-image.sh && OpenJDK/link-browser.sh`);
  }
}
say(`runtime inputs: verified against ${runtimeManifest.linkedAt}`);

// javavm.data is part of what the site serves, so it is audited like the
// payload: the JDK image and the bridge, and nothing else - no test classes,
// nothing compiled against Minecraft. The file packager lists every file it
// packed in javavm.js.
{
  const loader = await readFile(join(RUNTIME_DIR, "javavm.js"), "utf8");
  const audit = auditRuntimePreloads(loader);
  if (audit.violations.length) {
    die(audit.violations.join("\n") + "\n  Relink it: OpenJDK/make-image.sh && OpenJDK/link-browser.sh");
  }
  say(`runtime data:   ${audit.files} files, JDK image and bridge only`);
}

// ----------------------------------------------------------------- packaging

// The classpath the browser will use, in order. The native-policy jar is first
// so its oshi.SystemInfo shadow wins over the private port, real OSHI and JNA;
// the port jar precedes the client jar so its classes win over Mojang's.
const policyPointer = JSON.parse(
  await readFile(join(PROJECT, "OpenJDK", "native-policy", "current.json"), "utf8"));
if (policyPointer.schema !== 1
    || !/^mcweb-native-policy-[0-9a-f]{64}\.jar$/.test(policyPointer.name)
    || policyPointer.name !== `mcweb-native-policy-${policyPointer.sha256}.jar`) {
  die("invalid native-policy pointer: OpenJDK/native-policy/current.json");
}
const policyJar = join(PROJECT, "OpenJDK", "native-policy", "dist", policyPointer.name);

// Minecraft is not in the bundle at all. The page fetches Mojang's own client
// jar from Mojang's CDN (which is the one host in this set that sends CORS
// headers), verifies it against the SHA-1 Mojang publishes, and massages it in
// the tab.
let upstream = null;
{
  const versionMeta = JSON.parse(await readFile(install.manifest, "utf8"));
  const client = versionMeta.downloads?.client;
  if (!client?.url || !client?.sha1) {
    die(`${install.manifest} has no downloads.client url/sha1 to fetch from`);
  }
  upstream = { url: client.url, sha1: client.sha1, bytes: client.size };
  say(`upstream client:  ${upstream.url}`);
}

// Mojang's own libraries go the way the client jar goes: named in the
// manifest with Mojang's URL and SHA-1, fetched by the browser, never served.
// Only third-party open-source libraries stay in payload/jar, and those the
// site may redistribute. Each library keeps its place in the classpath:
// order decides which class wins.
const libraryJar = (r) => isMojangOwnedLibrary(r)
  ? { path: r.file, role: "mojang-library-upstream", maven: r.name, library: r }
  : { path: r.file, role: "private-classpath", maven: r.name };
// Mojang's libraries live on libraries.minecraft.net, which sends no CORS
// headers, so a page cannot download them. Most of them are also inside
// Mojang's dedicated-server jar, which piston-data.mojang.com serves with
// CORS; the page reads them out of it with range requests (mojang-upstream.js)
// and checks each against the SHA-1 Mojang publishes for it. The rest are
// replaced by MC-Web's own stand-ins in the port (src/graal/java/com/mojang):
// the client needs only an interface from each.
const STAND_IN_LIBRARIES = new Set([
  "com.mojang:text2speech",   // com.mojang.text2speech.Narrator: a silent narrator
  "com.mojang:blocklist",     // com.mojang.blocklist.BlockListSupplier: no provider
  "com.mojang:patchy",        // the blocklist provider; nothing else calls it
]);
const artifactOf = (maven) => String(maven || "").split(":").slice(0, 2).join(":");
const serverLibraries = await loadServerLibraryList();
const payloadJars = [
  { path: policyJar, role: "native-policy" },
  { path: portJar, role: "private-classpath" },
  ...records.map(libraryJar)
    .filter((jar) => !(jar.library && STAND_IN_LIBRARIES.has(artifactOf(jar.maven)))),
];
{
  const mojang = payloadJars.filter((j) => j.library);
  say(`mojang libraries: ${mojang.length} fetched upstream `
    + `(${mojang.map((j) => j.maven ?? basename(j.path)).join(", ") || "none"})`);
}
const seen = new Set();
for (const jar of payloadJars) {
  const name = basename(jar.path);
  if (!/^[A-Za-z0-9._-]+\.jar$/.test(name)) die(`unsafe payload jar name: ${name}`);
  if (seen.has(name)) die(`duplicate payload jar name: ${name}`);
  seen.add(name);
  if (!(await exists(jar.path))) die(`payload jar missing: ${jar.path}`);
}

say(`\npackaging -> ${outDir}`);
await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, "payload", "jar"), { recursive: true });

for (const [name, from] of runtime) {
  await copyFile(from, join(outDir, name));
}

let payloadBytes = 0;
let upstreamLibraryBytes = 0;
const payloadManifest = { schema: 1, jars: [] };
const thirdParty = [];
for (const jar of payloadJars) {
  let body = await readFile(jar.path);
  const name = basename(jar.path);
  if (jar.library) {
    // By reference. pre.js fetches any entry with a url, checks it against
    // Mojang's SHA-1 and size, then against the SHA-256 recorded here. The
    // launcher downloaded the local copy from that same URL, so these digests
    // are Mojang's; confirm that rather than assume it.
    const entry = upstreamLibraryEntry(jar.library, name, body);
    const bundled = serverLibraries.libraries.get(jar.maven);
    if (!bundled || bundled.sha256 !== entry.sha256) {
      die(`${jar.maven} is not inside Mojang's server jar${bundled ? " (different bytes there)" : ""},\n`
        + `  so a page has no way to download it (libraries.minecraft.net sends no CORS\n`
        + `  headers). Give the port a stand-in for what the client uses of it and add it\n`
        + `  to STAND_IN_LIBRARIES.`);
    }
    entry.bundled = { url: serverLibraries.url, bytes: serverLibraries.bytes,
      sha1: serverLibraries.sha1, path: bundled.path };
    payloadManifest.jars.push(entry);
    upstreamLibraryBytes += body.length;
    continue;
  }
  if (jar.path === portJar) assertNoMojangInPortJar(body);
  await writeFile(join(outDir, "payload", "jar", name), body);
  payloadBytes += body.length;
  payloadManifest.jars.push({
    name, bytes: body.length, sha256: sha256(body), role: jar.role,
    ...(jar.maven ? { maven: jar.maven } : {}),
  });
  if (jar.maven) {
    thirdParty.push({
      maven: jar.maven, file: name, sha256: sha256(body),
      licenseFiles: licenseFiles(jarTools(PROJECT).listEntries(new Uint8Array(body))),
    });
  }
}
{
  // The massaged bytes are deterministic, so their digest can be pinned here
  // and re-checked in the browser after massaging - the page verifies the
  // download against Mojang's SHA-1 and the result against this.
  payloadManifest.jars.splice(2, 0, {
    name: `minecraft-${version}-client.jar`,
    bytes: massaged.length,
    sha256: massagedSha,
    role: "mojang-client-upstream",
    url: upstream.url,
    sourceBytes: upstream.bytes,
    sourceSha1: upstream.sha1,
    massagePlan: MASSAGE_PLAN,
  });
  say(`upstream massaged: ${massaged.length} bytes, ${massagedSha.slice(0, 16)}…`);
}
if (payloadManifest.jars[0].role !== "native-policy") die("native-policy jar is not first");
if (payloadManifest.jars[0].sha256 !== policyPointer.sha256
    || payloadManifest.jars[0].bytes !== policyPointer.bytes) {
  die("native-policy artifact does not match its SHA-256 pointer");
}
// Mojang's asset index (sounds), which piston-meta serves with CORS: the page
// resolves /mcweb-audio/ requests through it (mojang-upstream.js).
{
  const index = JSON.parse(await readFile(install.manifest, "utf8")).assetIndex;
  if (index?.url && index?.sha1) {
    payloadManifest.assetIndex = { id: index.id, url: index.url, sha1: index.sha1 };
  }
}
await writeFile(join(outDir, "payload", "manifest.json"),
  JSON.stringify(payloadManifest, null, 2) + "\n");

// The page and its server are generated rather than copied, because the
// harness page at OpenJDK/browser/index.html is a probe bench with a dozen
// buttons and a hard-coded payload server. A bundle has exactly one job.
// Precompile only the established eager dependencies that this bundle ships.
// Optional side modules keep their normal lazy-loading behavior.
const mobileCoreLibraries = new Set(['libjli.so', 'libjvm.so', 'libjimage.so', 'libjava.so',
  'libnet.so', 'libnio.so', 'libzip.so', 'libverify.so', 'libmcwebjs.so']);
const mobileLibraries = runtime.map(([name]) => name)
  .filter(name => name.endsWith('.so') && mobileCoreLibraries.has(name));
const mobileRecord = async name => {
  const path = join(outDir, name);
  return { bytes: (await stat(path)).size, sha256: await fileHash('sha256', path) };
};
const runtimeDigests = await Promise.all(runtime.map(async ([name]) =>
  [name, await fileHash('sha256', join(outDir, name))]));
const mobileRuntime = {
  mobileJarPlan: MASSAGE_PLAN.mobile,
  cacheKey: sha256(JSON.stringify(runtimeDigests)).slice(0, 16),
  vm: await mobileRecord('libjvm.so'),
  loader: await mobileRecord('javavm.js'),
  libraries: await Promise.all(mobileLibraries.map(async name => [name, await mobileRecord(name)])),
};
await writeFile(join(outDir, "index.html"), playPage({ version, mobileRuntime }));
// The public Node server is packaged separately from the browser runtime.

// A bundle meant for publishing is audited, not trusted: every jar it serves
// is opened and checked for Mojang-owned content, and anything served that
// the manifest does not name is an error too. Redistributed libraries are
// recorded with their coordinates and the licence files they carry.
{
  await writeFile(join(outDir, "THIRD-PARTY.json"), JSON.stringify({
    schema: 1,
    note: "Third-party open-source libraries this bundle redistributes. Mojang's "
      + "client jar and libraries are not among them: the browser fetches those from Mojang.",
    libraries: thirdParty,
    wasm: [JSON.parse(await readFile(join(NAGA_DIR, "THIRD-PARTY.json"), "utf8"))],
  }, null, 2) + "\n");
  const audit = await auditBundle(outDir, {
    projectRoot: PROJECT, clientJarBytes: await readFile(clientJar),
    expectedClientSha256: clientSha, version,
  });
  if (audit.violations.length) {
    die(`the bundle failed its publication audit:\n    `
      + audit.violations.join("\n    "));
  }
  say(`provenance audit: clean - serves ${audit.served.length} jars, `
    + `${audit.upstream.length} come from Mojang`);
  say(`shader-text audit: clean - ${audit.shader.scanned} served text files against `
    + `${audit.shader.shaderFiles} shader files (${audit.shader.lines} lines, `
    + `${audit.shader.runs} constant runs, ${audit.shader.members} member runs)`);
}

const bundleManifest = {
  schema: 1,
  lane: "wasmjvm",
  version,
  builtAt: new Date().toISOString(),
  clientJarSha256: clientSha,
  libraryCount: jars.length,
  payloadJarCount: payloadManifest.jars.length,
  payloadBytes,
  // Reached only after the provenance audit passed: everything Mojang owns is
  // fetched by the browser.
  servesMojangContent: false,
  upstreamLibraryBytes,
  runtime: {
    javavmJsSha256: await fileHash("sha256", join(outDir, "javavm.js")),
    javavmWasmSha256: await fileHash("sha256", join(outDir, "javavm.wasm")),
    javavmDataSha256: await fileHash("sha256", join(outDir, "javavm.data")),
  },
  // Mojang's code is never compiled; the JVM runs it. MC-Web's port is
  // compiled against the API of the massaged jar recorded here.
  mojangCodeCompiled: false,
  portCompiledAgainst: { massagedJarSha256: massagedSha, massagePlanSha256: planSha },
  proprietaryToolchain: false,
};
await writeFile(join(outDir, "wasmjvm-manifest.json"),
  JSON.stringify(bundleManifest, null, 2) + "\n");

say(`\ndone.`);
say(`  payload:      ${payloadManifest.jars.length} jars, ${(payloadBytes / 1048576).toFixed(1)} MiB`);
say(`  runtime wasm: ${bundleManifest.runtime.javavmWasmSha256}`);
say(`  bundle:       ${outDir}`);
say(`\nPrepare the public runtime artifact, then run the repository server.`);
say(`\nThis bundle serves no Mojang-owned bytes; the browser fetches them from Mojang.`);
say(`resources.download.minecraft.net sends no CORS headers, so sounds.json cannot be`);
say(`read and a deployed bundle is silent.`);

/**
 * Mojang's dedicated-server jar for this version (from its version manifest):
 * where it is, and the libraries it bundles, by maven coordinate, as its own
 * META-INF/libraries.list names them. Downloaded once into the build cache;
 * nothing of it is packaged.
 */
async function loadServerLibraryList() {
  const server = JSON.parse(await readFile(install.manifest, "utf8")).downloads?.server;
  if (!server?.url || !server?.sha1 || !server?.size) die("the version manifest names no server jar");
  const cacheDir = join(CACHE_DIR, "server");
  const cached = join(cacheDir, `server-${server.sha1}.jar`);
  if (!(await exists(cached))) {
    say(`fetching Mojang's server jar (for its library list): ${server.url}`);
    const response = await fetch(server.url);
    if (!response.ok) die(`server jar: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha1").update(bytes).digest("hex");
    if (digest !== server.sha1) die(`server jar SHA-1 ${digest} is not Mojang's ${server.sha1}`);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cached, bytes);
  }
  const tools = jarTools(PROJECT);
  const list = await tools.readEntry(new Uint8Array(await readFile(cached)), "META-INF/libraries.list");
  if (!list) die("Mojang's server jar has no META-INF/libraries.list");
  const libraries = new Map();
  for (const line of new TextDecoder().decode(list).trim().split("\n")) {
    const [sha256, maven, path] = line.trim().split("\t");
    if (sha256 && maven && path) libraries.set(maven, { sha256, path: "META-INF/libraries/" + path });
  }
  say(`server jar:       ${libraries.size} bundled libraries`);
  return { url: server.url, bytes: server.size, sha1: server.sha1, libraries };
}

/**
 * The manifest entry for one Mojang library the browser fetches itself.
 * Dies rather than publish digests that are not Mojang's.
 */
function upstreamLibraryEntry(lib, name, body) {
  const localSha1 = createHash("sha1").update(body).digest("hex");
  if (lib.sha1 && lib.sha1 !== localSha1) {
    die(`${lib.file} does not match the SHA-1 its launcher manifest records\n`
      + `    manifest: ${lib.sha1}\n    on disk:  ${localSha1}\n`
      + `  Re-download it with your launcher; the browser would reject it too.`);
  }
  if (lib.size !== null && lib.size !== body.length) {
    die(`${lib.file} is ${body.length} bytes; its launcher manifest says ${lib.size}`);
  }
  const url = lib.url ?? `https://libraries.minecraft.net/${lib.relative}`;
  const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
  if (!url.startsWith("https://") || !MOJANG_HOST.test(host)) {
    die(`${lib.name} would be fetched from ${url}, which is not a Mojang host`);
  }
  return {
    name, bytes: body.length, sha256: sha256(body), role: "mojang-library-upstream",
    maven: lib.name, url, sourceBytes: body.length, sourceSha1: localSha1,
  };
}

/**
 * The port jar is MC-Web's own classes (its ABI shadows in Mojang's packages
 * included) and one service file. Anything the provenance audit would flag in
 * it - a Mojang asset, a class with no MC-Web source - is a build regression,
 * not something to strip quietly.
 */
function assertNoMojangInPortJar(body) {
  const tools = jarTools(PROJECT);
  const flagged = auditJarEntries(tools.listEntries(new Uint8Array(body)),
    { allowedShadows: authoredShadowClasses(PROJECT) });
  if (flagged.length) {
    die(`the port jar contains Mojang-owned entries:\n    `
      + flagged.slice(0, 10).map((v) => v.entry).join("\n    "));
  }
}

/** One digest over every file under the given roots (directories or files), by relative path. */
async function treeHash(roots) {
  const hash = createHash("sha256");
  for (const root of roots) {
    const files = [];
    const walk = async (d) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) files.push(p);
      }
    };
    if ((await stat(root)).isFile()) files.push(root); else await walk(root);
    for (const p of files.sort()) {
      hash.update(relative(PROJECT, p)).update("\0").update(await readFile(p)).update("\0");
    }
  }
  return hash.digest("hex");
}

/**
 * Run the browser's own massager here, so the digest pinned in the manifest is
 * produced by exactly the code the page will run - not by a second
 * implementation that could drift from it.
 */
async function massageJarLocally(bytes, plan) {
  const result = await jarTools(PROJECT).prepareClientJar(new Uint8Array(bytes), plan);
  if (result.missing.length) {
    die(`massage plan names entries the jar does not contain:\n    `
      + result.missing.join("\n    "));
  }
  say(`upstream patched:  ${result.patched.length} classes, dropped `
    + `${result.dropped.join(", ")}`);
  return Buffer.from(result.bytes);
}

// ------------------------------------------------------------------ templates

function playPage({ version, mobileRuntime }) {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Minecraft ${version} on OpenJDK 25 (wasm)</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --fg:#e6e6e6; --dim:#8b93a1; --accent:#7cc4ff; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { padding:16px 20px; border-bottom:1px solid #232733; }
  h1 { margin:0 0 4px; font-size:15px; font-weight:600; }
  .sub { color:var(--dim); font-size:12px; }
  .bar { display:flex; flex-wrap:wrap; gap:12px; align-items:center; padding:12px 20px;
         border-bottom:1px solid #232733; }
  select, input { font:inherit; }
  button { background:#1b2029; color:var(--fg); border:1px solid #303747; border-radius:6px;
           padding:6px 14px; font:inherit; cursor:pointer; }
  button:hover:not(:disabled) { border-color:var(--accent); }
  button:disabled { opacity:.45; cursor:default; }
  #game-canvas { display:none; width:calc(100vw - 40px); aspect-ratio:var(--mcweb-gc-aspect, 16 / 9);
                 margin:16px 20px; border:1px solid #303747; background:#000; }
  #game-canvas.on { display:block; }
  /* Full screen letterboxes the launch framebuffer; its pixel size is fixed
     at Play (launch-display.js), so this only scales it on the page. No
     object-fit: pre.js maps pointer input through the canvas's layout box.
     game-controls.js marks the stage mcweb-gc-fullscreen (also its CSS-only
     fallback where element full screen is unavailable) and owns the overlay. */
  #mcweb-game-stage { position:relative; }
  #game-loading { position:absolute; z-index:2; bottom:24px; left:50%; transform:translateX(-50%);
    width:max-content; max-width:calc(100% - 48px); box-sizing:border-box; padding:12px 18px;
    border:3px solid #242424; border-top-color:#aaa; border-left-color:#aaa; background:rgba(28,28,28,.94);
    color:#fff; box-shadow:3px 3px 0 #000; font:bold 14px/1.5 ui-monospace,Menlo,monospace;
    text-align:center; pointer-events:none; }
  #game-loading[hidden] { display:none; }
  #game-loading-status { display:block; color:#ddd; font-size:12px; font-weight:normal; }
  #mcweb-game-stage:fullscreen, #mcweb-game-stage:-webkit-full-screen, #mcweb-game-stage.mcweb-gc-fullscreen {
    display:flex; align-items:center; justify-content:center; width:100vw; height:100vh; height:100dvh; background:#000; }
  #mcweb-game-stage:fullscreen > #game-canvas, #mcweb-game-stage:-webkit-full-screen > #game-canvas,
  #mcweb-game-stage.mcweb-gc-fullscreen > #game-canvas {
    width:min(100vw, calc(100vh * var(--mcweb-gc-aspect, 16 / 9))); width:min(100vw, calc(100dvh * var(--mcweb-gc-aspect, 16 / 9))); height:auto; margin:0; border:0; }
  #memory-profile { margin:0 20px 12px; border:1px solid #303747; border-radius:6px; padding:0 14px; }
  #memory-profile summary { cursor:pointer; padding:10px 0; }
  .profile-row { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin:8px 0; }
  #log { margin:0; padding:16px 20px; white-space:pre-wrap; word-break:break-word;
         max-height:32vh; overflow-y:auto; color:var(--dim); }
  .err { color:#ff9d9d; }
  #runtime-log { margin:0 20px 20px; border:1px solid #303747; border-radius:6px; }
  #runtime-log summary { cursor:pointer; padding:10px 14px; }
  @media (max-width:600px) { .bar { gap:8px; } .bar #status { flex-basis:100%; } button, select, #runtime-log summary, #memory-profile summary { min-height:44px; box-sizing:border-box; } }
</style>
<link rel="stylesheet" href="game-controls.css?release=${mobileRuntime.cacheKey}">
<header>
  <h1>Minecraft ${version} &middot; OpenJDK 25 &middot; HotSpot Zero &middot; wasm32</h1>
  <div class="sub">Nothing about Minecraft is compiled. The JVM is the program; your JAR is data,
    loaded through an ordinary ClassLoader and never uploaded anywhere.</div>
</header>
<div class="bar">
  <button id="install" title="Download Minecraft from Mojang into this browser and patch it here">Install</button>
  <button id="play" disabled>Play</button>
  <span class="sub" id="status">checking this browser&hellip;</span>
  <span id="launch-options"></span>
  <label class="sub"><select id="touch-controls-mode"><option value="auto">Touch controls: auto</option>
    <option value="on">Touch controls: on</option><option value="off">Touch controls: off</option></select></label>
  <label class="sub"><input type="checkbox" id="fullscreen-on-play"> Full screen on Play</label>
  <button id="fullscreen" disabled title="Full screen; the on-screen Exit button leaves it">Full screen</button>
</div>
<div id="mcweb-game-stage"><canvas id="game-canvas" width="1280" height="720"></canvas><div id="game-loading" role="status" aria-live="polite" hidden>Loading Minecraft&hellip;<span id="game-loading-status"></span></div></div>
<details id="memory-profile"><summary>Profile memory (optional, separate from Play)</summary></details>
<details id="runtime-log"><summary>Runtime log</summary><pre id="log"></pre></details>
<script>
// Test drivers only (?mcweb_fakePointerLock=1, added by tools/test-display.mjs
// on its private headless display): Chrome on a headless Wayland compositor
// crashes when a page requests pointer lock, as there is no pointer device.
// The page then grants the lock itself; mouse deltas arrive as usual.
if (new URLSearchParams(location.search).get('mcweb_fakePointerLock') === '1') {
  let locked = null;
  const changed = () => document.dispatchEvent(new Event('pointerlockchange'));
  Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get: () => locked });
  Element.prototype.requestPointerLock = function () { locked = this; queueMicrotask(changed); return Promise.resolve(); };
  Document.prototype.exitPointerLock = function () { if (locked) { locked = null; queueMicrotask(changed); } };
}
</script>
<script src="jar-massage.js?release=${mobileRuntime.cacheKey}"></script>
<script src="mojang-upstream.js?release=${mobileRuntime.cacheKey}"></script>
<script src="mobile-runtime.js?release=${mobileRuntime.cacheKey}"></script>
<script src="audio-host.js?release=${mobileRuntime.cacheKey}"></script>
<script src="launch-display.js?release=${mobileRuntime.cacheKey}"></script>
<script src="memory-profile.js?release=${mobileRuntime.cacheKey}"></script>
<script src="game-controls.js?release=${mobileRuntime.cacheKey}"></script>
<script src="javavm.js?release=${mobileRuntime.cacheKey}"></script>
<script>
const mobile = globalThis.mcWebMobileRuntime;
const mobileRuntimeConfig = ${JSON.stringify(mobileRuntime)};
const query = new URLSearchParams(location.search);
// An on/off flag: ?flag and ?flag=1 turn it on, ?flag=0|false|off|no (or no
// ?flag at all) leave it off, so a templated benchmark URL means what it says.
const on = (name) => {
  const value = query.get(name);
  return value !== null && !/^(0|false|off|no)$/i.test(value);
};
const optional = (name, ...args) => on(name) ? args : [];
// ?xmx=1536m: the desktop Java heap (see the arguments below); iPhone/iPad
// use their own heap: the defaults or the caps of an applied memory-profile
// bound (mobile-runtime.js memoryLimits).
const requestedHeap = /^\\d+[mg]$/.test(query.get('xmx') || '') ? query.get('xmx') : '1536m';

const log = document.getElementById('log');
const runtimeLog = document.getElementById('runtime-log');
const status = document.getElementById('status');
const playButton = document.getElementById('play');
const mobileWake = mobile.createScreenWakeLock(write);
globalThis.mcWebScreenWakeState = mobileWake.state;
// Lines are queued and appended once per animation frame. Appending and
// scrolling per line forced a layout per line on the page's main thread
// (10% of it with the JIT's output on), which Emscripten also needs for
// proxied work.
const pendingLines = [];
let flushQueued = false;
const mirrorStdout = on('stdoutconsole');
function flushLines() {
  flushQueued = false;
  const frag = document.createDocumentFragment();
  for (const [text, cls] of pendingLines.splice(0)) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text + '\\n';
    frag.appendChild(span);
  }
  log.appendChild(frag);
  // Bounded: a long session writes hundreds of thousands of lines and the DOM
  // nodes cost more than the text is worth.
  while (log.childNodes.length > 4000) log.removeChild(log.firstChild);
  if (runtimeLog.open) log.scrollTop = log.scrollHeight;
}
function write(text, cls) {
  // ?stdoutconsole: also to the console, where tools can read it
  // (OpenJDK/prof/browser-profile.mjs keeps the console).
  if (mirrorStdout) console.log(text);
  pendingLines.push([text, cls]);
  if (pendingLines.length > 4000) pendingLines.splice(0, pendingLines.length - 4000);
  if (!flushQueued) { flushQueued = true; requestAnimationFrame(flushLines); }
}
runtimeLog.addEventListener('toggle', () => {
  if (runtimeLog.open) log.scrollTop = log.scrollHeight;
});

// Install: Mojang's files are downloaded by this browser, from Mojang only
// (mojang-upstream.js: the client jar from piston-data, Mojang's libraries
// out of Mojang's server jar there), checked against Mojang's SHA-1s, the jar
// patched here, and everything cached in OPFS. This page's own origin serves
// only the page, MC-Web's code, open-source jars and the wasm JVM.
const installButton = document.getElementById('install');
let runtimeDiscardRequested = false;
let manifestPromise;
function loadManifest() {
  return manifestPromise ||= fetch('./payload/manifest.json', { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error('payload manifest HTTP ' + response.status);
      return response.json();
    }).catch(failure => {
      manifestPromise = undefined;
      throw failure;
    });
}
let upstream = null;
async function setUp() {
  const manifest = await loadManifest();
  upstream = upstream || mcWebUpstream.install({
    // Sounds: Mojang's asset index (piston-meta), then each file from this
    // browser's cache or played straight from Mojang (audio-host.js).
    assetIndex: manifest.assetIndex,
    log: t => write(t),
  });
  return manifest;
}
const mb = (bytes) => (bytes / 1048576).toFixed(1);
async function refreshInstalled() {
  await mobile.requireRuntimeSupport();
  const manifest = await setUp();
  const missing = await mcWebUpstream.missingPayload(manifest);
  if (runtimeDiscardRequested) return false;
  const installed = missing.length === 0;
  playButton.disabled = !installed;
  installButton.textContent = installed ? 'Reinstall' : 'Install';
  status.textContent = installed
    ? 'installed in this browser - press Play'
    : 'not installed (' + missing.length + ' of ' + manifest.jars.length + ' files to fetch)';
  return installed;
}
installButton.onclick = async () => {
  if (runtimeDiscardRequested) return;
  try { await mobile.requireRuntimeSupport(); } catch (failure) { unsupportedBrowser(failure); return; }
  installButton.disabled = true;
  playButton.disabled = true;
  try {
    const manifest = await setUp();
    await mcWebUpstream.installPayload(manifest, {
      base: './payload',
      resolver: upstream,
      onProgress: (p) => {
        status.textContent = p.phase === 'installed'
          ? 'installed'
          : p.phase + ' ' + p.name + ' (' + (p.index + 1) + '/' + p.count + ', '
            + mb(p.done) + ' of ' + mb(p.total) + ' MB)';
      },
    });
    write('[install] ' + manifest.jars.length + ' files verified and cached in this browser');
  } catch (failure) {
    write('[install] failed: ' + (failure && failure.message || failure), 'err');
    status.textContent = 'install failed - see the log';
  } finally {
    installButton.disabled = false;
    await refreshInstalled().catch(unsupportedBrowser);
  }
};
function unsupportedBrowser(failure) {
  write('could not prepare this browser: ' + failure, 'err');
  status.textContent = failure.message || 'bundle unavailable - see the log';
  const blocked = failure?.code === 'MCWEB_RUNTIME_UNSUPPORTED' || failure?.code === 'MCWEB_RUNTIME_RELOAD_REQUIRED';
  installButton.disabled = blocked;
  playButton.disabled = true;
  if (!blocked) status.textContent += ' — press Install to retry';
}
refreshInstalled().catch(unsupportedBrowser);

playButton.onclick = async () => {
  if (runtimeDiscardRequested) return;
  if (!launchDisplay.validate()) {
    document.getElementById('settings-button')?.click();
    launchDisplay.reportValidity();
    status.textContent = 'Enter a valid custom resolution in Settings before playing.';
    return;
  }
  // A memory profile and a game never share a page, and a launch memory
  // applied or reset in this page needs a reload first (memory-profile.js).
  if (mcWebMemoryProfile.blocksPlay()) {
    status.textContent = 'the memory profile panel was used in this page - reload it before Play';
    return;
  }
  mcWebMemoryProfile.playStarted();
  // Full screen needs this tap's user activation, so it is asked for first.
  if (fullscreenOnPlay.checked) gameControls.enterFullscreen();
  // Media elements need their own trusted gesture before asynchronous JVM loading.
  const audioPreparation = mcWebAudio.prepareStreaming().catch(failure => ({ errors: [String(failure)] }));
  try { await mobile.requireRuntimeSupport(); } catch (failure) { unsupportedBrowser(failure); return; }
  if (runtimeDiscardRequested) return;
  playButton.disabled = true;
  installButton.disabled = true;
  status.textContent = 'starting the JVM…';
  mobileWake.start();
  let vmStarted = false;
  try {
  const audioReady = await audioPreparation;
  if (runtimeDiscardRequested) return;
  if (!audioReady.disabled && (audioReady.errors?.length || audioReady.ready < audioReady.limit))
    write('could not prepare sound: ' + (audioReady.errors?.join('; ') || 'not all sound channels are ready'), 'err');
  // Launch memory: the iPhone/iPad defaults, or the bound the player applied
  // from a memory profile, read once at page load. The -Xmx below and the
  // loader's WebAssembly maximum both come from this one cap.
  const launch = await launchMemory;
  if (runtimeDiscardRequested) return;
  if (launch.note) write('[memory] ' + launch.note);
  const memoryWasmMaxMiB = launch.budget ? launch.budget.limits.wasmMaxMiB : null;
  const manifest = await setUp();
  if (runtimeDiscardRequested) return;
  const cp = manifest.jars.map(j => '/app/mcweb/' + j.name).join(':');
  if (!(await refreshInstalled())) {
    write('Install first: some files are missing from this browser.', 'err');
    mobileWake.stop();
    installButton.disabled = false;
    return;
  }
  playButton.disabled = true;
  installButton.disabled = true;

  if (runtimeDiscardRequested) return;
  const holder = document.getElementById('game-canvas');
  const canvas = document.createElement('canvas');
  canvas.id = 'game-canvas';
  canvas.className = 'on';
  const launchSize = launchDisplay.launch();
  canvas.width = launchSize.width;
  canvas.height = launchSize.height;
  document.getElementById('mcweb-game-stage').style.setProperty('--mcweb-gc-aspect', String(launchSize.width / launchSize.height));
  holder.replaceWith(canvas);
  loadingStatus('Starting Minecraft. This can take a few minutes.');
  fullscreenButton.disabled = false;

  // The display's refresh rate, for VSync in BrowserFramePump.paceFrame: the
  // JVM's frame loop runs on a Worker, which has no animation frames. The
  // mean of 30 animation-frame intervals, ignoring any that skipped a frame;
  // 60 if the tab is hidden and animation frames do not come.
  const displayHz = await new Promise((resolve) => {
    const stamps = [];
    const step = (now) => {
      stamps.push(now);
      if (stamps.length <= 30) { requestAnimationFrame(step); return; }
      const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
      const median = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
      const steady = gaps.filter((g) => g < median * 1.5);
      resolve(1000 * steady.length / steady.reduce((sum, g) => sum + g, 0));
    };
    requestAnimationFrame(step);
    setTimeout(() => resolve(60), 2000);
  });
  if (runtimeDiscardRequested) return;
  write('[display] ' + displayHz.toFixed(2) + ' Hz');
  const args = [
    '-Dmcweb.displayHz=' + displayHz.toFixed(3),
    // ?mcweb_vsync=1|0, ?mcweb_max_fps=10..260: the Video Settings this
    // launch starts with (BrowserMinecraftMain.configureFrameOptions).
    ...optional('mcweb_pace', '-Dmcweb.paceStats=true'),
    ...(query.has('mcweb_vsync') ? ['-Dmcweb.vsync=' + on('mcweb_vsync')] : []),
    ...(/^\\d+$/.test(query.get('mcweb_max_fps') || '') ? ['-Dmcweb.maxFps=' + query.get('mcweb_max_fps')] : []),
    // ?xmx=1536m: the Java heap ceiling. Minecraft's live set with the whole
    // view loaded settles near 700 MB (LWJGL's "native" buffers are Java
    // arrays here, see BrowserNativeMemory); under 1g the old generation could
    // not take the promotions and a 350-430 ms full collection ran every ~3.5 s.
    // 2g cannot be reserved in wasm32's 4 GB next to everything else.
    '-Xmx' + requestedHeap,
    // The whole heap from the start: Serial resizes its generations only at
    // a full collection, and without one (the jar massaged in the tab never
    // gets the post-reload System.gc) the young generation stayed ~13 MB and
    // collected every 0.2 s. The range is reserved in linear memory anyway.
    '-Xms' + requestedHeap,
    // The Parallel collector: a pause is split across GC threads (half the
    // cores, 2..8) while every other thread waits, the render thread
    // included. Serial (?gc=serial) does it on one: 120 s flights, full
    // collection 699 ms -> 253/267 ms, young 27 -> 10 ms mean, same chunks/s
    // and FPS (pgc-ser-1, pgc-par-1/2). OpenJDK/tests/GcPauseStress.java
    // checks the collector with the JIT on a rewired old graph.
    ...(query.get('gc') === 'serial' ? ['-XX:+UseSerialGC']
      : ['-XX:+UseParallelGC', '-XX:ParallelGCThreads=' + Math.max(2, Math.min(8, ((navigator.hardwareConcurrency || 4) / 2) | 0))]),
    // Metaspace starts at a 20 MB threshold and each crossing is a full
    // collection: three during boot (~175 ms). The game's classes need ~250.
    '-XX:MetaspaceSize=256m',
    // Old generation 3/4 of the heap, not 2/3: the live set with the whole
    // view loaded is ~700-850 MB, and a full collection costs 600-800 ms.
    // Young collections stay short (they copy only survivors).
    '-XX:NewRatio=3',
    // LWJGL "native" arrays freed for reuse (BrowserNativeMemory): a small pool.
    '-Dmcweb.nativePoolMB=16', '--enable-native-access=ALL-UNNAMED',
    // LWJGL's Platform.<clinit> rejects "Emscripten" outright; the library
    // loading behind it is MC-Web's Java replacement, so no native is loaded.
    '-Dos.name=Linux', '-Dos.arch=amd64',
    // Netty estimates max direct memory by reflecting into java.nio.Bits and
    // falls back to ManagementFactory when that is closed. On this runtime
    // that fallback loads libmanagement.so and fails slowly - 77% of
    // world-creation samples sat in it. Opening java.nio avoids it entirely.
    '--add-opens', 'java.base/java.nio=ALL-UNNAMED',
    '-Dio.netty.tryReflectionSetAccessible=true',
    // Singleplayer runs over Netty's in-memory transport (docs/NET-MIGRATION.md):
    // one event-loop thread (each is a Worker here), heap buffers, no native
    // transports, and fixed ids instead of a MAC/PID lookup through libnet.
    '-Dio.netty.eventLoopThreads=' + (query.get('nettyThreads') || '1'),
    '-Dio.netty.machineId=02:00:00:00:00:01', '-Dio.netty.processId=1',
    '-Dio.netty.transport.noNative=true',
    '-Dio.netty.allocator.type=unpooled', '-Dio.netty.noPreferDirect=true',
    '-Dio.netty.leakDetection.level=disabled',
    '-Dmcweb.main=dev.mcweb.graal.BrowserMinecraftMain',
    // The launcher selects the authenticated multiplayer transport.
    ...(globalThis.mcWebLocalRelay && !globalThis.mcWebLocalRelay.isReady() ? ['-Dmcweb.disableMultiplayer=true'] : []),
    '-Dmcweb.bridge=/app/bridge/libmcwebjs.so',
    // This JVM's main thread IS the Worker thread, so frames cannot come back
    // through a browser callback; the pump drives them from main.
    '-Dmcweb.frameloop=1',
    // Mojang's own Server thread rather than a server pumped from the render
    // frame: this runtime has real pthreads, and ticket promotion (which sets
    // the chunk horizon) happens per server tick.
    '-Dmcweb.runtimeMode=' + (query.get('runtimeMode') || 'WASMLM_THREADED'),
    ...optional('noblur', '-Dmcweb.noblur=1'),
    // ?reloadStress=ms (test only): F3+A every ms (BrowserFramePump.reloadStress).
    ...(/^\\d+$/.test(query.get('reloadStress') || '') ? ['-Dmcweb.reloadStress=' + query.get('reloadStress')] : []),
    // The JIT is on for every Play; ?nojit=1 runs the interpreter alone.
    ...(on('nojit') ? [] : ['-XX:+UnlockExperimentalVMOptions', '-XX:+UseZeroWasmJIT']),
    // ?jitflags=-XX:ZeroWasmJITDisable=16384,-XX:+ZeroWasmJITVerbose: more JIT
    // flags, comma-separated. Bisecting a JIT fault needs nothing else.
    ...(!on('nojit') && query.get('jitflags')
        // A literal '+' in a query string decodes as a space: -XX:+Foo arrives
        // as '-XX: Foo' unless it was written %2B. Put it back.
        ? query.get('jitflags').split(',').map((f) => f.replace(/^-XX: /, '-XX:+')).filter((f) => /^-XX:[+-]?ZeroWasmJIT\\w*(=[\\w.$*/]*)?$/.test(f)) : []),
    // Worldgen threads. Without them every chunk is generated on Minecraft's
    // Server thread, which then cannot keep up with its ticks: a broken block
    // took seconds to register. Default: the cores left after the client and
    // Server threads, at most eight (world creation, 16-core machine: none
    // 158 s, 6 threads 117 s, 8 111 s, 12 107 s). Twelve gave a flight ~15%
    // more complete chunks/s but cost the render thread its core (8 cores
    // with SMT here): flight FPS 214 -> 150, frames over 50 ms x3-7, hovering
    // 26 -> 192 (gcab8-1, gcab12-1). More threads is not the lever: phones
    // have fewer, slower cores. ?serverThreads=0 turns them off; with fewer
    // than five the port keeps generation inline anyway.
    // ?simulationDistance=N (5..32): how far out entities tick. Mojang's
    // default otherwise; 6 and 12 measured the same server tick time here.
    ...(query.has('simulationDistance') ? ['-Dmcweb.simulationDistance=' + query.get('simulationDistance')] : []),
    // ?blockUpdates=none|player|nearby: Video Settings > Block Updates
    // (BrowserMinecraftMain.applyBlockUpdates; "player" when absent).
    ...(query.has('blockUpdates') ? ['-Dmcweb.blockUpdates=' + query.get('blockUpdates')] : []),
    // ?smartCull=0: Minecraft's occlusion culling off (on by default:
    // BrowserMinecraftMain.applySmartCull).
    ...(query.get('smartCull') === '0' ? ['-Dmcweb.smartCull=false'] : []),
    // ?chunkSlice=N: ms of chunk-system work the Server thread is given every
    // tick even when its ticks overrun (see BrowserIntegratedServerCompat).
    '-Dmcweb.chunkSliceMs=' + (query.get('chunkSlice') ?? '0'),
    // ?chunkDiag=1: the chunk pipeline samplers (worldgen executor top frames,
    // per-status tick latency) in the chunkpipe: reports.
    ...optional('chunkDiag', '-Dmcweb.chunkDiag=true'),
    // ?frameDiag=1: the once-per-120-frames GUI/input/thread census in
    // BrowserFramePump.frame (it re-extracts the screen and resolves methods by
    // reflection). ?terrainDiag=1: the deep section-pipeline probes behind
    // terrain: (three octree walks, a 5x5x4 section grid, 40 block reads).
    // ?frametimeFull=1: the median and GC counters in frametime:.
    // All three are diagnostics the benchmark harness never reads.
    ...optional('frameDiag', '-Dmcweb.frameDiag=true'),
    ...optional('terrainDiag', '-Dmcweb.terrainDiag=true'),
    ...optional('frametimeFull', '-Dmcweb.frametimeFull=true'),
    // ?bootSampler=1: stack samples of every thread from new Minecraft to the
    // title screen, reported there as bootsample: lines (BrowserBootSampler).
    ...optional('bootSampler', '-Dmcweb.bootSampler=true'),
    // ?frameSplit=1: the client tick and its phases timed, once a second
    // (BrowserFrameTiming).
    ...optional('frameSplit', '-Dmcweb.frameSplit=true'),
    // ?clientProfile=N: 20 s of stack samples every 10 ms, N seconds into
    // the world, printed as bootsample: lines (BrowserClientProfile).
    ...(/^\\d+$/.test(query.get('clientProfile') || '') ? ['-Dmcweb.clientProfile=' + query.get('clientProfile')] : []),
    // ?sampleFocus=Class.method: with clientProfile, an inclusive table of
    // the methods under that frame (BrowserBootSampler.FOCUS).
    ...(/^[\\w.$]+$/.test(query.get('sampleFocus') || '') ? ['-Dmcweb.sampleFocus=' + query.get('sampleFocus')] : []),
    // ?entityEvents=1: evt: markers for the per-entity packet flood (motion,
    // teleport, entity events) as well; off by default, they cost the
    // Server thread ~6% with a few dozen mobs around.
    ...optional('entityEvents', '-Dmcweb.entityEvents=true'),
    // ?gclog=1: the collector's pauses on stdout (with ?stdoutconsole=1).
    ...optional('gclog', '-Xlog:gc:stdout'),
    // ?nodeflate=1: no MonitorDeflationThread (inflated monitors are kept).
    ...optional('nodeflate', '-XX:+UnlockDiagnosticVMOptions', '-XX:AsyncDeflationInterval=0',
      '-XX:GuaranteedAsyncDeflationInterval=0'),
    // ?classload=1: every class the JVM loads, with the jar it came from.
    ...optional('classload', '-Xlog:class+load=info:stdout'),
    // ?gchisto=1: a class histogram before and after every full collection
    // (with ?stdoutconsole=1) -- what the live set is made of.
    ...optional('gchisto', '-Xlog:gc+classhisto=trace:stdout'),
    // ?ticketThrottle=N: chunks Mojang's player-ticket dispatcher lets into
    // execution at once (it hard-codes 4); an experiment knob.
    ...(query.has('ticketThrottle') ? ['-Dmcweb.ticketThrottle=' + query.get('ticketThrottle')] : []),
    // ?dispatcherLane=0: the worldgen/light ChunkTaskDispatchers' own executor
    // back on the shared pool, not the lane it feeds (on by default:
    // BrowserIntegratedServerCompat.DISPATCHER_LANE).
    ...(query.get('dispatcherLane') === '0' ? ['-Dmcweb.dispatcherLane=false'] : []),
    // ?lookAhead=N (default 12, 0 report only, -1 off): a moving player's
    // chunks in front streamed through small loading tickets, at most N still
    // generating (BrowserIntegratedServerCompat.streamAhead);
    // ?lookAheadRadius=R (default 1) is each ticket's radius.
    // ?lookAheadReport=1 reports it.
    '-Dmcweb.lookAhead=' + (query.get('lookAhead') ?? '12'),
    ...(/^\\d+$/.test(query.get('lookAheadRadius') || '') ? ['-Dmcweb.lookAheadRadius=' + query.get('lookAheadRadius')] : []),
    // ?offloadSteps=a,b: chunk statuses whose generation work runs on the
    // background pool instead of the serial worldgen lane (default none,
    // vanilla's placement; 26.3's terrain step already runs on the pool:
    // BrowserWorldgenSteps).
    ...(/^[a-z_,]+$/.test(query.get('offloadSteps') || '') ? ['-Dmcweb.offloadSteps=' + query.get('offloadSteps')] : []),
    // ?copyLockTrace=0: SectionRenderDispatcher's copy lock calls without
    // the ring BrowserCopyLockTrace keeps for the "Batching sections" fault.
    ...(query.get('copyLockTrace') === '0' ? ['-Dmcweb.copyLockTrace=false'] : []),
    // ?sectionPacks=N: section builder packs (default 6; vanilla: one a core).
    ...(/^\\d+$/.test(query.get('sectionPacks') || '') ? ['-Dmcweb.sectionPacks=' + query.get('sectionPacks')] : []),
    // ?threadingDetector=1: Mojang's per-write ThreadingDetector guard back on
    // every PalettedContainer acquire/release (off by default:
    // BrowserThreadingDetectorCompat).
    ...(query.get('threadingDetector') === '1' || query.get('threadingDetector') === 'on'
      ? ['-Dmcweb.threadingDetector=on'] : []),
    ...(on('lookAheadReport') ? ['-Dmcweb.lookAheadReport=true'] : []),
    // ?flowReport=1: "flow:" once a second, chunks from generated to drawn.
    ...(on('flowReport') ? ['-Dmcweb.flowReport=true'] : []),
    // ?earlySend=0: chunks sent only once they tick, as vanilla
    // (BrowserChunkCompat.sendEarly).
    ...(query.get('earlySend') === '0' ? ['-Dmcweb.earlySend=false'] : []),
    // ?serverWatchdog=1: stacks of the Server thread (and chunk threads) when
    // its tick stops for 6 s (BrowserIntegratedServerCompat.startServerWatchdog).
    ...(on('serverWatchdog') ? ['-Dmcweb.serverWatchdog=true'] : []),
    ...(query.get('serverWatchdog') === '2' ? ['-Dmcweb.serverWatchdogPeriodic=true'] : []),
    ...(() => {
      const n = query.has('serverThreads') ? Number(query.get('serverThreads'))
        : Math.min(8, Math.max(0, (navigator.hardwareConcurrency || 4) - 2));
      return n > 0 ? ['-Dmcweb.serverThreads=' + n] : [];
    })(),
    ...(query.has('autoplay') ? ['-Dmcweb.autoplay=' + query.get('autoplay')] : []),
    '-cp', cp,
    'dev.mcweb.wasm.Boot',
    '--version', '${version}', '--accessToken', '0', '--userType', 'legacy',
    '--versionType', 'release',
  ];
  const runtimeArgs = mobile.runtimeArguments(args, memoryWasmMaxMiB);
  write('$ java ' + runtimeArgs.join(' '));
  // The title panorama: Mojang's client jar carries 1x1 placeholders, and the
  // real images are objects in Mojang's asset index, like the sounds. They
  // come the same way (mojang-upstream.js: this browser's cache, Mojang, or
  // a same-origin pass-through to Mojang; SHA-1 checked) and go where the
  // game's own exploded asset folder is read from (GameConfig assets dir
  // /assets, no index). With no readable source the placeholder stays.
  // All six cube faces or none: the game refuses a cube map whose faces
  // differ in size, and one face missing beside five real ones (1x1 against
  // 1024x1024) failed the title screen's reload outright (hunt-6). Each image
  // gets a second try.
  const titleAssets = await Promise.race([
    Promise.all(Array.from({ length: 7 }, (_, i) =>
      'minecraft/textures/gui/title/background/panorama_' + (i < 6 ? i : 'overlay') + '.png')
      .map(async (name) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await upstream.fetch('/mcweb-audio/' + name);
            if (response.ok) return { name, bytes: new Uint8Array(await response.arrayBuffer()) };
          } catch { /* next attempt */ }
        }
        return null;
      })),
    new Promise((resolve) => setTimeout(() => resolve([]), 15000)),
  ]).then((found) => {
    const faces = found.slice(0, 6);
    return [...(faces.every(Boolean) ? faces : []), found[6]].filter(Boolean);
  });
  write('[assets] title panorama: ' + titleAssets.length + ' of 7 images from Mojang');
    if (runtimeDiscardRequested) return;
    loadingStatus('Preparing Minecraft. This can take a few minutes.');
    await mobile.prepareMobileRuntime(mobileRuntimeConfig, write, memoryWasmMaxMiB);
    if (runtimeDiscardRequested) return;
    const { prepareVmIdentity } = await import('./vm-identity.mjs');
    if (runtimeDiscardRequested) return;
    const vmIdentity = await prepareVmIdentity(mobileRuntimeConfig.vm, {
      ios: mobile.usesBoundedRuntime(), modules: globalThis.__mcWebMobileModules,
      release: mobileRuntimeConfig.cacheKey,
    });
    if (runtimeDiscardRequested) return;
    vmStarted = true;
    await createJavaVM({
      onRuntimeInitialized: vmIdentity.onRuntimeInitialized,
      onMcWebRuntimeCreated: runtimeCreated,
      onAbort: () => runtimeStopped('The game runtime stopped unexpectedly.'),
      onExit: () => runtimeStopped('The game runtime has exited.'),
      locateFile: (file, prefix) => prefix + file + '?release=${mobileRuntime.cacheKey}',
      arguments: runtimeArgs,
      preRun: [(module) => {
        vmIdentity.preRun(module);
        for (const { name, bytes } of titleAssets) {
          const path = '/assets/' + name;
          module.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
          module.FS.writeFile(path, bytes);
        }
      }],
      mcWebCanvas: canvas.transferControlToOffscreen(),
      mcWebCanvasElement: canvas,
      mcWebPayload: './payload/manifest.json',
      print: t => {
        write(t);
        if (runtimeTerminal || gameReady) return;
        const frame = /^(?:\\[MC-FRAMES\\] frames:|\\[MC-FRAME\\] first frame reported: )(\\d+)$/.exec(t);
        if (!frame || Number(frame[1]) <= 0) return;
        gameStarted();
        status.textContent = 'running';
      },
      printErr: t => {
        // Emscripten reports the syscalls it stubs out on this target; they
        // are expected here and only add noise.
        if (t.startsWith('warning: unsupported syscall')) return;
        write(t, 'err');
      },
      // The frame pump keeps the process alive; exiting would end the game.
      noExitRuntime: true,
    });
    if (!runtimeTerminal && !gameReady) {
    loadingStatus('Loading Minecraft. This can take a few minutes.');
    }
  } catch (error) {
    if (!(error && error.name === 'ExitStatus')) {
      write((error && error.stack) ? error.stack : String(error), 'err');
    }
    if (vmStarted || error?.code === 'MCWEB_RUNTIME_RELOAD_REQUIRED') {
      runtimeStopped('The game runtime could not continue.');
    } else {
      mobileWake.stop();
      document.getElementById('game-canvas')?.classList.remove('on');
      const loading = document.getElementById('game-loading');
      if (loading) loading.hidden = true;
      globalThis.mcWebRuntimeStopped?.();
      status.textContent = 'could not start — press Play to retry';
      installButton.disabled = playButton.disabled = false;
    }
  }
};

// Launcher controls. Each module is inert until used: the launch size is read
// once at Play, the memory profile runs only from its own panel, and the game
// controls stay inactive until the first frames arrive.
const ios = mobile.usesIOSRuntime();
const boundedRuntime = mobile.usesBoundedRuntime();
const fullscreenButton = document.getElementById('fullscreen');
const fullscreenOnPlay = document.getElementById('fullscreen-on-play');
const touchMode = document.getElementById('touch-controls-mode');
const launchDisplay = mcWebLaunchDisplay.mount({
  container: document.getElementById('launch-options'), query, ios, write });
let gameReady = false;
let runtimeTerminal = false;
let runtimeApi = null;
let terminalCleanup = null;
let terminalResult = null;
function discardGameRuntime() {
  runtimeDiscardRequested = true;
  if (!runtimeTerminal) playButton.disabled = true;
  installButton.disabled = true;
  if (terminalCleanup) return terminalCleanup;
  terminalCleanup = (async () => {
    // The selected page owns persistence. A failed commit leaves the runtime
    // and FS intact for Retry saving; resource discard never claims a save.
    await globalThis.mcWebGameStorage?.flush();
    gameStopped();
    mobileWake.stop();
    const api = runtimeApi;
    const result = api ? await api.discard() : (await globalThis.mcWebAudio?.dispose(),
      {version: 1, phase: 'discarded', saved: false, gpu: {owned: false}});
    runtimeApi = null;
    terminalResult = result;
    return result;
  })().catch(error => { terminalCleanup = null; throw error; });
  return terminalCleanup;
}
function runtimeCreated(api) {
  runtimeApi = api;
  if (!runtimeDiscardRequested) return true;
  // The factory can enter its pre.js after a terminal request has completed.
  // Tell it not to start main or create a GPU owner, then flush-backed discard
  // that late Module too. Pending first cleanup sees runtimeApi after its flush.
  if (!terminalCleanup || terminalResult) {
    terminalCleanup = terminalResult = null;
    void discardGameRuntime().catch(error => write(String(error), 'err'));
  }
  return false;
}
globalThis.mcWebRuntime = Object.freeze({version: 1, discard: discardGameRuntime,
  get state() { return terminalResult || runtimeApi?.state || {version: 1, phase: 'not-started', saved: false}; }});
addEventListener('pagehide', event => {
  if (event.persisted === false) void discardGameRuntime().catch(error => write(String(error), 'err'));
});
let controlsMessage = '';
const gameControls = mcWebGameControls.create({
  container: document.getElementById('mcweb-game-stage'),
  // pre.js forwards input from the canvas created at Play; before that the
  // placeholder is hidden and receives nothing.
  getCanvas: () => document.querySelector('#game-canvas.on'),
  isReady: () => gameReady,
  onStatus: (state) => {
    if (state.message && state.message !== controlsMessage) write('[controls] ' + state.message);
    controlsMessage = state.message || '';
  },
});
function loadingStatus(message) {
  if (runtimeTerminal || gameReady) return;
  status.textContent = message;
  const loading = document.getElementById('game-loading');
  if (!loading) return;
  document.getElementById('game-loading-status').textContent = message;
  loading.hidden = false;
}
function gameStarted() {
  if (gameReady) return;
  gameReady = true;
  const loading = document.getElementById('game-loading');
  if (loading) loading.hidden = true;
  gameControls.setReady(true);
}
function gameStopped() {
  const loading = document.getElementById('game-loading');
  if (loading) loading.hidden = true;
  gameReady = false;
  gameControls.setReady(false);
  gameControls.releaseAll();
}
// A transferred canvas and JVM heap are single-use. Recovery always starts a
// new document; the authenticated page supplies its durable-save handoff.
function runtimeStopped(message) {
  if (runtimeTerminal) return;
  runtimeTerminal = true;
  delete document.body.dataset.launcherState;
  mobileWake.stop();
  gameStopped();
  document.getElementById('game-canvas')?.classList.remove('on');
  fullscreenButton.disabled = true;
  installButton.disabled = true;
  status.textContent = message + ' Return to the launcher to start again.';
  playButton.textContent = 'Return to launcher';
  playButton.disabled = false;
  playButton.onclick = async () => {
    playButton.disabled = true;
    try {
      if (globalThis.mcWebQuitToLauncher) await globalThis.mcWebQuitToLauncher();
      else location.reload();
    } catch (failure) {
      status.textContent = 'Could not save before returning: ' + (failure.message || failure) + '. Keep this page open and retry.';
      playButton.disabled = false;
    }
  };
  globalThis.mcWebRuntimeStopped?.();
  void discardGameRuntime().catch(failure => {
    status.textContent = message + ' Could not finish saving: ' + (failure.message || failure) + '. Keep this page open and retry returning to the launcher.';
  });
}
fullscreenButton.onclick = () => gameControls.enterFullscreen();
const savedPreference = (key, fallback) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const savePreference = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
};
fullscreenOnPlay.checked = savedPreference('mcweb.fullscreenOnPlay', '0') === '1';
fullscreenOnPlay.onchange = () => savePreference('mcweb.fullscreenOnPlay', fullscreenOnPlay.checked ? '1' : '0');
touchMode.value = savedPreference('mcweb.touchControls', 'auto');
if (!touchMode.value) touchMode.value = 'auto';
gameControls.setTouchMode(touchMode.value);
touchMode.onchange = () => {
  savePreference('mcweb.touchControls', touchMode.value);
  gameControls.setTouchMode(touchMode.value);
};
// Launch memory (memory-profile.js, mobile-runtime.js). Only the iPhone/iPad
// runtime takes an applied bound; desktop Safari uses its bounded defaults,
// while other desktops keep their own heap and the loader's 4 GiB maximum. The bound is read from OPFS once, now, and Play
// awaits that read, so a slow read cannot start the game on the defaults.
const memoryPolicy = { applies: ios, defaults: mobile.memoryLimits(null), limitsFor: mobile.memoryBudgetLimits,
  check: mobile.appliedMemoryLimits };
const launchMemory = mcWebMemoryProfile.loadSelectedBudget(memoryPolicy);
// The desktop limits, for the profile's comparison line: the heap from the
// same arguments Play passes, and the loader's 65536-page maximum.
const heapArguments = mobile.runtimeArguments(['-Xmx' + requestedHeap, '-Xms' + requestedHeap]);
const heapMiB = (flag) => {
  const match = /^-Xm[xs](\\d+)([mg])$/.exec(heapArguments.find((arg) => arg.startsWith(flag)) || '');
  return match ? Number(match[1]) * (match[2] === 'g' ? 1024 : 1) : null;
};
mcWebMemoryProfile.mount({
  container: document.getElementById('memory-profile'),
  policy: memoryPolicy,
  launch: launchMemory,
  desktopCaps: { javaMaxMiB: heapMiB('-Xmx'), javaInitialMiB: heapMiB('-Xms'),
    wasmMaxMiB: boundedRuntime ? mobile.memoryLimits(null).wasmMaxMiB : 4096 },
  releaseKey: mobileRuntimeConfig.cacheKey,
  wake: mobileWake,
  write,
  onPlayBlocked: (reason) => {
    installButton.disabled = playButton.disabled = true;
    status.textContent = reason;
  },
});
</script>
`;
}
