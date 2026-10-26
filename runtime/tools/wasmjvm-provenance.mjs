// What a published wasmjvm bundle may serve, and a check that it serves nothing
// else.
//
// The rule this project publishes under: the site serves no Mojang-owned bytes.
// The browser fetches Mojang's files from Mojang and verifies them against
// the digests Mojang publishes. The audit uses a developer-local original
// client jar as its reference; that jar is never served. Everything the site
// itself serves is either MC-Web's own code,
// OpenJDK, or a third-party open-source library it may redistribute.
//
// Two packaging regressions this module prevents:
//
//  - Mojang's own libraries (authlib, blocklist, text2speech, ...) sat in
//    payload/jar beside the open-source ones, because only the client jar was
//    switched to an upstream fetch.
//  - mcweb-port.jar packs src/graal/resources, which is where
//    tools/stage-mojang-assets.mjs copies the real panorama faces from the
//    player's asset store. A developer checkout that had run it published
//    Mojang textures inside the port jar.
//
// Archive ownership checks read the central directory; the shader-text check
// also reads the original reference jar's shader entries. Both run on every build.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MC_VERSION } from "./mc-version.mjs";

const PROJECT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Maven groups whose artifacts are Mojang's. Some of them are open source
 * (brigadier and DataFixerUpper are MIT), but the policy is by owner, not by
 * licence: it needs no per-artifact legal judgement, it cannot go stale when a
 * new Mojang library appears, and the cost is only that a few small jars come
 * from Mojang instead of from the site.
 */
export const MOJANG_GROUPS = Object.freeze(["com.mojang", "net.minecraft"]);

/** Hosts a bundle may name as the upstream source of a Mojang file. */
export const MOJANG_HOST = /(^|\.)(mojang\.com|minecraft\.net)$/;

export const mavenGroup = (coordinate) => String(coordinate ?? "").split(":")[0];

/**
 * @param {{name?: string|null, relative?: string|null}} library
 *   a record from mc-installation's resolveLibraries.
 */
export function isMojangOwnedLibrary(library) {
  const group = library?.name ? mavenGroup(library.name) : null;
  if (group) return MOJANG_GROUPS.includes(group);
  // No coordinate: fall back to the repository path, which encodes the group.
  const path = String(library?.relative ?? "").replace(/\\/g, "/");
  return MOJANG_GROUPS.some((g) => path.startsWith(g.replace(/\./g, "/") + "/"));
}

// ----------------------------------------------------------------- archives

let massager = null;
/** The browser's own zip reader, loaded the way build-wasmjvm loads it. */
export function jarTools(projectRoot = PROJECT) {
  if (massager) return massager;
  const source = readFileSync(join(projectRoot, "OpenJDK", "browser", "jar-massage.js"), "utf8");
  const scope = {};
  new Function("globalThis", source).call(scope, scope);
  massager = scope.mcWebJarMassage;
  return massager;
}

/**
 * Classes MC-Web itself writes in Mojang's packages: ABI shadows such as the
 * canvas-backed com.mojang.blaze3d.platform.Window. They are this project's
 * code, compiled from src/graal/java, and are the only Mojang-namespace
 * classes a served jar may contain. Returned as class-file stems
 * ("com/mojang/blaze3d/platform/Window").
 */
export function authoredShadowClasses(projectRoot = PROJECT) {
  const stems = new Set();
  const roots = [
    join(projectRoot, "src", "graal", "java"),
    join(projectRoot, "OpenJDK", "mcweb", "shim-src"),
    join(projectRoot, "OpenJDK", "mcweb", "boot-src"),
  ];
  const walk = (root, dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(root, path);
      else if (name.endsWith(".java")) {
        stems.add(relative(root, path).split("\\").join("/").replace(/\.java$/, ""));
      }
    }
  };
  for (const root of roots) walk(root, root);
  return new Set([...stems].filter((stem) =>
    MOJANG_GROUPS.some((g) => stem.startsWith(g.replace(/\./g, "/") + "/"))));
}

