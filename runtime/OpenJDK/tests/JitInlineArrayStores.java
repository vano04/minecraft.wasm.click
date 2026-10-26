/**
 * Primitive array stores inside inlined callees, undo-logged: when a later
 * guard in the splice fires -- a cold throw, a class guard, a bounds check --
 * the whole call runs again in the interpreter, so every element the splice
 * already wrote must be put back first or it is written twice. Covers every
 * primitive element type, stores before a throw, read-modify-write elements,
 * two stores to the same element, and a receiver class change after warm-up.
 *
 * Lines starting with "astore" must be identical with and without the JIT.
 */
public class JitInlineArrayStores {
    static final class Buf {
        final byte[] b = new byte[64];
        final int[] i = new int[16];
        final long[] l = new long[8];
        final float[] f = new float[8];
        final double[] d = new double[8];
        final char[] c = new char[8];
        final short[] s = new short[8];

        // Four byte stores, then a cold throw: a bail after the stores.
        void putInt(int at, int v) {
            b[at] = (byte) v;
            b[at + 1] = (byte) (v >>> 8);
            b[at + 2] = (byte) (v >>> 16);
            b[at + 3] = (byte) (v >>> 24);
            if (v == 0x7fff_fff0) throw new IllegalStateException("v" + at);
        }
        // Read-modify-write twice on one element, then a bounds-checked store
        // that fails for a bad index after the first two ran.
        void bump(int k, int extra) {
            i[k & 15] += 3;
            i[k & 15] *= 2;
            i[extra] = k;
        }
        void wide(int k, long v) {
            l[k & 7] += v;
            d[k & 7] = d[k & 7] * 0.5 + v;
            f[k & 7] -= 1.25f;
            c[k & 7] = (char) (c[k & 7] + 7);
            s[k & 7] = (short) (s[k & 7] - 3);
            if (v < 0) throw new ArithmeticException("n");
        }
        long hash() {
            long h = 0;
            for (byte x : b) h = h * 31 + x;
            for (int x : i) h = h * 31 + x;
            for (long x : l) h = h * 31 + x;
            for (float x : f) h = h * 31 + Float.floatToIntBits(x);
            for (double x : d) h = h * 31 + Double.doubleToLongBits(x);
            for (char x : c) h = h * 31 + x;
            for (short x : s) h = h * 31 + x;
            return h;
        }
    }

    interface Sink { void put(Buf b, int k); }
    static final class A implements Sink { public void put(Buf b, int k) { b.putInt((k * 4) & 60, k); } }
    static final class B implements Sink { public void put(Buf b, int k) { b.putInt((k * 4) & 60, ~k); b.i[k & 15]--; } }

    static int step(Buf b, Sink s, int k) {
        int caught = 0;
        s.put(b, k);
        try { b.putInt((k * 8) & 60, k == 5000 ? 0x7fff_fff0 : k * 3); } catch (IllegalStateException e) { caught++; }
        try { b.bump(k, (k % 997 == 0) ? 99 : k & 15); } catch (ArrayIndexOutOfBoundsException e) { caught += 2; }
        try { b.wide(k, (k % 1231 == 0) ? -1 : k); } catch (ArithmeticException e) { caught += 4; }
        return caught;
    }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 200000;
        Buf b = new Buf();
        Sink a = new A(), bb = new B();
        long caught = 0;
        for (int k = 0; k < rounds; k++) caught += step(b, a, k);
        System.out.println("astore warm " + b.hash() + " " + caught);
        for (int k = 0; k < rounds / 4; k++) caught += step(b, (k % 3 == 0) ? bb : a, k);
        System.out.println("astore mixed " + b.hash() + " " + caught);
    }
}
