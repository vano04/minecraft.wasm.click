import java.lang.reflect.Field;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Warm the real JDK empty-queue offer path, then repeatedly wake its parked
 * consumer. The executor case adds the actual DelegatedExecutorService ->
 * ThreadPoolExecutor -> LinkedBlockingQueue path from the server crash. No
 * replacement queue, lock or executor implementation is used. Every item/task
 * must be consumed exactly once and in order. This is a targeted stress probe,
 * not a deterministic reproduction claim for an intermittent JVM race.
 */
public class QueueSignalStress {
    static volatile int consumed;
    static volatile Throwable failure;
    static volatile Thread worker;
    static long checksum;

    static void checkDeadline(long deadline, String phase) {
        if (failure != null) throw new AssertionError("Worker failed during " + phase, failure);
        if (System.nanoTime() >= deadline) throw new AssertionError("Finite deadline in " + phase);
    }

    static void awaitConsumed(int expected, long deadline) throws InterruptedException {
        while (consumed != expected) {
            checkDeadline(deadline, "consumer progression expected=" + expected + " actual=" + consumed);
            if (consumed > expected) throw new AssertionError("Consumer skipped sequence " + expected);
            Thread.sleep(0, 100000);
        }
    }

    static void awaitParked(long deadline) throws InterruptedException {
        while (worker == null || worker.getState() != Thread.State.WAITING) {
            checkDeadline(deadline, "real queue consumer parking");
            if (worker != null && !worker.isAlive()) throw new AssertionError("Consumer terminated before handoff");
            Thread.sleep(0, 100000);
        }
    }

    static void consume(int value) {
        int expected = consumed + 1;
        if (value != expected) throw new AssertionError("Out-of-order/duplicate task: expected=" + expected + " actual=" + value);
        checksum += value;
        consumed = value;
    }

    static Field field(Class<?> owner, String name) throws Exception {
        Field field = owner.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    static String lockState(LinkedBlockingQueue<?> queue) {
        try {
            ReentrantLock lock = (ReentrantLock) field(LinkedBlockingQueue.class, "takeLock").get(queue);
            Object sync = field(ReentrantLock.class, "sync").get(lock);
            Class<?> aqs = Class.forName("java.util.concurrent.locks.AbstractQueuedSynchronizer");
            Class<?> aos = Class.forName("java.util.concurrent.locks.AbstractOwnableSynchronizer");
            Thread owner = (Thread) field(aos, "exclusiveOwnerThread").get(sync);
            return "actualQueueTakeLock state=" + field(aqs, "state").getInt(sync)
                    + " owner=" + (owner == null ? "null" : owner.getName())
                    + " current=" + Thread.currentThread().getName() + " queued=" + lock.getQueueLength()
                    + " observation=after-fault-not-atomic";
        } catch (Throwable unavailable) {
            return "actualQueueTakeLock unavailable=" + unavailable.getClass().getName()
                    + "; add --add-opens=java.base/java.util.concurrent=ALL-UNNAMED"
                    + " --add-opens=java.base/java.util.concurrent.locks=ALL-UNNAMED";
        }
    }

    public static void main(String[] args) throws Exception {
        String mode = args.length > 0 ? args[0] : "queue";
        int rounds = args.length > 1 ? Integer.parseInt(args[1]) : 8000;
        int seconds = args.length > 2 ? Integer.parseInt(args[2]) : 90;
        if (!(mode.equals("queue") || mode.equals("executor")) || rounds < 4000 || rounds > 100000
                || seconds < 1 || seconds > 300)
            throw new IllegalArgumentException("queue|executor rounds=4000..100000 seconds=1..300");
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        LinkedBlockingQueue<Integer> queue = new LinkedBlockingQueue<>();
        // Same submitting JavaThread sees many uncontended signalNotEmpty calls
        // before the first wait/transfer makes previously cold release paths run.
        for (int n = 0; n < 30000; n++) {
            if (!queue.offer(n) || queue.poll() != n) throw new AssertionError("Warm queue lost an item");
        }
        ExecutorService executor = null;
        LinkedBlockingQueue<Runnable> workQueue = null;
        Throwable primaryFailure = null;
        try {
            if (mode.equals("queue")) {
                worker = new Thread(() -> {
                    try {
                        for (int n = 1; n <= rounds; n++) consume(queue.take());
                    } catch (Throwable caught) { failure = caught; }
                }, "queue-signal-consumer");
                worker.setDaemon(true);
                worker.start();
            } else {
                workQueue = new LinkedBlockingQueue<>();
                ThreadPoolExecutor pool = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, workQueue, runnable -> {
                    Thread thread = new Thread(runnable, "queue-signal-serial-lane");
                    thread.setDaemon(true);
                    thread.setUncaughtExceptionHandler((ignored, caught) -> { failure = caught; });
                    worker = thread;
                    return thread;
                });
                executor = Executors.unconfigurableExecutorService(pool);
                // Start the real worker, then require it to park before offers.
                executor.execute(() -> {});
            }
            for (int n = 1; n <= rounds; n++) {
                awaitConsumed(n - 1, deadline);
                awaitParked(deadline);
                if (executor == null) {
                    if (!queue.offer(n)) throw new AssertionError("Unbounded queue rejected an item");
                } else {
                    final int value = n;
                    executor.execute(() -> consume(value));
                }
                awaitConsumed(n, deadline);
            }
            if (failure != null) throw new AssertionError("Consumer failed", failure);
            long expectedChecksum = (long) rounds * (rounds + 1) / 2;
            if (consumed != rounds || checksum != expectedChecksum || !queue.isEmpty()
                    || workQueue != null && !workQueue.isEmpty())
                throw new AssertionError("Actual consumer accounting failed: consumed=" + consumed + " checksum=" + checksum);
        } catch (Throwable caught) {
            primaryFailure = caught;
            System.err.println(lockState(workQueue == null ? queue : workQueue));
            throw caught;
        } finally {
            try {
                if (executor != null) {
                    executor.shutdownNow();
                    if (!executor.awaitTermination(2, TimeUnit.SECONDS))
                        throw new AssertionError("Owned executor did not stop");
                } else if (worker != null) {
                    worker.interrupt();
                    worker.join(2000);
                    if (worker.isAlive()) throw new AssertionError("Owned consumer did not stop");
                }
            } catch (Throwable cleanupFailure) {
                if (primaryFailure != null) primaryFailure.addSuppressed(cleanupFailure);
                else throw cleanupFailure;
            }
        }
        if (failure != null) throw new AssertionError("Consumer failed during cleanup", failure);
        System.out.println("PASS queue-signal mode=" + mode + " consumed=" + consumed + " checksum=" + checksum
                + " parkedHandoffs=" + rounds + " pending=0");
    }
}
