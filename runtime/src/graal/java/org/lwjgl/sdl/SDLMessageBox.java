package org.lwjgl.sdl;

import java.nio.IntBuffer;

/**
 * Browser SDL: message boxes. A Worker cannot open a modal dialog, so the
 * text goes to the page log and the call fails, which Minecraft handles by
 * logging and carrying on.
 */
public final class SDLMessageBox {
    private SDLMessageBox() {
    }

    public static boolean SDL_ShowSimpleMessageBox(int flags, CharSequence title, CharSequence message, long window) {
        return report(String.valueOf(title), String.valueOf(message));
    }

    public static boolean SDL_ShowMessageBox(SDL_MessageBoxData data, IntBuffer buttonid) {
        return report(data.titleString(), data.messageString());
    }

    private static boolean report(String title, String message) {
        dev.mcweb.graal.webgpu.BrowserGpu.reportProgress("sdl:message-box " + title + ": " + message);
        return SDLError.fail("message boxes are not available in the browser runtime");
    }
}
