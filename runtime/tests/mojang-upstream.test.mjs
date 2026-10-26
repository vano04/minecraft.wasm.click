import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The page loads these as classic scripts; load them the same way.
const load = (path) => {
  const scope = {};
  new Function("globalThis", readFileSync(new URL(path, import.meta.url), "utf8")).call(scope, scope);
  return scope;
};
const { createResolver } = load("../OpenJDK/browser/mojang-upstream.js").mcWebUpstream;
const { mcWebJarMassage: zip } = load("../OpenJDK/browser/jar-massage.js");

const bytes = (text) => new TextEncoder().encode(text);
const sha1 = (data) => createHash("sha1").update(data).digest("hex");
const LIB_URL = "https://libraries.minecraft.net/com/mojang/authlib/6.0.58/authlib-6.0.58.jar";
const SERVER_URL = "https://piston-data.mojang.com/v1/objects/def/server.jar";
const LIB_PATH = "META-INF/libraries/com/mojang/authlib/6.0.58/authlib-6.0.58.jar";
const AUTHLIB = bytes("authlib-bytes");

const EMPTY_ZIP = (() => {
  const empty = new Uint8Array(22);
  new DataView(empty.buffer).setUint32(0, 0x06054b50, true);
  return empty;
})();
/** A STORED jar from {name: bytes}, via the browser's own zip writer. */
const makeJar = (entries) => zip.massageJar(EMPTY_ZIP, () => false, new Map(),
  new Map(Object.entries(entries))).bytes;

const entry = (name, url, data, extra = {}) => ({
  name, url, bytes: data.length, sha256: "0".repeat(64),
  sourceBytes: data.length, sourceSha1: sha1(data), ...extra,
});
const libEntry = (server) => entry("authlib-6.0.58.jar", LIB_URL, AUTHLIB, {
  bundled: { url: SERVER_URL, bytes: server.length, sha1: sha1(server), path: LIB_PATH },
});
/** fetch() over a route table; honours Range on Uint8Array routes, like piston-data. */
const recordingFetch = (routes) => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (!route) return new Response("missing", { status: 404 });
    const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range || "");
    if (range && route instanceof Uint8Array) {
      return new Response(route.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 });
    }
    return new Response(route, { status: 200 });
  };
  return { calls, fetch };
};

test("a Mojang library is read out of Mojang's server jar and checked against its SHA-1", async () => {
  const server = makeJar({ [LIB_PATH]: AUTHLIB, "net/minecraft/server/Main.class": bytes("main") });
  const net = recordingFetch({ [SERVER_URL]: server });
  const resolver = createResolver({ fetch: net.fetch });
  const found = await resolver.resolve(LIB_URL, libEntry(server));
  assert.equal(found.source, "Mojang's server jar");
  assert.deepEqual(found.bytes, AUTHLIB);
  assert.ok(net.calls.every((url) => url === SERVER_URL), net.calls.join("\n"));

  const tampered = makeJar({ [LIB_PATH]: bytes("evil-bytes!!!") });
  const logs = [];
  const strict = createResolver({
    fetch: recordingFetch({ [SERVER_URL]: tampered, [LIB_URL]: new TypeError("Failed to fetch") }).fetch,
    log: (t) => logs.push(t),
  });
  assert.equal(await strict.resolve(LIB_URL, libEntry(tampered)), null,
    "bytes that are not Mojang's are rejected");
  assert.ok(logs.some((l) => l.includes("is not Mojang's")), logs.join("\n"));
});

