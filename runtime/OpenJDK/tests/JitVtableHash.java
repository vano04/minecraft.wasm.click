import java.util.HashMap;

// Differential cases for virtual hashCode() calls whose receiver class keeps
// Object's (ZeroWasmJITCallFix bit 32: the identity hash read from the
// header behind a vtable check). Identity hashes differ between runs, so
// only facts about them are printed: equal to System.identityHashCode,
// stable across calls, and HashMap behaviour over identity keys. Receivers:
// classes that keep Object.hashCode and classes that override it, at one
// megamorphic site; arrays; objects that have no hash yet; a locked object.
// Every "vhash" line must match the interpreter and HotSpot.
public class JitVtableHash {
  static final class K1 {}
  static final class K2 {}
  static final class K3 { final int v; K3(int v) { this.v = v; } }
  static final class O1 { final int v; O1(int v) { this.v = v; } public int hashCode() { return v * 31; } }
  static final class O2 { public int hashCode() { return 77; } }
  record R(Object a, int b) {}

  static int hashOf(Object o) { return o.hashCode(); }          // one megamorphic site

  static long h(long acc, long v) { return acc * 1_000_003L ^ v; }

  static long round(Object[] objs, int n) {
    long acc = 3;
    HashMap<Object, Integer> map = new HashMap<>();
    for (int i = 0; i < n; i++) {
      Object o = objs[i % objs.length];
      int a = hashOf(o), b = hashOf(o);
      boolean overrides = o instanceof O1 || o instanceof O2;
      acc = h(acc, a == b ? 1 : 0);
      acc = h(acc, overrides ? a : (a == System.identityHashCode(o) ? 5 : 6));
      Object fresh = (i & 1) == 0 ? new K1() : new int[i & 7];  // no hash yet
      acc = h(acc, hashOf(fresh) == System.identityHashCode(fresh) ? 7 : 8);
      map.merge(o, 1, Integer::sum);
      acc = h(acc, map.size());
      R r = new R(objs[(i * 5) % objs.length], i & 3);           // record hashCode -> Objects.hashCode
      acc = h(acc, r.hashCode() == r.hashCode() ? 9 : 10);
      acc = h(acc, r.equals(new R(r.a(), r.b())) ? 11 : 12);
    }
    synchronized (objs[0]) {                                     // a locked receiver
      acc = h(acc, hashOf(objs[0]) == System.identityHashCode(objs[0]) ? 13 : 14);
    }
    for (Object o : objs) acc = h(acc, map.get(o));
    return acc;
  }

  public static void main(String[] args) {
    Object[] objs = { new K1(), new K2(), new K3(1), new O1(4), new O2(), new int[3], "str", new K3(9),
                      new Object(), new long[2], new O1(5) };
    for (int r = 0; r < 3; r++) System.out.println("vhash " + r + " " + round(objs, 5000));
  }
}
