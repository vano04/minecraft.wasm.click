import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.function.IntSupplier;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * Lambda capture, which the JIT emits as an allocation and field stores under
 * -XX:ZeroWasmJITIndyFast bit 2 (see emit_lambda in zeroWasmCompiler.cpp),
 * and non-capturing lambdas, which it reads from the call site's constant
 * handle. Captures of every slot kind (int, long, float, double, a reference,
 * the narrow ones, mixed, up to ten values); a captured `this`; method
 * references with a bound receiver, a null one included; serializable lambdas
 * (altMetafactory), round-tripped through serialization; non-capturing
 * lambdas and method references, which must be the same object every time;
 * captures in a pure static method (a frameless body) and in a small one that
 * inlines; enough of them, kept alive, to run TLABs out (the bump's failure
 * path); several threads capturing at once; and a thread forcing collections
 * while captured references are stored and later checked.
 *
 * Lines starting with "lam" must be identical with and without the JIT.
 */
public class JitLambdaAlloc {
    interface Mixed { double eval(int k); }
    interface Ten { long sum(); }
    interface Narrow { long bits(); }

    static final class Cell { final int v; Cell(int v) { this.v = v; } }

    // One value of each kind.
    static int capInt(int a) { IntSupplier s = () -> a * 3; return s.getAsInt(); }
    static long capLong(long a) { LongSupplier s = () -> a ^ 0x5555_5555_5555_5555L; return s.getAsLong(); }
    static float capFloat(float a) { Supplier<Float> s = () -> a * 2f; return s.get(); }
    static double capDouble(double a) { Supplier<Double> s = () -> a / 3.0; return s.get(); }
    static int capRef(Cell c) { IntSupplier s = () -> c == null ? -1 : c.v; return s.getAsInt(); }

    // The narrow kinds, at their extremes: each must be stored at its width.
    static long capNarrow(boolean z, byte b, char c, short s) {
        Narrow n = () -> (z ? 1L : 0L) | ((b & 0xffL) << 8) | ((long) c << 16) | ((s & 0xffffL) << 32) | ((long) b << 48);
        return n.bits();
    }

    // Mixed widths, so the fields are laid out out of argument order.
    static double capMixed(int i, long l, float f, double d, Cell c, int j) {
        Mixed m = k -> i + l * k + f + d * j + (c == null ? 0 : c.v);
        return m.eval(3);
    }

    // Ten values, half of them two slots wide.
    static long capTen(long a, int b, double c, Cell d, long e, float f, int g, double h, Object i, long j) {
        Ten t = () -> a + b + (long) c + d.v + e + (long) f + g + (long) h + (i == null ? 0 : i.hashCode() & 0) + j;
        return t.sum();
    }

    // Exact bits through a float and a double, a NaN with a payload included.
    static long capBits(float f, double d) {
        LongSupplier s = () -> ((long) Float.floatToRawIntBits(f) << 32) ^ Double.doubleToRawLongBits(d);
        return s.getAsLong();
    }

    // A captured `this`, and a field read through it.
    int base;
    JitLambdaAlloc(int base) { this.base = base; }
    int capThis(int k) { IntSupplier s = () -> base * 7 + k; return s.getAsInt(); }

    // Bound receivers: javac's requireNonNull comes first, so a null one is a
    // NullPointerException before the capture.
    static int boundRef(String s, String needle) { Function<String, Integer> f = s::indexOf; return f.apply(needle); }
    static int boundList(List<Integer> list, int v) {
        java.util.function.Predicate<Integer> add = list::add;
        return add.test(v) ? list.size() : -1;
    }

    // Serializable lambdas go through altMetafactory.
    static Supplier<String> serial(String p, int n) {
        return (Supplier<String> & Serializable) () -> p + ":" + n;
    }

    // Non-capturing: one object, every time.
    static IntSupplier constant() { return () -> 42; }
    static Function<Integer, Cell> ctorRef() { return Cell::new; }
    static Function<Object, String> staticRef() { return String::valueOf; }