test("reports what has no source, and remembers a CORS refusal per host", async () => {
  const other = bytes("blocklist-bytes");
  const otherUrl = "https://libraries.minecraft.net/com/mojang/blocklist/1.0.10/blocklist-1.0.10.jar";
  const net = recordingFetch({ [LIB_URL]: new TypeError("Failed to fetch"), [otherUrl]: new TypeError("x") });
  const resolver = createResolver({ fetch: net.fetch });
  assert.equal(await resolver.resolve(LIB_URL, entry("authlib-6.0.58.jar", LIB_URL, AUTHLIB)), null);
  assert.equal(await resolver.resolve(otherUrl, entry("blocklist-1.0.10.jar", otherUrl, other)), null);
  assert.deepEqual(net.calls, [LIB_URL], "the second library does not repeat the refused request");
  await assert.rejects(resolver.fetch(LIB_URL), /no source a web page can read/);
});

test("answers only the no-CORS hosts and, with an asset index, /mcweb-audio/", () => {
  const resolver = createResolver({ fetch: recordingFetch({}).fetch });
  assert.equal(resolver.handles(LIB_URL), true);
  assert.equal(resolver.handles("https://piston-data.mojang.com/v1/objects/abc/client.jar"), false,
    "a host that sends CORS is the page's own fetch");
  assert.equal(resolver.handles("https://example.com/x"), false);
  assert.equal(resolver.handles("http://localhost/mcweb-audio/minecraft/sounds.json"), false);
  resolver.assetIndex = { id: "30", url: "https://piston-meta.mojang.com/index.json", sha1: "0" };
  assert.equal(resolver.handles("http://localhost/mcweb-audio/minecraft/sounds.json"), true);
  assert.equal(resolver.handles("http://localhost/mcweb-audio/../secret"), false);
});

test("an asset comes from Mojang, else a same-origin pass-through, checked against its hash", async () => {
  const sounds = bytes('{"ambient.cave":{}}');
  const hash = sha1(sounds);
  const index = bytes(JSON.stringify({ objects: { "minecraft/sounds.json": { hash, size: sounds.length } } }));
  const INDEX_URL = "https://piston-meta.mojang.com/v1/packages/x/30.json";
  const MOJANG_URL = `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`;
  const LOCAL_URL = "http://localhost/mcweb-audio/minecraft/sounds.json";
  const assetIndex = { id: "30", url: INDEX_URL, sha1: sha1(index) };

  const net = recordingFetch({
    [INDEX_URL]: index, [MOJANG_URL]: new TypeError("Failed to fetch"), [LOCAL_URL]: sounds,
  });
  const resolver = createResolver({ fetch: net.fetch, assetIndex });
  const response = await resolver.fetch(LOCAL_URL);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), sounds);
  assert.deepEqual(net.calls, [INDEX_URL, MOJANG_URL, LOCAL_URL]);
  assert.equal(await resolver.assetDirectUrl("minecraft/sounds.json"), MOJANG_URL);

  const lying = recordingFetch({
    [INDEX_URL]: index, [MOJANG_URL]: new TypeError("x"), [LOCAL_URL]: bytes("not sounds.json"),
  });
  const strict = createResolver({ fetch: lying.fetch, assetIndex });
  assert.equal((await strict.fetch(LOCAL_URL)).status, 404, "a pass-through that changes bytes is refused");
});

test("install() diverts only the URLs it handles", async () => {
  const saved = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).startsWith("https://libraries.minecraft.net/")) throw new TypeError("Failed to fetch");
    return new Response("page");
  };
  try {
    const local = {};
    new Function("globalThis", readFileSync(
      new URL("../OpenJDK/browser/mojang-upstream.js", import.meta.url), "utf8")).call(local, globalThis);
    const resolver = globalThis.mcWebUpstream.install({});
    assert.equal(globalThis.mcWebUpstream.install({}), resolver, "one resolver per page");
    assert.equal(await (await fetch("./payload/manifest.json")).text(), "page");
    await assert.rejects(fetch(LIB_URL, { cache: "no-store" }), /no source a web page can read/);
    assert.deepEqual(seen, ["./payload/manifest.json", LIB_URL]);
  } finally {
    globalThis.fetch = saved;
    delete globalThis.mcWebUpstream;
  }
});
