package dev.mcweb.graal;

import java.util.concurrent.CompletableFuture;
import net.minecraft.network.protocol.game.ServerboundMovePlayerPacket;
import net.minecraft.server.level.ChunkResult;
import net.minecraft.server.level.GenerationChunkHolder;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.util.Mth;
import net.minecraft.world.level.chunk.ChunkAccess;

/**
 * The Server thread does not wait for chunks a player outruns.
 *
 * <p>Three places: two of them on the move-packet path -- lookups that may
 * not load ({@link #noWaitUnlessLoading}) and moves into a chunk still being
 * generated ({@link #holdMove}) -- and a spawn probe that reads the blocks of
 * a chunk still being generated ({@link #isSpawnPositionOk}).</p>
 *
 * <p>{@code ServerChunkCache.getChunk(x, z, status, load=false)} on the
 * Server thread declines to <em>start</em> generating a chunk, but it still
 * waits (a {@code managedBlock}) for a generation that is already under way --
 * and every chunk inside a player's loading ticket is under way. A player
 * flying toward the render edge sends moves whose collision box and fluid
 * check reach the next chunk: scheduled, not generated. On a desktop that
 * wait is milliseconds. Here generation runs breadth-first over the whole new
 * area at a few chunks a second, and the Server thread sat in it for minutes:
 * no ticks, no chunk sending, the world frozen around a player who could not
 * move.</p>
 *
 * <p>The build hands the future {@code getChunkFutureMainThread} returned
 * through here before {@code getChunk} waits on it. With {@code load=false}
 * an unfinished one is replaced by Mojang's own completed
 * {@code UNLOADED_CHUNK_FUTURE}, so the caller gets the {@code null} that
 * {@code load=false} already allows -- what vanilla answers for a chunk that
 * is not loaded at all, and every such caller handles. A finished chunk is
 * returned as before, and {@code load=true} lookups are unchanged. The client
 * does not move its player into a chunk it has not received, so nobody passes
 * through terrain that appears later.</p>
 */
public final class BrowserChunkCompat {
    private BrowserChunkCompat() {
    }

    /** Moves dropped by {@link #holdMove}, for the {@code lookahead:} report. */
    static volatile int heldMoves;

    /**
     * Whether {@code handleMovePlayer} returns early: {@code wonGame} (its own
     * reason), or a move that would put the player's box in a chunk the server
     * has not finished generating.
     *
     * <p>The client ticks its player until it stands in a chunk it has not
     * received, so the last move before it stops is one step into such a
     * chunk. Accepted, it put the server's player there, and
     * {@code Entity.move} and the player's tick then read block states in it
     * -- lookups that must return a chunk, so the Server thread waited for the
     * generation, minutes here. Dropped, the player stays where they were on
     * the server, and the client is sent back there ({@link #bounce}).</p>
     */
    public static boolean holdMove(boolean wonGame, ServerGamePacketListenerImpl listener,
                                   ServerboundMovePlayerPacket packet) {
        if (wonGame || !packet.hasPosition()) {
            return wonGame;
        }
        ServerPlayer player = listener.player;
        double x = packet.getX(player.getX()), z = packet.getZ(player.getZ());
        // Every chunk the player's box touches there, with a block to spare:
        // the tick's block checks (checkInsideBlocks, fluids) read the blocks
        // it overlaps and sweeps, and a box on a chunk's edge reaches into the
        // next one. Moves away from a pending chunk touch only complete ones
        // and go through.
        int x0 = Mth.floor(x - 1.0) >> 4, x1 = Mth.floor(x + 1.0) >> 4;
        int z0 = Mth.floor(z - 1.0) >> 4, z1 = Mth.floor(z + 1.0) >> 4;
        net.minecraft.server.level.ServerChunkCache chunks = player.level().getChunkSource();
        for (int cx = x0; cx <= x1; cx++) {
            for (int cz = z0; cz <= z1; cz++) {
                if (chunks.getChunkNow(cx, cz) == null) {
                    heldMoves++;
                    bounce(listener, player);
                    return true;
                }
            }
        }
        return false;
    }

    private static ServerPlayer bouncedPlayer;
    private static int bouncedAt = Integer.MIN_VALUE;

