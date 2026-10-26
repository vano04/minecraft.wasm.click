package dev.mcweb.graal;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcweb.graal.net.BrowserSocketPump;
import dev.mcweb.graal.webgpu.BrowserGpu;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;

/**
 * The browser's part of multiplayer around Mojang's own client.
 *
 * <p>Joining, the server list and its pings are Mojang's: ConnectScreen and
 * ServerStatusPinger run Connection.connect over
 * {@link dev.mcweb.graal.net.WebSocketChannel} to the app's gateway
 * (docs/NET-MIGRATION.md, stage 3). What is left here is what a page adds: the
 * per-frame socket pump, a join requested by the page
 * ({@code globalThis.__mcWebJoin(host, port)}), the launcher identity, and a
 * setting the in-memory options file cannot keep.</p>
 */
public final class BrowserMultiplayerCompat {
    private static Minecraft minecraft;
    private static long lastJoinPoll;

    private BrowserMultiplayerCompat() {
    }

    public static void install(Minecraft client) {
        minecraft = client;
        restoreSkipMultiplayerWarning(client);
    }

    /**
     * Re-applies "Do not show this screen again" from a previous visit.
     *
     * <p>Vanilla keeps this in {@code options.txt}, which here lives in an
     * in-memory filesystem that does not survive a reload - so the box was
     * ticked, saved, and forgotten every time. {@code localStorage} is the only
     * store on the page that outlives the tab, so the flag is mirrored there
     * and restored before the title screen can offer the warning.</p>
     */
    private static void restoreSkipMultiplayerWarning(Minecraft client) {
        try {
            if (client != null && client.options != null && readSkipWarning()) {
                client.options.skipMultiplayerWarning = true;
                BrowserGpu.reportProgress("multiplayer:warning-skip-restored");
            }
        } catch (Throwable ignored) {
            // A missing or blocked localStorage just means the screen shows.
        }
    }

    @org.graalvm.webimage.api.JS.Coerce
    @org.graalvm.webimage.api.JS(value =
            "try { return globalThis.localStorage?.getItem('mcweb.skipMultiplayerWarning') === '1'; }"
            + " catch (e) { return false; }", args = {})
    private static native boolean readSkipWarning();

    /** Once per frame from {@link BrowserFramePump}, on the client thread. */
    public static void pump() {
        if (minecraft == null) {
            return;
        }
        BrowserSocketPump.pump();
        // A page join is rare; four checks a second is prompt enough, and
        // each is a synchronous call to the page.
        long now = System.nanoTime();
        if (now - lastJoinPoll < 250_000_000L || minecraft.level != null) {
            return;
        }
        lastJoinPoll = now;
        String request = consumeJoin();
        if (request == null || request.isEmpty()) {
            return;
        }
        try {
            JsonObject join = JsonParser.parseString(request).getAsJsonObject();
            ServerAddress address = new ServerAddress(join.get("host").getAsString(), join.get("port").getAsInt());
            BrowserGpu.reportProgress("multiplayer:join " + address);
            ConnectScreen.startConnecting(new TitleScreen(), minecraft, address,
                    new ServerData("Joined from the page", address.toString(), ServerData.Type.OTHER),
                    false, null);
        } catch (Throwable failure) {
            BrowserGpu.reportJavaFailure("multiplayer-join", failure.getClass().getName(),
                    failure.getMessage() == null ? "" : failure.getMessage());
        }
    }

    @org.graalvm.webimage.api.JS.Coerce
    @org.graalvm.webimage.api.JS(value = "return globalThis.mcWebNet.consumeJoin();", args = {})
    private static native String consumeJoin();

    /** Authenticated profile metadata fetched from the app origin before boot. */
    @org.graalvm.webimage.api.JS.Coerce
    @org.graalvm.webimage.api.JS(value = "return globalThis.mcWebNet?.identity?.()?.name || '';", args = {})
    public static native String launcherProfileName();

    @org.graalvm.webimage.api.JS.Coerce
    @org.graalvm.webimage.api.JS(value = "return globalThis.mcWebNet?.identity?.()?.id || '';", args = {})
    public static native String launcherProfileId();
}
