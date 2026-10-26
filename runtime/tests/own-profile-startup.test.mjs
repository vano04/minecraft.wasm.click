import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import vm from 'node:vm';
import { MASSAGE_PLAN } from '../tools/wasmjvm-massage-plan.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const game = join(root, 'build/massaged/minecraft-26.3-massaged.jar');
const profileRules = () => MASSAGE_PLAN.redirect.filter(rule => rule.newName === 'offlineProfileFuture');

test('offline startup source binds the profile and preserves offline service mode', async () => {
  const main = await readFile(join(root, 'src/graal/java/dev/mcweb/graal/BrowserMinecraftMain.java'), 'utf8');
  assert.match(main, /prepareOwnProfile\(uuid, name\);\s*User user = new User\(name, uuid,/);
  assert.match(main, /PreferredGraphicsApi\.DEFAULT,\s*true\s*\)/, 'Offline service mode stays enabled');
  const rules = profileRules();
  assert.equal(rules.length, 1);
  const rule = rules[0];
  assert.equal(rule.entry, 'net/minecraft/client/Minecraft.class');
  assert.equal(rule.in, '<init>');
  assert.equal(rule.inDesc, '(Lnet/minecraft/client/main/GameConfig;)V');
  assert.equal(rule.expect, 1);
});

test('built offline constructor consumes the identity-bound profile without enabling online service mode', {
  skip: !existsSync(game) && !process.env.MCWEB_TEST_PORT_JAR && process.env.MCWEB_REQUIRE_GAME_TESTS !== '1'
    ? 'requires locally built game inputs and JDK 25; set MCWEB_REQUIRE_GAME_TESTS=1 to require this check' : false,
}, async () => {
  const [rule] = profileRules();
  const context = vm.createContext({ Uint8Array, DataView, TextDecoder, TextEncoder, Buffer,
    DecompressionStream, Blob, Response });
  vm.runInContext(await readFile(join(root, 'OpenJDK/browser/jar-massage.js'), 'utf8'), context);
  const api = context.mcWebJarMassage;
  const jar = new Uint8Array(await readFile(game));
  const bytes = await api.readEntry(jar, rule.entry);
  // The build fixture can already contain the new rule after a port rebuild.
  // Reverse it first so the test always exercises the original offline branch.
  let original = bytes;
  try {
    original = api.redirectReferences(bytes, [{ ...rule, owner: rule.newOwner, name: rule.newName,
      newOwner: rule.owner, newName: rule.name }]).bytes;
  } catch (error) { assert.match(String(error), /found 0/); }
  const patched = api.redirectReferences(original, [rule]).bytes;
  assert.throws(() => api.redirectReferences(original, [{ ...rule, expect: 2 }]), /expected 2 site/);
  assert.throws(() => api.redirectReferences(patched, [rule]), /found 0/);
  const temporary = await mkdtemp(join(tmpdir(), 'mcweb-own-profile-startup-'));
  try {
    const classFile = join(temporary, 'Minecraft.class');
    await writeFile(classFile, patched);
    const bytecode = execFileSync('javap', ['-p', '-c', classFile], { encoding: 'utf8' });
    const constructor = bytecode.slice(bytecode.indexOf('public net.minecraft.client.Minecraft('), bytecode.indexOf('\n  private', bytecode.indexOf('public net.minecraft.client.Minecraft(')));
    assert.equal((constructor.match(/BrowserPlayerTextures\.offlineProfileFuture/g) || []).length, 1);
    assert.match(constructor, /Field offlineDeveloperMode:Z[\s\S]*?if(eq|ne)[\s\S]*?aconst_null[\s\S]*?BrowserPlayerTextures\.offlineProfileFuture/);

    const libraries = join(root, 'build/wasmjvm-libraries-26.3');
    const packagedPort = process.env.MCWEB_TEST_PORT_JAR;
    const cp = [packagedPort || join(root, 'OpenJDK/mcweb/mcweb-port.jar'), game,
      ...(await readdir(libraries)).filter(name => name.endsWith('.jar') && !name.includes('natives')).map(name => join(libraries, name))].join(delimiter);
    const probe = join(temporary, 'OwnProfileStartupProbe.java');
    await writeFile(probe, `package dev.mcweb.browser;
import java.util.UUID;
public class OwnProfileStartupProbe {
  static void require(boolean value) { if (!value) throw new AssertionError(); }
  public static void main(String[] args) throws Exception {
    var output = System.out;
    if (Boolean.getBoolean("mcweb.frameDiag")) {
      net.minecraft.server.Bootstrap.STDOUT.flush();
      System.setOut(new java.io.PrintStream(java.io.OutputStream.nullOutputStream()));
    }
    UUID id = UUID.fromString("01234567-89ab-cdef-0123-456789abcdef");
    String json = "{\\"id\\":\\"0123456789abcdef0123456789abcdef\\",\\"name\\":\\"VerifiedPlayer\\",\\"properties\\":[{\\"name\\":\\"textures\\",\\"value\\":\\"signed-public-value\\",\\"signature\\":\\"signed-public-proof\\"}]}";
    var profile = BrowserPlayerTextures.ownProfile(id, json);
    require(profile != null && profile.profile().id().equals(id));
    require(profile.profile().properties().get("textures").iterator().next().hasSignature());
    require(BrowserPlayerTextures.ownProfile(UUID.randomUUID(), json) == null);
    require(BrowserPlayerTextures.ownProfile(id, json.replace("signature", "missing")) == null);
    var startup = BrowserPlayerTextures.class.getDeclaredField("startupProfile");
    startup.setAccessible(true); startup.set(null, profile);
    var future = BrowserPlayerTextures.offlineProfileFuture(null);
    require(future.isDone() && future.join() == profile);
    require(BrowserPlayerTextures.offlineProfileFuture(null).join() == null);
    startup.set(null, profile);
    Object fallback = new Object();
    require(BrowserPlayerTextures.offlineProfileFuture(fallback).join() == fallback);
    require(BrowserPlayerTextures.offlineProfileFuture(null).join() == null);
    BrowserPlayerTextures.prepareOwnProfile(UUID.randomUUID(), "OtherPlayer");
    require(BrowserPlayerTextures.offlineProfileFuture(null).join() == null);
    var discovery = dev.mcweb.graal.BrowserSkinTextureCompat.servicesDiscovery(java.net.Proxy.NO_PROXY);
    var constructor = com.mojang.authlib.services.MinecraftServicesSessionService.class.getDeclaredConstructor(
      com.mojang.authlib.services.ServicesKeySet.class, java.net.Proxy.class,
      com.mojang.authlib.services.MinecraftServicesDiscoveryService.class);
    constructor.setAccessible(true);
    var service = constructor.newInstance(com.mojang.authlib.services.ServicesKeySet.EMPTY,
      java.net.Proxy.NO_PROXY, discovery);
    var gsonField = com.mojang.authlib.services.MinecraftServicesSessionService.class.getDeclaredField("gson");
    gsonField.setAccessible(true);
    gsonField.set(service, ((com.google.gson.Gson) gsonField.get(service)).newBuilder().disableJdkUnsafe().create());
    String skinUrl = "https://textures.minecraft.net/texture/" + "a".repeat(64);
    String capeUrl = "http://textures.minecraft.net/texture/" + "b".repeat(64);
    var payload = new com.google.gson.JsonObject();
    payload.addProperty("timestamp", 1);
    payload.addProperty("profileId", id.toString().replace("-", ""));
    payload.addProperty("profileName", "VerifiedPlayer");
    var textures = new com.google.gson.JsonObject();
    var skin = new com.google.gson.JsonObject(); skin.addProperty("url", skinUrl);
    var metadata = new com.google.gson.JsonObject(); metadata.addProperty("model", "slim");
    skin.add("metadata", metadata); textures.add("SKIN", skin);
    var cape = new com.google.gson.JsonObject(); cape.addProperty("url", capeUrl); textures.add("CAPE", cape);
    payload.add("textures", textures);
    var encoder = java.util.Base64.getEncoder();
    var property = new com.mojang.authlib.properties.Property("textures",
      encoder.encodeToString(payload.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)),
      encoder.encodeToString(new byte[256]));
    boolean allocationFailed = false;
    try { ((com.google.gson.Gson) gsonField.get(service)).fromJson(skin, com.mojang.authlib.minecraft.MinecraftProfileTexture.class); }
    catch (RuntimeException expected) { allocationFailed = expected.toString().contains("Unsafe") && expected.toString().contains("MinecraftProfileTexture"); }
    require(allocationFailed);
    var unavailable = service.unpackTextures(property);
    require(unavailable.skin() == null && unavailable.cape() == null);
    var prepare = BrowserPlayerTextures.class.getDeclaredMethod("prepareTextureGson", com.mojang.authlib.minecraft.SessionService.class);
    prepare.setAccessible(true); prepare.invoke(null, service);
    var parsed = service.unpackTextures(property);
    require(parsed.skin().getUrl().equals(skinUrl));
    require(parsed.skin().getMetadata("model").equals("slim"));
    require(parsed.cape().getUrl().equals(capeUrl));
    require(parsed.signatureState() == com.mojang.authlib.SignatureState.INVALID);
    skin.addProperty("url", "https://example.invalid/texture/" + "a".repeat(64));
    var blocked = new com.mojang.authlib.properties.Property("textures",
      encoder.encodeToString(payload.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)), property.signature());
    try {
      var rejected = service.unpackTextures(blocked);
      require(rejected.skin() == null && rejected.cape() == null);
    } catch (RuntimeException domainRejected) { /* Authlib may reject by exception. */ }
    output.println("PASS real authlib texture fields without Unsafe; original domain rejection and INVALID signature retained");
    output.println("PASS identity binding, signed properties preserved without promotion, single consumption, null fallback");
  }
}
`);
    await mkdir(join(temporary, 'classes'));
    execFileSync('javac', ['-proc:none', '-cp', cp, '-d', join(temporary, 'classes'),
      ...(packagedPort ? [] : [join(root, 'src/graal/java/dev/mcweb/browser/BrowserPlayerTextures.java')]), probe]);
    const result = execFileSync('java', ['-cp', join(temporary, 'classes') + delimiter + cp,
      'dev.mcweb.browser.OwnProfileStartupProbe'], { encoding: 'utf8' });
    assert.match(result, /PASS identity binding/);
    assert.match(result, /PASS real authlib texture fields without Unsafe/);
    assert.doesNotMatch(result, /\[player-textures\]/, 'Default startup diagnostics stay off');
    const diagnostic = execFileSync('java', ['-Dmcweb.frameDiag=true', '-cp', join(temporary, 'classes') + delimiter + cp,
      'dev.mcweb.browser.OwnProfileStartupProbe'], { encoding: 'utf8' });
    assert.match(diagnostic, /startup-consume profile=true fallback=false futureClass=CompletableFuture/);
    assert.match(diagnostic, /startup-preload present=false parsed=false idMatch=false nameMatch=false textureProperties=-1 accepted=false/);
    assert.doesNotMatch(diagnostic, /01234567|VerifiedPlayer|signed-public/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
