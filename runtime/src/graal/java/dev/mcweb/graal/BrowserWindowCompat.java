package dev.mcweb.graal;

/**
 * The single browser window: its handle, and how a canvas resize reaches
 * Minecraft.
 *
 * <p>26.3 runs Mojang's own {@code com.mojang.blaze3d.platform.Window} on the
 * port's SDL shims. That class learns about size changes only from SDL window
 * events in {@code Window.handleEvent}, so a resize is delivered the way SDL
 * would deliver it: queued as {@code SDL_EVENT_WINDOW_RESIZED} followed by
 * {@code SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED}, which Mojang's handlers turn
 * into new GUI scale and render targets.</p>
 */
public final class BrowserWindowCompat {
    /**
     * The handle of the one window the page has. {@code SDL_GetWindowFromEvent}
     * returns it for every queued event, and Minecraft drops input whose
     * window handle differs from {@code Window.handle()}, so the GPU backend's
     * {@code createWindow} has to return this same value.
     */
    public static final long CANVAS_WINDOW = 1L;

    private static volatile int lastWidth;
    private static volatile int lastHeight;

    private BrowserWindowCompat() {
    }

    /**
     * The redirect target for {@code FramerateLimiter.limitDisplayFPS} in
     * {@code Minecraft.renderFrame}. {@link BrowserFramePump} paces the frame
     * loop itself (VSync at the display rate the page measured, Max
     * Framerate), between frames rather than inside one.
     */
    public static void limitDisplayFPS(int framerateLimit) {
    }

    /**
     * Reports a new canvas backing-store size. The host has already resized the
     * canvas and reconfigured the WebGPU surface. Host coordinates are
     * backing-store pixels and the pixel density is 1, so the window size and
     * its size in pixels are the same numbers.
     */
    public static void dispatchResize(final int width, final int height) {
        if (width <= 0 || height <= 0) {
            return;
        }
        if (width == lastWidth && height == lastHeight) {
            return;
        }
        lastWidth = width;
        lastHeight = height;
        BrowserInputCompat.enqueueResize(width, height);
        dev.mcweb.graal.webgpu.BrowserGpu.reportProgress("window:resize:" + width + "x" + height);
    }
}
