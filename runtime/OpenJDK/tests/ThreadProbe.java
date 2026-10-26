import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Does a second Java thread actually run on this JVM, and does a timed wait
 * ever return? The frame pump's watchdog thread printed nothing at all, which
 * is only worth chasing once these two primitives are known-good in isolation.
 */
public final class ThreadProbe {
    public static void main(String[] args) throws Exception {
        System.out.println("main thread: " + Thread.currentThread());

        CountDownLatch ran = new CountDownLatch(1);
        Thread worker = new Thread(() -> {
            System.out.println("worker: running");
            ran.countDown();
            long start = System.nanoTime();
            try {
                Thread.sleep(1000L);
            } catch (InterruptedException e) {
                System.out.println("worker: interrupted");
                return;
            }
            System.out.println("worker: slept " + (System.nanoTime() - start) / 1_000_000L + " ms");
        }, "probe-worker");
        worker.setDaemon(false);
        worker.start();
        System.out.println("main: start() returned, state=" + worker.getState());

        boolean started = ran.await(10, TimeUnit.SECONDS);
        System.out.println("main: worker ran within 10 s = " + started);

        // Main-thread timed wait, independently of the worker.
        long t0 = System.nanoTime();
        Thread.sleep(500L);
        System.out.println("main: slept " + (System.nanoTime() - t0) / 1_000_000L + " ms");

        // And a stack-trace handshake against a live thread.
        StackTraceElement[] trace = worker.getStackTrace();
        System.out.println("main: worker stack depth = " + trace.length);

        worker.join(10_000L);
        System.out.println("main: worker joined, state=" + worker.getState());
        System.out.println("PROBE-DONE");
    }
}
