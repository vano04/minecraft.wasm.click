package dev.mcweb.graal;

import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.function.Consumer;
import org.graalvm.webimage.api.JS;
import org.lwjgl.sdl.SDLEvents;
import org.lwjgl.sdl.SDLKeycode;
import org.lwjgl.sdl.SDLTimer;
import org.lwjgl.sdl.SDL_Event;
import org.lwjgl.sdl.SDL_TextEditingEvent;
import org.lwjgl.sdl.SDL_TextInputEvent;
import org.lwjgl.system.MemoryUtil;

/**
 * The browser's SDL event source and input state.
 *
 * <p>Minecraft 26.3 pulls input: {@code SDLEventHandler.pollEvents} loops
 * {@code SDL_PollEvent} and translates each {@code SDL_Event} itself. The
 * port's {@code org.lwjgl.sdl} shims answer those calls from here. Host input
 * (already in SDL numbering, see webgpu-host.js) is queued as SDL events, and
 * {@link #poll} writes one into Mojang's own {@code SDL_Event}, so the
 * key/mouse/text translation that follows is Mojang's code, unchanged.</p>
 *
 * <p>The keyboard state, modifier state and pointer position that SDL
 * exposes through {@code SDL_GetKeyboardState}, {@code SDL_GetModState} and
 * {@code SDL_GetMouseState} are updated when an event is queued, as SDL
 * updates them when it pumps, not when the game polls.</p>
 */
public final class BrowserInputCompat {
    /** SDL_SCANCODE_COUNT: the size of SDL's keyboard state array. */
    private static final int SCANCODE_COUNT = 512;
    private static final int MAX_QUEUED = 4096;

    private record HostEvent(int type, Consumer<SDL_Event> fields) {
    }

    private static final ArrayDeque<HostEvent> queue = new ArrayDeque<>();
    private static final ByteBuffer keyboardState = ByteBuffer.allocateDirect(SCANCODE_COUNT);
    /** Keycodes the host reported for unmodified presses, by scancode; 0 = none yet. */
    private static final int[] learnedKeycodes = new int[SCANCODE_COUNT];
    private static volatile int modState;
    private static volatile float mouseX;
    private static volatile float mouseY;
    private static volatile int buttonMask;
    private static volatile boolean relativeMouseMode;
    private static volatile boolean textInputActive;
    /** UTF-8 text of the last polled TEXT_INPUT or TEXT_EDITING event; SDL keeps it valid until the next poll. */
    private static ByteBuffer polledText;
    /** Bounds a composition the host spells out one code point at a time. */
    private static final int MAX_PREEDIT_CHARS = 256;
    private static final StringBuilder preedit = new StringBuilder();
    private static boolean preeditOpen;
    private static long queued;
    private static long polled;
    // Opt-in, bounded Space investigation; never changes input state. An enqueue
    // is not consumption: poll-edge reports the SDL event handed to the caller,
    // poll-empty samples SDL_GetKeyboardState after the queue was drained. Neither
    // proves Minecraft's jump binding or flight state.
    private static final boolean INPUT_HOLD_DIAG = Boolean.getBoolean("mcweb.inputHoldDiag");
    private static final int INPUT_HOLD_LIMIT = 128;
    private static int inputHoldReports;
    private static long inputHoldStarted;
    private static long inputHoldSampled;
    private static long inputHoldPollSequence;

    private BrowserInputCompat() {
    }

    // ---- host side: events in SDL terms ---------------------------------------

    public static void enqueueKey(int scancode, int keycode, boolean down, int mods, boolean repeat) {
        if (scancode <= 0 || scancode >= SCANCODE_COUNT) {
            return;
        }
        int key = keycode != 0 ? keycode : keyFromScancode(scancode);
        if (keycode != 0 && down && learnedKeycodes[scancode] != keycode) {
            // The page's layout differs from what the key labels were drawn
            // with (US until the key is first pressed). SDL announces a layout
            // change so the Controls screen relabels.
            boolean relabel = learnedKeycodes[scancode] != 0 || keycode != defaultKeycode(scancode);
            learnedKeycodes[scancode] = keycode;
            if (relabel) {
                enqueue(SDLEvents.SDL_EVENT_KEYMAP_CHANGED, event -> {
                });
            }
        }
        keyboardState.put(scancode, (byte) (down ? 1 : 0));
        modState = mods;
        enqueue(down ? SDLEvents.SDL_EVENT_KEY_DOWN : SDLEvents.SDL_EVENT_KEY_UP, event -> event.key()
                .scancode(scancode)
                .key(key)
                .mod((short) mods)
                .down(down)
                .repeat(repeat));
        if (INPUT_HOLD_DIAG && scancode == 44) {
            traceInputHold("enqueue", down ? 1 : 0);
        }
    }

