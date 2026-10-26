import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

/**
 * LockStress with the garbage collector in the middle: a ReentrantLock in the
 * old generation, taken by threads whose Thread objects are young (new
 * threads, and ForkJoinPool workers that retire after 1 s idle and are
 * replaced), each allocating enough while it holds the lock to run young
 * collections. The lock's owner field is then an old-to-young reference
 * that only the card mark of its store keeps current; if a collection moves
 * the Thread without fixing that field, unlock() throws
 * IllegalMonitorStateException.
 *
 *   java -XX:+UseSerialGC -Xmn8m LockGcStress [threads] [seconds]
 */
public class LockGcStress {
    static final ReentrantLock LOCK = new ReentrantLock();
    static final AtomicInteger violations = new AtomicInteger();
    static final AtomicInteger rounds = new AtomicInteger();
    static volatile String first;
    static volatile boolean stop;
    static volatile Object sink;
    static final int SCALE = Integer.getInteger("scale", 1);
    // Rounds per fresh thread: the JIT compiles per thread, so a fresh
    // thread runs compiled lock code only once its own methods are hot.
    static final int PER_THREAD = Integer.getInteger("perThread", 20);

    static void violation(String what) {
        if (violations.getAndIncrement() == 0) {
            first = what + " on " + Thread.currentThread().getName();
        }
    }

    static void round(int kb) {
        LOCK.lock();
        try {
            // Allocate while holding the lock: young collections happen here.
            List<byte[]> garbage = new ArrayList<>();
            for (int i = 0; i < kb * SCALE; i++) garbage.add(new byte[1024]);
            sink = garbage;
            if (!LOCK.isHeldByCurrentThread()) violation("not held by current thread after allocating");
        } finally {
            try {
                LOCK.unlock();
            } catch (IllegalMonitorStateException e) {
                violation("IllegalMonitorStateException from unlock()");
            }
        }
        rounds.incrementAndGet();
    }

    public static void main(String[] args) throws Exception {
        int threads = args.length > 0 ? Integer.parseInt(args[0]) : 4;
        int seconds = args.length > 1 ? Integer.parseInt(args[1]) : 30;
        // The lock (and its Sync) into the old generation first.
        for (int i = 0; i < 3; i++) System.gc();
        // Workers retire after 1 s idle, so new young Thread objects keep coming.
        ForkJoinPool pool = new ForkJoinPool(threads, ForkJoinPool.defaultForkJoinWorkerThreadFactory,
                null, true, 0, threads * 2, 1, p -> true, 1, TimeUnit.SECONDS);
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        int burst = 0;
        while (System.nanoTime() < end && violations.get() == 0) {
            // A burst of fresh plain threads, and a burst of pool tasks.
            List<Thread> fresh = new ArrayList<>();
            for (int t = 0; t < threads; t++) {
                final int kb = 64 + 97 * t;
                Thread th = new Thread(() -> { for (int i = 0; i < PER_THREAD; i++) round(i % 50 == 0 ? kb : 2); }, "fresh-" + burst + "-" + t);
                fresh.add(th);
                th.start();
            }
            for (int t = 0; t < threads; t++) {
                final int kb = 32 + 61 * t;
                pool.execute(() -> { for (int i = 0; i < PER_THREAD; i++) round(i % 50 == 0 ? kb : 2); });
            }
            for (int i = 0; i < 20; i++) round(16);
            for (Thread th : fresh) th.join();
            // Let some pool workers time out so new ones are created.
            if (++burst % 4 == 0) Thread.sleep(1500);
        }
        stop = true;
        pool.shutdown();
        pool.awaitTermination(60, TimeUnit.SECONDS);
        System.out.println((violations.get() == 0 ? "PASS" : "FAIL " + first)
                + " violations=" + violations.get() + " rounds=" + rounds.get() + " bursts=" + burst);
    }
}
