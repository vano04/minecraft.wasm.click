import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployedOrigin, ownerSecret } from './deploy-cloudflare.mjs';

test('deployment reuses the owner token and refuses to overwrite malformed credentials', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mcwc-cf-secret-'));
  try {
    const path = join(folder, 'secret.json');
    const first = await ownerSecret(path), second = await ownerSecret(path);
    assert.match(first.RELAY_TOKEN, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first.RELAY_TOKEN, second.RELAY_TOKEN);
    await writeFile(path, '{"RELAY_TOKEN":"bad"}');
    await assert.rejects(ownerSecret(path), /Invalid saved/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('connection URL uses the completed deployment for this Worker', () => {
  const records = [{ type: 'deploy', worker_name: 'other', version_id: 'v1', targets: ['https://other.owner.workers.dev'] },
    { type: 'deploy', worker_name: 'relay', version_id: 'v2', targets: ['https://relay.owner.workers.dev'] }];
  assert.equal(deployedOrigin(records, 'relay'), 'https://relay.owner.workers.dev');
  assert.throws(() => deployedOrigin(records, 'missing'), /did not report/);
});
