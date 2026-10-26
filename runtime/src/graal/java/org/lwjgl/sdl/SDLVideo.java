package org.lwjgl.sdl;

import dev.mcweb.graal.webgpu.BrowserGpu;
import java.nio.IntBuffer;
import org.lwjgl.PointerBuffer;
import org.lwjgl.system.MemoryUtil;
import org.lwjgl.system.Pointer;

/**
 * Browser SDL: the one display and the one window, both the canvas.
 *
 * <p>Sizes are the canvas backing store, which is also what host input
 * coordinates are measured in, so the pixel density is 1 and a window's size
 * equals its size in pixels. The window does not move; fullscreen belongs to
 * the browser, which only grants it from a user gesture.</p>
 */
public final class SDLVideo {
    private static final long SDL_WINDOW_RESIZABLE = 32L;
    private static final long SDL_WINDOW_INPUT_FOCUS = 512L;
    private static final long SDL_WINDOW_MOUSE_FOCUS = 1024L;

    /** SDL display ids are non-zero. */
    private static final int DISPLAY = 1;
    /** Browser callback cadence measured by the launcher, not a physical display capability. */
    private static final float REFRESH_RATE = displayRefreshRate();

    private static float displayRefreshRate() {
        try {
            double measured = Double.parseDouble(System.getProperty("mcweb.displayHz", "60"));
            if (Double.isFinite(measured) && measured >= 20 && measured <= 500) return (float) measured;
        } catch (NumberFormatException unavailable) { /* Keep the safe launcher fallback. */ }
        return 60.0F;
    }

    /** SDL owns the modes it returns from the desktop/current queries; they are refreshed per call. */
    private static SDL_DisplayMode desktopMode;

    private SDLVideo() {
    }

    // ---- displays ---------------------------------------------------------

    public static IntBuffer SDL_GetDisplays() {
        IntBuffer displays = MemoryUtil.memAllocInt(1);
        displays.put(0, DISPLAY);
        return displays;
    }

    public static int SDL_GetPrimaryDisplay() {
        return DISPLAY;
    }

    public static int SDL_GetDisplayForWindow(long window) {
        return DISPLAY;
    }

    public static String SDL_GetDisplayName(int displayID) {
        return "Browser Canvas";
    }

    public static boolean SDL_GetDisplayBounds(int displayID, SDL_Rect rect) {
        rect.set(0, 0, canvasWidth(), canvasHeight());
        return true;
    }

    public static synchronized SDL_DisplayMode SDL_GetDesktopDisplayMode(int displayID) {
        if (desktopMode == null) {
            desktopMode = SDL_DisplayMode.calloc();
        }
        return describeCanvas(desktopMode);
    }

    public static SDL_DisplayMode SDL_GetCurrentDisplayMode(int displayID) {
        return SDL_GetDesktopDisplayMode(displayID);
    }

    /**
     * One mode, the canvas. Laid out as SDL lays it out: a null-terminated
     * pointer array followed by the modes, all in one block that the caller
     * releases with {@code SDL_free}.
     */
    public static PointerBuffer SDL_GetFullscreenDisplayModes(int displayID) {
        long pointers = 2L * Pointer.POINTER_SIZE;
        long block = MemoryUtil.nmemCallocChecked(1, pointers + SDL_DisplayMode.SIZEOF);
        describeCanvas(SDL_DisplayMode.create(block + pointers));
        MemoryUtil.memPutAddress(block, block + pointers);
        return MemoryUtil.memPointerBuffer(block, 1);
    }

    public static boolean SDL_GetClosestFullscreenDisplayMode(
            int displayID, int w, int h, float refreshRate, boolean includeHighDensityModes, SDL_DisplayMode closest) {
        describeCanvas(closest);
        return true;
    }

    private static SDL_DisplayMode describeCanvas(SDL_DisplayMode mode) {
        return mode.set(DISPLAY, SDLPixels.SDL_PIXELFORMAT_XRGB8888, canvasWidth(), canvasHeight(),
                1.0F, REFRESH_RATE, Math.round(REFRESH_RATE * 1000.0F), 1000);
    }

    public static String SDL_GetCurrentVideoDriver() {
        return "browser";
    }

    // ---- the window -------------------------------------------------------

    public static long SDL_GetWindowFlags(long window) {
        return SDL_WINDOW_RESIZABLE | SDL_WINDOW_INPUT_FOCUS | SDL_WINDOW_MOUSE_FOCUS;
    }

    public static boolean SDL_GetWindowSizeInPixels(long window, IntBuffer w, IntBuffer h) {
        if (w != null) {
            w.put(w.position(), canvasWidth());
        }
        if (h != null) {
            h.put(h.position(), canvasHeight());
        }
        return true;
    }

    public static float SDL_GetWindowPixelDensity(long window) {
        return 1.0F;
    }

    public static boolean SDL_GetWindowPosition(long window, IntBuffer x, IntBuffer y) {
        if (x != null) {
            x.put(x.position(), 0);
        }
        if (y != null) {
            y.put(y.position(), 0);
        }
        return true;
    }

    /** Only the page lays out the canvas; a requested size or position is accepted and ignored. */
    public static boolean SDL_SetWindowPosition(long window, int x, int y) {
        return true;
    }

    public static boolean SDL_SetWindowSize(long window, int w, int h) {
        return true;
    }

    public static boolean SDL_SetWindowMinimumSize(long window, int minW, int minH) {
        return true;
    }

    public static boolean SDL_SetWindowMaximumSize(long window, int maxW, int maxH) {
        return true;
    }

    /**
     * Leaving fullscreen always succeeds; entering it is refused, so
     * Minecraft resets its fullscreen option instead of believing a canvas
     * that never changed size went fullscreen.
     */
    public static boolean SDL_SetWindowFullscreen(long window, boolean fullscreen) {
        return !fullscreen || SDLError.fail("fullscreen is controlled by the browser");
    }

    /** Never in exclusive fullscreen: SDL reports that as no fullscreen mode. */
    public static SDL_DisplayMode SDL_GetWindowFullscreenMode(long window) {
        return null;
    }

    public static boolean SDL_SetWindowFullscreenMode(long window, SDL_DisplayMode mode) {
        return true;
    }

    public static boolean SDL_SetWindowBordered(long window, boolean bordered) {
        return true;
    }

    public static boolean SDL_SetWindowTitle(long window, CharSequence title) {
        return true;
    }

    public static boolean SDL_SetWindowIcon(long window, SDL_Surface icon) {
        return true;
    }

    /** Confining the pointer is what pointer lock already does while the game has the mouse. */
    public static boolean SDL_SetWindowMouseGrab(long window, boolean grabbed) {
        return true;
    }

    public static boolean SDL_RestoreWindow(long window) {
        return true;
    }

    public static boolean SDL_SyncWindow(long window) {
        return true;
    }

    public static void SDL_DestroyWindow(long window) {
    }

    private static int canvasWidth() {
        return Math.max(1, BrowserGpu.canvasWidth());
    }

    private static int canvasHeight() {
        return Math.max(1, BrowserGpu.canvasHeight());
    }
}
