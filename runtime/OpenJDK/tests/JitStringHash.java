import java.util.HashMap;

/**
 * The String arm of a virtual hashCode() call (ZeroWasmJITCallFix bit 512):
 * a megamorphic Object.hashCode() site that sees Strings (fresh ones whose
 * hash is not cached yet, ones that hash to 0, which never cache a hash)
 * beside Integers, records and identity-hashed objects, both in a framed
 * caller and in a small frameless one. Identity hashes differ between VMs,
 * so only relations are printed for those.
 *
 * `bench` times HashMap<String,..> lookups with HashMap.hash polluted by
 * other key classes, as in the game (the render pass's uniform maps).
 */
public class JitStringHash {
    record Rec(int a, String b) {}
    static final class Plain {}

    static int hashOf(Object o) { return o.hashCode(); }          // frameless-sized

    static int framed(Object[] objs, int n) {                    // framed: a loop with calls
        int s = 0;
        for (int i = 0; i < n; i++) {
            Object o = objs[i % objs.length];
            s = s * 31 + o.hashCode();
        }
        return s;
    }

    static Object[] mix(int salt) {
        Object[] objs = new Object[32];
        for (int i = 0; i < objs.length; i++) {
            switch (i % 6) {
                case 0 -> objs[i] = "key" + (i + salt);            // fresh: hash not cached
                case 1 -> objs[i] = i % 12 == 1 ? "" : "f5a5a608"; // distinct zero hashes
                case 2 -> objs[i] = Integer.valueOf(i * 7 + salt);
                case 3 -> objs[i] = new Rec(i, "r" + salt);
                case 4 -> objs[i] = "uniform.ModelViewMat";
                default -> objs[i] = (i % 12 == 5 ? "été" : "水") + salt;
            }
        }
        return objs;
    }

    public static void main(String[] args) {
        if (args.length > 0 && args[0].equals("bench")) { bench(args.length > 1 ? Integer.parseInt(args[1]) : 5); return; }
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 200000;
        long sum = 0;
        int zeros = 0, plainOk = 0;
        Plain p = new Plain();
        int pid = System.identityHashCode(p);
        for (int r = 0; r < n / 1000; r++) {
            Object[] objs = mix(r);                                // fresh Strings each round
            sum += framed(objs, 1000);
            for (Object o : objs) {
                int h = hashOf(o);
                sum = sum * 17 + h;
                if (h == 0) zeros++;
            }
            if (hashOf(p) == pid) plainOk++;
        }
        HashMap<Object, Integer> m = new HashMap<>();
        for (int r = 0; r < 64; r++) for (Object o : mix(r)) m.merge(o, 1, Integer::sum);
        System.out.println("shash sum=" + sum + " zeros=" + zeros + " plainOk=" + plainOk
                + " mapSize=" + m.size() + " empty=" + m.get("") + " zero=" + m.get("f5a5a608")
                + " mvm=" + m.get("uniform.ModelViewMat"));
        int nulls = 0;
        try { hashOf(null); } catch (NullPointerException expected) { nulls++; }
        try { framed(new Object[] { null }, 1); } catch (NullPointerException expected) { nulls++; }
        System.out.println("shash nulls=" + nulls + " zeroHashes="
                + (hashOf("") == 0 && hashOf("f5a5a608") == 0));
    }

    static void bench(int rounds) {
        // Pollute HashMap.hash's key.hashCode() first, as the game does.
        HashMap<Object, Integer> other = new HashMap<>();
        for (int i = 0; i < 2000; i++) { other.put(i, i); other.put(new Rec(i, "x"), i); other.put(new Plain(), i); }
        String[] names = { "ModelViewMat", "ProjMat", "ColorModulator", "GameTime", "Sampler0", "Sampler1",
                           "Sampler2", "FogStart", "FogEnd", "FogColor", "TextureMat", "ScreenSize" };
        HashMap<String, Integer> u = new HashMap<>();
        for (int i = 0; i < names.length; i++) u.put(names[i], i);
        for (int r = 0; r < rounds; r++) {
            long t0 = System.nanoTime();
            int s = 0;
            for (int i = 0; i < 2_000_000; i++) {
                String k = names[i % names.length];
                s += u.get(k);
                if ((i & 7) == 0) u.put(k, i);
                if ((i & 63) == 0) s += other.get(i & 1023);
            }
            long t1 = System.nanoTime();
            System.out.println("bench round " + r + " " + (t1 - t0) / 1_000_000 + " ms (s=" + s + ")");
        }
    }
}
