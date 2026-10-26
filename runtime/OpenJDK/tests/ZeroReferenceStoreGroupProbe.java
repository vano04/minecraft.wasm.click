// OSS-only semantic driver for the M2-C3a exact reference-store group.
import java.util.Arrays;
import java.lang.ref.WeakReference;

public final class ZeroReferenceStoreGroupProbe {
    private interface Marker {
    }

    private static final class Child implements Marker {
    }

    private ZeroReferenceStoreGroupProbe() {
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    private static void requireIdentitySnapshot(Object[] values, Object[] before,
                                                String label) {
        require(values.length == before.length, label + " length");
        for (int i = 0; i < values.length; i++) {
            require(values[i] == before[i], label + " element " + i);
        }
    }

    private static boolean expectReject(Object[] values, int index, Object value,
                                        Class<? extends Throwable> expected,
                                        String label) {
        Object[] before = values == null ? null : values.clone();
        try {
            ZeroReferenceStoreGroupFixture.groupedReferenceStore(values, index,
                                                                  value);
            throw new AssertionError(label + " accepted");
        } catch (Throwable failure) {
            require(expected.isInstance(failure), label + " wrong failure " + failure);
        }
        if (values != null) {
            requireIdentitySnapshot(values, before, label);
        }
        return true;
    }

    private static void runMatrix() {
        Object[] values = {"a", "b", "c"};
        Object first = new Object();
        Object last = new Object();
        Number[] numbers = {Integer.valueOf(1)};
        Marker[] markers = {null};
        Child child = new Child();
        Object[][] arrays = {new Object[0]};

        int direct = 0;
        direct += ZeroReferenceStoreGroupFixture.groupedReferenceStore(values, 0, first)
                == first && values[0] == first ? 1 : 0;
        direct += ZeroReferenceStoreGroupFixture.groupedReferenceStore(values, 1, null)
                == null && values[1] == null ? 1 : 0;
        direct += ZeroReferenceStoreGroupFixture.groupedReferenceStore(values, 2, last)
                == last && values[2] == last ? 1 : 0;
        direct += ZeroReferenceStoreGroupFixture.groupedReferenceStore(
                numbers, 0, Integer.valueOf(2)) == numbers[0] ? 1 : 0;
        direct += ZeroReferenceStoreGroupFixture.groupedReferenceStore(markers, 0, child)
                == child && markers[0] == child ? 1 : 0;
        String[] replacement = {"new"};
        direct += ZeroReferenceStoreGroupFixture.groupedReferenceStore(
                arrays, 0, replacement) == replacement && arrays[0] == replacement ? 1 : 0;

        int rejected = 0;
        rejected += expectReject(null, Integer.MIN_VALUE, new Object(),
                                 NullPointerException.class, "null-min") ? 1 : 0;
        rejected += expectReject(new Object[] {"n0", "n1"}, -1, new Object(),
                                 ArrayIndexOutOfBoundsException.class, "negative") ? 1 : 0;
        rejected += expectReject(new Object[] {"u0", "u1"}, 2, new Object(),
                                 ArrayIndexOutOfBoundsException.class, "upper") ? 1 : 0;
        rejected += expectReject(new Object[] {"m0", "m1"}, Integer.MIN_VALUE,
                                 new Object(), ArrayIndexOutOfBoundsException.class,
                                 "min") ? 1 : 0;
        rejected += expectReject(new Object[0], 0, new Object(),
                                 ArrayIndexOutOfBoundsException.class, "empty") ? 1 : 0;
        rejected += expectReject(new String[] {"p0"}, 1, Integer.valueOf(1),
                                 ArrayIndexOutOfBoundsException.class,
                                 "bounds-before-type") ? 1 : 0;
        rejected += expectReject(new String[] {"s0"}, 0, Integer.valueOf(1),
                                 ArrayStoreException.class, "string-type") ? 1 : 0;
        rejected += expectReject(new Number[] {Integer.valueOf(1)}, 0, "bad",
                                 ArrayStoreException.class, "number-type") ? 1 : 0;

        require(direct == 6, "direct count " + direct);
        require(rejected == 8, "reject count " + rejected);
        System.out.println("reference-store-group direct=6 reexec=8 "
                + "reject-array-unchanged=8 result=pass");
    }

    private static void runNearMiss() {
        Object[] values = {"before"};
        Object replacement = new Object();
        Object result = ZeroReferenceStoreGroupNearMiss.groupedReferenceStore(
                values, 0, replacement);
        require(result == replacement && values[0] == replacement, "near miss");
        System.out.println("reference-store-group-near-miss owner=1 result=pass");
    }

    private static void runOsr() {
        Object[] values = {null, null};
        int checksum = 0;
        for (int i = 0; i < 512; i++) {
            Object value = Integer.valueOf(i);
            if (ZeroReferenceStoreGroupFixture.groupedReferenceStore(
                    values, i & 1, value) == value) {
                checksum++;
            }
        }
        require(checksum == 512, "osr checksum");
        System.out.println("reference-store-group-osr checksum=512 result=pass");
    }

    private static void runSingle() {
        Object[] values = {"before"};
        Object replacement = new Object();
        Object result = ZeroReferenceStoreGroupFixture.groupedReferenceStore(
                values, 0, replacement);
        require(result == replacement && values[0] == replacement, "single");
        System.out.println("reference-store-group-single result=pass");
    }

    private static void ageArray(Object[] values) {
        for (int i = 0; i < 512; i++) {
            byte[] pressure = new byte[8192];
            pressure[0] = (byte) i;
        }
        System.gc();
        require(values != null, "root array lost during aging");
    }

    private static void runRoot() {
        Object[] values = new Object[2048];
        System.out.println("GROUP_ROOT_PRE_STORE_GC_BEGIN");
        ageArray(values);
        System.out.println("GROUP_ROOT_PRE_STORE_GC_END");
        values = ZeroReferenceArrayStoreFixture
                .prepareReferenceArrayStoreCardProbe(values);
        int index = values.length / 2;
        Object expected = new Object();
        WeakReference<Object> weak = new WeakReference<>(expected);
        System.out.println("CASE_BEGIN group-root-liveness");
        Object returned = ZeroReferenceStoreGroupFixture.groupedReferenceStore(
                values, index, expected);
        boolean resultIdentity = returned == expected && values[index] == expected;
        System.out.println("CASE_END group-root-liveness");
        returned = null;
        expected = null;
        System.out.println("GROUP_ROOT_POST_STORE_YOUNG_BEGIN");
        for (int i = 0; i < 4096; i++) {
            byte[] pressure = new byte[16384];
            pressure[0] = (byte) i;
        }
        System.out.println("GROUP_ROOT_POST_STORE_YOUNG_END");
        Object retained = weak.get();
        boolean arrayIdentity = retained != null && values[index] == retained;
        require(resultIdentity && arrayIdentity, "group root/card liveness");
        System.out.println("reference-store-group-root identity=1 array-identity=1 weak=1");
    }

    public static void main(String[] args) {
        require(args.length == 1, "mode");
        switch (args[0]) {
            case "matrix":
                runMatrix();
                break;
            case "near-miss":
                runNearMiss();
                break;
            case "osr":
                runOsr();
                break;
            case "single":
                runSingle();
                break;
            case "root":
                runRoot();
                break;
            default:
                throw new IllegalArgumentException("unknown mode " + Arrays.toString(args));
        }
    }
}
