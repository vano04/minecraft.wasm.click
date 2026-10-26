package org.lwjgl.sdl;

/** Browser SDL: the monotonic clock. */
public final class SDLTimer {
    private static final long START_NANOS = System.nanoTime();

    private SDLTimer() {
    }

    /**
     * Nanoseconds since SDL started. This is also Minecraft's frame clock:
     * {@code RenderSystem.initBackendSystem} returns it as the game's
     * {@code NanoTimeSource}, and {@code Blaze3D.getTime} reads it.
     */
    public static long SDL_GetTicksNS() {
        return System.nanoTime() - START_NANOS;
    }
}
