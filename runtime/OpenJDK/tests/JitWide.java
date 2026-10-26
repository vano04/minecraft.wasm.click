/**
 * Long and double arithmetic -- the shape of the leaves the in-world profile
 * is made of (LegacyRandomSource.next, Mth.floor). Checks the edges a
 * bytecode-to-wasm translation gets wrong: shift counts masked to 6 bits,
 * saturating d2i (wasm's plain trunc traps where Java clamps), NaN ordering
 * for dcmpl vs dcmpg, and long overflow.
 */
public class JitWide {
    static long seed = 12345L;

    static int next(int bits) {                 // LegacyRandomSource.next
        long m = seed * 25214903917L + 11L & 281474976710655L;
        seed = m;
        return (int) (m >>> (48 - bits));
    }

    static int floor(double d) {                // Mth.floor
        int i = (int) d;
        return d < i ? i - 1 : i;
    }

    static long longs(int n) {
        long acc = 1;
        for (int i = 0; i < n; i++) {
            acc = acc * 6364136223846793005L + 1442695040888963407L;
            acc ^= acc >>> 33;
            acc += (long) i << (i & 63);
            acc |= 1L;
            acc &= -3L;
            acc -= i;
        }
        return acc;
    }

    static double doubles(int n) {
        double acc = 1.5;
        for (int i = 0; i < n; i++) {
            acc = acc * 1.0000001 + i;
            acc = acc / 1.0000002 - 0.5;
            acc = -acc; acc = -acc;
        }
        return acc;
    }

    static int compares(int n) {
        int r = 0;
        double nan = Double.NaN;
        for (int i = 0; i < n; i++) {
            double a = i - 50;
            r += Long.compare((long) i, 25L);
            r += (a < nan ? 1 : 0) + (a > nan ? 2 : 0);      // dcmpl / dcmpg
            r += floor(a / 3.0) + (int) (a * 1e18) + (int) (long) (a * 1e30);
        }
        return r;
    }

    public static void main(String[] args) {
        StringBuilder sb = new StringBuilder();
        for (int r = 0; r < 500; r++) {
            seed = 12345L;
            long a = 0; for (int i = 0; i < 40; i++) a += next(24);
            long b = longs(200);
            double c = doubles(200);
            int d = compares(200);
            if (r == 499) {
                sb.append(a).append(' ').append(b).append(' ')
                  .append(Double.doubleToRawLongBits(c)).append(' ').append(d);
            }
        }
        System.out.println("wide: " + sb);
    }
}
