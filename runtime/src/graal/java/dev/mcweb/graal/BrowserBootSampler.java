package dev.mcweb.graal;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

/**
 * Where boot spends its time, from {@code new Minecraft} to the title screen.
 *
 * <p>There is no native profiler in the tab, and 26.3 takes ~41 s from the
 * "Loading Minecraft" screen to the title against 26.2's ~23 s with every
 * pipeline built in the first 1.5 s. {@code -Dmcweb.bootSampler=true} (the
 * page's {@code ?bootSampler=1}) starts a daemon thread that every ~100 ms
 * reads every live thread's state and, for a RUNNABLE one, its stack. Each
 * stack counts towards three tables for its thread-name group (digits folded,
 * so {@code Worker-Main-3} is {@code Worker-Main-#}):
 * <ul>
 * <li>{@code game}: the deepest {@code net.minecraft} or {@code com.mojang}
 *     frame, the method the game is in;</li>
 * <li>{@code owner}: the outermost frame in a reload-listener package
 *     ({@code client.resources}, {@code client.renderer}, {@code server.packs}
 *     ...) that is not one of the generic drivers in {@link #OWNER_SKIP}, the
 *     listener or task the work belongs to;</li>
 * <li>{@code leaf}: the topmost frame, which is where a thread that is
 *     RUNNABLE but really waiting (a native bridge call, a futex in JS)
 *     shows.</li>
 * </ul>
 * The time between samples also goes to the group's state split (RUNNABLE,
 * WAITING, TIMED_WAITING, BLOCKED) as thread-seconds.
 *
 * <p>The frame pump owns the screen check: it marks each screen change and
 * stops the sampler on the TitleScreen, then hands every {@code bootsample:}
 * line to {@link BrowserGpu#reportProgress} from the client thread, since a
 * report from any other thread does not reach the page. The sampler also
 * stops by itself after {@code -Dmcweb.bootSampler.limitMs} (180 s).
 *
 * <p>Stacks are walked one thread at a time, and only for RUNNABLE threads:
 * {@code Thread.getAllStackTraces} can wedge on this runtime, and so can a
 * stack walk of a thread parked in a futex. The sampler sleeps between
 * samples; the gap it actually got is weighed and reported ({@code gap=}),
 * because timed waits here have been late before. Nothing runs, and no
 * thread exists, unless the flag is set; nothing it throws reaches a caller.
 *
 * <p>The sampler knows no game types, so a synthetic workload drives it alone
 * on the desktop JDK and on the wasm JVM under node (docs/DEVELOPMENT.md).
 */
public final class BrowserBootSampler {

    public static final boolean ENABLED = Boolean.getBoolean("mcweb.bootSampler");
    private static final long INTERVAL_MS = Math.max(5L, Long.getLong("mcweb.bootSampler.ms", 100L));
    private static final long LIMIT_MS = Long.getLong("mcweb.bootSampler.limitMs", 180_000L);
    private static final int TOP = 15;
    /**
     * {@code -Dmcweb.sampleFocus=Class.method} (simple class name, as in the
     * tables): for stacks through that frame, a {@code focus} table of every
     * method above it, each counted once per stack, so its percentages are
     * inclusive shares of the focus method's time.
     */
    private static final String FOCUS = System.getProperty("mcweb.sampleFocus", "");
    private static final int FOCUS_TOP = 40;
    private static final int MAX_GROUPS = 12;
    /** Under the ~4 KB a console line may carry before a driver truncates it. */
    private static final int MAX_LINE = 3800;