    /**
     * Typed text. As in SDL, it becomes an event only while a text field has
     * asked for text input ({@code SDL_StartTextInput}); otherwise typing a
     * movement key in game would also arrive as text.
     */
    public static void enqueueText(int codepoint) {
        if (!textInputActive || !Character.isValidCodePoint(codepoint)) {
            return;
        }
        String text = Character.toString(codepoint);
        enqueue(SDLEvents.SDL_EVENT_TEXT_INPUT, event -> MemoryUtil.memPutAddress(
                event.text().address() + SDL_TextInputEvent.TEXT, polledText(text)));
    }

    /**
     * An IME composition the page's text field is showing, sent by the host as
     * {@code textPreeditBegin}, one {@code textPreeditChar} per code point and
     * {@code textPreeditEnd cursor selection}; the end queues one
     * {@code SDL_EVENT_TEXT_EDITING}, which Mojang's handler turns into its
     * preedit overlay. Empty text clears the composition, as in SDL. The
     * committed text arrives separately as {@code charInput}.
     */
    public static void beginPreedit() {
        preedit.setLength(0);
        preeditOpen = true;
    }

    public static void appendPreedit(int codepoint) {
        if (preeditOpen && Character.isValidCodePoint(codepoint) && preedit.length() < MAX_PREEDIT_CHARS) {
            preedit.appendCodePoint(codepoint);
        }
    }

    /** {@code cursor} and {@code selection} count code points, as SDL's start/length do. */
    public static void endPreedit(int cursor, int selection) {
        if (!preeditOpen) {
            return;
        }
        preeditOpen = false;
        if (!textInputActive) {
            return;
        }
        String text = preedit.toString();
        enqueue(SDLEvents.SDL_EVENT_TEXT_EDITING, event -> {
            MemoryUtil.memPutAddress(event.edit().address() + SDL_TextEditingEvent.TEXT, polledText(text));
            event.edit().start(cursor).length(selection);
        });
    }

    /** The UTF-8 copy a text-bearing event points at, valid until the next one is polled. */
    private static long polledText(String text) {
        if (polledText != null) {
            MemoryUtil.memFree(polledText);
        }
        polledText = MemoryUtil.memUTF8(text);
        return MemoryUtil.memAddress(polledText);
    }

    public static void enqueueMotion(float x, float y, float dx, float dy) {
        mouseX = x;
        mouseY = y;
        int mask = buttonMask;
        enqueue(SDLEvents.SDL_EVENT_MOUSE_MOTION, event -> event.motion()
                .state(mask)
                .x(x)
                .y(y)
                .xrel(dx)
                .yrel(dy));
    }

    /** {@code button} is SDL's: 1 left, 2 middle, 3 right, 4 and 5 the side buttons. */
    public static void enqueueButton(int button, boolean down, int mods) {
        if (button < 1 || button > 32) {
            return;
        }
        buttonMask = down ? buttonMask | (1 << (button - 1)) : buttonMask & ~(1 << (button - 1));
        modState = mods;
        float x = mouseX;
        float y = mouseY;
        enqueue(down ? SDLEvents.SDL_EVENT_MOUSE_BUTTON_DOWN : SDLEvents.SDL_EVENT_MOUSE_BUTTON_UP,
                event -> event.button()
                        .button((byte) button)
                        .down(down)
                        .clicks((byte) 1)
                        .x(x)
                        .y(y));
    }

    public static void enqueueWheel(float x, float y) {
        float px = mouseX;
        float py = mouseY;
        enqueue(SDLEvents.SDL_EVENT_MOUSE_WHEEL, event -> event.wheel()
                .x(x)
                .y(y)
                .mouse_x(px)
                .mouse_y(py));
    }

    /** SDL reports a resize as the window size, then its size in pixels. */
    static void enqueueResize(int width, int height) {
        enqueue(SDLEvents.SDL_EVENT_WINDOW_RESIZED, event -> event.window().data1(width).data2(height));
        enqueue(SDLEvents.SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED,
                event -> event.window().data1(width).data2(height));
    }

    private static synchronized void enqueue(int type, Consumer<SDL_Event> fields) {
        if (queue.size() >= MAX_QUEUED) {
            // A game that stopped polling must not grow the heap without bound;
            // SDL's own queue is capped the same way.
            queue.pollFirst();
        }
        queue.addLast(new HostEvent(type, fields));
        queued++;
    }

    // ---- game side: what the SDL shims call -----------------------------------

    /** {@code SDL_PollEvent}: writes the oldest queued event into {@code event}. */
    public static synchronized boolean poll(SDL_Event event) {
        if (INPUT_HOLD_DIAG) {
            inputHoldPollSequence++;
        }
        HostEvent next = queue.pollFirst();
        if (next == null) {
            if (INPUT_HOLD_DIAG && inputHoldStarted != 0 && inputHoldReports < INPUT_HOLD_LIMIT
                    && System.nanoTime() - inputHoldSampled >= 100_000_000L) {
                traceInputHold("poll-empty", -1);
            }
            return false;
        }
        polled++;
        MemoryUtil.memSet(event.address(), 0, SDL_Event.SIZEOF);
        event.type(next.type());
        event.common().timestamp(SDLTimer.SDL_GetTicksNS());
        next.fields().accept(event);
        if (INPUT_HOLD_DIAG
                && (next.type() == SDLEvents.SDL_EVENT_KEY_DOWN || next.type() == SDLEvents.SDL_EVENT_KEY_UP)
                && event.key().scancode() == 44) {
            traceInputHold("poll-edge", next.type() == SDLEvents.SDL_EVENT_KEY_DOWN ? 1 : 0);
        }
        return true;
    }

