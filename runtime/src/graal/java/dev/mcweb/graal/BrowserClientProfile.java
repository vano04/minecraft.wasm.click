package dev.mcweb.graal;

import dev.mcweb.graal.webgpu.BrowserGpu;
import net.minecraft.client.Minecraft;

/**
 * Diagnostic thread-state and stack residence samples in a running world.
 *
 * <p>{@code -Dmcweb.clientProfile=N} (the page's {@code ?clientProfile=N})
 * opts into {@link BrowserBootSampler} with 200 ms sleeps between samples
 * (nominally 5 Hz) and a cooperative 20-second deadline, once the player has
 * been in a world for N seconds, and prints its tables as {@code bootsample:}
 * lines. A blocked stack walk can overrun the deadline. RUNNABLE stacks can
 * include native waits, so these are not CPU-time measurements. Sampling is
 * off by default. Minecraft's own F3+L recorder was tried first: it
 * started but still reported itself recording a minute later and saved
 * nothing. The client thread is the only one whose reports reach the page, so
 * the frame pump drives this.</p>
 */
final class BrowserClientProfile {
    private static final int START_SECONDS = Integer.getInteger("mcweb.clientProfile", -1);

    private static long inWorldSince;
    private static boolean started;
    private static boolean done;

    private BrowserClientProfile() {
    }

    static void pump(Minecraft minecraft) {
        if (START_SECONDS < 0 || done) {
            return;
        }
        if (started) {
            done = BrowserBootSampler.pollWorld(BrowserGpu::reportProgress);
            return;
        }
        if (minecraft.level == null || minecraft.player == null) {
            inWorldSince = 0L;
            return;
        }
        long now = System.nanoTime();
        if (inWorldSince == 0L) {
            inWorldSince = now;
        }
        if (now - inWorldSince >= START_SECONDS * 1_000_000_000L) {
            started = true;
            BrowserGpu.reportProgress("clientprofile: 200 ms between samples (nominal 5 Hz), cooperative 20 s deadline");
            BrowserBootSampler.beginWorld(200L, 20_000L);
        }
    }
}
