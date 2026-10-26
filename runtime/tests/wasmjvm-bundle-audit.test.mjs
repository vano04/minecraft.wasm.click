// Entirely original jars, shader text, loader listings and bundle records.
// No Minecraft installation, download, runtime build or browser is required.
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {auditBundle, auditRuntimePreloads, jarTools} from "../tools/wasmjvm-provenance.mjs";
import {MC_VERSION} from "../tools/mc-version.mjs";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The version as it appears inside a RegExp.
const V = MC_VERSION.replaceAll(".", "\\.");
const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");
const ORIGINAL = "fixtureColor = fixtureTint * sin(fixtureCoordinate + fixturePhase);";
const SHADER = `#version 330\nvoid main() {\n  ${ORIGINAL}\n}\n`;
const shaderPath = "assets/fixture/shaders/core/original.fsh";
const empty = new Uint8Array(22);
new DataView(empty.buffer).setUint32(0, 0x06054b50, true);
const jar = (entries) => jarTools().massageJar(empty, () => false, new Map(),
  new Map(Object.entries(entries).map(([path, body]) => [path, new TextEncoder().encode(body)]))).bytes;
const loader = (paths) => JSON.stringify({files: paths.map((filename) => ({filename, start: 0, end: 1}))});
function write(path, bytes) { mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, bytes); }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mcweb-consolidated-audit-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const bundle = join(root, "bundle");
  const original = jar({[shaderPath]: SHADER, "fixture/Reference.class": "original fixture"});
  const library = jar({"fixture/Library.class": "original library", "META-INF/LICENSE": "fixture licence"});
  const reference = join(root, "original.jar");
  write(reference, original);
  const client = {name: `minecraft-${MC_VERSION}-client.jar`, role: "mojang-client-upstream",
    url: "https://piston-data.mojang.com/fixture/client.jar",
    sourceSha1: sha("sha1", original), sourceBytes: original.length,
    // Deliberately different: payload SHA-256 describes massaged bytes, and
    // must never be used to authenticate the original shader reference.
    sha256: "a".repeat(64), bytes: original.length + 23};
  const manifest = {jars: [
    {name: "fixture-library.jar", bytes: library.length, sha256: sha("sha256", library)}, client,
  ]};
  const record = {version: MC_VERSION, clientJarSha256: sha("sha256", original)};
  const persist = () => {
    write(join(bundle, "payload/manifest.json"), JSON.stringify(manifest));
    write(join(bundle, "wasmjvm-manifest.json"), JSON.stringify(record));
  };
  persist();
  write(join(bundle, "payload/jar/fixture-library.jar"), library);
  write(join(bundle, "javavm.js"), loader(["/jdk/lib/modules", "/app/bridge/libmcwebjs.so"]));
  write(join(bundle, "index.html"), "<!doctype html><title>Original fixture</title>");
  write(join(bundle, "host.js"), "const fixtureHost = () => 'original host';");
  const audit = (options = {}) => auditBundle(bundle, {
    clientJarBytes: original, expectedClientSha256: record.clientJarSha256, version: record.version, ...options,
  });
  return {root, bundle, original, reference, manifest, client, record, persist, audit};
}

test("consolidated audit returns archive, runtime-preload and shader statistics", async (t) => {
  const f = fixture(t), result = await f.audit();
  assert.deepEqual(result.violations, []);
  assert.equal(result.served.length, 1);
  assert.equal(result.upstream.length, 1);
  assert.deepEqual(result.preload, {files: 2});
  assert.equal(result.shader.shaderFiles, 1);
  assert.equal(result.shader.lines, 1);
  assert.equal(result.shader.scanned, 5);
});

test("reference is required, readable and consistent with original digest/source metadata", async (t) => {
  const f = fixture(t);
  for (const [name, options, match] of [
    ["missing", {clientJarBytes: undefined}, /original client jar bytes are missing/],
    ["wrong digest", {expectedClientSha256: "0".repeat(64)}, /SHA-256 does not match/],
    ["missing digest", {expectedClientSha256: undefined}, /no valid recorded original client SHA-256/],
    ["wrong version", {version: "other"}, new RegExp(`recorded version ${V}`)],
  ]) await t.test(name, async () => assert.match((await f.audit(options)).violations.join("\n"), match));
  f.client.sourceSha1 = "0".repeat(40); f.client.sourceBytes++;
  f.persist();
  const metadata = (await f.audit()).violations.join("\n");
  assert.match(metadata, /upstream sourceSha1/);
  assert.match(metadata, /upstream sourceBytes/);
  const malformed = new TextEncoder().encode("this is an original non-archive fixture");
  f.client.sourceSha1 = sha("sha1", malformed); f.client.sourceBytes = malformed.length; f.persist();
  const invalid = await f.audit({clientJarBytes: malformed, expectedClientSha256: sha("sha256", malformed)});
  assert.match(invalid.violations.join("\n"), /unreadable original client archive/);
});

