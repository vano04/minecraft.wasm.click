package dev.mcweb.graal;

import dev.mcweb.graal.webgpu.BrowserGpu;
import net.minecraft.client.server.IntegratedServer;

/**
 * Integrated-server helpers for the threaded lane, where Mojang's own Server
 * thread runs the server: the two spawn finders the massage plan redirects
 * here ({@link #browserInitialSpawn}, {@link #browserPrepareSpawnPosition}),
 * the per-tick chunk task the frame pump queues on that thread
 * ({@link #requestChunkSlice}: early chunk send, look-ahead tickets, the
 * chunk slice) and the chunk-pipeline diagnostics it reports
 * ({@code flow:}, {@code lookahead:}, {@code chunkpipe:}).
 */
public final class BrowserIntegratedServerCompat {
    /**
     * Chunk radius scanned when hunting the parked-generation root. Covers the
     * view distance (8) plus the radius-8 generation halo that feeds its edge.
     */
    private static final int SCAN_RADIUS = 18;

    private BrowserIntegratedServerCompat() {
    }

    /**
     * Browser-only replacement for Mojang's synchronous initial spawn finder.
     *
     * <p>{@code setInitialSpawn()} first installs the climate sampler's candidate
     * before probing a square around it.  Returning {@code null} would skip that
     * probe but preserve the sampler candidate, which can be hundreds of blocks
     * from the origin and turns the first login into an unexpectedly large terrain
     * load.  Use the browser's deterministic, bounded spawn instead; the normal
     * player ticket still loads the real chunk and all gameplay terrain through
     * Mojang's pipeline. Never null, so the first probe ends the spiral: the
     * in-tab massage plan leaves the spiral's bounds at vanilla's for that
     * reason.</p>
     */
    public static net.minecraft.core.BlockPos browserInitialSpawn(
            net.minecraft.server.level.ServerLevel level,
            net.minecraft.world.level.ChunkPos chunk
    ) {
        return net.minecraft.core.BlockPos.ZERO.above(80);
    }

    /**
     * Browser-only replacement for the serial respawn-radius search performed
     * while the configuration handshake is preparing the first player.
     *
     * <p>The position was selected and stored by {@code setInitialSpawn}; the
     * normal {@code PrepareSpawnTask} ticket still loads the configured spawn
     * square before the player is placed. Deferring collision probing here keeps
     * that real ticket/chunk path intact without making configuration wait on a
     * potentially hundreds-of-chunks sequential search.</p>
     */
    public static java.util.concurrent.CompletableFuture<net.minecraft.world.phys.Vec3>
            browserPrepareSpawnPosition(
                    net.minecraft.server.level.ServerLevel level,
                    net.minecraft.core.BlockPos spawn
            ) {
        // The initial-spawn BlockPos is a fixed high point (ZERO.above(80)),
        // chosen in setInitialSpawn before any chunk exists. Placing the
        // player there drops them ~140 blocks on superflat and ~17 blocks
        // onto normal terrain — both lethal for survival, which read as
        // "block breaking does not register" for the seconds between entry
        // and respawn (measured: hp 20 -> 0 in ~0.8 s, DeathScreen at entry).
        //
        // Full chunks are NOT loaded at this point (PrepareSpawnTask loads
        // the spawn square only after the position is resolved), so a
        // getChunkNow probe misses and free-fall happens anyway. The
        // chunk-independent answer is the chunk generator's heightmap:
        // getFirstFreeHeight computes the standing surface Y for any
        // generator (flat or noise) without loading a chunk, which is
        // exactly how vanilla derives spawn heights.
        try {
            net.minecraft.server.level.ServerChunkCache chunks = level.getChunkSource();
            int surfaceY = chunks.getGenerator().getFirstFreeHeight(
                    spawn.getX(),
                    spawn.getZ(),
                    net.minecraft.world.level.levelgen.Heightmap.Types.MOTION_BLOCKING,
                    level,
                    chunks.randomState()
            );
            if (surfaceY > level.getMinY()) {
                // getFirstFreeHeight returns the heightmap value, the first
                // free space above the highest motion-blocking block — the
                // exact standing position, no settle-fall.
                net.minecraft.world.phys.Vec3 placed = new net.minecraft.world.phys.Vec3(
                        spawn.getX() + 0.5, surfaceY, spawn.getZ() + 0.5);
                dev.mcweb.graal.webgpu.BrowserGpu.reportProgress(
                        "spawn:surface-found y=" + surfaceY + " placed=" + placed);
                return java.util.concurrent.CompletableFuture.completedFuture(placed);
            }
        } catch (Throwable probeFailure) {
            // A failed probe must not break login; the fallback below is
            // the previous behavior.
        }
        return java.util.concurrent.CompletableFuture.completedFuture(
                net.minecraft.world.phys.Vec3.atBottomCenterOf(spawn)
        );
    }

    /**
     * The chunk pipeline around the player, sampled on Mojang's own Server
     * thread: loaded and pending work, the send
     * throttle, the status histogram. The client thread reports it as
     * {@code chunkpipe:} (BrowserFramePump), since progress reports only
     * reach the page from there.
     */
    public static void sampleChunkPipeline(IntegratedServer current) {
        try {
            if (current == null || current.getPlayerCount() == 0) {
                return;
            }
            AgentExecutorService.noteServerThread(Thread.currentThread());
            net.minecraft.server.level.ServerLevel level = primaryPlayerLevel(current);
            net.minecraft.server.level.ServerChunkCache chunks = level.getChunkSource();
            chunkPipeline = "tick=" + current.getTickCount()
                    + " slices=" + chunkSlices.get() + " slicePolls=" + chunkSlicePolls.get()
                    + " sliceMs=" + (CHUNK_SLICE_NANOS / 1_000_000L)
                    + " lanes=[" + AgentExecutorService.describeLanes() + "]"
                    + " loadedChunks=" + chunks.getLoadedChunksCount()
                    + " pendingTasks=" + chunks.getPendingTasksCount()
                    // The generation-root probe walks a 37x37 holder grid and
                    // all its status futures. Keep it off the normal Server
                    // thread, like the other deep chunkDiag samplers.
                    + (CHUNK_DIAG ? describeStepLatency() + BrowserWorldgenSteps.describe()
                            + " wg=[" + describeDispatcher(chunks.chunkMap.worldgenTaskDispatcher) + "]"
                            + " lt=[" + describeDispatcher(chunks.chunkMap.lightTaskDispatcher) + "]"
                            + describeChunkSendState(current, chunks) : "");
        } catch (Throwable probeFailure) {
            chunkPipeline = "failed=" + probeFailure.getClass().getName();
        }
    }

