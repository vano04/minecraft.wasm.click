// Differential cases for invokedynamic and invokehandle in compiled code. A
// linked call site is compiled as the interpreter runs it: the appendix is
// pushed after the arguments and the linked adapter is called. Every "indy"
// line must match with and without -XX:+UseZeroWasmJIT (and HotSpot).
import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.util.function.IntBinaryOperator;
import java.util.function.IntPredicate;
import java.util.function.Supplier;

public class JitIndy {
  record P(int x, double y, String s) {}
  sealed interface Shape permits Sq, Circ, Tri {}
  record Sq(int side) implements Shape {}
  record Circ(double r) implements Shape {}
  record Tri(int a, int b) implements Shape {}

  static final MethodHandle ADD;
  static {
    try {
      ADD = MethodHandles.lookup().findStatic(JitIndy.class, "add", MethodType.methodType(int.class, int.class, int.class));
    } catch (ReflectiveOperationException e) { throw new ExceptionInInitializerError(e); }
  }
  static int add(int a, int b) { return a * 31 + b; }

  static long h(long acc, long v) { return acc * 1_000_003L ^ v; }

  // Capturing lambdas created on every call, as CubicSpline does.
  static int search(float[] xs, float x) {
    IntPredicate below = i -> x < xs[i];
    int lo = 0, hi = xs.length;
    while (lo < hi) { int mid = (lo + hi) >>> 1; if (below.test(mid)) hi = mid; else lo = mid + 1; }
    return lo;
  }

  static String concat(int i, long l, double d, char c, boolean z, Object o) {
    return "i=" + i + " l=" + l + " d=" + d + " c=" + c + " z=" + z + " o=" + o;
  }

  static double area(Shape s) {
    return switch (s) {
      case Sq q -> q.side() * q.side();
      case Circ c -> 3.0 * c.r() * c.r();
      case Tri t when t.a() > t.b() -> t.a() * 0.5;
      case Tri t -> t.b() * 0.25;
    };
  }

  static int viaHandle(int a, int b) throws Throwable { return (int) ADD.invokeExact(a, b); }

  static int thrower(int k) {
    Supplier<Integer> s = () -> { if (k % 7 == 3) throw new IllegalStateException("k" + k); return k * 2; };
    try { return s.get(); } catch (IllegalStateException e) { return -e.getMessage().length(); }
  }

  static long one(int k, float[] xs, Shape[] shapes) throws Throwable {
    long acc = 0;
    acc = h(acc, search(xs, k * 0.37f));
    acc = h(acc, concat(k, k * 3_000_000_000L, k / 7.0, (char) ('a' + k % 26), k % 2 == 0, k % 3 == 0 ? null : "s" + k).hashCode());
    acc = h(acc, Double.doubleToLongBits(area(shapes[k % shapes.length])));
    P p = new P(k, k * 0.5, "p" + (k % 5));
    acc = h(acc, p.hashCode());
    acc = h(acc, p.toString().hashCode());
    acc = h(acc, p.equals(new P(k, k * 0.5, "p" + (k % 5))) ? 1 : 0);
    acc = h(acc, viaHandle(k, k + 1));
    IntBinaryOperator op = (k & 1) == 0 ? Math::max : (a, b) -> a - b;
    acc = h(acc, op.applyAsInt(k, 17));
    acc = h(acc, thrower(k));
    return acc;
  }

  public static void main(String[] args) throws Throwable {
    float[] xs = { 0.5f, 1.5f, 2.25f, 4f, 8f, 16f, 30f, 64f, 100f };
    Shape[] shapes = { new Sq(3), new Circ(1.5), new Tri(5, 2), new Tri(1, 9) };
    for (int r = 0; r < 3; r++) {
      long acc = 0;
      for (int k = 0; k < 700; k++) acc = h(acc, one(k, xs, shapes));
      System.out.println("indy " + r + " " + acc);
    }
  }
}
