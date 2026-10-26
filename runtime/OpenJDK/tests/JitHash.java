import java.util.IdentityHashMap;

/**
 * Object.hashCode and System.identityHashCode through the header fast path:
 * objects hashed before and after the method compiles, locked objects (the
 * hash is not in the header while locked), identityHashCode(null), and a
 * class that overrides hashCode at the same call site. Hash values differ
 * between VMs, so only relations between them are printed.
 */
public class JitHash {
    static final class Plain {}
    static final class Own { final int v; Own(int v) { this.v = v; } public int hashCode() { return v * 31; } }

    static int hashOf(Object o) { return o.hashCode(); }
    static int idOf(Object o) { return System.identityHashCode(o); }

    public static void main(String[] args) {
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 200000;
        Object[] objs = new Object[64];
        for (int i = 0; i < objs.length; i++) objs[i] = (i % 3 == 0) ? new Own(i) : new Plain();
        int stable = 0, idMatch = 0, own = 0, nulls = 0, locked = 0;
        int[] first = new int[objs.length];
        for (int i = 0; i < objs.length; i++) first[i] = hashOf(objs[i]);
        for (int r = 0; r < n; r++) {
            int k = r & 63;
            Object o = objs[k];
            int h = hashOf(o);
            if (h == first[k]) stable++;
            if (!(o instanceof Own) && idOf(o) == h) idMatch++;
            if (o instanceof Own && h == ((Own) o).v * 31) own++;
            if (idOf(null) == 0) nulls++;
            if ((r & 1023) == 0) {
                synchronized (o) { if (hashOf(o) == first[k] && idOf(o) == System.identityHashCode(o)) locked++; }
                objs[(r >> 10) & 63] = ((r >> 10) % 3 == 0) ? new Own(r) : new Plain();   // fresh, unhashed
                first[(r >> 10) & 63] = hashOf(objs[(r >> 10) & 63]);
            }
        }
        IdentityHashMap<Object, Integer> m = new IdentityHashMap<>();
        for (Object o : objs) m.put(o, 1);
        System.out.println("hash stable=" + stable + " idMatch=" + idMatch + " own=" + own + " nulls=" + nulls
                + " locked=" + locked + " identitySize=" + m.size());
    }
}