    /**
     * Guaranteed chunk-system time on the Server thread.
     *
     * <p>Mojang's server runs the chunk system's main-thread work (the steps
     * that finish a chunk, ticket updates) only between ticks, and only while
     * it has time left before the next one ({@code pollTaskInternal}: sprinting,
     * {@code shouldRunAllTasks} or {@code haveTime}). Here entity ticks alone
     * overrun the 50 ms budget, so there is never time left: profiled, the
     * Server thread spent 99% in {@code tickServer} and none polling chunk
     * tasks, the worldgen threads sat ~97% idle, and chunks arrived one ring
     * at a time. This queues, at most once per server tick, a task that polls
     * every level's chunk cache for up to {@code -Dmcweb.chunkSliceMs} (the
     * page's {@code ?chunkSlice=N}); 0 turns it off.</p>
     */
    /**
     * {@code -Dmcweb.ticketThrottle=N} (the page's {@code ?ticketThrottle=N}):
     * chunks the player-ticket dispatcher lets into execution at once; Mojang's
     * DistanceManager hard-codes 4. A slot is released only when the chunk's
     * full future completes, which here spans several server ticks, so 4 in
     * flight can leave the worldgen lane idle. An experiment knob: 0 keeps
     * Mojang's value.
     */
    private static final int TICKET_THROTTLE = Integer.getInteger("mcweb.ticketThrottle", 0);

    /**
     * {@code -Dmcweb.dispatcherLane} (default on; the page's
     * {@code ?dispatcherLane=0} turns it off): each level's worldgen and light
     * ChunkTaskDispatcher runs its own "dispatcher" executor on the serial
     * lane it feeds ({@link AgentExecutorService#bindToLane}). Bound once per
     * level, from the first chunk slice; until then they run on the pool, as
     * before. About 45-70% more complete chunks a second in flight. It was
     * opt-in while the client's IllegalMonitorStateException on
     * SectionRenderDispatcher's copy lock ended 2 of 11 flights with it on
     * (docs/STATUS.md, 2026-10-11 night); with the generation offload, 10 of
     * 10 flights with it on passed (2026-10-12). The copy-lock diagnostic
     * (BrowserFramePump, frame:lock-state:) reports the next occurrence.
     */
    private static final boolean DISPATCHER_LANE =
            !"false".equals(System.getProperty("mcweb.dispatcherLane", "true"));
    private static final java.util.Map<Object, Boolean> lanesBound =
            java.util.Collections.synchronizedMap(new java.util.WeakHashMap<>());

    private static void bindDispatchersToLanes(IntegratedServer current) {
        for (net.minecraft.server.level.ServerLevel level : current.getAllLevels()) {
            net.minecraft.server.level.ChunkMap map = level.getChunkSource().chunkMap;
            if (lanesBound.containsKey(map)) {
                continue;
            }
            lanesBound.put(map, Boolean.TRUE);
            try {
                java.lang.reflect.Field f =
                        net.minecraft.server.level.ChunkTaskDispatcher.class.getDeclaredField("dispatcher");
                f.setAccessible(true);
                AgentExecutorService.bindToLane(f.get(map.worldgenTaskDispatcher), "worldgen");
                AgentExecutorService.bindToLane(f.get(map.lightTaskDispatcher), "light");
            } catch (Throwable failure) {
                BrowserGpu.reportProgress("server:dispatcherLane-failed=" + failure);
            }
        }
    }
    private static volatile Object throttledDistanceManager;

    private static void applyTicketThrottle(IntegratedServer current) {
        for (net.minecraft.server.level.ServerLevel level : current.getAllLevels()) {
            Object dm = level.getChunkSource().chunkMap.getDistanceManager();
            if (dm == throttledDistanceManager) {
                return;
            }
            try {
                java.lang.reflect.Field f = net.minecraft.server.level.DistanceManager.class
                        .getDeclaredField("ticketDispatcher");
                f.setAccessible(true);
                Object dispatcher = f.get(dm);
                java.lang.reflect.Field max = net.minecraft.server.level.ThrottlingChunkTaskDispatcher.class
                        .getDeclaredField("maxChunksInExecution");
                max.setAccessible(true);
                max.setInt(dispatcher, TICKET_THROTTLE);
                BrowserGpu.reportProgress("server:ticketThrottle=" + TICKET_THROTTLE);
            } catch (Throwable failed) {
                BrowserGpu.reportProgress("server:ticketThrottle-failed " + failed);
            }
            throttledDistanceManager = dm;
            return;                                  // the first level: the overworld
        }
    }

