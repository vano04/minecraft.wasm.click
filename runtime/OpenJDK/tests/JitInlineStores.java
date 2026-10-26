/**
 * Inlined callees that store to fields (the JIT's undo log, NO_INLINE_STORES
 * to disable). A store in an inlined body happens before guards that can
 * still fire later in the same body; a firing guard rewinds to the caller's
 * invoke and the interpreter runs the whole call again. Every case here makes
 * the store first and the guard fire afterwards some of the time, so a store
 * that is not taken back shows up as a count that went up twice.
 *
 * Lines starting with "stores" must be identical with and without the JIT.
 */
public class JitInlineStores {
    static final class Counter {
        int hits;
        long total;
        double mean;
        Object last;
        int[] data;
        Counter(int n) { data = new int[n]; }
    }

    // store, then a null dereference that fires when `o` is null
    static int bump(Counter c, Integer o) {
        c.hits = c.hits + 1;
        return o.intValue() & 7;
    }

    // iterator shape: advance the cursor, then an access that can be out of bounds
    static final class Cursor {
        int pos;
        int lastRet;
        final int[] arr;
        Cursor(int[] a) { arr = a; }
        int next() {
            int i = pos;
            pos = i + 1;
            return arr[lastRet = i];
        }
    }

    // wide and reference stores, then a division that fails when d == 0
    static long mix(Counter c, long v, int d, Object tag) {
        c.total = c.total + v;
        c.mean = c.total / 3.0;
        c.last = tag;
        return v / d;
    }

    // the same field twice, then a bounds check
    static int twice(Counter c, int i) {
        c.hits = c.hits + 10;
        c.hits = c.hits * 2;
        return c.data[i];
    }

    // a store in a callee spliced into another callee
    static int outer(Counter c, Cursor k, Integer o) {
        c.hits++;
        return k.next() + bump(c, o);
    }

    // Hot drivers: each compiles on its own and splices its callee, stores
    // and all, which is what the undo log is for.
    static int driveBump(Counter c, Integer o) { return bump(c, o) + 1; }
    static int driveNext(Cursor k) { return k.next() + 1; }
    static long driveMix(Counter c, long v, int d, Object tag) { return mix(c, v, d, tag) + 1; }
    static int driveTwice(Counter c, int i) { return twice(c, i) + 1; }
    static int driveOuter(Counter c, Cursor k, Integer o) { return outer(c, k, o) + 1; }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 30000;
        Counter c = new Counter(16);
        Object marker = new Object();
        Integer boxed = 42;

        int npe = 0;
        long acc = 0;
        for (int r = 0; r < rounds; r++) {
            try { acc += driveBump(c, (r % 97 == 0) ? null : boxed); } catch (NullPointerException e) { npe++; }
        }
        System.out.println("stores bump hits=" + c.hits + " npe=" + npe + " acc=" + acc);

        int[] arr = new int[64];
        for (int i = 0; i < arr.length; i++) arr[i] = i * 3;
        int oob = 0;
        long sum = 0;
        for (int r = 0; r < rounds; r++) {
            Cursor k = new Cursor(arr);
            k.pos = r % 70;                 // 64..69 run off the end
            try { sum += driveNext(k); } catch (ArrayIndexOutOfBoundsException e) { oob++; sum += k.pos * 1000L + k.lastRet; }
        }
        System.out.println("stores cursor sum=" + sum + " oob=" + oob);

        Counter m = new Counter(1);
        int div0 = 0;
        long q = 0;
        for (int r = 0; r < rounds; r++) {
            try { q += driveMix(m, r, (r % 50 == 0) ? 0 : 7, (r & 1) == 0 ? marker : boxed); }
            catch (ArithmeticException e) { div0++; }
        }
        System.out.println("stores mix total=" + m.total + " mean=" + m.mean + " last=" + (m.last == marker) + " div0=" + div0 + " q=" + q);

        Counter t = new Counter(8);
        int bad = 0;
        long tsum = 0;
        for (int r = 0; r < rounds; r++) {
            t.hits = r & 1023;
            try { tsum += driveTwice(t, r % 9) + t.hits; } catch (ArrayIndexOutOfBoundsException e) { bad++; tsum += t.hits; }
        }
        System.out.println("stores twice sum=" + tsum + " bad=" + bad);

        Counter o = new Counter(1);
        int onpe = 0;
        long osum = 0;
        for (int r = 0; r < rounds; r++) {
            Cursor k = new Cursor(arr);
            k.pos = r & 31;
            try { osum += driveOuter(o, k, (r % 61 == 0) ? null : boxed); }
            catch (NullPointerException e) { onpe++; osum += k.pos; }
        }
        System.out.println("stores outer hits=" + o.hits + " sum=" + osum + " npe=" + onpe);
    }
}