    /**
     * Sends the client's player back to where the server has it, keeping
     * their view direction and stopping their momentum: an invisible wall at
     * the edge of what is generated. Without it the client stayed one step
     * inside a chunk it did not have, and a camera in a missing chunk draws
     * nothing at all -- the whole world vanished until that chunk arrived.
     * At most every 10 ticks: a client that is not ticking its player sends
     * nothing more, so one bounce per overshoot is the usual case.
     */
    private static void bounce(ServerGamePacketListenerImpl listener, ServerPlayer player) {
        if (player == bouncedPlayer && player.tickCount - bouncedAt < 10 && player.tickCount >= bouncedAt) {
            return;
        }
        bouncedPlayer = player;
        bouncedAt = player.tickCount;
        listener.teleport(new net.minecraft.world.entity.PositionMoveRotation(
                player.position(), net.minecraft.world.phys.Vec3.ZERO, 0f, 0f),
                net.minecraft.world.entity.Relative.ROTATION);
    }

    /**
     * The client player's move, stopped at the edge of the chunks the client
     * has.
     *
     * <p>A player who outruns chunk generation used to fly on into chunks
     * the client had not received. In 26.2 a camera in a missing chunk
     * propagates nowhere ({@code SectionOcclusionGraph} waits for that one
     * chunk), so the whole world vanished -- blocks still there to break,
     * nothing drawn -- and the server, which refuses such moves, could only
     * rubber-band the player back while the keys were held. Here each
     * horizontal component of the move is dropped if it would bring the
     * player's box (a block of margin, as the server's check) over a chunk
     * the client does not have that it was not already over; the vertical
     * component always goes through. The player meets a wall at the edge
     * and walks on once the chunk arrives.</p>
     */
    public static net.minecraft.world.phys.Vec3 clampToLoaded(
            net.minecraft.client.player.LocalPlayer player, net.minecraft.world.phys.Vec3 delta) {
        if (delta == null || (delta.x == 0 && delta.z == 0) || player.noPhysics && player.isSpectator()) {
            return delta;
        }
        return clampToLoaded(player.level().getChunkSource(), player.getX(), player.getZ(), delta);
    }

    static net.minecraft.world.phys.Vec3 clampToLoaded(
            net.minecraft.world.level.chunk.ChunkSource chunks,
            double x, double z, net.minecraft.world.phys.Vec3 delta) {
        boolean xOk = !entersMissing(chunks, x, z, x + delta.x, z);
        boolean zOk = !entersMissing(chunks, x, z, x, z + delta.z);
        if (xOk && zOk) {
            if (!entersMissing(chunks, x, z, x + delta.x, z + delta.z)) {
                return delta;
            }
            // Both axis moves can be safe while their diagonal enters a
            // missing corner chunk. Slide on one loaded axis, never both.
            zOk = false;
        }
        heldClientMoves++;
        return new net.minecraft.world.phys.Vec3(xOk ? delta.x : 0, delta.y, zOk ? delta.z : 0);
    }

    /** Moves {@link #clampToLoaded} stopped at the edge. */
    static volatile int heldClientMoves;

    // Whether the box (a block of margin) at (x1, z1) is over a chunk the
    // client does not have that the box at (x0, z0) was not over.
    private static boolean entersMissing(net.minecraft.world.level.chunk.ChunkSource chunks,
                                         double x0, double z0, double x1, double z1) {
        int ax = Mth.floor(x1 - 1.0) >> 4, bx = Mth.floor(x1 + 1.0) >> 4;
        int az = Mth.floor(z1 - 1.0) >> 4, bz = Mth.floor(z1 + 1.0) >> 4;
        for (int cx = ax; cx <= bx; cx++) {
            for (int cz = az; cz <= bz; cz++) {
                if (chunks.hasChunk(cx, cz)) {
                    continue;
                }
                boolean wasOver = cx >= (Mth.floor(x0 - 1.0) >> 4) && cx <= (Mth.floor(x0 + 1.0) >> 4)
                        && cz >= (Mth.floor(z0 - 1.0) >> 4) && cz <= (Mth.floor(z0 + 1.0) >> 4);
                if (!wasOver) {
                    return true;
                }
            }
        }
        return false;
    }

    // ---- a spawn probe does not wait for chunks either

    /** Probes {@link #isSpawnPositionOk} answered without the chunk, for the {@code lookahead:} report. */
    static volatile int spawnProbesDeferred;

