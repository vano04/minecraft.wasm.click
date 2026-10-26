package org.lwjgl.sdl;

/**
 * Browser SDL: the clipboard. The browser clipboard API is asynchronous and
 * gated on user gestures, so copy and paste stay inside the game.
 */
public final class SDLClipboard {
    private static volatile String clipboard = "";

    private SDLClipboard() {
    }

    public static String SDL_GetClipboardText() {
        return clipboard;
    }

    public static boolean SDL_SetClipboardText(CharSequence text) {
        clipboard = text == null ? "" : text.toString();
        return true;
    }
}
