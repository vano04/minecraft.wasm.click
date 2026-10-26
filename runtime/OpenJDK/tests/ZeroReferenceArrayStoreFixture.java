import java.lang.ref.WeakReference;

/*
 * Generated-OSS-only M2-C2 fixture for the opt-in ZeroWasmBaseline spike.
 *
 * The exact production candidate is intentionally six bytecodes:
 * aload_0, iload_1, aload_2, aastore, aload_2, areturn.  The surrounding
 * cases exercise canonical interpreter precedence and card-mark evidence;
 * this is not Minecraft or an arbitrary-JAR input.
 */
public final class ZeroReferenceArrayStoreFixture {
    private interface Marker {
    }

    private static final class Child implements Marker {
    }

    private ZeroReferenceArrayStoreFixture() {
    }

    public static Object referenceArrayStore(Object[] values, int index,
                                             Object value) {
        values[index] = value;
        return value;
    }

    // Dedicated card-probe setup helper. Ordinary stores never clean a card
    // before their side effect; the native lane accepts this exact two-byte
    // helper only for the separately proven old-array diagnostic.
    public static Object[] prepareReferenceArrayStoreCardProbe(Object[] values) {
        return values;
    }

    public static Object referenceArrayStoreLong(Object[] values, long index,
                                                 Object value) {
        values[(int) index] = value;
        return value;
    }

    public static Object referenceArrayStoreWrongBody(Object[] values, int index,
                                                      Object value) {
        if (index < 0) {
            return null;
        }
        values[index] = value;
        return value;
    }

    public Object referenceArrayStoreInstance(Object[] values, int index,
                                              Object value) {
        values[index] = value;
        return value;
    }

    private static String detail(Throwable error) {
        return error.getClass().getName() + "|" + String.valueOf(error.getMessage());
    }

    private static Object[] snapshot(Object[] values) {
        return values == null ? null : values.clone();
    }

    private static boolean arrayUnchanged(Object[] values, Object[] before) {
        if (values == null || before == null || values.length != before.length) {
            return values == before;
        }
        for (int i = 0; i < values.length; i++) {
            if (values[i] != before[i]) {
                return false;
            }
        }
        return true;
    }

    private static void ageArray(Object[] values) {
        // With SerialGC, keep the array rooted across a full collection so
        // the following store is an old-array -> young-child edge. The
        // pressure is deliberately narrow and is evidence setup only.
        for (int i = 0; i < 512; i++) {
            byte[] pressure = new byte[8192];
            pressure[0] = (byte) i;
        }
        System.gc();
        if (values == null) {
            throw new AssertionError("root array was lost while aging");
        }
    }

    public static void main(String[] args) {
        if (args.length == 0 || "ref-array-store".equals(args[0])) {
            runStoreCases();
            return;
        }
        if ("ref-array-store-root".equals(args[0])) {
            runRootCase();
            return;
        }
        if ("ref-array-store-negatives".equals(args[0])) {
            runNegativeCases();
            return;
        }
        if ("ref-array-store-osr-collision".equals(args[0])) {
            runOsrCollisionCase();
            return;
        }
        throw new IllegalArgumentException("unknown fixture mode: " + args[0]);
    }

