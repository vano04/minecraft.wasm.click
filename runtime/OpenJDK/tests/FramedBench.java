// The cost of a framed compiled-to-compiled call, alone: the callee writes a
// field, so it has no frameless body, and the site sees four classes, so it
// is not inlined. Time per iteration is the framed call protocol plus a few
// instructions. Pairs with CallBench (frameless calls).
//
//   run-java.sh -XX:+UnlockExperimentalVMOptions -XX:+UseZeroWasmJIT \
//       -cp tests/classes FramedBench [iterations]
public class FramedBench {
  static abstract class Acc { int n; abstract int put(int x); }
  static final class A extends Acc { int put(int x) { n = x; return x + 1; } }
  static final class B extends Acc { int put(int x) { n = x ^ 5; return x + 2; } }
  static final class C extends Acc { int put(int x) { n += x; return x - 1; } }
  static final class D extends Acc { int put(int x) { n = -x; return x; } }

  static int run(Acc[] as, int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc = as[i & 3].put(acc + i);
    return acc;
  }

  // One class at the site: after the profiled recompile, the target is
  // known where the caller compiles. The site is in a method entered on
  // every iteration, so it is recompiled with its profile; the loop's own
  // call to it is a static one (see runStatic).
  static int monoStep(Acc a, int x) { return a.put(x); }
  static int runMono(Acc a, int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc = monoStep(a, acc + i);
    return acc;
  }
  // Four classes at one site, entered the same way.
  static int polyStep(Acc a, int x) { return a.put(x); }
  static int runPoly(Acc[] as, int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc = polyStep(as[i & 3], acc + i);
    return acc;
  }

  static int cell;
  static int bump(int x) { cell = x; return x + 3; }
  static int runStatic(int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc = bump(acc + i);
    return acc;
  }

  public static void main(String[] args) {
    int n = args.length > 0 ? Integer.parseInt(args[0]) : 2_000_000;
    Acc[] as = { new A(), new B(), new C(), new D() };
    for (int round = 0; round < 4; round++) {
      long t = System.nanoTime();
      int a = run(as, n);
      long t1 = System.nanoTime();
      int b = runMono(as[0], n);
      long t2 = System.nanoTime();
      int c = runStatic(n);
      long t3 = System.nanoTime();
      int d = runPoly(as, n);
      long t4 = System.nanoTime();
      System.out.printf("framed round %d: %.1f ns per call (%d)  static %.1f ns (%d)  static+mono %.1f ns (%d)  static+poly %.1f ns (%d)%n",
                        round, (t1 - t) / (double) n, a, (t3 - t2) / (double) n, c,
                        (t2 - t1) / (double) n, b, (t4 - t3) / (double) n, d);
    }
  }
}
