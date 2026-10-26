// Locate, or download, a player's own Minecraft installation and resolve the
// classpath it implies.
//
// Both bundle builders need exactly this and nothing else from a launcher:
// tools/build-cb10.mjs (GraalVM Web Image) and tools/build-wasmjvm.mjs (the
// OSS OpenJDK-on-wasm lane). Keeping one copy means a launcher layout that
// works for one lane works for the other.
//
// Nothing here uploads, mutates or redistributes a game file. Downloads are
// public CDN objects verified by SHA-1; a located installation is read-only.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, platform, arch } from "node:os";
import { basename, join, resolve } from "node:path";

const VERSION_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const RESOURCES = "https://resources.download.minecraft.net";

export const exists = async (p) => !!(await stat(p).catch(() => null));
export const fileHash = async (algorithm, path) =>
  createHash(algorithm).update(await readFile(path)).digest("hex");

// group:artifact:version[:classifier] -> group/path/artifact/version/artifact-version[-classifier].jar
export function mavenPath(name) {
  const [group, artifact, ver, classifier] = name.split(":");
  const file = `${artifact}-${ver}${classifier ? `-${classifier}` : ""}.jar`;
  return join(group.replace(/\./g, "/"), artifact, ver, file);
}

function osName() {
  const p = platform();
  return p === "darwin" ? "osx" : p === "win32" ? "windows" : "linux";
}

// Mojang's manifest gates libraries behind allow/disallow rules keyed on OS.
export function ruleAllows(rules) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let matches = true;
    if (rule.os?.name && rule.os.name !== osName()) matches = false;
    if (rule.os?.arch && rule.os.arch !== (arch() === "x64" ? "x86_64" : arch())) matches = false;
    if (matches) allowed = rule.action === "allow";
  }
  return allowed;
}

// Natives are irrelevant to a browser target and must not reach the classpath. They
// appear as a maven classifier naming a platform - "natives-macos", but also bare
// forms like netty's "osx-aarch_64" - and launchers only download the one matching
// the host, so treating them as required would fail the build on jars we must not
// use anyway.
export function isNativeCoord(name) {
  const [, artifact = "", , classifier] = name.split(":");
  // Prism encodes natives as their own artifact ("com.mojang:jtracy-natives-macos"),
  // Mojang as a classifier on a shared artifact. Both must be skipped.
  if (/-natives(-|$)/i.test(artifact)) return true;
  return !!classifier && /natives|linux|windows|osx|macos|x86|aarch|arm/i.test(classifier);
}

/**
 * Spawn a child process, inheriting stdio, and reject on a non-zero exit.
 *
 * Node cannot exec a .bat/.cmd directly (EINVAL on Windows); batch launchers
 * such as gradlew.bat have to go through the command processor.
 */
export function run(cmd, args, opts = {}) {
  return new Promise((ok, no) => {
    let command = cmd;
    let argList = args;
    if (process.platform === "win32" && /\.(bat|cmd)$/i.test(cmd)) {
      command = process.env.ComSpec || "cmd.exe";
      argList = ["/c", cmd, ...args];
    }
    const child = spawn(command, argList, { stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? ok() : no(new Error(`${cmd} exited ${code}`))));
    child.on("error", no);
  });
}

/**
 * @param {object} options
 * @param {string} options.version   Minecraft version, e.g. "26.3".
 * @param {(...a: unknown[]) => void} options.say   progress reporter.
 * @param {(message: string) => never} options.die  fatal-error reporter.
 * @param {boolean} [options.noAudio] skip sound objects when downloading.
 */
