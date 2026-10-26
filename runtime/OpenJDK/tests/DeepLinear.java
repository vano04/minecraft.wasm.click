// Recursion depth that completes, found by stepping up linearly and printing
// each depth that returned: when the VM dies (a wasm engine stack overflow
// kills the Worker instead of throwing StackOverflowError) the last line is
// how far it got.
public class DeepLinear {
  static int f(int n) { return n == 0 ? 0 : 1 + f(n - 1); }
  public static void main(String[] a) {
    int step = a.length > 0 ? Integer.parseInt(a[0]) : 250;
    for (int w = 0; w < 3000; w++) f(10);           // compile f first
    for (int n = step; n <= 400000; n += step) {
      try { f(n); } catch (StackOverflowError e) { System.out.println("soe " + n); return; }
      System.out.println("ok " + n);
    }
  }
}
