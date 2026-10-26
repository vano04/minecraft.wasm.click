import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeUnit;

/**
 * A task running on a ForkJoinPool worker submits the next one from inside
 * the pool, then its worker goes idle -- the way Minecraft's
 * ConsecutiveExecutor re-registers itself. Measures how long each follow-up
 * waits to start (microseconds). Runs chains on a pool whose other workers
 * are parked, with gaps so they are asleep.
 */
public class PoolChain {
    public static void main(String[] args) throws Exception {
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 200;
        ForkJoinPool pool = new ForkJoinPool(5, ForkJoinPool.defaultForkJoinWorkerThreadFactory, null, true,
                5, 6, 1, p -> true, 60L, TimeUnit.SECONDS);
        long[] lat = new long[n];
        for (int i = 0; i < n; i++) {
            final int k = i;
            CountDownLatch done = new CountDownLatch(1);
            pool.execute(() -> {
                final long t = System.nanoTime();
                pool.execute(() -> { lat[k] = (System.nanoTime() - t) / 1000; done.countDown(); });
                // The submitting worker stays busy a while, so the follow-up
                // must be picked up by another (parked) worker or wait.
                long spin = System.nanoTime() + 20_000_000L;
                while (System.nanoTime() < spin) { Thread.onSpinWait(); }
            });
            done.await();
            Thread.sleep(20);
        }
        long[] s = lat.clone(); Arrays.sort(s);
        System.out.println("chain latency us: p50=" + s[n / 2] + " p90=" + s[n * 9 / 10] + " p99=" + s[n * 99 / 100] + " max=" + s[n - 1]);
        pool.shutdown();
    }
}
