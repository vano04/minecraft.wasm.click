/*
 * OSS-only input for the whole-unit browser-compiler fixture.
 *
 * This is intentionally shaped like a small user program: the compiler must
 * consume the class files produced by javac, link a group into one Wasm
 * module, and use handles plus an explicit runtime ABI for operations which
 * are not pure arithmetic.  It contains no game or third-party input.
 */
public final class WholeUnitFixture {
    public static final class Box {
        public int value;

        public Box(int value) {
            this.value = value;
        }
    }

    public interface Shape {
        int value(int x);
    }

    public static final class Good implements Shape {
        @Override
        public final int value(int x) {
            return x + 11;
        }
    }

    public static final class Other implements Shape {
        @Override
        public final int value(int x) {
            return 29 - x;
        }
    }

    public static final class Holder {
        public static int VALUE;

        static {
            VALUE = 19;
        }
    }

    public static int leaf(int x) {
        return x + 3;
    }

    public static int linked(int x) {
        return leaf(x) * 2;
    }

    public static int objectArray(Box box, int[] values, int index) {
        return box.value + values[index];
    }

    public static int classInit(int x) {
        return Holder.VALUE + x;
    }

    public static int virtual(Shape shape, int x) {
        return shape.value(x);
    }

    public static int safeDiv(int x, int y) {
        try {
            return x / y;
        } catch (ArithmeticException e) {
            return -1;
        }
    }

    public static void main(String[] args) {
        Box box = new Box(5);
        int[] values = {2, 4, 8};
        Shape good = new Good();
        Shape other = new Other();
        System.out.println("whole-fixture "
                + leaf(7) + "," + linked(7) + ","
                + objectArray(box, values, 1) + "," + classInit(7) + ","
                + virtual(good, 7) + "," + virtual(other, 7) + ","
                + safeDiv(7, 3) + "," + safeDiv(7, 0) + ","
                + classInit(8));
    }
}
