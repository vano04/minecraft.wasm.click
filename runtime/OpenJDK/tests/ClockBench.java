// What the JVM's clocks cost from compiled code: System.nanoTime and
// currentTimeMillis against an empty static call. Minecraft calls them
// (Util.getNanos/getMillis) all over its frame and tick code.
public class ClockBench {
    static long sink;

    static long nothing(long x) {
        return x + 1;
    }

    public static void main(String[] args) {
        int n = 1_000_000;
        for (int round = 0; round < 6; round++) {
            long acc = 0;
            long t0 = System.nanoTime();
            for (int i = 0; i < n; i++) acc += System.nanoTime();
            long t1 = System.nanoTime();
            for (int i = 0; i < n; i++) acc += System.currentTimeMillis();
            long t2 = System.nanoTime();
            for (int i = 0; i < n; i++) acc = nothing(acc);
            long t3 = System.nanoTime();
            sink += acc;
            System.out.printf("round %d: nanoTime %.1f ns  currentTimeMillis %.1f ns  static call %.1f ns%n", round,
                (t1 - t0) / (double) n, (t2 - t1) / (double) n, (t3 - t2) / (double) n);
        }
    }
}
