import java.lang.reflect.Method;

/**
 * System.nanoTime and currentTimeMillis as the wasm JIT emits them (a call to
 * zwc_clock instead of the native): compiled values never run backwards, sit
 * between the native's (read reflectively, which keeps the native call) taken
 * in order, and both clocks advance at the same rate. Prints only verdicts,
 * so the output is the same with and without the JIT.
 */
public class JitClock {
    static long nanos() { return System.nanoTime(); }
    static long millis() { return System.currentTimeMillis(); }
    // Small enough for a frameless body.
    static long since(long t0) { return System.nanoTime() - t0; }

    public static void main(String[] args) throws Exception {
        Method nativeNanos = System.class.getMethod("nanoTime");
        Method nativeMillis = System.class.getMethod("currentTimeMillis");
        boolean monotonic = true, nanoOrder = true, milliOrder = true, frameless = true;
        long prev = nanos(), t0 = prev;
        for (int rep = 0; rep < 40; rep++) {
            for (int i = 0; i < 20_000; i++) {
                long t = nanos();
                if (t < prev) monotonic = false;
                prev = t;
                if (since(t0) < 0) frameless = false;
            }
            long a = nanos();
            long b = (Long) nativeNanos.invoke(null);
            long c = nanos();
            if (!(a <= b && b <= c)) nanoOrder = false;
            long ma = millis();
            long mb = (Long) nativeMillis.invoke(null);
            long mc = millis();
            if (!(ma <= mb && mb <= mc)) milliOrder = false;
        }
        long n0 = nanos(), m0 = millis();
        while (nanos() - n0 < 50_000_000L) { }
        long dn = (nanos() - n0) / 1_000_000L, dm = millis() - m0;
        System.out.println("clock monotonic " + monotonic);
        System.out.println("clock nano order " + nanoOrder);
        System.out.println("clock milli order " + milliOrder);
        System.out.println("clock frameless " + frameless);
        System.out.println("clock rates " + (Math.abs(dn - dm) <= 5));
        System.out.println("clock epoch " + (millis() > 1_700_000_000_000L));
    }
}
