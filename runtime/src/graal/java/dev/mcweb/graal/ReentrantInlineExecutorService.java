package dev.mcweb.graal;

import java.util.ArrayDeque;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;

/** Same-thread executor that defers only a task already running on this thread. */
public final class ReentrantInlineExecutorService extends AbstractExecutorService {
    public static final ReentrantInlineExecutorService INSTANCE = new ReentrantInlineExecutorService();
    private final ThreadLocal<State> current = new ThreadLocal<>();

    private static final class State {
        final IdentityHashMap<Runnable, Boolean> running = new IdentityHashMap<>();
        final ArrayDeque<Runnable> pending = new ArrayDeque<>();

        void run(Runnable task) {
            if (running.containsKey(task)) {
                pending.addLast(task);
                return;
            }
            running.put(task, Boolean.TRUE);
            try {
                task.run();
            } finally {
                running.remove(task);
            }
        }
    }

    private ReentrantInlineExecutorService() {}

    @Override
    public void execute(Runnable task) {
        Objects.requireNonNull(task, "task");
        State state = current.get();
        if (state != null) {
            state.run(task);
            return;
        }
        state = new State();
        current.set(state);
        Throwable failure = null;
        try {
            state.pending.addLast(task);
            while (!state.pending.isEmpty()) {
                try {
                    state.run(state.pending.removeFirst());
                } catch (RuntimeException | Error thrown) {
                    if (failure == null) failure = thrown;
                    else if (failure != thrown) failure.addSuppressed(thrown);
                }
            }
        } finally {
            current.remove();
        }
        if (failure instanceof RuntimeException thrown) throw thrown;
        if (failure instanceof Error thrown) throw thrown;
    }

    @Override public void shutdown() {}
    @Override public List<Runnable> shutdownNow() { return Collections.emptyList(); }
    @Override public boolean isShutdown() { return false; }
    @Override public boolean isTerminated() { return false; }
    @Override public boolean awaitTermination(long timeout, TimeUnit unit) { return true; }
}
