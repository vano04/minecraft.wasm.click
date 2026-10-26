package org.lwjgl.sdl;

import dev.mcweb.graal.BrowserInputBridge;
import dev.mcweb.graal.BrowserInputCompat;
import dev.mcweb.graal.BrowserTextInput;
import dev.mcweb.graal.BrowserWindowCompat;

/**
 * Browser SDL: the event queue. Events come from the page host through
 * {@link BrowserInputCompat}, already in SDL's numbering.
 */
public final class SDLEvents {
    // Event types, as LWJGL 3.4.3 declares them.
    public static final int SDL_EVENT_WINDOW_RESIZED = 518;
    public static final int SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED = 519;
    public static final int SDL_EVENT_KEY_DOWN = 768;
    public static final int SDL_EVENT_KEY_UP = 769;
    public static final int SDL_EVENT_TEXT_EDITING = 770;
    public static final int SDL_EVENT_TEXT_INPUT = 771;
    public static final int SDL_EVENT_KEYMAP_CHANGED = 772;
    public static final int SDL_EVENT_MOUSE_MOTION = 1024;
    public static final int SDL_EVENT_MOUSE_BUTTON_DOWN = 1025;
    public static final int SDL_EVENT_MOUSE_BUTTON_UP = 1026;
    public static final int SDL_EVENT_MOUSE_WHEEL = 1027;

    private SDLEvents() {
    }

    /**
     * Unlike SDL's, this does not pump first: the frame pump drains the host
     * once per frame just before Minecraft polls, and pumping here as well
     * would cost a host round trip for the empty poll that ends every loop.
     */
    public static boolean SDL_PollEvent(SDL_Event event) {
        if (event == null) {
            return false;
        }
        if (BrowserInputCompat.poll(event)) {
            return true;
        }
        // The empty poll ends the frame's input: what the game now wants
        // typed, and where, goes to the page from here.
        BrowserTextInput.publish();
        return false;
    }

    /** Called while Minecraft loads a world or disconnects, when it pumps without a frame. */
    public static void SDL_PumpEvents() {
        BrowserInputBridge.drainHostEvents();
    }

    public static void SDL_FlushEvents(int minType, int maxType) {
        BrowserInputCompat.flush(minType, maxType);
    }

    /** Every event this source produces belongs to the page's one window. */
    public static long SDL_GetWindowFromEvent(SDL_Event event) {
        return BrowserWindowCompat.CANVAS_WINDOW;
    }
}
