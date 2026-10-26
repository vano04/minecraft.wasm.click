import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialKinds, scanSource } from './source-hygiene.mjs';

const token = () => 'gh' + 'p_' + 'q'.repeat(40);
test('detects credential formats while accepting public configuration and placeholders', () => {
  assert.deepEqual(credentialKinds(token()), ['github-token']);
  assert.deepEqual(credentialKinds(['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----'].join(' ')), ['private-key']);
  assert.deepEqual(credentialKinds('PUBLIC_ORIGIN=https://example.com public_id=00000000-0000-4000-8000-000000000000'), []);
});

test('reports only paths and kinds and checks removed credentials in bounded history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcweb-hygiene-'));
  const git = args => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
  try {
    git(['init', '-q']);
    await writeFile(join(directory, 'config.txt'), token());
    git(['add', 'config.txt']);
    const report = await scanSource({ directory });
    assert.deepEqual(report.findings, [{ path: 'config.txt', kind: 'github-token' }]);
    assert.ok(!JSON.stringify(report).includes(token()));
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    await writeFile(join(directory, 'config.txt'), 'safe configuration');
    git(['add', 'config.txt']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'remove fixture']);
    assert.deepEqual((await scanSource({ directory })).findings, []);
    await writeFile(join(directory, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(directory, 'ignored.txt'), token());
    await writeFile(join(directory, 'untracked.txt'), token());
    assert.deepEqual((await scanSource({ directory })).findings, [{ path: 'untracked.txt', kind: 'github-token' }]);
    await rm(join(directory, 'untracked.txt'));
    const history = await scanSource({ directory, history: true });
    assert.deepEqual(history.findings, [{ path: 'config.txt', kind: 'history-github-token' }]);
    assert.ok(!JSON.stringify(history).includes(token()));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
