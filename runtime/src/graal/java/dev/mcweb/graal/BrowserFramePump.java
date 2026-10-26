package dev.mcweb.graal;

import com.mojang.blaze3d.platform.FramerateLimitTracker;
import com.mojang.blaze3d.platform.FramerateLimitTracker.FramerateThrottleReason;
import com.mojang.blaze3d.systems.RenderSystem;
import dev.mcweb.graal.webgpu.BrowserGpu;
import net.minecraft.client.Minecraft;
import org.graalvm.webimage.api.JS;

/**
 * Animation-frame pump replacing Minecraft's blocking run() loop. The browser
 * host calls the registered callback once per requestAnimationFrame; each call
 * executes exactly one real runTick frame. run() is entered once in pump mode
 * only to install the game thread, then returns.
 */
public final class BrowserFramePump {
    private static Minecraft minecraft;
    private static volatile long frameCount;
    private static volatile boolean failed;
    /** Frames dropped in a row before the pump gives up for good. */
    private static final int MAX_CONSECUTIVE_FAILURES = 240;
    /** Cap on failure reports, so a repeating fault cannot flood the ring buffer. */
    private static final int MAX_REPORTED_FAILURES = 5;
    private static int consecutiveFailures;
    private static int reportedFailures;
    private static volatile String currentPhase = "not-started";
    private static String lastScreenClass;
    private static boolean postReloadGcRequested;
    private static int postReloadGcAttempts;
    private static long postReloadGcBefore = -1L;
    /**
     * Diagnostic depth switches, read once at start (the JVM's properties never
     * change afterwards). Each one keeps a report that the frame loop pays for
     * whether or not anyone reads it.
     *
     * <ul>
     * <li>{@code ?frameDiag=1} — the once-per-120-frames GUI, input and thread
     * census. {@link #reportGuiState()} alone re-extracts the screen into a
     * throwaway render state and resolves four methods by reflection on every
     * invocation.</li>
     * <li>{@code ?terrainDiag=1} — the deep section-pipeline probes behind
     * {@code terrain:}: a 5x5x4 grid of sections around the player, 40 block
     * reads below it, and three full octree walks with the frustum-offset
     * convergence loop. The numbers {@code compare-lanes} samples are not in
     * there.</li>
     * <li>{@code ?frametimeFull=1} — the median (a 1024-element copy and a
     * sort) and the GC counters (a fresh MXBean list) in {@code frametime:}.</li>
     * </ul>
     */
    private static boolean frameDiag;
    private static boolean terrainDiag;
    private static boolean frametimeFull;
    private static boolean inputHoldDiag;
    /** {@code -Dmcweb.autoclick} drives a real click; its report must keep running. */
    private static boolean autoclick;
    /** What {@link #reportWorldState} last reported, compared without building text. */
    private static net.minecraft.client.multiplayer.ClientLevel lastWorldLevel;
    private static boolean lastWorldHadPlayer;
    private static net.minecraft.client.renderer.ViewArea lastViewArea;
    private static int viewAreaGeneration;
    private static int terrainReportCount;
    private static int lastBrowserFrameLimit = -1;
    private static boolean lastBrowserVsync;
    /** Set once Minecraft's own Quit Game has cleared {@code running}. */
    private static boolean quitting;
    private static boolean autoClicked;
    private static boolean cursorSelfTested;
    private static String autoPlayScreen;
    private static long autoPlayAt;

    private BrowserFramePump() {
    }

    public static void start(Minecraft instance) {
        minecraft = instance;
        BrowserMultiplayerCompat.install(instance);
        postReloadGcRequested = false;
        postReloadGcAttempts = 0;
        postReloadGcBefore = -1L;
        lastGameplayState = null;
        nextGameplayReportFrame = 0L;
        lastBrowserFrameLimit = -1;
        failed = false;
        consecutiveFailures = 0;
        reportedFailures = 0;
        currentPhase = "start";
        quitting = false;
        // ?frameDiag / ?terrainDiag / ?frametimeFull: the frame-loop probes that
        // cost something whether or not a run reads them. Off by default; each
        // one is a diagnostic, not a behaviour.
        frameDiag = System.getProperty("mcweb.frameDiag") != null;
        terrainDiag = System.getProperty("mcweb.terrainDiag") != null;
        frametimeFull = System.getProperty("mcweb.frametimeFull") != null;
        inputHoldDiag = Boolean.getBoolean("mcweb.inputHoldDiag");
        autoclick = System.getProperty("mcweb.autoclick") != null;
        // Start the AFK clock here rather than at image start. The tracker's
        // latestInputTime begins at zero and is measured against a monotonic
        // clock, so by the time a long boot reaches the title screen Minecraft
        // already believes nobody has touched the game -- it then clamps to
        // 30 FPS (and to 10 after ten minutes) until the first real click.
        noteInput();
        alignFrameClock(instance);
        updateBrowserFramePacing();
        // The runTick prologue patch lazily installs the game thread on the
        // first pumped frame; the blocking desktop run() loop is never called.
        // Names every pack the repository found, including the directory packs
        // restored from browser storage. Without it a pack that silently failed
        // discovery is indistinguishable from one the player never enabled.
        reportDiscoveredPacks(instance);
        BrowserGpu.registerFrameCallback(BrowserFramePump::frame);
        // DOM events from the page host are queued as SDL events, which
        // Minecraft's own SDL_PollEvent loop hands to its input handlers.
        BrowserGpu.registerInputBridge(BrowserInputBridge.dispatcher());
    }

    /** Diagnostic: which packs the repository actually discovered. */
    private static void reportDiscoveredPacks(Minecraft minecraft) {
        try {
            java.util.List<String> ids = new java.util.ArrayList<>(
                    minecraft.getResourcePackRepository().getAvailableIds());
            BrowserGpu.reportProgress("packs:available " + String.join(",", ids));
        } catch (Throwable unavailable) {
            BrowserGpu.reportProgress("packs:available-failed "
                    + unavailable.getClass().getSimpleName());
        }
    }

    /**
     * Runs frames from the calling thread until the game quits.
     *
     * <p>Web Image hands each frame back through a browser callback, which
     * works because its "main thread" only ever borrows the Worker. A real JVM
     * cannot do that: its main thread <em>is</em> the Worker thread, and both
     * ways of leaving it standing are fatal. Returning from {@code main} lets
     * libjli run {@code DestroyJavaVM}, so the callback finds no VM; parking it
     * (the {@code mcweb.keepalive} join) blocks the Worker's event loop, so the
     * pump messages queue up undelivered. Either way no frame is ever drawn.
     *
     * <p>Nothing actually needs this thread's event loop. Every host call is a
     * synchronous RPC to the GPU Worker, which keeps its own loop turning and
     * commits the canvas, so the frame schedule can simply live here.</p>
     */
    private static final long OVERLAY_FRAME_NANOS = 1_000_000_000L / 60;

    private static long lastGcCount, lastGcMillis;

    /**
     * The display's refresh period. The page measures it from animation
     * frames before the JVM starts ({@code -Dmcweb.displayHz}); this Worker
     * has no animation frames of its own.
     */
    private static final long DISPLAY_FRAME_NANOS = displayFrameNanos();
    /** When the next paced frame may start; 0 until pacing begins. */
    private static long paceDue;

    private static long displayFrameNanos() {
        try {
            double hz = Double.parseDouble(System.getProperty("mcweb.displayHz", "60"));
            if (hz >= 20 && hz <= 500) {
                return (long) (1_000_000_000L / hz);
            }
        } catch (NumberFormatException ignored) {
        }
        return 1_000_000_000L / 60;
    }

    /**
     * Waits out the rest of this frame's slot. The slot is the display period
     * with VSync on and the Max Framerate period below Unlimited, whichever
     * is longer; with neither, frames run back to back. Deadlines advance by
     * whole periods, so a frame that ran long is followed by one that starts
     * at once; one that ran more than a period late restarts the schedule.
     */
    private static void paceFrame() {
        long period = 0L;
        if (lastBrowserVsync) {
            period = DISPLAY_FRAME_NANOS;
        }
        if (lastBrowserFrameLimit > 0 && lastBrowserFrameLimit < 260) {
            period = Math.max(period, 1_000_000_000L / lastBrowserFrameLimit);
        }
        if (period == 0L) {
            paceDue = 0L;
            return;
        }
        long now = System.nanoTime();
        if (lastBrowserVsync && paceToVsync(now)) {
            return;
        }
        paceDue += period;
        if (paceDue - now > period || now - paceDue > period) {
            // Pacing just started, the period shrank, or the frame ran over.
            paceDue = now;
            paceResets++;
            return;
        }
        long asked = paceDue - now;
        long sleepStart = now;
        while (paceDue - now > 0) {
            java.util.concurrent.locks.LockSupport.parkNanos(paceDue - now);
            now = System.nanoTime();
        }
        if (PACE_STATS) {
            long over = now - sleepStart - asked;
            paceSlept += now - sleepStart;
            paceOver += Math.max(0L, over);
            paceOverMax = Math.max(paceOverMax, over);
        }
    }

    /** The GPU Worker's last animation frame (epoch nanoseconds) and its period. */
    private static volatile long vsyncStampNanos;
    private static volatile long vsyncPeriodNanos;
    /** The refresh the previous paced frame started at. */
    private static long lastFrameVsync;
    private static long paceVsyncLocked;

    /** A {@code vsync} line from the GPU Worker's input mailbox. */
    static void noteVsync(double epochMillis, double periodMillis) {
        if (periodMillis >= 2.0 && periodMillis <= 50.0) {
            vsyncPeriodNanos = (long) (periodMillis * 1_000_000.0);
            vsyncStampNanos = (long) (epochMillis * 1_000_000.0);
        }
    }

    /**
     * VSync proper: start the frame at the first refresh after the previous
     * frame finished, and at least as many refreshes after the previous
     * start as the frame limit asks. A frame that starts just after a
     * refresh has the whole period to reach the GPU Worker before the next
     * one, so each refresh shows one new frame; one that started on a timer
     * of its own drifted against the refreshes and doubled or dropped
     * frames whenever its finish crossed one. Needs a refresh stamp under a
     * quarter-second old on this thread's clock (nanoTime is epoch-based
     * here, as the GPU Worker's timeOrigin+now is); otherwise the timer
     * schedule stands in.
     */
    private static boolean paceToVsync(long now) {
        long stamp = vsyncStampNanos;
        long refresh = vsyncPeriodNanos;
        if (refresh == 0L || now - stamp > 250_000_000L || stamp - now > 50_000_000L
                || Math.abs(now / 1_000_000L - System.currentTimeMillis()) > 1000L) {
            return false;
        }
        // Max Framerate below the refresh rate: every n-th refresh. (The
        // page's measured period is not used here; the Worker's refreshes
        // are the ones that count.)
        long limitPeriod = lastBrowserFrameLimit > 0 && lastBrowserFrameLimit < 260
                ? 1_000_000_000L / lastBrowserFrameLimit : 0L;
        long refreshesPerFrame = Math.max(1L, (limitPeriod + refresh / 2) / refresh);
        long next = stamp + (Math.floorDiv(now - stamp, refresh) + 1L) * refresh;
        long earliest = lastFrameVsync + refreshesPerFrame * refresh - refresh / 2;
        while (next < earliest) {
            next += refresh;
        }
        lastFrameVsync = next;
        // Start a little after the refresh, not on it, so that the frame is
        // not taken for the previous refresh's.
        long target = next + VSYNC_START_OFFSET_NANOS;
        long asked = target - now;
        while (target - now > 0) {
            java.util.concurrent.locks.LockSupport.parkNanos(target - now);
            now = System.nanoTime();
        }
        paceDue = now;
        if (PACE_STATS) {
            paceVsyncLocked++;
            paceSlept += Math.max(0L, asked);
            long over = (now - target);
            paceOver += Math.max(0L, over);
            paceOverMax = Math.max(paceOverMax, over);
        }
        return true;
    }

    private static final long VSYNC_START_OFFSET_NANOS = 300_000L;

    /**
     * {@code -Dmcweb.paceStats} (the page sets it with {@code ?mcweb_pace=1}):
     * once a second, {@code pacing:} with the gaps between frame ends as this
     * thread sees them and what {@link #paceFrame} slept, so unevenness the
     * GPU Worker measures can be told apart from unevenness made here.
     */
    private static final boolean PACE_STATS = Boolean.getBoolean("mcweb.paceStats");
    private static long paceSlept, paceOver, paceOverMax, paceResets, paceLastEnd, paceWindow;
    private static final long[] paceGaps = new long[1024];
    private static int paceGapCount;

