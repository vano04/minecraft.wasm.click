/**
 * Differential test for the wasm JIT: every method here is run with
 * -XX:+UseZeroWasmJIT on and off, and the printed lines must be byte-identical.
 *
 * The cases are chosen where a bytecode-to-wasm translation is most likely to
 * be subtly wrong rather than obviously broken: shift counts above 31 (Java
 * masks to 5 bits, and so does wasm -- but only for i32), signed vs unsigned
 * shifts, overflow, negative operands, division-free but branch-dense control
 * flow, loops that exceed the back-edge budget so the trace bails mid-loop and
 * the interpreter finishes it, and empty loop bodies.
 */
public class JitDiff {
    static int shifts(int x) {
        int a = x << 33, b = x >> 33, c = x >>> 33;      // counts masked to 5 bits
        return a ^ b ^ c ^ (x << 31) ^ (x >> 31) ^ (x >>> 31);
    }

    static int overflow(int n) {
        int acc = 1;
        for (int i = 0; i < n; i++) acc = acc * 31 + i;   // wraps repeatedly
        return acc;
    }

    static int branches(int x) {
        int r = 0;
        for (int i = -20; i < x; i++) {
            if (i < 0) r += 1;
            else if (i == 0) r += 2;
            else if (i > 100) r += 3;
            else r += i & 7;
            if ((i & 3) == 0) r ^= i;
        }
        return r;
    }

    static int nested(int n) {
        int r = 0;
        for (int i = 0; i < n; i++)
            for (int j = 0; j < i; j++)
                r += (i * j) ^ (i - j);
        return r;
    }

    // Longer than ZeroWasmJITBackedgeBudget, so the trace runs out of budget
    // and the interpreter must finish the loop from exactly where it stopped.
    static int longLoop(int n) {
        int acc = 0;
        for (int i = 0; i < n; i++) acc += i ^ (i >>> 7);
        return acc;
    }

    static int emptyLoop(int n) {
        int i = 0;
        while (i < n) i++;
        return i;
    }

    static int negatives(int x) {
        int r = -x;
        r = -r + (-1 * x) - (x & -1);
        return r ^ -x;
    }

    // Field access: every width the JIT emits a different load/store for, and
    // sub-word fields are where a wrong signed/unsigned choice hides.
    int fi; byte fb; short fs; char fc; boolean fz;

    int fields(int n) {
        int r = 0;
        for (int i = 0; i < n; i++) {
            fi = i * 7;
            fb = (byte) (i * 13);       // wraps and goes negative
            fs = (short) (i * 1013);
            fc = (char) (i * 1013);     // same bits as fs, read unsigned
            fz = (i & 1) == 0;
            r += fi + fb + fs + fc + (fz ? 1 : 0);
        }
        return r;
    }

    static int nullField(JitDiff o, int n) {
        int r = 0;
        for (int i = 0; i < n; i++) r += o.fi + i;   // o is null on the last call
        return r;
    }

    // Inlined callees with control flow: the shape where the operand stack at
    // a branch target has to be found in the caller's slots, not the callee's.
    static int clamp(int v, int lo, int hi) {
        if (v < lo) return lo;
        if (v > hi) return hi;
        return v;
    }
    static int sign(int v) { if (v < 0) return -1; if (v > 0) return 1; return 0; }
    final int scaled(int i) { return clamp(i - 50, 0, fi & 255) + sign(i - 20); }

    int inlined(int n) {
        int r = 0;
        for (int i = 0; i < n; i++) { fi = i; r += scaled(i) ^ clamp(i, 3, 9); }
        return r;
    }

    // Arrays: every element width, plus the two exception paths, which the
    // JIT must hand back for rather than raise itself.
    static int arrays(int n) {
        int[] ai = new int[16];
        byte[] ab = new byte[16];
        char[] ac = new char[16];
        short[] as = new short[16];
        int r = 0;
        for (int i = 0; i < n; i++) {
            int k = i & 15;
            ai[k] = i * 7;
            ab[k] = (byte) (i * 13);
            ac[k] = (char) (i * 1013);
            as[k] = (short) (i * 1013);
            r += ai[k] + ab[k] + ac[k] + as[k] + ai.length;
        }
        return r;
    }

    static int oob(int[] a, int i) { return a[i]; }
    static int constants(int n) {
        int r = 0;
        for (int i = 0; i < n; i++) r += (i ^ 1234567) + 987654321;
        return r;
    }

    public static void main(String[] args) {
        StringBuilder sb = new StringBuilder();
        for (int r = 0; r < 600; r++) {   // well past the compile threshold
            for (int x = -3; x <= 3; x++) {
                sb.setLength(0);
                sb.append(shifts(x * 12345)).append(' ')
                  .append(overflow(50 + x)).append(' ')
                  .append(branches(40 + x)).append(' ')
                  .append(nested(30 + x)).append(' ')
                  .append(longLoop(25000 + x)).append(' ')
                  .append(emptyLoop(1000 + x)).append(' ')
                  .append(negatives(x * 7919)).append(' ')
                  .append(new JitDiff().fields(300 + x)).append(' ')
                  .append(nullField(new JitDiff(), 40 + x)).append(' ')
                  .append(new JitDiff().inlined(400 + x)).append(' ')
                  .append(arrays(300 + x)).append(' ')
                  .append(constants(300 + x));
                if (r == 599) System.out.println("x=" + x + ": " + sb);
            }
            // The guarded path: a null receiver must still throw NPE from the
            // interpreter, at the right bci, after the JIT has compiled the
            // method. Compiled code emits the check and hands back.
            if (r == 599) {
                try {
                    nullField(null, 10);
                    System.out.println("npe: MISSING");
                } catch (NullPointerException e) {
                    System.out.println("npe: thrown");
                }
                int[] small = new int[4];
                for (int w = 0; w < 400; w++) oob(small, w & 3);   // make it hot
                try {
                    oob(small, 9);
                    System.out.println("aioobe: MISSING");
                } catch (ArrayIndexOutOfBoundsException e) {
                    System.out.println("aioobe: " + e.getMessage());
                }
                try {
                    oob(null, 0);
                    System.out.println("array-npe: MISSING");
                } catch (NullPointerException e) {
                    System.out.println("array-npe: thrown");
                }
            }
        }
    }
}
