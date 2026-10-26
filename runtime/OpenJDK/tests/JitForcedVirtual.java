import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;

// Differential cases for invokeinterface sites that link to a method of
// java.lang.Object (List.equals, Collection.hashCode, CharSequence.toString,
// an interface redeclaring equals/hashCode). The cpCache never marks them
// resolved for invokeinterface -- the interpreter re-resolves every one --
// so compiled code dispatches them through the vtable (zwc_entry_resolved).
// Every "forcedv" line must match the interpreter and HotSpot. Nothing here
// depends on an identity hash, which differs between runs.
public class JitForcedVirtual {
  interface Named {
    boolean equals(Object o);
    int hashCode();
    String name();
  }
  static final class Keyed implements Named {
    final int k;
    Keyed(int k) { this.k = k; }
    public boolean equals(Object o) { return o instanceof Keyed other && other.k == k; }
    public int hashCode() { return k * 7919; }
    public String name() { return "k" + k; }
  }
  // Inherits Object's equals and hashCode: identity equality is deterministic.
  static final class Plain implements Named {
    final int v;
    Plain(int v) { this.v = v; }
    public String name() { return "p" + v; }
  }

  static long h(long acc, long v) { return acc * 1_000_003L ^ v; }

  static long named(Named[] xs, int n) {
    long acc = 1;
    for (int i = 0; i < n; i++) {
      Named a = xs[i % xs.length], b = xs[(i * 7 + 3) % xs.length];
      acc = h(acc, a.equals(b) ? 1 : 0);
      acc = h(acc, a.equals(a) ? 1 : 0);
      if (a instanceof Keyed) acc = h(acc, a.hashCode());
      acc = h(acc, a.name().length());
    }
    return acc;
  }

  static long lists(List<Object>[] ls, CharSequence[] cs, int n) {
    long acc = 2;
    for (int i = 0; i < n; i++) {
      List<Object> a = ls[i % ls.length], b = ls[(i + 1) % ls.length];
      acc = h(acc, a.equals(b) ? 1 : 0);
      acc = h(acc, a.hashCode());
      acc = h(acc, cs[i % cs.length].toString().length());
    }
    return acc;
  }

  @SuppressWarnings("unchecked")
  public static void main(String[] args) {
    Named[] xs = { new Keyed(1), new Plain(2), new Keyed(1), new Keyed(3), new Plain(4) };
    List<Object> a = new ArrayList<>(List.of(1, 2, 3));
    List<Object> b = new LinkedList<>(List.of(1, 2, 3));
    List<Object> c = List.of(1, 2, 4);
    List<Object>[] ls = new List[] { a, b, c, List.of() };
    CharSequence[] cs = { "abc", new StringBuilder("hello"), "x" };
    for (int r = 0; r < 3; r++) {
      System.out.println("forcedv named " + r + " " + named(xs, 4000));
      System.out.println("forcedv lists " + r + " " + lists(ls, cs, 4000));
    }
  }
}