    private static void paceStats(long frameEnd) {
        if (paceLastEnd != 0L && paceGapCount < paceGaps.length) {
            paceGaps[paceGapCount++] = frameEnd - paceLastEnd;
        }
        paceLastEnd = frameEnd;
        if (paceWindow == 0L) {
            paceWindow = frameEnd;
        }
        if (frameEnd - paceWindow < 1_000_000_000L || paceGapCount == 0) {
            return;
        }
        long[] gaps = java.util.Arrays.copyOf(paceGaps, paceGapCount);
        java.util.Arrays.sort(gaps);
        int n = gaps.length;
        BrowserGpu.reportProgress(String.format(java.util.Locale.ROOT,
                "pacing: n=%d startGap p50=%.1f p90=%.1f max=%.1f slept=%.0f overshoot=%.1f overMax=%.1f resets=%d"
                        + " vsyncLocked=%d refresh=%.2f",
                n, gaps[n / 2] / 1e6, gaps[Math.min(n - 1, n * 9 / 10)] / 1e6, gaps[n - 1] / 1e6,
                paceSlept / 1e6, paceOver / 1e6, paceOverMax / 1e6, paceResets,
                paceVsyncLocked, vsyncPeriodNanos / 1e6));
        paceGapCount = 0;
        paceSlept = paceOver = paceOverMax = paceResets = paceVsyncLocked = 0L;
        paceWindow = frameEnd;
    }

    /**
     * Once a second, and only when a frame in that second took over 50 ms: the
     * frame count, the slowest one, and the screen. Those are what
     * {@code tools/compare-lanes.mjs} parses out of the line.
     *
     * <p>The median needs a full copy of the second's samples and a sort of
     * them, and the GC deltas walk {@code getGarbageCollectorMXBeans()}, which
     * builds a fresh {@code List} and asks every bean for two counters. Both
     * ran on every second of every run, hitched or not, for numbers no gate
     * reads: {@code ?frametimeFull=1} asks for them.</p>
     */
    private static void reportFrameTimes(long[] nanos, int n) {
        if (n == 0) {
            return;
        }
        long max = 0;
        int hitches = 0;
        for (int i = 0; i < n; i++) {
            max = Math.max(max, nanos[i]);
            if (nanos[i] > 50_000_000L) {
                hitches++;
            }
        }
        if (hitches == 0) {
            return;
        }
        StringBuilder line = new StringBuilder("frametime: n=").append(n)
                .append(" max=").append(max / 1_000_000L).append("ms hitches=").append(hitches);
        if (frametimeFull) {
            long[] sorted = java.util.Arrays.copyOf(nanos, n);
            java.util.Arrays.sort(sorted);
            line.append(" p50=").append(sorted[n / 2] / 1_000_000L).append("ms");
            long gcCount = 0, gcMillis = 0;
            try {
                for (java.lang.management.GarbageCollectorMXBean gc
                        : java.lang.management.ManagementFactory.getGarbageCollectorMXBeans()) {
                    gcCount += Math.max(0, gc.getCollectionCount());
                    gcMillis += Math.max(0, gc.getCollectionTime());
                }
            } catch (Throwable unavailable) {
                gcCount = -1;
            }
            line.append(" gc=").append(gcCount - lastGcCount)
                    .append('/').append(gcMillis - lastGcMillis).append("ms");
            lastGcCount = gcCount;
            lastGcMillis = gcMillis;
        }
        line.append(" screen=").append(minecraft != null && minecraft.gui != null
                && minecraft.gui.screen() != null
                ? minecraft.gui.screen().getClass().getSimpleName() : "-");
        BrowserGpu.reportProgress(line.toString());
    }