    /**
     * Generation ahead of a moving player: {@code -Dmcweb.lookAhead=N}
     * ({@code ?lookAhead=N} on the page; 0 = no tickets, only the report, to
     * compare against; unset or negative = off). {@code -Dmcweb.lookAheadReport}
     * ({@code ?lookAheadReport=1}) reports every 2 s what the player could fly
     * into ({@code lookahead:}).
     *
     * <p>Mojang admits the chunks around a player nearest-first, four at a time,
     * sides and front alike. Here worldgen finishes ~3.5 chunks a second and a
     * flying player needs a row of 2*renderDistance+1 of them every 16 blocks,
     * so the ground ahead was still empty when they reached it. While the
     * player moves (over {@code LOOK_AHEAD_MIN_SPEED} blocks a second,
     * horizontally), this streams the chunks in front: a cone ahead inside the
     * view, cheapest first (distance ahead plus twice the distance to the
     * side), each with its own small loading ticket ({@code
     * -Dmcweb.lookAheadRadius}, default 1: that chunk and the eight around it
     * complete, so the client, which meshes a section only once all its
     * neighbouring chunks have arrived, can draw it), at most N of them still
     * generating at once. A streamed chunk keeps its ticket until it is
     * complete and a ticket of the player's holds it, or it leaves the view;
     * nothing outside the view is asked for.</p>
     *
     * <p>It replaced one radius-4 ticket at the render edge (2026-09-28 to
     * 2026-10-11). That asked for a 9x9 block of complete chunks at once,
     * half of it past the view: Mojang's generation advances every chunk of a
     * request one status at a time, so the block finished together (+29 to
     * +49 complete chunks in one second after ~10 s of none, the stall-then-
     * burst players saw), and each refresh moved it, so expired tickets
     * unloaded part-generated chunks: 2.2-2.7 complete chunks a second
     * against 3.4-4.2 without it, the worldgen lane as busy
     * (build/compare/lt-la0 vs lt-la4, 2026-10-11).</p>
     */
    static final int LOOK_AHEAD = Integer.getInteger("mcweb.lookAhead", -1);
    private static final boolean LOOK_AHEAD_REPORT = Boolean.getBoolean("mcweb.lookAheadReport");
    /** -Dmcweb.flowReport: {@code flow:} once a second (BrowserFramePump.reportFlow). */
    static final boolean FLOW_REPORT = Boolean.getBoolean("mcweb.flowReport");
    /** Complete chunks within view distance of the player, and when counted. */
    static volatile int serverFullInView = -1;
    static volatile int serverFlowTick = -1;
    private static final double LOOK_AHEAD_MIN_SPEED = 4.0;
    private static final int LOOK_AHEAD_RADIUS = Integer.getInteger("mcweb.lookAheadRadius", 1);
    /** Streamed chunks whose ticket is kept (generating, or complete and not yet held). */
    private static final java.util.LinkedHashSet<Long> lookAheadHeld = new java.util.LinkedHashSet<>();
    private static final int LOOK_AHEAD_HELD_MAX = 128;
    /** Chunks the stream asked for, for the {@code lookahead:} report. */
    private static int lookAheadStreamed;
    /**
     * Expires 40 ticks after it was placed whatever the chunk under it is
     * doing. Without FLAG_CAN_EXPIRE_IF_UNLOADED a timed ticket only counts
     * down once its chunk is ready for saving (TicketStorage.canTicketExpire),
     * and one placed ahead on a chunk still generating never did: every ticket
     * of a flight stayed, each holding ~15 chunks of holders around it, and the
     * server's chunks grew without bound (1300 -> 4000 in six minutes, the heap
     * after it).
     */
    private static final net.minecraft.server.level.TicketType LOOK_AHEAD_TICKET =
            new net.minecraft.server.level.TicketType(40L, net.minecraft.server.level.TicketType.FLAG_LOADING
                    | net.minecraft.server.level.TicketType.FLAG_CAN_EXPIRE_IF_UNLOADED);
    // Per server: getTickCount() restarts at 0 in every world opened in the
    // same tab, and the last world's positions are not this one's. Re-armed in
    // lookAhead(), on the Server thread that owns these fields. Weak, so a
    // stopped world is not kept on the heap until the next one opens.
    private static java.lang.ref.WeakReference<IntegratedServer> lookAheadServer =
            new java.lang.ref.WeakReference<>(null);
    private static int lookAheadTick = -1;
    private static final java.util.Map<java.util.UUID, double[]> lookAheadLast = new java.util.HashMap<>();
    private static int lookAheadReports;

    // Reported from the client thread (requestChunkSlice): a report made on
    // any other thread -- the Server thread, a watchdog -- never reached the
    // page on this lane, and neither did their System.out.
    private static final java.util.concurrent.ConcurrentLinkedQueue<String> serverNotes =
            new java.util.concurrent.ConcurrentLinkedQueue<>();

    private static void noteFromServer(String line) {
        if (serverNotes.size() < 256) {
            serverNotes.add(line);
        }
    }

    private static void lookAhead(IntegratedServer current) {
        if (current != lookAheadServer.get()) {
            lookAheadServer = new java.lang.ref.WeakReference<>(current);
            lookAheadTick = -1;
            lookAheadLast.clear();
            lookAheadReports = 0;
            lookAheadHeld.clear();
            lookAheadStreamed = 0;
            serverFullInView = -1;
            serverFlowTick = -1;
        }
        int tick = current.getTickCount();
        if (lookAheadTick >= 0 && tick - lookAheadTick < 10) {
            return;
        }
        int dt = lookAheadTick < 0 ? 0 : tick - lookAheadTick;
        lookAheadTick = tick;
        boolean report = (CHUNK_DIAG || LOOK_AHEAD_REPORT) && (++lookAheadReports & 3) == 0;   // every 2 s
        for (net.minecraft.server.level.ServerPlayer player : current.getPlayerList().getPlayers()) {
            double x = player.getX(), z = player.getZ();
            // {x, z, direction x, direction z}: the direction is the last one
            // the player moved in, kept while they stand still.
            double[] last = lookAheadLast.get(player.getUUID());
            double[] now = {x, z, last != null ? last[2] : 0, last != null ? last[3] : 0};
            lookAheadLast.put(player.getUUID(), now);
            if (last == null || dt <= 0) {
                continue;
            }
            double dx = x - last[0], dz = z - last[1];
            double moved = Math.sqrt(dx * dx + dz * dz);
            double speed = moved * 20.0 / dt;                               // blocks a second
            boolean moving = speed >= LOOK_AHEAD_MIN_SPEED;
            if (moving) {
                now[2] = dx / moved;
                now[3] = dz / moved;
            }
            net.minecraft.server.level.ServerLevel level = player.level();
            int view = current.getPlayerList().getViewDistance();
            net.minecraft.world.level.ChunkPos here = player.chunkPosition();
            if (FLOW_REPORT) {
                int full = 0;
                for (int ox = -view; ox <= view; ox++) {
                    for (int oz = -view; oz <= view; oz++) {
                        if (level.getChunkSource().getChunkNow(here.x() + ox, here.z() + oz) != null) {
                            full++;
                        }
                    }
                }
                serverFullInView = full;
                serverFlowTick = tick;
            }
            double ux = now[2], uz = now[3];
            // Refresh pending tickets even when the player stops at the loaded
            // edge. Otherwise their 40-tick lifetime expires precisely while
            // generation is still needed. Reports must not change that lifetime.
            if (LOOK_AHEAD > 0) {
                streamAhead(level, here, view, ux, uz, moving);
            }
            // How far the player could go on, generated, along that line, and
            // where they are: the measures of whether generation keeps up (a
            // player cannot move into a chunk that is not there, so a flight
            // that outruns it stalls at the edge).
            if (report && (ux != 0 || uz != 0)) {
                int ready = 0;
                for (int k = 1; k <= view + 4; k++) {
                    int cx = here.x() + (int) Math.round(ux * k), cz = here.z() + (int) Math.round(uz * k);
                    if (level.getChunkSource().getChunkNow(cx, cz) == null) {
                        break;
                    }
                    ready = k;
                }
                noteFromServer("lookahead: speed=" + Math.round(speed) + " ready=" + ready
                        + "/" + view + " at=" + Math.round(x) + "," + Math.round(z)
                        + " heldMoves=" + BrowserChunkCompat.heldMoves
                        + " spawnDeferred=" + BrowserChunkCompat.spawnProbesDeferred
                        + " clientEdge=" + BrowserChunkCompat.heldClientMoves
                        + " streamed=" + lookAheadStreamed + " held=" + lookAheadHeld.size() + " tick=" + tick);
            }
        }
    }