export function createInstallationResolver({ version, say, die, noAudio = false }) {
  // ------------------------------------------------------------ installation

  // Both the official launcher and PrismLauncher use the same
  // versions/libraries/assets layout; Prism just nests it per-instance. Accept
  // either, and let an explicit directory win.
  function candidateRoots() {
    const home = homedir();
    const mac = platform() === "darwin";
    const roots = [];
    if (mac) {
      roots.push(join(home, "Library/Application Support/minecraft"));
      roots.push(join(home, "Library/Application Support/PrismLauncher"));
    }
    roots.push(join(home, ".minecraft"));
    roots.push(join(home, ".local/share/PrismLauncher"));
    roots.push(join(home, ".var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher"));
    if (process.env.APPDATA) {
      roots.push(join(process.env.APPDATA, ".minecraft"));
      roots.push(join(process.env.APPDATA, "PrismLauncher"));
    }
    return roots;
  }

  // A usable root is one that actually has this version's manifest somewhere under it.
  async function findVersionManifest(root) {
    const direct = join(root, "versions", version, `${version}.json`);
    if (await exists(direct)) {
      return {
        kind: "mojang", manifest: direct,
        librariesRoot: join(root, "libraries"), assetsRoot: join(root, "assets"),
      };
    }
    // PrismLauncher stores its own meta format under meta/<uid>/<version>.json and shares
    // libraries/assets at the root. The schema differs from Mojang's: libraries carry maven
    // coordinates with no path, and LWJGL lives in a separate component reached via "requires".
    const prismMeta = join(root, "meta", "net.minecraft", `${version}.json`);
    if (await exists(prismMeta)) {
      return {
        kind: "prism", manifest: prismMeta, metaRoot: join(root, "meta"),
        librariesRoot: join(root, "libraries"), assetsRoot: join(root, "assets"),
      };
    }
    return null;
  }

  // ---------------------------------------------------------------- download
  //
  // Mirrors what PrismLauncher does, minus the parts that do not apply. Its auth flow
  // (MSA -> XboxUser -> XboxAuthorization -> LauncherLogin -> Entitlements -> Profile)
  // exists for ownership, profile and session; it is NOT used to fetch game files.
  // Assets, libraries and the client jar are public CDN downloads, verified by SHA-1.
  // So downloading needs no credentials; ownership verification is a separate concern.

  /**
   * One GET, retried.
   *
   * A build pulls a manifest, a client jar, ~55 libraries and (with audio) several
   * thousand sound objects from CDNs that occasionally refuse a connection. Without
   * retries a single ETIMEDOUT anywhere in that sequence aborts the whole build,
   * which is what happens in practice: hosts behind Azure Front Door time out on
   * one address family while the other is unreachable, and the aggregate error is
   * fatal. Retry the transient classes only; a 404 will not improve.
   */
  async function fetchRetry(url, attempts = 4) {
    let last = "";
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetch(url);
        if (response.ok) return response;
        if (response.status < 500 && response.status !== 408 && response.status !== 429) {
          die(`GET ${url} -> HTTP ${response.status}`);
        }
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = error?.cause?.code || error?.cause?.errors?.[0]?.code || error?.message || String(error);
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    die(`GET ${url} failed after ${attempts} attempts (${last})`);
  }

  const fetchJson = async (url) => (await fetchRetry(url)).json();

  // Verified, resumable-by-skipping download: an already-correct file is never refetched,
  // which matters because a full pull is thousands of small asset objects.
  async function download(url, dest, expectedSha1) {
    if (await exists(dest)) {
      if (!expectedSha1 || (await fileHash("sha1", dest)) === expectedSha1) return false;
    }
    await mkdir(join(dest, ".."), { recursive: true });
    const response = await fetch(url);
    if (!response.ok) die(`GET ${url} -> HTTP ${response.status}`);
    await writeFile(dest, Buffer.from(await response.arrayBuffer()));
    if (expectedSha1) {
      const actual = await fileHash("sha1", dest);
      if (actual !== expectedSha1) {
        die(`checksum mismatch for ${url}\n  expected ${expectedSha1}\n  got      ${actual}`);
      }
    }
    return true;
  }

  async function pool(items, limit, worker) {
    let index = 0;
    let done = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index++];
        await worker(item);
        done++;
        if (done % 250 === 0) process.stdout.write(`\r  ${done}/${items.length}`);
      }
    });
    await Promise.all(runners);
    if (items.length >= 250) process.stdout.write(`\r  ${items.length}/${items.length}\n`);
  }

  // Lays the download out exactly like a vanilla .minecraft directory so the ordinary
  // resolver above can consume it with no special cases.
  async function downloadInstallation(cacheDir) {
    say(`downloading ${version} into ${cacheDir}`);
    const manifest = await fetchJson(VERSION_MANIFEST);
    const entry = (manifest.versions ?? []).find((v) => v.id === version);
    if (!entry) die(`version ${version} is not in the Mojang manifest`);

    const versionDir = join(cacheDir, "versions", version);
    const versionJson = join(versionDir, `${version}.json`);
    await mkdir(versionDir, { recursive: true });
    await download(entry.url, versionJson, entry.sha1);
    const client = JSON.parse(await readFile(versionJson, "utf8"));

    say("  client jar");
    await download(client.downloads.client.url, join(versionDir, `${version}.jar`),
      client.downloads.client.sha1);

    const libs = (client.libraries ?? []).filter((l) => ruleAllows(l.rules)
      && !(l.name && isNativeCoord(l.name)) && l.downloads?.artifact?.path);
    say(`  ${libs.length} libraries`);
    await pool(libs, 8, (lib) => download(
      lib.downloads.artifact.url, join(cacheDir, "libraries", lib.downloads.artifact.path),
      lib.downloads.artifact.sha1));

    if (noAudio) {
      say("  skipping sound objects (--no-audio)");
      say("download complete");
      return;
    }

    // Only sounds are needed on disk: every texture and data file already lives inside
    // the client jar, and audio staging wants sounds.json plus the .ogg objects.
    const assetIndexId = client.assetIndex.id;
    const indexPath = join(cacheDir, "assets", "indexes", `${assetIndexId}.json`);
    await download(client.assetIndex.url, indexPath, client.assetIndex.sha1);
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const allObjects = Object.entries(index.objects ?? {});
    const sounds = allObjects.filter(([name]) =>
      name.endsWith("/sounds.json") || (name.includes("/sounds/") && name.endsWith(".ogg")));
    say(`  ${sounds.length} sound objects (of ${allObjects.length} total)`);
    await pool(sounds, 16, ([, meta]) => {
      const rel = `${meta.hash.slice(0, 2)}/${meta.hash}`;
      return download(`${RESOURCES}/${rel}`, join(cacheDir, "assets", "objects", rel), meta.hash);
    });

    say("download complete");
  }

  /**
   * @param {object} [where]
   * @param {boolean} [where.download] fetch game files into cacheDir first.
   * @param {string} [where.cacheDir]  destination for --download.
   * @param {string} [where.mcDir]     an explicit installation root.
   */
  async function locateInstallation(where = {}) {
    if (where.download) {
      const cacheDir = resolve(where.cacheDir);
      await downloadInstallation(cacheDir);
      const found = await findVersionManifest(cacheDir);
      if (!found) die(`download completed but ${cacheDir} is not usable`);
      return { root: cacheDir, ...found };
    }
    const roots = where.mcDir
      ? [resolve(where.mcDir.replace(/^~/, homedir()))]
      : candidateRoots();
    for (const root of roots) {
      if (!(await exists(root))) continue;
      const found = await findVersionManifest(root);
      if (found) return { root, ...found };
    }
    die(`no Minecraft ${version} installation found.\n`
      + `  Looked in:\n${roots.map((r) => `    ${r}`).join("\n")}\n`
      + `  Pass --mc-dir /path/to/.minecraft if yours is elsewhere.`);
  }

  // --------------------------------------------------------------- classpath

  async function collectLibraries(components, librariesRoot, kind) {
    const jars = [];
    const records = [];
    const missing = [];
    const seen = new Set();
    for (const manifest of components) {
      for (const lib of manifest.libraries ?? []) {
        if (!ruleAllows(lib.rules)) continue;
        if (lib.name && isNativeCoord(lib.name)) continue;
        // Mojang manifests give an explicit path; Prism's only give maven coordinates.
        const relative = kind === "mojang"
          ? lib.downloads?.artifact?.path
          : lib.name && mavenPath(lib.name);
        if (!relative || seen.has(relative)) continue;
        seen.add(relative);
        const file = join(librariesRoot, relative);
        if (await exists(file)) {
          jars.push(file);
          // Where the launcher got it from, so a bundle can tell the browser to
          // fetch it from the same place instead of serving it. Both layouts
          // usually carry downloads.artifact; when one does not, the caller
          // derives the values from the local file.
          const artifact = lib.downloads?.artifact ?? {};
          records.push({
            file,
            relative: relative.split("\\").join("/"),
            name: lib.name ?? null,
            url: artifact.url ?? null,
            sha1: artifact.sha1 ?? null,
            size: Number.isSafeInteger(artifact.size) ? artifact.size : null,
          });
        } else {
          missing.push(relative);
        }
      }
    }
    return { jars, records, missing };
  }

  async function resolveLibraries(install) {
    const manifest = JSON.parse(await readFile(install.manifest, "utf8"));
    if (manifest.inheritsFrom) {
      die(`${basename(install.manifest)} inherits from ${manifest.inheritsFrom} (a modded profile).\n`
        + `  Build from a vanilla ${version} installation.`);
    }
    const components = [manifest];
    if (install.kind === "prism") {
      // Follow "requires" so LWJGL and friends come along; one level is enough in practice.
      for (const req of manifest.requires ?? []) {
        const reqVersion = req.suggests ?? req.equals;
        if (!req.uid || !reqVersion) continue;
        const path = join(install.metaRoot, req.uid, `${reqVersion}.json`);
        if (await exists(path)) components.push(JSON.parse(await readFile(path, "utf8")));
        else say(`  warning: required component ${req.uid} ${reqVersion} not found at ${path}`);
      }
    }
    const { jars, records, missing } =
      await collectLibraries(components, install.librariesRoot, install.kind);
    return { manifest, jars, records, missing };
  }

  /** The client jar a located installation implies, for either layout. */
  function clientJarPath(install, manifest) {
    return install.kind === "prism"
      ? join(install.librariesRoot,
          mavenPath(manifest.mainJar?.name ?? `com.mojang:minecraft:${version}:client`))
      : join(install.root, "versions", version, `${version}.jar`);
  }

  return {
    locateInstallation, resolveLibraries, clientJarPath,
    downloadInstallation, findVersionManifest, mavenPath,
    fetchRetry, fetchJson, download, pool,
  };
}