test("shaderless and generic-only original references fail closed", async (t) => {
  const f = fixture(t);
  for (const [name, entries] of [
    ["shaderless", {"fixture/Reference.class": "original fixture"}],
    ["degenerate", {[shaderPath]: "#version 330\nvoid main() {\n}\n"}],
  ]) await t.test(name, async () => {
    const bytes = jar(entries);
    f.client.sourceSha1 = sha("sha1", bytes); f.client.sourceBytes = bytes.length; f.persist();
    const result = await f.audit({clientJarBytes: bytes, expectedClientSha256: sha("sha256", bytes)});
    assert.match(result.violations.join("\n"), /no detectable shader fragments/);
  });
});

test("the consolidated shader scan covers root and nested payload text", async (t) => {
  const f = fixture(t);
  write(join(f.bundle, "copied.js"), `const copied = ${JSON.stringify(ORIGINAL)};`);
  write(join(f.bundle, "payload/nested/copied.wgsl"), ORIGINAL);
  const violations = (await f.audit()).violations;
  assert.ok(violations.some((v) => /^copied\.js: \[line\]/.test(v)), violations.join("\n"));
  assert.ok(violations.some((v) => /^payload\/nested\/copied\.wgsl: \[line\]/.test(v)), violations.join("\n"));
});

test("runtime preload helper and consolidated audit refuse empty/forbidden listings", async (t) => {
  const f = fixture(t);
  for (const [text, match] of [
    ["/* original loader without preloads */", /lists no packaged files/],
    [loader(["/jdk/lib/modules", "/app/classes/Fixture.class"]), /not the JDK or the bridge/],
  ]) {
    assert.match(auditRuntimePreloads(text).violations.join("\n"), match);
    write(join(f.bundle, "javavm.js"), text);
    assert.match((await f.audit()).violations.join("\n"), match);
  }
});

test("preload failure display stays bounded while reporting every forbidden path count", () => {
  const paths = Array.from({length: 25}, (_, i) => `/app/fixture/Forbidden${i}.class`);
  const result = auditRuntimePreloads(loader(paths));
  assert.equal(result.files, 25);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /Forbidden9\.class/);
  assert.doesNotMatch(result.violations[0], /Forbidden10\.class/);
  assert.match(result.violations[0], /15 more forbidden path\(s\)/);
});

test("payload outside jar is recursively checked for loose content and archives", async (t) => {
  const f = fixture(t);
  for (const path of ["loose.png", "payload/loose.ogg", "payload/nested/pack.mcmeta", "payload/nested/hidden.jar"])
    write(join(f.bundle, path), "original prohibited fixture bytes");
  const violations = (await f.audit()).violations.join("\n");
  for (const path of ["loose.png", "payload/loose.ogg", "payload/nested/pack.mcmeta", "payload/nested/hidden.jar"])
    assert.ok(violations.includes(path + ": game-content file type"), violations);
});

test("listed archive contents, unlisted archives and missing listed jars are checked", async (t) => {
  const f = fixture(t);
  write(join(f.bundle, "payload/jar/fixture-library.jar"), jar({"assets/minecraft/fixture.txt": "original policy-test bytes"}));
  write(join(f.bundle, "payload/jar/unlisted.jar"), jar({"fixture/Unlisted.class": "original"}));
  f.manifest.jars.push({name: "missing.jar"}); f.persist();
  const violations = (await f.audit()).violations.join("\n");
  assert.match(violations, /fixture-library\.jar: assets\/minecraft\/fixture\.txt/);
  assert.match(violations, /payload\/jar\/unlisted\.jar: served but not in the manifest/);
  assert.match(violations, /missing\.jar: listed in the manifest but missing/);
});

function cliProject(f) {
  const project = join(f.root, "project");
  for (const path of ["tools/audit-wasmjvm-bundle.mjs", "tools/wasmjvm-provenance.mjs", "tools/mc-installation.mjs", "tools/mc-version.mjs", "OpenJDK/browser/jar-massage.js"]) {
    const target = join(project, path); mkdirSync(dirname(target), {recursive: true});
    copyFileSync(join(PROJECT, path), target);
  }
  const fixtureUserRoot = join(f.root, "fixture-user"); mkdirSync(fixtureUserRoot);
  const preload = join(f.root, "fixture-user-preload.mjs");
  write(preload, `import os from "node:os";
import {syncBuiltinESMExports} from "node:module";
os.homedir = () => process.env.MCWEB_AUDIT_FIXTURE_USER_ROOT;
syncBuiltinESMExports();
`);
  const run = (...args) => spawnSync(process.execPath,
    ["--import", preload, join(project, "tools/audit-wasmjvm-bundle.mjs"), ...args], {
      encoding: "utf8", env: {MCWEB_AUDIT_FIXTURE_USER_ROOT: fixtureUserRoot},
    });
  return {project, fixtureUserRoot, run};
}

