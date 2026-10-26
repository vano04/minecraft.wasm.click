package org.lwjgl.sdl;

/** Browser SDL: the platform name shown in debug screens and crash reports. */
public final class SDLPlatform {
    private SDLPlatform() {
    }

    public static String SDL_GetPlatform() {
        return "Web";
    }
}
