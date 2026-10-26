// Exercise the production Java queue gate and loaded-edge consumer against the
// real Minecraft API. No copied implementation or source-marker assertions.
// The browser-only native progress sink is adapted to stderr for this host JVM.
// Upstream Mth initialization and the production movement logic stay intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const jdk = [process.env.BOOT_JDK, join(repo, 'OpenJDK/work/temurin25'), '/opt/homebrew/opt/openjdk@25']
  .find(path => path && existsSync(join(path, 'bin/javac')));
const javac = jdk ? join(jdk, 'bin/javac') : 'javac';
const java = jdk ? join(jdk, 'bin/java') : 'java';
const port = process.env.MCWEB_PORT_JAR || join(repo, 'OpenJDK/mcweb/mcweb-port.jar');
const game = process.env.MCWEB_COMPILE_JAR || join(repo, 'build/massaged/minecraft-26.3-massaged.jar');
const libraries = process.env.MCWEB_LIBRARIES_DIR || join(repo, 'build/wasmjvm-libraries-26.3');

const fixture = String.raw`
package dev.mcweb.graal;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;
import java.util.function.BooleanSupplier;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.ChunkSource;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.level.lighting.LevelLightEngine;
import net.minecraft.world.phys.Vec3;

public final class ChunkRuntimeBehavior {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void queue() {
        var gate = new BrowserIntegratedServerCompat.ChunkSliceGate();
        var tasks = new ArrayDeque<Runnable>();
        int[] completed = {0};
        for (int frame = 0; frame < 120; frame++) {
            if (gate.tryQueue(20)) tasks.add(() -> {
                completed[0]++;
                gate.completed(20);
            });
        }
        require(tasks.size() == 1, "render frames must coalesce before consumption");
        tasks.remove().run();
        for (int frame = 0; frame < 120; frame++) {
            require(!gate.tryQueue(20), "completion must not requeue in the same tick");
        }
        require(completed[0] == 1, "one actual consumer run per tick");
        require(gate.tryQueue(21), "the next server tick must make progress");
        require(!gate.tryQueue(22), "a pending task must still coalesce across ticks");
        gate.completed(25);
        require(!gate.tryQueue(25), "a delayed task must account for its execution tick");
        require(gate.tryQueue(26), "delayed completion must not strand the next tick");
        gate.rejected();
        require(gate.tryQueue(26), "a rejected submission must release the pending latch");
        gate.completed(26);

        var nextWorld = new BrowserIntegratedServerCompat.ChunkSliceGate();
        require(nextWorld.tryQueue(0), "a new world's zero tick must not inherit the old tick");
        gate.completed(27);
        require(!nextWorld.tryQueue(0), "old-world completion must not release new-world work");
        nextWorld.completed(0);
        require(nextWorld.tryQueue(1), "new-world queue must progress after its own consumption");
        nextWorld.completed(1);
    }

    // Only chunk availability is supplied by the fixture. The actual production
    // clamp performs its box, corner, negative-coordinate and movement decisions.
    private static final class AvailableChunks extends ChunkSource {
        private final Set<Long> loaded = new HashSet<>();
        private static long key(int x, int z) { return ((long) x << 32) ^ (z & 0xffffffffL); }
        void add(int x, int z) { loaded.add(key(x, z)); }
        @Override public boolean hasChunk(int x, int z) { return loaded.contains(key(x, z)); }
        @Override public ChunkAccess getChunk(int x, int z, ChunkStatus status, boolean load) {
            throw new AssertionError("the movement clamp must never request generation");
        }
        @Override public void tick(BooleanSupplier haveTime, boolean tickChunks) {
            throw new AssertionError("the movement clamp must not tick the world");
        }
        @Override public String gatherStats() { return "fixture"; }
        @Override public int getLoadedChunksCount() { return loaded.size(); }
        @Override public LevelLightEngine getLightEngine() { return null; }
        @Override public BlockGetter getLevel() { return null; }
    }

    private static void movement() {
        for (int direction : new int[] {-1, 1}) {
            var chunks = new AvailableChunks();
            int origin = direction > 0 ? 0 : -1;
            int next = direction > 0 ? 1 : -2;
            double position = direction * 14.5;
            chunks.add(origin, origin);
            chunks.add(next, origin);
            chunks.add(origin, next);
            var move = new Vec3(direction * 1.5, 0.75, direction * 1.5);
            int before = BrowserChunkCompat.heldClientMoves;
            Vec3 held = BrowserChunkCompat.clampToLoaded(chunks, position, position, move);
            require(held.x == move.x && held.z == 0 && held.y == move.y,
                    "a missing diagonal corner must slide along one loaded axis");
            require(BrowserChunkCompat.heldClientMoves == before + 1,
                    "a held corner must be counted");
            chunks.add(next, next);
            require(BrowserChunkCompat.clampToLoaded(chunks, position, position, move) == move,
                    "arrival of the corner chunk must restore the unchanged move");
        }
        var chunks = new AvailableChunks();
        chunks.add(0, 0);
        var vertical = new Vec3(0, 1.25, 0);
        require(BrowserChunkCompat.clampToLoaded(chunks, 8, 8, vertical) == vertical,
                "vertical movement must remain unchanged");
        var blocked = new Vec3(1.5, -0.5, 1.5);
        Vec3 held = BrowserChunkCompat.clampToLoaded(chunks, 14.5, 14.5, blocked);
        require(held.x == 0 && held.z == 0 && held.y == blocked.y,
                "both missing axes must hold horizontal movement but preserve descent");
        var retreat = new Vec3(-1, 0.25, -1);
        require(BrowserChunkCompat.clampToLoaded(chunks, 15.5, 15.5, retreat) == retreat,
                "a player already overlapping a pending edge must be allowed to retreat");
    }

    public static void main(String[] args) {
        switch (args[0]) {
            case "queue" -> queue();
            case "movement" -> movement();
            default -> throw new AssertionError(args[0]);
        }
    }
}
`;

test('chunk maintenance and loaded-edge movement preserve actual consumer semantics', {
  skip: (!existsSync(port) || !existsSync(game) || !existsSync(libraries))
    && 'requires the local 26.3 compile jar, port jar and upstream libraries',
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'mcweb-chunk-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'ChunkRuntimeBehavior.java');
  writeFileSync(source, fixture);
  const progressSource = join(root, 'BrowserGpu.java');
  writeFileSync(progressSource, `package dev.mcweb.graal.webgpu;
public final class BrowserGpu {
    public static void reportProgress(String message) {
        System.err.println("[host-progress] " + message);
    }
}
`);
  const classpath = [port, game, join(libraries, '*')].join(delimiter);
  const compile = spawnSync(javac, ['-nowarn', '-proc:none', '-d', root, '-cp', classpath,
    join(repo, 'src/graal/java/dev/mcweb/graal/BrowserIntegratedServerCompat.java'),
    join(repo, 'src/graal/java/dev/mcweb/graal/BrowserChunkCompat.java'), source, progressSource,
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(compile.status, 0, `${compile.error || ''}\n${compile.stdout}\n${compile.stderr}`);
  for (const scenario of ['queue', 'movement']) {
    await t.test(scenario, () => {
      const run = spawnSync(java, ['-cp', [root, classpath].join(delimiter),
        'dev.mcweb.graal.ChunkRuntimeBehavior', scenario], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(run.status, 0, `${run.error || ''}\n${run.stdout}\n${run.stderr}`);
    });
  }
});
