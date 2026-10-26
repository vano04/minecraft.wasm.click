// Stage-1 JVM semantic driver. The relocation seam is intentionally a no-op.
public final class ZeroReferenceStoreGroupRelocationProbe {
    private ZeroReferenceStoreGroupRelocationProbe() {
    }

    public static void forceYoungRelocation() {
        // Stage 1 must not execute GC. A later focused gate replaces this
        // no-op contract with an exact relocation window.
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    public static void main(String[] args) {
        require(args.length == 1 && args[0].equals("stage1"), "mode");
        Object[] values = {"before"};
        Object expected = new Object();
        Object returned = ZeroReferenceStoreGroupRelocationFixture
                .groupedReferenceStoreAcrossRelocation(values, 0, expected);
        require(returned == expected && values[0] == expected,
                "fixture identity/store");

        Object[] nearValues = {"near-before"};
        Object nearExpected = new Object();
        Object nearReturned = ZeroReferenceStoreGroupRelocationNearMiss
                .groupedReferenceStoreAcrossRelocation(
                        nearValues, 0, nearExpected);
        require(nearReturned == nearExpected
                        && nearValues[0] == nearExpected,
                "near-miss identity/store");
        System.out.println("reference-store-group-relocation-stage1"
                + " fixture=pass near-miss=pass gc=not-executed");
    }
}
