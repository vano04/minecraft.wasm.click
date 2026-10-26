package dev.mcweb.browser;

import java.nio.file.Path;
import net.minecraft.server.Bootstrap;

/** Browser bridge for the resource pack screen's Open Folder action. */
public final class BrowserPackFolder {
    private BrowserPackFolder() {}

    public static void openPath(Path path) {
        // This class only replaces PackSelectionScreen's one Open Folder call.
        // A DOM file picker still requires the next direct browser user gesture.
        // Minecraft redirects System.out through an INFO logger that may be disabled.
        Bootstrap.realStdoutPrintln("[MCWEB-OPEN-RESOURCEPACKS]");
    }
}
