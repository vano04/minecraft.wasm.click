/**
 * The shape of Minecraft's density functions without Minecraft: a tree of
 * small records behind one interface, evaluated per point. Every node is a
 * megamorphic interface call; leaves do double arithmetic; a spline walks an
 * array. finalDensity is this shape, dozens of nodes deep.
 *
 *   java DensityBench [rounds] [grid]
 *
 * The checksum is the correctness gate.
 */
public class DensityBench {
    interface DF { double compute(int x, int y, int z); }

    record Const(double v) implements DF {
        public double compute(int x, int y, int z) { return v; }
    }
    record Add(DF a, DF b) implements DF {
        public double compute(int x, int y, int z) { return a.compute(x, y, z) + b.compute(x, y, z); }
    }
    record Mul(DF a, DF b) implements DF {
        public double compute(int x, int y, int z) {
            double l = a.compute(x, y, z);
            return l == 0.0 ? 0.0 : l * b.compute(x, y, z);
        }
    }
    record Clamp(DF in, double lo, double hi) implements DF {
        public double compute(int x, int y, int z) {
            double v = in.compute(x, y, z);
            return v < lo ? lo : v > hi ? hi : v;
        }
    }
    record YGradient(int fromY, int toY, double fromV, double toV) implements DF {
        public double compute(int x, int y, int z) {
            double t = (double)(y - fromY) / (toY - fromY);
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            return fromV + t * (toV - fromV);
        }
    }
    record Squeeze(DF in) implements DF {
        public double compute(int x, int y, int z) {
            double v = in.compute(x, y, z);
            v = v < -1 ? -1 : v > 1 ? 1 : v;
            return v / 2.0 - v * v * v / 24.0;
        }
    }
    /** Hash-based value noise with trilinear interpolation, ImprovedNoise-shaped. */
    record Noise(long seed, double xzScale, double yScale) implements DF {
        public double compute(int x, int y, int z) {
            double fx = x * xzScale, fy = y * yScale, fz = z * xzScale;
            int ix = floor(fx), iy = floor(fy), iz = floor(fz);
            double dx = smooth(fx - ix), dy = smooth(fy - iy), dz = smooth(fz - iz);
            double c000 = hash(ix, iy, iz), c100 = hash(ix + 1, iy, iz);
            double c010 = hash(ix, iy + 1, iz), c110 = hash(ix + 1, iy + 1, iz);
            double c001 = hash(ix, iy, iz + 1), c101 = hash(ix + 1, iy, iz + 1);
            double c011 = hash(ix, iy + 1, iz + 1), c111 = hash(ix + 1, iy + 1, iz + 1);
            return lerp(dz, lerp(dy, lerp(dx, c000, c100), lerp(dx, c010, c110)),
                            lerp(dy, lerp(dx, c001, c101), lerp(dx, c011, c111)));
        }
        double hash(int x, int y, int z) {
            long h = seed ^ (x * 0x9E3779B97F4A7C15L) ^ (y * 0xC2B2AE3D27D4EB4FL) ^ (z * 0x165667B19E3779F9L);
            h ^= h >>> 29; h *= 0xBF58476D1CE4E5B9L; h ^= h >>> 32;
            return (h & 0xFFFF) / 32768.0 - 1.0;
        }
        static int floor(double d) { int i = (int)d; return d < i ? i - 1 : i; }
        static double smooth(double t) { return t * t * t * (t * (t * 6 - 15) + 10); }
        static double lerp(double t, double a, double b) { return a + t * (b - a); }
    }
    /** A cubic-ish spline over a coordinate function, like TerrainProvider's. */
    record Spline(DF coord, double[] locs, double[] vals) implements DF {
        public double compute(int x, int y, int z) {
            double c = coord.compute(x, y, z);
            int i = 0;
            while (i < locs.length && locs[i] < c) i++;
            if (i == 0) return vals[0];
            if (i == locs.length) return vals[vals.length - 1];
            double t = (c - locs[i - 1]) / (locs[i] - locs[i - 1]);
            return vals[i - 1] + t * t * (3 - 2 * t) * (vals[i] - vals[i - 1]);
        }
    }

    static DF noise(long s, double xz, double y) { return new Noise(s, xz, y); }

    static DF tree() {
        DF continents = new Add(noise(1, 0.004, 0.0), new Mul(new Const(0.3), noise(2, 0.02, 0.0)));
        DF erosion = new Clamp(new Add(noise(3, 0.008, 0.0), noise(4, 0.03, 0.0)), -1, 1);
        DF ridges = new Squeeze(new Mul(noise(5, 0.012, 0.0), new Const(1.5)));
        DF offset = new Spline(continents, new double[] {-1.1, -0.5, -0.1, 0.2, 0.6},
                new double[] {-0.3, -0.1, 0.05, 0.2, 0.5});
        DF factor = new Spline(erosion, new double[] {-0.8, -0.2, 0.3, 0.7},
                new double[] {6.0, 4.0, 3.0, 2.5});
        DF depth = new Add(new YGradient(-64, 320, 1.5, -1.5), offset);
        DF base = new Mul(new Mul(depth, factor), new Const(0.5));
        DF detail = new Add(noise(6, 0.05, 0.1), new Mul(new Const(0.5), noise(7, 0.1, 0.2)));
        DF caves = new Clamp(new Add(noise(8, 0.03, 0.06), ridges), -0.5, 0.5);
        return new Squeeze(new Add(new Add(base, new Mul(new Const(0.2), detail)), caves));
    }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 5;
        int grid = args.length > 1 ? Integer.parseInt(args[1]) : 16;
        DF f = tree();
        for (int round = 0; round < rounds; round++) {
            long start = System.nanoTime();
            double sum = 0;
            int points = 0;
            for (int x = 0; x < grid; x++)
                for (int z = 0; z < grid; z++)
                    for (int y = -64; y < 320; y += 8) {
                        sum += f.compute(x * 4, y, z * 4);
                        points++;
                    }
            long ns = System.nanoTime() - start;
            System.out.printf("BENCH round=%d points=%d ms=%.1f us/point=%.2f checksum=%.6f%n",
                    round, points, ns / 1e6, ns / 1e3 / points, sum);
        }
    }
}
