package com.mojang.text2speech;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * MC-Web's own stand-in for the narrator API Minecraft's {@code GameNarrator}
 * calls. Mojang's text2speech library is only published on
 * libraries.minecraft.net, which a web page cannot read (no CORS headers), and
 * its implementations drive native speech engines a browser does not have.
 * This keeps the API and answers with a narrator that is never active.
 */
public interface Narrator {
    Logger LOGGER = LoggerFactory.getLogger("Narrator");

    Narrator EMPTY = new Narrator() {
        @Override public void say(String message, boolean interrupt, float volume) { }
        @Override public void clear() { }
        @Override public boolean active() { return false; }
        @Override public void destroy() { }
    };

    void say(String message, boolean interrupt, float volume);

    void clear();

    default boolean active() {
        return true;
    }

    void destroy();

    static Narrator getNarrator() {
        return EMPTY;
    }
}
