#!/usr/bin/env node
// audit-wasmjvm-bundle - check the same publication rules as the builder.
//
//   node tools/audit-wasmjvm-bundle.mjs              # dist/wasmjvm
//   node tools/audit-wasmjvm-bundle.mjs path/to/dir --client-jar /local/original.jar
//
// The local original reference is read only. It is never downloaded, resolved
// with libraries or copied into the bundle. Without --client-jar, prefer the
// build cache, then locate a developer installation without downloading.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInstallationResolver, exists } from "./mc-installation.mjs";
import { auditBundle } from "./wasmjvm-provenance.mjs";
import { MC_VERSION } from "./mc-version.mjs";

const PROJECT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REFERENCE_GUIDANCE = `Use --client-jar /path/to/original-${MC_VERSION}.jar with a local original Minecraft ${MC_VERSION} client jar (not a massaged jar).`;

function options(args) {
  let bundle, clientJar;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--client-jar") {
      if (clientJar !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) {
        throw new Error("--client-jar requires one explicit file path");
      }
      clientJar = resolve(args[++i]);
    } else if (args[i].startsWith("--")) {
      throw new Error(`unknown option ${args[i]}`);
    } else if (bundle !== undefined) {
      throw new Error("expected at most one bundle directory");
    } else bundle = resolve(args[i]);
  }
  return {bundle: bundle ?? join(PROJECT, "dist", "wasmjvm"), clientJar};
}

async function referencePath(explicit, version) {
  if (explicit !== undefined) return explicit;
  if (version !== MC_VERSION) throw new Error(`shader reference requires recorded version ${MC_VERSION}`);
  const cached = join(PROJECT, "build", "mojang-cache", "versions", version, `${version}.jar`);
  if (await exists(cached)) return cached;
  const {locateInstallation, clientJarPath} = createInstallationResolver({
    version, noAudio: true, say: () => {}, die: (message) => { throw new Error(message); },
  });
  // This CLI deliberately supports neither installation flags nor downloads.
  // Keep resolver failures from recommending those unrelated builder options.
  try {
    const install = await locateInstallation({download: false});
    const manifest = JSON.parse(await readFile(install.manifest, "utf8"));
    return clientJarPath(install, manifest);
  } catch {
    throw new Error(`cannot locate a usable local original Minecraft ${MC_VERSION} client reference`);
  }
}

try {
  const {bundle: dir, clientJar} = options(process.argv.slice(2));
  const record = JSON.parse(await readFile(join(dir, "wasmjvm-manifest.json"), "utf8"));
  let reference, clientJarBytes;
  try {
    reference = await referencePath(clientJar, record.version);
    clientJarBytes = await readFile(reference);
  } catch (error) {
    const detail = reference ? `cannot read original client reference ${reference}: ${error.message}` : error.message;
    throw new Error(`${detail}\n${REFERENCE_GUIDANCE}`);
  }
  const {violations, served, upstream, preload, shader} = await auditBundle(dir, {
    clientJarBytes, expectedClientSha256: record.clientJarSha256, version: record.version,
  });
  if (violations.length) {
    console.error(`${dir}: ${violations.length} publication audit failure(s):`);
    for (const violation of violations) console.error(`  ${violation}`);
    if (violations.some((violation) => violation.startsWith("shader reference"))) {
      console.error(`  ${REFERENCE_GUIDANCE}`);
    }
    process.exitCode = 1;
  } else {
    const mib = (n) => (n / 1048576).toFixed(1);
    console.log(`${dir}: clean`);
    console.log(`  served by the bundle:  ${served.length} jars, `
      + `${mib(served.reduce((sum, j) => sum + j.bytes, 0))} MiB (MC-Web's own + third-party open source)`);
    console.log(`  fetched from Mojang:   ${upstream.length} jars, `
      + `${mib(upstream.reduce((sum, j) => sum + (j.sourceBytes ?? 0), 0))} MiB`);
    console.log(`  runtime preloads:     ${preload.files} files, JDK image and bridge only`);
    console.log(`  shader text:          ${shader.scanned} served text files against ${shader.shaderFiles} shader files `
      + `(${shader.lines} lines, ${shader.runs} constant runs, ${shader.members} member runs)`);
    const unlicensed = served.filter((j) => j.maven && j.licenseFiles.length === 0);
    if (unlicensed.length) {
      console.log(`  note: ${unlicensed.length} redistributed librar${unlicensed.length === 1 ? "y carries" : "ies carry"} `
        + "no licence file of its own; THIRD-PARTY.json records its coordinates:");
      for (const jar of unlicensed) console.log(`    ${jar.maven}`);
    }
  }
} catch (error) {
  console.error(`audit-wasmjvm-bundle: audit failed: ${error.message}`);
  process.exitCode = 1;
}
