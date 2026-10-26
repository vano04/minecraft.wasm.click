package dev.mcweb.graal;

import dev.mcweb.graal.webgpu.BrowserGpu;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.function.BooleanSupplier;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.particle.ParticleEngine;
import net.minecraft.client.renderer.GameRenderer;
import net.minecraft.client.renderer.texture.TextureManager;
import net.minecraft.world.entity.Entity;

/**
 * Where a frame's time goes, by the clock rather than by samples.
 *
 * <p>The in-world sampler ({@code ?clientProfile=N}) takes a thread's stack
 * at a handshake, which lands on method entries and back-edges, so tiny
 * getters collect samples out of proportion. This times the client tick and
 * its phases directly. The massage plan turns the calls in
 * {@code Minecraft.runTick}, {@code Minecraft.tick} and
 * {@code Minecraft.renderFrame} into calls to the methods here, each of
 * which makes the original call. With {@code -Dmcweb.frameSplit} (the page's
 * {@code ?frameSplit=1}) they also time it, and once a second the pump prints
 * a {@code framesplit:} line:
 * <ul>
 * <li>frames that ran at least one client tick against frames that ran none,
 *     with the median and 90th-percentile frame time of each;</li>
 * <li>the mean milliseconds per client tick of the tick and of each phase:
 *     level tick, entities, animate tick, particles, textures and the game
 *     renderer's tick;</li>
 * <li>the mean milliseconds per frame of {@code GameRenderer.render}.</li>
 * </ul>
 * and an {@code entitytick:} line: what {@code ClientLevel.tickNonPassenger}
 * spends in {@code Entity.commonTick} and {@code Entity.tick} per client
 * tick, and the entity classes that cost the most, with how many ticked and
 * the microseconds each took.
 * Without the flag each method is one static check and the original call.
 * With it, mind the clock's own price: {@code System.nanoTime} costs about
 * 0.6 µs on this runtime, so timing anything called thousands of times a
 * tick (animateTick's block samples) measures mostly the clock.
 */
public final class BrowserFrameTiming {
    private static final boolean ENABLED = Boolean.getBoolean("mcweb.frameSplit");

    private static final int TICK = 0;
    private static final int LEVEL = 1;
    private static final int ENTITIES = 2;
    private static final int ANIMATE = 3;
    private static final int PARTICLES = 4;
    private static final int TEXTURES = 5;
    private static final int RENDERER_TICK = 6;
    private static final int RENDER = 7;
    private static final String[] NAMES = {
        "tick", "level", "entities", "animate", "particles", "textures", "rendererTick", "render",
    };

    private static final long[] nanos = new long[NAMES.length];
    private static int ticks;
    private static int ticksThisFrame;
    private static final long[] tickFrames = new long[1024];
    private static final long[] plainFrames = new long[1024];
    private static int tickFrameCount;
    private static int plainFrameCount;
    private static long windowStart;
    private static long commonTickNanos;
    /** Per entity class: nanoseconds in {@code tick}, then calls. */
    private static final IdentityHashMap<Class<?>, long[]> entityTicks = new IdentityHashMap<>();

    private BrowserFrameTiming() {
    }

    public static void clientTick(Minecraft minecraft) {
        if (!ENABLED) {
            minecraft.tick();
            return;
        }
        long start = System.nanoTime();
        minecraft.tick();
        nanos[TICK] += System.nanoTime() - start;
        ticks++;
        ticksThisFrame++;
    }

    public static void levelTick(ClientLevel level, BooleanSupplier haveTime) {
        if (!ENABLED) {
            level.tick(haveTime);
            return;
        }
        long start = System.nanoTime();
        level.tick(haveTime);
        nanos[LEVEL] += System.nanoTime() - start;
    }

    public static void tickEntities(ClientLevel level) {
        if (!ENABLED) {
            level.tickEntities();
            return;
        }
        long start = System.nanoTime();
        level.tickEntities();
        nanos[ENTITIES] += System.nanoTime() - start;
    }

    public static void animateTick(ClientLevel level, int x, int y, int z) {
        if (!ENABLED) {
            level.animateTick(x, y, z);
            return;
        }
        long start = System.nanoTime();
        level.animateTick(x, y, z);
        nanos[ANIMATE] += System.nanoTime() - start;
    }

    public static void particleTick(ParticleEngine particles) {
        if (!ENABLED) {
            particles.tick();
            return;
        }
        long start = System.nanoTime();
        particles.tick();
        nanos[PARTICLES] += System.nanoTime() - start;
    }

    public static void textureTick(TextureManager textures) {
        if (!ENABLED) {
            textures.tick();
            return;
        }
        long start = System.nanoTime();
        textures.tick();
        nanos[TEXTURES] += System.nanoTime() - start;
    }

