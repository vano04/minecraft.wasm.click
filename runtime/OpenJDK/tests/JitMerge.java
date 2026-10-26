/**
 * Focused regression for an inlined forward merge carrying a value.
 *
 * The first call in caller is deliberately not inlineable.  The second call
 * inlines valueMerge, whose bytecode has targets with both empty and non-empty
 * operand stacks (the short-circuit || shape that broke the JIT).
 */
public class JitMerge {
    static final class Late {
        static final Object K = new Object();
    }

    static final class Holder {
        Object option;
        Holder(Object option) { this.option = option; }
    }

    static boolean valueMerge(Holder h) {
        return h.option == null || h.option == Late.K;
    }

    static synchronized int outOfLine(int x) {
        return x + 1;
    }

    static int caller(Holder h, int x) {
        int r = outOfLine(x);
        // Keep a useful amount of caller work before the splice so the
        // compile is retained even when the inlined getstatic must bail.
        r += x; r ^= 3; r += 5; r ^= 7; r += 11; r ^= 13;
        r += x; r ^= 17; r += 19; r ^= 23; r += 29; r ^= 31;
        r += x; r ^= 37; r += 41; r ^= 43; r += 47; r ^= 53;
        r += x; r ^= 59; r += 61; r ^= 67; r += 71; r ^= 73;
        return valueMerge(h) ? r + 1 : r - 1;
    }

    public static void main(String[] args) {
        Holder nil = new Holder(null);
        for (int i = 0; i < 300; i++) caller(nil, i);
        Holder[] values = { nil, new Holder(new Object()), new Holder(new Object()) };
        long sum = 0;
        for (int round = 0; round < 4000; round++) {
            for (int i = 0; i < values.length; i++) {
                sum += caller(values[i], round + i);
            }
        }
        System.out.println("merge " + sum);
        try {
            caller(null, 7);
            System.out.println("guard MISSING");
        } catch (NullPointerException e) {
            System.out.println("guard thrown");
        }
    }
}