    /** {@code SDL_FlushEvents}: drops queued events whose type is in {@code [min, max]}. */
    public static synchronized void flush(int min, int max) {
        for (Iterator<HostEvent> it = queue.iterator(); it.hasNext(); ) {
            int type = it.next().type();
            if (type >= min && type <= max) {
                it.remove();
            }
        }
    }

    public static ByteBuffer keyboardState() {
        return keyboardState;
    }

    public static int modState() {
        return modState;
    }

    public static float mouseX() {
        return mouseX;
    }

    public static float mouseY() {
        return mouseY;
    }

    public static int buttonMask() {
        return buttonMask;
    }

    /**
     * {@code SDL_WarpMouseInWindow}. Minecraft warps to the window centre
     * around every grab and release; the host does the same to its synthetic
     * pointer in {@link #setCursorDisabled}.
     */
    public static void warpMouse(float x, float y) {
        mouseX = x;
        mouseY = y;
    }

    /** {@code SDL_SetWindowRelativeMouseMode}: the browser's pointer lock. */
    public static void setRelativeMouseMode(boolean enabled) {
        if (relativeMouseMode != enabled) {
            relativeMouseMode = enabled;
            setCursorDisabled(enabled ? 1 : 0);
        }
    }

    public static void setTextInputActive(boolean active) {
        textInputActive = active;
    }

    /**
     * {@code SDL_GetKeyFromScancode}: the unshifted key the page's layout puts
     * on this scancode, once the host has reported it, else the US layout
     * SDL falls back to.
     */
    public static int keyFromScancode(int scancode) {
        if (scancode <= 0 || scancode >= SCANCODE_COUNT) {
            return 0;
        }
        int learned = learnedKeycodes[scancode];
        return learned != 0 ? learned : defaultKeycode(scancode);
    }

    /** SDL's US keymap: printable keys are their character, the rest scancode | SDLK_SCANCODE_MASK. */
    private static int defaultKeycode(int scancode) {
        if (scancode >= 4 && scancode <= 29) {
            return 'a' + scancode - 4;
        }
        if (scancode >= 30 && scancode <= 38) {
            return '1' + scancode - 30;
        }
        return switch (scancode) {
            case 39 -> '0';
            case 40 -> '\r';
            case 41 -> 0x1B;
            case 42 -> '\b';
            case 43 -> '\t';
            case 44 -> ' ';
            case 45 -> '-';
            case 46 -> '=';
            case 47 -> '[';
            case 48 -> ']';
            case 49 -> '\\';
            case 51 -> ';';
            case 52 -> '\'';
            case 53 -> '`';
            case 54 -> ',';
            case 55 -> '.';
            case 56 -> '/';
            case 76 -> 0x7F;
            default -> scancode | SDLKeycode.SDLK_SCANCODE_MASK;
        };
    }

    /** Queue and input-state summary for the frame pump's diagnostics. */
    public static synchronized String describe() {
        return "queued=" + queued
                + " polled=" + polled
                + " pending=" + queue.size()
                + " mods=" + modState
                + " buttons=" + buttonMask
                + " relative=" + relativeMouseMode
                + " text=" + textInputActive;
    }

    private static void traceInputHold(String stage, int edgeDown) {
        if (inputHoldReports >= INPUT_HOLD_LIMIT) {
            return;
        }
        long now = System.nanoTime();
        if (inputHoldStarted == 0) {
            inputHoldStarted = now;
        }
        inputHoldSampled = now;
        dev.mcweb.graal.webgpu.BrowserGpu.reportProgress("evt:input-hold: n=" + (++inputHoldReports)
                + " elapsedUs=" + (now - inputHoldStarted) / 1000
                + " stage=" + stage
                + " pollSeq=" + inputHoldPollSequence
                + " edgeDown=" + edgeDown
                + " sdlSpace=" + keyboardState.get(44)
                + " queued=" + queued + " polled=" + polled + " pending=" + queue.size());
    }

    /**
     * Applies relative mouse mode to the browser canvas. Pointer lock
     * still requires a user gesture, so the host arms it for the next click.
     */
    @JS.Coerce
    @JS(value = """
            const input = globalThis.mcWebInput;
            if (!input) return;
            input.lockPointerOnNextClick = disabled !== 0;
            if (disabled !== 0) {
              const canvas = document.querySelector('canvas');
              if (canvas) {
                input.syntheticX = canvas.width / 2;
                input.syntheticY = canvas.height / 2;
              }
            } else if (document.pointerLockElement && document.exitPointerLock) {
              document.exitPointerLock();
            }
            """, args = {"disabled"})
    public static native void setCursorDisabled(int disabled);
}