    public static void driveFrames() {
        startPhaseWatchdog();
        BrowserGpu.reportProgress("pump:main-thread-loop-entered");
        long overlayFrameDue = 0L;
        long windowStart = System.nanoTime();
        long[] frameNanos = new long[1024];
        int frameCountInWindow = 0;
        while (!failed) {
            trace("frame-begin");
            long frameStart = System.nanoTime();
            holdLoadingProgress(true);
            frame();
            holdLoadingProgress(false);
            long frameEnd = System.nanoTime();
            trace("frame-end");
            BrowserFrameTiming.frameEnded(frameEnd - frameStart, frameEnd);
            // Stutter, measured where it happens: once a second, if any frame
            // took over 50 ms, the second's frame times (count, median,
            // slowest, and how many were over 50 ms).
            if (frameCountInWindow < frameNanos.length) {
                frameNanos[frameCountInWindow++] = frameEnd - frameStart;
            }
            if (frameEnd - windowStart >= 1_000_000_000L) {
                reportFrameTimes(frameNanos, frameCountInWindow);
                frameCountInWindow = 0;
                windowStart = frameEnd;
            }
            // In a world or a menu, the player's own Video Settings decide the
            // schedule, as on desktop: VSync holds frames to the display's
            // refresh, Max Framerate below Unlimited caps them. Unpaced, a
            // frame that runs a client tick took twice as long as the frames
            // around it, and with ~2 frames per display refresh the motion
            // shown was sampled unevenly.
            if (minecraft == null || minecraft.gui == null || minecraft.gui.overlay() == null) {
                paceFrame();
            }
            if (PACE_STATS) {
                paceStats(System.nanoTime());
            }
            // While an overlay is up (the resource-reload screen), 60 frames a
            // second, as desktop Minecraft paces everything outside a world.
            // Unpaced, this loop drew the red loading screen ~2,000 times a
            // second: LoadingOverlay smooths its bar by 5% per frame, which
            // assumes ~60, so the bar followed every dip of the raw
            // finished/started ratio and visibly ran backwards -- and the
            // spinning took the time the reload's main-thread tasks run in.
            if (minecraft != null && minecraft.gui != null && minecraft.gui.overlay() != null) {
                long now = System.nanoTime();
                if (overlayFrameDue > now) {
                    long ms = (overlayFrameDue - now) / 1_000_000L;
                    if (ms > 0) {
                        try {
                            Thread.sleep(ms);
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    overlayFrameDue += OVERLAY_FRAME_NANOS;
                } else {
                    overlayFrameDue = now + OVERLAY_FRAME_NANOS;
                }
            }
        }
        BrowserGpu.reportProgress("pump:main-thread-loop-ended frames=" + frameCount);
    }

    private static long lastFlowNanos;

    /**
     * {@code flow:} once a second with {@code -Dmcweb.flowReport}: where
     * chunks are between being generated and being drawn -- complete on the
     * server within view distance, received by the client, sections visible
     * and sections with something to draw -- so a burst can be traced to the
     * stage that holds chunks back.
     */
    private static int flowReports;
    private static int minFreePacks = Integer.MAX_VALUE;

    /**
     * The integrated server's loaded overworld chunks and where its unloading
     * stands: chunk positions with tickets, holders to drop, dropped holders
     * waiting to save, queued unloads, generation tasks. Racy reads, for reports.
     */
    private static String serverLoadedChunks() {
        var server = minecraft.getSingleplayerServer();
        if (server == null) {
            return "-1";
        }
        var source = server.overworld().getChunkSource();
        StringBuilder out = new StringBuilder().append(source.getLoadedChunksCount());
        try {
            out.append(" tickets=").append(sizeOf(source, "ticketStorage", "tickets"))
                    .append(" toDrop=").append(sizeOf(source.chunkMap, null, "toDrop"))
                    .append(" pendingUnloads=").append(sizeOf(source.chunkMap, null, "pendingUnloads"))
                    .append(" unloadQueue=").append(sizeOf(source.chunkMap, null, "unloadQueue"))
                    .append(" genTasks=").append(sizeOf(source.chunkMap, null, "pendingGenerationTasks"));
            // Holders more than 24 chunks from the player: how many, and the
            // ticket levels they hold (unloaded past ChunkLevel.MAX_LEVEL).
            var player = server.getPlayerList().getPlayers().isEmpty() ? null : server.getPlayerList().getPlayers().get(0);
            if (player != null) {
                var f = source.chunkMap.getClass().getDeclaredField("visibleChunkMap");
                f.setAccessible(true);
                var holders = (it.unimi.dsi.fastutil.longs.Long2ObjectMap<?>) f.get(source.chunkMap);
                int px = player.chunkPosition().x(), pz = player.chunkPosition().z(), far = 0, farLoaded = 0;
                java.util.TreeMap<Integer, Integer> levels = new java.util.TreeMap<>();
                for (Object o : holders.values()) {
                    var holder = (net.minecraft.server.level.ChunkHolder) o;
                    var pos = holder.getPos();
                    if (Math.max(Math.abs(pos.x() - px), Math.abs(pos.z() - pz)) > 24) {
                        far++;
                        levels.merge(holder.getTicketLevel(), 1, Integer::sum);
                        if (net.minecraft.server.level.ChunkLevel.isLoaded(holder.getTicketLevel())) {
                            farLoaded++;
                        }
                    }
                }
                out.append(" far=").append(far).append(" farLoaded=").append(farLoaded).append(" farLevels=").append(levels);
                // Tickets by type (timeout/flags), and how many are far away.
                var tf = source.getClass().getDeclaredField("ticketStorage");
                tf.setAccessible(true);
                Object storage = tf.get(source);
                var mf = storage.getClass().getDeclaredField("tickets");
                mf.setAccessible(true);
                var tickets = (it.unimi.dsi.fastutil.longs.Long2ObjectMap<?>) mf.get(storage);
                java.util.TreeMap<String, Integer> types = new java.util.TreeMap<>();
                for (var e : tickets.long2ObjectEntrySet()) {
                    var pos = net.minecraft.world.level.ChunkPos.unpack(e.getLongKey());
                    boolean isFar = Math.max(Math.abs(pos.x() - px), Math.abs(pos.z() - pz)) > 24;
                    for (Object t : (java.util.List<?>) e.getValue()) {
                        var ticket = (net.minecraft.server.level.Ticket) t;
                        String key = ticket.getType().timeout() + "/" + ticket.getType().flags() + (isFar ? "far" : "");
                        types.merge(key, 1, Integer::sum);
                    }
                }
                out.append(" ticketTypes=").append(types);
            }
        } catch (ReflectiveOperationException | RuntimeException e) {
            out.append(" unloadState=").append(e);
        }
        return out.toString();
    }

    /** size() of {@code owner.[via.]field}, read reflectively (private in Mojang's classes). */
    private static int sizeOf(Object owner, String via, String field) throws ReflectiveOperationException {
        Object target = owner;
        if (via != null) {
            var f = target.getClass().getDeclaredField(via);
            f.setAccessible(true);
            target = f.get(target);
        }
        var f = target.getClass().getDeclaredField(field);
        f.setAccessible(true);
        Object value = f.get(target);
        return value instanceof java.util.Map<?, ?> map ? map.size() : ((java.util.Collection<?>) value).size();
    }

    private static void reportFlow() {
        if (!BrowserIntegratedServerCompat.FLOW_REPORT || minecraft.level == null) {
            return;
        }
        // Section builder packs never taken this second (sampled every frame).
        int free = minecraft.gameRenderer == null ? 0 : minecraft.gameRenderer.renderBuffers().sectionBufferPool().getFreeBufferCount();
        minFreePacks = Math.min(minFreePacks, free);
        long now = System.nanoTime();
        if (now - lastFlowNanos < 1_000_000_000L) {
            return;
        }
        lastFlowNanos = now;
        int packsUnused = minFreePacks;
        minFreePacks = Integer.MAX_VALUE;
        try {
            int client = minecraft.level.getChunkSource() instanceof net.minecraft.client.multiplayer.ClientChunkCache cache
                    ? cache.getLoadedChunksCount() : -1;
            int visible = 0, renderable = 0, pendingMesh = 0;
            var renderer = minecraft.levelRenderer;
            if (renderer != null) {
                for (var section : renderer.visibleSections()) {
                    visible++;
                    var mesh = section.getSectionMesh();
                    if (mesh != null && mesh.hasRenderableLayers()) {
                        renderable++;
                    }
                    if (mesh == net.minecraft.client.renderer.chunk.CompiledSectionMesh.UNCOMPILED) {
                        pendingMesh++;
                    }
                }
            }
            BrowserGpu.reportProgress("flow: serverFull=" + BrowserIntegratedServerCompat.serverFullInView
                    + " serverTick=" + BrowserIntegratedServerCompat.serverFlowTick
                    + " client=" + client + " visible=" + visible + " uncompiled=" + pendingMesh
                    + " renderable=" + renderable + " earlySent=" + BrowserChunkCompat.earlySent
                    + " lightWait=" + BrowserChunkCompat.lightWaiting
                    + " packsUnused=" + packsUnused
                    + " serverLoaded=" + serverLoadedChunks()
                    + " heapMB=" + ((Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) >> 20)
                    + " " + org.lwjgl.system.BrowserNativeMemory.stats()
                    + (++flowReports % 30 == 1 ? " " + org.lwjgl.system.BrowserNativeMemory.sizeClasses() : ""));
        } catch (Throwable unavailable) {
            BrowserGpu.reportProgress("flow: failed " + unavailable);
        }
    }

    private static java.lang.reflect.Field loadingProgress;
    private static java.lang.reflect.Field loadingReload;
    private static boolean loadingProgressUnavailable;
    private static Object heldOverlay;
    private static float heldProgress;

    /**
     * Keeps the loading screen's bar from running backwards.
     *
     * <p>{@code LoadingOverlay} eases {@code currentProgress} 5% per frame
     * toward the reload's finished/started ratio, which dips whenever a burst
     * of tasks is started -- with worker threads they come in bursts, so the
     * drawn bar visibly went back (54% to 45% at 60 FPS). Holding the eased
     * value at its maximum between frames was not enough: the frame eases it
     * toward the lower ratio again before drawing, so the bar sat a little
     * back for as long as a dip lasted. Before each frame the value is set so
     * that Mojang's own easing lands exactly on the highest value reached
     * ({@code (held - 0.05 * ratio) / 0.95}); after it, the highest value is
     * recorded.</p>
     */
    private static void holdLoadingProgress(boolean beforeFrame) {
        if (loadingProgressUnavailable || minecraft == null || minecraft.gui == null) {
            return;
        }
        Object overlay = minecraft.gui.overlay();
        if (!(overlay instanceof net.minecraft.client.gui.screens.LoadingOverlay)) {
            heldOverlay = null;
            return;
        }
        try {
            if (loadingProgress == null) {
                loadingProgress = net.minecraft.client.gui.screens.LoadingOverlay.class
                        .getDeclaredField("currentProgress");
                loadingProgress.setAccessible(true);
                loadingReload = net.minecraft.client.gui.screens.LoadingOverlay.class
                        .getDeclaredField("reload");
                loadingReload.setAccessible(true);
            }
            if (overlay != heldOverlay) {
                heldOverlay = overlay;
                heldProgress = 0f;
            }
            float now = loadingProgress.getFloat(overlay);
            if (!beforeFrame) {
                heldProgress = Math.max(heldProgress, now);
                return;
            }
            float ratio = ((net.minecraft.server.packs.resources.ReloadInstance) loadingReload.get(overlay))
                    .getActualProgress();
            if (ratio < heldProgress) {
                loadingProgress.setFloat(overlay,
                        Math.min(1f, (heldProgress - 0.050000012f * ratio) / 0.95f));
            }
        } catch (Throwable unavailable) {
            loadingProgressUnavailable = true;
            BrowserGpu.reportProgress("loading:progress-hold-unavailable " + unavailable);
        }
    }

    /**
     * What a render graph that shows nothing is waiting for: the chunks it
     * expects (first few), how many chunks it counts as loaded, and whether
     * the client has the camera's own chunk -- a camera in a chunk the client
     * does not have propagates nowhere, which looks the same as a graph that
     * lost track of the loaded chunks.
     */
    private static String describeGraphWaits(net.minecraft.client.renderer.SectionOcclusionGraph graph,
                                             net.minecraft.client.renderer.ViewArea area) {
        if (graph == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(" expected=[");
        int n = 0;
        for (long key : graph.expectedChunks()) {
            if (n++ == 4) {
                out.append("...");
                break;
            }
            out.append(net.minecraft.world.level.ChunkPos.unpack(key)).append(' ');
        }
        out.append(']');
        try {
            java.lang.reflect.Field f = net.minecraft.client.renderer.SectionOcclusionGraph.class
                    .getDeclaredField("loadedChunks");
            f.setAccessible(true);
            out.append(" graphLoaded=").append(((java.util.Collection<?>) f.get(graph)).size());
        } catch (Throwable unavailable) {
            out.append(" graphLoaded=?");
        }
        try {
            net.minecraft.core.SectionPos camera = area.getCameraSectionPos();
            out.append(" cameraChunkLoaded=").append(minecraft.level.getChunkSource()
                    .hasChunk(camera.x(), camera.z()));
        } catch (Throwable unavailable) {
            out.append(" cameraChunkLoaded=?");
        }
        return out.toString();
    }

    /**
     * Starts Minecraft's FPS counter at now instead of at the epoch.
     *
     * <p>{@code renderFrame} ends with vanilla's FPS catch-up loop, which
     * keeps advancing {@code lastTime} one second at a time (publishing the
     * frame count each step) until it is within a second of
     * {@code Util.getMillis()}. Nothing ever seeds {@code lastTime} — it is
     * zero until that loop first runs. On a desktop JVM {@code System.nanoTime()} counts from an
     * arbitrary but small origin, so the catch-up is a few hundred thousand
     * iterations and invisible. This runtime's {@code nanoTime} is epoch-based
     * (it equals {@code currentTimeMillis} to the millisecond), which makes the
     * first frame run <b>1.79 billion</b> iterations of it: ~15 minutes in
     * Zero's interpreter, allocating nothing and calling nothing, which is why
     * it looked like a deadlock right after the first present.</p>
     *
     * <p>Seeding the field is deliberately preferred to "fixing" the clock:
     * {@code nanoTime}'s origin is unspecified, so code that assumes a small
     * one is the thing that is wrong.</p>
     */
    private static void alignFrameClock(Minecraft instance) {
        try {
            java.lang.reflect.Field lastTime = Minecraft.class.getDeclaredField("lastTime");
            lastTime.setAccessible(true);
            lastTime.setLong(instance, net.minecraft.util.Util.getMillis());
        } catch (Throwable unavailable) {
            BrowserGpu.reportProgress("clock:fps-counter-seed-failed "
                    + unavailable.getClass().getName() + ":" + unavailable.getMessage());
        }
    }

    /**
     * Queues a cursor move and a click, polls them, and reads back what
     * Minecraft stored.
     *
     * <p>Isolates the SDL event queue and Mojang's SDLEventHandler from
     * everything in front of them — the page listener, the RPC queue, the
     * drain — so "the click never arrived" and "the event does nothing" stop
     * looking alike.</p>
     */
    private static String selfTestCursor() {
        if (cursorSelfTested) {
            return "done";
        }
        if (System.getProperty("mcweb.autoclick") == null) {
            return "off";
        }
        cursorSelfTested = true;
        try {
            // Aim at the first widget on the screen and drive a whole press and
            // release through the same entry points the host uses.
            net.minecraft.client.gui.screens.Screen screen = minecraft.gui.screen();
            double scale = minecraft.getWindow().getGuiScale();
            double targetX = 0.0;
            double targetY = 0.0;
            for (net.minecraft.client.gui.components.events.GuiEventListener child : screen.children()) {
                if (child instanceof net.minecraft.client.gui.components.AbstractWidget widget) {
                    targetX = (widget.getX() + widget.getWidth() / 2.0) * scale;
                    targetY = (widget.getY() + widget.getHeight() / 2.0) * scale;
                    break;
                }
            }
            String before = screen.getClass().getSimpleName();
            int left = com.mojang.blaze3d.platform.InputConstants.MOUSE_BUTTON_LEFT;
            BrowserInputCompat.enqueueMotion((float) targetX, (float) targetY, 0.0F, 0.0F);
            BrowserInputCompat.enqueueButton(left, true, 0);
            BrowserInputCompat.enqueueButton(left, false, 0);
            RenderSystem.pollEvents(minecraft.sdlEventHandler);
            return "clicked(" + (int) targetX + "," + (int) targetY + ")"
                    + " pos=" + (int) minecraft.mouseHandler.xpos()
                    + "," + (int) minecraft.mouseHandler.ypos()
                    + " lastInput=" + minecraft.getLastInputType()
                    + " " + before + "->"
                    + (minecraft.gui.screen() == null ? "<none>"
                        : minecraft.gui.screen().getClass().getSimpleName());
        } catch (Throwable failure) {
            return "threw:" + failure.getClass().getSimpleName() + ":" + failure.getMessage();
        }
    }

    /**
     * Clicks through the menus to a world, without a mouse.
     *
     * <p>{@code -Dmcweb.autoplay=singleplayer} drives Title -> Singleplayer ->
     * Create New World by handing the screen a synthetic click, which is the
     * same entry point a real click reaches. The point is that it works under
     * node: the browser cannot be bisected with {@code -Xlog:class+load}, and
     * that log is what names a stall on this runtime.</p>
     */
    private static void autoPlay() {
        if (System.getProperty("mcweb.autoplay") == null) {
            return;
        }
        try {
            net.minecraft.client.gui.screens.Screen screen = minecraft.gui.screen();
            if (screen == null) {
                autoPlayScreen = null;
                return;
            }
            String name = screen.getClass().getSimpleName();
            if (!name.equals(autoPlayScreen)) {
                autoPlayScreen = name;
                // A screen's widgets are laid out in init(); give it a few
                // frames before aiming at them.
                autoPlayAt = frameCount + 20;
                return;
            }
            if (autoPlayAt == 0L || frameCount < autoPlayAt) {
                return;
            }
            autoPlayAt = 0L;
            String wanted = switch (name) {
                case "TitleScreen" -> "Singleplayer";
                case "SelectWorldScreen", "CreateWorldScreen" -> "Create New World";
                default -> null;
            };
            if (wanted == null) {
                return;
            }
            // Default worldgen is the single most expensive thing Minecraft
            // does, and Zero interprets it; superflat makes the same path
            // finish in minutes instead of hours.
            if (screen instanceof net.minecraft.client.gui.screens.worldselection.CreateWorldScreen create) {
                if ("superflat".equals(System.getProperty("mcweb.autoplay"))) {
                    selectFlatWorldType(create);
                }
                // Creative by default: survival spawns can be in water, and at
                // these tick rates the player drowns before the world finishes
                // streaming — which stops streaming and looks like a chunk
                // limit. Creative also lets a benchmark fly to load terrain.
                if (!"survival".equals(System.getProperty("mcweb.gamemode"))) {
                    create.getUiState().setGameMode(
                            net.minecraft.client.gui.screens.worldselection
                                    .WorldCreationUiState.SelectedGameMode.CREATIVE);
                    BrowserGpu.reportProgress("autoplay:game-mode creative");
                }
            }
            for (net.minecraft.client.gui.components.events.GuiEventListener child : screen.children()) {
                if (!(child instanceof net.minecraft.client.gui.components.AbstractWidget widget)) {
                    continue;
                }
                String label = widget.getMessage() == null ? "" : widget.getMessage().getString();
                if (!label.equalsIgnoreCase(wanted)) {
                    continue;
                }
                double x = widget.getX() + widget.getWidth() / 2.0;
                double y = widget.getY() + widget.getHeight() / 2.0;
                BrowserGpu.reportProgress("autoplay:click " + name + " -> " + label);
                screen.mouseClicked(
                        new net.minecraft.client.input.MouseButtonEvent(x, y,
                                new net.minecraft.client.input.MouseButtonInfo(
                                        com.mojang.blaze3d.platform.InputConstants.MOUSE_BUTTON_LEFT, 0)),
                        false);
                return;
            }
            BrowserGpu.reportProgress("autoplay:no-button " + name + " wanted=" + wanted);
        } catch (Throwable failure) {
            BrowserGpu.reportProgress("autoplay:failed "
                    + BrowserMinecraftMain.describeFailure(failure));
            if (failure instanceof net.minecraft.ReportedException reported) {
                BrowserMinecraftMain.reportCrashReport("autoplay:crash-report:", reported.getReport());
            }
        }
    }

    /** Switches the create-world screen to the superflat preset. */
    private static void selectFlatWorldType(
            net.minecraft.client.gui.screens.worldselection.CreateWorldScreen screen) {
        try {
            net.minecraft.client.gui.screens.worldselection.WorldCreationUiState state =
                    screen.getUiState();
            java.util.List<net.minecraft.client.gui.screens.worldselection.WorldCreationUiState.WorldTypeEntry> all =
                    new java.util.ArrayList<>(state.getNormalPresetList());
            all.addAll(state.getAltPresetList());
            for (var entry : all) {
                String described = entry.describePreset() == null
                        ? "" : entry.describePreset().getString();
                if (described.toLowerCase(java.util.Locale.ROOT).contains("flat")) {
                    state.setWorldType(entry);
                    BrowserGpu.reportProgress("autoplay:world-type " + described);
                    return;
                }
            }
            BrowserGpu.reportProgress("autoplay:world-type not-found n=" + all.size());
        } catch (Throwable failure) {
            BrowserGpu.reportProgress("autoplay:world-type-failed "
                    + failure.getClass().getName() + ":" + failure.getMessage());
        }
    }

    /**
     * Asks each widget whether it would take a click at the current pointer.
     *
     * <p>{@code Screen.mouseClicked} returning false is indistinguishable from
     * the click never arriving, and the three things a widget checks —
     * {@code isMouseOver}, {@code active}, {@code visible} — are exactly what
     * separates them.</p>
     */
    private static String describeHitTest() {
        try {
            net.minecraft.client.gui.screens.Screen screen = minecraft.gui.screen();
            if (screen == null) {
                return "<no-screen>";
            }
            double mouseX = minecraft.mouseHandler.getScaledXPos(minecraft.getWindow());
            double mouseY = minecraft.mouseHandler.getScaledYPos(minecraft.getWindow());
            StringBuilder hits = new StringBuilder();
            for (net.minecraft.client.gui.components.events.GuiEventListener child : screen.children()) {
                if (!(child instanceof net.minecraft.client.gui.components.AbstractWidget widget)) {
                    continue;
                }
                if (!widget.isMouseOver(mouseX, mouseY)) {
                    continue;
                }
                hits.append(' ')
                        .append(widget.getClass().getSimpleName())
                        .append("[x=").append(widget.getX()).append(",y=").append(widget.getY())
                        .append(",w=").append(widget.getWidth()).append(",h=").append(widget.getHeight())
                        .append(",active=").append(widget.active)
                        .append(",visible=").append(widget.visible).append(']');
            }
            if (hits.length() == 0) {
                return "<none-under-pointer>";
            }
            // -Dmcweb.autoclick: bypass MouseHandler entirely and hand the
            // screen the click itself. Separates "the widget refuses the
            // click" from "the click never got past MouseHandler's gates",
            // which the silent no-op cannot.
            if (System.getProperty("mcweb.autoclick") != null && !autoClicked) {
                autoClicked = true;
                boolean accepted = screen.mouseClicked(
                        new net.minecraft.client.input.MouseButtonEvent(
                                mouseX, mouseY,
                                new net.minecraft.client.input.MouseButtonInfo(
                                        com.mojang.blaze3d.platform.InputConstants.MOUSE_BUTTON_LEFT, 0)),
                        false);
                hits.append(" directMouseClicked=").append(accepted);
            }
            return hits.toString();
        } catch (Throwable unavailable) {
            return "<" + unavailable.getClass().getSimpleName() + ">";
        }
    }

    /**
     * Names every widget on the current screen and where it is.
     *
     * <p>Coordinates are canvas pixels, so a test can click a button by name
     * instead of by guessing at a fraction of the window — which is the only
     * option while the menu's own sprites are not visible, and is a better
     * assertion afterwards anyway.</p>
     */
    private static void reportScreenWidgets() {
        try {
            net.minecraft.client.gui.screens.Screen screen = minecraft.gui.screen();
            if (screen == null) {
                return;
            }
            double scale = minecraft.getWindow().getGuiScale();
            StringBuilder line = new StringBuilder("widgets:");
            for (net.minecraft.client.gui.components.events.GuiEventListener child : screen.children()) {
                if (!(child instanceof net.minecraft.client.gui.components.AbstractWidget widget)) {
                    continue;
                }
                String label = widget.getMessage() == null ? "" : widget.getMessage().getString();
                if (label.isEmpty()) {
                    label = widget.getClass().getSimpleName();
                }
                // Coordinates first and no spaces in the label: button text is
                // a sentence often enough ("Welcome to Minecraft!") that a
                // label-first format cannot be parsed back.
                line.append(' ')
                        .append((int) ((widget.getX() + widget.getWidth() / 2.0) * scale))
                        .append(',')
                        .append((int) ((widget.getY() + widget.getHeight() / 2.0) * scale))
                        .append('=')
                        .append(label.replaceAll("\\s+", "_"));
            }
            BrowserGpu.reportProgress(line.toString());
        } catch (Throwable unavailable) {
            BrowserGpu.reportProgress("widgets:probe-failed "
                    + unavailable.getClass().getName() + ":" + unavailable.getMessage());
        }
    }

    /**
     * Reports what the GUI half of the frame produced.
     *
     * <p>26.2 splits the frame into extract (build a {@code GuiRenderState}) and
     * render (submit it). A screen that looks alive from Java while the host
     * receives no {@code minecraft:pipeline/gui} draws is one of: the extract
     * being skipped (it is gated on {@code isGameLoadFinished} and on the
     * overlay being gone), the extract producing an empty state, or the state
     * failing to reach the GPU. Counting elements at the seam separates them.</p>
     */
    private static void reportGuiState() {
        try {
            net.minecraft.client.gui.Gui gui = minecraft.gui;
            Object screen = gui.screen();
            Object overlay = gui.overlay();
            // Re-extract into a throwaway state rather than reading the live
            // one: GuiRenderer.render() resets it as its last act, so after
            // runTick the real state is always empty and counting it says
            // nothing. This asks the screen directly whether it produces any
            // geometry at all.
            Object state = new net.minecraft.client.renderer.state.gui.GuiRenderState();
            if (screen != null) {
                net.minecraft.client.gui.GuiGraphicsExtractor extractor =
                        new net.minecraft.client.gui.GuiGraphicsExtractor(
                                minecraft,
                                (net.minecraft.client.renderer.state.gui.GuiRenderState) state,
                                0,
                                0);
                ((net.minecraft.client.gui.screens.Screen) screen)
                        .extractRenderStateWithTooltipAndSubtitles(extractor, 0, 0, 0.0F);
            }

            int[] counts = new int[3];
            Class<?> stateClass = state.getClass();
            Class<?> rangeClass = Class.forName(
                    "net.minecraft.client.renderer.state.gui.GuiRenderState$TraverseRange");
            Object all = Enum.valueOf(rangeClass.asSubclass(Enum.class), "ALL");
            stateClass.getMethod("forEachElement", java.util.function.Consumer.class, rangeClass)
                    .invoke(state, (java.util.function.Consumer<Object>) e -> counts[0]++, all);
            stateClass.getMethod("forEachText", java.util.function.Consumer.class)
                    .invoke(state, (java.util.function.Consumer<Object>) e -> counts[1]++);
            stateClass.getMethod("forEachItem", java.util.function.Consumer.class)
                    .invoke(state, (java.util.function.Consumer<Object>) e -> counts[2]++);

            // What kind of geometry, not just how much: buttons and labels are
            // atlas sprites and glyphs, and those are exactly the two kinds
            // missing from the canvas.
            java.util.TreeMap<String, Integer> kinds = new java.util.TreeMap<>();
            stateClass.getMethod("forEachElement", java.util.function.Consumer.class, rangeClass)
                    .invoke(state, (java.util.function.Consumer<Object>) e ->
                            kinds.merge(e.getClass().getSimpleName(), 1, Integer::sum), all);

            BrowserGpu.reportProgress("gui-state:"
                    + " loadFinished=" + minecraft.isGameLoadFinished()
                    + " overlay=" + (overlay == null ? "<none>" : overlay.getClass().getSimpleName())
                    + " screen=" + (screen == null ? "<none>" : screen.getClass().getSimpleName())
                    + " elements=" + counts[0] + " texts=" + counts[1] + " items=" + counts[2]
                    + " kinds=" + kinds
                    + " fontWidth(Minecraft)=" + minecraft.font.width("Minecraft")
                    + " lineHeight=" + minecraft.font.lineHeight);
        } catch (Throwable unavailable) {
            BrowserGpu.reportProgress("gui-state:probe-failed "
                    + unavailable.getClass().getName() + ":" + unavailable.getMessage());
        }
    }

    /**
     * Marks a point in the first few frames on the RPC log.
     *
     * <p>The one channel proven to work from a stalled run: it is a blocking
     * call on the thread being traced, so it cannot be starved the way a
     * watchdog thread can, and it lands in the GPU Worker's own log.</p>
     */
    private static void trace(String point) {
        if (frameCount < 4) {
            BrowserGpu.reportProgress("pump:" + point + " frame=" + frameCount
                    + " phase=" + currentPhase);
        }
    }

    /**
     * Names the frame phase a wedged run is sitting in.
     *
     * <p>Deliberately not a stack dump: {@code getStackTrace} needs a safepoint
     * handshake, and a main thread parked in a futex never answers one, so the
     * old stackbeat wedged the JVM it was meant to describe. Reading a volatile
     * phase field and {@link Thread#getState()} needs no handshake, and this
     * thread's own {@code System.out} keeps working while main is parked.</p>
     */
    private static void startPhaseWatchdog() {
        if (System.getProperty("mcweb.framewatchdog") == null) {
            return;
        }
        final Thread main = Thread.currentThread();
        final int intervalMillis = Integer.getInteger("mcweb.framewatchdog.ms", 2000);
        Thread watchdog = new Thread(() -> {
            BrowserGpu.reportProgress("frame-watchdog: started interval=" + intervalMillis + "ms");
            java.util.Map<String, Integer> hot = new java.util.HashMap<>();
            int samples = 0;
            while (true) {
                // Spin rather than sleep: a timed futex wait on this runtime
                // does not reliably wake, and a watchdog that never runs is
                // worse than one that costs a core.
                long until = System.nanoTime() + intervalMillis * 1_000_000L;
                while (System.nanoTime() < until) {
                    Thread.onSpinWait();
                }
                StackTraceElement[] trace = main.getStackTrace();
                if (trace.length == 0) {
                    continue;
                }
                samples++;
                // Attribute the sample to the deepest frame that is game code:
                // the leaf is usually a JDK primitive and says nothing about
                // which part of worldgen is expensive.
                for (StackTraceElement el : trace) {
                    String cls = el.getClassName();
                    if (cls.startsWith("java.") || cls.startsWith("jdk.")
                            || cls.startsWith("it.unimi") || cls.startsWith("com.google")) {
                        continue;
                    }
                    hot.merge(cls + "." + el.getMethodName(), 1, Integer::sum);
                    break;
                }
                StringBuilder line = new StringBuilder("frame-watchdog: #").append(samples)
                        .append(" frame=").append(frameCount)
                        .append(" phase=").append(currentPhase)
                        .append(" depth=").append(trace.length)
                        .append("\n    top: ");
                for (int i = 0; i < Math.min(trace.length, 10); i++) {
                    line.append("\n      ").append(trace[i]);
                }
                if (samples % 10 == 0) {
                    line.append("\n    hottest (").append(samples).append(" samples):");
                    hot.entrySet().stream()
                            .sorted(java.util.Map.Entry.<String, Integer>comparingByValue().reversed())
                            .limit(12)
                            .forEach(e -> line.append("\n      ").append(e.getValue())
                                    .append("  ").append(e.getKey()));
                }
                BrowserGpu.reportProgress(line.toString());
            }
        }, "mcweb-frame-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
    }

    /**
     * Keeps Minecraft's inactivity throttle honest.
     *
     * <p>Vanilla resets it from SDL key, button and scroll events. This
     * port additionally counts cursor movement: the desktop reason for ignoring
     * it — a stray mouse should not keep an unattended game at full speed — is
     * already handled by the browser, which stops delivering animation frames
     * to a hidden tab entirely.</p>
     */
    static void noteInput() {
        if (minecraft == null) {
            return;
        }
        try {
            minecraft.getFramerateLimitTracker().onInputReceived();
        } catch (Throwable ignored) {
            // Pacing is an optimisation; input must never fail because of it.
        }
    }

    static void frame() {
        if (minecraft == null || failed) {
            return;
        }
        // Quit Game only clears Minecraft's `running` flag, which the desktop
        // run() loop would have noticed. This pump replaces that loop, so the
        // button did nothing at all: no unload, no menu, a live canvas.
        if (!quitting && !minecraft.isRunning()) {
            quitting = true;
            handleQuit();
            return;
        }
        final long frameStartedNanos = System.nanoTime();
        currentPhase = "frame.pre-tick";
        try {
            // Input is pulled, not pushed, on the OpenJDK lane. It has to run
            // inside the frame body: the drain only queues SDL events, the
            // pollEvents call below hands them to Minecraft's handlers, and
            // those post to its main-thread queue, which runTick drains a few
            // lines below — draining from outside the frame left the events
            // queued with nothing to run them.
            BrowserInputBridge.drainHostEvents();
            autoPlay();
            BrowserMinecraftMain.applyBenchmarkSeedIfPresent();
            // Multiplayer: the gateway sockets' traffic, then a page-issued join.
            BrowserMultiplayerCompat.pump();
            // Vanilla download IO threads wait on bounded browser HTTP pulls;
            // only this client thread crosses the GPU worker's RPC boundary.
            BrowserPackHttp.pump();
            RenderSystem.pollEvents(minecraft.sdlEventHandler);
            int reloadCompletion = BrowserReloadDiagnostics.consumeReloadCompletion();
            if (reloadCompletion != 0) {
                BrowserGpu.reportProgress("reload:all-done result="
                        + (reloadCompletion > 0 ? "success" : "failure"));
                if (reloadCompletion > 0 && McWebRuntimeMode.isThreaded()) {
                    postReloadGcRequested = true;
                }
            }
            /*
             * Collect at the exact reload boundary, before the next interactive
             * frame. This is intentionally independent of screen class: screen
             * transitions are not a safe proxy for reload completion and made the
             * old Accessibility/Title path stutter visibly.
            */
            if (postReloadGcRequested && postReloadGcAttempts < 3) {
                long before = observedCollections();
                long refusalsBefore = observedAgentRefusals();
                if (postReloadGcBefore < 0L) {
                    postReloadGcBefore = before;
                }
                postReloadGcAttempts++;
                BrowserGpu.reportProgress("gc:post-reload-start attempt=" + postReloadGcAttempts);
                System.gc();
                long after = observedCollections();
                long refusalsAfter = observedAgentRefusals();
                boolean progressed = before >= 0L && after > before;
                boolean refused = refusalsBefore >= 0L && refusalsAfter > refusalsBefore;
                BrowserGpu.reportProgress("gc:post-reload-done attempt=" + postReloadGcAttempts
                        + " before=" + before + " after=" + after
                        + " progressed=" + progressed + " refused=" + refused);
                // Keep the flag for at most two later overlay frames when the
                // collector explicitly refused to park workers. A successful
                // collection, an ignored System.gc(), or the bounded attempt limit
                // ends the lifecycle request.
                postReloadGcRequested = !progressed && refused && postReloadGcAttempts < 3;
                if (!postReloadGcRequested) {
                    postReloadGcBefore = -1L;
                }
            }
            AgentExecutorService.servicePrimaryCollectionRequest("frame-boundary");
            // The boolean enables the render section of runTick; every
            // scheduled callback is a real, fully rendered game frame.
            currentPhase = "frame.minecraft-run-tick";
            minecraft.runTick(true);
            trace("run-tick-returned");
            BrowserClientProfile.pump(minecraft);
            currentPhase = "frame.post-tick.storage";
            // Minecraft's client files live in Web Image's in-memory filesystem.
            // Publish changed options/server-list/resource-pack files at a
            // bounded cadence; IndexedDB writes stay asynchronous on the page.
            BrowserPersistentStorage.pump();
            currentPhase = "frame.post-tick.pacing";
            trace("storage-done");
            // FramerateLimitTracker includes Minecraft's menu/AFK throttles,
            // while enableVsync is the user's presentation choice. Publish a
            // change only when either value moves so the browser scheduler can
            // match desktop semantics without adding a hot bridge crossing.
            updateBrowserFramePacing();
            frameCount++;
            currentPhase = "frame.post-tick.report";
            trace("pacing-done");
            BrowserGpu.reportFrame(frameCount);
            currentPhase = "frame.post-tick.mesh";
            trace("report-done");
            AgentExecutorService.maintain();
            // Small budget: this only fires when every worker is busy and work is still
            // queued, which is the starvation the pool cannot resolve on its own. Kept
            // far below the world-load budget so a starved pool costs frame time rather
            // than the frame.
            if (McWebRuntimeMode.isCooperativeServer()) {
                AgentExecutorService.drainInlineIfStarved(4);
            }
            BrowserReloadDiagnostics.heartbeat(frameCount);
            // The GUI/input/thread census. Nothing in the harness reads any of
            // it, and reportGuiState() re-extracts the screen into a throwaway
            // render state while resolving four methods by reflection, so it is
            // ?frameDiag=1 only. -Dmcweb.autoclick still runs it: describeHitTest
            // drives the click that autoclick exists to perform.
            if ((frameDiag || autoclick) && frameCount % 120 == 1) {
                BrowserGpu.reportProgress("threads:" + describeThreadIdentity());
                BrowserSkinTextureCompat.reportLivePlayerState(minecraft);
                reportGuiState();
                // xpos/ypos prove the cursorPos path; lastInputType is set by
                // MouseHandler.onButton immediately after its window-handle
                // gate, so seeing MOUSE proves the button reached the game.
                BrowserGpu.reportProgress("input-events: "
                        + BrowserInputCompat.describe()
                        + " mouse=" + (int) minecraft.mouseHandler.xpos()
                        + "," + (int) minecraft.mouseHandler.ypos()
                        + " scaled=" + (int) minecraft.mouseHandler.getScaledXPos(minecraft.getWindow())
                        + "," + (int) minecraft.mouseHandler.getScaledYPos(minecraft.getWindow())
                        + " lastInput=" + minecraft.getLastInputType()
                        + " windowHandle=" + minecraft.getWindow().handle()
                        + " pending=" + minecraft.getPendingTasksCount()
                        + " selfTest=" + selfTestCursor()
                        + " hits=" + describeHitTest());
            }
            String screenClass = minecraft.gui.screen() == null
                    ? "<none>"
                    : minecraft.gui.screen().getClass().getName();
            if (!screenClass.equals(lastScreenClass)) {
                lastScreenClass = screenClass;
                // Widget count with it: a screen that draws its background but
                // no text or buttons is indistinguishable from a working one on
                // the host side, and an init() that died leaves exactly that.
                String widgets = "";
                try {
                    net.minecraft.client.gui.screens.Screen screen = minecraft.gui.screen();
                    if (screen != null) {
                        widgets = " children=" + screen.children().size()
                                + " size=" + screen.width + "x" + screen.height;
                        // What the screen says (a disconnect screen's reason
                        // included), for drivers that cannot read the canvas.
                        String said = screen.getNarrationMessage().getString().replace('\n', ' ');
                        widgets += " says=\"" + (said.length() > 200 ? said.substring(0, 200) : said) + "\"";
                    }
                } catch (Throwable unavailable) {
                    widgets = " children=<" + unavailable.getClass().getName() + ">";
                }
                BrowserGpu.reportProgress("screen:" + screenClass + widgets);
                reportScreenWidgets();
            }
            // ?bootSampler=1: its report once the title screen is up.
            if (BrowserBootSampler.ENABLED) {
                BrowserBootSampler.screen(screenClass, screenClass.endsWith(".TitleScreen"),
                        BrowserGpu::reportProgress);
            }
            reportWorldState();
            reportGameplayState();
            reportTerrainState();
            reportFlow();
            reloadStress();
            BrowserIntegratedServerCompat.requestChunkSlice(minecraft.getSingleplayerServer());
            consecutiveFailures = 0;
        } catch (Throwable frameFailure) {
            consecutiveFailures++;
            reportedFailures++;
            String failurePhase = currentPhase;
            // Key this to total reports, not consecutive failures. An
            // intermittent fault has successful frames between occurrences;
            // the old counter therefore reran the bisect and emitted a full
            // crash report forever.
            String noRenderResult = "";
            if (reportedFailures == 1) {
                try {
                    minecraft.runTick(false);
                    noRenderResult = "runTick(false)=OK";
                } catch (Throwable noRenderFailure) {
                    noRenderResult = "runTick(false)=" + noRenderFailure.getClass().getName()
                            + ":" + noRenderFailure.getMessage();
                }
            }
            // A failing frame used to latch `failed` forever, so one bad frame
            // ended the session: the screen froze on whatever was last drawn and
            // every later frame returned immediately. That is why terrain
            // "stopped drawing" two frames after it started -- the pump was dead,
            // not the renderer. Every report so far says runTick(false)=OK, so
            // the simulation survives and only rendering threw; dropping the
            // frame and trying again is strictly better than ending the run.
            // Still bounded, so a permanently broken renderer cannot spin.
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                failed = true;
            }
            if (reportedFailures > MAX_REPORTED_FAILURES) {
                return;
            }
            if (reportedFailures == 1
                    && frameFailure instanceof net.minecraft.ReportedException reported) {
                BrowserMinecraftMain.reportCrashReport(
                        "frame:crash-report:", reported.getReport());
            }
            if (reportedFailures == 1 && hasCause(frameFailure, IllegalMonitorStateException.class)) {
                BrowserGpu.reportProgress("frame:lock-state:" + describeCopyLock() + BrowserCopyLockTrace.describe());
            }
            String detail = BrowserMinecraftMain.describeFailure(frameFailure)
                    + " | phase=" + failurePhase
                    + " | consecutive=" + consecutiveFailures
                    + " | reported=" + reportedFailures + "/" + MAX_REPORTED_FAILURES
                    + (noRenderResult.isEmpty() ? "" : " | " + noRenderResult);
            // A bare OutOfMemoryError carries no message and no useful cause
            // chain, so the report on its own says nothing about what exhausted
            // the heap. The boot path already dumps heap totals plus the largest
            // live native blocks; the frame pump needs the same, because this is
            // where terrain meshing actually runs out of memory.
            if (BrowserMinecraftMain.isHeapExhaustion(frameFailure)) {
                detail += " | " + BrowserMinecraftMain.describeHeapAtFailure()
                        + " | headroom=" + probeHeadroom();
            }
            detail += " | at " + topFrames(frameFailure, 12);
            BrowserGpu.reportJavaFailure(
                    "frame#" + frameCount,
                    frameFailure.getClass().getName(),
                    detail
            );
        }
    }

    /**
     * Unloads the game and hands the page back to the launcher.
     *
     * <p>The page reloads rather than reconstructing Minecraft in place: the
     * image's statics, the render system and the GPU objects are all built once
     * per {@code main}, so a second {@code new Minecraft(GameConfig)} in the
     * same heap is not a supported state. The runtime is already in Cache
     * Storage, so the return trip is the launcher's ordinary warm start.</p>
     */
    private static void handleQuit() {
        currentPhase = "frame.quit";
        BrowserGpu.reportProgress("lifecycle:quit-requested");
        try {
            BrowserPersistentStorage.syncClientFilesNow();
        } catch (Throwable ignored) {
            // Options and server list are best-effort at this point.
        }
        // No further frames: the page owns the tear-down from here.
        failed = true;
        BrowserGpu.reportProgress("lifecycle:quit-handed-to-page");
        returnToLauncher();
    }

    @JS.Coerce
    @JS(value = "globalThis.mcWebLifecycle?.quitToLauncher?.();", args = {})
    private static native void returnToLauncher();

    private static void updateBrowserFramePacing() {
        FramerateLimitTracker tracker = minecraft.getFramerateLimitTracker();
        FramerateThrottleReason throttleReason = tracker.getThrottleReason();
        int configuredLimit = minecraft.options.framerateLimit().get();
        int effectiveLimit = tracker.getFramerateLimit();
        // Desktop Minecraft hard-codes 60 FPS while no ClientLevel exists.
        // That is useful for a native title screen, but it became an arbitrary
        // browser cap during boot, menus, and dimension hand-off even though
        // the user selected a higher limit and the host already has a finite
        // runaway-safety ceiling. Preserve the meaningful iconified/AFK
        // throttles; only the out-of-level 60 FPS special case is omitted.
        int selectedLimit = throttleReason == FramerateThrottleReason.OUT_OF_LEVEL_MENU
                ? configuredLimit
                : effectiveLimit;
        int frameLimit = Math.max(1, Math.min(260, selectedLimit));
        boolean vsync = minecraft.options.enableVsync().get();
        if (frameLimit == lastBrowserFrameLimit && vsync == lastBrowserVsync) {
            return;
        }
        lastBrowserFrameLimit = frameLimit;
        lastBrowserVsync = vsync;
        BrowserGpu.configureFramePacing(vsync, frameLimit);
        BrowserGpu.reportProgress("frame-pacing:vsync=" + vsync
                + " maxFps=" + frameLimit
                + " configured=" + configuredLimit
                + " tracker=" + effectiveLimit
                + " reason=" + throttleReason);
    }

    @JS.Coerce
    @JS(value = "const c=globalThis.mcWebThreadRuntime?.imageCounters?.();"
            + "return c && typeof c.gcStopped === 'number' && typeof c.gcUncontended === 'number'"
            + " ? c.gcStopped + c.gcUncontended : -1;", args = {})
    private static native int observedCollections();

    @JS.Coerce
    @JS(value = "const c=globalThis.mcWebThreadRuntime?.imageCounters?.();"
            + "return c && typeof c.gcAgentRefused === 'number' ? c.gcAgentRefused : -1;", args = {})
    private static native int observedAgentRefusals();

    /**
     * Identity of the browser thread as Minecraft's event loop sees it.
     *
     * <p>{@code BlockableEventLoop.isSameThread()} is a reference comparison of
     * {@code Thread.currentThread()} against the loop's running thread, and the
     * whole client depends on it: {@code Minecraft.execute} runs a task inline
     * only when it holds, and the transformed {@code blockUntilDone} drains the
     * main queue only when it holds. If {@code Thread.currentThread()} does not
     * return one stable object on the primary WasmLM agent, every deferred task
     * — including every UI click — is queued and never run, and the wait loops
     * spin instead of draining.</p>
     */
    private static String describeThreadIdentity() {
        StringBuilder state = new StringBuilder();
        try {
            Thread first = Thread.currentThread();
            Thread second = Thread.currentThread();
            state.append("stable=").append(first == second)
                    .append(" id=").append(first.getId())
                    .append(" name=").append(first.getName())
                    .append(" hash=").append(System.identityHashCode(first))
                    .append(" secondHash=").append(System.identityHashCode(second))
                    .append(" sameThread=").append(minecraft.isSameThread())
                    .append(" mainQueue=").append(minecraft.getPendingTasksCount());
        } catch (Throwable failure) {
            state.append(" identity-failed=").append(failure.getClass().getSimpleName());
        }
        try {
            state.append(' ').append(AgentExecutorService.stats());
        } catch (Throwable failure) {
            state.append(" pool-failed=").append(failure.getClass().getSimpleName());
        }
        return state.toString();
    }

    /**
     * How much the heap will still hand out immediately after an
     * OutOfMemoryError.
     *
     * <p>This settles the question every other measurement has dodged. A bare
     * {@code OutOfMemoryError} carries no message, Web Image strips stack
     * traces, {@code Runtime}'s numbers are inert here (used always reads 0),
     * and {@code performance.memory} covers only the JS heap — not the WasmGC
     * one. So the heap is asked directly: if 64 MiB still allocates the instant
     * after the throw, nothing was exhausted and the failure was one oversized
     * or pathological request; if even 1 MiB fails, it is a genuine ceiling and
     * the fix is to shrink the resident set.</p>
     */
    private static String probeHeadroom() {
        StringBuilder result = new StringBuilder();
        for (int megabytes : new int[] {1, 8, 32, 64, 128}) {
            boolean ok;
            try {
                byte[] probe = new byte[megabytes * 1024 * 1024];
                // Touch both ends so the allocation cannot be elided.
                probe[0] = 1;
                probe[probe.length - 1] = 1;
                ok = true;
            } catch (Throwable outOfMemory) {
                ok = false;
            }
            result.append(megabytes).append("MiB=").append(ok ? "ok" : "FAIL").append(' ');
        }
        return result.toString().trim();
    }

    private static String lastTerrainState;
    private static long nextTerrainReportFrame;

    /**
     * Reports the state of the chunk-section render pipeline.
     *
     * <p>In-world the frame draws sky, fog, entities and the HUD but no block
     * geometry, and the F3 overlay omits its section-count line entirely. That
     * narrows the fault to the section pipeline, but not to a stage within it,
     * so this walks the pipeline end to end: whether the {@code ViewArea}
     * exists at all, how many sections it holds, how many the occlusion graph
     * considers visible, and — for those visible sections — how many actually
     * carry a compiled mesh with renderable layers.</p>
     *
     * <p>The distinction is what identifies the culprit. Sections present but
     * none visible means the occlusion/frustum stage; sections visible but no
     * renderable meshes means the compile or upload stage; no ViewArea at all
     * means the renderer was never set up for the level.</p>
     */
    private static void reportTerrainState() {
        if (minecraft.level == null || frameCount < nextTerrainReportFrame) {
            return;
        }
        // Sampling: this walks the visible-section list, which is cheap next to
        // a frame but not free, and the numbers only matter as they change.
        // Sample every frame at first, then back off. The intermittent OOM ends
        // in-world runs after a few dozen frames, and at any coarser interval
        // every run so far produced exactly one sample -- which cannot tell a
        // state that never changes from a probe that only ran once. Several
        // consecutive frames are what make per-frame churn (a ViewArea rebuilt
        // every frame, say) visible at all.
        nextTerrainReportFrame = frameCount + (terrainReportCount < 40 ? 1 : 60);
        terrainReportCount++;
        String state;
        try {
            net.minecraft.client.renderer.LevelRenderer renderer = minecraft.levelRenderer;
            if (renderer == null) {
                state = "levelRenderer=null";
            } else {
                net.minecraft.client.renderer.ViewArea area = renderer.viewArea();
                if (area == null) {
                    state = "viewArea=null";
                } else {
                    var visible = renderer.visibleSections();
                    int withMesh = 0;
                    int renderable = 0;
                    for (var section : visible) {
                        net.minecraft.client.renderer.chunk.SectionMesh mesh = section.getSectionMesh();
                        if (mesh != null) {
                            withMesh++;
                            if (mesh.hasRenderableLayers()) {
                                renderable++;
                            }
                        }
                    }
                    // What is left after the census is the deep probe: a grid
                    // of sections around the player, 40 block reads under it,
                    // and three full octree walks behind occlusionState(). It
                    // changes none of the numbers compare-lanes samples, so it
                    // is ?terrainDiag=1 only (deepTerrainState).
                    //
                    // clientChunks is the exact count of chunks the client has
                    // actually received and stored. Every other number here is
                    // derived from the render graph, which can lag or cull;
                    // this one answers "did the chunk arrive at all" on its
                    // own, and is the client-side counterpart to the server's
                    // trackedReady.
                    String clientChunks = "n/a";
                    if (minecraft.level.getChunkSource()
                            instanceof net.minecraft.client.multiplayer.ClientChunkCache cache) {
                        clientChunks = cache.getLoadedChunksCount() + " " + cache.gatherStats();
                    }
                    state = "total=" + area.size()
                            + " clientChunks=" + clientChunks
                            + " visible=" + visible.size()
                            + " nearbyVisible=" + renderer.nearbyVisibleSections().size()
                            + " visWithMesh=" + withMesh
                            + " visRenderable=" + renderable
                            + (terrainDiag ? deepTerrainState(renderer, area) : "")
                            + serverTickState();
                }
            }
        } catch (Throwable probeFailure) {
            state = "probe-failed:" + probeFailure.getClass().getName()
                    + ":" + probeFailure.getMessage();
        }
        if (!state.equals(lastTerrainState)) {
            lastTerrainState = state;
            BrowserGpu.reportProgress("terrain:" + state);
        }
    }

    /**
     * The stage-finding half of {@code terrain:} — the part that says <em>which
     * stage</em> of the section pipeline is stuck rather than how much of it
     * runs. Behind {@code ?terrainDiag=1}.
     *
     * <p>It is the expensive half by an order of magnitude: 100 section lookups
     * in a 5x5x4 grid around the player, 40 block reads below them, a
     * reflective read of the graph's loaded-chunk set, and
     * {@link #occlusionState} walking the whole octree three times with a
     * bounded replay of the frustum-offset loop between two of them. All of it
     * ran once a minute (every frame for the first forty) in every run, for
     * numbers the benchmark harness never reads.</p>
     */
    private static String deepTerrainState(
            net.minecraft.client.renderer.LevelRenderer renderer,
            net.minecraft.client.renderer.ViewArea area) {
        try {
            // visible == 0 cannot distinguish "no meshes were ever compiled"
            // from "meshes exist but the occlusion graph culls them all", and
            // those have opposite fixes. Sampling the sections around the
            // player answers it directly, because it bypasses visibility.
            int sampled = 0;
            int sampledWithMesh = 0;
            int sampledRenderable = 0;
            int sampledWithNode = 0;
            var graph = renderer.sectionOcclusionGraph();
            int sampledUncompiled = 0;
            int sampledEmpty = 0;
            int sampledCompiled = 0;
            if (minecraft.player != null) {
                net.minecraft.core.BlockPos origin = minecraft.player.blockPosition();
                for (int dx = -32; dx <= 32; dx += 16) {
                    for (int dz = -32; dz <= 32; dz += 16) {
                        for (int dy = -32; dy <= 16; dy += 16) {
                            var section = area.getRenderSectionAt(origin.offset(dx, dy, dz));
                            if (section == null) {
                                continue;
                            }
                            sampled++;
                            var mesh = section.getSectionMesh();
                            if (mesh != null) {
                                sampledWithMesh++;
                                if (mesh.hasRenderableLayers()) {
                                    sampledRenderable++;
                                }
                                // A non-null mesh proves nothing on its
                                // own: CompiledSectionMesh.UNCOMPILED
                                // and EMPTY are shared sentinels that
                                // inherit hasRenderableLayers() = false
                                // from the interface default. Only the
                                // identity of the instance separates
                                // "never compiled" from "compiled to
                                // nothing", and those have unrelated
                                // fixes.
                                // The occlusion graph only has a Node
                                // for a section once its full update
                                // has actually run. That update is a
                                // CompletableFuture.runAsync on
                                // Util.backgroundExecutor(), which this
                                // port replaces -- so "graph has no
                                // nodes" (update never ran) and "graph
                                // built but the frustum culls all of
                                // it" both present as visible == 0 and
                                // need opposite fixes.
                                if (graph != null && graph.getNode(section) != null) {
                                    sampledWithNode++;
                                }
                                if (mesh == net.minecraft.client.renderer.chunk.CompiledSectionMesh.UNCOMPILED) {
                                    sampledUncompiled++;
                                } else if (mesh == net.minecraft.client.renderer.chunk.CompiledSectionMesh.EMPTY) {
                                    sampledEmpty++;
                                } else {
                                    sampledCompiled++;
                                }
                            }
                        }
                    }
                }
            }
            // Every sampled section has a mesh yet none has renderable
            // layers, so the compile step is producing empty results.
            // That has two very different causes: the client level
            // really is air here (chunk payload never applied), or the
            // blocks exist and the mesh build drops them (models,
            // atlas, buffer upload). Counting non-air blocks in the
            // client level under the player separates the two.
            int solidBelow = 0;
            String groundBlock = "n/a";
            if (minecraft.player != null) {
                net.minecraft.core.BlockPos origin = minecraft.player.blockPosition();
                for (int dy = 0; dy < 40; dy++) {
                    net.minecraft.core.BlockPos probe = origin.below(dy);
                    var blockState = minecraft.level.getBlockState(probe);
                    if (!blockState.isAir()) {
                        solidBelow++;
                        if (groundBlock.equals("n/a")) {
                            groundBlock = blockState.getBlock().toString();
                        }
                    }
                }
            }
            // Visibility comes from an Octree built around the view
            // area's camera section, and Octree.add() rejects anything
            // outside those bounds. If the camera section is stale --
            // still the origin from before the player spawned, say --
            // every add fails and the octree stays empty, which is
            // indistinguishable from "propagation never ran" in every
            // other number here.
            String cameraSection = "n/a";
            String playerSection = "n/a";
            try {
                cameraSection = String.valueOf(area.getCameraSectionPos());
                if (minecraft.player != null) {
                    playerSection = String.valueOf(
                            net.minecraft.core.SectionPos.of(minecraft.player.blockPosition())
                    );
                }
            } catch (Throwable ignored) {
                cameraSection = "failed";
            }
            return " cameraSection=" + cameraSection
                    + " playerSection=" + playerSection
                    + " height=" + area.sectionCount()
                    + " viewDistance=" + area.getViewDistance()
                    + " sampled=" + sampled
                    + " sampledWithMesh=" + sampledWithMesh
                    + " sampledRenderable=" + sampledRenderable
                    + " withNode=" + sampledWithNode
                    + " expectedChunks=" + (graph == null ? "n/a" : graph.expectedChunks().size())
                    + describeGraphWaits(graph, area)
                    + " uncompiled=" + sampledUncompiled
                    + " empty=" + sampledEmpty
                    + " compiled=" + sampledCompiled
                    + " solidBelow=" + solidBelow
                    + " ground=" + groundBlock
                    + " dispatcher=[" + dispatcherState(renderer) + "]"
                    + " occlusion=[" + occlusionState(renderer, graph) + "]";
        } catch (Throwable probeFailure) {
            return " deep-probe-failed:" + probeFailure.getClass().getName()
                    + ":" + probeFailure.getMessage();
        }
    }

    /**
     * The integrated server's smoothed tick time (what F3 shows as ms/tick; over
     * 50 means it cannot keep 20 ticks a second, and player actions queue behind
     * it) and how many entities the client holds. Both reads are what the debug
     * screen does from this thread.
     */
    private static long lastChunkPipeNanos;

    private static String serverTickState() {
        try {
            net.minecraft.client.server.IntegratedServer server = minecraft.getSingleplayerServer();
            long now = System.nanoTime();
            if (server != null && now - lastChunkPipeNanos > 5_000_000_000L) {
                lastChunkPipeNanos = now;
                String pipe = BrowserIntegratedServerCompat.chunkPipeline;
                if (pipe != null) {
                    BrowserGpu.reportProgress("chunkpipe:" + pipe);
                }
                server.execute(() -> BrowserIntegratedServerCompat.sampleChunkPipeline(server));
            }
            return " mspt=" + (server == null ? "n/a" : String.valueOf(Math.round(server.getCurrentSmoothedTickTime())))
                    + " entities=" + (minecraft.level == null ? "n/a" : String.valueOf(minecraft.level.getEntityCount()));
        } catch (Throwable failure) {
            return " mspt=failed";
        }
    }

    /**
     * State of the step that fills {@code visibleSections}: the octree census
     * and the frustum that filters it.
     *
     * <p>{@code visible=0} has three surviving causes that every other number
     * here reports identically, so each gets its own measurement.</p>
     *
     * <ul>
     * <li>{@code inTree} — sections the octree holds at all, counted through a
     * deliberately permissive frustum. Zero means propagation never reached
     * {@code Octree.add}; non-zero rules the octree out, which a host-JVM
     * harness against the real jar already did for the insert path itself
     * (75/75 added).</li>
     * <li>{@code inFrustum} — the same walk under the real cull frustum. A gap
     * against {@code inTree} means the frustum is culling everything.</li>
     * <li>{@code offsetIters} — {@code addSectionsInFrustum} does not use the
     * cull frustum directly, it uses
     * {@code offsetToFullyIncludeCameraCube(8)}, an <em>unbounded</em> loop
     * that walks the camera back along {@code viewVector} until an 8-block cube
     * is fully inside. That vector is row 2 of projection*view, so a projection
     * built with reverse-Z inverts its sign and shrinks it by ~20000x: measured
     * on the host JVM, the vanilla forward-Z culling projection converges in 4
     * iterations while a reverse-Z one never converges. This replicates the
     * loop with a bound rather than calling it, because the real method would
     * hang the frame instead of reporting the problem.</li>
     * </ul>
     */
    private static String occlusionState(
            final net.minecraft.client.renderer.LevelRenderer renderer,
            final net.minecraft.client.renderer.SectionOcclusionGraph graph) {
        try {
            if (graph == null) {
                return "graph=null";
            }
            net.minecraft.client.Camera camera = minecraft.gameRenderer.mainCamera();
            net.minecraft.client.renderer.culling.Frustum cull = camera.getCullFrustum();
            if (cull == null) {
                return "cullFrustum=null";
            }
            net.minecraft.client.renderer.Octree tree = graph.getOctree();
            if (tree == null) {
                return "octree=null";
            }

            // offset(t) advances the camera by viewVector*t, and is the only
            // public surface that exposes the vector the offset loop steps by.
            net.minecraft.client.renderer.culling.Frustum vectorProbe =
                    new net.minecraft.client.renderer.culling.Frustum(cull);
            double baseX = vectorProbe.getCamX();
            double baseY = vectorProbe.getCamY();
            double baseZ = vectorProbe.getCamZ();
            vectorProbe.offset(1.0F);
            double viewX = vectorProbe.getCamX() - baseX;
            double viewY = vectorProbe.getCamY() - baseY;
            double viewZ = vectorProbe.getCamZ() - baseZ;

            int[] inTree = countOctree(tree, permissiveFrustum(baseX, baseY, baseZ));
            int[] inFrustum = countOctree(tree, cull);
            // The one that matters: addSectionsInFrustum does not walk with the
            // cull frustum, it walks with offsetFrustum(cull) -- the camera
            // pushed back along viewVector until its own 8-block cube is fully
            // inside. inFrustum counts what the plain cull frustum sees;
            // inOffset counts what applyFrustum would actually have collected.
            // A gap between them means the offset step is the fault.
            net.minecraft.client.renderer.culling.Frustum offset =
                    new net.minecraft.client.renderer.culling.Frustum(cull);
            String iterations = offsetConvergence(offset);
            int[] inOffset = countOctree(tree, offset);
            return "inTree=" + inTree[1] + "/" + inTree[0]
                    + " inFrustum=" + inFrustum[1] + "/" + inFrustum[0]
                    + " inOffset=" + inOffset[1] + "/" + inOffset[0]
                    + " offsetCam=(" + round(offset.getCamX() - baseX)
                    + "," + round(offset.getCamY() - baseY)
                    + "," + round(offset.getCamZ() - baseZ) + ")"
                    + " view=(" + round(viewX) + "," + round(viewY) + "," + round(viewZ) + ")"
                    + " offsetIters=" + iterations
                    + " shape=" + frustumShape(cull)
                    + " window=" + minecraft.getWindow().getWidth()
                    + "x" + minecraft.getWindow().getHeight()
                    + " fov=" + minecraft.options.fov().get()
                    + " zZeroToOne=" + RenderSystem.getDevice().getDeviceInfo().isZZeroToOne()
                    + " " + applyFrustumGates(renderer, camera);
        } catch (Throwable probeFailure) {
            return "failed:" + probeFailure.getClass().getName() + ":" + probeFailure.getMessage();
        }
    }

    /**
     * The three conditions that can stop {@code LevelExtractor.extract} from
     * calling {@code applyFrustum}, which is the only writer of
     * {@code visibleSections}.
     *
     * <p>Measured 2026-07-27: the octree holds sections and the cull frustum
     * accepts them ({@code inTree=6}, {@code inFrustum=5}) while
     * {@code visible=0}, so the walk is fine and the call is simply not
     * happening. extract only reaches it when compiled geometry is not being
     * invalidated this frame ({@code invalidateCompiledGeometry} takes the
     * other branch), no debug frustum is captured
     * ({@code camera.getCapturedFrustum()} is null), and either
     * {@code consumeFrustumUpdate()} reports a pending update or the camera
     * rotated;</p>
     *
     * <p>and {@code applyFrustum} itself throws unless
     * {@code Minecraft.isSameThread()}. Each field below pins one of those:
     * {@code sameThread=false} means it throws on entry (and, because
     * {@code consumeFrustumUpdate} is a CAS evaluated first, the flag is
     * consumed and lost, so the state never recovers); {@code captured=true}
     * means the debug frustum-capture branch is swallowing it;
     * {@code viewAreaAge} counting 0 every report means
     * {@code invalidateCompiledGeometry} is re-arming every frame and the
     * {@code else} branch never runs at all.</p>
     */
    private static String applyFrustumGates(
            final net.minecraft.client.renderer.LevelRenderer renderer,
            final net.minecraft.client.Camera camera) {
        String sameThread;
        String threadStable;
        try {
            sameThread = String.valueOf(minecraft.isSameThread());
            // Web Image's thread model is synthetic, so identity of the current
            // thread is worth confirming rather than assuming: if
            // Thread.currentThread() does not return a stable object, every
            // isSameThread() in the game is false and this is the shared cause.
            threadStable = String.valueOf(Thread.currentThread() == Thread.currentThread());
        } catch (Throwable threadFailure) {
            sameThread = "failed";
            threadStable = "failed";
        }
        String captured;
        try {
            captured = String.valueOf(camera.getCapturedFrustum() != null);
        } catch (Throwable capturedFailure) {
            captured = "failed";
        }
        // invalidateCompiledGeometry is the only thing that builds a ViewArea,
        // and it also calls clearVisibleSections() and waitAndReset(). So a
        // rising generation count is a direct count of how often extract takes
        // the invalidate branch -- the branch whose "else" holds applyFrustum.
        // Comparing the generation delta against the report delta says whether
        // it is every frame or occasional.
        net.minecraft.client.renderer.ViewArea area = renderer.viewArea();
        if (area != lastViewArea) {
            lastViewArea = area;
            viewAreaGeneration++;
        }
        // allChanged() is the only setter of shouldInvalidateCompiledGeometry,
        // and extract calls it when getEffectiveRenderDistance() disagrees with
        // the value allChanged itself last stored. If these two disagree, that
        // comparison is the re-arming loop; if they agree, the trigger is a
        // repeated setLevel instead.
        String effective;
        String option;
        try {
            effective = String.valueOf(minecraft.options.getEffectiveRenderDistance());
            option = String.valueOf(minecraft.options.renderDistance().get());
        } catch (Throwable optionFailure) {
            effective = "failed";
            option = "failed";
        }
        // Deliberately not reading needsFrustumUpdate here. consumeFrustumUpdate
        // is a compareAndSet, so reading it steals it from extract, and the
        // reading is confounded anyway: the full update that runs later in the
        // same frame (inside LevelRenderer.render, after extract) sets the flag
        // again, so finding it set after runTick says nothing about whether
        // extract consumed it.
        return "sameThread=" + sameThread
                + " threadStable=" + threadStable
                + " captured=" + captured
                + " viewAreaGen=" + viewAreaGeneration
                + " reports=" + terrainReportCount
                + " rdEffective=" + effective
                + " rdOption=" + option
                + " areaViewDistance=" + area.getViewDistance();
    }

    /** Sections the octree yields under {@code frustum}, as {nodes, sections}. */
    private static int[] countOctree(
            final net.minecraft.client.renderer.Octree tree,
            final net.minecraft.client.renderer.culling.Frustum frustum) {
        int[] counts = new int[2];
        tree.visitNodes((node, fullyInside, depth, nearby) -> {
            counts[0]++;
            if (node.getSection() != null) {
                counts[1]++;
            }
        }, frustum, 32);
        return counts;
    }

    /**
     * A frustum that accepts everything near the camera, so an octree walk
     * counts membership rather than visibility.
     */
    private static net.minecraft.client.renderer.culling.Frustum permissiveFrustum(
            final double camX, final double camY, final double camZ) {
        org.joml.Matrix4f wide = new org.joml.Matrix4f()
                .setOrtho(-1.0E7F, 1.0E7F, -1.0E7F, 1.0E7F, -1.0E7F, 1.0E7F, true);
        net.minecraft.client.renderer.culling.Frustum frustum =
                new net.minecraft.client.renderer.culling.Frustum(new org.joml.Matrix4f(), wide);
        frustum.prepare(camX, camY, camZ);
        return frustum;
    }

    /**
     * Iterations {@code offsetToFullyIncludeCameraCube(8)} would need, or
     * {@code >bound} if it would not terminate.
     */
    private static String offsetConvergence(final net.minecraft.client.renderer.culling.Frustum probe) {
        final int cube = 8;
        final int bound = 4096;
        int minX = (int) (Math.floor(probe.getCamX() / cube) * cube);
        int minY = (int) (Math.floor(probe.getCamY() / cube) * cube);
        int minZ = (int) (Math.floor(probe.getCamZ() / cube) * cube);
        int maxX = (int) (Math.ceil(probe.getCamX() / cube) * cube);
        int maxY = (int) (Math.ceil(probe.getCamY() / cube) * cube);
        int maxZ = (int) (Math.ceil(probe.getCamZ() / cube) * cube);
        // cubeInFrustum(BoundingBox) tests min..max+1, so the exclusive upper
        // corner has to be passed as max-1 to match the real loop's box.
        net.minecraft.world.level.levelgen.structure.BoundingBox box =
                new net.minecraft.world.level.levelgen.structure.BoundingBox(
                        minX, minY, minZ, maxX - 1, maxY - 1, maxZ - 1);
        for (int i = 0; i < bound; i++) {
            if (probe.cubeInFrustum(box) == -2) {
                return String.valueOf(i);
            }
            probe.offset(-4.0F);
        }
        return ">" + bound;
    }

    /**
     * Extent of the frustum's eight corners, which separates "the frustum is
     * pointing somewhere unhelpful" from "the frustum is not a view volume at
     * all" — a singular or reverse-Z projection shows up here as NaN, infinite
     * or collapsed spans.
     */
    private static String frustumShape(final net.minecraft.client.renderer.culling.Frustum cull) {
        try {
            org.joml.Vector4f[] points = cull.getFrustumPoints();
            if (points == null || points.length == 0) {
                return "none";
            }
            float minX = Float.MAX_VALUE;
            float minY = Float.MAX_VALUE;
            float minZ = Float.MAX_VALUE;
            float maxX = -Float.MAX_VALUE;
            float maxY = -Float.MAX_VALUE;
            float maxZ = -Float.MAX_VALUE;
            boolean finite = true;
            for (org.joml.Vector4f point : points) {
                finite &= Float.isFinite(point.x()) && Float.isFinite(point.y()) && Float.isFinite(point.z());
                minX = Math.min(minX, point.x());
                minY = Math.min(minY, point.y());
                minZ = Math.min(minZ, point.z());
                maxX = Math.max(maxX, point.x());
                maxY = Math.max(maxY, point.y());
                maxZ = Math.max(maxZ, point.z());
            }
            return "span(" + round(maxX - minX) + "," + round(maxY - minY) + "," + round(maxZ - minZ)
                    + ")finite=" + finite;
        } catch (Throwable shapeFailure) {
            return "failed:" + shapeFailure.getClass().getName();
        }
    }

    private static String round(final double value) {
        return String.valueOf(Math.round(value * 1.0E6) / 1.0E6);
    }

    /**
     * Compile-queue state, which says whether work is stuck or simply absent.
     * A non-empty queue that never drains points at the executor; an empty
     * queue with uncompiled sections means nothing was ever scheduled.
     */
    private static String dispatcherState(final net.minecraft.client.renderer.LevelRenderer renderer) {
        try {
            var dispatcher = renderer.sectionRenderDispatcher();
            if (dispatcher == null) {
                return "null";
            }
            return "queue=" + dispatcher.getCompileQueueSize()
                    + " empty=" + dispatcher.isQueueEmpty()
                    + " freeBuffers=" + dispatcher.getFreeBufferCount()
                    + " stats=" + dispatcher.getStats();
        } catch (Throwable probeFailure) {
            return "failed:" + probeFailure.getClass().getName();
        }
    }

    /**
     * Top stack frames of a failure, innermost first.
     *
     * <p>The reported stage is only the last {@code reportProgress} marker, so
     * it is routinely stale and has already sent debugging down the wrong path
     * once. The actual throw site is what identifies the culprit.</p>
     */
    /**
     * {@code ?reloadStress=ms} (test only): every ms, what F3+A does, so every
     * section is compiled again at once -- the most the compile workers ever
     * contend for the section dispatcher's copy lock (see describeCopyLock).
     */
    private static final long RELOAD_STRESS_MS = Long.getLong("mcweb.reloadStress", 0L);
    private static long nextReloadStress;
    private static int reloadStressCount;

    private static void reloadStress() {
        if (RELOAD_STRESS_MS <= 0 || minecraft.level == null || minecraft.player == null) {
            return;
        }
        long now = System.currentTimeMillis();
        if (nextReloadStress == 0) {
            nextReloadStress = now + RELOAD_STRESS_MS;
        } else if (now >= nextReloadStress) {
            nextReloadStress = now + RELOAD_STRESS_MS;
            minecraft.levelExtractor.allChanged();
            BrowserGpu.reportProgress("reload-stress:" + (++reloadStressCount));
        }
    }

    private static boolean hasCause(Throwable failure, Class<? extends Throwable> type) {
        for (int depth = 0; failure != null && depth < 16; depth++, failure = failure.getCause()) {
            if (type.isInstance(failure)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The section dispatcher's copy lock and every thread inside the section
     * dispatcher or a lock, when a compile task's unlock of that lock threw
     * IllegalMonitorStateException (it is taken with a plain lock / try /
     * finally unlock, so a correct JVM never throws there). The owner tells
     * the cases apart: another live thread means two held it at once; the
     * failing worker's own name means the owner check misread the thread;
     * unlocked means someone released it under the worker.
     */
    private static String describeCopyLock() {
        StringBuilder out = new StringBuilder();
        try {
            Object dispatcher = minecraft.levelRenderer.sectionRenderDispatcher();
            java.lang.reflect.Field field = dispatcher.getClass().getDeclaredField("copyLock");
            field.setAccessible(true);
            java.util.concurrent.locks.ReentrantLock lock =
                    (java.util.concurrent.locks.ReentrantLock) field.get(dispatcher);
            out.append(lock).append(" holds=").append(lock.getHoldCount())
                    .append(" queued=").append(lock.getQueueLength());
        } catch (Throwable failure) {
            out.append("copyLock=<").append(failure).append('>');
        }
        try {
            for (var entry : Thread.getAllStackTraces().entrySet()) {
                StackTraceElement[] stack = entry.getValue();
                boolean relevant = false;
                for (int i = 0; i < Math.min(stack.length, 24) && !relevant; i++) {
                    String frame = stack[i].getClassName();
                    relevant = frame.contains("SectionRenderDispatcher")
                            || frame.contains("locks.");
                }
                if (!relevant) {
                    continue;
                }
                Thread thread = entry.getKey();
                out.append(" || ").append(thread.getName()).append(' ').append(thread.getState());
                for (int i = 0; i < Math.min(stack.length, 10); i++) {
                    out.append(" < ").append(stack[i]);
                }
            }
        } catch (Throwable failure) {
            out.append(" threads=<").append(failure).append('>');
        }
        return out.toString();
    }

    private static String topFrames(final Throwable failure, final int limit) {
        try {
            StackTraceElement[] trace = failure.getStackTrace();
            if (trace == null || trace.length == 0) {
                return "<no stack trace>";
            }
            StringBuilder frames = new StringBuilder();
            for (int i = 0; i < Math.min(limit, trace.length); i++) {
                if (i > 0) {
                    frames.append(" < ");
                }
                frames.append(trace[i]);
            }
            return frames.toString();
        } catch (Throwable dumpFailure) {
            return "<stack-dump-failed:" + dumpFailure.getClass().getName() + ">";
        }
    }

    /**
     * Reports client world/player presence when it changes. The screen class
     * alone cannot tell "still loading" from "in the world" — both can render
     * with no screen — so this is what marks world entry as actually complete.
     */
    private static void reportWorldState() {
        // Compared as state, not as text: the previous version concatenated the
        // dimension's identifier into a fresh String on every frame and then
        // threw it away whenever it equalled the last one.
        net.minecraft.client.multiplayer.ClientLevel level = minecraft.level;
        boolean player = minecraft.player != null;
        if (level == lastWorldLevel && player == lastWorldHadPlayer) {
            return;
        }
        lastWorldLevel = level;
        lastWorldHadPlayer = player;
        BrowserGpu.reportProgress("world-state:"
                + (level == null ? "level=none" : "level=" + level.dimension().identifier())
                + " player=" + (player ? "present" : "none"));
    }

    /**
     * Low-rate, opt-in-friendly state sampling for the gameplay smoke test. It
     * contains only vanilla state already owned by Minecraft; it is not a second
     * input or world simulation path.
     */
    private static String lastGameplayState;
    private static long nextGameplayReportFrame;
    private static boolean lastScreenWasDeath;

    private static void reportGameplayState() {
        if (minecraft.level == null || minecraft.player == null || frameCount < nextGameplayReportFrame) {
            return;
        }
        nextGameplayReportFrame = frameCount + 15;
        try {
            net.minecraft.world.phys.HitResult hit = minecraft.hitResult;
            String target = "none";
            // A BlockHitResult also represents MISS endpoints. Only an actual
            // block hit is an actionable crosshair target for input probes.
            if (hit instanceof net.minecraft.world.phys.BlockHitResult blockHit
                    && hit.getType() == net.minecraft.world.phys.HitResult.Type.BLOCK) {
                net.minecraft.core.BlockPos pos = blockHit.getBlockPos();
                target = pos.getX() + "," + pos.getY() + "," + pos.getZ();
                // What the CLIENT believes is at the crosshair. "The block did
                // not break" is this staying non-air a second after the dig, so
                // the probe needs the block, not only the position.
                target += "@" + net.minecraft.core.registries.BuiltInRegistries.BLOCK
                        .getKey(minecraft.level.getBlockState(pos).getBlock()).getPath();
            } else if (hit != null) {
                target = hit.getType().name();
            }
            // Entity census: total entities in the client level plus the one
            // nearest the player. A pick that never targets an entity while
            // this shows one adjacent means the client entity index or the
            // pick's entity pass is broken.
            int entityCount = 0;
            String nearestEntity = "none";
            double nearestDistance = Double.MAX_VALUE;
            try {
                for (net.minecraft.world.entity.Entity entity : minecraft.level.entitiesForRendering()) {
                    if (entity == minecraft.player) {
                        continue;
                    }
                    entityCount++;
                    double distance = entity.distanceToSqr(minecraft.player);
                    if (distance < nearestDistance) {
                        nearestDistance = distance;
                        nearestEntity = entity.getType().getDescriptionId()
                                + "@" + Math.round(entity.getX() * 10.0) / 10.0
                                + "," + Math.round(entity.getY() * 10.0) / 10.0
                                + "," + Math.round(entity.getZ() * 10.0) / 10.0;
                    }
                }
            } catch (Throwable ignored) {
                // Census is diagnostic; a failure must not stop the report.
            }
            String state = "x=" + Math.round(minecraft.player.getX() * 100.0) / 100.0
                    + " y=" + Math.round(minecraft.player.getY() * 100.0) / 100.0
                    + " z=" + Math.round(minecraft.player.getZ() * 100.0) / 100.0
                    + " yaw=" + Math.round(minecraft.player.getYRot() * 10.0) / 10.0
                    + " pitch=" + Math.round(minecraft.player.getXRot() * 10.0) / 10.0
                    + " hp=" + Math.round(minecraft.player.getHealth() * 10.0) / 10.0
                    + " entities=" + entityCount
                    + " nearest=" + nearestEntity
                    + " target=" + target
                    + " screen=" + (minecraft.gui.screen() == null
                            ? "<none>" : minecraft.gui.screen().getClass().getSimpleName());
            if (inputHoldDiag) {
                state += " jumpDown=" + minecraft.options.keyJump.isDown()
                        + " flying=" + minecraft.player.getAbilities().flying
                        + " onGround=" + minecraft.player.onGround()
                        + " verticalCollision=" + minecraft.player.verticalCollision
                        + " collisionBelow=" + minecraft.player.verticalCollisionBelow
                        + " velocityY=" + minecraft.player.getDeltaMovement().y;
            }
            if (!state.equals(lastGameplayState)) {
                lastGameplayState = state;
                BrowserGpu.reportProgress("gameplay-state:" + state);
            }
            // Death at superflat survival spawn is a port anomaly worth
            // pinning: record the transition the moment it happens, with the
            // position the player occupied when health hit zero.
            if (minecraft.gui.screen() instanceof net.minecraft.client.gui.screens.DeathScreen
                    && !lastScreenWasDeath) {
                lastScreenWasDeath = true;
                String cause = "?";
                try {
                    net.minecraft.client.gui.screens.Screen deathScreen = minecraft.gui.screen();
                    if (deathScreen != null) {
                        cause = deathScreen.getTitle().getString().replace('\n', ' ');
                    }
                } catch (Throwable ignored) {
                    // Diagnostic only.
                }
                BrowserGpu.reportProgress("player-death:"
                        + " cause=" + cause
                        + " x=" + Math.round(minecraft.player.getX() * 100.0) / 100.0
                        + " y=" + Math.round(minecraft.player.getY() * 100.0) / 100.0
                        + " z=" + Math.round(minecraft.player.getZ() * 100.0) / 100.0);
            } else if (!(minecraft.gui.screen() instanceof net.minecraft.client.gui.screens.DeathScreen)) {
                lastScreenWasDeath = false;
            }
        } catch (Throwable ignored) {
            // Diagnostics must never make a frame fail.
        }
    }
}
