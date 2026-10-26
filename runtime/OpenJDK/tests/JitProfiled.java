import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Class-guarded inlining of profiled virtual and interface calls
 * (-XX:ZeroWasmJITProfileRecompile): a site that only saw one receiver class
 * when its method was recompiled gets that class's body spliced in behind a
 * class check. This drives every way that check can be wrong:
 *
 *  - a site that stays monomorphic long enough to be recompiled, then sees a
 *    second class (the guard must hand back, not run the wrong body);
 *  - a null receiver after the recompile (NPE from the interpreter);
 *  - an interface site over a List iterator, the shape of Minecraft's GUI
 *    and entity loops, and an abstract-class site;
 *  - receivers alternating every call (a site that is polymorphic from the
 *    start must never be inlined).
 *
 * Output lines start with "profiled" and must be identical with and without
 * the JIT, and with ZeroWasmJITProfileRecompile=0.
 */
public class JitProfiled {
    interface Shape { int area(); int side(); }
    record Sq(int s) implements Shape { public int area() { return s * s; } public int side() { return s; } }
    record Rect(int w, int h) implements Shape { public int area() { return w * h; } public int side() { return w + h; } }
    static abstract class Base { abstract long weight(long x); }
    static final class Light extends Base { long weight(long x) { return x + 1; } }
    static final class Heavy extends Base { long weight(long x) { return x * 3 - 7; } }

    static int sumAreas(Shape[] a) {
        int t = 0;
        for (Shape s : a) t += s.area() + s.side();
        return t;
    }

    static long sumIter(List<Shape> list) {
        long t = 0;
        for (Iterator<Shape> it = list.iterator(); it.hasNext(); ) {
            Shape s = it.next();
            t = t * 31 + s.area();
        }
        return t;
    }

    static long weigh(Base b, long x) { return b.weight(x); }

    static int areaOf(Shape s) { return s.area(); }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 40000;
        Shape[] mono = new Shape[16];
        for (int i = 0; i < mono.length; i++) mono[i] = new Sq(i + 1);
        List<Shape> list = new ArrayList<>();
        for (int i = 0; i < 24; i++) list.add(new Sq(i % 7));

        // Phase 1: monomorphic, long enough for compile, profile, recompile.
        long a = 0, b = 0, c = 0;
        for (int r = 0; r < rounds; r++) {
            a += sumAreas(mono);
            b ^= sumIter(list) + r;
            c += weigh(new Light(), r);
        }
        System.out.println("profiled mono " + a + " " + b + " " + c);

        // Phase 2: the same sites now see a second class.
        Shape[] mixed = mono.clone();
        mixed[5] = new Rect(3, 4);
        mixed[11] = new Rect(2, 9);
        list.set(3, new Rect(5, 6));
        long d = 0, e = 0, f = 0;
        for (int r = 0; r < rounds / 4; r++) {
            d += sumAreas(mixed);
            e ^= sumIter(list) + r;
            f += weigh((r & 3) == 0 ? new Heavy() : new Light(), r);
        }
        System.out.println("profiled mixed " + d + " " + e + " " + f);

        // Phase 3: a null receiver at a profiled site.
        int npes = 0;
        for (int r = 0; r < 1000; r++) {
            try { areaOf(r % 250 == 0 ? null : mono[r & 15]); } catch (NullPointerException ex) { npes++; }
        }
        for (int r = 0; r < rounds; r++) areaOf(mono[r & 15]);
        try { areaOf(null); } catch (NullPointerException ex) { npes++; }
        System.out.println("profiled npe " + npes);

        // Phase 4: polymorphic from the first call.
        Shape[] alt = { new Sq(2), new Rect(1, 5) };
        long g = 0;
        for (int r = 0; r < rounds; r++) g += areaOf(alt[r & 1]) * (long) r;
        System.out.println("profiled alternating " + g);
    }
}