    /**
     * One step of the look-ahead stream (see {@link #LOOK_AHEAD}): refresh
     * the tickets still needed, let go of the rest, then, while moving, ask
     * for the cheapest chunks in front until N are generating.
     */
    private static void streamAhead(net.minecraft.server.level.ServerLevel level,
            net.minecraft.world.level.ChunkPos here, int view, double ux, double uz, boolean moving) {
        net.minecraft.server.level.ServerChunkCache chunks = level.getChunkSource();
        int generating = 0;
        for (java.util.Iterator<Long> it = lookAheadHeld.iterator(); it.hasNext(); ) {
            long pos = it.next();
            int x = net.minecraft.world.level.ChunkPos.getX(pos), z = net.minecraft.world.level.ChunkPos.getZ(pos);
            if (Math.max(Math.abs(x - here.x()), Math.abs(z - here.z())) > view) {
                it.remove();                                    // left the view: the ticket runs out
                continue;
            }
            boolean complete = chunks.getChunkNow(x, z) != null;
            if (complete) {
                net.minecraft.server.level.ChunkHolder holder = chunks.chunkMap.getUpdatingChunkIfPresent(pos);
                // Under 33 is a level only another ticket gives (this one
                // gives 33 - radius at most at its centre, 33 at radius 0).
                if (holder != null && holder.getTicketLevel() < 33 - LOOK_AHEAD_RADIUS) {
                    it.remove();
                    continue;
                }
            } else {
                generating++;
            }
            chunks.addTicketWithRadius(LOOK_AHEAD_TICKET, new net.minecraft.world.level.ChunkPos(x, z), LOOK_AHEAD_RADIUS);
        }
        if (!moving || (ux == 0 && uz == 0)) {
            return;
        }
        // The cone: k chunks ahead, lat to the side, cheapest first.
        double px = -uz, pz = ux;
        for (int cost = 1; cost <= 3 * view && generating < LOOK_AHEAD
                && lookAheadHeld.size() < LOOK_AHEAD_HELD_MAX; cost++) {
            for (int lat = 0; 2 * lat < cost && generating < LOOK_AHEAD; lat++) {
                int k = cost - 2 * lat;
                for (int side = lat == 0 ? 1 : -1; side <= 1 && generating < LOOK_AHEAD; side += 2) {
                    int x = here.x() + (int) Math.round(ux * k + px * lat * side);
                    int z = here.z() + (int) Math.round(uz * k + pz * lat * side);
                    if (Math.max(Math.abs(x - here.x()), Math.abs(z - here.z())) > view
                            || chunks.getChunkNow(x, z) != null) {
                        continue;
                    }
                    if (lookAheadHeld.add(net.minecraft.world.level.ChunkPos.pack(x, z))) {
                        chunks.addTicketWithRadius(LOOK_AHEAD_TICKET, new net.minecraft.world.level.ChunkPos(x, z),
                                LOOK_AHEAD_RADIUS);
                        lookAheadStreamed++;
                        generating++;
                    }
                }
            }
        }
    }

    /**
     * {@code -Dmcweb.serverWatchdog} ({@code ?serverWatchdog=1}): when the
     * integrated server's tick count stops for 6 s, prints the Server
     * thread's state and stack, and every other thread whose stack mentions
     * worldgen or the chunk system, to stdout (a report from another thread
     * does not reach the page). Diagnostic only: a stack of a thread parked
     * in a futex needs a safepoint handshake that may never complete, which
     * wedges only this watchdog.
     */
    private static final boolean SERVER_WATCHDOG = Boolean.getBoolean("mcweb.serverWatchdog");
    // -Dmcweb.serverWatchdogPeriodic: also every 15 s while ticking (a stall
    // of chunk generation does not stop the tick).
    private static final boolean SERVER_WATCHDOG_PERIODIC = Boolean.getBoolean("mcweb.serverWatchdogPeriodic");
    private static volatile IntegratedServer watchedServer;

