package org.lwjgl.sdl;

import java.nio.ByteBuffer;
import org.lwjgl.system.MemoryUtil;

/**
 * Browser SDL: surfaces, which Minecraft creates only for the window icon.
 * The page has its own favicon, so a surface just describes the caller's
 * pixels; it never copies or retains them.
 */
public final class SDLSurface {
    private SDLSurface() {
    }

    public static SDL_Surface SDL_CreateSurfaceFrom(int width, int height, int format, ByteBuffer pixels, int pitch) {
        SDL_Surface surface = SDL_Surface.calloc()
                .format(format)
                .w(width)
                .h(height)
                .pitch(pitch)
                .refcount(1);
        MemoryUtil.memPutAddress(surface.address() + SDL_Surface.PIXELS, MemoryUtil.memAddressSafe(pixels));
        return surface;
    }

    public static boolean SDL_AddSurfaceAlternateImage(SDL_Surface surface, SDL_Surface image) {
        return true;
    }

    public static void SDL_DestroySurface(SDL_Surface surface) {
        if (surface != null) {
            surface.free();
        }
    }
}
