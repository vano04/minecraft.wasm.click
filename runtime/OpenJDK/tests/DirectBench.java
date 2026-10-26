// The cost of a compiled-to-compiled call that never leaves wasm: a
// statically bound call to a method with a frameless body, which the caller
// imports and calls directly (emit_direct_fast_path). Its loop keeps the
// inliner away, so the time per iteration is the direct call plus a few
// instructions. Pairs with CallBench (through zwc_invoke) and FramedBench.
//
//   run-java.sh -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
//       -cp tests/classes DirectBench [iterations]
public class DirectBench {
  static int g(int x) { for (int k = 0; k < 2; k++) x += k; return x * 3; }

  static int run(int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc = g(acc + i);
    return acc;
  }

  public static void main(String[] args) {
    int n = args.length > 0 ? Integer.parseInt(args[0]) : 2_000_000;
    for (int w = 0; w < 3000; w++) g(w);          // g compiled, with its frameless body
    for (int w = 0; w < 3; w++) run(1000);          // run compiled after g: calls it directly
    for (int round = 0; round < 4; round++) {
      long t = System.nanoTime();
      int a = run(n);
      long t1 = System.nanoTime();
      System.out.printf("direct round %d: %.1f ns per call (%d)%n", round, (t1 - t) / (double) n, a);
    }
  }
}
