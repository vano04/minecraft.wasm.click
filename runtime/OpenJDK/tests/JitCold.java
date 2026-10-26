// Differential cases for cold throw paths in inlined callees. A callee shaped
// like `if (bad) throw new X(...); return v;` is inlined with the throw path
// as a guard: when it fires, the whole call re-runs in the interpreter, which
// must then throw exactly what the interpreter alone would -- type, message,
// and nothing written before it. Every "cold" line must match with and
// without -XX:+UseZeroWasmJIT (and HotSpot).
import java.util.Objects;

public class JitCold {
  static int at(int[] a, int i) {
    if (i >= a.length) throw new IndexOutOfBoundsException("at " + i + " of " + a.length);
    return a[i];
  }
  static double getD(double[] a, int size, int i) {
    if (i >= size) throw new IndexOutOfBoundsException("Index (" + i + ") is greater than or equal to list size (" + size + ")");
    return a[i];
  }
  static int checked(int i, int n) { return Objects.checkIndex(i, n); }
  static String name(Object o) { return Objects.requireNonNull(o, "o").toString(); }
  static int twoThrows(int x) {
    if (x < 0) throw new IllegalArgumentException("negative " + x);
    if (x > 1000) throw new IllegalStateException("big " + x);
    return x * 3 + 1;
  }

  static long loop(int[] a, double[] d, int n) {
    long acc = 0;
    int[] thrown = new int[1];
    StringBuilder msgs = new StringBuilder();
    for (int i = 0; i < n; i++) acc += one(a, d, i, thrown, msgs);
    return acc * 31 + thrown[0] + msgs.toString().hashCode();
  }

  // Called per element so it is compiled (at 200 calls) with the helpers
  // above inlined into it, and their throw paths fire from compiled code.
  static long one(int[] a, double[] d, int i, int[] thrown, StringBuilder msgs) {
    long acc = 0;
    int k = i % (a.length + 3);                    // runs off the end now and then
    try { acc += at(a, k); } catch (IndexOutOfBoundsException e) { thrown[0]++; if (i < 40) msgs.append(e.getMessage()).append(';'); }
    try { acc += (long) getD(d, d.length - 1, k); } catch (IndexOutOfBoundsException e) { thrown[0]++; }
    try { acc += checked(k, a.length); } catch (IndexOutOfBoundsException e) { thrown[0]++; if (i < 40) msgs.append(e.getMessage()).append(';'); }
    try { acc += twoThrows(k * 97 - 50); } catch (IllegalArgumentException e) { thrown[0] += 2; } catch (IllegalStateException e) { thrown[0] += 3; }
    Object o = (i % 11 == 0) ? null : Integer.valueOf(k);
    try { acc += name(o).length(); } catch (NullPointerException e) { thrown[0] += 5; if (i < 40) msgs.append(e.getMessage()).append(';'); }
    return acc;
  }

  public static void main(String[] args) {
    int[] a = new int[13];
    double[] d = new double[13];
    for (int i = 0; i < a.length; i++) { a[i] = i * i - 7; d[i] = i * 0.5; }
    for (int r = 0; r < 3; r++) System.out.println("cold " + r + " " + loop(a, d, 3000));
  }
}