    private static final String[] GAME = {"net.minecraft.", "com.mojang."};
    private static final String[] OWNER = {
        "net.minecraft.client.resources.", "net.minecraft.client.renderer.",
        "net.minecraft.client.sounds.", "net.minecraft.client.gui.",
        "net.minecraft.client.model.", "net.minecraft.client.particle.",
        "net.minecraft.client.color.", "net.minecraft.client.multiplayer.",
        "net.minecraft.server.packs.", "net.minecraft.resources.",
        "net.minecraft.world.", "net.minecraft.core.", "net.minecraft.tags.",
        "com.mojang.blaze3d.",
    };
    /** Classes that drive every listener's work and so own none of it. */
    private static final Set<String> OWNER_SKIP = new HashSet<>(Arrays.asList(
            "Minecraft", "GameRenderer", "LoadingOverlay", "SimpleReloadInstance",
            "ProfiledReloadInstance", "ReloadInstance", "ReloadableResourceManager",
            "PreparableReloadListener", "SimplePreparableReloadListener",
            "SimpleJsonResourceReloadListener", "ResourceManagerReloadListener"));
    /** The JDK's own threads: RUNNABLE in a native wait the whole time, no tables. */
    private static final Set<String> JDK_THREADS = new HashSet<>(Arrays.asList(
            "Reference Handler", "Signal Dispatcher", "Notification Thread", "Finalizer",
            "Common-Cleaner", "Attach Listener"));

    private static volatile BrowserBootSampler boot;

    /** The pump's hook, at the first phase it names: starts sampling if the flag is set. */
    public static void begin(String phase) {
        if (!ENABLED || boot != null) {
            return;
        }
        try {
            BrowserBootSampler sampler = new BrowserBootSampler(INTERVAL_MS, LIMIT_MS, GAME, OWNER, OWNER_SKIP);
            sampler.mark(phase);
            sampler.start();
            boot = sampler;
        } catch (Throwable unavailable) {
            // A sampler that cannot start must not take boot down with it.
        }
    }

    /**
     * The pump's per-frame hook: notes a screen change as a phase, stops on
     * the title screen ({@code title}, decided by the caller), and once
     * sampling has ended for either reason hands the report to {@code sink}.
     */
    public static void screen(String screenClass, boolean title, Consumer<String> sink) {
        BrowserBootSampler sampler = boot;
        if (sampler == null) {
            return;
        }
        try {
            sampler.mark(screenClass.substring(screenClass.lastIndexOf('.') + 1));
            if (title) {
                sampler.stop("title");
            }
            if (!sampler.isStopped()) {
                return;
            }
            boot = null;
            for (String line : sampler.report(TOP)) {
                sink.accept(line);
            }
        } catch (Throwable failure) {
            boot = null;
            try {
                sink.accept("bootsample: report-failed " + failure);
            } catch (Throwable ignored) {
                // Nothing left to tell it to.
            }
        }
    }

    private static volatile BrowserBootSampler world;

    /**
     * An in-world run ({@code ?clientProfile=N}, BrowserClientProfile):
     * samples every {@code intervalMillis} for {@code limitMillis}, whatever
     * the boot flag says. {@link #pollWorld} hands over the report.
     */
    public static void beginWorld(long intervalMillis, long limitMillis) {
        if (world != null) {
            return;
        }
        try {
            BrowserBootSampler sampler = new BrowserBootSampler(intervalMillis, limitMillis, GAME, OWNER, OWNER_SKIP);
            sampler.mark("world");
            sampler.start();
            world = sampler;
        } catch (Throwable unavailable) {
            // Nothing to report then.
        }
    }

    /** Once the in-world run has stopped, its report goes to {@code sink}; true then. */
    public static boolean pollWorld(Consumer<String> sink) {
        BrowserBootSampler sampler = world;
        if (sampler == null || !sampler.isStopped()) {
            return false;
        }
        world = null;
        try {
            for (String line : sampler.report(TOP)) {
                sink.accept(line);
            }
        } catch (Throwable failure) {
            sink.accept("bootsample: report-failed " + failure);
        }
        return true;
    }

    private static final class Group {
        int threads;
        long runnable;
        final long[] stateNanos = new long[Thread.State.values().length];
        final Map<String, int[]> game = new HashMap<>();
        final Map<String, int[]> owner = new HashMap<>();
        final Map<String, int[]> leaf = new HashMap<>();
        int focused;
        final Map<String, int[]> focus = new HashMap<>();
    }

