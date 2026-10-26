import java.util.Iterator;

/**
 * Calls on `this` inside inlined callees: once a profiled call site has
 * inlined a receiver class's method behind a class guard, the receiver's
 * class is exact inside that splice, and virtual or interface calls on
 * `this` there are bound through it without a profile of their own
 * (ZeroWasmJITDisable bit 268435456 turns this off). Covers chains of
 * interface default methods, bridge methods, private methods on `this`
 * passing the exact class on, an override the guard must catch when a
 * subclass arrives after warm-up, and calls on another object of the same
 * type, which must not be bound to `this`'s class.
 *
 * Lines starting with "exact" must be identical with and without the JIT.
 */
public class JitExactThis {
    interface Height {
        int minY();
        int height();
        default int maxY() { return minY() + height() - 1; }
        default boolean outside(int y) { return y < minY() || y > maxY(); }
        default int section(int y) { return sectionFromY(y >> 4); }
        default int sectionFromY(int sy) { return sy - (minY() >> 4); }
    }

    interface Named { default int tag() { return 7; } }

    static class Box implements Height, Named {
        final int min, h;
        int writes;
        Box(int min, int h) { this.min = min; this.h = h; }
        public int minY() { return min; }
        public int height() { return h; }
        int get(int y) {
            if (outside(y)) return -1;
            return section(y) * 31 + tag() + probe(y);
        }
        private int probe(int y) { return (y & 15) + maxY(); }
        // A call on another Box: bound only by its own profile or class.
        int pair(Box other, int y) { return get(y) + other.minY() * 3 + other.tag(); }
    }

    // Arrives after warm-up: overrides a method the inlined chain calls on
    // `this`, so the guard on Box must send it elsewhere.
    static class TallBox extends Box {
        TallBox(int min, int h) { super(min, h); }
        @Override public int minY() { return min - 16; }
        @Override public int tag() { return 9; }
    }

    static final class Words implements Iterator<String> {
        int left;
        Words(int n) { left = n; }
        public boolean hasNext() { return left > 0; }
        public String next() { left--; return left % 3 == 0 ? "ab" : "c"; }  // bridge next()Object
    }

    static int total(Iterator<String> it) {
        int n = 0;
        while (it.hasNext()) n += it.next().length();
        return n;
    }

    static long use(Box b, Box o, int i) {
        long h = b.get(i % 400 - 80);
        h = h * 31 + b.pair(o, i % 300 - 64);
        h = h * 31 + (b.outside(i % 500 - 100) ? 1 : 0);
        h = h * 31 + b.section(i % 320 - 64);
        return h;
    }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 200000;
        Box a = new Box(-64, 384), b = new Box(0, 256);
        TallBox t = new TallBox(-32, 128);
        long h = 0;
        for (int i = 0; i < rounds; i++) h = h * 131 + use((i & 1) == 0 ? a : b, (i & 2) == 0 ? a : b, i);
        System.out.println("exact warm " + h);
        long g = 0;
        for (int i = 0; i < rounds / 4; i++) {
            Box x = (i % 5 == 0) ? t : a;
            Box y = (i % 7 == 0) ? t : b;
            g = g * 131 + use(x, y, i);
        }
        System.out.println("exact mixed " + g);
        int w = 0;
        for (int i = 0; i < rounds / 20; i++) w += total(new Words(i % 9));
        System.out.println("exact words " + w);
    }
}
