/**
 * Direct calls from compiled code into another compiled method's frameless
 * body, without zwc_invoke (ZeroWasmJITDisable bit 524288 turns them off).
 * The callees are warmed first so their frameless bodies exist when the
 * callers compile; then every way the fast path can be wrong:
 *
 *  - results of every width, narrowed as the interpreter does, from int,
 *    long, float and double arguments;
 *  - a virtual site that turns polymorphic after its profiled recompile
 *    (the class check must send it the long way);
 *  - a null receiver (the interpreter throws);
 *  - a callee that asks to be retried (it allocates);
 *  - a recursion a thousand deep through a direct call site. Kept well
 *    short of a StackOverflowError: the stack pads that make one fire
 *    before the engine's stack runs out (ZeroWasmJITFramePad,
 *    ZeroWasmInterpreterFramePad) put the JIT's limit and the
 *    interpreter's at different depths.
 *
 * Lines starting with "direct" must be identical with and without the JIT.
 */
public class JitDirect {
    // Each has a loop, so the inliner leaves it alone and it is called: the
    // direct path is what is under test.
    static boolean z(int x) { for (int k = 0; k < 2; k++) x += k; return (x & 3) == 1; }
    static byte b(int x) { for (int k = 0; k < 2; k++) x += k; return (byte) (x * 37); }
    static char c(int x) { for (int k = 0; k < 2; k++) x += k; return (char) (x * 131); }
    static short s(int x) { for (int k = 0; k < 2; k++) x += k; return (short) (x * 1009); }
    static int i(int x, long y) { for (int k = 0; k < 2; k++) x += k; return x * 7 + (int) (y >>> 3); }
    static long l(long x, int y) { for (int k = 0; k < 2; k++) y += k; return x * 31 + y; }
    static float f(float x, double y) { for (int k = 0; k < 2; k++) x += k; return x * 0.5f + (float) y; }
    static double d(double x, float y) { for (int k = 0; k < 2; k++) y += k; return x / 3.0 + y; }
    static int[] alloc(int x) { return new int[x & 7]; }       // frameless, but retries

    static abstract class Op { abstract int apply(int x); }
    static final class Add extends Op { final int k; Add(int k) { this.k = k; } int apply(int x) { return x + k; } }
    static final class Mul extends Op { final int k; Mul(int k) { this.k = k; } int apply(int x) { return x * k; } }

    static long widths(int r) {
        long h = 0;
        h = h * 3 + (z(r) ? 1 : 0);
        h = h * 3 + b(r);
        h = h * 3 + c(r);
        h = h * 3 + s(r);
        h = h * 3 + i(r, r * 11L);
        h = h * 3 + l(r * 13L, r);
        h = h * 3 + Float.floatToIntBits(f(r * 0.25f, r * 1.5));
        h = h * 3 + Double.doubleToLongBits(d(r * 0.75, r * 0.5f));
        h = h * 3 + alloc(r).length;
        return h;
    }

    static int applyOp(Op op, int x) { return op.apply(x); }

    static int depth(Op op, int n) { return n == 0 ? 0 : applyOp(op, depth(op, n - 1)); }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 30000;
        // Warm the callees on their own first.
        long warm = 0;
        for (int r = 0; r < 2000; r++) {
            warm += (z(r) ? 1 : 0) + b(r) + c(r) + s(r) + i(r, r) + l(r, r) + (long) f(r, r) + (long) d(r, r) + alloc(r).length;
        }
        long h = 0;
        for (int r = 0; r < rounds; r++) h = h * 31 + widths(r);
        System.out.println("direct widths " + warm + " " + h);

        Op add = new Add(3), mul = new Mul(5);
        for (int r = 0; r < 2000; r++) add.apply(r);           // Add.apply compiled first
        long a = 0;
        for (int r = 0; r < rounds; r++) a += applyOp(add, r);  // monomorphic: profiled + direct
        for (int r = 0; r < rounds; r++) a += applyOp((r & 1) == 0 ? add : mul, r);   // now polymorphic
        System.out.println("direct virtual " + a);

        int npe = 0;
        for (int r = 0; r < 500; r++) {
            try { a += applyOp(r % 100 == 0 ? null : add, r); } catch (NullPointerException e) { npe++; }
        }
        System.out.println("direct npe " + npe + " " + a);

        long deep = 0;
        for (int r = 0; r < 20; r++) deep += depth(add, 1000 + r);
        System.out.println("direct deep " + deep);
    }
}
