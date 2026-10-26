package dev.mcweb.graal;

import dev.mcweb.graal.webgpu.BrowserGpu;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.progress.LevelLoadListener;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;

/**
 * Reports world-load progress to the browser host instead of slf4j.
 *
 * <p>{@code Minecraft.doWorldLoad} composes its own tracker with the listener
 * {@code LoggingLevelLoadListener.forSingleplayer()} returns; the massage plan
 * redirects that call here. The host then sees the exact stage and chunk
 * counts the loading screen waits on - the difference between "spawn chunks
 * are generating slowly" and "the chunk future never completes".</p>
 */
public final class BrowserLevelLoadReporter implements LevelLoadListener {
    private String lastReport = "";
    private int suppressed;

    private BrowserLevelLoadReporter() {
    }

    /** The redirect target for {@code LoggingLevelLoadListener.forSingleplayer()}. */
    public static LevelLoadListener forSingleplayer() {
        return new BrowserLevelLoadReporter();
    }

    @Override
    public void start(LevelLoadListener.Stage stage, int total) {
        report("start " + stage + " total=" + total);
    }

    @Override
    public void update(LevelLoadListener.Stage stage, int ready, int total) {
        report("update " + stage + " " + ready + "/" + total);
    }

    @Override
    public void finish(LevelLoadListener.Stage stage) {
        report("finish " + stage);
    }

    @Override
    public void updateFocus(ResourceKey<Level> dimension, ChunkPos center) {
        report("focus " + dimension.identifier() + " " + center);
    }

    /**
     * Collapses repeats without going silent: {@code update} fires every server
     * tick with unchanged numbers while a stage stalls, so a repeat reports
     * every 64th time with its count. A climbing count is progress; one that
     * stops is a stall.
     */
    private synchronized void report(String message) {
        if (message.equals(lastReport)) {
            if ((++suppressed & 0x3F) == 0) {
                BrowserGpu.reportProgress("levelload:" + message + " x" + suppressed);
            }
            return;
        }
        lastReport = message;
        suppressed = 0;
        BrowserGpu.reportProgress("levelload:" + message);
    }
}