    private final long intervalMillis;
    private final long limitNanos;
    private final String[] gamePrefixes;
    private final String[] ownerPrefixes;
    private final Set<String> ownerSkip;
    private final long startNanos = System.nanoTime();
    private final Map<String, Group> groups = new HashMap<>();
    private final List<String> phases = new ArrayList<>();
    private String lastPhase;
    private volatile Thread thread;
    private volatile boolean stopRequested;
    private volatile String stopReason;
    private volatile long stopNanos;
    private volatile String failure;
    private long ticks;
    private long stacks;
    private long samplingNanos;
    private long maxGapNanos;

    public BrowserBootSampler(long intervalMillis, long limitMillis, String[] gamePrefixes,
            String[] ownerPrefixes, Set<String> ownerSkip) {
        this.intervalMillis = intervalMillis;
        this.limitNanos = limitMillis * 1_000_000L;
        this.gamePrefixes = gamePrefixes;
        this.ownerPrefixes = ownerPrefixes;
        this.ownerSkip = ownerSkip;
    }

    public synchronized void start() {
        if (thread != null) {
            return;
        }
        thread = new Thread(this::run, "mcweb-boot-sampler");
        thread.setDaemon(true);
        thread.start();
    }

    /** A named point on the timeline (a repeat of the last one is ignored). */
    public synchronized void mark(String phase) {
        if (stopNanos == 0 && !phase.equals(lastPhase)) {
            lastPhase = phase;
            phases.add(phase + "@" + seconds(System.nanoTime() - startNanos));
        }
    }

    /** Ends sampling; the samples taken so far stay for {@link #report}. */
    public void stop(String reason) {
        if (stopNanos == 0) {
            stopNanos = System.nanoTime();
            stopReason = reason;
        }
        stopRequested = true;
        Thread sampler = thread;
        if (sampler != null && sampler != Thread.currentThread()) {
            sampler.interrupt();
        }
    }

    public boolean isStopped() {
        return stopRequested;
    }

    private void run() {
        long last = System.nanoTime();
        try {
            while (!stopRequested) {
                try {
                    Thread.sleep(intervalMillis);
                } catch (InterruptedException interrupted) {
                    break;
                }
                long now = System.nanoTime();
                if (now - startNanos > limitNanos) {
                    stop("limit");
                    break;
                }
                sample(now - last);
                last = now;
            }
        } catch (Throwable sampleFailure) {
            failure = String.valueOf(sampleFailure);
            stop("failed");
        }
    }

    private void sample(long gapNanos) {
        long begin = System.nanoTime();
        Thread self = Thread.currentThread();
        ThreadGroup root = self.getThreadGroup();
        while (root.getParent() != null) {
            root = root.getParent();
        }
        Thread[] all = new Thread[root.activeCount() + 32];
        int count = root.enumerate(all, true);
        Map<String, Integer> seen = new HashMap<>();
        for (int i = 0; i < count; i++) {
            Thread t = all[i];
            if (t == self) {
                continue;
            }
            Thread.State state = t.getState();
            if (state == Thread.State.NEW || state == Thread.State.TERMINATED) {
                continue;
            }
            String group = t.getName().replaceAll("\\d+", "#");
            String game = null;
            String owner = null;
            String leaf = null;
            Set<String> above = null;
            if (state == Thread.State.RUNNABLE) {
                StackTraceElement[] stack = t.getStackTrace();
                if (stack.length > 0) {
                    game = deepest(stack, gamePrefixes);
                    owner = owner(stack);
                    leaf = frame(stack[0]);
                    above = focusFrames(stack);
                }
            }
            synchronized (this) {
                Group g = groups.computeIfAbsent(group, k -> new Group());
                g.stateNanos[state.ordinal()] += gapNanos;
                seen.merge(group, 1, Integer::sum);
                if (leaf != null) {
                    stacks++;
                    g.runnable++;
                    count(g.game, game);
                    count(g.owner, owner);
                    count(g.leaf, leaf);
                    if (above != null) {
                        g.focused++;
                        for (String f : above) {
                            count(g.focus, f);
                        }
                    }
                }
            }
        }
        synchronized (this) {
            for (Map.Entry<String, Integer> e : seen.entrySet()) {
                Group g = groups.get(e.getKey());
                g.threads = Math.max(g.threads, e.getValue());
            }
            ticks++;
            maxGapNanos = Math.max(maxGapNanos, gapNanos);
            samplingNanos += System.nanoTime() - begin;
        }
    }

