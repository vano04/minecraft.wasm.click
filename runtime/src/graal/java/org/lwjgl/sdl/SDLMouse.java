package org.lwjgl.sdl;

import dev.mcweb.graal.BrowserInputCompat;
import java.nio.FloatBuffer;

/** Browser SDL: pointer state, relative mode and cursors. */
public final class SDLMouse {
    private SDLMouse() {
    }

    /** Relative mode is the browser's pointer lock, armed for the next click. */
    public static boolean SDL_SetWindowRelativeMouseMode(long window, boolean enabled) {
        BrowserInputCompat.setRelativeMouseMode(enabled);
        return true;
    }

    public static void SDL_WarpMouseInWindow(long window, float x, float y) {
        BrowserInputCompat.warpMouse(x, y);
    }

    public static int SDL_GetMouseState(FloatBuffer x, FloatBuffer y) {
        if (x != null) {
            x.put(x.position(), BrowserInputCompat.mouseX());
        }
        if (y != null) {
            y.put(y.position(), BrowserInputCompat.mouseY());
        }
        return BrowserInputCompat.buttonMask();
    }

    /** The canvas is the whole desktop: the window sits at its origin. */
    public static int SDL_GetGlobalMouseState(FloatBuffer x, FloatBuffer y) {
        return SDL_GetMouseState(x, y);
    }

    /**
     * Cursor shapes are accepted and not shown: the page keeps its own
     * cursor. Handles must be non-zero, or Minecraft treats the cursor as
     * missing.
     */
    public static long SDL_CreateSystemCursor(int id) {
        return id + 1L;
    }

    public static boolean SDL_SetCursor(long cursor) {
        return true;
    }

    public static long SDL_GetDefaultCursor() {
        return 1L;
    }
}
