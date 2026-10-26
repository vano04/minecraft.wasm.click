package org.lwjgl.sdl;

/** Browser SDL: the last error a shim reported, for Minecraft's log lines. */
public final class SDLError {
    private static volatile String lastError = "";

    private SDLError() {
    }

    public static String SDL_GetError() {
        return lastError;
    }

    /** Records why a shim call failed and returns SDL's failure value. */
    static boolean fail(String message) {
        lastError = message;
        return false;
    }
}
