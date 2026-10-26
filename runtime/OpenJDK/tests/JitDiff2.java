// Differential test for the second wave of opcodes: floats, division, the
// dup/swap family, switches, allocation, type checks, reference stores and
// methods with exception handlers.
//
// Every method here must run more than -XX:ZeroWasmJITThreshold times or it is
// never compiled and the comparison proves nothing. Run it with and without
// -XX:+UseZeroWasmJIT; the output must be byte-identical.
public class JitDiff2 {

  // ---------- floats ----------
  static float farith(float a, float b) {
    float r = 0;
    r += a + b; r += a - b; r += a * b; r += a / b; r += -a;
    r += (float)(int)a; r += (float)(long)b; r += (float)(double)a;
    return r;
  }
  static int fcmp(float a, float b) {
    int r = 0;
    if (a < b) r += 1;
    if (a > b) r += 2;
    if (a <= b) r += 4;
    if (a >= b) r += 8;
    if (a == b) r += 16;
    if (a != b) r += 32;
    return r;
  }
  static int fconv(float f) {
    return (int)f + (int)(long)f + (int)(double)f + Float.floatToRawIntBits(f * 2.0f);
  }

  // ---------- division ----------
  static long divs(int a, int b, long c, long d) {
    long r = 0;
    try { r += a / b; } catch (ArithmeticException e) { r += 1000; }
    try { r += a % b; } catch (ArithmeticException e) { r += 2000; }
    try { r += c / d; } catch (ArithmeticException e) { r += 3000; }
    try { r += c % d; } catch (ArithmeticException e) { r += 4000; }
    return r;
  }

  // ---------- stack shuffles ----------
  static int[] arr = new int[8];
  static long[] larr = new long[8];
  static float[] farr = new float[8];
  static double[] darr = new double[8];
  static int shuffle(int i) {
    // ++ on an array element is dup_x2/dup2; the long forms use dup2_x2
    arr[i & 7]++;
    larr[i & 7] += 3;
    farr[i & 7] += 1.5f;
    darr[i & 7] *= 1.0000001;
    return arr[i & 7] + (int)larr[i & 7] + (int)farr[i & 7] + (int)darr[i & 7];
  }

