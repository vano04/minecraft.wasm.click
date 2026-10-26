import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * jdk.internal.misc.Unsafe's native-endian unaligned accessors
 * (get/put{Short,Char,Int,Long}Unaligned) as JIT intrinsics, reached the way
 * the JDK reaches them: heap and direct ByteBuffers in both byte orders, and
 * byte-array view VarHandles. Every offset 0..7 (each alignment the lowering
 * dispatches on), the last index that fits, the first that does not, values
 * with the sign bit set in every piece (short sign-extends, char does not),
 * and a get made from a small method the JIT inlines or runs frameless.
 *
 * Lines starting with "unaligned" must be identical with and without the JIT.
 */
public class JitUnaligned {
    static final VarHandle VS_LE = MethodHandles.byteArrayViewVarHandle(short[].class, ByteOrder.LITTLE_ENDIAN);
    static final VarHandle VC_BE = MethodHandles.byteArrayViewVarHandle(char[].class, ByteOrder.BIG_ENDIAN);
    static final VarHandle VI_LE = MethodHandles.byteArrayViewVarHandle(int[].class, ByteOrder.LITTLE_ENDIAN);
    static final VarHandle VI_BE = MethodHandles.byteArrayViewVarHandle(int[].class, ByteOrder.BIG_ENDIAN);
    static final VarHandle VL_LE = MethodHandles.byteArrayViewVarHandle(long[].class, ByteOrder.LITTLE_ENDIAN);
    static final VarHandle VL_BE = MethodHandles.byteArrayViewVarHandle(long[].class, ByteOrder.BIG_ENDIAN);

    // Every byte of each pattern has its top bit set or clear depending on r,
    // so a lost sign extension or a byte from the wrong piece changes the hash.
    static short s(int r) { return (short) (0x8001 ^ (r * 0x0101)); }
    static char c(int r) { return (char) (0xfffe - r * 0x0103); }
    static int i(int r) { return 0x80ff7f01 ^ (r * 0x01010101); }
    static long l(int r) { return 0x8000ff7f0180fe02L ^ (r * 0x0101010101010101L); }

    // A small get-only method: a candidate for inlining and for a frameless body.
    static long peek(ByteBuffer b, int at) {
        return b.getShort(at) + 3L * b.getChar(at) + 5L * b.getInt(at) + 7L * b.getLong(at);
    }

    static long buffer(ByteBuffer b, int r) {
        long h = 0;
        int lim = b.capacity();
        for (int at = 0; at < 8; at++) {
            b.putShort(at, s(r + at));     h = h * 31 + b.getShort(at) + b.get(at) + b.get(at + 1);
            b.putChar(at + 1, c(r + at));  h = h * 31 + b.getChar(at + 1) + b.get(at + 2);
            b.putInt(at + 2, i(r + at));   h = h * 31 + b.getInt(at + 2) + b.get(at + 2) + b.get(at + 5);
            b.putLong(at + 3, l(r + at));  h = h * 31 + b.getLong(at + 3) + b.get(at + 3) + b.get(at + 10);
            // Overlapping reads across what the last stores wrote.
            h = h * 31 + b.getInt(at + 1) + b.getLong(at) + b.getShort(at + 7) + b.getChar(at + 9);
            b.putFloat(at + 4, i(r) * 0.5f);      h = h * 31 + Float.floatToRawIntBits(b.getFloat(at + 4));
            b.putDouble(at + 5, l(r) * 0.25);     h = h * 31 + Double.doubleToRawLongBits(b.getDouble(at + 5));
            h = h * 31 + peek(b, at);
        }
        // The last index each width fits at, and the first it does not.
        b.putLong(lim - 8, l(r)); b.putInt(lim - 4, i(r)); b.putShort(lim - 2, s(r));
        h = h * 31 + b.getLong(lim - 8) + b.getInt(lim - 4) + b.getShort(lim - 2) + b.getChar(lim - 2);
        int oob = 0;
        try { b.putLong(lim - 7, 1L); } catch (IndexOutOfBoundsException e) { oob++; }
        try { b.getInt(lim - 3); } catch (IndexOutOfBoundsException e) { oob++; }
        try { b.putShort(lim - 1, (short) 1); } catch (IndexOutOfBoundsException e) { oob++; }
        try { b.getChar(lim - 1); } catch (IndexOutOfBoundsException e) { oob++; }
        return h * 31 + oob;
    }

