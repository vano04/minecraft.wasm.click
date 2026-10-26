// Differential cases for native method calls. Zero calls JNI natives through
// libffi; under -XX:+UseZeroWasmJIT they go through wasm trampolines generated
// per signature instead. Every "native" line must match the interpreter, the
// trampolines disabled (-XX:ZeroWasmJITDisable=4096) and HotSpot itself.
//
// The cases are chosen for the widths a trampoline can get wrong: 64-bit and
// floating-point arguments, and results that libffi widens (signed and
// unsigned bytes, shorts, chars, booleans) or returns in two words.
import java.lang.reflect.Field;
import sun.misc.Unsafe;

public class NativeCalls {
  static final Unsafe U;
  static {
    try {
      Field f = Unsafe.class.getDeclaredField("theUnsafe");
      f.setAccessible(true);
      U = (Unsafe) f.get(null);
    } catch (ReflectiveOperationException e) {
      throw new ExceptionInInitializerError(e);
    }
  }

  static long h(long acc, long v) { return acc * 1_000_003L ^ v; }

  static long unsafeRound(long base, byte[] bytes, long[] longs, double[] doubles, float[] floats) {
    long acc = 17;
    long bo = Unsafe.ARRAY_BYTE_BASE_OFFSET;
    for (int i = 0; i < bytes.length; i++) {
      acc = h(acc, U.getByte(bytes, bo + i));                    // sint8 result
      acc = h(acc, U.getBoolean(bytes, bo + i) ? 1 : 0);         // uint8 result
    }
    for (int i = 0; i + 1 < bytes.length; i += 2) {
      acc = h(acc, U.getShort(bytes, bo + i));                   // sint16 result
      acc = h(acc, U.getChar(bytes, bo + i));                    // uint16 result
    }
    long lo = Unsafe.ARRAY_LONG_BASE_OFFSET;
    for (int i = 0; i < longs.length; i++) {
      acc = h(acc, U.getLong(longs, lo + 8L * i));               // sint64 result
      acc = h(acc, U.getInt(longs, lo + 8L * i + 4));            // sint32 result
      U.putLong(longs, lo + 8L * i, longs[i] * 31 + base);       // sint64 argument
    }
    long dof = Unsafe.ARRAY_DOUBLE_BASE_OFFSET;
    for (int i = 0; i < doubles.length; i++) {
      double d = U.getDouble(doubles, dof + 8L * i);             // double result
      acc = h(acc, Double.doubleToRawLongBits(d));
      U.putDouble(doubles, dof + 8L * i, d * 0.5 + 1);           // double argument
    }
    long fo = Unsafe.ARRAY_FLOAT_BASE_OFFSET;
    for (int i = 0; i < floats.length; i++) {
      float f = U.getFloat(floats, fo + 4L * i);                 // float result
      acc = h(acc, Float.floatToRawIntBits(f));
      U.putFloat(floats, fo + 4L * i, f * 0.75f - 2.5f);         // float argument
    }
    long cell = U.allocateMemory(16);
    try {
      U.putLong(cell, 0x0123_4567_89ab_cdefL ^ base);
      acc = h(acc, U.getLong(cell));
      acc = h(acc, U.getByte(cell + 7));
      acc = h(acc, U.compareAndSwapLong(longs, lo, longs[0], base) ? 3 : 5);
      acc = h(acc, U.compareAndSwapInt(bytes, bo, U.getInt(bytes, bo), (int) base) ? 7 : 11);
    } finally {
      U.freeMemory(cell);
    }
    return acc;
  }

  static long jdkRound(int k) {
    long acc = 29;
    acc = h(acc, Double.doubleToRawLongBits(Double.longBitsToDouble(0x4009_21fb_5444_2d18L + k)));
    acc = h(acc, Float.floatToRawIntBits(Float.intBitsToFloat(0x3fc0_0000 + k)));
    acc = h(acc, Double.doubleToRawLongBits(StrictMath.sqrt(k + 0.25)));
    int[] src = { 1, 2, 3, 4, 5, 6, 7, 8 };
    int[] dst = new int[8];
    System.arraycopy(src, k & 3, dst, 1, 4);                     // void, five arguments
    for (int v : dst) acc = h(acc, v);
    Object o = src.clone();
    acc = h(acc, ((int[]) o)[k & 7]);
    acc = h(acc, o.getClass() == int[].class ? 1 : 2);
    acc = h(acc, Thread.currentThread() != null ? 1 : 2);
    return acc;
  }

  public static void main(String[] args) {
    byte[] bytes = new byte[64];
    for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) (i * 37 - 100);
    long[] longs = { -1L, Long.MIN_VALUE, 0x7fff_ffff_ffffL, 42 };
    double[] doubles = { -0.0, 1.5, Double.MIN_VALUE, -3e300 };
    float[] floats = { -0.0f, 1.25f, Float.MIN_VALUE, 3e30f };
    for (int round = 0; round < 3; round++) {
      long a = 0, b = 0;
      for (int k = 0; k < 400; k++) {
        a = h(a, unsafeRound(k, bytes, longs, doubles, floats));
        b = h(b, jdkRound(k));
      }
      System.out.println("native unsafe " + round + " " + a);
      System.out.println("native jdk " + round + " " + b);
    }
  }
}
