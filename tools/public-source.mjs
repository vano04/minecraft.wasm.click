import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isRuntimeGenerated } from './verify-runtime-source.mjs';
import { credentialKinds } from './source-hygiene.mjs';

const skipped = new Set(['.git','node_modules','build','dist','site','.wrangler','.netlify','.mcweb',
  '.agents','.codex','.aws','test-results','playwright-report','worlds','saves','.audit']);
const privateMarkers = [/\/(?:home|Users)\/[^/\s]+\//, /[A-Za-z]:[\\/]Users[\\/][^/\\\s]+[\\/]/];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function hasAccountCredentials(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasAccountCredentials);
  for (const [key,child] of Object.entries(value)) {
    const normalized=key.toLowerCase().replace(/[^a-z]/g,'');
    if (['accesstoken','refreshtoken'].includes(normalized) && typeof child==='string' && child.length>=16) return true;
    if (key==='ygg' && typeof child?.token==='string') return true;
    if (hasAccountCredentials(child)) return true;
  }
  return false;
}

export async function publicSourceInventory(root) {
  const entries = [];
  async function walk(path = '') {
    for (const item of await readdir(join(root,path),{withFileTypes:true})) {
      const name = path ? path+'/'+item.name : item.name;
      if (skipped.has(item.name) || /(?:^|\/)\.env(?:\.|$)/.test(name) || name.endsWith('.log')) continue;
      if (name.startsWith('runtime/') && isRuntimeGenerated(name.slice(8))) continue;
      if (name === 'artifacts/runtime.tar.gz') continue;
      if (item.isDirectory()) { await walk(name); continue; }
      if (!item.isFile()) throw Error('Public source contains a link or special file: '+name);
      if (/\.(?:pem|key|p12|pfx|crt|cer|mca|mcr|dat|jar|wasm|data|zip|tar|gz)$/i.test(name)
          || /(?:^|\/)(?:accounts|launcher_accounts|stage)\.json$/i.test(name)) throw Error('Private or binary input in publication source: '+name);
      const body = await readFile(join(root,name));
      const png = /^public\/icons\/(?:app-192|app-512|apple-touch-icon)\.png$/.test(name);
      if (!png && body.includes(0)) throw Error('Unexpected binary publication source: '+name);
      if (!png) {
        // /home/web_user is Emscripten's virtual home, not a build host path.
        const text = body.toString('utf8').replaceAll('/home/web_user', '/virtual-home');
        if (privateMarkers.some(pattern=>pattern.test(text))) throw Error('Private deployment or machine marker remains: '+name);
        if (credentialKinds(text).length) throw Error('Credential-format match in publication source: '+name);
        if (name.endsWith('.json') && hasAccountCredentials(JSON.parse(text))) throw Error('Account credentials in publication JSON: '+name);
      }
      entries.push({path:name,bytes:body.length,sha256:hash(body),mode:(await lstat(join(root,name))).mode&0o111?'100755':'100644'});
    }
  }
  await walk();
  return entries.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
