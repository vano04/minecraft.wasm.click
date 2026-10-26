/**
 * Int-only hot loop: exactly the subset the first wasm JIT stage compiles
 * (constants, iload/istore, imul/ixor/iushr/iadd, iinc, if_icmplt, goto).
 * The checksum is the correctness gate -- it must be identical with the JIT
 * on and off, or the compiler is producing wrong answers rather than fast ones.
 */
public class JitBench {
    static int hot(int n) {
        int acc = 0;
        for (int i = 0; i < n; i++) {
            acc += (i * 31) ^ (i >>> 3);
        }
        return acc;
    }

    public static void main(String[] args) {
        int inner = args.length > 0 ? Integer.parseInt(args[0]) : 5000;
        int outer = args.length > 1 ? Integer.parseInt(args[1]) : 4000;
        long sum = 0;
        long t0 = System.nanoTime();
        for (int r = 0; r < outer; r++) sum += hot(inner);
        long t1 = System.nanoTime();
        System.out.println("hot " + (t1 - t0) / 1_000_000L + " ms   checksum " + sum);
    }
}
