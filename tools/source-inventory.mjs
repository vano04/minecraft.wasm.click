import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function verifyTrackedInventory(root, paths) {
  const expected = new Set(paths);
  const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  for (const path of stdout.split('\0').filter(Boolean)) {
    const info = await lstat(resolve(root, path)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    // An unstaged removal remains in Git's index until the cleanup is staged.
    if (!info) continue;
    if (!expected.has(path) || !info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Tracked file is outside the source inventory: ${path}`);
    }
  }
}
