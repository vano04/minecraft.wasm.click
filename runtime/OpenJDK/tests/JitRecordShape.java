import java.util.List;
import java.util.Objects;

/**
 * Record hashCode on the shape of Minecraft's CubicSpline.Multipoint: a
 * generic component, float[] components, an immutable List of records that
 * nest the same way, and float components -- hashed through List.hashCode
 * and Objects.hashCode, as the noise router's caches do. Each hash is checked
 * against the formula ObjectMethods uses (31 * h + hash(component)) in the
 * same run, so identity hashes of the arrays need not match across runs.
 *
 * Lines starting with "shape" must be identical with and without the JIT.
 */
public class JitRecordShape {
    interface Fn<C> { float apply(C c); }
    // hashCode allocates: with a small heap, collections happen inside the
    // record's hashCode fold, between its reads of the record's fields.
    static final class Name {
        final String s;
        Name(String s) { this.s = s; }
        static Object[] keep = new Object[64];
        static int next;
        @Override public int hashCode() {
            keep[next++ & 63] = new byte[2048];
            return s.hashCode();
        }
    }
    record Coord(Name name, float scale) implements Fn<Object> {
        public float apply(Object o) { return scale; }
    }
    interface Spline<I extends Fn<?>> { }
    record Constant<I extends Fn<?>>(float value) implements Spline<I> { }
    record Multipoint<I extends Fn<?>>(I coordinate, float[] locations, List<Spline<I>> values,
                                       float[] derivatives, float minValue, float maxValue) implements Spline<I> { }

    static int expected(Object o) {
        if (o instanceof Constant<?> c) return Float.hashCode(c.value());
        if (o instanceof Coord c) return Objects.hashCode(c.name()) * 31 + Float.hashCode(c.scale());
        if (o instanceof Multipoint<?> m) {
            int h = 0;
            h = h * 31 + expected(m.coordinate());
            h = h * 31 + Objects.hashCode(m.locations());
            int lh = 1;
            for (Object e : m.values()) lh = 31 * lh + expected(e);
            h = h * 31 + lh;
            h = h * 31 + Objects.hashCode(m.derivatives());
            h = h * 31 + Float.hashCode(m.minValue());
            h = h * 31 + Float.hashCode(m.maxValue());
            return h;
        }
        throw new IllegalStateException();
    }

    static Spline<Coord> build(int depth, int seed) {
        if (depth == 0) return new Constant<>(seed * 0.25f - 3f);
        int n = 2 + seed % 3;
        float[] loc = new float[n], der = new float[n];
        Spline<Coord>[] vals = new Spline[n];
        for (int i = 0; i < n; i++) {
            loc[i] = i - 1.5f + seed * 0.01f;
            der[i] = (i & 1) == 0 ? 0f : -0.5f * i;
            vals[i] = build(depth - 1, seed * 7 + i);
        }
        return new Multipoint<>(new Coord(new Name("c" + (seed % 5)), seed * 0.5f), loc, List.of(vals), der,
                -1f - seed, 1f + seed);
    }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 400;
        Spline<Coord>[] roots = new Spline[24];
        for (int i = 0; i < roots.length; i++) roots[i] = build(3, i);
        int mismatches = 0, drift = 0;
        long sink = 0;
        // Taken before anything is compiled: identity hashes (the arrays')
        // stay put for the run, so a later hash that differs is miscompiled.
        int[] first = new int[roots.length];
        for (int i = 0; i < roots.length; i++) first[i] = expected(roots[i]);
        for (int r = 0; r < rounds; r++) {
            for (int i = 0; i < roots.length; i++) {
                Spline<Coord> s = roots[i];
                int h = s.hashCode();
                if (h != first[i]) drift++;
                if (h != expected(s)) mismatches++;
                sink += h & 1;
                if (s.equals(s) == false) mismatches++;
            }
        }
        System.out.println("shape mismatches " + mismatches + " drift " + drift);
        System.out.println("shape done " + (sink >= 0));
    }
}
