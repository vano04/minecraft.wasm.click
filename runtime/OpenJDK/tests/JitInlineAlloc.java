import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Allocation inside inlined callees (ZeroWasmJITDisable bit 536870912 turns
 * it off): a TLAB bump in the splice, and when it does not fit, or a guard
 * later in the splice fires, the whole call runs again in the interpreter
 * and the first object is garbage. Covers constructors that store fields
 * (undo-logged), a cold throw after the allocation that must take back the
 * caller-visible stores, iterators from for-each loops, and a second thread
 * collecting all the while, so bumps keep missing the TLAB.
 *
 * Lines starting with "ialloc" must be identical with and without the JIT.
 */
public class JitInlineAlloc {
    static final class Node {
        final int v; Node next;
        Node(int v, Node next) { this.v = v; this.next = next; }
    }

    static final class Stack {
        Node top; int size;
        void push(int v) { top = new Node(v, top); size++; }
        int popOr(int dflt) {
            Node t = top;
            if (t == null) return dflt;
            top = t.next; size--;
            return t.v;
        }
        // The allocation, then the caller-visible stores, then a cold throw:
        // a bail there must leave neither `top` nor `size` changed twice.
        int attempts;
        Node pushChecked(int v) {
            Node n = new Node(v, top);
            attempts++;
            if (v % 1000 == 999) throw new IllegalStateException("x" + v);
            top = n; size++;
            return n;
        }
    }

    static final class Range implements Iterable<Integer> {
        final int lo, hi;
        Range(int lo, int hi) { this.lo = lo; this.hi = hi; }
        public Iterator<Integer> iterator() { return new It(lo, hi); }
    }
    static final class It implements Iterator<Integer> {
        int at; final int hi;
        It(int at, int hi) { this.at = at; this.hi = hi; }
        public boolean hasNext() { return at < hi; }
        public Integer next() { return at++; }
    }

    static int sum(Range r) {
        int s = 0;
        for (int x : r) s += x;
        return s;
    }

    static volatile Object sink;

    public static void main(String[] args) throws Exception {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 150000;
        Thread gc = new Thread(() -> {
            for (int k = 0; k < 300; k++) {
                List<long[]> l = new ArrayList<>();
                for (int j = 0; j < 500; j++) l.add(new long[32]);
                sink = l;
                if ((k & 31) == 0) System.gc();
                Thread.yield();
            }
        });
        gc.start();
        Stack s = new Stack();
        long h = 0;
        int thrown = 0;
        for (int i = 0; i < rounds; i++) {
            s.push(i);
            if ((i & 3) == 0) h = h * 31 + s.popOr(-1);
            try {
                Node n = s.pushChecked(i);
                h = h * 31 + n.v;
            } catch (IllegalStateException e) {
                thrown++;
                h = h * 31 + e.getMessage().length();
            }
            if (s.size > 64) { while (s.size > 8) h += s.popOr(0); }
            if ((i & 1023) == 0) h = h * 31 + sum(new Range(i & 63, (i & 63) + 17));
        }
        gc.join();
        int depth = 0;
        for (Node n = s.top; n != null; n = n.next) depth++;
        System.out.println("ialloc stack " + h + " size " + s.size + " depth " + depth + " thrown " + thrown
                + " attempts " + s.attempts);
        long r = 0;
        for (int i = 0; i < rounds / 50; i++) r += sum(new Range(i % 11, i % 11 + (i % 5)));
        System.out.println("ialloc range " + r);
    }
}
