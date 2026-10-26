import java.util.ArrayList;
import java.util.List;

/**
 * Framed calls whose callee's frame is built in wasm (ZeroWasmJITDisable bit
 * 4194304 turns them off): statically bound and profiled monomorphic sites
 * to callees that write the heap, so they have no frameless body. Covers
 * every result width and the narrowed ones, constructors, exceptions thrown
 * and caught on either side, callees that bail to the interpreter, garbage
 * collections while the caller holds references on its operand stack, a
 * second thread forcing safepoints, and recursion deep enough to throw
 * StackOverflowError.
 *
 * Lines starting with "framed" must be identical with and without the JIT.
 */
public class JitFramed {
    static int sink;
    static Object osink;

    static final class Cell {
        int i; long l; double d; Object o;
        Cell(int i, Object o) { this.i = i; this.o = o; sink += i; }
        int addI(int x) { i += x; return i; }
        long addL(long x) { l += x; return l; }
        double addD(double x) { d += x; return d; }
        float addF(float x) { i++; return x * 0.5f + i; }
        byte b(int x) { i ^= x; return (byte) (x * 37); }
        short s(int x) { i ^= x; return (short) (x * 1009); }
        char c(int x) { i ^= x; return (char) (x * 31); }
        boolean z(int x) { i ^= x; return (x & 3) == 1; }
        Object swap(Object x) { Object old = o; o = x; return old; }
        void v(int x) { i -= x; }
    }

    // Static callees that write a field: framed, never frameless.
    static int st(int x) { sink = x; return x * 3 + 1; }
    static long stL(long x, int y) { sink = y; return x * 7 + y; }
    static double stD(double x) { sink++; return x * 1.5; }

    static int thrower(int x) {
        sink = x;
        if (x % 97 == 0) throw new IllegalStateException("t" + x);
        return x + 1;
    }

    // A callee that allocates enough to collect while its caller holds
    // references on its operand stack and in its locals.
    static Object churn(int x) {
        sink = x;
        Object[] junk = null;
        for (int k = 0; k < 40; k++) junk = new Object[64];
        return junk.length + x > 0 ? new int[] { x } : null;
    }

    // A callee that bails: a monitor hands the body back to the interpreter.
    static int locked(Object lock, int x) {
        sink = x;
        synchronized (lock) { return x ^ 0x55; }
    }

    static int depth(int n) {
        sink = n;
        return n == 0 ? 0 : 1 + depth(n - 1);
    }

    static long run(Cell c, int r) {
        long h = 0;
        String keep = "k" + (r & 7);                     // a reference across calls
        h += st(r);
        h = h * 31 + stL(r, r & 15);
        h = h * 31 + (long) stD(r * 0.25);
        h = h * 31 + c.addI(r);
        h = h * 31 + c.addL(r * 3L);
        h = h * 31 + (long) c.addD(r * 0.5);
        h = h * 31 + (long) c.addF(r);
        h = h * 31 + c.b(r) + c.s(r) + c.c(r) + (c.z(r) ? 1 : 0);
        Object old = c.swap(keep);
        h = h * 31 + (old == null ? 0 : old.hashCode());
        c.v(r & 3);
        try {
            h = h * 31 + thrower(r);
        } catch (IllegalStateException e) {
            h = h * 31 + e.getMessage().length();
        }
        Object a = churn(r);
        h = h * 31 + ((int[]) a)[0] + keep.length();
        h = h * 31 + locked(c, r);
        Cell n = new Cell(r, keep);
        h = h * 31 + n.i + (n.o == keep ? 1 : 0);
        return h;
    }

    public static void main(String[] args) throws Exception {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 20000;
        Thread gc = new Thread(() -> {
            for (int k = 0; k < 200; k++) {
                List<int[]> l = new ArrayList<>();
                for (int j = 0; j < 2000; j++) l.add(new int[16]);
                osink = l;
                if ((k & 15) == 0) System.gc();
                Thread.yield();
            }
        });
        gc.start();
        Cell c = new Cell(1, null);
        long h = 0;
        for (int r = 0; r < rounds; r++) h = h * 131 + run(c, r);
        gc.join();
        System.out.println("framed run " + h + " cell " + c.i + " " + c.l + " " + c.d);

        int deep = 0;
        for (int r = 0; r < 3; r++) {
            try {
                deep = depth(1_000_000);
            } catch (StackOverflowError e) {
                deep = -1;
            }
        }
        System.out.println("framed deep " + deep);
        int ok = 0;
        for (int r = 0; r < 2000; r++) ok += depth(200) == 200 ? 1 : 0;
        System.out.println("framed shallow " + ok);
    }
}
