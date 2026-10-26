/**
 * Floating-point remainder (frem, drem) compiled against interpreted: wasm has
 * no instruction for it, so compiled code calls the interpreter's own fmod.
 * Covers signed zeros, infinities, NaN, huge quotients, subnormals and the
 * wrapDegrees shape Minecraft ticks every entity with.
 *
 * Lines starting with "rem" must be identical with and without the JIT.
 */
public class JitRem {
    static float wrapDegrees(float value) {
        float f = value % 360.0F;
        if (f >= 180.0F) f -= 360.0F;
        if (f < -180.0F) f += 360.0F;
        return f;
    }

    static double wrapDegrees(double value) {
        double d = value % 360.0;
        if (d >= 180.0) d -= 360.0;
        if (d < -180.0) d += 360.0;
        return d;
    }

    static float frem(float a, float b) { return a % b; }
    static double drem(double a, double b) { return a % b; }

    static final float[] F = {0f, -0f, 1f, -1f, 0.5f, 360f, -360f, 179.99f, 180f, -180f, 1e30f, -1e30f,
            3.4028235e38f, 1.4e-45f, 1.17549435e-38f, Float.NaN, Float.POSITIVE_INFINITY,
            Float.NEGATIVE_INFINITY, 7.25f, -7.25f, 123456.789f, 1e-7f};
    static final double[] D = {0d, -0d, 1d, -1d, 0.5d, 360d, -360d, 179.99d, 180d, -180d, 1e300, -1e300,
            Double.MAX_VALUE, Double.MIN_VALUE, 2.2250738585072014e-308, Double.NaN,
            Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, 7.25d, -7.25d, 123456.789d, 1e-17};

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 3000;
        long hf = 0, hd = 0, hw = 0;
        for (int r = 0; r < rounds; r++) {
            for (float a : F) for (float b : F) hf = hf * 31 + Float.floatToRawIntBits(frem(a, b));
            for (double a : D) for (double b : D) hd = hd * 31 + Double.doubleToRawLongBits(drem(a, b));
            for (int i = -2000; i < 2000; i += 7) {
                hw = hw * 31 + Float.floatToRawIntBits(wrapDegrees(i * 0.73f + r));
                hw = hw * 31 + Double.doubleToRawLongBits(wrapDegrees(i * 0.73 - r));
            }
        }
        System.out.println("rem float " + hf);
        System.out.println("rem double " + hd);
        System.out.println("rem wrap " + hw);
    }
}
