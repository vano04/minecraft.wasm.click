import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sourcePath, verifyRuntimeSource } from './verify-runtime-source.mjs';
import { stageDependencyNotices, stageDependencySources } from './dependency-notices.mjs';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function publishableSourcePath(path) {
  sourcePath(path);
  const parts = path.split('/');
  if (parts.some(part => ['.git', '.netlify', '.wrangler', '.mcweb', 'node_modules', 'build', 'dist',
    'site', 'work', 'private', 'test-server', 'test-results', 'playwright-report', 'worlds', 'saves'].includes(part))
    || parts.some(part => part === '.env' || part.startsWith('.env.'))
    || /\.(?:jar|class|wasm|data|pem|key|p12|pfx|crt|cer|log|mca|mcr|dat|zip|tar|gz|profraw)$/i.test(path)) {
    throw new Error(`Forbidden source-archive path: ${path}`);
  }
  return path;
}

const ARCHIVE_SCRIPT = String.raw`
import gzip, hashlib, io, json, os, pathlib, sys, tarfile
spec = json.load(sys.stdin)
root = pathlib.Path(spec['root'])
with open(spec['output'], 'wb') as output:
    with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for record in spec['entries']:
                path = root / record['path']
                with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
                    data = source.read()
                if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
                    raise ValueError('Source changed after audit: ' + record['path'])
                info = tarfile.TarInfo(record['path'])
                info.size = len(data)
                info.mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
                info.mtime = info.uid = info.gid = 0
                info.uname = info.gname = ''
                archive.addfile(info, io.BytesIO(data))
`;

export async function sourceArchive({ root, output, entries }) {
  const names = new Set();
  for (const record of entries) {
    publishableSourcePath(record.path);
    if (names.has(record.path)) throw new Error(`Duplicate source-archive path: ${record.path}`);
    names.add(record.path);
  }
  const ordered = [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  try {
    execFileSync('python3', ['-c', ARCHIVE_SCRIPT], { input: JSON.stringify({ root, output: temporary, entries: ordered }), timeout: 30_000 });
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
  const body = await readFile(output);
  return { path: '/notices/corresponding-source.tar.gz', bytes: body.length, sha256: hash(body), files: ordered.length };
}

export function runtimeNoticePage({ template, records, source }) {
  const replacements = {
    '{{RUNTIME_SHA256}}': source.runtime.sha256,
    '{{SOURCE_TREE_SHA256}}': source.sourceTreeSha256,
    '{{NOTICE_LINKS}}': records.map(record => `<li><a href="${escape(record.publicPath)}">${escape(record.component)}: ${escape(record.path.replace(/^licenses\//, ''))}</a></li>`).join('\n'),
  };
  for (const [marker, value] of Object.entries(replacements)) {
    if (template.split(marker).length !== 2) throw new Error(`Unexpected runtime notice page: ${marker}`);
    template = template.replace(marker, value);
  }
  return template;
}

export async function repositoryState({ root, environment = process.env, run = exec }) {
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 };
  const head = (await run('git', ['rev-parse', '--verify', 'HEAD'], options)).stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('Could not identify the staged source revision');
  const requested = String(environment.GITHUB_SHA || '').trim().toLowerCase();
  if (requested && requested !== head) throw new Error('GITHUB_SHA does not match the checked-out source revision');
  const status = (await run('git', ['status', '--porcelain=v1', '--untracked-files=no'], options)).stdout.trim();
  return { revision: head, dirty: Boolean(status) };
}

export async function stageRuntimeNotices({ root, site, thirdParty }) {
  const verified = await verifyRuntimeSource({ root, checkGit:false, requireReleaseMatch:true });
  const lock = JSON.parse(await readFile(join(root, 'testing/runtime-source.json'), 'utf8'));
  const release = JSON.parse(await readFile(join(root, 'testing/release.json'), 'utf8'));
  const records = [...lock.dependencyNotices,lock.projectNotice];
  for (const record of records) {
    const body=await readFile(join(root,record.path));
    if(body.length!==record.bytes || hash(body)!==record.sha256)throw Error('Pinned notice differs: '+record.path);
    const destination=join(site,record.publicPath.slice(1));
    await mkdir(dirname(destination),{recursive:true});await writeFile(destination,body);
  }
  const original=release.files['THIRD-PARTY.json'];
  if(thirdParty.length!==original.bytes || hash(thirdParty)!==original.sha256)throw Error('Runtime dependency inventory changed');
  await writeFile(join(site,'notices/THIRD-PARTY.json'),thirdParty);
  records.push(...await stageDependencyNotices({root,site,thirdParty}));
  records.push(...await stageDependencySources({root,site,allowDownloads:true}));
  const wsLicense=await readFile(join(root,'node_modules/ws/LICENSE'));
  await writeFile(join(site,'notices/ws-LICENSE.txt'),wsLicense);
  records.push({path:'node_modules/ws/LICENSE',publicPath:'/notices/ws-LICENSE.txt',component:'ws',bytes:wsLicense.length,sha256:hash(wsLicense)});
  const {publicSourceInventory}=await import('./public-source.mjs');
  const entries=await publicSourceInventory(root);
  const archive=await sourceArchive({root,output:join(site,'notices/corresponding-source.tar.gz'),entries});
  const artifact=JSON.parse(await readFile(join(root,'artifacts/runtime.json'),'utf8'));
  const deps=lock.publicDependencies;
  const source={schema:1,kind:'runtime-corresponding-source',archive,
    projectRepository:'https://github.com/vano04/minecraft.wasm.click',
    distributionSourceSha256:hash(JSON.stringify(entries)),
    sourceTreeSha256:verified.sourceTreeSha256,selectedSourceFiles:verified.selectedSourceFiles,
    runtime:{name:'libjvm.so',...release.files['libjvm.so'],cacheKey:release.build.runtimeCacheKey},
    publicRuntime:artifact,
    upstream:[
      {component:'OpenJDK',revision:deps.openjdk.commit,source:`https://github.com/openjdk/jdk/archive/${deps.openjdk.commit}.tar.gz`,patches:'runtime/OpenJDK/patches and runtime/OpenJDK/setup.sh'},
      {component:'libffi',revision:deps.libffi.commit,source:`https://github.com/libffi/libffi/archive/${deps.libffi.commit}.tar.gz`,patch:deps.libffi.patch},
      {component:'Emscripten',version:deps.emscripten.version,revision:deps.emscripten.emscriptenCommit,source:`https://github.com/emscripten-core/emscripten/archive/${deps.emscripten.emscriptenCommit}.tar.gz`}
    ],buildInstructions:'docs/runtime-build.md',sourceLock:'testing/public-source.json',
    notices:records.map(({path,publicPath,component,bytes,sha256})=>({source:path,path:publicPath,component,bytes,sha256})),
    thirdParty:{path:'/notices/THIRD-PARTY.json',...original}};
  await writeFile(join(site,'notices/source.json'),JSON.stringify(source,null,2)+'\n');
  const page=runtimeNoticePage({template:await readFile(join(root,'public/notices/index.html'),'utf8'),records,source});
  await writeFile(join(site,'notices/index.html'),page);
  return source;
}