    private static void runStoreCases() {
        Object first = new Object();
        Object middle = new Object();
        Object last = new Object();
        Object replacement0 = new Object();
        Object replacement1 = new Object();
        Object replacement2 = new Object();
        Child child = new Child();
        Object[] values = new Object[] { first, middle, last };
        Number[] numbers = new Number[] { Integer.valueOf(1) };
        Marker[] markers = new Marker[] { child };
        Object[][] arrays = new Object[][] { new Object[] { "old" } };

        System.out.println("CASE_BEGIN direct");
        boolean firstOk = referenceArrayStore(values, 0, replacement0) == replacement0
                && values[0] == replacement0;
        // This is both the middle-position direct case and the successful
        // null-value/card-mark case; keep it as one call for the 6+8 matrix.
        boolean middleOk = referenceArrayStore(values, 1, null) == null
                && values[1] == null;
        boolean lastOk = referenceArrayStore(values, 2, replacement2) == replacement2
                && values[2] == replacement2;
        boolean subclassOk = referenceArrayStore(numbers, 0, Integer.valueOf(2))
                instanceof Integer && numbers[0].intValue() == 2;
        boolean interfaceOk = referenceArrayStore(markers, 0, child) == child
                && markers[0] == child;
        boolean covariantArrayOk = referenceArrayStore(arrays, 0, new String[] { "new" })
                instanceof String[] && arrays[0] instanceof String[];
        boolean nullValueOk = middleOk;
        System.out.println("CASE_END direct");

        int nullNpe = 0;
        int negativeAioobe = 0;
        int lengthAioobe = 0;
        int minIndexAioobe = 0;
        int emptyAioobe = 0;
        int boundsAseAioobe = 0;
        int stringArrayAse = 0;
        int numberArrayAse = 0;
        boolean rejectArrayUnchanged = true;
        String nullDetail = "";
        String boundsDetail = "";
        System.out.println("CASE_BEGIN null");
        try {
            referenceArrayStore(null, Integer.MIN_VALUE, Integer.valueOf(1));
        } catch (NullPointerException expected) {
            nullNpe = 1;
            nullDetail = detail(expected);
        }
        System.out.println("CASE_END null");
        System.out.println("CASE_BEGIN negative");
        String[] negativeValues = new String[] { "old" };
        Object[] negativeBefore = snapshot(negativeValues);
        try {
            referenceArrayStore(negativeValues, -1, Integer.valueOf(1));
        } catch (ArrayIndexOutOfBoundsException expected) {
            negativeAioobe = 1;
            boundsDetail = detail(expected);
        }
        rejectArrayUnchanged &= arrayUnchanged(negativeValues, negativeBefore);
        System.out.println("CASE_END negative");
        System.out.println("CASE_BEGIN length");
        Object[] lengthBefore = snapshot(values);
        try {
            referenceArrayStore(values, values.length, new Object());
        } catch (ArrayIndexOutOfBoundsException expected) {
            lengthAioobe = 1;
        }
        rejectArrayUnchanged &= arrayUnchanged(values, lengthBefore);
        System.out.println("CASE_END length");
        System.out.println("CASE_BEGIN min-index");
        Object[] minBefore = snapshot(values);
        try {
            referenceArrayStore(values, Integer.MIN_VALUE, new Object());
        } catch (ArrayIndexOutOfBoundsException expected) {
            minIndexAioobe = 1;
        }
        rejectArrayUnchanged &= arrayUnchanged(values, minBefore);
        System.out.println("CASE_END min-index");
        System.out.println("CASE_BEGIN empty");
        Object[] emptyValues = new Object[0];
        Object[] emptyBefore = snapshot(emptyValues);
        try {
            referenceArrayStore(emptyValues, 0, new Object());
        } catch (ArrayIndexOutOfBoundsException expected) {
            emptyAioobe = 1;
        }
        rejectArrayUnchanged &= arrayUnchanged(emptyValues, emptyBefore);
        System.out.println("CASE_END empty");
        System.out.println("CASE_BEGIN bounds-ase");
        String[] boundsValues = new String[] { "old" };
        Object[] boundsBefore = snapshot(boundsValues);
        try {
            referenceArrayStore(boundsValues, 1, Integer.valueOf(1));
        } catch (ArrayIndexOutOfBoundsException expected) {
            boundsAseAioobe = 1;
        }
        rejectArrayUnchanged &= arrayUnchanged(boundsValues, boundsBefore);
        System.out.println("CASE_END bounds-ase");
        System.out.println("CASE_BEGIN string-ase");
        String[] stringValues = new String[] { "old" };
        Object[] stringBefore = snapshot(stringValues);
        try {
            referenceArrayStore(stringValues, 0, Integer.valueOf(1));
        } catch (ArrayStoreException expected) {
            stringArrayAse = 1;
        }
        rejectArrayUnchanged &= arrayUnchanged(stringValues, stringBefore);
        System.out.println("CASE_END string-ase");
        System.out.println("CASE_BEGIN number-ase");
        Number[] numberValues = new Number[] { Integer.valueOf(1) };
        Object[] numberBefore = snapshot(numberValues);
        try {
            referenceArrayStore(numberValues, 0, "bad");
        } catch (ArrayStoreException expected) {
            numberArrayAse = 1;
        }
        rejectArrayUnchanged &= arrayUnchanged(numberValues, numberBefore);
        System.out.println("CASE_END number-ase");

        if (!firstOk || !middleOk || !lastOk || !subclassOk || !interfaceOk
                || !covariantArrayOk || !nullValueOk || nullNpe != 1 || negativeAioobe != 1
                || lengthAioobe != 1 || minIndexAioobe != 1 || emptyAioobe != 1
                || boundsAseAioobe != 1
                || stringArrayAse != 1 || numberArrayAse != 1 || !rejectArrayUnchanged) {
            throw new AssertionError("reference-array-store fixture failed");
        }
        System.out.println("reject-array-unchanged=" + (rejectArrayUnchanged ? 1 : 0));
        System.out.println("ref-array-store direct-first=" + (firstOk ? 1 : 0)
                + " direct-middle=" + (middleOk ? 1 : 0)
                + " direct-last=" + (lastOk ? 1 : 0)
                + " subclass=" + (subclassOk ? 1 : 0)
                + " interface=" + (interfaceOk ? 1 : 0)
                + " covariant-array=" + (covariantArrayOk ? 1 : 0)
                + " null-value=" + (nullValueOk ? 1 : 0)
                + " null-npe=" + nullNpe
                + " negative-aioobe=" + negativeAioobe
                + " length-aioobe=" + lengthAioobe
                + " min-index-aioobe=" + minIndexAioobe
                + " empty-aioobe=" + emptyAioobe
                + " bounds-ase-aioobe=" + boundsAseAioobe
                + " string-ase=" + stringArrayAse
                + " number-ase=" + numberArrayAse
                + " reject-array-unchanged=" + (rejectArrayUnchanged ? 1 : 0));
        System.out.println("ref-array-store-exceptions null=" + nullDetail
                + " negative=" + boundsDetail);
    }

