package dev.mcweb.graal;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLongArray;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.GenerationChunkHolder;
import net.minecraft.util.StaticCache2D;
import net.minecraft.util.Util;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.level.chunk.status.ChunkStatusTask;
import net.minecraft.world.level.chunk.status.ChunkStep;
import net.minecraft.world.level.chunk.status.WorldGenContext;

/**
 * Where a chunk generation step runs.
 *
 * <p>Mojang's {@code ChunkStep.apply} calls its step's task on the thread
 * that runs the chunk's generation task: the server's serial "worldgen"
 * executor, one thread for every chunk. Only the terrain step hands its work
 * to the background pool and returns a pending future; the generation task
 * then yields, and the lane moves on to other chunks until the terrain is
 * done. The rest of a step's work runs on the lane, so the lane's speed is
 * the world's generation speed (docs/STATUS.md: ~3 chunks a second here,
 * where a flight needs 11-22).
 *
 * <p>The one call site, {@code ChunkStep.apply}'s {@code task.doWork}, is
 * redirected here (tools/wasmjvm-massage-plan.mjs). For the statuses named
 * by {@code -Dmcweb.offloadSteps} (the page's {@code ?offloadSteps=}, comma
 * separated; default {@code none}, vanilla's placement), the task runs on the
 * background pool the way the terrain step does, and its future is the
 * step's future. Which statuses are safe is a property of Mojang's generation
 * pyramid: a step that writes only its own chunk, and reads only neighbours
 * that its dependencies have already finished, touches nothing another
 * chunk's concurrent step writes. Not offloadable: structure_starts
 * (StructureCheck's caches are plain hash maps) and features (writes the 3x3
 * around its chunk).
 *
 * <p>Nothing is offloaded by default since 26.3. In 26.2 the surface and
 * carvers were statuses of their own on the lane, and offloading them took
 * 60 s look-down flights (fixed seed) from 2.42/2.51 to 3.68/3.75 FULL
 * chunks/s. 26.3 merged noise, surface and carvers into one terrain status
 * whose body already runs on the background pool, so those names match
 * nothing; whether another status is worth moving needs a new fixed-seed
 * measurement.
 *
 * <p>With {@code -Dmcweb.chunkDiag} it also times each status's task on the
 * thread that ran it ({@link #describe}), which is how the lane's time
 * splits between statuses.
 */
public final class BrowserWorldgenSteps {

    private static final String OFFLOAD = System.getProperty("mcweb.offloadSteps", "none");
    private static final boolean TIMED = Boolean.getBoolean("mcweb.chunkDiag");
    private static final int SLOTS = 32;

    /** Per status index: 0 unknown, 1 runs in place, 2 offloaded. */
    private static final byte[] placement = new byte[SLOTS];
    private static final AtomicLongArray nanos = new AtomicLongArray(SLOTS);
    private static final AtomicLongArray runs = new AtomicLongArray(SLOTS);
    /** Offloaded steps whose future failed (an exception there reaches no crash report). */
    private static final java.util.concurrent.atomic.AtomicLong offloadFailures =
            new java.util.concurrent.atomic.AtomicLong();
    private static volatile String firstOffloadFailure;

    private BrowserWorldgenSteps() {
    }

    /** Stands in for {@code task.doWork(context, step, cache, chunk)} in {@code ChunkStep.apply}. */
    public static CompletableFuture<ChunkAccess> doWork(ChunkStatusTask task, WorldGenContext context,
            ChunkStep step, StaticCache2D<GenerationChunkHolder> cache, ChunkAccess chunk) {
        ChunkStatus status = step.targetStatus();
        int index = status.getIndex();
        if (index < 0 || index >= SLOTS) {
            return task.doWork(context, step, cache, chunk);
        }
        if (offloaded(status, index) && chunk.getPersistedStatus().isBefore(status)) {
            return CompletableFuture.supplyAsync(
                    () -> run(task, context, step, cache, chunk, index),
                    Util.backgroundExecutor().forName("wgen_" + status.getName()))
                    .thenCompose(future -> future)
                    .whenComplete((done, failure) -> {
                        if (failure != null && offloadFailures.getAndIncrement() == 0) {
                            firstOffloadFailure = status.getName() + ": " + failure;
                        }
                    });
        }
        return run(task, context, step, cache, chunk, index);
    }

    private static CompletableFuture<ChunkAccess> run(ChunkStatusTask task, WorldGenContext context,
            ChunkStep step, StaticCache2D<GenerationChunkHolder> cache, ChunkAccess chunk, int index) {
        if (!TIMED) {
            return task.doWork(context, step, cache, chunk);
        }
        long start = System.nanoTime();
        try {
            return task.doWork(context, step, cache, chunk);
        } finally {
            nanos.addAndGet(index, System.nanoTime() - start);
            runs.incrementAndGet(index);
        }
    }

    private static boolean offloaded(ChunkStatus status, int index) {
        byte known = placement[index];
        if (known == 0) {
            String name = BuiltInRegistries.CHUNK_STATUS.getKey(status).getPath();
            boolean listed = false;
            for (String wanted : OFFLOAD.split(",")) {
                listed |= wanted.trim().equals(name);
            }
            known = listed ? (byte) 2 : (byte) 1;
            placement[index] = known;
        }
        return known == 2;
    }

    /**
     * " stepCpu=[features:120x14.2ms ...] offloadFailed=N": per status, tasks
     * run and their mean time on the thread that ran them (wall time;
     * * = offloaded), and how many offloaded steps failed. Empty unless
     * -Dmcweb.chunkDiag.
     */
    public static String describe() {
        if (!TIMED) {
            return "";
        }
        StringBuilder out = new StringBuilder(" stepCpu=[");
        for (ChunkStatus status : ChunkStatus.getStatusList()) {
            int i = status.getIndex();
            long n = i >= 0 && i < SLOTS ? runs.get(i) : 0;
            if (n > 0) {
                out.append(status.getName()).append(':').append(n).append('x')
                        .append(String.format(java.util.Locale.ROOT, "%.1f", nanos.get(i) / 1e6 / n))
                        .append("ms").append(placement[i] == 2 ? "* " : " ");
            }
        }
        out.append(']').append(" offloadFailed=").append(offloadFailures.get());
        String first = firstOffloadFailure;
        if (first != null) {
            out.append(" firstOffloadFailure=[").append(first.length() > 300 ? first.substring(0, 300) : first).append(']');
        }
        return out.toString();
    }
}
