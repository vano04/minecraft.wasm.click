import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyTrackedInventory } from './source-inventory.mjs';

test('rejects force-tracked output even when the directory walk ignores build caches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcweb-tracked-inventory-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'source');
    await writeFile(join(root, '.gitignore'), 'build/\n');
    await mkdir(join(root, 'build'));
    await writeFile(join(root, 'build/game.jar'), 'forbidden output');
    execFileSync('git', ['add', 'README.md', '.gitignore'], { cwd: root });
    const paths = ['README.md', '.gitignore'];
    await verifyTrackedInventory(root, paths);
    execFileSync('git', ['add', '-f', 'build/game.jar'], { cwd: root });
    await assert.rejects(verifyTrackedInventory(root, paths), /outside the source inventory: build\/game.jar/);
    await rm(join(root, 'build/game.jar'));
    await verifyTrackedInventory(root, paths);
  } finally { await rm(root, { recursive: true, force: true }); }
});
