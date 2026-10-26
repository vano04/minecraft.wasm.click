/** Rough interpreter throughput: integer/FP work, allocation, and string ops. */
public class Bench {
    public static void main(String[] args) {
        long t0 = System.nanoTime();
        long acc = 0;
        for (int i = 0; i < 20_000_000; i++) acc += (i * 31) ^ (i >>> 3);
        long t1 = System.nanoTime();
        double f = 0;
        for (int i = 1; i < 5_000_000; i++) f += Math.sqrt(i) / i;
        long t2 = System.nanoTime();
        int n = 0;
        for (int i = 0; i < 500_000; i++) n += new int[16].length;
        long t3 = System.nanoTime();
        System.out.printf("int   %6.0f ms%n", (t1 - t0) / 1e6);
        System.out.printf("fp    %6.0f ms%n", (t2 - t1) / 1e6);
        System.out.printf("alloc %6.0f ms%n", (t3 - t2) / 1e6);
        System.out.printf("total %6.0f ms  (checksum %d %f %d)%n", (t3 - t0) / 1e6, acc, f, n);
    }
}