const MOJANG_CLASS = /^(net\/minecraft|com\/mojang)\/.+\.class$/;
// Resource namespaces only Mojang's jar and asset store populate.
const MOJANG_RESOURCE = /^(assets|data)\/(minecraft|realms)\//;
// Files that exist only at the root of the client jar, or are derived from it.
const MOJANG_ROOT_FILE = new Set([
  "version.json", "pack.mcmeta", "pack.png", "flightrecorder-config.jfc",
  "mcweb-asset-index.txt",
]);
const MOJANG_SIGNATURE = /^META-INF\/MOJANG[^/]*\.(SF|RSA|DSA|EC)$/i;

/** The stem a class entry was compiled from: Foo$Bar$1.class -> Foo. */
const classStem = (entry) => entry.replace(/\.class$/, "").replace(/\$.*$/, "");

/**
 * Mojang-owned entries in one archive MC-Web would serve.
 *
 * @param {string[]} names entry names
 * @param {{allowedShadows?: Set<string>}} [options]
 *   stems of Mojang-namespace classes this jar may carry because MC-Web wrote
 *   them. Pass it only for jars built from this repository's sources.
 * @returns {{entry: string, reason: string}[]}
 */
export function auditJarEntries(names, { allowedShadows = new Set() } = {}) {
  const violations = [];
  for (const entry of names) {
    if (entry.endsWith("/")) continue;
    if (MOJANG_CLASS.test(entry)) {
      if (!allowedShadows.has(classStem(entry))) {
        violations.push({ entry, reason: "Mojang-namespace class not written by MC-Web" });
      }
    } else if (MOJANG_RESOURCE.test(entry)) {
      violations.push({ entry, reason: "Mojang resource namespace" });
    } else if (MOJANG_ROOT_FILE.has(entry)) {
      violations.push({ entry, reason: "client-jar root file" });
    } else if (MOJANG_SIGNATURE.test(entry)) {
      violations.push({ entry, reason: "Mojang signature" });
    } else if (/\.ogg$/i.test(entry)) {
      violations.push({ entry, reason: "audio object (Mojang's sounds live in its asset store)" });
    }
  }
  return violations;
}

/** Licence and notice files a redistributed library carries. */
export const licenseFiles = (names) => names.filter((name) =>
  /^(META-INF\/)?([^/]*\/)?(LICEN[CS]E|NOTICE|COPYING)[^/]*$/i.test(name) && !name.endsWith("/"));

// ------------------------------------------------------------------- bundle

const ROLES_BUILT_HERE = new Set(["native-policy"]);
const PORT_JAR = /^mcweb-port(\.[0-9a-f]{16,64})?\.jar$/;

/** Audit the file-packager listing before any runtime data is published. */
export function auditRuntimePreloads(loaderText) {
  const packed = [...String(loaderText).matchAll(/"filename":\s*"([^"]+)"/g)].map((m) => m[1]);
  const violations = [];
  if (packed.length === 0) violations.push("javavm.js lists no packaged files; relink it");
  const stray = packed.filter((p) => !p.startsWith("/jdk/") && p !== "/app/bridge/libmcwebjs.so");
  if (stray.length) {
    const more = stray.length > 10 ? `\n    ... ${stray.length - 10} more forbidden path(s)` : "";
    violations.push("javavm.data packs files that are not the JDK or the bridge:\n    "
      + stray.slice(0, 10).join("\n    ") + more);
  }
  return {violations, files: packed.length};
}

const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");

/**
 * Audits a packaged bundle directory. Nothing about the bundle is trusted:
 * the manifest, every file under payload/jar and every other file served are
 * read from disk.
 *
 * clientJarBytes is a developer-local ORIGINAL client, never the massaged
 * payload. Its digest/version must match the build record and upstream source
 * metadata. These checks establish consistency with that record.
 *
 * @returns {Promise<{violations: string[], served: object[], upstream: object[],
 *   preload: {files: number}, shader: object|null}>}
 */
