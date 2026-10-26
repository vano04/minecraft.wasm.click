import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReferenceArray;

/**
 * jdk.internal.misc.Unsafe's accessors as JIT intrinsics (NO_UNSAFE to
 * disable): every width, plain and volatile, through VarHandles on fields
 * and arrays, AtomicReferenceArray, and ConcurrentHashMap (tabAt is
 * getReferenceAcquire).
 *
 * Lines starting with "unsafe" must be identical with and without the JIT.
 */
public class JitUnsafe {
    static final java.util.concurrent.atomic.AtomicLong LCTR = new java.util.concurrent.atomic.AtomicLong();
    static final java.util.concurrent.atomic.AtomicInteger CTR = new java.util.concurrent.atomic.AtomicInteger();
    static final java.util.concurrent.atomic.AtomicReference<Object> REF = new java.util.concurrent.atomic.AtomicReference<>();
    static final class Box { int i; long l; byte b; short s; char c; boolean z; float f; double d; Object o; }
    static final VarHandle I, L, B, S, C, Z, F, D, O, ARR;
    static {
        try {
            MethodHandles.Lookup lk = MethodHandles.lookup();
            I = lk.findVarHandle(Box.class, "i", int.class);
            L = lk.findVarHandle(Box.class, "l", long.class);
            B = lk.findVarHandle(Box.class, "b", byte.class);
            S = lk.findVarHandle(Box.class, "s", short.class);
            C = lk.findVarHandle(Box.class, "c", char.class);
            Z = lk.findVarHandle(Box.class, "z", boolean.class);
            F = lk.findVarHandle(Box.class, "f", float.class);
            D = lk.findVarHandle(Box.class, "d", double.class);
            O = lk.findVarHandle(Box.class, "o", Object.class);
            ARR = MethodHandles.arrayElementVarHandle(Object[].class);
        } catch (ReflectiveOperationException e) { throw new Error(e); }
    }

    static long fields(Box x, int r) {
        I.set(x, r * 7); L.set(x, r * 0x1_0000_0001L); B.set(x, (byte) (r * 37)); S.set(x, (short) (r * 1009));
        C.set(x, (char) (r * 31)); Z.set(x, (r & 1) == 0); F.set(x, r * 0.5f); D.set(x, r * 0.25);
        long v = (int) I.get(x) + (long) L.get(x) + (byte) B.get(x) + (short) S.get(x) + (char) C.get(x)
               + ((boolean) Z.get(x) ? 1 : 0) + (long) ((float) F.get(x) * 4) + (long) ((double) D.get(x) * 8);
        I.setVolatile(x, (int) I.getVolatile(x) + 1);
        B.setVolatile(x, (byte) ((byte) B.getVolatile(x) - 3));
        S.setOpaque(x, (short) ((short) S.getOpaque(x) - 5));
        C.setRelease(x, (char) ((char) C.getAcquire(x) + 7));
        Z.setVolatile(x, !(boolean) Z.getVolatile(x));
        F.setVolatile(x, (float) F.getVolatile(x) - 1.5f);
        O.setVolatile(x, (r % 3 == 0) ? null : x);
        // Compare-and-set and -exchange, int and reference, hit and miss.
        int iv = (int) I.getVolatile(x);
        boolean c1 = I.compareAndSet(x, iv, iv + 3);
        boolean c2 = I.compareAndSet(x, iv, iv + 5);          // misses: already changed
        int ex = (int) I.compareAndExchange(x, iv + 3, iv - 1);
        Object ov = O.getVolatile(x);
        boolean c3 = O.compareAndSet(x, ov, (r & 1) == 0 ? "s" + r : null);
        Object oe = O.compareAndExchange(x, "nope", x);
        CTR.addAndGet(r & 7);
        LCTR.addAndGet(r);                                     // compareAndSetLong under getAndAdd
        long lv = LCTR.get();
        boolean c4 = LCTR.compareAndSet(lv, lv * 3 + 1), c5 = LCTR.compareAndSet(lv, 7);
        v += (c4 ? 32 : 0) + (c5 ? 64 : 0) + (LCTR.get() & 0xffff);
        REF.compareAndSet(REF.get(), (r & 3) == 0 ? null : x);
        v += (c1 ? 1 : 0) + (c2 ? 2 : 0) + ex + (c3 ? 4 : 0) + (oe == null ? 8 : 16) + CTR.get() + (REF.get() == null ? 1 : 3);
        v = v * 31 + (int) I.getVolatile(x) + (byte) B.getVolatile(x) + (short) S.getOpaque(x)
          + (char) C.getAcquire(x) + ((boolean) Z.getVolatile(x) ? 1 : 0)
          + Float.floatToIntBits((float) F.getVolatile(x)) + (O.getVolatile(x) == null ? -9 : 9);
        return v;
    }

    static long arrays(Object[] a, AtomicReferenceArray<String> ara, int r) {
        ARR.setVolatile(a, r & 7, (r & 1) == 0 ? "e" : null);
        ara.set(r & 15, (r & 3) == 0 ? "a" + (r & 7) : null);
        Object e = ARR.getVolatile(a, (r + 3) & 7);
        String s = ara.get((r + 5) & 15);
        return (e == null ? 1 : 2) + (s == null ? 0 : s.length() * 10);
    }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 30000;
        Box x = new Box();
        long h = 0;
        for (int r = 0; r < rounds; r++) h = h * 31 + fields(x, r);
        System.out.println("unsafe fields " + h + " b=" + x.b + " s=" + x.s + " c=" + (int) x.c + " z=" + x.z + " f=" + x.f);
        Object[] a = new Object[8];
        AtomicReferenceArray<String> ara = new AtomicReferenceArray<>(16);
        long g = 0;
        for (int r = 0; r < rounds; r++) g += arrays(a, ara, r);
        System.out.println("unsafe arrays " + g);
        ConcurrentHashMap<Integer, Integer> m = new ConcurrentHashMap<>();
        long k = 0;
        for (int r = 0; r < rounds; r++) { m.merge(r & 255, 1, Integer::sum); k += m.getOrDefault((r * 7) & 255, 0); }
        System.out.println("unsafe chm " + k + " " + m.size() + " " + m.get(17));
    }
}
