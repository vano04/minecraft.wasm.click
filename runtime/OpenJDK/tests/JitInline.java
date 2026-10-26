/**
 * The case inlining exists for: a loop whose body is nothing but small calls.
 * Interpreted, each of these builds a whole Zero frame to run three bytecodes.
 * getX/getY/getZ are final, so HotSpot rewrites the calls to
 * _fast_invokevfinal and they are statically bound; mix is invokestatic.
 */
public class JitInline {
    private final int x, y, z;
    JitInline(int x, int y, int z) { this.x = x; this.y = y; this.z = z; }

    final int getX() { return x; }
    final int getY() { return y; }
    final int getZ() { return z; }

    static int mix(int a, int b) { return (a * 31) ^ (b >>> 3); }

    static int hot(JitInline o, int n) {
        int acc = 0;
        for (int i = 0; i < n; i++) {
            acc += mix(o.getX() + i, o.getY()) ^ o.getZ();
        }
        return acc;
    }

    public static void main(String[] args) {
        int inner = args.length > 0 ? Integer.parseInt(args[0]) : 5000;
        int outer = args.length > 1 ? Integer.parseInt(args[1]) : 4000;
        JitInline o = new JitInline(7, 11, 13);
        long sum = 0;
        long t0 = System.nanoTime();
        for (int r = 0; r < outer; r++) sum += hot(o, inner);
        long t1 = System.nanoTime();
        System.out.println("inline " + (t1 - t0) / 1_000_000L + " ms   checksum " + sum);
    }
}
