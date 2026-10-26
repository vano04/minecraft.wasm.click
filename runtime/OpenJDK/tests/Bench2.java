/** Separate pure-Java float work from JNI-crossing work (Math.sqrt is a native
 *  method under Zero: there is no intrinsic without a JIT). */
public class Bench2 {
    public static void main(String[] args) {
        long t0 = System.nanoTime();
        double a = 0;
        for (int i = 1; i < 5_000_000; i++) a += (i * 1.0000001) / i;
        long t1 = System.nanoTime();
        double b = 0;
        for (int i = 1; i < 200_000; i++) b += Math.sqrt(i);
        long t2 = System.nanoTime();
        System.out.printf("pure fp   5.0M iters: %7.0f ms  (%5.3f us/iter)%n", (t1-t0)/1e6, (t1-t0)/1e3/5_000_000);
        System.out.printf("Math.sqrt 0.2M calls: %7.0f ms  (%5.3f us/call)%n", (t2-t1)/1e6, (t2-t1)/1e3/200_000);
        System.out.println("checksum " + a + " " + b);
    }
}