    /**
     * A spawn probe at a position whose chunk the server has not generated:
     * false, and Mojang's own check for a position whose chunk it has.
     *
     * <p>A placement type's {@code isSpawnPositionOk} reads the block below,
     * at and above the position through {@code Level.getBlockState}, which
     * asks {@code ServerChunkCache.getChunk(x, z, FULL, load=true)} -- and
     * that waits, on the Server thread, for a generation already under way
     * ({@link #noWaitUnlessLoading}'s {@code load=false} is what the move
     * path uses). Every chunk a player's ticket covers is under way, so a
     * spawner probing a position a few blocks from the player during flight
     * parked the server for the whole breadth-first generation of that chunk
     * and the eight around it: no ticks, and so no chunk sends either --
     * client, visible and renderable all frozen with it. Watchdog forensics
     * found {@code CatSpawner.tick} there every 1200 ticks, one probe 8-32
     * blocks out, and a 13 s freeze with a 61-chunk burst when it ended.</p>
     *
     * <p>Answered here instead with what the wait would have answered for a
     * position in a chunk that is not generated -- and what vanilla already
     * answers for a chunk that is not loaded at all, which every caller
     * handles. The spawner moves on and asks again in a minute (CatSpawner)
     * or a tick (NaturalSpawner), by which time the chunk is usually there;
     * a mob is never spawned into, nor is one read out of, a chunk that does
     * not exist. A position whose chunk the server does have runs Mojang's
     * check unchanged.</p>
     */
    public static boolean isSpawnPositionOk(net.minecraft.world.entity.SpawnPlacementType placement,
            net.minecraft.world.level.LevelReader level, net.minecraft.core.BlockPos pos,
            net.minecraft.world.entity.EntityType<?> entityType) {
        // getChunkNow is the same load=false lookup the move path guards
        // with, and the two agree on what is there: null means getChunk
        // would wait for the generation, so the position cannot be answered.
        if (level instanceof net.minecraft.server.level.ServerLevel serverLevel
                && serverLevel.getChunkSource().getChunkNow(pos.getX() >> 4, pos.getZ() >> 4) == null) {
            spawnProbesDeferred++;
            return false;
        }
        return placement.isSpawnPositionOk(level, pos, entityType);
    }

    // ---- the same edits for the in-tab patch (jar-massage.js), which can
    // only swap an instruction for a static call: the build's transform
    // inserts calls instead (build.gradle). Both land in the methods above.

    /** ServerChunkCache.getChunk's getChunkFutureMainThread, then {@link #noWaitUnlessLoading}. */
    public static CompletableFuture<ChunkResult<ChunkAccess>> getChunkFutureNoWait(
            net.minecraft.server.level.ServerChunkCache cache, int x, int z,
            net.minecraft.world.level.chunk.status.ChunkStatus status, boolean load) {
        return noWaitUnlessLoading(load, cache.getChunkFutureMainThread(x, z, status, load));
    }

    // handleMovePlayer's packet, noted by its first call, read by its wonGame
    // test. Server thread only, and consumed at once.
    private static ServerboundMovePlayerPacket notedMove;

