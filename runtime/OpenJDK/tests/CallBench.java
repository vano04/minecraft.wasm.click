// The cost of one compiled-to-compiled call, alone. Each loop makes one call
// per iteration to a small method the JIT cannot inline (it is virtual, and
// the receiver's class varies or the callee allocates), so the time per
// iteration is the call protocol plus a few instructions.
//
//   run-java.sh -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
//       -cp tests/classes CallBench [iterations]
public class CallBench {
  interface Fn { int apply(int x); }
  static final class Add implements Fn { final int k; Add(int k) { this.k = k; } public int apply(int x) { return x + k; } }
  static final class Mul implements Fn { final int k; Mul(int k) { this.k = k; } public int apply(int x) { return x * k; } }
  static final class Xor implements Fn { final int k; Xor(int k) { this.k = k; } public int apply(int x) { return x ^ k; } }
  static final class Shl implements Fn { public int apply(int x) { return x << 1; } }

  static final class Box { final int v; Box(int v) { this.v = v; } }
  static Box make(int v) { return new Box(v); }          // allocates: never inlined

  static int mono(Fn f, int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc = f.apply(acc + i);
    return acc;
  }
  static int mega(Fn[] fs, int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc = fs[i & 3].apply(acc + i);
    return acc;
  }
  static int alloc(int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc += make(i).v;
    return acc;
  }

  public static void main(String[] args) {
    int n = args.length > 0 ? Integer.parseInt(args[0]) : 2_000_000;
    Fn one = new Add(3);
    Fn[] four = { new Add(3), new Mul(5), new Xor(7), new Shl() };
    for (int round = 0; round < 3; round++) {
      long t = System.nanoTime();
      int a = mono(one, n);
      long t1 = System.nanoTime();
      int b = mega(four, n);
      long t2 = System.nanoTime();
      int c = alloc(n);
      long t3 = System.nanoTime();
      System.out.printf("calls round %d: mono %.1f ns  mega %.1f ns  alloc %.1f ns  (%d %d %d)%n",
          round, (t1 - t) / (double) n, (t2 - t1) / (double) n, (t3 - t2) / (double) n, a, b, c);
    }
  }
}
