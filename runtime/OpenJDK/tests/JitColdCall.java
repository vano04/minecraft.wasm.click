/**
 * Calls never taken as cold paths in inlined callees (ZeroWasmJITDisable bit
 * 16777216 turns it off): a small cache whose get() calls a store-heavy
 * load() only on a miss. After a long run with no misses, the callers inline
 * get() with the load() call as a guard; then misses come back, and every
 * one must re-execute the whole call in the interpreter, nothing done twice.
 *
 * Lines starting with "coldcall" must be identical with and without the JIT.
 */
public class JitColdCall {
    static final class Cache {
        final Object[] slots = new Object[256];
        int misses;
        Object get(int k) {
            Object v = slots[k & 255];
            if (v == null) return load(k);
            return v;
        }
        Object load(int k) {
            misses++;
            Object v = "v" + (k & 255);
            slots[k & 255] = v;
            return v;
        }
        void clear(int from) { for (int i = from; i < 256; i++) slots[i] = null; }
    }

    static int sink;
    static int use(Cache c, int k) {
        Object v = c.get(k);
        sink += 1;                        // a store: not frameless
        return v.hashCode() & 0xff;
    }

    public static void main(String[] args) {
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 300000;
        Cache c = new Cache();
        long h = 0;
        for (int i = 0; i < 256; i++) h += use(c, i);            // fill
        for (int r = 0; r < 4; r++)                               // steady: no misses
            for (int i = 0; i < n; i++) h = h * 31 + use(c, i);
        System.out.println("coldcall steady " + h + " misses " + c.misses);
        for (int r = 0; r < 20; r++) {                            // misses come back
            c.clear(128 + (r & 7) * 16);
            for (int i = 0; i < 5000; i++) h = h * 31 + use(c, i * 7 + r);
        }
        System.out.println("coldcall misses " + h + " misses " + c.misses + " sink " + sink);
    }
}
