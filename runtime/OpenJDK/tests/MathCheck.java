/** Correctness gate for the Zero math entry: every intrinsic kind, against
 *  values computed by the same JDK on the host. */
public class MathCheck {
    static int bad = 0;

    /** Exact equality: required of StrictMath, and of the operations the spec
     *  defines exactly (sqrt, abs, fma). */
    static void eq(String what, double got, double want) {
        boolean ok = (Double.isNaN(want) && Double.isNaN(got)) || Double.compare(got, want) == 0;
        if (!ok) { System.out.println("MISMATCH " + what + ": got " + got + " want " + want); bad++; }
    }

    /** Math's transcendental methods are allowed 1 ulp and need not be
     *  reproducible across platforms, so the platform libm is a valid backing
     *  implementation — which is exactly what every other HotSpot port uses. */
    static void near(String what, double got, double want) {
        long ulps = Math.abs(Double.doubleToLongBits(got) - Double.doubleToLongBits(want));
        if (!(Double.compare(got, want) == 0 || ulps <= 1)) {
            System.out.println("MISMATCH " + what + ": got " + got + " want " + want + " (" + ulps + " ulp)");
            bad++;
        }
    }

    public static void main(String[] a) {
        eq("sqrt(2)", Math.sqrt(2.0), 1.4142135623730951);
        eq("sqrt(0)", Math.sqrt(0.0), 0.0);
        eq("sqrt(-1)", Math.sqrt(-1.0), Double.NaN);
        eq("sqrt(inf)", Math.sqrt(Double.POSITIVE_INFINITY), Double.POSITIVE_INFINITY);
        eq("strictSqrt(2)", StrictMath.sqrt(2.0), 1.4142135623730951);
        near("sin(1)", Math.sin(1.0), 0.8414709848078965);
        near("cos(1)", Math.cos(1.0), 0.5403023058681398);
        near("tan(1)", Math.tan(1.0), 1.5574077246549023);
        near("log(2)", Math.log(2.0), 0.6931471805599453);
        eq("log10(1000)", Math.log10(1000.0), 3.0);
        near("exp(1)", Math.exp(1.0), 2.7182818284590455);
        eq("abs(-3.5)", Math.abs(-3.5), 3.5);
        near("cbrt(27)", Math.cbrt(27.0), 3.0);
        eq("pow(2,10)", Math.pow(2.0, 10.0), 1024.0);
        eq("pow(9,0.5)", Math.pow(9.0, 0.5), 3.0);
        eq("fma(2,3,4)", Math.fma(2.0, 3.0, 4.0), 10.0);
        eq("fmaF(2,3,4)", Math.fma(2.0f, 3.0f, 4.0f), 10.0f);

        // The stack must be left in the right state: use results in further work.
        double acc = 0;
        for (int i = 1; i <= 1000; i++) acc += Math.sqrt(i) + Math.pow(i, 0.5);
        near("loop", Math.round(acc * 1e6) / 1e6, 42194.911775);

        System.out.println(bad == 0 ? "MATH OK" : bad + " MISMATCHES");
    }
}
