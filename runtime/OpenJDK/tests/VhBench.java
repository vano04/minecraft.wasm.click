import java.util.concurrent.atomic.AtomicReferenceArray;
import java.util.concurrent.atomic.AtomicLong;
public class VhBench {
    public static void main(String[] args) {
        int n = 2_000_000;
        AtomicReferenceArray<Object> ara = new AtomicReferenceArray<>(64);
        Object[] plain = new Object[64];
        for (int i = 0; i < 64; i++) { Object o = (i % 3 == 0) ? null : Integer.valueOf(i); ara.set(i, o); plain[i] = o; }
        AtomicLong al = new AtomicLong();
        for (int round = 0; round < 6; round++) {
            long t0 = System.nanoTime(); int acc = 0;
            for (int i = 0; i < n; i++) if (ara.get(i & 63) != null) acc++;
            long t1 = System.nanoTime();
            for (int i = 0; i < n; i++) if (plain[i & 63] != null) acc++;
            long t2 = System.nanoTime();
            for (int i = 0; i < n; i++) acc += (int) al.get();
            long t3 = System.nanoTime();
            for (int i = 0; i < n; i++) al.incrementAndGet();
            long t4 = System.nanoTime();
            System.out.printf("round %d: ARA.get %.1f ns  array %.1f ns  AtomicLong.get %.1f ns  incrementAndGet %.1f ns (%d)%n", round,
                (t1 - t0) / (double) n, (t2 - t1) / (double) n, (t3 - t2) / (double) n, (t4 - t3) / (double) n, acc);
        }
    }
}
