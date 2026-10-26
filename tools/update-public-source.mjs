import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRuntimeGenerated } from './verify-runtime-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const base = JSON.parse(await readFile(resolve(root, 'testing/source-provenance.json'), 'utf8'));
const files = [];
async function walk(path = '') {
  for (const item of await readdir(resolve(root, 'runtime', path), {withFileTypes:true})) {
    const name = path ? path + '/' + item.name : item.name;
    if (isRuntimeGenerated(name)) continue;
    if (item.isDirectory()) await walk(name);
    else if (item.isFile()) {
      const body = await readFile(resolve(root, 'runtime', name));
      const mode = (await lstat(resolve(root, 'runtime', name))).mode & 0o111 ? '100755' : '100644';
      files.push({path:name,bytes:body.length,sha256:hash(body),mode});
    } else throw Error('Unexpected linked runtime input: ' + name);
  }
}
await walk(); files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
const patch = await readFile(resolve(root, base.patch.path));
const manifest = { schema:1,kind:'public-runtime-source',baseSourceTreeSha256:base.sourceTreeSha256,
  sourceTreeSha256:hash(JSON.stringify(canonical(files))), files,
  removed:base.files.filter(record=>!files.some(file=>file.path===record.path)).map(file=>file.path),
  changed:base.files.filter(record=>files.some(file=>file.path===record.path && file.sha256!==record.sha256)).map(file=>file.path),
  historicalPatch:{path:base.patch.path,baseSha256:base.patch.sha256,bytes:patch.length,sha256:hash(patch),
    change:'Replace machine-specific acceptance-pack and local-playtest lab paths with portable defaults and optional environment settings.'} };
await writeFile(resolve(root,'testing/public-source.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({files:files.length,removed:manifest.removed,changed:manifest.changed,sourceTreeSha256:manifest.sourceTreeSha256}));