    public static void rendererTick(GameRenderer renderer) {
        if (!ENABLED) {
            renderer.tick();
            return;
        }
        long start = System.nanoTime();
        renderer.tick();
        nanos[RENDERER_TICK] += System.nanoTime() - start;
    }

    public static void render(GameRenderer renderer) {
        if (!ENABLED) {
            renderer.render();
            return;
        }
        long start = System.nanoTime();
        renderer.render();
        nanos[RENDER] += System.nanoTime() - start;
    }

    public static void entityCommonTick(Entity entity) {
        if (!ENABLED) {
            entity.commonTick();
            return;
        }
        long start = System.nanoTime();
        entity.commonTick();
        commonTickNanos += System.nanoTime() - start;
    }

    public static void entityTick(Entity entity) {
        if (!ENABLED) {
            entity.tick();
            return;
        }
        long start = System.nanoTime();
        entity.tick();
        long spent = System.nanoTime() - start;
        long[] slot = entityTicks.get(entity.getClass());
        if (slot == null) {
            slot = new long[2];
            entityTicks.put(entity.getClass(), slot);
        }
        slot[0] += spent;
        slot[1]++;
    }

    /** The pump's call after each frame, on the client thread. */
    static void frameEnded(long frameNanos, long now) {
        if (!ENABLED) {
            return;
        }
        if (ticksThisFrame > 0) {
            if (tickFrameCount < tickFrames.length) {
                tickFrames[tickFrameCount++] = frameNanos;
            }
        } else if (plainFrameCount < plainFrames.length) {
            plainFrames[plainFrameCount++] = frameNanos;
        }
        ticksThisFrame = 0;
        if (windowStart == 0L) {
            windowStart = now;
        }
        if (now - windowStart < 1_000_000_000L) {
            return;
        }
        int frames = tickFrameCount + plainFrameCount;
        StringBuilder line = new StringBuilder(256);
        line.append("framesplit: frames=").append(frames)
                .append(" tickFrames=").append(tickFrameCount)
                .append(" ticks=").append(ticks)
                .append(" tickFrame").append(percentiles(tickFrames, tickFrameCount))
                .append(" plainFrame").append(percentiles(plainFrames, plainFrameCount))
                .append(" | per tick ms:");
        for (int i = TICK; i < RENDER; i++) {
            line.append(' ').append(NAMES[i]).append('=')
                    .append(ticks == 0 ? "-" : String.format(Locale.ROOT, "%.2f", nanos[i] / 1e6 / ticks));
        }
        line.append(" | per frame ms: render=")
                .append(frames == 0 ? "-" : String.format(Locale.ROOT, "%.2f", nanos[RENDER] / 1e6 / frames));
        BrowserGpu.reportProgress(line.toString());
        if (ticks > 0) {
            BrowserGpu.reportProgress(entityLine());
        }
        Arrays.fill(nanos, 0L);
        ticks = 0;
        tickFrameCount = 0;
        plainFrameCount = 0;
        windowStart = now;
    }

    private static String entityLine() {
        long tickNanos = 0L;
        long calls = 0L;
        List<Class<?>> classes = new ArrayList<>(entityTicks.keySet());
        for (long[] slot : entityTicks.values()) {
            tickNanos += slot[0];
            calls += slot[1];
        }
        classes.sort((a, b) -> Long.compare(entityTicks.get(b)[0], entityTicks.get(a)[0]));
        StringBuilder line = new StringBuilder(512);
        line.append(String.format(Locale.ROOT,
                "entitytick: per tick ms: commonTick=%.2f tick=%.2f entities=%.0f | top:",
                commonTickNanos / 1e6 / ticks, tickNanos / 1e6 / ticks, (double) calls / ticks));
        for (int i = 0; i < Math.min(8, classes.size()); i++) {
            long[] slot = entityTicks.get(classes.get(i));
            line.append(String.format(Locale.ROOT, " %s=%.2fms/%.0f@%.0fus",
                    classes.get(i).getSimpleName(), slot[0] / 1e6 / ticks, (double) slot[1] / ticks,
                    slot[0] / 1e3 / slot[1]));
        }
        commonTickNanos = 0L;
        entityTicks.clear();
        return line.toString();
    }

    private static String percentiles(long[] values, int count) {
        if (count == 0) {
            return "[-]";
        }
        long[] sorted = Arrays.copyOf(values, count);
        Arrays.sort(sorted);
        return String.format(Locale.ROOT, "[p50=%.1f p90=%.1f]",
                sorted[count / 2] / 1e6, sorted[Math.min(count - 1, count * 9 / 10)] / 1e6);
    }
}
