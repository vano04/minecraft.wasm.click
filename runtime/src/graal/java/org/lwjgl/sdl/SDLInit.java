package org.lwjgl.sdl;

/**
 * Browser SDL: initialisation. There is no native SDL in the page; the port's
 * {@code org.lwjgl.sdl} classes are whole-class replacements that answer the
 * calls Minecraft 26.3 makes from the browser's own state. The real classes
 * resolve native function addresses in their static initialisers and would
 * fail on the first call.
 */
public final class SDLInit {
    private SDLInit() {
    }

    public static boolean SDL_Init(int flags) {
        return true;
    }

    public static void SDL_Quit() {
    }

    public static boolean SDL_SetAppMetadataProperty(CharSequence name, CharSequence value) {
        return true;
    }
}