  // ---------- switches ----------
  static int dense(int i) {
    switch (i & 15) {
      case 0: return 100; case 1: return 101; case 2: return 102; case 3: return 103;
      case 4: return 104; case 5: return 105; case 6: return 106; case 7: return 107;
      case 8: return 108; case 9: return 109; case 10: return 110; case 11: return 111;
      case 12: return 112; case 13: return 113; case 14: return 114;
      default: return -1;
    }
  }
  static int sparse(int i) {
    switch (i) {
      case 1: return 1; case 17: return 2; case 199: return 3; case 4000: return 4;
      case -5: return 5; case 100000: return 6;
      default: return 0;
    }
  }
  static int loopswitch(int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) {
      switch (i & 3) {
        case 0: acc += 1; break;
        case 1: acc += 2; continue;
        case 2: acc -= 1; break;
        default: acc *= 2; break;
      }
      acc++;
    }
    return acc;
  }

  // ---------- allocation and constructors ----------
  static final class Node {
    int a; long b; float c; double d; Node next; byte e; short f; char g; boolean h;
    Node(int a, Node next) {
      this.a = a; this.b = a * 3L; this.c = a * 1.5f; this.d = a / 3.0;
      this.next = next; this.e = (byte)a; this.f = (short)a; this.g = (char)a; this.h = (a & 1) != 0;
    }
  }
  static long build(int n) {
    Node head = null;
    for (int i = 0; i < n; i++) head = new Node(i, head);
    long sum = 0;
    for (Node p = head; p != null; p = p.next)
      sum += p.a + p.b + (long)p.c + (long)p.d + p.e + p.f + p.g + (p.h ? 1 : 0);
    return sum;
  }

  // ---------- type checks ----------
  interface Shape {}
  static class Base implements Shape { int k = 1; }
  static class Derived extends Base { int j = 2; }
  static final class Leaf extends Base { int m = 3; }
  static int typecheck(Object o) {
    int r = 0;
    if (o instanceof Base) r += 1;
    if (o instanceof Derived) r += 2;
    if (o instanceof Leaf) r += 4;
    if (o instanceof Shape) r += 8;
    if (o instanceof String) r += 16;
    try { r += ((Base)o).k; } catch (ClassCastException e) { r += 100; }
    try { r += ((Leaf)o).m; } catch (ClassCastException e) { r += 200; }
    return r;
  }

  // ---------- exception handlers in a compiled method ----------
  static int handlers(int[] a, int i, Object o) {
    int r = 0;
    try { r += a[i]; } catch (ArrayIndexOutOfBoundsException e) { r += 7; }
    catch (NullPointerException e) { r += 9; }
    try { r += o.hashCode() == 0 ? 1 : 2; } catch (NullPointerException e) { r += 11; }
    for (int k = 0; k < 4; k++) {
      try { r += 100 / (k - 2); } catch (ArithmeticException e) { r -= 13; }
    }
    return r;
  }

  // ---------- reference stores, with a real collection in between ----------
  // If the card mark is missing, the collector never scans this old object and
  // the young references it holds are freed underneath it.
  static final class Holder { Object x0, x1, x2, x3; }
  static Holder[] old = new Holder[64];
  static long barrier(int round) {
    for (int i = 0; i < old.length; i++) {
      Holder h = old[i];
      h.x0 = new int[] { round + i, 1 };
      h.x1 = Integer.valueOf(round * 31 + i);
      h.x2 = new Node(round + i, null);
      h.x3 = "s" + ((round + i) & 7);
    }
    // churn, so a young collection happens with those stores outstanding
    Object sink = null;
    for (int i = 0; i < 40000; i++) sink = new int[4];
    if (sink == null) return -1;
    long sum = 0;
    for (int i = 0; i < old.length; i++) {
      Holder h = old[i];
      sum += ((int[])h.x0)[0] + ((int[])h.x0)[1];
      sum += ((Integer)h.x1).intValue();
      sum += ((Node)h.x2).a;
      sum += ((String)h.x3).length() + ((String)h.x3).charAt(1);
    }
    return sum;
  }

  // ---------- statics of every width ----------
  static int si; static long sl; static float sf; static double sd;
  static byte sb; static short ss; static char sc; static boolean sz;
  static long statics(int i) {
    si = i; sl = i * 7L; sf = i * 0.25f; sd = i / 7.0;
    sb = (byte)i; ss = (short)i; sc = (char)i; sz = (i & 1) != 0;
    return si + sl + (long)sf + (long)sd + sb + ss + sc + (sz ? 1 : 0);
  }

  public static void main(String[] args) {
    for (int i = 0; i < old.length; i++) old[i] = new Holder();
    for (int i = 0; i < darr.length; i++) darr[i] = i + 1;

    long acc = 0;
    for (int i = 0; i < 3000; i++) {
      float a = (i % 17) - 8.5f, b = (i % 5) - 2.0f;
      acc += Float.floatToRawIntBits(farith(a, b));
      acc += fcmp(a, b) * 3L;
      acc += fconv(a * 1024.0f);
      acc += divs(i - 1500, (i % 7) - 3, i * 1000000007L, (i % 5) - 2);
      acc += shuffle(i);
      acc += dense(i) + sparse(i % 6 == 0 ? 199 : i) + loopswitch(i & 31);
      acc += statics(i);
    }
    System.out.println("d2-scalar " + acc);

    long b2 = 0;
    for (int i = 0; i < 400; i++) b2 += build(20);
    System.out.println("d2-alloc " + b2);

    Object[] os = { new Base(), new Derived(), new Leaf(), "str", new Object(), null };
    long t = 0;
    for (int i = 0; i < 3000; i++) {
      Object o = os[i % os.length];
      try { t += typecheck(o); } catch (NullPointerException e) { t += 5000; }
    }
    System.out.println("d2-types " + t);

    int[] small = { 1, 2, 3 };
    long h = 0;
    for (int i = 0; i < 3000; i++)
      h += handlers((i % 11 == 0) ? null : small, i % 5, (i % 13 == 0) ? null : small);
    System.out.println("d2-handlers " + h);

    long bar = 0;
    for (int r = 0; r < 12; r++) bar += barrier(r);
    System.out.println("d2-barrier " + bar);

    System.out.println("d2-floats " + Float.floatToRawIntBits(farith(Float.NaN, 2.0f))
        + " " + fcmp(Float.NaN, 1.0f) + " " + fcmp(1.0f, Float.NaN)
        + " " + fconv(Float.POSITIVE_INFINITY) + " " + fconv(-1e30f)
        + " " + divs(Integer.MIN_VALUE, -1, Long.MIN_VALUE, -1)
        + " " + divs(7, 0, 7L, 0L));
  }
}
