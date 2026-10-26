package dev.mcweb.graal;

import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Same-thread executor: every submitted task runs inline on the caller.
 * {@link AgentExecutorService} falls back to it when no pool thread can take a
 * task, and the redirected executor factories use it before the pool exists.
 */
public final class InlineExecutorService extends AbstractExecutorService {
    public static final InlineExecutorService INSTANCE = new InlineExecutorService();

    private static int taskCount;

    private InlineExecutorService() {
    }

    @Override
    public void execute(Runnable command) {
        Objects.requireNonNull(command, "command");
        // A sparse progress breadcrumb: proves a long inline run is advancing
        // without flooding the console.
        if ((++taskCount & 0x3FF) == 1) {
            try {
                dev.mcweb.graal.webgpu.BrowserGpu.reportProgress(
                        "inline-task#" + taskCount + ":" + command.getClass().getSimpleName());
            } catch (Throwable ignored) {
                // Telemetry must never break the boot.
            }
        }
        command.run();
    }

    @Override
    public void shutdown() {
        // No workers to stop.
    }

    @Override
    public List<Runnable> shutdownNow() {
        return Collections.emptyList();
    }

    @Override
    public boolean isShutdown() {
        return false;
    }

    @Override
    public boolean isTerminated() {
        return false;
    }

    @Override
    public boolean awaitTermination(long timeout, TimeUnit unit) {
        return true;
    }
}
