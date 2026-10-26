#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { verifyRuntimeSource } from './verify-runtime-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime');
const exec = promisify(execFile);

export function buildPlan({ jobs = 8, mcDir = null, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 256) throw new Error('--jobs must be an integer from 1 to 256');
  const packageArgs = ['tools/build-wasmjvm.mjs', ...(mcDir ? ['--mc-dir', resolve(mcDir)] : ['--download'])];
  return [
    { id: 'dependencies', command: 'npm', args: ['ci'] },
    { id: 'naga', command: 'sh', args: ['tools/naga-wasm/build.sh'] },
    { id: 'setup', command: 'sh', args: ['OpenJDK/setup.sh'] },
    { id: 'configure', command: 'sh', args: ['OpenJDK/configure-wasm.sh'] },
    { id: 'jdk', command: platform === 'darwin' ? 'gmake' : 'make', args: ['-C', 'OpenJDK/work/jdk25', 'CONF=wasm-zero', `JOBS=${jobs}`, 'jdk'] },
    { id: 'port', command: process.execPath, args: packageArgs, expectedStop: 'missing-browser-runtime-after-port-build' },
    { id: 'image', command: 'sh', args: ['OpenJDK/make-image.sh'] },
    { id: 'link', command: 'sh', args: ['OpenJDK/link-browser.sh'] },
    { id: 'package', command: process.execPath, args: packageArgs },
  ];
}

export function expectedPortStop({ code, output, runtimePath }) {
  const marker = `\nbuild-wasmjvm: the wasm JVM runtime is incomplete in ${join(runtimePath, 'OpenJDK/browser')}\n`;
  return code === 1 && output.includes(marker) && output.includes('  missing: javavm.js');
}

function run(step, env) {
  console.log(`\n[${step.id}] ${step.command} ${step.args.join(' ')}`);
  return new Promise((accept, reject) => {
    const child = spawn(step.command, step.args, { cwd: runtime, env, stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    const capture = (stream, bytes) => {
      stream.write(bytes);
      output = (output + bytes.toString('utf8')).slice(-128 * 1024);
    };
    child.stdout.on('data', bytes => capture(process.stdout, bytes));
    child.stderr.on('data', bytes => capture(process.stderr, bytes));
    child.once('error', reject);
    child.once('close', (code, signal) => accept({ code, signal, output }));
  });
}

export async function verifyEmscripten({ emsdk, version, commit, emccPySha256, runCommand = exec }) {
  const emcc = join(emsdk, 'upstream/emscripten/emcc');
  const bytes = await readFile(`${emcc}.py`);
  if (createHash('sha256').update(bytes).digest('hex') !== emccPySha256) throw new Error('Unexpected Emscripten emcc.py source');
  // SDK releases extract a compiler archive, not a nested Git checkout.
  // Asking Git here would report the enclosing SDK manager's revision.
  const { stdout } = await runCommand(emcc, ['--version'], { env: { ...process.env,
    EMSDK: emsdk, EM_CONFIG: join(emsdk, '.emscripten') } });
  if (!stdout.split('\n')[0].endsWith(` ${version} (${commit})`)) throw new Error('Unexpected Emscripten compiler version');
}

async function verifyUpstreamPins(lock) {
  for (const [path, expected] of [
    ['OpenJDK/work/jdk25', lock.publicDependencies.openjdk.commit],
    ['OpenJDK/work/libffi-upstream', lock.publicDependencies.libffi.commit],
  ]) {
    const { stdout: top } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: join(runtime, path) });
    if (resolve(top.trim()) !== join(runtime, path)) throw new Error(`Expected an independent upstream Git checkout at ${path}`);
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: join(runtime, path) });
    if (stdout.trim() !== expected) throw new Error(`Unexpected upstream revision at ${path}`);
  }
  const provenance = JSON.parse(await readFile(join(root, 'testing/source-provenance.json'), 'utf8'));
  await verifyEmscripten({ emsdk: join(runtime, 'OpenJDK/work/emsdk'),
    version: lock.publicDependencies.emscripten.version, commit: lock.publicDependencies.emscripten.emscriptenCommit,
    emccPySha256: provenance.toolchains.sdkFiles.find(file => file.path === 'upstream/emscripten/emcc.py').sha256 });
}