export async function auditBundle(bundleDir, {
  projectRoot = PROJECT, clientJarBytes, expectedClientSha256, version,
} = {}) {
  const tools = jarTools(projectRoot);
  const shadows = authoredShadowClasses(projectRoot);
  const violations = [];
  const manifest = JSON.parse(await readFile(join(bundleDir, "payload", "manifest.json"), "utf8"));
  const served = [];
  const upstream = [];
  const listed = new Set();

  for (const jar of manifest.jars ?? []) {
    if (jar.url) {
      let host = "";
      try { host = new URL(jar.url).host; } catch { /* reported below */ }
      if (!jar.url.startsWith("https://") || !MOJANG_HOST.test(host)) {
        violations.push(`${jar.name}: upstream URL is not a Mojang host: ${jar.url}`);
      }
      if (!/^[0-9a-f]{40}$/.test(jar.sourceSha1 ?? "")) {
        violations.push(`${jar.name}: upstream entry has no SHA-1 to verify against`);
      }
      upstream.push(jar);
      continue;
    }
    listed.add(jar.name);
    if (/^minecraft-.*\.jar$/i.test(jar.name)) {
      violations.push(`${jar.name}: a Minecraft jar is served from the bundle`);
    }
    if (jar.maven && MOJANG_GROUPS.includes(mavenGroup(jar.maven))) {
      violations.push(`${jar.name}: Mojang library ${jar.maven} is served from the bundle`);
    }
    let bytes;
    try {
      bytes = new Uint8Array(await readFile(join(bundleDir, "payload", "jar", jar.name)));
    } catch {
      violations.push(`${jar.name}: listed in the manifest but missing from payload/jar`);
      continue;
    }
    let names;
    try { names = tools.listEntries(bytes); } catch (error) {
      violations.push(`${jar.name}: unreadable archive (${error.message})`);
      continue;
    }
    // Only jars compiled from this repository may carry MC-Web's own shadows.
    const ours = ROLES_BUILT_HERE.has(jar.role) || PORT_JAR.test(jar.name);
    for (const v of auditJarEntries(names, { allowedShadows: ours ? shadows : new Set() })) {
      violations.push(`${jar.name}: ${v.entry} (${v.reason})`);
    }
    served.push({ ...jar, licenseFiles: licenseFiles(names) });
  }

  // Anything in payload/jar that the manifest does not name is still served.
  const onDisk = await readdir(join(bundleDir, "payload", "jar")).catch(() => []);
  for (const name of onDisk) {
    if (!listed.has(name)) violations.push(`payload/jar/${name}: served but not in the manifest`);
  }

  // The rest of the bundle is runtime and page. None of it should be a jar,
  // a texture or a sound.
  const walk = async (dir) => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      const rel = relative(bundleDir, path).split("\\").join("/");
      if ((await stat(path)).isDirectory()) {
        if (rel !== "payload/jar") await walk(path);
      } else if (/\.(jar|png|ogg|mcmeta)$/i.test(name)) {
        violations.push(`${rel}: game-content file type served outside the audited payload`);
      }
    }
  };
  await walk(bundleDir);

  let preload = {files: 0};
  try {
    const audit = auditRuntimePreloads(await readFile(join(bundleDir, "javavm.js"), "utf8"));
    preload = {files: audit.files};
    violations.push(...audit.violations);
  } catch (error) {
    violations.push(`runtime preload audit: cannot read javavm.js (${error.message})`);
  }

  let shader = null;
  const referenceErrors = [];
  const client = upstream.filter((j) => j.role === "mojang-client-upstream");
  if (version !== MC_VERSION) referenceErrors.push(`shader reference requires recorded version ${MC_VERSION}`);
  if (!/^[0-9a-f]{64}$/.test(expectedClientSha256 ?? "")) {
    referenceErrors.push("shader reference has no valid recorded original client SHA-256");
  }
  if (!(clientJarBytes instanceof Uint8Array) || clientJarBytes.byteLength === 0) {
    referenceErrors.push("shader reference: original client jar bytes are missing");
  } else {
    if (digest("sha256", clientJarBytes) !== expectedClientSha256) {
      referenceErrors.push("shader reference: original client SHA-256 does not match the build record");
    }
    if (client.length !== 1) {
      referenceErrors.push("shader reference requires exactly one upstream original client record");
    } else {
      if (digest("sha1", clientJarBytes) !== client[0].sourceSha1) {
        referenceErrors.push("shader reference: original client SHA-1 does not match upstream sourceSha1");
      }
      if (clientJarBytes.byteLength !== client[0].sourceBytes) {
        referenceErrors.push("shader reference: original client size does not match upstream sourceBytes");
      }
    }
  }
  violations.push(...referenceErrors);
  if (!referenceErrors.length) {
    let shaders;
    try { shaders = await jarShaderFiles(clientJarBytes, {projectRoot}); } catch (error) {
      violations.push(`shader reference: unreadable original client archive (${error.message})`);
    }
    if (shaders) {
      const fragments = shaderFragments(shaders);
      if (!shaders.size || !(fragments.lines.size + fragments.runs.length + fragments.members.size)) {
        violations.push("shader reference: original client has no detectable shader fragments");
      } else {
        try {
          const {violations: shaderViolations, ...stats} = await auditShaderFiles(shaders, bundleDir, fragments);
          shader = stats;
          violations.push(...shaderViolations);
        } catch (error) {
          violations.push(`shader-text audit: cannot read served text (${error.message})`);
        }
      }
    }
  }
  return { violations, served, upstream, preload, shader };
}

