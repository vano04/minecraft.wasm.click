package org.lwjgl.sdl;

/** Browser SDL: hints configure native subsystems the page does not have. */
public final class SDLHints {
    private SDLHints() {
    }

    public static boolean SDL_SetHint(CharSequence name, CharSequence value) {
        return true;
    }
}