test("CLI accepts explicit reference and refuses explicit bad paths without cache fallback", (t) => {
  const f = fixture(t), c = cliProject(f);
  const cache = join(c.project, `build/mojang-cache/versions/${MC_VERSION}/${MC_VERSION}.jar`);
  write(cache, f.original);
  const clean = c.run(f.bundle, "--client-jar", f.reference);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /runtime preloads: +2 files/);
  assert.match(clean.stdout, /shader text: +5 served text files against 1 shader files/);
  const missing = c.run("--client-jar", join(f.root, "absent.jar"), f.bundle);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read original client reference .*absent\.jar/);
  assert.doesNotMatch(missing.stderr, /Mojang-owned item/);
  assert.match(missing.stderr, new RegExp(`--client-jar.*local original Minecraft ${V} client jar`));
  const invalid = join(f.root, "invalid.jar"); write(invalid, "original invalid fixture");
  const malformed = c.run(f.bundle, "--client-jar", invalid);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /original client SHA-256 does not match/);
  assert.match(malformed.stderr, new RegExp(`--client-jar.*local original Minecraft ${V} client jar`));
  f.record.clientJarSha256 = sha("sha256", readFileSync(invalid));
  f.client.sourceSha1 = sha("sha1", readFileSync(invalid));
  f.client.sourceBytes = readFileSync(invalid).length;
  f.persist();
  const invalidArchive = c.run(f.bundle, "--client-jar", invalid);
  assert.equal(invalidArchive.status, 1);
  assert.match(invalidArchive.stderr, /unreadable original client archive/);
  assert.match(invalidArchive.stderr, new RegExp(`--client-jar.*local original Minecraft ${V} client jar`));
});

test("CLI prefers local cache, keeps default bundle dir, then resolves installation read-only", (t) => {
  const f = fixture(t), c = cliProject(f);
  const cache = join(c.project, `build/mojang-cache/versions/${MC_VERSION}/${MC_VERSION}.jar`);
  write(cache, f.original);
  const cached = c.run(f.bundle);
  assert.equal(cached.status, 0, cached.stdout + cached.stderr);
  // The default directory is tested with original fixture files only.
  const copy = (relative) => write(join(c.project, "dist/wasmjvm", relative), readFileSync(join(f.bundle, relative)));
  for (const path of ["wasmjvm-manifest.json", "payload/manifest.json", "payload/jar/fixture-library.jar", "javavm.js", "index.html", "host.js"]) copy(path);
  const defaultDir = c.run();
  assert.equal(defaultDir.status, 0, defaultDir.stdout + defaultDir.stderr);
  rmSync(cache);
  const versionDir = join(c.fixtureUserRoot, `.minecraft/versions/${MC_VERSION}`);
  write(join(versionDir, `${MC_VERSION}.jar`), f.original);
  write(join(versionDir, `${MC_VERSION}.json`), JSON.stringify({id: MC_VERSION, libraries: [{name: "fixture:missing:1"}]}));
  const installation = c.run(f.bundle);
  assert.equal(installation.status, 0, installation.stdout + installation.stderr);
  // No libraries exist. A successful audit proves it didn't resolve them.
  rmSync(join(c.fixtureUserRoot, ".minecraft"), {recursive: true});
  const absent = c.run(f.bundle);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, new RegExp(`cannot locate a usable local original Minecraft ${V} client reference`));
  assert.match(absent.stderr, new RegExp(`--client-jar.*local original Minecraft ${V} client jar`));
  assert.doesNotMatch(absent.stderr, /--download|--mc-dir/);
});


test("actual CLI applies shader, payload and runtime checks together", (t) => {
  const f = fixture(t), c = cliProject(f);
  write(join(f.bundle, "payload/nested/copied.js"), ORIGINAL);
  write(join(f.bundle, "payload/nested/loose.png"), "original fixture bytes");
  write(join(f.bundle, "javavm.js"), loader(["/app/classes/Fixture.class"]));
  const result = c.run(f.bundle, "--client-jar", f.reference);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /payload\/nested\/copied\.js: \[line\]/);
  assert.match(result.stderr, /payload\/nested\/loose\.png: game-content file type/);
  assert.match(result.stderr, /not the JDK or the bridge/);
});
