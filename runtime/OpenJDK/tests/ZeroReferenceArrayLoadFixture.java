/*
 * Generated-OSS-only M2-C1 fixture for the opt-in ZeroWasmBaseline spike.
 *
 * The exact production candidate is intentionally four bytecodes:
 * aload_0, iload_1, aaload, areturn.  The class contains only local test
 * helpers around that method; it is not a Minecraft or arbitrary-JAR input.
 */
public final class ZeroReferenceArrayLoadFixture {
    private ZeroReferenceArrayLoadFixture() {
    }

    public static Object referenceArrayLoad(Object[] values, int index) {
        return values[index];
    }

    // Classifier near misses: the linked lane is exact about name,
    // descriptor, static-ness, and body shape.
    public static Object referenceArrayLoadLong(Object[] values, long index) {
        return values[(int) index];
    }

    public static Object referenceArrayLoadWrongBody(Object[] values, int index) {
        if (index < 0) {
            return null;
        }
        return values[index];
    }

    public Object referenceArrayLoadInstance(Object[] values, int index) {
        return values[index];
    }

    private static String detail(Throwable error) {
        return error.getClass().getName() + "|" + String.valueOf(error.getMessage());
    }

    public static void main(String[] args) {
        if (args.length == 0 || "ref-array-load".equals(args[0])) {
            runLoadCases();
            return;
        }
        if ("ref-array-root".equals(args[0])) {
            runRootCase();
            return;
        }
        if ("ref-array-negatives".equals(args[0])) {
            runNegativeCases();
            return;
        }
        if ("ref-array-osr-collision".equals(args[0])) {
            runOsrCollisionCase();
            return;
        }
        throw new IllegalArgumentException("unknown fixture mode: " + args[0]);
    }

    private static void runLoadCases() {
        Object first = new Object();
        Object middle = new Object();
        Object last = new Object();
        Object[] values = new Object[] { first, middle, last };
        String[] covariant = new String[] { "cov-first", "cov-last" };
        System.out.println("CASE_BEGIN identity");
        boolean firstOk = referenceArrayLoad(values, 0) == first;
        boolean middleOk = referenceArrayLoad(values, 1) == middle;
        boolean lastOk = referenceArrayLoad(values, 2) == last;
        System.out.println("CASE_END identity");

        values[1] = null;
        System.out.println("CASE_BEGIN null-element");
        boolean nullElementOk = referenceArrayLoad(values, 1) == null;
        System.out.println("CASE_END null-element");
        values[1] = middle;
        System.out.println("CASE_BEGIN covariant");
        boolean covariantOk = "cov-last".equals(referenceArrayLoad(covariant, 1));
        System.out.println("CASE_END covariant");

        int nullNpe = 0;
        int negativeAioobe = 0;
        int lengthAioobe = 0;
        int minIndexAioobe = 0;
        int emptyAioobe = 0;
        String nullDetail = "";
        String boundsDetail = "";
        System.out.println("CASE_BEGIN null");
        try {
            referenceArrayLoad(null, 0);
        } catch (NullPointerException expected) {
            nullNpe = 1;
            nullDetail = detail(expected);
        }
        System.out.println("CASE_END null");
        System.out.println("CASE_BEGIN negative");
        try {
            referenceArrayLoad(values, -1);
        } catch (ArrayIndexOutOfBoundsException expected) {
            negativeAioobe = 1;
            boundsDetail = detail(expected);
        }
        System.out.println("CASE_END negative");
        System.out.println("CASE_BEGIN length");
        try {
            referenceArrayLoad(values, values.length);
        } catch (ArrayIndexOutOfBoundsException expected) {
            lengthAioobe = 1;
        }
        System.out.println("CASE_END length");
        System.out.println("CASE_BEGIN min-index");
        try {
            referenceArrayLoad(values, Integer.MIN_VALUE);
        } catch (ArrayIndexOutOfBoundsException expected) {
            minIndexAioobe = 1;
        }
        System.out.println("CASE_END min-index");
        System.out.println("CASE_BEGIN empty");
        try {
            referenceArrayLoad(new Object[0], 0);
        } catch (ArrayIndexOutOfBoundsException expected) {
            emptyAioobe = 1;
        }
        System.out.println("CASE_END empty");

        if (!firstOk || !middleOk || !lastOk || !nullElementOk || !covariantOk
                || nullNpe != 1 || negativeAioobe != 1
                || lengthAioobe != 1 || minIndexAioobe != 1 || emptyAioobe != 1) {
            throw new AssertionError("reference-array fixture failed");
        }
        System.out.println("ref-array-load first=" + (firstOk ? 1 : 0)
                + " middle=" + (middleOk ? 1 : 0)
                + " last=" + (lastOk ? 1 : 0)
                + " null-element=" + (nullElementOk ? 1 : 0)
                + " covariant=" + (covariantOk ? 1 : 0)
                + " null-npe=" + nullNpe
                + " negative-aioobe=" + negativeAioobe
                + " length-aioobe=" + lengthAioobe
                + " min-index-aioobe=" + minIndexAioobe
                + " empty-aioobe=" + emptyAioobe);
        System.out.println("ref-array-exceptions null=" + nullDetail
                + " negative=" + boundsDetail);
    }

    private static void runRootCase() {
        Object expected = new Object();
        Object[] values = new Object[] { expected };
        System.out.println("CASE_BEGIN root-liveness");
        Object returned = referenceArrayLoad(values, 0);
        System.out.println("CASE_END root-liveness");
        // The linked call has already published the returned oop in the
        // caller's expression stack before CASE_END. Keep a second caller
        // root, request GC only after that return, and check identity without
        // claiming that this C1 smoke test observes a moving collector.
        System.out.println("ROOT_POST_RETURN_GC_BEGIN");
        System.gc();
        for (int i = 0; i < 2048; i++) {
            Object[] pressure = new Object[64];
            pressure[0] = new Object();
        }
        System.out.println("ROOT_POST_RETURN_GC_END");
        boolean identity = returned == expected;
        if (!identity) {
            throw new AssertionError("reference-array root fixture failed");
        }
        System.out.println("ref-array-root identity=1");
    }

    private static void runNegativeCases() {
        Object[] values = new Object[] { "near-miss" };
        boolean descriptor = "near-miss".equals(
                referenceArrayLoadLong(values, 0L));
        boolean owner = "near-miss".equals(
                ZeroReferenceArrayLoadNearMiss.referenceArrayLoad(values, 0));
        boolean body = referenceArrayLoadWrongBody(values, -1) == null;
        boolean instance = new ZeroReferenceArrayLoadFixture()
                .referenceArrayLoadInstance(values, 0) == values[0];
        if (!descriptor || !owner || !body || !instance) {
            throw new AssertionError("reference-array near-miss fixture failed");
        }
        System.out.println("ref-array-negatives descriptor=" + (descriptor ? 1 : 0)
                + " owner=" + (owner ? 1 : 0) + " static=1 body=" + (body ? 1 : 0)
                + " instance=" + (instance ? 1 : 0));
    }

    private static void runOsrCollisionCase() {
        Object[] values = new Object[] { new Object(), new Object() };
        System.out.println("CASE_BEGIN osr-collision");
        int checksum = 0;
        for (int i = 0; i < 512; i++) {
            if (referenceArrayLoad(values, i & 1) != null) {
                checksum++;
            }
        }
        System.out.println("CASE_END osr-collision");
        if (checksum != 512) {
            throw new AssertionError("reference-array OSR collision fixture failed");
        }
        System.out.println("ref-array-osr-collision checksum=" + checksum);
    }
}
