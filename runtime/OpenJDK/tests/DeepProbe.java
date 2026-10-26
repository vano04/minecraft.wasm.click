// Deepest recursion (through a compiled static call) that completes; for
// telling a JIT stack regression from a test that is simply too deep.
public class DeepProbe {
  static int f(int n) { return n == 0 ? 0 : 1 + f(n - 1); }
  public static void main(String[] a) {
    for (int w = 0; w < 3000; w++) f(10);           // compile f first
    int lo = 100, hi = 200000;
    while (lo < hi) {
      int mid = (lo + hi + 1) >>> 1;
      boolean ok;
      try { f(mid); ok = true; } catch (StackOverflowError e) { ok = false; }
      if (ok) lo = mid; else hi = mid - 1;
    }
    System.out.println("deepest " + lo);
  }
}