    private static void runRootCase() {
        Object[] values = new Object[2048];
        System.out.println("ROOT_PRE_STORE_GC_BEGIN");
        ageArray(values);
        System.out.println("ROOT_PRE_STORE_GC_END");
        values = prepareReferenceArrayStoreCardProbe(values);
        int storeIndex = values.length / 2;

        Object expected = new Object();
        WeakReference<Object> childWeak = new WeakReference<>(expected);
        System.out.println("CASE_BEGIN root-liveness");
        Object returned = referenceArrayStore(values, storeIndex, expected);
        boolean returnedIdentity = returned == expected && values[storeIndex] == expected;
        System.out.println("CASE_END root-liveness");
        // Do not let the caller's temporaries mask a missing old->young card
        // mark. After these stores, the array is the only strong child root.
        returned = null;
        expected = null;
        System.out.println("ROOT_POST_STORE_YOUNG_BEGIN");
        // Allocation-failure pressure, not an explicit Full GC. The gate
        // requires a Young collection in this window and rejects Full.
        for (int i = 0; i < 4096; i++) {
            byte[] pressure = new byte[16384];
            pressure[0] = (byte) i;
        }
        System.out.println("ROOT_POST_STORE_YOUNG_END");
        Object retained = childWeak.get();
        boolean arrayIdentity = retained != null && values[storeIndex] == retained;
        if (!returnedIdentity || !arrayIdentity) {
            throw new AssertionError("reference-array-store root fixture failed");
        }
        System.out.println("ref-array-store-root identity=1 array-identity=1 weak=1");
    }

    private static void runNegativeCases() {
        Object[] values = new Object[] { "near-miss" };
        boolean descriptor = "near-miss".equals(
                referenceArrayStoreLong(values, 0L, "near-miss"));
        boolean owner = "near-miss".equals(
                ZeroReferenceArrayStoreNearMiss.referenceArrayStore(values, 0,
                                                                      "near-miss"));
        boolean body = referenceArrayStoreWrongBody(values, -1, "bad") == null;
        boolean instance = new ZeroReferenceArrayStoreFixture()
                .referenceArrayStoreInstance(values, 0, values[0]) == values[0];
        if (!descriptor || !owner || !body || !instance) {
            throw new AssertionError("reference-array-store near-miss fixture failed");
        }
        System.out.println("ref-array-store-negatives descriptor=" + (descriptor ? 1 : 0)
                + " owner=" + (owner ? 1 : 0) + " static=1 body=" + (body ? 1 : 0)
                + " instance=" + (instance ? 1 : 0));
    }

    private static void runOsrCollisionCase() {
        Object[] values = new Object[] { null, null };
        Object value = new Object();
        System.out.println("CASE_BEGIN osr-collision");
        int checksum = 0;
        for (int i = 0; i < 512; i++) {
            if (referenceArrayStore(values, i & 1, value) == value) {
                checksum++;
            }
        }
        System.out.println("CASE_END osr-collision");
        if (checksum != 512 || values[0] != value || values[1] != value) {
            throw new AssertionError("reference-array-store OSR collision fixture failed");
        }
        System.out.println("ref-array-store-osr-collision checksum=" + checksum);
    }
}
