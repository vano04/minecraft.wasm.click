// Differential cases for frameless bodies that store fields
// (-XX:+ZeroWasmJITFramelessStores). Such a body logs each store and puts it
// back before it returns "retry", so the ordinary call that follows runs every
// store exactly once; and only framed code may enter it. Every "flstores" line
// must match the interpreter and the JIT with the flag off.
//
// The shapes are Minecraft's: BlockPos.MutableBlockPos's setters, which call
// Vec3i's through invokespecial and return this; set(x, y, z) calling three
// of them; a counter bumped before a guard that can still fire (bounds, null),
// where a store that was not put back would count twice; reference stores
// under a small heap (card marks, collections between calls); and pure
// callers that call a storing setter, inline or through a call out.
public class JitFramelessStores {
  static class Vec {
    protected int x, y, z;
    Vec(int x, int y, int z) { this.x = x; this.y = y; this.z = z; }
    protected Vec setX(int v) { x = v; return this; }
    protected Vec setY(int v) { y = v; return this; }
    protected Vec setZ(int v) { z = v; return this; }
    int sum() { return x * 31 + y * 7 + z; }
  }
  static class Pos extends Vec {
    Pos(int x, int y, int z) { super(x, y, z); }
    public Pos setX(int v) { super.setX(v); return this; }
    public Pos setY(int v) { super.setY(v); return this; }
    public Pos setZ(int v) { super.setZ(v); return this; }
    public Pos set(int a, int b, int c) { setX(a); setY(b); setZ(c); return this; }
    public Pos move(int dy) { return setY(y + dy); }
  }
  static final class Counter {
    int count; long total; Object last; double avg;
    // The store runs before the bounds check on a[i]: a retry that kept it
    // would count the call twice.
    int bumpThenRead(int[] a, int i) { count++; total += i; return a[i]; }
    // The store runs before the null check on o.
    int bumpThenDeref(Pos p) { count += 3; return p.y; }
    Counter keep(Object o) { last = o; return this; }
    void wide(long t, double d) { total = t; avg = d; }
  }

  static long h(long acc, long v) { return acc * 1_000_003L ^ v; }

  // A pure caller of a storing setter: it inlines it or calls it out.
  static int lift(Pos p, int v) { p.setY(v); return p.y + 1; }

  // A loop whose frameless body could splice the setter: stores on earlier
  // iterations, then the bounds guard fires partway (a has fewer than n). A
  // retry that kept the earlier stores would count them twice.
  static int climb(Pos p, int[] a, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) { p.setY(p.y + 1); s += a[i]; }
    return s;
  }

  static final class Flag { volatile int state; Flag set(int v) { state = v; return this; } }

  // A store, then a call out whose callee (a loop: called, not inlined) can
  // retry on a bounds guard. The retry must put the bump back first.
  static final class Reader {
    int count;
    int sumTo(int[] a, int n) { int s = 0; for (int i = 0; i < n; i++) s += a[i]; return s; }
    int bumpThenSum(int[] a, int n) { count++; return sumTo(a, n); }
  }

  // Identity-keyed lookups (System.identityHashCode in a frameless body):
  // keys with a hash, fresh keys without one yet, and a key held locked.
  static int probe(java.util.IdentityHashMap<Object, Integer> m, Object k) {
    Integer v = m.get(k);
    return v == null ? -1 : v;
  }

  static long round(Pos p, Counter c, int[] arr, int n) {
    long acc = 7;
    Object[] keep = new Object[4];
    for (int i = 0; i < n; i++) {
      p.setX(i).setY(i * 3).setZ(-i);
      acc = h(acc, p.sum());
      p.set(i ^ 5, i >> 1, i * i);
      acc = h(acc, p.sum());
      p.move(i & 7);
      acc = h(acc, p.y);
      acc = h(acc, lift(p, i % 13));
      try { acc = h(acc, c.bumpThenRead(arr, i % 11)); }       // arr has 8: bounds guard fires
      catch (ArrayIndexOutOfBoundsException e) { acc = h(acc, 91); }
      try { acc = h(acc, c.bumpThenDeref((i % 17) == 0 ? null : p)); }
      catch (NullPointerException e) { acc = h(acc, 92); }
      Object o = (i & 1) == 0 ? new int[i & 31] : "s" + (i & 3);    // garbage: collections
      keep[i & 3] = o;
      c.keep(o).keep(keep[(i + 1) & 3]);
      acc = h(acc, c.last == null ? 0 : c.last.getClass().getName().length());
      c.wide(c.total + i, i * 0.5);
      acc = h(acc, c.count);
      acc = h(acc, c.total);
      acc = h(acc, Double.doubleToLongBits(c.avg));
    }
    try { ((Pos) null).setY(1); } catch (NullPointerException e) { acc = h(acc, 93); }
    java.util.IdentityHashMap<Object, Integer> ids = new java.util.IdentityHashMap<>();
    Object[] keys = new Object[64];
    for (int i = 0; i < keys.length; i++) { keys[i] = new Object(); ids.put(keys[i], i * 7); }
    for (int i = 0; i < n; i++) {
      acc = h(acc, probe(ids, keys[i & 63]));
      acc = h(acc, probe(ids, new Object()));           // no hash yet: a retry
      if ((i & 255) == 0) synchronized (keys[3]) { acc = h(acc, probe(ids, keys[3])); }
    }
    Reader rd = new Reader();
    for (int i = 0; i < n; i++) {
      try { acc = h(acc, rd.bumpThenSum(arr, 5 + (i % 6))); }   // 9 and 10 run past arr
      catch (ArrayIndexOutOfBoundsException e) { acc = h(acc, 95); }
      acc = h(acc, rd.count);
    }
    Flag f = new Flag();
    for (int i = 0; i < n; i++) {
      try { acc = h(acc, climb(p, arr, 4 + (i % 7))); }     // 9 and 10 run past arr
      catch (ArrayIndexOutOfBoundsException e) { acc = h(acc, 94); }
      acc = h(acc, p.y);
      acc = h(acc, f.set(i).set(f.state + 1).state);
    }
    return acc;
  }

  public static void main(String[] args) {
    int[] arr = { 3, 1, 4, 1, 5, 9, 2, 6 };
    Pos p = new Pos(1, 2, 3);
    Counter c = new Counter();
    for (int r = 0; r < 4; r++) {
      long acc = round(p, c, arr, 3000);
      System.out.println("flstores " + r + " " + acc + " " + p.sum() + " " + c.count + " " + c.total);
    }
  }
}
