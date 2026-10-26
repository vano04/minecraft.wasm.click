import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * A collector under the game's shape of load: a large long-lived graph in
 * the old generation that mutator threads keep rewiring (old-to-young
 * references only card marks keep current), plus a steady stream of
 * short-lived garbage, on several threads at once. Every node carries a
 * check value derived from its contents and its children's ids, re-verified
 * by a full walk at the end, so a collector that loses or misplaces an
 * object (or a barrier the JIT skipped) fails loudly instead of slowly.
 *
 * Also reports how long the main thread stalled: a 1 ms sleep loop records
 * its worst wake-up gap, the stand-in for a render thread's frame.
 *
 *   java -Xlog:gc -XX:+UseSerialGC   GcPauseStress [threads] [seconds] [liveMB]
 *   java -Xlog:gc -XX:+UseParallelGC GcPauseStress 6 30 500
 */
public class GcPauseStress {
    static final class Node {
        final int id;
        final int[] payload;
        Node left, right;
        int check;

        Node(int id, int size) {
            this.id = id;
            this.payload = new int[size];
            for (int i = 0; i < size; i++) payload[i] = id * 31 + i;
        }

        int expected() {
            int h = id;
            for (int v : payload) h = h * 17 + v;
            return h * 13 + (left == null ? -1 : left.id) * 7 + (right == null ? -2 : right.id);
        }
    }

    static Node[] nodes;
    static volatile boolean stop;
    static final AtomicLong garbageBytes = new AtomicLong();
    static final AtomicInteger rewires = new AtomicInteger();
    static volatile Object sink;

    public static void main(String[] args) throws Exception {
        int threads = args.length > 0 ? Integer.parseInt(args[0]) : 6;
        int seconds = args.length > 1 ? Integer.parseInt(args[1]) : 30;
        int liveMb = args.length > 2 ? Integer.parseInt(args[2]) : 400;
        int size = 64;   // ints per payload: ~300 bytes a node
        int count = (int) (liveMb * 1024L * 1024L / (size * 4 + 48));
        nodes = new Node[count];
        for (int i = 0; i < count; i++) nodes[i] = new Node(i, size);
        for (int i = 0; i < count; i++) {
            Node n = nodes[i];
            n.left = nodes[(i * 7 + 1) % count];
            n.right = nodes[(i * 13 + 5) % count];
            n.check = n.expected();
        }
        System.gc();
        System.out.printf("STRESS live nodes=%d (~%d MB) threads=%d seconds=%d%n", count, liveMb, threads, seconds);

        Thread[] workers = new Thread[threads];
        for (int t = 0; t < threads; t++) {
            workers[t] = new Thread(() -> {
                ThreadLocalRandom r = ThreadLocalRandom.current();
                while (!stop) {
                    // Short-lived garbage, the bulk of a mutator's allocation.
                    Object[] junk = new Object[64];
                    for (int i = 0; i < junk.length; i++) junk[i] = new int[16 + r.nextInt(48)];
                    sink = junk;
                    garbageBytes.addAndGet(64 * 140);
                    // Now and then a slot of the old graph gets a new young node
                    // and a neighbour points at it: old -> young references.
                    if (r.nextInt(8) == 0) {
                        int i = r.nextInt(nodes.length);
                        synchronized (GcPauseStress.class) {
                            Node fresh = new Node(i, size);
                            Node old = nodes[i];
                            fresh.left = old.left;
                            fresh.right = old.right;
                            fresh.check = fresh.expected();
                            nodes[i] = fresh;
                            Node pointer = nodes[(i + 1) % nodes.length];
                            pointer.left = fresh;
                            pointer.check = pointer.expected();
                        }
                        rewires.incrementAndGet();
                    }
                }
            }, "mutator-" + t);
            workers[t].start();
        }

        long end = System.nanoTime() + seconds * 1_000_000_000L;
        long worst = 0, over50 = 0, last = System.nanoTime();
        while (System.nanoTime() < end) {
            Thread.sleep(1);
            long now = System.nanoTime();
            long gap = now - last;
            worst = Math.max(worst, gap);
            if (gap > 50_000_000L) over50++;
            last = now;
        }
        stop = true;
        for (Thread w : workers) w.join();

        int bad = 0;
        for (Node n : nodes) {
            if (n.check != n.expected()) bad++;
            if (n.left == null || n.right == null) bad++;
        }
        System.out.printf("STRESS garbage=%d MB rewires=%d mainWorstGap=%d ms gapsOver50ms=%d bad=%d %s%n",
                garbageBytes.get() >> 20, rewires.get(), worst / 1_000_000, over50, bad, bad == 0 ? "PASS" : "FAIL");
        if (bad != 0) System.exit(1);
    }
}