// ------------------------------------------------------------ shader text

/*
 * MC-Web translates the game's shaders in the tab, from the GLSL the player's
 * own jar hands the GPU device (docs/SHADERS-PLAN.md). Nothing the site serves
 * may carry text from those shaders: no hand-ported WGSL, no copied constant
 * tables, no uniform-block layouts restated member by member. This guard
 * reads the local client jar's shaders at build time and fails the build when
 * a served text file contains a distinctive piece of one.
 *
 * Three kinds of fragment, each read the same way on either side:
 *
 *  - Lines. Every line of every shader file, with runs of whitespace
 *    collapsed and the space next to punctuation dropped (so reformatting
 *    does not hide a copy), kept when it is at least SHADER_LINE_MIN
 *    characters long and not generic (GENERIC_SHADER_LINE).
 *  - Numeric runs. Three or more numeric literals in a row, separated only by
 *    punctuation and type-constructor names (so vec3(a, b, c) in GLSL,
 *    vec3<f32>(a,b,c) in WGSL and [a, b, c] in JS read the same). Numbers
 *    compare by value (1.0 == 1 == 1.0f). A run counts when it holds a
 *    non-trivial number (TRIVIAL_NUMBER) or is at least
 *    SHADER_RUN_LONG long, and is not a table any code may hold
 *    (genericRun); a served file violates when it contains the whole run, in
 *    order, inside one of its own runs, or SHADER_RUN_WINDOW consecutive
 *    values of a longer one. Comments are read through, so annotating a
 *    table row by row does not hide it.
 *  - Uniform-block members. The member names of each `uniform Block { ... }`,
 *    in order: a served file violates when SHADER_MEMBER_RUN consecutive ones
 *    appear in order with only punctuation, type names and padding members
 *    between them (a struct restated member by member, in any syntax).
 */

/** Shortest normalised line that counts as distinctive. */
export const SHADER_LINE_MIN = 24;
/** A run of only trivial numbers counts from this length (a lookup table). */
export const SHADER_RUN_LONG = 8;
/** Consecutive uniform-block member names that count as a restated block. */
export const SHADER_MEMBER_RUN = 4;
/**
 * Lines every GLSL file of this shape has, which say nothing about where a
 * text came from: the preamble, the empty main signature, include and
 * extension directives. Lines are tested after normalisation.
 */
