import java.util.ArrayList;
import java.util.List;

/**
 * aastore (store checks), newarray/anewarray (every element type, sizes around
 * the 4 KB fast-path limit, negative sizes) and ldc of String and Class
 * constants, compiled. Lines starting with "arrays" must be identical with
 * and without the JIT.
 */
public class JitArrays {
    interface Shape { int area(); }
    record Sq(int s) implements Shape { public int area() { return s * s; } }
    record Rect(int w, int h) implements Shape { public int area() { return w * h; } }

    static int store(Object[] into, Object v, int i) {
        try { into[i % into.length] = v; return 1; }
        catch (ArrayStoreException e) { return 100; }
        catch (NullPointerException e) { return 10000; }
    }

    static long alloc(int n) {
        long h = 0;
        try {
            h += new int[n].length + new long[n].length * 2 + new byte[n].length * 3 + new boolean[n].length
               + new char[n].length + new short[n].length + new float[n].length + new double[n].length
               + new Object[n].length + new String[n].length + new Shape[n].length + new int[n][0].length;
            long[] l = new long[n]; if (n > 0) { l[n - 1] = 5; h += l[n - 1] + l[0]; }
            Object[] o = new Object[n]; for (int i = 0; i < n && i < 3; i++) h += o[i] == null ? 1 : 7;
        } catch (NegativeArraySizeException e) { h += 999; }
        return h;
    }

    static int constants(int r) {
        String a = "hello", b = "hello";
        Class<?> c = String.class, d = Shape.class, e = int[].class;
        return (a == b ? 1 : 0) + a.length() + (c == String.class ? 2 : 0) + d.getSimpleName().length()
             + (e.isArray() ? 4 : 0) + (r % 2 == 0 ? "x".length() : "yy".length());
    }

    public static void main(String[] args) {
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 100000;
        Object[] objs = new Object[8];
        String[] strs = new String[8];
        Shape[] shapes = new Shape[8];
        Object[] covariant = new Integer[4];
        List<Object> list = new ArrayList<>();
        long h = 0;
        for (int r = 0; r < n; r++) {
            h += store(objs, (r & 1) == 0 ? "s" : Integer.valueOf(r), r);
            h += store(strs, (r & 3) == 0 ? "t" : null, r);
            h += store(shapes, (r & 1) == 0 ? new Sq(r & 7) : new Rect(r & 3, 2), r);
            h += store(covariant, (r % 5 == 0) ? "notAnInteger" : Integer.valueOf(r), r);
            h += store(null, "x", r) / 100;
            if ((r & 63) == 0) { list.add(r); if (list.size() > 100) list.clear(); }
            h = h * 31 + alloc((r % 41 == 0) ? 1100 : (r % 97 == 0) ? -1 : (r & 15)) + constants(r);
        }
        int areas = 0;
        for (Shape s : shapes) areas += s == null ? 0 : s.area();
        System.out.println("arrays " + h + " " + list.size() + " " + areas + " " + strs[0] + " " + objs[1]);
    }
}
