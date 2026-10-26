// Differential cases for frameless calls. A compiled method the inliner could
// take whole gets a second, frameless body: no Zero frame, locals in wasm
// locals, and any guard returns "retry" so the call re-runs the ordinary way.
// Every "frameless" line must match the interpreter, the JIT with frameless
// calls disabled (-XX:ZeroWasmJITDisable=16384), and HotSpot.
//
// The cases cover what a frameless call can get wrong: every result width
// and its narrowing, 64-bit and floating-point arguments, guards that fire
// (null, bounds, a cold throw), static fields, type checks, and callers that
// are compiled (monomorphic and megamorphic sites) or interpreted.
public class JitFrameless {
  interface Leaf {
    boolean z(int x); byte b(int x); char c(int x); short s(int x); int i(int x);
    long j(int x); float f(int x); double d(int x); Object o(int x);
  }
  static final class Box { final int v; Box(int v) { this.v = v; } }

  static int SCALE = 3;
  static final Object MARK = new Object();

  static class A implements Leaf {
    final Box box; final int[] arr;
    A(Box box, int[] arr) { this.box = box; this.arr = arr; }
    public boolean z(int x) { return (x & 3) == 1; }
    public byte b(int x) { return (byte) (x * 37); }
    public char c(int x) { return (char) (60000 + x * 13); }
    public short s(int x) { return (short) (x * -3001); }
    public int i(int x) { return box.v * x + arr[x & 7] * SCALE; }       // null and bounds guards
    public long j(int x) { return (long) x * 0x1_0000_0001L - box.v; }
    public float f(int x) { return x * 0.75f - box.v; }
    public double d(int x) { return x / 3.0 + arr[x & 3]; }
    public Object o(int x) { return (x & 1) == 0 ? MARK : box; }
  }
  static final class B extends A {
    B(Box box, int[] arr) { super(box, arr); }
    public int i(int x) {
      if (x > 500) throw new IllegalArgumentException("too big: " + x);  // cold throw path
      return x ^ 0x5a5a;
    }
    public double d(int x) { return -x * 1.5; }
    public Object o(int x) { return this; }
  }
  static final class C extends A {
    C(Box box, int[] arr) { super(box, arr); }
    public long j(int x) { return ~(long) x; }
    public boolean z(int x) { return (x % 3) == 0; }
  }

  // Static leaves: wide and floating-point arguments, reached from the
  // interpreter (main runs interpreted) and from compiled callers.
  static long mixL(long a, int b, double c) { return a * 31 + b + (long) (c * 8); }
  static double mixD(float a, double b, long c) { return a * b - c; }
  static int kind(Object o) { return o instanceof A ? (o instanceof B ? 2 : 1) : 0; }

  static long h(long acc, long v) { return acc * 1_000_003L ^ v; }

  // A loop, so its frameless body comes from the ordinary emitter, with its
  // locals in memory; it assigns to its parameter and then makes a call that
  // may have to be retried the ordinary way. The retry must see the argument
  // it was called with, not the negated one (a real bug: the JDK's
  // DecimalDigits.uncheckedGetCharsLatin1 has exactly this shape).
  static int digitsThen(int i, Leaf l) {
    boolean negative = i < 0;
    if (!negative) i = -i;
    int n = 1;
    while (i <= -10) { i = i / 10; n++; }
    return n * 1000 + l.i(n) + (negative ? 1 : 0);
  }

  static long callAll(Leaf l, int x) {
    long acc = 17;
    acc = h(acc, l.z(x) ? 1 : 0);
    acc = h(acc, l.b(x));
    acc = h(acc, l.c(x));
    acc = h(acc, l.s(x));
    try { acc = h(acc, l.i(x)); } catch (NullPointerException e) { acc = h(acc, 101); }
      catch (ArrayIndexOutOfBoundsException e) { acc = h(acc, 102); }
      catch (IllegalArgumentException e) { acc = h(acc, e.getMessage().hashCode()); }
    try { acc = h(acc, l.j(x)); } catch (NullPointerException e) { acc = h(acc, 103); }
    try { acc = h(acc, Float.floatToIntBits(l.f(x))); } catch (NullPointerException e) { acc = h(acc, 104); }
    try { acc = h(acc, Double.doubleToLongBits(l.d(x))); } catch (ArrayIndexOutOfBoundsException e) { acc = h(acc, 105); }
    Object o = l.o(x);
    acc = h(acc, o == MARK ? 7 : kind(o));
    acc = h(acc, mixL(x * 1_000_000_007L, x, x * 0.125));
    acc = h(acc, Double.doubleToLongBits(mixD(x * 0.5f, x * 1.25, x)));
    try { acc = h(acc, digitsThen(x * 7919 - 3000, l)); } catch (RuntimeException e) { acc = h(acc, 106); }
    return acc;
  }

  static long mono(Leaf l, int n) {
    long acc = 0;
    for (int x = 0; x < n; x++) acc = h(acc, callAll(l, x));
    return acc;
  }
  static long mega(Leaf[] ls, int n) {
    long acc = 0;
    for (int x = 0; x < n; x++) acc = h(acc, callAll(ls[x % ls.length], x));
    return acc;
  }

  public static void main(String[] args) {
    int[] eight = { 3, 1, 4, 1, 5, 9, 2, 6 };
    int[] four = { 2, 7, 1, 8 };
    Leaf good = new A(new Box(5), eight);
    Leaf nullBox = new A(null, eight);      // i, j, f throw NPE: the guard must retry
    Leaf shortArr = new A(new Box(2), four); // i reads arr[x & 7]: bounds guard
    Leaf[] all = { good, new B(new Box(1), eight), new C(new Box(9), eight), nullBox, shortArr };
    for (int r = 0; r < 3; r++) {
      System.out.println("frameless mono " + r + " " + mono(good, 900));
      System.out.println("frameless mega " + r + " " + mega(all, 900));
      System.out.println("frameless static " + r + " " + mixL(r, r, r) + " " + mixD(r, r, r) + " " + kind(all[r]));
    }
  }
}
