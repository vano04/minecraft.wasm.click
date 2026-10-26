import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.util.function.Supplier;

/**
 * Unsafe.allocateInstance as a JIT intrinsic: constructor method handles
 * (DirectMethodHandle.allocateInstance) and constructor references, for small
 * and large objects, a class with a finalizer (the slow path), and enough of
 * them that TLABs run out on the way.
 */
public class JitAlloc {
    static final class Small { int a = 7; Object o; Small() {} }
    static final class Big { long a, b, c, d, e, f, g, h; int[] arr = new int[3]; String s = "big"; Big() { a = 1; h = 8; } }
    static final class Fin { int v = 3; Fin() {} @SuppressWarnings("removal") protected void finalize() {} }
    record Point(int x, int y) {}

    public static void main(String[] args) throws Throwable {
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 300000;
        MethodHandles.Lookup lk = MethodHandles.lookup();
        MethodHandle small = lk.findConstructor(Small.class, MethodType.methodType(void.class));
        MethodHandle big = lk.findConstructor(Big.class, MethodType.methodType(void.class));
        MethodHandle fin = lk.findConstructor(Fin.class, MethodType.methodType(void.class));
        MethodHandle point = lk.findConstructor(Point.class, MethodType.methodType(void.class, int.class, int.class));
        Supplier<Small> ref = Small::new;
        long h = 0;
        for (int i = 0; i < n; i++) {
            Small s = (Small) small.invokeExact();
            Big b = (Big) big.invokeExact();
            Point p = (Point) point.invokeExact(i, -i);
            Small r = ref.get();
            h = h * 31 + s.a + (s.o == null ? 1 : 2) + b.a + b.h + b.arr.length + b.s.length() + p.x() + p.y() + r.a;
            if ((i & 4095) == 0) { Fin f = (Fin) fin.invokeExact(); h += f.v; }
        }
        System.out.println("alloc " + h);
    }
}