async function main(args) {
  let jobs = 8, mcDir = null, planOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plan') planOnly = true;
    else if (args[i] === '--jobs' && args[i + 1]) jobs = Number(args[++i]);
    else if (args[i] === '--mc-dir' && args[i + 1]) mcDir = args[++i];
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  const source = await verifyRuntimeSource();
  const plan = buildPlan({ jobs, mcDir });
  if (planOnly) {
    console.log(JSON.stringify({ cwd: 'runtime', sourceTreeSha256: source.sourceTreeSha256, steps: plan,
      librarySelection: 'The resolver uses the build host OS. The selected release is the reviewed 53-JAR Linux bundle; macOS selects a different library set and requires its own reviewed release selection.',
      portBootstrap: 'Remove only the generated javavm.js before compiling the port; accept only the exact missing-runtime stop, then link and package.' }, null, 2));
    return;
  }
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Build on Linux or macOS; Windows users can use a Linux build environment.');
  if (process.platform !== 'linux') console.warn('The current release was packaged on Linux (53 JARs). macOS selects a different library set; its bundle requires a separate reviewed release selection.');
  const overrides = Object.keys(process.env).filter(key => key.startsWith('MCWEB_'));
  if (overrides.length) throw new Error(`Unset experimental build overrides before a release build: ${overrides.join(', ')}`);
  const lock = JSON.parse(await readFile(join(root, 'testing/runtime-source.json'), 'utf8'));
  const env = { ...process.env, MCWEB_EMSDK_VERSION: lock.publicDependencies.emscripten.version,
    MCWEB_LIBFFI_COMMIT: lock.publicDependencies.libffi.commit, CCACHE_DISABLE: '1' };
  const stateDir = join(runtime, 'build/integration-build');
  await mkdir(stateDir, { recursive: true });
  const buildLock = join(stateDir, 'active');
  await mkdir(buildLock).catch(() => { throw new Error(`A build lock exists at ${buildLock}. Verify no build is running before removing it.`); });
  const receipt = { schema: 1, sourceTreeSha256: source.sourceTreeSha256, startedAt: new Date().toISOString(), steps: [] };
  try {
    for (const step of plan) {
      // The existing packager compiles the port before checking the linked JVM.
      // Removing this one generated loader makes that bootstrap stop explicit,
      // including when a previous build left a stale linked JVM in the cache.
      if (step.id === 'port') await rm(join(runtime, 'OpenJDK/browser/javavm.js'), { force: true });
      const result = await run(step, env);
      if (step.id === 'port') {
        if (!expectedPortStop({ ...result, runtimePath: runtime })) throw new Error('Port bootstrap did not stop at the expected missing-browser-runtime check');
        for (const path of ['OpenJDK/mcweb/mcweb-port.jar', 'OpenJDK/mcweb/port-build.json',
          'OpenJDK/mcweb/libmcwebjs.so', 'OpenJDK/mcweb/jsbridge.c', 'OpenJDK/native-policy/current.json']) {
          if (!(await stat(join(runtime, path))).isFile()) throw new Error(`Port bootstrap did not produce ${path}`);
        }
      } else if (result.code !== 0 || result.signal) throw new Error(`${step.id} failed (${result.signal || result.code})`);
      if (step.id === 'setup') await verifyUpstreamPins(lock);
      receipt.steps.push({ id: step.id, completedAt: new Date().toISOString(), code: result.code,
        ...(step.expectedStop ? { expectedStop: step.expectedStop } : {}) });
      await writeFile(join(stateDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    }
    await verifyRuntimeSource();
    receipt.completedAt = new Date().toISOString();
    await writeFile(join(stateDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log('\nBuilt runtime/dist/wasmjvm. Staging still requires every reviewed release checksum to match.');
  } finally {
    await rm(buildLock, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
