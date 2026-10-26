/**
 * Profiled inlining inside inlined callees (ZeroWasmJITDisable bit 8388608
 * turns it off): chains of small interface default methods, each calling the
 * next through the interface, the shape of Minecraft's LevelHeightAccessor
 * (getSectionIndex -> getMinSectionY -> getMinY). Each level is inlined behind
 * its own class guard. Midway the receivers change class, so guards deep in
 * the splice miss and the whole outer call must re-execute in the
 * interpreter with nothing done twice.
 *
 * Lines starting with "nested" must be identical with and without the JIT.
 */
public class JitNested {
    interface Height {
        int minY();
        int height();
        default int minSection() { return minY() >> 4; }
        default int maxSection() { return (minY() + height() - 1 >> 4) + 1; }
        default int sectionIndex(int y) { return (y >> 4) - minSection(); }
        default boolean inside(int y) { return y >= minY() && y < minY() + height(); }
        default int sections() { return maxSection() - minSection(); }
    }
    static final class Level implements Height {
        final int min, h;
        Level(int min, int h) { this.min = min; this.h = h; }
        public int minY() { return min; }
        public int height() { return h; }
    }
    static final class Chunk implements Height {
        final Height level;
        Chunk(Height level) { this.level = level; }
        public int minY() { return level.minY(); }
        public int height() { return level.height(); }
    }
    static final class Odd implements Height {
        public int minY() { return -7; }
        public int height() { return 33; }
        public int sectionIndex(int y) { return 1000 + y; }
    }

    static int sink;
    static long step(Height a, int y) {
        long r = a.sectionIndex(y) * 31L + a.sections();
        if (a.inside(y)) r ^= 0x55;
        sink += (int) r;                 // a store: the method is not frameless
        return r;
    }

    public static void main(String[] args) {
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 400000;
        Height lv = new Level(-64, 384);
        Height ch = new Chunk(lv);
        long h = 0;
        for (int i = 0; i < n; i++) h = h * 131 + step(ch, (i % 400) - 70);
        System.out.println("nested mono " + h);
        Height[] mix = { new Chunk(new Level(0, 256)), new Odd(), lv, new Chunk(new Odd()) };
        for (int i = 0; i < n / 4; i++) h = h * 131 + step(mix[(i >> 6) & 3], (i % 300) - 20);
        System.out.println("nested mixed " + h + " " + sink);
        for (int i = 0; i < n; i++) h = h * 131 + step(ch, (i % 400) - 70);
        System.out.println("nested again " + h);
    }
}
