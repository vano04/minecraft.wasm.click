// What a frameless-body loss costs, in the shape the game hits: an iterator
// in the style of Guava's AbstractIterator, whose hasNext() calls an
// overridden computeNext(). When computeNext writes a field (as
// BlockCollisions.computeNext does), frameless callers cannot enter it, so
// hasNext's frameless body keeps retrying and is dropped to framed. The
// "pure" variant computes the same without a store. With "mono" only the
// storing class runs, so every site sees one receiver class. With "mixed" both
// classes alternate from the start, so the profile sees both before the
// profiled recompile.
public class FlStoreBench {
    static abstract class It {
        int state;            // 0 = not ready, 1 = ready, 2 = done
        int next;
        abstract int computeNext();
        final boolean hasNext() {
            if (state == 1) return true;
            if (state == 2) return false;
            int v = computeNext();
            if (v < 0) { state = 2; return false; }
            next = v; state = 1; return true;
        }
        int take() { state = 0; return next; }
    }
    static final class Storing extends It {
        int i, n;
        Storing(int n) { this.n = n; }
        int computeNext() { return i < n ? i++ : -1; }          // writes i
    }
    static final class Pure extends It {
        final int[] src;
        int at;
        Pure(int[] src) { this.src = src; }
        int computeNext() { int k = at; return k < src.length ? src[k] : -1; }
        @Override int take() { at++; return super.take(); }      // advance outside hasNext
    }
    static long drain(It it) { long s = 0; while (it.hasNext()) s += it.take(); return s; }

    public static void main(String[] args) {
        int n = 1000, reps = 2000;
        boolean mono = args.length > 0 && args[0].equals("mono");   // one class per site
        boolean mixed = args.length > 0 && args[0].equals("mixed"); // both classes from the start
        int[] src = new int[n];
        for (int i = 0; i < n; i++) src[i] = i;
        if (mixed) {
            for (int round = 0; round < 6; round++) {
                long s = 0;
                long t0 = System.nanoTime();
                for (int r = 0; r < reps; r++) { s += drain(new Storing(n)); s += drain(new Pure(src)); }
                long t1 = System.nanoTime();
                System.out.printf("round %d: mixed %.1f ns/element (%d)%n", round,
                    (t1 - t0) / (double) (2 * n * reps), s);
            }
            return;
        }
        for (int round = 0; round < 6; round++) {
            long s = 0;
            long t0 = System.nanoTime();
            for (int r = 0; r < reps; r++) s += drain(new Storing(n));
            long t1 = System.nanoTime();
            if (!mono) for (int r = 0; r < reps; r++) s += drain(new Pure(src));
            long t2 = System.nanoTime();
            System.out.printf("round %d: storing %.1f ns/element  pure %.1f ns/element (%d)%n", round,
                (t1 - t0) / (double) (n * reps), (t2 - t1) / (double) (n * reps), s);
        }
    }
}
