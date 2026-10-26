import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.MCWEB_TEST_PORT_JAR || join(runtime, 'OpenJDK/mcweb/mcweb-port.jar');
const game = join(runtime, 'build/massaged/minecraft-26.3-massaged.jar');
const libraries = join(runtime, 'build/wasmjvm-libraries-26.3');
const available = [port, game, libraries].every(existsSync);
if (!available && process.env.MCWEB_REQUIRE_GAME_TESTS === '1') throw Error('Build the game port before testing launcher options');

test('production option preparation preserves saved Chunk Builder choices and migrates old defaults once', { skip: !available }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcweb-launch-options-'));
  const java = process.env.BOOT_JDK ? join(process.env.BOOT_JDK, 'bin/java') : 'java';
  const classpath = [port, game, ...readdirSync(libraries).filter(name => name.endsWith('.jar')).map(name => join(libraries, name))].join(delimiter);
  const source = join(directory, 'LaunchOptionsFixture.java');
  writeFileSync(source, String.raw`
package dev.mcweb.graal;
import java.nio.file.*;
public class LaunchOptionsFixture {
    public static void main(String[] args) throws Exception {
        Path file = Path.of(args[0], "options.txt");
        BrowserMinecraftMain.prepareOptionsFile(file.toFile(), 123);
        String seeded = Files.readString(file);
        if (!seeded.contains("version:123\n") || !seeded.contains("prioritizeChunkUpdates:1\n")) throw new AssertionError(seeded);
        BrowserMinecraftMain.prepareOptionsFile(file.toFile(), 456);
        if (!Files.readString(file).equals(seeded)) throw new AssertionError("changed existing defaults");
        for (int value = 0; value <= 2; value++) {
            String saved = "version:123\nprioritizeChunkUpdates:" + value + "\nrenderDistance:7\n";
            Files.writeString(file, saved);
            BrowserMinecraftMain.prepareOptionsFile(file.toFile(), 456);
            if (!Files.readString(file).equals(saved)) throw new AssertionError("overwrote choice " + value);
        }
        String legacy = "version:123\nrenderDistance:7";
        Files.writeString(file, legacy);
        BrowserMinecraftMain.prepareOptionsFile(file.toFile(), 456);
        String migrated = Files.readString(file);
        if (!migrated.equals(legacy + "\nprioritizeChunkUpdates:1\n")) throw new AssertionError(migrated);
        BrowserMinecraftMain.prepareOptionsFile(file.toFile(), 456);
        if (!Files.readString(file).equals(migrated)) throw new AssertionError("migration repeated");
        System.out.println("fresh defaults, saved choices 0/1/2, and idempotent legacy migration passed");
    }
}
`);
  try {
    const compile = spawnSync(java, ['-m', 'jdk.compiler/com.sun.tools.javac.Main', '-cp', classpath, '-d', directory, source], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const run = spawnSync(java, ['-cp', directory + delimiter + classpath, 'dev.mcweb.graal.LaunchOptionsFixture', directory], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /idempotent legacy migration passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
