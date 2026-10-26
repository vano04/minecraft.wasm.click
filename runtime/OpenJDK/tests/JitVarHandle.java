import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReferenceArray;

/**
 * Reads through a VarHandle over a reference array and volatile long fields,
 * which the JIT emits as code under -XX:ZeroWasmJITIndyFast bit 1 (see
 * emit_vh_array and field_shape in zeroWasmCompiler.cpp). Every access mode
 * the fast path takes (get, getVolatile, getAcquire, getOpaque), through
 * AtomicReferenceArray and through handles of its own; the cases it must hand
 * back to the linked call -- a null array, indexes out of bounds either way, a
 * subtype array, a handle with exact behaviour, a handle of another class
 * reaching the same site, a result the site's return type rejects -- each with
 * the exception the JDK throws; volatile longs read and written by two threads
 * on a 32-bit boundary (a torn read would show a value never written); and a
 * thread forcing collections while compiled code reads elements that move.
 *
 * Lines starting with "vh" must be identical with and without the JIT.
 */
public class JitVarHandle {
    static final VarHandle OA = MethodHandles.arrayElementVarHandle(Object[].class);
    static final VarHandle SA = MethodHandles.arrayElementVarHandle(String[].class);
    static final VarHandle OA_EXACT = OA.withInvokeExactBehavior();
    static final VarHandle IA = MethodHandles.arrayElementVarHandle(int[].class);

    static final class Counter {
        int pad;
        volatile long v;
        volatile int i;
        long plain;
    }

    static final class Cell { final int v; Cell(int v) { this.v = v; } }

    static int val(Object o) {
        return o == null ? -1 : o instanceof Integer n ? n : o instanceof Cell c ? c.v : o.hashCode() & 0xff;
    }

    // AtomicReferenceArray's own reads: get is getVolatile, and the others.
    static long araModes(AtomicReferenceArray<Object> a, int i) {
        int n = a.length();
        return val(a.get(i % n)) * 31L + val(a.getPlain((i + 1) % n)) * 7L
            + val(a.getAcquire((i + 2) % n)) * 3L + val(a.getOpaque((i + 3) % n));
    }

    // The same modes through a handle of this class; the site returns Object.
    static long vhModes(Object[] arr, int i) {
        int n = arr.length;
        return val(OA.get(arr, i % n)) * 31L + val(OA.getVolatile(arr, (i + 1) % n)) * 7L
            + val(OA.getAcquire(arr, (i + 2) % n)) * 3L + val(OA.getOpaque(arr, (i + 3) % n));
    }

    // A site returning String: the result is cast, and an Integer in the
    // array is a ClassCastException from the linked call.
    static int castSite(Object[] arr, int i) {
        String s = (String) OA.getVolatile(arr, i);
        return s == null ? -1 : s.length();
    }

    // A String[] handle on a String[] array; a String[] array through the
    // Object[] handle (a subtype array, which only the linked call takes).
    static int stringArrays(String[] arr, int i) {
        String a = (String) SA.get(arr, i);
        Object b = OA.getAcquire(arr, (i + 1) % arr.length);
        return (a == null ? -1 : a.length()) * 10 + val(b);
    }

    // Whatever handle the caller passes: the site sees several classes.
    static Object anyHandle(VarHandle vh, Object[] arr, int i) {
        return vh.getVolatile(arr, i);
    }

    static String exactSite(String[] arr, int i) {
        return (String) OA_EXACT.get(arr, i);    // the exact type is (Object[],int)Object
    }

    static String describe(Throwable t) {
        if (t instanceof NullPointerException) return t.getClass().getName();
        return t.getClass().getName() + ": " + t.getMessage();
    }

    static long readLong(Counter c, int n) {
        long acc = 0;
        for (int k = 0; k < n; k++) acc += c.v + c.i;
        return acc;
    }

    static long writeLong(Counter c, int n) {
        for (int k = 0; k < n; k++) { c.v = c.v * 3 + k; c.plain += c.v; }
        return c.v ^ c.plain;
    }

    static long atomics(AtomicLong al, int n) {
        long acc = 0;
        for (int k = 0; k < n; k++) { al.set(al.get() + k); acc += al.get(); al.lazySet(al.getPlain() ^ 5); }
        return acc + al.get();
    }

    static final long LO = 0x00000000FFFFFFFFL, HI = 0x0000000100000000L;
    static volatile boolean stop;

    static int tornReads(Counter c) {
        int bad = 0;
        while (!stop) {
            long x = c.v;
            if (x != LO && x != HI) bad++;
        }
        return bad;
    }

    static int checkElements(AtomicReferenceArray<Object> a, Object[] expect) {
        int bad = 0;
        for (int i = 0; i < expect.length; i++) {
            Object o = a.get(i);
            if (o != expect[i] || (o != null && val(o) != i)) bad++;
        }
        return bad;
    }

