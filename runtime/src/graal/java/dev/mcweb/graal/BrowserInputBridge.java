package dev.mcweb.graal;


/**
 * Converts the browser host's single callable input boundary into SDL events
 * queued in BrowserInputCompat, where Minecraft's SDL_PollEvent loop picks
 * them up.
 *
 * <p>The host already speaks SDL's numbering (webgpu-host.js). Each message is
 * a name and four numbers:</p>
 * <ul>
 *   <li>{@code key}: scancode, keycode (0 = the unshifted key for the
 *       scancode), down, SDL_KMOD bits with bit 16 set for a repeat;</li>
 *   <li>{@code charInput}: one Unicode code point;</li>
 *   <li>{@code textPreeditBegin}, {@code textPreeditChar} (one code point
 *       each) and {@code textPreeditEnd} (cursor, selection length, in code
 *       points): the IME composition the page's text field shows;</li>
 *   <li>{@code cursorPos}: x, y, and the relative motion SDL reports as
 *       xrel/yrel, which is what Minecraft reads while the mouse is grabbed;</li>
 *   <li>{@code mouseButton}: SDL button (1 left, 2 middle, 3 right), down,
 *       SDL_KMOD bits;</li>
 *   <li>{@code scroll}: SDL wheel x (positive right), y (positive away);</li>
 *   <li>{@code resize}: canvas width and height.</li>
 * </ul>
 */
public final class BrowserInputBridge {
    /** Bounded trace of the first events, to prove the pull path end to end. */
    private static int reported;
    private BrowserInputBridge() {
    }

    public static BrowserInputDispatcher dispatcher() {
        return BrowserInputBridge::dispatch;
    }

    /**
     * Pulls the events the host queued since the last frame.
     *
     * <p>The OpenJDK lane cannot be pushed into: the JVM's main thread is the
     * Worker thread and never returns to an event loop, so a registered
     * callback would never be called (and could not cross the RPC as a function
     * in the first place). The host queues instead, and the frame loop asks.
     * Returns the number of events dispatched.</p>
     *
     * <p>No-op on Web Image, where the host pushes and {@code drain} does not
     * exist.</p>
     */
    public static int drainHostEvents() {
        String batch;
        try {
            batch = dev.mcweb.graal.webgpu.BrowserGpu.drainInputEvents();
        } catch (Throwable unavailable) {
            return 0;
        }
        if (batch == null || batch.isEmpty()) {
            return 0;
        }
        int dispatched = 0;
        for (String line : batch.split("\n")) {
            String[] parts = line.split(" ");
            if (parts.length < 5) {
                continue;
            }
            if ("vsync".equals(parts[0])) {
                try {
                    BrowserFramePump.noteVsync(Double.parseDouble(parts[1]), Double.parseDouble(parts[2]));
                } catch (NumberFormatException malformed) {
                    // A torn line: the next refresh brings another.
                }
                continue;
            }
            try {
                if (reported < 12) {
                    reported++;
                    dev.mcweb.graal.webgpu.BrowserGpu.reportProgress("input-drained: " + line);
                }
                dispatch(parts[0], parseCoordinate(parts[1]), parseCoordinate(parts[2]),
                        parseCoordinate(parts[3]), parseCoordinate(parts[4]));
                dispatched++;
            } catch (Throwable malformed) {
                // dispatch() already reports; a bad line must not stop the rest.
            }
        }
        return dispatched;
    }

    /** Host numbers arrive as JavaScript strings, including "undefined". */
    private static double parseCoordinate(String text) {
        try {
            return Double.parseDouble(text);
        } catch (NumberFormatException notANumber) {
            return 0.0;
        }
    }

    /**
     * Input is dispatched from a DOM event, not from inside the frame pump, so
     * a throw here unwinds into JavaScript and disappears: the screen simply
     * does not change and nothing is logged. That is what a "dead button" in
     * this port has always been. Name it instead.
     */
    private static void dispatch(
            String name,
            double first,
            double second,
            double third,
            double fourth
    ) {
        try {
            dispatchOrReport(name, first, second, third, fourth);
        } catch (Throwable failure) {
            // Throwable, not Exception: the usual culprits are LinkageError and
            // NoClassDefFoundError from a class the image never initialised.
            dev.mcweb.graal.webgpu.BrowserGpu.reportJavaFailure(
                    "input:" + name,
                    failure.getClass().getName(),
                    failure.getMessage() == null ? "" : failure.getMessage()
            );
        }
    }

    private static void dispatchOrReport(
            String name,
            double first,
            double second,
            double third,
            double fourth
    ) {
        // Every branch below except "resize" is a person touching the game;
        // Minecraft's inactivity throttle has to hear about it or it clamps the
        // frame rate to 30 (then 10) while they are still playing.
        if (!"resize".equals(name)) {
            BrowserFramePump.noteInput();
        }
        switch (name) {
            case "key" -> {
                int packed = (int) fourth;
                BrowserInputCompat.enqueueKey((int) first, (int) second, third != 0,
                        packed & 0xFFFF, (packed & 0x10000) != 0);
            }
            case "charInput" -> BrowserInputCompat.enqueueText((int) first);
            case "textPreeditBegin" -> BrowserInputCompat.beginPreedit();
            case "textPreeditChar" -> BrowserInputCompat.appendPreedit((int) first);
            case "textPreeditEnd" -> BrowserInputCompat.endPreedit((int) first, (int) second);
            case "cursorPos" -> BrowserInputCompat.enqueueMotion(
                    (float) first, (float) second, (float) third, (float) fourth);
            case "mouseButton" -> BrowserInputCompat.enqueueButton((int) first, second != 0, (int) third);
            case "scroll" -> BrowserInputCompat.enqueueWheel((float) first, (float) second);
            case "resize" -> BrowserWindowCompat.dispatchResize((int) first, (int) second);
            default -> {
                // A name the switch does not know is silent otherwise, and
                // silence here is indistinguishable from input that never
                // reached the game.
                if (reported < 20) {
                    reported++;
                    dev.mcweb.graal.webgpu.BrowserGpu.reportProgress(
                            "input-unhandled:[" + name + "] len=" + name.length());
                }
            }
        }
    }
}
