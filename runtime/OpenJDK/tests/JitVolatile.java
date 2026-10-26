import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Volatile fields compiled as wasm atomics (NO_VOLATILE to disable): every
 * width the JIT takes (int, reference, byte, boolean, short, char), sign
 * extension of the narrow ones, the java.util.concurrent shapes that made
 * compiled code hand back on every call (AtomicReference.get,
 * CompletableFuture.getNow), and a two-thread handoff whose correctness
 * depends on the volatile write publishing the plain writes before it.
 *
 * Lines starting with "volatile" must be identical with and without the JIT.
 */
public class JitVolatile {
    static final class Box {
        volatile int i;
        volatile Object ref;
        volatile byte b;
        volatile boolean z;
        volatile short s;
        volatile char c;
        int plain;
    }

    static long churn(Box x, int r) {
        x.i = r * 7;
        x.b = (byte) (r * 37);           // negative values half the time
        x.z = (r & 1) == 0;
        x.s = (short) (r * 1009);        // negative values half the time
        x.c = (char) (r * 31);
        x.ref = (r % 3 == 0) ? null : x;
        long v = x.i + x.b + (x.z ? 1 : 0) + x.s + x.c + (x.ref == null ? -5 : 5);
        return v;
    }

    static int atomics(AtomicReference<String> ar, AtomicInteger ai, int r) {
        String prev = ar.get();
        ar.set((r & 7) == 0 ? "x" + r : prev);
        return ai.incrementAndGet() + (ar.get() == null ? 0 : ar.get().length());
    }

    static long futures(CompletableFuture<Integer> done, CompletableFuture<Integer> pending, int r) {
        return done.getNow(-1) + pending.getNow(r);
    }

    // Writer publishes `plain` then the volatile `i`; the reader, seeing `i`,
    // must see `plain` too.
    static volatile boolean stop;
    static int handoff(int rounds) throws InterruptedException {
        Box shared = new Box();
        int[] bad = new int[1];
        Thread reader = new Thread(() -> {
            int last = 0;
            while (!stop) {
                int seen = shared.i;
                if (seen != last) {
                    if (shared.plain < seen) bad[0]++;
                    last = seen;
                }
            }
        });
        reader.start();
        for (int r = 1; r <= rounds; r++) {
            shared.plain = r;
            shared.i = r;
        }
        stop = true;
        reader.join();
        return bad[0];
    }

    public static void main(String[] args) throws Exception {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 40000;
        Box x = new Box();
        long a = 0;
        for (int r = 0; r < rounds; r++) a = a * 31 + churn(x, r);
        System.out.println("volatile widths " + a + " b=" + x.b + " s=" + x.s + " c=" + (int) x.c);

        AtomicReference<String> ar = new AtomicReference<>("start");
        AtomicInteger ai = new AtomicInteger();
        long b = 0;
        for (int r = 0; r < rounds; r++) b += atomics(ar, ai, r);
        System.out.println("volatile atomics " + b + " " + ar.get() + " " + ai.get());

        CompletableFuture<Integer> done = CompletableFuture.completedFuture(11);
        CompletableFuture<Integer> pending = new CompletableFuture<>();
        long c = 0;
        for (int r = 0; r < rounds; r++) c += futures(done, pending, r);
        pending.complete(5);
        c += futures(done, pending, 0);
        System.out.println("volatile futures " + c);

        System.out.println("volatile handoff bad=" + handoff(rounds * 5));
    }
}