    private static void startServerWatchdog(IntegratedServer current) {
        if (!SERVER_WATCHDOG || watchedServer == current) {
            return;
        }
        watchedServer = current;
        Thread watchdog = new Thread(() -> {
            noteFromServer("server-watchdog: watching");
            long lastPeriodic = System.nanoTime();
            int lastTick = -1;
            long stalledSince = 0;
            boolean dumped = false;
            while (watchedServer == current && current.isRunning()) {
                // Spin, as the frame watchdog does: a timed wait on this
                // runtime does not reliably wake.
                long until = System.nanoTime() + 1_000_000_000L;
                while (System.nanoTime() < until) {
                    Thread.onSpinWait();
                }
                int tick = current.getTickCount();
                long now = System.nanoTime();
                boolean periodic = SERVER_WATCHDOG_PERIODIC && now - lastPeriodic >= 15_000_000_000L;
                if (periodic) {
                    lastPeriodic = now;
                } else if (tick != lastTick) {
                    lastTick = tick;
                    stalledSince = now;
                    dumped = false;
                    continue;
                } else if (dumped || now - stalledSince < 6_000_000_000L) {
                    continue;
                }
                dumped = true;
                // One thread at a time, its state printed before its stack is
                // asked for: a stack walk of a parked thread can wedge this
                // watchdog, and what was printed before it still tells.
                java.util.List<Thread> threads = new java.util.ArrayList<>();
                threads.add(current.getRunningThread());
                ThreadGroup root = Thread.currentThread().getThreadGroup();
                while (root.getParent() != null) {
                    root = root.getParent();
                }
                Thread[] all = new Thread[512];
                int count = root.enumerate(all, true);
                for (int i = 0; i < count; i++) {
                    Thread t = all[i];
                    String n = t.getName();
                    if (n.startsWith("mcweb-") && !n.equals("mcweb-server-watchdog") || n.contains("Worker") || n.contains("worldgen")) {
                        threads.add(t);
                    }
                }
                noteFromServer("server-watchdog: tick " + tick + (periodic ? " periodic" : " stalled 6 s") + "; threads "
                        + threads.stream().map(t -> t.getName() + "=" + t.getState()).toList());
                for (Thread t : threads) {
                    StackTraceElement[] st = t.getStackTrace();
                    StringBuilder out = new StringBuilder("server-watchdog: " + t.getName() + " "
                            + t.getState() + " depth=" + st.length);
                    for (int i = 0; i < Math.min(st.length, 30); i++) {
                        out.append("\n      ").append(st[i]);
                    }
                    noteFromServer(out.toString());
                }
            }
        }, "mcweb-server-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
    }

    public static void requestChunkSlice(IntegratedServer current) {
        if (SERVER_WATCHDOG && current != null) {
            startServerWatchdog(current);
        }
        for (String note; (note = serverNotes.poll()) != null; ) {
            BrowserGpu.reportProgress(note);
        }
        if (current != null && current != sliceServer.get()) {
            // Give each world its own latch. A late task from the previous
            // server must not release a task already queued on the new one.
            sliceServer = new java.lang.ref.WeakReference<>(current);
            chunkSliceGate = new ChunkSliceGate();
        }
        long budgetNanos = CHUNK_SLICE_NANOS;
        ChunkSliceGate gate = chunkSliceGate;
        if (current == null || (budgetNanos <= 0 && !CHUNK_DIAG && TICKET_THROTTLE <= 0 && LOOK_AHEAD < 0 && !FLOW_REPORT
                && !DISPATCHER_LANE
                && !BrowserChunkCompat.EARLY_SEND)
                || !gate.tryQueue(current.getTickCount())) {
            return;
        }
        try {
            // execute() from another thread stamps the task with the current
            // tick, and an overloaded server runs such a task only once three
            // more ticks have passed (MinecraftServer.shouldRun). Stamped four
            // ticks back, it runs at the next task point, every tick.
            current.schedule(new net.minecraft.server.TickTask(current.getTickCount() - 4, () -> {
                try {
                    if (TICKET_THROTTLE > 0) {
                        applyTicketThrottle(current);
                    }
                    if (DISPATCHER_LANE) {
                        bindDispatchersToLanes(current);
                    }
                    if (BrowserChunkCompat.EARLY_SEND) {
                        for (net.minecraft.server.level.ServerPlayer player : current.getPlayerList().getPlayers()) {
                            BrowserChunkCompat.sendEarly(player.level(), player);
                        }
                    }
                    if (LOOK_AHEAD >= 0 || FLOW_REPORT) {
                        lookAhead(current);
                    }
                    if (CHUNK_DIAG) {
                        sampleStatusChanges(current);
                    }
                    long end = System.nanoTime() + budgetNanos;
                    boolean polled = true;
                    chunkSlices.incrementAndGet();
                    while (polled && System.nanoTime() < end) {
                        polled = false;
                        for (net.minecraft.server.level.ServerLevel level : current.getAllLevels()) {
                            if (level.getChunkSource().pollTask()) {
                                polled = true;
                                chunkSlicePolls.incrementAndGet();
                            }
                            if (System.nanoTime() >= end) {
                                break;
                            }
                        }
                    }
                } finally {
                    gate.completed(current.getTickCount());
                }
            }));
        } catch (Throwable rejected) {
            gate.rejected();
        }
    }

    /**
     * Per-status latency around the player: every server tick (from the chunk
     * slice task), the latest status of each holder within view distance is
     * compared with the last tick's, and each change is timed. The report
     * gives, per status, how many chunks reached it and the mean ticks from
     * the previous status, so the step that holds chunks back is named.
     */
    private static final java.util.Map<Long, long[]> statusSeen = new java.util.HashMap<>();
    private static final long[] stepTicks = new long[32];
    private static final long[] stepCount = new long[32];

    private static void sampleStatusChanges(IntegratedServer current) {
        try {
            if (current.getPlayerCount() == 0) {
                return;
            }
            net.minecraft.server.level.ServerLevel level = primaryPlayerLevel(current);
            net.minecraft.server.level.ServerChunkCache chunks = level.getChunkSource();
            net.minecraft.server.level.ServerPlayer player = current.getPlayerList().getPlayers().get(0);
            net.minecraft.world.level.ChunkPos center = player.chunkPosition();
            int tick = current.getTickCount();
            for (int dz = -8; dz <= 8; dz++) {
                for (int dx = -8; dx <= 8; dx++) {
                    long pos = net.minecraft.world.level.ChunkPos.pack(center.x() + dx, center.z() + dz);
                    net.minecraft.server.level.ChunkHolder holder = chunks.chunkMap.getUpdatingChunkIfPresent(pos);
                    if (holder == null) {
                        continue;
                    }
                    net.minecraft.world.level.chunk.status.ChunkStatus latest = holder.getLatestStatus();
                    int index = latest == null ? -1 : latest.getIndex();
                    long[] seen = statusSeen.get(pos);
                    if (seen == null) {
                        statusSeen.put(pos, new long[] {index, tick});
                    } else if (seen[0] != index) {
                        if (index >= 0 && index < stepTicks.length && seen[0] >= 0) {
                            stepTicks[index] += tick - seen[1];
                            stepCount[index]++;
                        }
                        seen[0] = index;
                        seen[1] = tick;
                    }
                }
            }
        } catch (Throwable ignored) {
            // Diagnostics only.
        }
    }

    /** A ChunkTaskDispatcher's three parts: its priority queue, and both executors. */
    private static String describeDispatcher(Object dispatcher) {
        StringBuilder out = new StringBuilder();
        for (String name : new String[] {"queue", "executor", "dispatcher"}) {
            try {
                java.lang.reflect.Field f =
                        net.minecraft.server.level.ChunkTaskDispatcher.class.getDeclaredField(name);
                f.setAccessible(true);
                Object v = f.get(dispatcher);
                out.append(name).append('=');
                if (v instanceof net.minecraft.util.thread.AbstractConsecutiveExecutor<?> ex) {
                    out.append(ex.name()).append("/size=").append(ex.size()).append("/work=").append(ex.hasWork());
                    try {
                        java.lang.reflect.Field st = net.minecraft.util.thread.AbstractConsecutiveExecutor.class
                                .getDeclaredField("status");
                        st.setAccessible(true);
                        out.append("/status=").append(((java.util.concurrent.atomic.AtomicReference<?>) st.get(ex)).get());
                    } catch (Throwable ignored) {
                    }
                } else {
                    String text = String.valueOf(v);
                    out.append(text.length() > 160 ? text.substring(0, 160) : text);
                }
                out.append(' ');
            } catch (Throwable failure) {
                out.append(name).append("-failed ");
            }
        }
        return out.toString().trim();
    }

    private static String describeStepLatency() {
        StringBuilder out = new StringBuilder(" steps=[");
        for (net.minecraft.world.level.chunk.status.ChunkStatus status
                : net.minecraft.world.level.chunk.status.ChunkStatus.getStatusList()) {
            int i = status.getIndex();
            if (i < stepCount.length && stepCount[i] > 0) {
                out.append(net.minecraft.core.registries.BuiltInRegistries.CHUNK_STATUS.getKey(status).getPath())
                        .append(':').append(stepCount[i]).append('x')
                        .append(stepTicks[i] / stepCount[i]).append("t ");
            }
        }
        return out.append(']').toString();
    }

    private static final java.util.concurrent.atomic.AtomicLong chunkSlices =
            new java.util.concurrent.atomic.AtomicLong();
    private static final java.util.concurrent.atomic.AtomicLong chunkSlicePolls =
            new java.util.concurrent.atomic.AtomicLong();
    /**
     * -Dmcweb.chunkDiag (the page's ?chunkDiag=1): the per-tick status sampler
     * here and the worldgen executor sampler in AgentExecutorService. Off by
     * default; they cost a scan per tick and a map update per pool task.
     */
    static final boolean CHUNK_DIAG = Boolean.getBoolean("mcweb.chunkDiag");
    private static final long CHUNK_SLICE_NANOS =
            Long.getLong("mcweb.chunkSliceMs", 0L) * 1_000_000L;
    /**
     * One maintenance task per server tick, not per rendered frame. Completion
     * records the tick it actually ran on, which can be later than submission.
     */
    static final class ChunkSliceGate {
        private final java.util.concurrent.atomic.AtomicBoolean queued =
                new java.util.concurrent.atomic.AtomicBoolean();
        private volatile int servicedTick;
        private volatile boolean serviced;

        boolean tryQueue(int tick) {
            if ((serviced && servicedTick == tick) || !queued.compareAndSet(false, true)) {
                return false;
            }
            // Completion can publish this tick between the first check and CAS.
            if (serviced && servicedTick == tick) {
                queued.set(false);
                return false;
            }
            return true;
        }

        void completed(int tick) {
            servicedTick = tick;
            serviced = true;
            queued.set(false);
        }

        void rejected() {
            queued.set(false);
        }
    }

    private static ChunkSliceGate chunkSliceGate = new ChunkSliceGate();
    /** The server {@link #chunkSliceGate} belongs to; client thread only. */
    private static java.lang.ref.WeakReference<IntegratedServer> sliceServer =
            new java.lang.ref.WeakReference<>(null);

    /** The last {@link #sampleChunkPipeline}, for the client thread to report. */
    public static volatile String chunkPipeline;

    /**
     * Destination level for the integrated player, with Overworld as the
     * pre-login fallback. The private integrated server normally has one local
     * player; Minecraft's task drain still iterates every level itself.
     */
    private static net.minecraft.server.level.ServerLevel primaryPlayerLevel(
            IntegratedServer current
    ) {
        if (current.getPlayerList() != null
                && !current.getPlayerList().getPlayers().isEmpty()) {
            return current.getPlayerList().getPlayers().get(0).level();
        }
        return current.overworld();
    }

    /**
     * Reports the exact server-side state behind the visible chunk horizon.
     *
     * <p>Every part is a separate {@link #section} because Mojang's holder
     * futures are legitimately null before they are scheduled. A single such
     * null used to abort the whole probe and replace 20 measured fields with
     * one exception name, which is exactly the state this must never be in
     * while it is the only view of the pipeline.</p>
     */
    private static String describeChunkSendState(
            IntegratedServer current,
            net.minecraft.server.level.ServerChunkCache chunks
    ) {
        StringBuilder state = new StringBuilder();
        section(state, "readyChunks", () -> {
            int[] totalReady = {0};
            chunks.chunkMap.forEachReadyToSendChunk(chunk -> totalReady[0]++);
            state.append(" readyChunks=").append(totalReady[0]);
        });
        // Which dispatcher is holding the work that ChunkMap.hasWork() reports.
        // `sleeping` with queued work is a hard stall: pollTask() only sets it
        // when popTasks() returns null, and nothing re-polls until the next
        // submit()/release().
        section(state, "dispatchers", () -> state.append(" dispatchers=[worldgen work=")
                .append(chunks.chunkMap.worldgenTaskDispatcher.hasWork())
                .append(" sleeping=").append(chunks.chunkMap.worldgenTaskDispatcher.sleeping)
                .append(" | light work=")
                .append(chunks.chunkMap.lightTaskDispatcher.hasWork())
                .append(" sleeping=").append(chunks.chunkMap.lightTaskDispatcher.sleeping)
                .append(']'));
        section(state, "serverLoop", () -> state.append(" serverLoop=[sameThread=")
                .append(current.isSameThread())
                .append(" queued=").append(current.getPendingTasksCount())
                .append(" chunkMapHasWork=").append(chunks.chunkMap.hasWork())
                .append(']'));
        // The player-ticket dispatcher admits only a handful of chunks into
        // execution at once and releases a slot when the chunk's full future
        // completes. If it reports the same positions tick after tick, ticket
        // promotion — not the send path — is the horizon's limit.
        section(state, "ticketDispatcher", () -> state.append(" ticketDispatcher=[")
                .append(chunks.chunkMap.getDistanceManager().getDebugStatus())
                .append(']'));
        for (net.minecraft.server.level.ServerPlayer player : current.getPlayerList().getPlayers()) {
            net.minecraft.server.level.ServerChunkCache playerChunks =
                    player.level().getChunkSource();
            section(state, "dimension", () -> state.append(" playerDimension=")
                    .append(player.level().dimension().identifier()));
            section(state, "trackingView", () -> appendTrackingView(state, playerChunks, player));
            section(state, "sender", () -> appendSender(state, player));
            section(state, "statuses", () -> appendStatusHistogram(state, playerChunks, player));
            section(state, "nearHolders", () -> state.append(" nearHolders=[")
                    .append(describeNearbyHolders(playerChunks, player)).append(']'));
            section(state, "stuck", () -> state.append(" stuck=[")
                    .append(describeStuckHolder(playerChunks, player)).append(']'));
            section(state, "genRoot", () -> state.append(" genRoot=[")
                    .append(describeGenerationRoot(playerChunks, player)).append(']'));
        }
        return state.toString();
    }

    /**
     * Runs one probe section, keeping every field the earlier sections produced.
     *
     * <p>A failing section rewinds only its own partial output and names itself,
     * so one null future costs one field group instead of the whole report.</p>
     */
    private static void section(StringBuilder out, String name, Runnable body) {
        int mark = out.length();
        try {
            body.run();
        } catch (Throwable failure) {
            out.setLength(mark);
            out.append(' ').append(name).append("-failed=")
                    .append(failure.getClass().getSimpleName());
        }
    }

    /** Splits the tracking view along the exact gates that permit a send. */
    private static void appendTrackingView(
            StringBuilder state,
            net.minecraft.server.level.ServerChunkCache chunks,
            net.minecraft.server.level.ServerPlayer player
    ) {
        net.minecraft.server.level.ChunkTrackingView view = player.getChunkTrackingView();
        // 0 tracked, 1 ready-to-send, 2 pending-send, 3 no holder,
        // 4 ticket level above FULL (33), 5 exactly FULL, 6 BLOCK_TICKING
        // or better, 7 send-sync still pending, 8 sendable level but no
        // ticking chunk yet.
        int[] counts = new int[9];
        view.forEach(pos -> {
            counts[0]++;
            long packed = pos.pack();
            if (chunks.chunkMap.getChunkToSend(packed) != null) {
                counts[1]++;
            }
            if (player.connection.chunkSender.isPending(packed)) {
                counts[2]++;
            }
            // Sending requires FullChunkStatus.BLOCK_TICKING (ticket level
            // <= 32) *and* a completed send-sync future, which waits on the
            // light engine. Splitting the tracking view along exactly those
            // two gates says whether the horizon is stuck on ticket
            // promotion or on light.
            net.minecraft.server.level.ChunkHolder holder =
                    chunks.chunkMap.getUpdatingChunkIfPresent(packed);
            if (holder == null) {
                counts[3]++;
                return;
            }
            int level = holder.getTicketLevel();
            if (level > 33) {
                counts[4]++;
                return;
            }
            if (level == 33) {
                counts[5]++;
                return;
            }
            counts[6]++;
            java.util.concurrent.CompletableFuture<?> sendSync = holder.getSendSyncFuture();
            if (sendSync != null && !sendSync.isDone()) {
                counts[7]++;
            }
            if (holder.getTickingChunk() == null) {
                counts[8]++;
            }
        });
        state.append(" playerView=").append(view)
                .append(" requestedView=").append(player.requestedViewDistance())
                .append(" tracked=").append(counts[0])
                .append(" trackedReady=").append(counts[1])
                .append(" pendingSend=").append(counts[2])
                .append(" noHolder=").append(counts[3])
                .append(" lvlAbove33=").append(counts[4])
                .append(" lvl33=").append(counts[5])
                .append(" lvlSendable=").append(counts[6])
                .append(" sendSyncPending=").append(counts[7])
                .append(" notTicking=").append(counts[8]);
    }

    /**
     * The send throttle itself. desired is what the client's
     * ChunkBatchSizeCalculator asked for; quota is what has accrued toward the
     * next batch. quota &lt; 1 with a non-empty queue means the throttle, not
     * readiness, is the limit.
     */
    private static void appendSender(
            StringBuilder state,
            net.minecraft.server.level.ServerPlayer player
    ) {
        net.minecraft.server.network.PlayerChunkSender sender = player.connection.chunkSender;
        state.append(" desired=").append(sender.desiredChunksPerTick)
                .append(" quota=").append(sender.batchQuota)
                .append(" unackBatches=").append(sender.unacknowledgedBatches)
                .append('/').append(sender.maxUnacknowledgedBatches)
                .append(" senderQueue=").append(sender.pendingChunks.size());
    }

    /**
     * Latest generation status of every holder around the player.
     *
     * <p>Separates "generation is slow" from "generation has stopped": a
     * histogram that does not move between heartbeats while tasks are still
     * being drained means the drained tasks are not generation work.</p>
     */
    private static void appendStatusHistogram(
            StringBuilder state,
            net.minecraft.server.level.ServerChunkCache chunks,
            net.minecraft.server.level.ServerPlayer player
    ) {
        java.util.Map<String, Integer> histogram = new java.util.TreeMap<>();
        net.minecraft.world.level.ChunkPos center = player.chunkPosition();
        int holders = 0;
        for (int dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
            for (int dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
                net.minecraft.server.level.ChunkHolder holder =
                        chunks.chunkMap.getUpdatingChunkIfPresent(
                                net.minecraft.world.level.ChunkPos.pack(
                                        center.x() + dx,
                                        center.z() + dz
                                )
                        );
                if (holder == null) {
                    continue;
                }
                holders++;
                String status = String.valueOf(holder.getLatestStatus());
                histogram.merge(status, 1, Integer::sum);
            }
        }
        state.append(" holders=").append(holders).append(" statuses=[");
        boolean first = true;
        for (java.util.Map.Entry<String, Integer> entry : histogram.entrySet()) {
            if (!first) {
                state.append(' ');
            }
            first = false;
            state.append(entry.getKey()).append('=').append(entry.getValue());
        }
        state.append(']');
    }

    /**
     * Per-holder state for the chunks around the player.
     *
     * <p>The player-ticket throttler admits four chunks at a time and frees a
     * slot only when that chunk's <em>entity-ticking</em> future completes
     * ({@code DistanceManager.runAllUpdates} chains the release onto
     * {@code ChunkHolder.getEntityTickingChunkFuture()}). If those futures never
     * complete, the four slots are held forever, no further {@code
     * PLAYER_LOADING} tickets are ever applied, and the rest of the tracking
     * view stays at a ticket level above FULL — which is exactly the observed
     * horizon. The chunks holding the slots are the ones next to the player, so
     * report each nearby holder's ticket level, statuses, and which of the three
     * promotion futures is still pending.</p>
     */
    private static String describeNearbyHolders(
            net.minecraft.server.level.ServerChunkCache chunks,
            net.minecraft.server.level.ServerPlayer player
    ) {
        StringBuilder holders = new StringBuilder();
        net.minecraft.world.level.ChunkPos center = player.chunkPosition();
        for (int dz = -1; dz <= 1; dz++) {
            for (int dx = -1; dx <= 1; dx++) {
                long packed = net.minecraft.world.level.ChunkPos.pack(
                        center.x() + dx,
                        center.z() + dz
                );
                net.minecraft.server.level.ChunkHolder holder =
                        chunks.chunkMap.getUpdatingChunkIfPresent(packed);
                if (holders.length() > 0) {
                    holders.append(' ');
                }
                holders.append(center.x() + dx).append(',').append(center.z() + dz).append(':');
                if (holder == null) {
                    holders.append("none");
                    continue;
                }
                // Deliberately terse. The verbose form truncated in the
                // progress-marker pipe after five of the nine holders, and the
                // four it dropped were exactly the stuck ticket slots.
                //
                // Fields: ticket level, first letter of the full status, then
                // the full / block-ticking / entity-ticking promotion futures.
                // The first zero from the left is the step that is stuck.
                // `gen` is the holder's own FULL generation future — the input
                // `prepareTickingChunk` waits on across the whole 3x3, so a
                // neighbour showing gen=0 is what blocks the centre's ticking.
                holders.append(holder.getTicketLevel())
                        .append(String.valueOf(holder.getFullStatus()).charAt(0))
                        .append(' ')
                        .append(holder.getFullChunkFuture().isDone() ? 1 : 0)
                        .append(holder.getTickingChunkFuture().isDone() ? 1 : 0)
                        .append(holder.getEntityTickingChunkFuture().isDone() ? 1 : 0)
                        .append(" gen=").append(fullGenerationState(holder));
            }
        }
        return holders.toString();
    }

    /**
     * The root of the parked-generation cascade.
     *
     * <p>{@code ChunkGenerationTask.waitForScheduledLayer()} parks the task on
     * the last future in its {@code scheduledLayer}, and those futures are the
     * generation futures of <em>neighbouring</em> holders. So one holder whose
     * future never completes parks every task queued behind it, and the visible
     * symptom (a chunk at a sendable ticket level whose FULL never arrives) can
     * be many chunks away from the cause.</p>
     *
     * <p>Parked tasks are unreachable — nothing holds them but the {@code
     * thenRun} continuation on the future they wait for — so this searches from
     * the holder side instead. The holder with the <em>lowest-index</em> pending
     * generation status is the deepest point of the cascade: everything above it
     * is waiting, and it is waiting on nothing earlier. That is the chunk to
     * explain.</p>
     */
    private static String describeGenerationRoot(
            net.minecraft.server.level.ServerChunkCache chunks,
            net.minecraft.server.level.ServerPlayer player
    ) {
        net.minecraft.world.level.ChunkPos center = player.chunkPosition();
        net.minecraft.server.level.ChunkHolder root = null;
        net.minecraft.world.level.chunk.status.ChunkStatus rootStatus = null;
        int rootIndex = Integer.MAX_VALUE;
        int pendingHolders = 0;
        int scanned = 0;
        // Wide enough to cover the tracking view plus the radius-8 generation
        // halo that feeds its edge.
        for (int dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
            for (int dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
                net.minecraft.server.level.ChunkHolder holder =
                        chunks.chunkMap.getUpdatingChunkIfPresent(
                                net.minecraft.world.level.ChunkPos.pack(
                                        center.x() + dx,
                                        center.z() + dz
                                )
                        );
                if (holder == null) {
                    continue;
                }
                scanned++;
                boolean anyPending = false;
                for (com.mojang.datafixers.util.Pair<
                        net.minecraft.world.level.chunk.status.ChunkStatus,
                        java.util.concurrent.CompletableFuture<
                                net.minecraft.server.level.ChunkResult<
                                        net.minecraft.world.level.chunk.ChunkAccess>>> entry
                        : holder.getAllFutures()) {
                    // Statuses the holder never requested have no future.
                    if (entry.getSecond() == null || entry.getSecond().isDone()) {
                        continue;
                    }
                    anyPending = true;
                    int index = entry.getFirst().getIndex();
                    if (index < rootIndex) {
                        rootIndex = index;
                        root = holder;
                        rootStatus = entry.getFirst();
                    }
                }
                if (anyPending) {
                    pendingHolders++;
                }
            }
        }
        StringBuilder detail = new StringBuilder();
        detail.append("scanned=").append(scanned)
                .append(" pendingHolders=").append(pendingHolders);
        if (root == null) {
            return detail.append(" root=none").toString();
        }
        return detail.append(" root=").append(root.getPos().x())
                .append(',').append(root.getPos().z())
                .append(" lvl=").append(root.getTicketLevel())
                .append(" waitingOn=").append(rootStatus)
                .append(" latest=").append(root.getLatestStatus())
                .toString();
    }

    /**
     * The first wedged holder, and <em>its own</em> 3x3 inputs.
     *
     * <p>Sampling around the player was misleading: it showed nine neighbours
     * all at {@code gen=1} while the centre was promoted fine. The chunks that
     * actually stall sit at the edge of the ticketed region, and what blocks
     * them is their <em>own</em> radius-1 neighbourhood reaching outward into
     * chunks that were never ticketed. {@code prepareTickingChunk} waits on the
     * FULL future of all nine, so a neighbour with {@code gen=0} — or no holder
     * at all — is the thing to fix.</p>
     *
     * <p>Reports the first holder in the tracking view that is at a sendable
     * ticket level ({@code <= 32}) but whose ticking future is still pending.
     * That is exactly the state that keeps a ticket-throttler slot occupied.</p>
     */
    private static String describeStuckHolder(
            net.minecraft.server.level.ServerChunkCache chunks,
            net.minecraft.server.level.ServerPlayer player
    ) {
        net.minecraft.server.level.ChunkHolder[] wedged = {null};
        player.getChunkTrackingView().forEach(pos -> {
            if (wedged[0] != null) {
                return;
            }
            net.minecraft.server.level.ChunkHolder holder =
                    chunks.chunkMap.getUpdatingChunkIfPresent(pos.pack());
            if (holder != null
                    && holder.getTicketLevel() <= 32
                    && !holder.getTickingChunkFuture().isDone()) {
                wedged[0] = holder;
            }
        });
        if (wedged[0] == null) {
            return "none";
        }
        net.minecraft.world.level.ChunkPos at = wedged[0].getPos();
        StringBuilder detail = new StringBuilder();
        detail.append(at.x()).append(',').append(at.z())
                .append(" lvl=").append(wedged[0].getTicketLevel())
                .append(" inputs:");
        for (int dz = -1; dz <= 1; dz++) {
            for (int dx = -1; dx <= 1; dx++) {
                long packed = net.minecraft.world.level.ChunkPos.pack(at.x() + dx, at.z() + dz);
                net.minecraft.server.level.ChunkHolder input =
                        chunks.chunkMap.getUpdatingChunkIfPresent(packed);
                detail.append(' ').append(at.x() + dx).append(',').append(at.z() + dz).append(':');
                if (input == null) {
                    detail.append("NOHOLDER");
                    continue;
                }
                detail.append(input.getTicketLevel())
                        .append('/').append(fullGenerationState(input));
            }
        }
        return detail.toString();
    }

    /**
     * State of this holder's {@code minecraft:full} generation future.
     *
     * <p>{@code prepareTickingChunk} waits on the FULL future of every chunk in
     * the 3x3 around it, so this is the exact per-neighbour input that decides
     * whether the centre chunk can ever be promoted to BLOCK_TICKING.</p>
     *
     * <p>{@code missing} is meaningful on its own: it means no FULL future has
     * been scheduled for this holder at all, which is a different failure from
     * one that is scheduled and pending.</p>
     */
    private static String fullGenerationState(net.minecraft.server.level.ChunkHolder holder) {
        for (com.mojang.datafixers.util.Pair<
                net.minecraft.world.level.chunk.status.ChunkStatus,
                java.util.concurrent.CompletableFuture<
                        net.minecraft.server.level.ChunkResult<
                                net.minecraft.world.level.chunk.ChunkAccess>>> entry
                : holder.getAllFutures()) {
            if (entry.getFirst() == net.minecraft.world.level.chunk.status.ChunkStatus.FULL) {
                if (entry.getSecond() == null) {
                    return "missing";
                }
                return entry.getSecond().isDone() ? "1" : "0";
            }
        }
        return "missing";
    }
}
