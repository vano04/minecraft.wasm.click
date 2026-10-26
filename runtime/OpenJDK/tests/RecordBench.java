import java.util.HashSet;
import java.util.Objects;
import java.util.Set;

/**
 * Record hashCode/equals (an invokedynamic that ObjectMethods links to a
 * tree of method handles) against the same methods written out by hand,
 * through the HashSet lookups Minecraft's tag checks make
 * (Holder.is -> Set.contains(TagKey)).
 *
 *   run-java.sh ... RecordBench [rounds]
 *
 * Lines starting with "records" must be identical on every JVM.
 */
public class RecordBench {
    record Key(String registry, String location) {}

    static final class HandKey {
        final String registry, location;
        HandKey(String registry, String location) { this.registry = registry; this.location = location; }
        @Override public boolean equals(Object o) {
            return o instanceof HandKey k && Objects.equals(registry, k.registry) && Objects.equals(location, k.location);
        }
        @Override public int hashCode() { return 31 * Objects.hashCode(registry) + Objects.hashCode(location); }
    }

    record Mixed(int a, long b, boolean c, double d, float e, char f, Object g) {}

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 8;
        String[] names = new String[64];
        for (int i = 0; i < names.length; i++) names[i] = ("minecraft:tag_" + i).intern();
        Set<Key> keys = Set.of(new Key("block", names[3]), new Key("block", names[9]),
                new Key("block", names[17]), new Key("item", names[3]), new Key("block", names[40]));
        Set<HandKey> hand = Set.of(new HandKey("block", names[3]), new HandKey("block", names[9]),
                new HandKey("block", names[17]), new HandKey("item", names[3]), new HandKey("block", names[40]));
        Key[] probes = new Key[names.length];
        HandKey[] hprobes = new HandKey[names.length];
        for (int i = 0; i < names.length; i++) {
            probes[i] = new Key((i & 1) == 0 ? "block" : "item", names[i]);
            hprobes[i] = new HandKey((i & 1) == 0 ? "block" : "item", names[i]);
        }
        for (int r = 0; r < rounds; r++) {
            long t0 = System.nanoTime();
            int hits = 0;
            for (int i = 0; i < 200_000; i++) if (keys.contains(probes[i & 63])) hits++;
            long t1 = System.nanoTime();
            int hhits = 0;
            for (int i = 0; i < 200_000; i++) if (hand.contains(hprobes[i & 63])) hhits++;
            long t2 = System.nanoTime();
            System.out.printf("BENCH round=%d record=%.1fms hand=%.1fms%n", r, (t1 - t0) / 1e6, (t2 - t1) / 1e6);
            if (r == 0) System.out.println("records hits " + hits + " " + hhits);
        }
        // Every component kind, null and not, equal and not.
        Set<Mixed> ms = new HashSet<>();
        long h = 0;
        for (int i = 0; i < 20000; i++) {
            Mixed m = new Mixed(i % 7, i * 31L, (i & 1) == 0, i * 0.5, (i % 3) * 1.5f, (char) ('a' + i % 26),
                    (i & 4) == 0 ? null : names[i & 63]);
            h = h * 31 + m.hashCode();
            ms.add(m);
            Mixed n = new Mixed(i % 7, i * 31L, (i & 1) == 0, i * 0.5, (i % 3) * 1.5f, (char) ('a' + i % 26),
                    (i & 4) == 0 ? null : names[(i + (i % 5 == 0 ? 1 : 0)) & 63]);
            h = h * 31 + (m.equals(n) ? 1 : 2) + (m.equals(null) ? 5 : 0) + (m.equals("x") ? 7 : 0);
        }
        Mixed nan = new Mixed(0, 0, false, Double.NaN, Float.NaN, 'x', null);
        h = h * 31 + nan.hashCode() + (nan.equals(new Mixed(0, 0, false, Double.NaN, Float.NaN, 'x', null)) ? 1 : 0);
        Mixed z = new Mixed(0, 0, false, 0.0, 0.0f, 'x', null);
        h = h * 31 + (z.equals(new Mixed(0, 0, false, -0.0, -0.0f, 'x', null)) ? 1 : 0) + z.hashCode();
        System.out.println("records mixed " + h + " " + ms.size());
    }
}