    /** The distinct frames above the outermost {@link #FOCUS} frame, or null without one. */
    private static Set<String> focusFrames(StackTraceElement[] stack) {
        if (FOCUS.isEmpty()) {
            return null;
        }
        for (int i = stack.length - 1; i >= 0; i--) {
            String full = stack[i].getClassName() + "." + stack[i].getMethodName();
            if (!full.endsWith("." + FOCUS) && !full.equals(FOCUS)) {
                continue;
            }
            Set<String> above = new HashSet<>();
            for (int j = 0; j < i; j++) {
                above.add(frame(stack[j]));
            }
            return above;
        }
        return null;
    }

    private static void count(Map<String, int[]> table, String key) {
        table.computeIfAbsent(key, k -> new int[1])[0]++;
    }

    private String deepest(StackTraceElement[] stack, String[] prefixes) {
        for (StackTraceElement element : stack) {
            if (matches(element.getClassName(), prefixes)) {
                return frame(element);
            }
        }
        return "(no game frame)";
    }

    private String owner(StackTraceElement[] stack) {
        for (int i = stack.length - 1; i >= 0; i--) {
            String cls = stack[i].getClassName();
            if (!matches(cls, ownerPrefixes) || cls.contains("$$Lambda")) {
                continue;
            }
            String simple = cls.substring(cls.lastIndexOf('.') + 1);
            int nested = simple.indexOf('$');
            if (!ownerSkip.contains(nested < 0 ? simple : simple.substring(0, nested))) {
                return frame(stack[i]);
            }
        }
        return "(no owner)";
    }

