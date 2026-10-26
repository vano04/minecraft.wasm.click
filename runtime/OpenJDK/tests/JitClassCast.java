import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;
import java.util.RandomAccess;

/**
 * Class.isInstance as a JIT intrinsic (and so Class.cast, which calls it):
 * exact classes, superclasses, interfaces, arrays, primitive mirrors (which
 * hand back to the interpreter), null objects, and failing casts whose
 * ClassCastException message must be the interpreter's.
 *
 * Lines starting with "cast" must be identical with and without the JIT.
 */
public class JitClassCast {
    static int test(Class<?> k, Object o) {
        return k.isInstance(o) ? 1 : 0;
    }

    static Object cast(Class<?> k, Object o) {
        return k.cast(o);
    }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 20000;
        Class<?>[] classes = { Object.class, Number.class, Integer.class, String.class,
                CharSequence.class, Comparable.class, Serializable.class, List.class,
                RandomAccess.class, int[].class, Object[].class, String[].class, int.class };
        Object[] objs = { 7, "s", new ArrayList<String>(), new int[1], new String[1],
                new Object[1], 3.5, null, new StringBuilder("b") };
        long acc = 0;
        for (int r = 0; r < rounds; r++) {
            for (int i = 0; i < classes.length; i++) {
                acc = acc * 3 + test(classes[i], objs[(r + i) % objs.length]);
            }
        }
        System.out.println("cast isInstance " + acc);

        long ok = 0, cce = 0;
        String lastMessage = "";
        for (int r = 0; r < rounds; r++) {
            Class<?> k = classes[r % (classes.length - 1)];      // no int.class: cast would NPE-free CCE
            Object o = objs[r % objs.length];
            try {
                Object back = cast(k, o);
                if (back == o) ok++;
            } catch (ClassCastException e) {
                cce++;
                lastMessage = e.getMessage();
            }
        }
        System.out.println("cast cast ok=" + ok + " cce=" + cce + " last=" + lastMessage);

        int npe = 0;
        for (int r = 0; r < 100; r++) {
            try { test(null, "x"); } catch (NullPointerException e) { npe++; }
        }
        System.out.println("cast nullclass npe=" + npe);
    }
}
