// The polymorphic inline cache (ZeroWasmJITCallFix bit 64): virtual sites that
// see a few receiver classes get one class test per class with its target
// inlined, and the ordinary call for anything else. Every result kind, a
// null receiver, a class the cache does not hold, a throw inside an inlined
// arm, a class that only appears after the profiled recompile, and the same
// sites inside an inlined final method (the nested cache, which bails to the
// outer call for a class it does not hold). The
// output must match the interpreter's exactly.
public class JitPoly {
    static abstract class Shape {
        int k;
        abstract int i();
        abstract long l();
        abstract double d();
        abstract Object o();
        abstract void bump();
        abstract int div(int x);
        // Nested sites: a caller that inlines these meets each call above
        // as a polymorphic site inside a splice.
        final long mix() { return i() * 3L + l() + (long) d(); }
        final int safeDiv(int x) { return x == 3 ? -1 : div(x); }
    }
    static final class A extends Shape {
        int i() { return 3 + k; }
        long l() { return 1L << 40 | k; }
        double d() { return 0.5 * k; }
        Object o() { return "a"; }
        void bump() { k++; }
        int div(int x) { return 100 / x; }
    }
    static final class B extends Shape {
        int i() { return 7 * k; }
        long l() { return -k; }
        double d() { return k + 0.25; }
        Object o() { return this; }
        void bump() { k += 2; }
        int div(int x) { return x / (x - 1); }
    }
    static final class C extends Shape {           // joins late
        int[] a = new int[4];
        int i() { return a[k & 3]; }
        long l() { return 5; }
        double d() { return -1; }
        Object o() { return null; }
        void bump() { a[k & 3]++; k++; }
        int div(int x) { return a.length / x; }
    }

    static long one(Shape s, int x) {
        long h = s.i();
        h = h * 31 + s.l();
        h = h * 31 + (long) (s.d() * 4);
        Object o = s.o();
        h = h * 31 + (o == null ? 0 : o == s ? 1 : 2);
        s.bump();
        try { h = h * 31 + s.div(x); } catch (ArithmeticException e) { h = h * 31 + 99; }
        h = h * 31 + s.mix();
        try { h = h * 31 + s.safeDiv(x); } catch (ArithmeticException e) { h = h * 31 + 98; }
        return h;
    }
    static long run(Shape[] ss, int n) {
        long h = 0;
        for (int r = 0; r < n; r++) {
            Shape s = ss[r % ss.length];
            try { h = h * 17 + one(s, r % 5); } catch (NullPointerException e) { h = h * 17 + 1; }
        }
        return h;
    }
    public static void main(String[] args) {
        Shape[] ab = { new A(), new B(), new A(), new B() };
        Shape[] abn = { new A(), null, new B() };
        Shape[] abc = { new A(), new B(), new C() };
        System.out.println("poly ab " + run(ab, 200000));
        System.out.println("poly abn " + run(abn, 200000));
        System.out.println("poly abc " + run(abc, 200000));
        System.out.println("poly ab2 " + run(ab, 200000));
    }
}