    /** handleMovePlayer's PacketUtils.ensureRunningOnSameThread, noting the packet. */
    public static void ensureRunningOnSameThread(net.minecraft.network.protocol.Packet<?> packet,
            net.minecraft.network.PacketListener listener, net.minecraft.server.level.ServerLevel level) {
        ensureOnServerThread(packet, listener, level);
        notedMove = packet instanceof ServerboundMovePlayerPacket move ? move : null;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static void ensureOnServerThread(net.minecraft.network.protocol.Packet packet,
            net.minecraft.network.PacketListener listener, net.minecraft.server.level.ServerLevel level) {
        net.minecraft.network.protocol.PacketUtils.ensureRunningOnSameThread(packet, listener, level);
    }

    /** handleMovePlayer's read of player.wonGame: {@link #holdMove} on the noted packet. */
    public static boolean wonGameOrHold(ServerPlayer player) {
        ServerboundMovePlayerPacket packet = notedMove;
        notedMove = null;
        return packet == null ? player.wonGame : holdMove(player.wonGame, player.connection, packet);
    }

    /** LivingEntity's calls to move: the client player's delta through {@link #clampToLoaded}. */
    public static void move(net.minecraft.world.entity.LivingEntity entity,
                            net.minecraft.world.entity.MoverType type, net.minecraft.world.phys.Vec3 delta) {
        entity.move(type, entity instanceof net.minecraft.client.player.LocalPlayer player
                ? clampToLoaded(player, delta) : delta);
    }

    // ---- chunks sent once complete, not once ticking

    /**
     * Whether complete chunks are sent before they tick:
     * {@code -Dmcweb.earlySend=false} ({@code ?earlySend=0}) turns it off.
     */
    static final boolean EARLY_SEND = !"false".equals(System.getProperty("mcweb.earlySend"));

    // The chunks each player has been given (queued or sent) and not dropped
    // since. Server thread only.
    private static final java.util.Map<ServerPlayer, it.unimi.dsi.fastutil.longs.LongOpenHashSet> given =
            new java.util.WeakHashMap<>();

    private static it.unimi.dsi.fastutil.longs.LongOpenHashSet given(ServerPlayer player) {
        return given.computeIfAbsent(player, p -> new it.unimi.dsi.fastutil.longs.LongOpenHashSet());
    }


    /**
     * ChunkHolder's chunk for sending and for recording changes
     * (getChunkToSend, blockChanged, sectionLightChanged): the ticking one,
     * or with early sending the complete one.
     *
     * <p>Vanilla sends a chunk once it ticks, which needs all eight of its
     * neighbours complete too, and its sender re-reads this at send time. At
     * the edge of the world a finished chunk therefore waited for the next
     * ring, and generation works a ring at a time, so a whole row became
     * sendable at once: flying, nothing for 15-23 s and then 20-40 chunks in
     * a second, while the server completed chunks at a steady few a second.
     * getChunkToSend still waits for the chunk's light (its send-sync
     * future); the client still meshes a section only once its neighbours
     * have arrived, so nothing is drawn half-done.</p>
     */
    public static net.minecraft.world.level.chunk.LevelChunk chunkToSend(net.minecraft.server.level.ChunkHolder holder) {
        net.minecraft.world.level.chunk.LevelChunk ticking = holder.getTickingChunk();
        if (ticking != null || !EARLY_SEND) {
            return ticking;
        }
        ChunkResult<net.minecraft.world.level.chunk.LevelChunk> full = holder.getFullChunkFuture().getNow(null);
        return full == null ? null : full.orElse(null);
    }

    /**
     * Queues, for each player, the complete chunks in their view that nothing
     * else will: vanilla queues a chunk when it enters the view or when it
     * starts ticking, and a chunk completing inside the view does neither.
     */
    static int sendEarly(net.minecraft.server.level.ServerLevel level, ServerPlayer player) {
        net.minecraft.server.level.ChunkMap map = level.getChunkSource().chunkMap;
        it.unimi.dsi.fastutil.longs.LongOpenHashSet has = given(player);
        net.minecraft.server.network.PlayerChunkSender sender = player.connection.chunkSender;
        int[] sent = {0};
        int[] waitingForLight = {0};
        player.getChunkTrackingView().forEach(pos -> {
            long key = pos.pack();
            if (has.contains(key)) {
                return;
            }
            net.minecraft.world.level.chunk.LevelChunk chunk = map.getChunkToSend(key);
            if (chunk == null) {
                if (level.getChunkSource().getChunkNow(pos.x(), pos.z()) != null) {
                    waitingForLight[0]++;       // complete, light not settled
                }
                return;
            }
            has.add(key);
            sender.markChunkPendingToSend(chunk);
            sent[0]++;
        });
        earlySent += sent[0];
        lightWaiting = waitingForLight[0];
        return sent[0];
    }

    /** Chunks {@link #sendEarly} has queued, for the {@code flow:} report. */
    static volatile int earlySent;
    /** Complete chunks in view whose light has not settled, at the last sendEarly. */
    static volatile int lightWaiting;

    /**
     * ChunkMap's markChunkPendingToSend(player, chunk) -- a chunk entering the
     * view, or starting to tick: queued unless the player already has it.
     * Changes to a chunk sent before it ticked -- its light above all,
     * completed across its borders by neighbours that finish after it --
     * are recorded (ChunkHolder asks {@link #chunkToSend}, not only for a
     * ticking chunk) and broadcast the vanilla way once it ticks: vanilla
     * queues a holder for broadcast when its chunk starts ticking, so the
     * sections that changed go out together, once. Broadcasting each change
     * as it happened cost ~25% of FPS while the world loaded.
     */
    public static void markChunkPendingToSend(ServerPlayer player, net.minecraft.world.level.chunk.LevelChunk chunk) {
        if (!EARLY_SEND || given(player).add(chunk.getPos().pack())) {
            player.connection.chunkSender.markChunkPendingToSend(chunk);
        }
    }

    /** ChunkMap's chunkSender.dropChunk: a chunk leaving the view is no longer the player's. */
    public static void dropChunk(net.minecraft.server.network.PlayerChunkSender sender, ServerPlayer player,
                                 net.minecraft.world.level.ChunkPos pos) {
        it.unimi.dsi.fastutil.longs.LongOpenHashSet has = given.get(player);
        if (has != null) {
            has.remove(pos.pack());
        }
        sender.dropChunk(player, pos);
    }

    public static CompletableFuture<ChunkResult<ChunkAccess>> noWaitUnlessLoading(
            boolean load, CompletableFuture<ChunkResult<ChunkAccess>> future) {
        if (load || future == null || future.isDone()) {
            return future;
        }
        return GenerationChunkHolder.UNLOADED_CHUNK_FUTURE;
    }
}
