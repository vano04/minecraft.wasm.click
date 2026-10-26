package org.lwjgl.sdl;

/** Browser SDL: opening links. */
public final class SDLMisc {
    private SDLMisc() {
    }

    /**
     * Opening a tab needs a page call this runtime does not have yet, so the
     * link is reported instead and Minecraft logs the failure.
     */
    public static boolean SDL_OpenURL(CharSequence url) {
        dev.mcweb.graal.webgpu.BrowserGpu.reportProgress("sdl:open-url " + url);
        return SDLError.fail("opening links is not available in the browser runtime");
    }
}
