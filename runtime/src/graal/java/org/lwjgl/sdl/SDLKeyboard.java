package org.lwjgl.sdl;

import dev.mcweb.graal.BrowserInputCompat;
import dev.mcweb.graal.BrowserTextInput;
import java.nio.ByteBuffer;
import java.util.Locale;

/** Browser SDL: keyboard state, key names and text input. */
public final class SDLKeyboard {
    private SDLKeyboard() {
    }

    public static ByteBuffer SDL_GetKeyboardState() {
        return BrowserInputCompat.keyboardState();
    }

    public static short SDL_GetModState() {
        return (short) BrowserInputCompat.modState();
    }

    /**
     * The unshifted key: Minecraft asks with no modifiers when it labels key
     * bindings, and the host reports unmodified keycodes for the same reason.
     */
    public static int SDL_GetKeyFromScancode(int scancode, short modstate, boolean keyEvent) {
        return BrowserInputCompat.keyFromScancode(scancode);
    }

    /**
     * The character a printable key types, upper-cased as SDL names it, or
     * empty. Minecraft only shows a key name that is one character and falls
     * back to its own translations otherwise, so SDL's names for the other
     * keys ("Return", "Left Shift", ...) would never be displayed.
     */
    public static String SDL_GetKeyName(int key) {
        if (key <= ' ' || key == 0x7F || (key & SDLKeycode.SDLK_SCANCODE_MASK) != 0
                || !Character.isValidCodePoint(key)) {
            return "";
        }
        return Character.toString(key).toUpperCase(Locale.ROOT);
    }

    /**
     * A text field wants typing. Besides gating SDL text events, the page is
     * told ({@link BrowserTextInput}): on a touch screen its native keyboard is
     * the only way to type, and it may only open it inside the tap on the field.
     */
    public static boolean SDL_StartTextInput(long window) {
        BrowserInputCompat.setTextInputActive(true);
        BrowserTextInput.started();
        return true;
    }

    public static boolean SDL_StopTextInput(long window) {
        BrowserInputCompat.setTextInputActive(false);
        BrowserTextInput.stopped();
        return true;
    }

    /**
     * Where the caret is, in window coordinates, which are canvas pixels here
     * ({@code SDL_GetWindowPixelDensity} is 1). The page keeps it above its
     * on-screen keyboard.
     */
    public static boolean SDL_SetTextInputArea(long window, SDL_Rect.Buffer rect, int cursor) {
        if (rect == null) {
            BrowserTextInput.clearArea();
        } else {
            BrowserTextInput.area(rect.x(), rect.y(), rect.w(), rect.h());
        }
        return true;
    }

    public static boolean SDL_ClearComposition(long window) {
        return true;
    }
}