    public static void main(String[] args) throws Exception {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 40000;
        AtomicReferenceArray<Object> ara = new AtomicReferenceArray<>(13);
        Object[] objs = new Object[13];
        String[] strs = new String[11];
        for (int i = 0; i < 13; i++) {
            Object o = (i % 4 == 0) ? null : Integer.valueOf(i * 3);
            ara.set(i, o);
            objs[i] = (i % 5 == 0) ? null : (i % 3 == 0) ? Integer.valueOf(i) : "s" + "x".repeat(i);
        }
        for (int i = 0; i < 11; i++) strs[i] = (i % 3 == 0) ? null : "t".repeat(i);

        long a = 0, b = 0, c = 0, d = 0;
        int cce = 0;
        String cceMsg = null;
        for (int r = 0; r < rounds; r++) {
            a = a * 31 + araModes(ara, r);
            b = b * 31 + vhModes(objs, r);
            try {
                c = c * 31 + castSite(objs, r % objs.length);
            } catch (ClassCastException e) {
                cce++;
                if (cceMsg == null) cceMsg = describe(e);
            }
            d = d * 31 + stringArrays(strs, r % strs.length);
        }
        System.out.println("vh modes ara=" + a + " handle=" + b);
        System.out.println("vh cast " + c + " cce=" + cce + " " + cceMsg);
        System.out.println("vh string arrays " + d);

        // Out of bounds both ways, and a null array, once each site is hot.
        int[] bad = { -1, 13, 14, Integer.MIN_VALUE, Integer.MAX_VALUE };
        for (int k : bad) {
            try { araModes(ara, 0); ara.get(k); System.out.println("vh bounds " + k + " none"); }
            catch (RuntimeException e) { System.out.println("vh bounds ara " + k + " " + describe(e)); }
            try { System.out.println("vh bounds handle " + k + " " + val(OA.getVolatile(objs, k))); }
            catch (RuntimeException e) { System.out.println("vh bounds handle " + k + " " + describe(e)); }
        }
        try { castSite(null, 0); } catch (RuntimeException e) { System.out.println("vh null " + describe(e)); }
        try { System.out.println("vh empty " + val(OA.getOpaque(new Object[0], 0))); }
        catch (RuntimeException e) { System.out.println("vh empty " + describe(e)); }

        // Several handles through one site.
        VarHandle[] hs = { OA, SA, OA_EXACT, IA };
        long any = 0;
        int[] fails = new int[hs.length];
        String[] firstFail = new String[hs.length];
        for (int r = 0; r < rounds; r++) {
            int h = (r % 7 == 0) ? (r / 7) % hs.length : 0;
            Object[] arr = (r % 3 == 0) ? strs : objs;
            try {
                any = any * 31 + val(anyHandle(hs[h], arr, r % 11));
            } catch (RuntimeException e) {
                fails[h]++;
                if (firstFail[h] == null) firstFail[h] = describe(e);
            }
        }
        System.out.println("vh any handle " + any);
        for (int h = 0; h < hs.length; h++) System.out.println("vh any handle " + h + " fails=" + fails[h] + " " + firstFail[h]);
        try { System.out.println("vh exact " + exactSite(strs, 1)); }
        catch (RuntimeException e) { System.out.println("vh exact " + describe(e)); }

        // Volatile longs.
        Counter ctr = new Counter();
        ctr.i = 7;
        long rl = 0, wl = 0;
        for (int r = 0; r < rounds / 100; r++) {
            ctr.v = r * 0x10000001L;
            rl = rl * 31 + readLong(ctr, 50);
            wl = wl * 31 + writeLong(ctr, 50);
        }
        AtomicLong al = new AtomicLong(1);
        long at = 0;
        for (int r = 0; r < rounds / 100; r++) at = at * 31 + atomics(al, 50);
        System.out.println("vh volatile long read=" + rl + " write=" + wl + " atomic=" + at);

        // Two threads on the 32-bit boundary: every read must be a value written.
        Counter shared = new Counter();
        shared.v = LO;
        int[] torn = new int[1];
        Thread reader = new Thread(() -> torn[0] = tornReads(shared));
        reader.start();
        for (int r = 0; r < rounds * 5; r++) shared.v = (r & 1) == 0 ? HI : LO;
        stop = true;
        reader.join();
        System.out.println("vh torn reads " + torn[0]);

        // Elements that move: a thread collects while compiled code reads.
        Object[] expect = new Object[64];
        AtomicReferenceArray<Object> moving = new AtomicReferenceArray<>(64);
        for (int i = 0; i < 64; i++) {
            expect[i] = (i % 5 == 0) ? null : new Cell(i);
            moving.set(i, expect[i]);
        }
        stop = false;
        Thread gc = new Thread(() -> {
            Object keep = null;
            for (int k = 0; !stop; k++) {
                keep = new byte[4096];
                if ((k & 1023) == 0) System.gc();
            }
            if (keep == null) System.out.println("unreachable");
        });
        gc.start();
        int moved = 0;
        for (int r = 0; r < rounds / 4; r++) moved += checkElements(moving, expect);
        stop = true;
        gc.join();
        System.out.println("vh moving elements bad=" + moved);
    }
}
