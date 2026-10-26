/**
 * A ternary's second arm that loads a local, followed by another local load
 * that is the arms' join: `set(x, c ? 0 : h, z)`. The interpreter rewrites
 * the two iloads to fast_iload2, which spans the join, so the compiler must
 * read it as a single iload (bc_len) -- it refused the whole method before
 * (SurfaceSystem.buildSurface, the per-chunk surface loop, ran interpreted).
 *
 * Lines starting with "fused" must be identical with and without the JIT.
 */
public class JitFusedLoads {
    static int sink;
    static int set(int x, int y, int z) { return x * 961 + y * 31 + z; }

    static long column(boolean legacy, int n) {
        long h = 0;
        for (int i = 0; i < n; i++) {
            int x = i & 15, height = (i * 7) & 255, z = i >> 4;
            h = h * 31 + set(x, legacy ? 0 : height, z);           // iload height; iload z
            long w = i;
            h = h * 31 + set((int) w, legacy ? height : 1, z + x);
        }
        return h;
    }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 3000;
        long h = 0;
        for (int r = 0; r < rounds; r++) h = h * 131 + column((r & 3) == 0, 64);
        System.out.println("fused " + h);
    }
}
