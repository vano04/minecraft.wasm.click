// Differential cases for frameless bodies that allocate from the TLAB. A
// frameless attempt is all-or-nothing: on its way out it returns "retry" and
// the caller re-runs the call the ordinary way, so the object it made has to
// go away with it -- the body records the TLAB top it entered with and every
// bail restores it. Every "flalloc" line must match the interpreter, and the
// JIT with the feature disabled through its own bisection bit.
//
// The shapes are Minecraft's: DensityFunctions$Spline.compute, which allocates
// a Point per call and is called from framed code through the density tree.
// Here: a Point allocated and then stored into, a guard that fires after the
// allocation (so the store must happen exactly once, not twice), a guard that
// fires before it (where a local a path never wrote would read as zero), a
// caller that publishes the object and then bails, and enough allocations to
// run the TLAB out -- the only path that refills or collects, and the only one
// that runs in the interpreter anyway.
public class JitFramelessAlloc {
  static final class Point {
    int x, y;
    Point(int x, int y) { this.x = x; this.y = y; }
    int sum() { return x * 31 + y; }
  }

  // Allocates, stores into the new object, then hits a bounds check.
  static int allocThenBail(int[] a, int x) {
    Point p = new Point(x, x + 1);
    int v = a[9];                       // 9 and 10 run past a
    return p.sum() + v;
  }

  // Guard before the allocation: a body that reads a local it never wrote on
  // this path would set the TLAB top to zero and allocate out of the heap.
  static int bailThenAlloc(int[] a, int x) {
    int v = a[9];
    Point p = new Point(x, x + 1);
    return p.sum() + v;
  }

  // Publishes the new object, then bails: the ordinary retry runs the whole
  // call again, so a leaked object would change the hash.
  static int publishThenBail(int[] a, int x) {
    a[3] = x;
    Point p = new Point(x, x + 1);
    int v = a[9];
    return p.sum() + v + a[3];
  }

  // A call out of a frameless body that allocated first.
  static int helper(int x) { sink = x; return x * 3 + 1; }
  static int allocThenCall(int x) {
    Point p = new Point(x, x + 1);
    return p.sum() + helper(x);
  }

  // Enough allocation to run the TLAB out: the bump becomes a guard bail, the
  // interpreter refills, and the whole call runs again.
  static int[] churn(int n) {
    int[] last = null;
    for (int i = 0; i < n; i++) last = new int[] { i, i + 1 };
    return last;
  }

  // Enough allocation before the bail to run the TLAB out: the bump does not
  // fit, the fit check bails, the interpreter refills, and the whole call runs
  // again. A TLAB top that was not put back would make the refill hand the
  // same memory to a later object.
  static int allocMany(int x, int n) {
    long s = 0;
    for (int i = 0; i < n; i++) s += new Point(x + i, x - i).sum();
    // Always out of bounds, so every frameless attempt retries after its
    // objects are taken back and the ordinary path throws the AIOOBE: the
    // rollback happens on every one of thousands of rolled-back allocations.
    return (int) s + x + arr4[9];
  }
  static int[] arr4 = { 5, 2, 8 };

  static int sink;
  static long h(long acc, int v) { return acc * 31 + v; }

  public static void main(String[] args) {
    int n = args.length > 0 ? Integer.parseInt(args[0]) : 20000;
    int[] arr = { 3, 1, 4, 1, 5, 9, 2, 6 };
    long acc = 1;
    for (int i = 0; i < n; i++) {
      try { acc = h(acc, allocThenBail(arr, i)); }
      catch (ArrayIndexOutOfBoundsException e) { acc = h(acc, 71); }
      try { acc = h(acc, bailThenAlloc(arr, i)); }
      catch (ArrayIndexOutOfBoundsException e) { acc = h(acc, 72); }
      try { acc = h(acc, publishThenBail(arr, i)); }
      catch (ArrayIndexOutOfBoundsException e) { acc = h(acc, 73); }
      acc = h(acc, allocThenCall(i));
      try { acc = h(acc, allocMany(i, 4 + (i & 15))); }
      catch (ArrayIndexOutOfBoundsException e) { acc = h(acc, 74); }
      int[] c = churn(4 + (i & 15));
      acc = h(acc, c[0] + c[1]);
      if ((i & 1023) == 0) {                           // collections between calls
        Object[] junk = new Object[64];
        acc = h(acc, junk.length);
      }
    }
    System.out.println("flalloc " + acc + " " + sink + " " + Arrays_sum(arr));
  }

  static int Arrays_sum(int[] a) { int s = 0; for (int v : a) s += v; return s; }
}
