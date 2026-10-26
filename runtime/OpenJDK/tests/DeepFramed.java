// DeepLinear for framed calls only: f writes a field, so it has no
// frameless body, and every level of the recursion is a framed call (in
// wasm, through a framed helper, where the engine supports it). The last
// line is the depth reached; "soe" means StackOverflowError came first, as
// it must, and a missing one means the engine's stack ran out and killed
// the Worker.
public class DeepFramed {
  static int sink;
  static int f(int n) { sink = n; return n == 0 ? 0 : 1 + f(n - 1); }
  public static void main(String[] a) {
    int step = a.length > 0 ? Integer.parseInt(a[0]) : 250;
    for (int w = 0; w < 5000; w++) f(10);           // compile f, then recompile it
    for (int n = step; n <= 400000; n += step) {
      try { f(n); } catch (StackOverflowError e) { System.out.println("soe " + n); return; }
      System.out.println("ok " + n);
    }
  }
}
