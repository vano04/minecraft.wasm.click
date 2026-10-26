import java.util.concurrent.*;

/**
 * Rendezvous stress, sized to catch a missed wakeup rather than a slow one.
 *
 * The browser run stalled inside managedBlock waiting on background workers
 * while single-threaded benchmarks stayed correct, which is the signature of a
 * publish/observe pair that stopped being observed -- exactly what an optimiser
 * that hoists a plain load out of a spin loop produces. This exercises the same
 * primitives (pool handoff, barrier, park/unpark, timed wait) in seconds.
 */
public final class ThreadStress {
    public static void main(String[] args) throws Exception {
        int threads = args.length > 0 ? Integer.parseInt(args[0]) : 8;
        int rounds = args.length > 1 ? Integer.parseInt(args[1]) : 200;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        long checksum = 0;
        long t0 = System.nanoTime();
        for (int round = 0; round < rounds; round++) {
            CyclicBarrier gate = new CyclicBarrier(threads);
            @SuppressWarnings("unchecked")
            Future<Long>[] work = new Future[threads];
            for (int t = 0; t < threads; t++) {
                final int id = t;
                work[t] = pool.submit(() -> {
                    gate.await(20, TimeUnit.SECONDS);   // every worker must be seen
                    long acc = 0;
                    for (int i = 0; i < 20_000; i++) acc += (i * 31L) ^ (id + i);
                    return acc;
                });
            }
            for (Future<Long> f : work) checksum += f.get(30, TimeUnit.SECONDS);
            if (round % 50 == 0) {
                System.out.println("round " + round + " ok  (" 
                        + (System.nanoTime() - t0) / 1_000_000L + " ms)");
            }
        }
        pool.shutdown();
        if (!pool.awaitTermination(30, TimeUnit.SECONDS)) throw new IllegalStateException("pool stuck");
        System.out.println("ALL " + rounds + " ROUNDS OK in "
                + (System.nanoTime() - t0) / 1_000_000L + " ms, checksum " + checksum);
    }
}
