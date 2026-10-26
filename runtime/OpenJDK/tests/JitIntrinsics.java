/**
 * Differential gate for the Math/Float/Double methods the wasm JIT emits as
 * instructions. The edge values are the point: NaN, -0.0, infinities,
 * MIN_VALUE, and rint's round-half-even.
 *
 * Results are compared with NaNs canonicalized. Java lets an implementation
 * quiet a signaling NaN (see Double.longBitsToDouble) and only promises "a
 * NaN" from Math, and wasm float instructions do quiet them -- as does this
 * port's interpreter for floats -- so payload bits are not a correctness
 * property here. Everything else, -0.0 included, is compared exactly.
 */
public class JitIntrinsics {
    static final double[] D = {0.0, -0.0, 1.5, -1.5, 2.5, -2.5, 0.49999999999999994, 1e308, -1e308,
        Double.MIN_VALUE, Double.NaN, Double.longBitsToDouble(0x7ff8000000000123L),
        Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, 3.999999999, -7.0000001, 1e16 + 1};
    static final float[] F = {0f, -0f, 1.25f, -1.75f, Float.NaN, Float.intBitsToFloat(0x7fc00123),
        Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, Float.MIN_VALUE, 3.4e38f};
    static final int[] I = {0, 1, -1, 42, -42, Integer.MAX_VALUE, Integer.MIN_VALUE};
    static final long[] L = {0, 1, -1, 1L << 40, -(1L << 40), Long.MAX_VALUE, Long.MIN_VALUE};

    static long d(double x) { return x != x ? 0x7ff8000000000000L : Double.doubleToRawLongBits(x); }
    static long f(float x) { return x != x ? 0x7fc00000 : Float.floatToRawIntBits(x); }

    // Each helper is small enough to be compiled on its own and inlined into
    // the loop that calls it, so both emission paths are exercised.
    static long doubles(double a, double b) {
        return d(Math.floor(a)) * 31 + d(Math.ceil(a)) * 17 + d(Math.rint(a)) * 13
             + d(Math.sqrt(a)) * 11 + d(Math.abs(a)) * 7 + d(Math.min(a, b)) * 5 + d(Math.max(a, b)) * 3
             + d(StrictMath.sqrt(b)) + Double.doubleToLongBits(a) * 19
             + d(Double.longBitsToDouble(Double.doubleToRawLongBits(b)));
    }
    static long floats(float a, float b) {
        return f(Math.abs(a)) * 7 + f(Math.min(a, b)) * 5 + f(Math.max(a, b)) * 3
             + Float.floatToIntBits(a) * 11L + f(Float.intBitsToFloat(Float.floatToRawIntBits(b)));
    }
    static long ints(int a, int b) { return Math.abs(a) * 7L + Math.min(a, b) * 5L + Math.max(a, b) * 3L; }
    static long longs(long a, long b) { return Math.abs(a) * 7 + Math.min(a, b) * 5 + Math.max(a, b) * 3; }
    static int mthFloor(double v) { return (int)Math.floor(v); }

    public static void main(String[] args) {
        long h = 0;
        for (int rep = 0; rep < 400; rep++) {
            for (double a : D) for (double b : D) h = h * 1_000_003 + doubles(a, b);
            for (float a : F) for (float b : F) h = h * 1_000_003 + floats(a, b);
            for (int a : I) for (int b : I) h = h * 1_000_003 + ints(a, b);
            for (long a : L) for (long b : L) h = h * 1_000_003 + longs(a, b);
            for (double a : D) h = h * 31 + mthFloor(a);
        }
        System.out.println("intrinsics " + h);
        StringBuilder sb = new StringBuilder();
        for (double a : D) sb.append(Long.toHexString(d(Math.rint(a)))).append(' ');
        System.out.println("rint " + sb.toString().hashCode());
    }
}
