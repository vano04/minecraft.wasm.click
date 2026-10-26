import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

/**
 * ReentrantLock under contention, alone: the client's section compile tasks
 * died with an IllegalMonitorStateException from unlock() after a plain
 * lock(); try { ... } finally { unlock(); } on one shared lock, which a correct
 * JVM never throws. Plain threads and ForkJoinPool workers (the client's
 * compile pool) take one lock in turns; inside it each checks that it is alone
 * and that the lock names it as owner.
 *
 *   java LockStress [threads] [poolTasks] [seconds]
 *
 * Prints PASS or FAIL with the first violation, and the totals.
 */
public class LockStress {
    static final ReentrantLock LOCK = new ReentrantLock();
    static int inside;             // guarded by LOCK: never above 1
    static long counter;           // guarded by LOCK: increments must not be lost
    static final AtomicInteger violations = new AtomicInteger();
    static volatile String first;
    static volatile boolean stop;

    static void violation(String what) {
        if (violations.getAndIncrement() == 0) {
            first = what + " on " + Thread.currentThread().getName();
        }
    }

    static long round(int spin) {
        long done = 0;
        LOCK.lock();
        try {
            if (++inside != 1) violation("two holders: inside=" + inside);
            if (!LOCK.isHeldByCurrentThread()) violation("lock() returned but not held by current thread");
            counter++;
            done++;
            for (int i = 0; i < spin; i++) Thread.onSpinWait();
            inside--;
        } finally {
            try {
                LOCK.unlock();
            } catch (IllegalMonitorStateException e) {
                violation("IllegalMonitorStateException from unlock()");
            }
        }
        return done;
    }

    public static void main(String[] args) throws Exception {
        int threads = args.length > 0 ? Integer.parseInt(args[0]) : 4;
        int poolTasks = args.length > 1 ? Integer.parseInt(args[1]) : 4;
        int seconds = args.length > 2 ? Integer.parseInt(args[2]) : 20;
        AtomicInteger rounds = new AtomicInteger();
        Thread[] ts = new Thread[threads];
        for (int t = 0; t < threads; t++) {
            final int spin = t * 7;
            ts[t] = new Thread(() -> {
                while (!stop) { round(spin); rounds.incrementAndGet(); }
            }, "plain-" + t);
            ts[t].start();
        }
        ForkJoinPool pool = new ForkJoinPool(Math.max(1, poolTasks));
        for (int t = 0; t < poolTasks; t++) {
            final int spin = 3 + t * 5;
            pool.execute(() -> {
                while (!stop) { round(spin); rounds.incrementAndGet(); }
            });
        }
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (System.nanoTime() < end && violations.get() == 0) {
            round(1);
            rounds.incrementAndGet();
            Thread.sleep(1);
        }
        stop = true;
        for (Thread t : ts) t.join();
        pool.shutdown();
        pool.awaitTermination(30, TimeUnit.SECONDS);
        boolean lost = counter != rounds.get();
        if (lost) violation("lost increments: counter=" + counter + " rounds=" + rounds.get());
        System.out.println((violations.get() == 0 ? "PASS" : "FAIL " + first)
                + " violations=" + violations.get() + " rounds=" + rounds.get() + " counter=" + counter);
    }
}
