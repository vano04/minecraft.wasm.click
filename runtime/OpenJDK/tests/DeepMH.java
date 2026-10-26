import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;

// Compare bound/direct MethodHandle recursion with java.lang.invoke included
// and excluded from the JIT allowlist, using identical stack/frame-pad limits.
// "soe N" records Java stack-overflow handling; recovery uses the depth that
// already completed during warmup, not the depth that just overflowed.
// Retain the worker error separately: a truncated log alone proves no cause.
//
//   DeepMH [step] [special|static]
public class DeepMH {
  private static final MethodType STEP = MethodType.methodType(int.class, int.class);
  private static MethodHandle staticSelf;

  private MethodHandle self;

  private int step(int n) throws Throwable {
    return n == 0 ? 0 : 1 + (int) self.invokeExact(n - 1);
  }

  private static int stepStatic(int n) throws Throwable {
    return n == 0 ? 0 : 1 + (int) staticSelf.invokeExact(n - 1);
  }

  public static void main(String[] a) throws Throwable {
    int stepBy = a.length > 0 ? Integer.parseInt(a[0]) : 250;
    boolean special = a.length < 2 || !a[1].equals("static");
    MethodHandles.Lookup lookup = MethodHandles.lookup();
    DeepMH d = new DeepMH();
    MethodHandle top;
    if (special) {
      d.self = lookup.findSpecial(DeepMH.class, "step", STEP, DeepMH.class).bindTo(d);
      top = d.self;
    } else {
      // Bound to a dummy leading argument, so the call still goes through a
      // bound handle's LambdaForm before the direct handle's.
      MethodHandle direct = lookup.findStatic(DeepMH.class, "stepStatic", STEP);
      staticSelf = MethodHandles.dropArguments(direct, 0, Object.class).bindTo("bound");
      top = staticSelf;
    }
    // Enough calls for the LambdaForms to be customized and compiled.
    long warm = 0;
    for (int w = 0; w < 5000; w++) warm += (int) top.invokeExact(10);
    System.out.println("warm " + warm);
    int soe = -1;
    for (int n = stepBy; n <= 400000; n += stepBy) {
      try {
        int r = (int) top.invokeExact(n);
        if (r != n) throw new AssertionError("wrong " + n + " -> " + r);
      } catch (StackOverflowError e) {
        soe = n;
        System.out.println("soe " + n);
        break;
      }
      System.out.println("ok " + n);
    }
    if (soe < 0) throw new AssertionError("no overflow within probe depth");
    int after = (int) top.invokeExact(10);
    if (after != 10) throw new AssertionError("recovery returned " + after);
    System.out.println("after " + after);
    System.out.println("deepmh done");
  }
}
