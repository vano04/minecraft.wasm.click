package org.lwjgl.sdl;

import java.nio.IntBuffer;
import org.lwjgl.PointerBuffer;
import org.lwjgl.system.MemoryUtil;

/**
 * Browser SDL: freeing arrays the video shim returned. They come from
 * {@link MemoryUtil}, so they go back to it.
 */
public final class SDLStdinc {
    private SDLStdinc() {
    }

    public static void SDL_free(IntBuffer mem) {
        MemoryUtil.nmemFree(MemoryUtil.memAddressSafe(mem));
    }

    public static void SDL_free(PointerBuffer mem) {
        MemoryUtil.nmemFree(MemoryUtil.memAddressSafe(mem));
    }
}