    static long views(byte[] a, int r) {
        long h = 0;
        for (int at = 0; at < 8; at++) {
            VS_LE.set(a, at, s(r + at));       h = h * 31 + (short) VS_LE.get(a, at);
            VC_BE.set(a, at + 1, c(r + at));   h = h * 31 + (char) VC_BE.get(a, at + 1);
            VI_LE.set(a, at + 2, i(r + at));   h = h * 31 + (int) VI_LE.get(a, at + 2) + (int) VI_BE.get(a, at + 2);
            VI_BE.set(a, at + 3, i(r - at));   h = h * 31 + (int) VI_BE.get(a, at + 3) + a[at + 3];
            VL_LE.set(a, at + 4, l(r + at));   h = h * 31 + (long) VL_LE.get(a, at + 4) + (long) VL_BE.get(a, at + 4);
            VL_BE.set(a, at + 5, l(r - at));   h = h * 31 + (long) VL_BE.get(a, at + 5) + a[at + 12];
        }
        return h;
    }

    static String hex(ByteBuffer b, int n) {
        StringBuilder sb = new StringBuilder();
        for (int k = 0; k < n; k++) sb.append(String.format("%02x", b.get(k) & 0xff));
        return sb.toString();
    }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 20000;
        if (args.length > 1 && args[1].equals("bench")) { bench(rounds); return; }
        ByteBuffer[] bufs = {
            ByteBuffer.allocate(64), ByteBuffer.allocate(64).order(ByteOrder.LITTLE_ENDIAN),
            ByteBuffer.allocateDirect(64), ByteBuffer.allocateDirect(64).order(ByteOrder.LITTLE_ENDIAN),
        };
        String[] names = { "heap-be", "heap-le", "direct-be", "direct-le" };
        for (int k = 0; k < bufs.length; k++) {
            long h = 0;
            for (int r = 0; r < rounds; r++) h = h * 31 + buffer(bufs[k], r);
            System.out.println("unaligned " + names[k] + " " + h);
        }
        byte[] a = new byte[24];
        long g = 0;
        for (int r = 0; r < rounds; r++) g = g * 31 + views(a, r);
        System.out.println("unaligned views " + g);
        // Byte layout of one store per piece size, compared byte by byte:
        // an int at 1 (bytes), a long at 6 (shorts), a short at 17 (bytes), a char at 20 (whole).
        ByteBuffer le = ByteBuffer.allocateDirect(32).order(ByteOrder.LITTLE_ENDIAN);
        le.putInt(1, 0x11223344).putLong(6, 0x0102030405060708L).putShort(17, (short) 0xa1b2).putChar(20, (char) 0xc3d4);
        System.out.println("unaligned bytes " + hex(le, 24) + " " + le.getShort(17) + " " + (int) le.getChar(20));
    }

    // `JitUnaligned <n> bench`: ns per ByteBuffer put or get on a direct
    // native-order buffer (the uniform-upload shape): ints at 0 mod 16 and
    // longs at 4 mod 16, then everything at an odd address.
    // Timing only; not part of the differential.
    static void bench(int n) {
        ByteBuffer b = ByteBuffer.allocateDirect(4096).order(ByteOrder.nativeOrder());
        for (int pass = 0; pass < 5; pass++) {
            for (int shift = 0; shift < 2; shift++) {
                long t0 = System.nanoTime(), sum = 0;
                for (int r = 0; r < n; r++) {
                    for (int at = shift; at < 4000; at += 16) { b.putInt(at, r ^ at); b.putLong(at + 4, r); }
                    for (int at = shift; at < 4000; at += 16) sum += b.getInt(at) + b.getLong(at + 4);
                }
                long ops = (long) n * 250 * 4;
                System.out.println("bench " + (shift == 0 ? "aligned" : "offset1") + " "
                        + String.format("%.2f", (System.nanoTime() - t0) / (double) ops) + " ns/op checksum " + sum);
            }
        }
    }
}