const GENERIC_SHADER_LINE = [
  /^#\s*version\b/,
  /^#\s*(moj_import|include|extension|line)\b/,
  /^void main\(\)\{?$/,
  /^[{}();,\s]*$/,
];
/**
 * Values that turn up in any graphics code (identity matrices, unit quads,
 * byte masks, halving): a run made only of these is too generic to name a
 * source unless it is long.
 */
const TRIVIAL_NUMBER = (n) => (Number.isInteger(n) && Math.abs(n) <= 16)
  || n === 0.5 || n === -0.5 || n === 0.25 || n === 255 || n === 256;
/**
 * Tables any graphics code may hold whatever its source, so a shader that
 * happens to contain one names nothing: the unit square's corners as a
 * triangle list or strip (in any order), identity matrices, and the textbook
 * luma weights.
 */
const GENERIC_RUNS = new Set([
  "0.299,0.587,0.114", "0.3,0.59,0.11", "0.2126,0.7152,0.0722",
  "1,0,0,0,1,0,0,0,1", "1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1",
]);
const genericRun = (run) => {
  if (GENERIC_RUNS.has(run.join(","))) return true;
  if ((run.length !== 8 && run.length !== 12) || !run.every((v) => v === "0" || v === "1")) return false;
  const corners = [];
  for (let i = 0; i < run.length; i += 2) corners.push(run[i] + run[i + 1]);
  const distinct = (points) => new Set(points).size;
  // A strip: the four corners once each. A list: two triangles of three
  // distinct corners that together cover all four.
  return corners.length === 4 ? distinct(corners) === 4
    : distinct(corners) === 4 && distinct(corners.slice(0, 3)) === 3 && distinct(corners.slice(3)) === 3;
};
/**
 * A long distinctive run is also checked in windows of this many values
 * (holding at least SHADER_WINDOW_DISTINCT non-trivial ones), so a table
 * copied in part, or split by comments, still names its source.
 */
export const SHADER_RUN_WINDOW = 6;
const SHADER_WINDOW_DISTINCT = 4;
/** Text files a bundle serves (code, data, shader sources, maps, notes). */
export const SHIPPED_TEXT = /\.(js|mjs|cjs|html|json|css|wgsl|glsl|vsh|fsh|vert|frag|txt|svg|map)$/i;

/** Collapse whitespace; drop it next to punctuation. */
export const normaliseShaderText = (text) => String(text)
  .replace(/\s+/g, " ")
  .replace(/ ?([^\w\s$#.]) ?/g, "$1")
  .trim();

// Literal: decimal or hex, optional exponent, optional GLSL/WGSL suffix.
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:[uUfFhHiI]|lf|LF)?$/;
// Between two numbers of one run: punctuation, and the names of the vector,
// matrix and scalar types (GLSL and WGSL) that constructors and casts use.
const RUN_GLUE = /^(?:[,()[\]{}<>]|(?:[iudb]?vec[234]|mat[234](?:x[234])?|f32|i32|u32|f16|float|int|uint|double|array))$/;

const parseNumber = (token) => {
  const body = token.replace(/(?:[uUfFhHiI]|lf|LF)$/, "");
  return /^0[xX]/.test(body) ? parseInt(body, 16) : Number(body);
};

/**
 * Runs of consecutive numeric literals in a text, as arrays of canonical
 * value strings. Comments are not stripped: a table copied into a comment is
 * still a copy.
 */
export function numericRuns(text, minimum = 3) {
  const runs = [];
  let run = [];
  let sign = 1;
  const flush = () => {
    if (run.length >= minimum) runs.push(run);
    run = [];
  };
  const tokens = String(text).match(/0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:[uUfFhHiI]|lf|LF)?|[A-Za-z_$][\w$]*|\S/g) || [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (NUMBER.test(token)) {
      const value = sign * parseNumber(token);
      sign = 1;
      if (Number.isFinite(value)) run.push(String(Object.is(value, -0) ? 0 : value));
      else flush();
      continue;
    }
    // A minus directly before a literal, where an operand cannot end (after
    // run glue or at the start), is the literal's sign.
    if (token === "-" && i + 1 < tokens.length && NUMBER.test(tokens[i + 1])
        && (i === 0 || RUN_GLUE.test(tokens[i - 1]) || /^[=:+*/-]$/.test(tokens[i - 1]))) {
      sign = -1;
      continue;
    }
    sign = 1;
    if (!RUN_GLUE.test(token)) flush();
  }
  flush();
  return runs;
}

// Words that sit between member names in a struct written in GLSL, WGSL or
// JS without being names themselves.
const TYPE_WORD = /^(?:[iudb]?vec[234]|mat[234](?:x[234])?|f32|i32|u32|f16|bool|float|int|uint|double|array|struct|uniform|layout|std140|const|let|var|align|size|_\w*|\d\w*)$/;

/**
 * Runs of consecutive identifiers that are not type words, separated only
 * by punctuation and type words. Comment markers, WGSL attributes (@align(16))
 * and offset notes (@64, = 64) count as punctuation, so a block restated in a
 * comment or with its byte offsets still reads as one run.
 */
export function identifierRuns(text, minimum = SHADER_MEMBER_RUN) {
  const runs = [];
  let run = [];
  for (const token of String(text).match(/[A-Za-z_$][\w$]*|\d[\w.]*|[^\s\w$]/g) || []) {
    if (/^[A-Za-z$][\w$]*$/.test(token) && !TYPE_WORD.test(token)) run.push(token);
    else if (!(TYPE_WORD.test(token) || /^[,;:<>()[\]{}"'`@/*#=]$/.test(token))) {
      if (run.length >= minimum) runs.push(run);
      run = [];
    }
  }
  if (run.length >= minimum) runs.push(run);
  return runs;
}

/** Member names of each uniform block declared in a GLSL text, in order. */
export function uniformBlockMembers(text) {
  const blocks = [];
  const body = String(text).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  for (const m of body.matchAll(/\buniform\s+\w+\s*\{([^}]*)\}/g)) {
    const members = [];
    for (const decl of m[1].split(";")) {
      const name = /(\w+)\s*(?:\[[^\]]*\])?\s*$/.exec(decl.trim());
      if (name && !TYPE_WORD.test(name[1])) members.push(name[1]);
    }
    if (members.length) blocks.push(members);
  }
  return blocks;
}

const distinctiveRun = (run) => !genericRun(run) && (run.length >= SHADER_RUN_LONG
  || run.some((value) => !TRIVIAL_NUMBER(Number(value))));

/**
 * The fragments of a set of shader files that a served file must not contain.
 *
 * @param {Map<string, string>|Record<string, string>} files name -> text
 * @returns {{lines: Map<string, string>, runs: {run: string[], source: string}[],
 *   members: Map<string, string>}}
 *   lines maps a normalised line to the file it came from; members maps
 *   SHADER_MEMBER_RUN consecutive member names, comma-joined, likewise.
 */
export function shaderFragments(files) {
  const lines = new Map();
  const runs = [];
  const members = new Map();
  const seenRuns = new Set();
  const entries = files instanceof Map ? [...files] : Object.entries(files);
  for (const [name, text] of entries) {
    for (const raw of String(text).split(/\r?\n/)) {
      const line = normaliseShaderText(raw);
      if (line.length < SHADER_LINE_MIN) continue;
      if (GENERIC_SHADER_LINE.some((re) => re.test(line))) continue;
      if (!lines.has(line)) lines.set(line, name);
    }
    for (const run of numericRuns(text)) {
      const key = run.join(",");
      if (!distinctiveRun(run) || seenRuns.has(key)) continue;
      seenRuns.add(key);
      runs.push({ run, source: name, parent: key, length: run.length });
      for (let i = 0; run.length > SHADER_RUN_WINDOW && i + SHADER_RUN_WINDOW <= run.length; i++) {
        const window = run.slice(i, i + SHADER_RUN_WINDOW);
        const windowKey = window.join(",");
        if (seenRuns.has(windowKey)) continue;
        if (window.filter((v) => !TRIVIAL_NUMBER(Number(v))).length < SHADER_WINDOW_DISTINCT) continue;
        seenRuns.add(windowKey);
        runs.push({ run: window, source: name, parent: key, length: run.length });
      }
    }
    for (const block of uniformBlockMembers(text)) {
      for (let i = 0; i + SHADER_MEMBER_RUN <= block.length; i++) {
        const key = block.slice(i, i + SHADER_MEMBER_RUN).join(",");
        if (!members.has(key)) members.set(key, name);
      }
    }
  }
  return { lines, runs, members };
}

/**
 * Fragments of `fragments` that occur in `text`.
 * @returns {{kind: "line"|"numbers"|"members", fragment: string, source: string}[]}
 */
export function findShaderFragments(text, fragments) {
  const found = [];
  // Lines: substring search over the normalised file, indexed by each
  // fragment's first SHADER_LINE_MIN characters.
  const flat = normaliseShaderText(text);
  if (!fragments._byPrefix) {
    const byPrefix = new Map();
    for (const line of fragments.lines.keys()) {
      const prefix = line.slice(0, SHADER_LINE_MIN);
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push(line);
    }
    Object.defineProperty(fragments, "_byPrefix", { value: byPrefix });
    const byHead = new Map();
    for (const entry of fragments.runs) {
      const head = entry.run.slice(0, 3).join(",");
      if (!byHead.has(head)) byHead.set(head, []);
      byHead.get(head).push(entry);
    }
    Object.defineProperty(fragments, "_byHead", { value: byHead });
  }
  const seen = new Set();
  if (fragments._byPrefix.size) {
    for (let i = 0; i + SHADER_LINE_MIN <= flat.length; i++) {
      const candidates = fragments._byPrefix.get(flat.substr(i, SHADER_LINE_MIN));
      if (!candidates) continue;
      for (const line of candidates) {
        if (!seen.has(line) && flat.startsWith(line, i)) {
          seen.add(line);
          found.push({ kind: "line", fragment: line, source: fragments.lines.get(line) });
        }
      }
    }
  }
  if (fragments.members && fragments.members.size) {
    for (const run of identifierRuns(text)) {
      for (let i = 0; i + SHADER_MEMBER_RUN <= run.length; i++) {
        const key = run.slice(i, i + SHADER_MEMBER_RUN).join(",");
        if (!seen.has(key) && fragments.members.has(key)) {
          seen.add(key);
          found.push({ kind: "members", fragment: key.split(",").join(", "), source: fragments.members.get(key) });
        }
      }
    }
  }
  if (fragments._byHead.size) {
    // Twice: as served, and with comments taken out, so a table whose rows
    // are annotated (`0.1, 0.2, 0.3, // layer 1`) still reads as one run.
    const uncommented = String(text).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    for (const run of [...numericRuns(text), ...numericRuns(uncommented)]) {
      for (let i = 0; i + 3 <= run.length; i++) {
        const candidates = fragments._byHead.get(run.slice(i, i + 3).join(","));
        if (!candidates) continue;
        for (const entry of candidates) {
          // One report per source table, whether it matched whole or in part.
          const key = `numbers:${entry.parent || entry.run.join(",")}`;
          if (seen.has(key) || i + entry.run.length > run.length) continue;
          if (entry.run.every((value, k) => run[i + k] === value)) {
            seen.add(key);
            const part = entry.length && entry.run.length < entry.length
              ? ` (${entry.run.length} values of a ${entry.length}-value run)` : "";
            found.push({ kind: "numbers", fragment: entry.run.join(", ") + part, source: entry.source });
          }
        }
      }
    }
  }
  return found;
}

/** Every assets/<namespace>/shaders/** file in a jar, name -> text. */
export async function jarShaderFiles(jarBytes, { projectRoot = PROJECT } = {}) {
  const tools = jarTools(projectRoot);
  const bytes = jarBytes instanceof Uint8Array ? jarBytes : new Uint8Array(jarBytes);
  const files = new Map();
  const decoder = new TextDecoder();
  for (const name of tools.listEntries(bytes)) {
    if (name.endsWith("/") || !/^assets\/[^/]+\/shaders\//.test(name)) continue;
    const data = await tools.readEntry(bytes, name);
    if (data) files.set(name, decoder.decode(data));
  }
  return files;
}

/**
 * Fails when a served text file contains text from the client jar's shaders.
 *
 * @param {Uint8Array} jarBytes the local client jar (the builder's clientJar)
 * @param {string} bundleDir the packaged bundle
 * @returns {Promise<{violations: string[], shaderFiles: number,
 *   lines: number, runs: number, members: number, scanned: number}>}
 *   violations read "file: [line|numbers|members] fragment (from shader)".
 */
export async function auditShaderText(jarBytes, bundleDir, { projectRoot = PROJECT } = {}) {
  const shaders = await jarShaderFiles(jarBytes, { projectRoot });
  return auditShaderFiles(shaders, bundleDir);
}

async function auditShaderFiles(shaders, bundleDir, fragments = shaderFragments(shaders)) {
  const violations = [];
  let scanned = 0;
  const walk = async (dir) => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      if ((await stat(path)).isDirectory()) {
        await walk(path);
        continue;
      }
      if (!SHIPPED_TEXT.test(name)) continue;
      scanned++;
      const rel = relative(bundleDir, path).split("\\").join("/");
      for (const hit of findShaderFragments(await readFile(path, "utf8"), fragments)) {
        violations.push(`${rel}: [${hit.kind}] ${hit.fragment} (from ${hit.source})`);
      }
    }
  };
  await walk(bundleDir);
  return { violations, shaderFiles: shaders.size, lines: fragments.lines.size,
    runs: new Set(fragments.runs.map((entry) => entry.parent)).size,
    members: fragments.members.size, scanned };
}
