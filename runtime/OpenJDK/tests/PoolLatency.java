import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * How long a task submitted to an idle ForkJoinPool waits before a worker
 * runs it: the wake-up path (LockSupport.unpark -> Parker -> pthread cond ->
 * futex) that Minecraft's worldgen executor depends on. Submits one task at a
 * time with gaps, so the workers are parked every time, and prints the
 * submit-to-start latency distribution in microseconds.
 */
public class PoolLatency {
    public static void main(String[] args) throws Exception {
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 200;
        int gapMs = args.length > 1 ? Integer.parseInt(args[1]) : 20;
        ForkJoinPool pool = new ForkJoinPool(5, ForkJoinPool.defaultForkJoinWorkerThreadFactory, null, true,
                5, 6, 1, p -> true, 60L, TimeUnit.SECONDS);
        long[] lat = new long[n];
        for (int i = 0; i < n; i++) {
            final int k = i;
            CountDownLatch done = new CountDownLatch(1);
            final long t = System.nanoTime();
            pool.execute(() -> { lat[k] = (System.nanoTime() - t) / 1000; done.countDown(); });
            done.await();
            Thread.sleep(gapMs);
        }
        long[] s = lat.clone(); Arrays.sort(s);
        System.out.println("pool latency us: p50=" + s[n / 2] + " p90=" + s[n * 9 / 10] + " p99=" + s[n * 99 / 100] + " max=" + s[n - 1]);
        pool.shutdown();
    }
}
