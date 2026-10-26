package dev.mcweb.graal.webgpu;

/**
 * Headless stand-in for the port's JS bridge, for benchmarks that run
 * Mojang's code with the port's shadows but no browser (McVertexBench). Only
 * what those paths reach; anything else fails loudly with NoSuchMethodError.
 * Placed ahead of mcweb-port.jar on the classpath by prof/mc-bench.sh.
 */
public final class BrowserGpu {
    private BrowserGpu() {}

    public static void reportProgress(String stage) {}
}
