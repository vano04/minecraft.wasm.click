import java.lang.ref.PhantomReference;
import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;

/**
 * Thread.currentThread(), Reference.refersTo0 and Object.getClass() as JIT
 * intrinsics:
 * ThreadLocal lookups on several threads (their maps hold WeakReference
 * entries), refersTo on weak and phantom references before and after the
 * referent is dropped and collected, and currentThread identity.
 *
 * Lines starting with "tl" must be identical with and without the JIT.
 */
public class JitThreadLocal {
    static final ThreadLocal<int[]> CELL = ThreadLocal.withInitial(() -> new int[1]);
    static final ThreadLocal<String> NAME = new ThreadLocal<>();

    static long lookups(int n, int salt) {
        long h = 0;
        for (int i = 0; i < n; i++) {
            int[] c = CELL.get();
            c[0] += i ^ salt;
            if ((i & 1023) == 0) NAME.set("n" + (i >> 10));
            String s = NAME.get();
            h = h * 31 + c[0] + (s == null ? 0 : s.length()) + (Thread.currentThread() == null ? 1 : 0);
        }
        return h;
    }

    static int refs(Object keep, int r) {
        WeakReference<Object> w = new WeakReference<>(keep);
        PhantomReference<Object> p = new PhantomReference<>(keep, new ReferenceQueue<>());
        Object other = new Object();
        return (w.refersTo(keep) ? 1 : 0) + (w.refersTo(other) ? 2 : 0) + (w.refersTo(null) ? 4 : 0)
             + (p.refersTo(keep) ? 8 : 0) + (p.refersTo(other) ? 16 : 0) + (r & 0);
    }

    enum Dir { N, E, S, W }
    static int classes(Object[] objs, java.util.EnumMap<Dir, Integer> m, int r) {
        int h = 0;
        for (Object o : objs) {
            h = h * 31 + (o.getClass() == String.class ? 1 : o.getClass() == Integer.class ? 2 : 3);
            h += o.getClass().getSimpleName().length();
        }
        Dir d = Dir.values()[r & 3];
        m.merge(d, 1, Integer::sum);
        return h + m.get(d) + (m.containsKey(Dir.W) ? 1 : 0);
    }
    static int npe(Object o) {
        try { return o.getClass().getName().length() & 1; } catch (NullPointerException e) { return 7; }
    }

    public static void main(String[] args) throws Exception {
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 200000;
        long[] out = new long[4];
        Thread[] ts = new Thread[3];
        for (int t = 0; t < 3; t++) {
            final int k = t;
            ts[t] = new Thread(() -> out[k] = lookups(n, k) ^ (Thread.currentThread() == ts[k] ? 7 : 0));
            ts[t].start();
        }
        out[3] = lookups(n, 3);
        for (Thread t : ts) t.join();
        System.out.println("tl lookups " + out[0] + " " + out[1] + " " + out[2] + " " + out[3]);
        long sum = 0;
        Object keep = new Object();
        for (int r = 0; r < n / 10; r++) sum += refs(keep, r);
        System.out.println("tl refs " + sum);
        WeakReference<Object> w = new WeakReference<>(new Object());
        Object other = new Object();
        for (int g = 0; g < 5 && !w.refersTo(null); g++) System.gc();
        int cleared = 0;
        for (int r = 0; r < 20000; r++) cleared += (w.refersTo(null) ? 1 : 0) + (w.refersTo(other) ? 2 : 0);
        System.out.println("tl cleared " + cleared + " current " + (Thread.currentThread().getName()));
        Object[] objs = { "a", 1, new int[0], Dir.S, 2.0 };
        java.util.EnumMap<Dir, Integer> em = new java.util.EnumMap<>(Dir.class);
        long ch = 0;
        for (int r = 0; r < n / 4; r++) ch = ch * 31 + classes(objs, em, r) + npe((r % 97) == 0 ? null : objs[r % 5]);
        System.out.println("tl classes " + ch + " " + em);
    }
}
