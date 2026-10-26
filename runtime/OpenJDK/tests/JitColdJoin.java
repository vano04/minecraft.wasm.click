/**
 * Calls never taken whose path joins the live code again before any throw or
 * return -- `a || b()`, EnumMap.isValidKey's shape (ZeroWasmJITDisable bit
 * 1073741824 turns them off). The inlined callee bails at the call and the
 * splice resumes at the next join; a branch target only the skipped code
 * reaches is not emitted. Warm-up never takes the call; afterwards an enum
 * constant with its own class body (whose class is not the enum's) and
 * other shapes take it, and every answer must still be right.
 *
 * Lines starting with "coldjoin" must be identical with and without the JIT.
 */
public class JitColdJoin {
    enum Color {
        RED, GREEN,
        BLUE { @Override int x() { return 3; } };
        int x() { return 1; }
    }

    static final class Keyed {
        final Class<?> type;
        Keyed(Class<?> type) { this.type = type; }
        // As EnumMap.isValidKey: the getSuperclass call is the cold one.
        private boolean valid(Object key) {
            if (key == null) return false;
            Class<?> kc = key.getClass();
            return kc == type || kc.getSuperclass() == type;
        }
        int get(Object key) { return valid(key) ? ((Color) key).ordinal() + 1 : 0; }
    }

    static int weigh(Keyed k, Object o) { return k.get(o) * 7 + 1; }

    // A cold call whose result feeds a comparison, then a join, twice.
    static final class Gate {
        int limit;
        boolean pass(int v, Object note) {
            return v < limit || String.valueOf(note).length() > 3;
        }
        int score(int v, Object note) { return (pass(v, note) ? 5 : 2) + (v > limit * 2 || note == null ? 1 : 0); }
    }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 200000;
        Keyed k = new Keyed(Color.class);
        Gate g = new Gate();
        g.limit = 1 << 30;
        Color[] warm = { Color.RED, Color.GREEN };
        long h = 0;
        for (int i = 0; i < rounds; i++) {
            h = h * 31 + weigh(k, warm[i & 1]);
            h = h * 31 + g.score(i, null);
        }
        System.out.println("coldjoin warm " + h);
        g.limit = 1000;
        Object[] later = { Color.RED, Color.BLUE, "str", null, Color.GREEN, Integer.valueOf(4) };
        long m = 0;
        for (int i = 0; i < rounds / 4; i++) {
            Object o = later[i % later.length];
            m = m * 31 + weigh(k, o);
            m = m * 31 + g.score(i % 3000, (i & 7) == 0 ? "long note" : (i & 7) == 1 ? "ab" : null);
        }
        System.out.println("coldjoin later " + m);
    }
}
