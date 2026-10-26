#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
// These identify credential formats, not public client IDs or account IDs.
const patterns = [
  ['private-key', new RegExp('-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----')],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{24,255}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
];

export function credentialKinds(text) {
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

export async function scanSource({ directory = root, history = false } = {}) {
  const { stdout } = await exec('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { cwd: directory, maxBuffer: MAX_TOTAL_BYTES });
  const findings = [];
  let scannedFiles = 0, scannedBytes = 0;
  for (const path of new Set(stdout.split('\0').filter(Boolean))) {
    const absolute = resolve(directory, path);
    const stat = await lstat(absolute).catch(() => null);
    // A tracked deletion is reviewed by the source inventory separately.
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      findings.push({ path, kind: 'non-regular-tracked-file' });
      continue;
    }
    if (stat.size > MAX_FILE_BYTES || scannedBytes + stat.size > MAX_TOTAL_BYTES) {
      throw new Error('Source hygiene scan exceeded its byte limit; review the inventory before increasing it.');
    }
    scannedFiles++; scannedBytes += stat.size;
    if (/(?:^|\/)\.env(?:\.|$)|\.(?:key|pem|p12|pfx)$/i.test(path)) findings.push({ path, kind: 'credential-file' });
    const bytes = await readFile(absolute);
    if (bytes.includes(0)) continue;
    for (const kind of credentialKinds(bytes.toString('utf8'))) findings.push({ path, kind });
  }
  if (history) {
    let patch;
    try {
      ({ stdout: patch } = await exec('git', ['log', '-50', '--format=', '--no-ext-diff', '--no-renames', '-p', '--'],
        { cwd: directory, maxBuffer: MAX_HISTORY_BYTES }));
    } catch { throw new Error('History hygiene scan failed or exceeded 16 MiB. Inspect a smaller history range privately.'); }
    let path = '[history]';
    for (const line of patch.split('\n')) {
      if (line.startsWith('+++ b/')) path = line.slice(6);
      else if (line.startsWith('--- a/')) path = line.slice(6);
      else if (/^[+-]/.test(line) && !/^[+-]{3}/.test(line)) {
        for (const kind of credentialKinds(line.slice(1))) findings.push({ path, kind: `history-${kind}` });
      }
    }
  }
  const unique = [...new Map(findings.map(row => [`${row.path}\0${row.kind}`, row])).values()];
  return { kind: 'source-hygiene', scannedFiles, scannedBytes, historyCommitsLimit: history ? 50 : 0,
    limitations: ['Detects selected credential formats, not every secret.', 'History is checked only with --history.'], findings: unique };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(value => value !== '--history') || process.argv.slice(2).length > 1) {
      throw new Error('Usage: node tools/source-hygiene.mjs [--history]');
    }
    const report = await scanSource({ history: process.argv.includes('--history') });
    console.log(JSON.stringify(report, null, 2));
    if (report.findings.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
