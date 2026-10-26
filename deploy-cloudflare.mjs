import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = dirname(fileURLToPath(import.meta.url));

export function deployedOrigin(records, name) {
  const result = records.findLast(row => row.type === 'deploy' && row.worker_name === name && row.version_id);
  const target = result?.targets?.find(target => typeof target === 'string' && /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(target));
  if (!target) throw Error('Wrangler did not report a workers.dev URL. Check that workers_dev is enabled in wrangler.jsonc.');
  return target;
}

export async function ownerSecret(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (typeof value.RELAY_TOKEN !== 'string' || value.RELAY_TOKEN.length < 32 || value.RELAY_TOKEN.length > 256) throw Error('Invalid saved RELAY_TOKEN. Keep a backup before replacing this file.');
    await chmod(path, 0o600);
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = { RELAY_TOKEN: randomBytes(32).toString('base64url') };
    await writeFile(path, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    return value;
  }
}

async function deploy() {
  const { values } = parseArgs({ options: { name: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  const config = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
  const name = values.name || config.name;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw Error('Use a Worker name containing lowercase letters, numbers and hyphens.');
  const privateFolder = join(root, '.mcwc', 'cloudflare');
  const buildFolder = join(root, 'build', 'cloudflare', name);
  await mkdir(privateFolder, { recursive: true, mode: 0o700 });
  await mkdir(buildFolder, { recursive: true });
  const secretsFile = join(privateFolder, name + '-secrets.json');
  const secret = await ownerSecret(secretsFile);
  const output = join(buildFolder, 'deploy-' + Date.now() + '.ndjson');
  const cli = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const args = [cli, 'deploy', '--config', join(root, 'wrangler.jsonc'), '--name', name,
    '--secrets-file', secretsFile, '--outdir', join(buildFolder, 'bundle')];
  if (values['dry-run']) args.push('--dry-run');
  const status = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit',
      env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: output } });
    child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(Error('Wrangler stopped on ' + signal)) : accept(code));
  });
  if (status !== 0) throw Error('Deployment failed. Run npm run cloudflare:login if you have not signed in.');
  if (values['dry-run']) { console.log('Dry run passed. No Worker was deployed.'); return; }
  const records = (await readFile(output, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const origin = deployedOrigin(records, name);
  const endpoint = new URL('/tcp/', origin); endpoint.protocol = 'wss:'; endpoint.searchParams.set('token', secret.RELAY_TOKEN);
  const connection = join(privateFolder, name + '-connection.txt');
  await writeFile(connection, endpoint.href + '\n', { mode: 0o600 });
  await chmod(connection, 0o600);
  let ready = false;
  // A new workers.dev route can take a few seconds to serve the uploaded version.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(new URL('/healthz', origin), { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (response.ok && (await response.json()).status === 'ok') { ready = true; break; }
    } catch {}
    if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  if (!ready) throw Error('Worker deployed, but its health check failed. Your connection URL is saved at ' + connection);
  console.log('Worker ready: ' + origin);
  console.log('Copy the URL from ' + connection + ' into Settings > Self-hosted relay URL.');
  console.log('Keep that file private. Future deployments reuse its token.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deploy().catch(error => { console.error(error.message); process.exitCode = 1; });
}