    // Pure, small, static: a frameless body, or a splice in the loop.
    static int framelessCap(int a, int b) { IntSupplier s = () -> a * 31 + b; return s.getAsInt(); }
    static IntSupplier make(int a, Cell c) { return () -> a + c.v; }

    static String describe(Throwable t) {
        return t.getClass().getName();
    }

    static byte[] ser(Object o) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        try (ObjectOutputStream oo = new ObjectOutputStream(bo)) { oo.writeObject(o); }
        return bo.toByteArray();
    }
    static Object deser(byte[] b) throws Exception {
        try (ObjectInputStream oi = new ObjectInputStream(new ByteArrayInputStream(b))) { return oi.readObject(); }
    }

    static volatile boolean stop;

    public static void main(String[] args) throws Exception {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 40000;
        Cell[] cells = new Cell[17];
        for (int i = 0; i < cells.length; i++) cells[i] = (i % 6 == 0) ? null : new Cell(i * 5);

        long a = 0, b = 0, c = 0, d = 0, e = 0;
        for (int r = 0; r < rounds; r++) {
            a = a * 31 + capInt(r) + capLong(r * 0x1_0000_0001L) + capRef(cells[r % cells.length]);
            b = b * 31 + Float.floatToRawIntBits(capFloat(r * 0.37f)) + Double.doubleToRawLongBits(capDouble(r * 1.5));
            c = c * 31 + capNarrow((r & 1) != 0, (byte) r, (char) (r * 7919), (short) (r * 31));
            d = d * 31 + Double.doubleToRawLongBits(capMixed(r, -r * 3L, r * 0.5f, r * 0.25, cells[r % cells.length], r & 15));
            e = e * 31 + capTen(r, -r, r * 1.5, cells[1 + r % 5], r * 7L, r * 0.5f, r ^ 3, r * 2.5, (r & 1) == 0 ? null : "x", -1L);
        }
        System.out.println("lam kinds int/long/ref=" + a + " float/double=" + b);
        System.out.println("lam narrow " + c);
        System.out.println("lam mixed " + d);
        System.out.println("lam ten " + e);
        System.out.println("lam narrow extremes " + capNarrow(true, Byte.MIN_VALUE, Character.MAX_VALUE, Short.MIN_VALUE)
            + " " + capNarrow(false, Byte.MAX_VALUE, (char) 0, (short) -1));
        long bits = 0;
        for (int r = 0; r < rounds / 10; r++) {
            bits = bits * 31 + capBits(Float.intBitsToFloat(0x7fc00001 + (r & 7)), Double.longBitsToDouble(0x7ff8000000000001L + r));
            bits = bits * 31 + capBits(-0.0f, Double.MIN_VALUE * r);
        }
        System.out.println("lam bits " + bits);

        JitLambdaAlloc self = new JitLambdaAlloc(3);
        long t = 0;
        for (int r = 0; r < rounds; r++) { self.base = r & 255; t = t * 31 + self.capThis(r); }
        System.out.println("lam this " + t);

        long br = 0;
        List<Integer> list = new ArrayList<>();
        for (int r = 0; r < rounds; r++) {
            br = br * 31 + boundRef("abcdefghij".substring(r % 5), "f");
            if ((r & 1023) == 0) list.clear();
            br = br * 31 + boundList(list, r);
        }
        System.out.println("lam bound " + br);
        try { boundRef(null, "a"); System.out.println("lam bound null none"); }
        catch (RuntimeException ex) { System.out.println("lam bound null " + describe(ex)); }

        StringBuilder sb = new StringBuilder();
        Supplier<String> last = null;
        for (int r = 0; r < rounds; r++) {
            Supplier<String> s = serial("p" + (r % 13), r);
            if (r % 9973 == 0) sb.append(s.get()).append(' ');
            last = s;
        }
        @SuppressWarnings("unchecked")
        Supplier<String> back = (Supplier<String>) deser(ser(last));
        System.out.println("lam serial " + sb + "back=" + back.get() + " same=" + (back.get().equals(last.get())));

        int sameC = 0, sameR = 0, sameS = 0, distinct = 0;
        IntSupplier c0 = constant();
        Function<Integer, Cell> r0 = ctorRef();
        Function<Object, String> s0 = staticRef();
        long cv = 0;
        for (int r = 0; r < rounds; r++) {
            IntSupplier ci = constant();
            if (ci == c0) sameC++;
            cv += ci.getAsInt();
            Function<Integer, Cell> ri = ctorRef();
            if (ri == r0) sameR++;
            cv += ri.apply(r).v;
            if (staticRef() == s0) sameS++;
            if (make(r, cells[1]) != make(r, cells[1])) distinct++;
        }
        System.out.println("lam constant same=" + sameC + "/" + sameR + "/" + sameS + " v=" + cv + " captures distinct=" + distinct
            + " hidden=" + c0.getClass().isHidden() + "/" + make(1, cells[1]).getClass().isHidden()
            + " sameClass=" + (make(1, cells[1]).getClass() == make(2, cells[2]).getClass()));

        long fl = 0;
        for (int r = 0; r < rounds * 2; r++) fl = fl * 31 + framelessCap(r, r >> 3);
        long sp = 0;
        for (int r = 0; r < rounds * 2; r++) sp = sp * 31 + make(r, cells[1 + (r % 5)]).getAsInt();
        System.out.println("lam frameless " + fl + " spliced " + sp);
        try { make(1, null).getAsInt(); System.out.println("lam null capture none"); }
        catch (RuntimeException ex) { System.out.println("lam null capture " + describe(ex)); }

        // Kept alive: many TLABs' worth of captures, the bump failing at each
        // refill; every one checked afterwards.
        IntSupplier[] keep = new IntSupplier[rounds * 2];
        Ten[] tens = new Ten[rounds / 4];
        for (int i = 0; i < keep.length; i++) keep[i] = make(i, cells[1 + (i % 5)]);
        for (int i = 0; i < tens.length; i++) {
            long x = i;
            Cell cc = cells[1 + (i % 5)];
            tens[i] = () -> x * 3 + cc.v;
        }
        int badKeep = 0;
        for (int i = 0; i < keep.length; i++) if (keep[i].getAsInt() != i + cells[1 + (i % 5)].v) badKeep++;
        for (int i = 0; i < tens.length; i++) if (tens[i].sum() != i * 3L + cells[1 + (i % 5)].v) badKeep++;
        System.out.println("lam kept bad=" + badKeep);

        // Several threads at once, each with its own TLAB and code.
        long[] sums = new long[4];
        Thread[] ts = new Thread[4];
        for (int k = 0; k < ts.length; k++) {
            final int id = k;
            ts[k] = new Thread(() -> {
                long s = 0;
                for (int r = 0; r < rounds; r++) s = s * 31 + Double.doubleToRawLongBits(capMixed(r + id, id, r * 0.5f, id * 0.25, cells[1 + (r % 5)], r & 7));
                sums[id] = s;
            });
            ts[k].start();
        }
        for (Thread th : ts) th.join();
        System.out.println("lam threads " + sums[0] + " " + sums[1] + " " + sums[2] + " " + sums[3]);

        // Captured references that move: a thread collects while captures
        // are made, stored and read back.
        stop = false;
        Thread gc = new Thread(() -> {
            Object hold = null;
            for (int k = 0; !stop; k++) {
                hold = new byte[4096];
                if ((k & 1023) == 0) System.gc();
            }
            if (hold == null) System.out.println("unreachable");
        });
        gc.start();
        int moved = 0;
        Supplier<?>[] ring = new Supplier<?>[256];
        Cell[] want = new Cell[256];
        for (int r = 0; r < rounds * 2; r++) {
            int slot = r & 255;
            if (ring[slot] != null && ring[slot].get() != want[slot]) moved++;
            Cell cc = new Cell(r);
            String tag = "t" + (r & 63);
            want[slot] = cc;
            ring[slot] = () -> tag.length() > 0 ? cc : null;
            if (((Cell) ring[slot].get()).v != r) moved++;
        }
        stop = true;
        gc.join();
        for (int s = 0; s < 256; s++) if (ring[s].get() != want[s]) moved++;
        System.out.println("lam moving bad=" + moved);
    }
}
