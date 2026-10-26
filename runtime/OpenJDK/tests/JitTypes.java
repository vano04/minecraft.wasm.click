// Differential cases for the JIT's type checks and fused field loads. Run with
// and without -XX:+UseZeroWasmJIT; the "types" lines must be identical.
//
// The subtype cases alternate several interfaces on the same classes: that is
// what defeats the one-word fast test (the secondary-super cache holds one
// answer per class), so they exercise the zwc_subtype call rather than the
// fast path. The failing checkcast must still throw from the interpreter.
import java.io.Serializable;
import java.util.function.IntPredicate;

public class JitTypes {
  interface Shape { double area(); }
  interface Named { String name(); }
  interface Tagged { int tag(); }

  static final class Sq implements Shape, Named, Tagged {
    final double s; Sq(double s) { this.s = s; }
    public double area() { return s * s; }
    public String name() { return "sq"; }
    public int tag() { return 1; }
  }
  static class Circ implements Shape, Tagged {
    final double r; Circ(double r) { this.r = r; }
    public double area() { return 3.0 * r * r; }
    public int tag() { return 2; }
  }
  static final class Big extends Circ implements Named, Serializable {
    Big(double r) { super(r); }
    public String name() { return "big"; }
  }
  static final class Plain { int v = 7; }

  // fast_faccess_0 once the interpreter has rewritten aload_0; getfield.
  static final class Holder {
    float f; int i; Object o;
    Holder(float f, int i, Object o) { this.f = f; this.i = i; this.o = o; }
    float getF() { return f; }
    int getI() { return i; }
    Object getO() { return o; }
    float scaled(float k) { return f * k + i; }
  }

  static int classify(Object o) {
    int r = 0;
    if (o instanceof Shape) r |= 1;
    if (o instanceof Named) r |= 2;
    if (o instanceof Tagged) r |= 4;
    if (o instanceof Serializable) r |= 8;
    if (o instanceof Circ) r |= 16;
    if (o instanceof Object[]) r |= 32;
    if (o instanceof Comparable[]) r |= 64;
    if (o instanceof Cloneable) r |= 128;
    return r;
  }

  static double shapeArea(Object o) { return ((Shape) o).area(); }
  static int tagOf(Object o) { return ((Tagged) o).tag(); }
  static int nameLen(Object o) { return ((Named) o).name().length(); }

  static long run(Object[] objs, int rounds) {
    long acc = 0;
    for (int r = 0; r < rounds; r++) {
      for (int i = 0; i < objs.length; i++) {
        Object o = objs[i];
        int c = classify(o);
        acc = acc * 31 + c;
        if ((c & 1) != 0) acc += (long) shapeArea(o);
        if ((c & 4) != 0) acc += tagOf(o);
        if ((c & 2) != 0) acc += nameLen(o);
      }
    }
    return acc;
  }

  static int castFailures(Object[] objs, int rounds) {
    int n = 0;
    for (int r = 0; r < rounds; r++) {
      for (Object o : objs) {
        try { n += tagOf(o); } catch (ClassCastException e) { n += 1000; }
        catch (NullPointerException e) { n += 100000; }
      }
    }
    return n;
  }

  static double holders(Holder[] hs, int rounds) {
    double acc = 0;
    for (int r = 0; r < rounds; r++) {
      for (Holder h : hs) {
        acc += h.getF() + h.getI() + h.scaled(0.5f) + (h.getO() == null ? 1 : 2);
      }
    }
    return acc;
  }

  static int lambdas(int rounds) {
    int[] box = { 3 };
    int lim = 17;
    IntPredicate p = x -> x < lim + box[0];
    int n = 0;
    for (int r = 0; r < rounds; r++) {
      for (int i = 0; i < 40; i++) if (p.test(i)) n++;
    }
    return n;
  }

  public static void main(String[] args) {
    Object[] objs = {
      new Sq(2), new Circ(3), new Big(1), new Plain(), "str", new String[1],
      new Integer[2], new int[3], new Object[0], null, new Sq(5), new Big(4),
    };
    Holder[] hs = { new Holder(1.5f, 2, null), new Holder(-0.25f, 9, "x"),
                    new Holder(0.125f, 0, hs0()), new Holder(3.75f, -4, null) };
    Box[] boxes = { new B0(), new B1(), new B2(), new B3(), new B4(), new B5(), new B6(), new B7() };
    Base[] sgets = { new B1(), null, new B2(), new B7(), null };
    for (int warm = 0; warm < 3; warm++) {
      System.out.println("types run " + warm + " " + run(objs, 400));
      System.out.println("types cast " + warm + " " + castFailures(objs, 300));
      System.out.println("types holders " + warm + " " + holders(hs, 500));
      System.out.println("types lambda " + warm + " " + lambdas(300));
      System.out.println("types boxes " + warm + " " + boxes(boxes, 300));
      System.out.println("types sget " + warm + " " + staticGetter(sgets, 300));
    }
  }

  static Object hs0() { return new Object(); }

  // Getters of every one-slot type, reached through one interface site that
  // cycles through more receiver classes than an inline cache holds: the
  // megamorphic table and the getter fast path in zwc_invoke.
  interface Box { byte b(); char c(); short s(); boolean z(); float f(); int i(); Object o(); }
  static abstract class Base implements Box {
    byte b; char c; short s; boolean z; float f; int i; Object o;
    Base(int k) {
      b = (byte) (k * 37); c = (char) (60000 + k); s = (short) (-3000 * k); z = (k & 1) != 0;
      f = k * 0.75f - 2; i = k * 1000003; o = (k % 3 == 0) ? null : "o" + k;
    }
    public byte b() { return b; }
    public char c() { return c; }
    public short s() { return s; }
    public boolean z() { return z; }
    public float f() { return f; }
    public int i() { return i; }
    public Object o() { return o; }
  }
  static final class B0 extends Base { B0() { super(0); } }
  static final class B1 extends Base { B1() { super(1); } }
  static final class B2 extends Base { B2() { super(2); } }
  static final class B3 extends Base { B3() { super(3); } }
  static final class B4 extends Base { B4() { super(4); } }
  static final class B5 extends Base { B5() { super(5); } }
  static final class B6 extends Base { B6() { super(6); } }
  static final class B7 extends Base { B7() { super(7); } }

  static long boxes(Box[] bs, int rounds) {
    long acc = 0;
    for (int r = 0; r < rounds; r++) {
      for (int k = 0; k < bs.length; k++) acc = acc * 31 + boxOne(bs[(k * 5 + r) % bs.length]);
    }
    return acc;
  }
  static long boxOne(Box x) {
    Object o = x.o();
    return x.b() + 3L * x.c() + 7L * x.s() + (x.z() ? 11 : 13)
         + Float.floatToRawIntBits(x.f()) + x.i() + (o == null ? 17 : o.hashCode());
  }

  // Zero runs a static method of the getter's shape through its getter
  // entry too; a null argument has to reach the interpreter and throw.
  static int sget(Base h) { return h.i; }
  static int sgetSafe(Base h) {
    try { return sget(h); } catch (NullPointerException e) { return 5; }
  }
  static long staticGetter(Base[] bs, int rounds) {
    long acc = 0;
    for (int r = 0; r < rounds; r++) {
      for (Base h : bs) acc += sgetSafe(h);
    }
    return acc;
  }
}
