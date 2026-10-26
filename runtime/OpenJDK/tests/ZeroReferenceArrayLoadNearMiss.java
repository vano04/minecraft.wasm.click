/* OSS-only holder-boundary negative for M2-C1 classifier tests. */
public final class ZeroReferenceArrayLoadNearMiss {
    private ZeroReferenceArrayLoadNearMiss() {
    }

    // Deliberately the same descriptor and four-byte body as the candidate,
    // but a different holder. verify_linked_method must reject it.
    public static Object referenceArrayLoad(Object[] values, int index) {
        return values[index];
    }
}
