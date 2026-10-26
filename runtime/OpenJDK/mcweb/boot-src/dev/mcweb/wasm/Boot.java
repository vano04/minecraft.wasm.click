package dev.mcweb.wasm;

import java.lang.reflect.Method;

/**
 * Entry point for running the MC-Web browser port on the wasm OpenJDK runtime.
 *
 * The port's browser seams are {@code @JS}-annotated native methods, which on
 * this runtime are backed by a generated JNI/EM_JS bridge. That bridge has to be
 * loaded before any seam class initialises, so it happens here, ahead of
 * Mojang's entry point.
 */
public final class Boot {
    private Boot() {
    }

    public static void main(String[] args) throws Exception {
        // Install before loading the bridge or the player's main class. This
        // blocks JNA's ELF extraction path while leaving Emscripten's generic
        // Wasm side-module loading available to the JVM itself.
        dev.mcweb.graal.BrowserNativePolicy.install();
        String lib = System.getProperty("mcweb.bridge", "libmcwebjs.so");
        System.load(lib);


        // While diagnosing boot stalls: a daemon thread reports the main
        // thread's stack every 30 s so a wedge is visible from the page log.
        if (System.getProperty("mcweb.stackbeat") != null) {
            Thread main = Thread.currentThread();
            Thread beat = new Thread(() -> {
                while (true) {
                    try { Thread.sleep(30000); } catch (InterruptedException e) { return; }
                    StringBuilder sb = new StringBuilder("[stackbeat] ");
                    for (StackTraceElement el : main.getStackTrace()) {
                        sb.append(el.getClassName()).append('.').append(el.getMethodName())
                          .append(':').append(el.getLineNumber()).append(" <- ");
                    }
                    System.out.println(sb);
                }
            }, "mcweb-stackbeat");
            beat.setDaemon(true);
            beat.start();
        }
        String main = System.getProperty("mcweb.main", "net.minecraft.client.main.Main");
        Method entry = Class.forName(main).getMethod("main", String[].class);
        entry.invoke(null, (Object) args);

        // The browser client is event-driven after construction: the frame
        // pump fires from the Worker's event loop. main() returning would let
        // Emscripten's EXIT_RUNTIME tear the process down, so park this
        // (Java main) thread forever when asked.
        if (System.getProperty("mcweb.keepalive") != null) {
            Thread.currentThread().join();
        }
    }
}
