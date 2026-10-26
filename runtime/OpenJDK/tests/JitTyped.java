/**
 * Differential gate for inlining callees that use float, long and double:
 * typed parameters, typed locals, typed returns, typed values merging at a
 * ternary, nesting, and a bail inside an inlined typed callee (which must put
 * the caller's typed arguments back exactly before the interpreter re-executes
 * the call). Run it interpreted and with -XX:+UseZeroWasmJIT; the output must
 * be identical.
 */
public class JitTyped {
    static double lerp(double t, double a, double b) { return a + t * (b - a); }
    static double lerp2(double tx, double ty, double a, double b, double c, double d) {
        return lerp(ty, lerp(tx, a, b), lerp(tx, c, d));
    }
    static int floor(double d) { int i = (int)d; return d < i ? i - 1 : i; }
    static long lfloor(double d) { long l = (long)d; return d < l ? l - 1L : l; }
    static float fmix(float a, float b, int w) { float t = w / 16f; return a * (1f - t) + b * t; }
    static double pick(boolean c, double a, double b) { return c ? a : b; }
    static long mixLong(long a, int b) { return (a << b) ^ (a >>> 3) + b; }
    static double poly(double x) { double y = x * x; double z = y * x; return z - y + 1.0; }
    static float fl(float x) { float y = x * 2f; return y - 1f; }
    static int sign(double d) { return d > 0 ? 1 : d < 0 ? -1 : 0; }
    static double at(double[] arr, int i, double add) { return arr[i] + add; }
    static long lat(long[] arr, int i, long add) { return arr[i] ^ add; }
    static double smooth(double t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
    static double grad(int h, double x, double y, double z) {
        int k = h & 15;
        double u = k < 8 ? x : y;
        double v = k < 4 ? y : (k == 12 || k == 14 ? x : z);
        return ((k & 1) == 0 ? u : -u) + ((k & 2) == 0 ? v : -v);
    }

    static double kernel(int i, double[] arr, long[] larr) {
        double x = i * 0.37 - 11.0;
        double s = 0;
        s += lerp(x * 0.01, 3.0, -7.5);
        s += lerp2(x * 0.02, x * 0.03, 1.0, 2.0, 3.0, 4.0);
        s += floor(x) + lfloor(x * 3.3);
        s += fmix(1.5f, -2.25f, i & 15);
        s += pick((i & 1) == 0, x, -x);
        s += mixLong(i * 0x9E3779B97F4A7C15L, i & 31) & 0xFFFF;
        s += poly(x * 0.1);
        s += fl((float)x);
        s += sign(x);
        s += smooth((i & 127) / 128.0);
        s += grad(i, x, x * 0.5, x * 0.25);
        s += at(arr, i & 7, x);
        s += lat(larr, i & 7, (long)i) & 0xFF;
        return s;
    }

    public static void main(String[] args) {
        double[] arr = {0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5};
        long[] larr = {1, 22, 333, 4444, 55555, 666666, 7777777, 88888888};
        double total = 0;
        for (int i = 0; i < 20000; i++) total += kernel(i, arr, larr);
        System.out.println("typed total=" + total);

        // Bails inside inlined typed callees: out-of-bounds and null arrays.
        // The interpreter re-executes the call with the caller's arguments,
        // so the exception message names the index passed in, exactly.
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 3000; i++) {
            try {
                total += at(i % 1000 == 999 ? null : arr, i % 500 == 499 ? 8 + (i & 3) : i & 7, i * 0.5);
                total += lat(larr, i % 700 == 699 ? -1 : i & 7, i);
            } catch (ArrayIndexOutOfBoundsException | NullPointerException e) {
                sb.append(e.getClass().getSimpleName()).append(':').append(e.getMessage()).append(';');
            }
        }
        System.out.println("typed bails=" + sb.length() + " " + sb.toString().hashCode() + " total=" + total);
        System.out.println("typed first=" + sb.substring(0, Math.min(200, sb.length())));
    }
}
