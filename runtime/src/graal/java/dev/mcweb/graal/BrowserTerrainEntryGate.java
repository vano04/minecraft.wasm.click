package dev.mcweb.graal;

import dev.mcweb.graal.webgpu.BrowserGpu;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.LevelLoadTracker;

/**
 * The loading screen's readiness check, reached from the real JAR's
 * LevelLoadingScreen.tick() through an exact-counted redirect in the massage
 * plan. The vanilla tracker decides; this only reports why the screen is still
 * up, because a hold that never ends is otherwise silent.
 */
public final class BrowserTerrainEntryGate {
    private static LevelLoadTracker lastTracker;
    private static int holdSamples;

    private BrowserTerrainEntryGate() {
    }

    public static boolean isLevelReady(LevelLoadTracker tracker) {
        if (tracker != lastTracker) {
            lastTracker = tracker;
            holdSamples = 0;
        }

        boolean vanillaReady = tracker != null && tracker.isLevelReady();
        if (!vanillaReady) {
            // The vanilla tracker only advances from ClientPacketListener.tick(),
            // which the browser lane reaches through Connection.tick().
            holdSamples++;
            if (holdSamples == 1 || holdSamples % 60 == 0) {
                String progress = "n/a";
                try {
                    progress = tracker == null ? "no-tracker"
                            : (tracker.hasProgress() + "/" + tracker.serverProgress());
                } catch (Throwable ignored) {
                    progress = "failed";
                }
                boolean paused = false;
                try {
                    paused = Minecraft.getInstance() != null && Minecraft.getInstance().isPaused();
                } catch (Throwable ignored) {
                    // diagnostic only
                }
                BrowserGpu.reportProgress("level-ready:hold samples=" + holdSamples
                        + " serverProgress=" + progress
                        + " paused=" + paused);
            }
        }
        return vanillaReady;
    }
}