    private static boolean matches(String cls, String[] prefixes) {
        for (String prefix : prefixes) {
            if (cls.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    /** {@code n.m.c.r.t.TextureManager.method}: packages to initials, hidden-class ids dropped. */
    static String frame(StackTraceElement element) {
        String cls = element.getClassName();
        int hidden = cls.indexOf('/');
        if (hidden >= 0) {
            cls = cls.substring(0, hidden);
        }
        StringBuilder out = new StringBuilder(cls.length() + 24);
        int start = 0;
        for (int dot; (dot = cls.indexOf('.', start)) >= 0; start = dot + 1) {
            out.append(cls.charAt(start)).append('.');
        }
        return out.append(cls, start, cls.length()).append('.').append(element.getMethodName()).toString();
    }

    private static String seconds(long nanos) {
        return String.format(Locale.ROOT, "%.1fs", nanos / 1e9);
    }

    private static String percent(long part, long whole) {
        return whole <= 0 ? "0%" : String.format(Locale.ROOT, "%.1f%%", 100.0 * part / whole);
    }

    /**
     * The {@code bootsample:} lines, each under ~4 KB: the window, then the
     * state split of every thread group, then the three tables for the
     * groups with the most RUNNABLE samples.
     */
    public synchronized List<String> report(int top) {
        List<String> out = new ArrayList<>();
        long end = stopNanos != 0 ? stopNanos : System.nanoTime();
        out.add("bootsample: window=" + seconds(end - startNanos)
                + " stop=" + stopReason + (failure != null ? " failure=" + failure : "")
                + " ticks=" + ticks + " every=" + intervalMillis + "ms"
                + " gap=" + (ticks == 0 ? 0 : (end - startNanos) / ticks / 1_000_000L) + "ms"
                + " maxGap=" + maxGapNanos / 1_000_000L + "ms"
                + " stacks=" + stacks
                + " sampling=" + seconds(samplingNanos) + "(" + percent(samplingNanos, end - startNanos) + ")"
                + " phases=" + String.join(",", phases));

        List<Map.Entry<String, Group>> byRunnable = new ArrayList<>(groups.entrySet());
        byRunnable.sort((a, b) -> Long.compare(
                b.getValue().stateNanos[Thread.State.RUNNABLE.ordinal()],
                a.getValue().stateNanos[Thread.State.RUNNABLE.ordinal()]));
        List<String> states = new ArrayList<>();
        for (Map.Entry<String, Group> e : byRunnable) {
            long[] ns = e.getValue().stateNanos;
            long total = 0;
            for (long n : ns) {
                total += n;
            }
            StringBuilder line = new StringBuilder(e.getKey()).append(" x").append(e.getValue().threads);
            for (Thread.State state : new Thread.State[] {Thread.State.RUNNABLE, Thread.State.BLOCKED,
                    Thread.State.WAITING, Thread.State.TIMED_WAITING}) {
                long n = ns[state.ordinal()];
                if (n > 0) {
                    line.append(' ').append(abbreviate(state)).append('=').append(seconds(n))
                            .append('(').append(percent(n, total)).append(')');
                }
            }
            states.add(line.toString());
        }
        emit(out, "bootsample: states (thread-seconds; run includes native waits)", states);

        byRunnable.sort((a, b) -> Long.compare(b.getValue().runnable, a.getValue().runnable));
        int shown = 0;
        for (Map.Entry<String, Group> e : byRunnable) {
            Group g = e.getValue();
            if (g.runnable == 0 || shown >= MAX_GROUPS) {
                break;
            }
            if (JDK_THREADS.contains(e.getKey())) {
                continue;
            }
            shown++;
            String head = "[" + e.getKey() + "] n=" + g.runnable;
            emit(out, "bootsample: game " + head, table(g.game, g.runnable, top));
            emit(out, "bootsample: owner " + head, table(g.owner, g.runnable, top));
            emit(out, "bootsample: leaf " + head, table(g.leaf, g.runnable, top));
            if (g.focused > 0) {
                emit(out, "bootsample: focus " + FOCUS + " [" + e.getKey() + "] n=" + g.focused
                        + " (" + percent(g.focused, g.runnable) + " of run)", table(g.focus, g.focused, FOCUS_TOP));
            }
        }
        out.add("bootsample: end lines=" + (out.size() + 1));
        return out;
    }

    private static String abbreviate(Thread.State state) {
        return switch (state) {
            case RUNNABLE -> "run";
            case BLOCKED -> "blocked";
            case WAITING -> "wait";
            case TIMED_WAITING -> "timed";
            default -> state.name().toLowerCase();
        };
    }

    private static List<String> table(Map<String, int[]> counts, long whole, int top) {
        List<Map.Entry<String, int[]>> sorted = new ArrayList<>(counts.entrySet());
        sorted.sort((a, b) -> b.getValue()[0] - a.getValue()[0]);
        List<String> rows = new ArrayList<>();
        for (int i = 0; i < Math.min(top, sorted.size()); i++) {
            int n = sorted.get(i).getValue()[0];
            rows.add(n + " " + percent(n, whole) + " " + sorted.get(i).getKey());
        }
        return rows;
    }

    /** {@code head | item | item ...}, wrapped into as many lines as stay under MAX_LINE. */
    private static void emit(List<String> out, String head, List<String> items) {
        StringBuilder line = new StringBuilder(head);
        for (String item : items) {
            if (item.length() > 600) {
                item = item.substring(0, 600) + "...";
            }
            if (line.length() + item.length() + 3 > MAX_LINE) {
                out.add(line.toString());
                line = new StringBuilder(head).append(" (cont)");
            }
            line.append(" | ").append(item);
        }
        out.add(line.toString());
    }
}
