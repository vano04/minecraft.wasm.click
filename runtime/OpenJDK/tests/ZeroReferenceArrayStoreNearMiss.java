/* OSS-only holder-boundary negative for the M2-C2 classifier. */
public final class ZeroReferenceArrayStoreNearMiss {
    private ZeroReferenceArrayStoreNearMiss() {
    }

    // Same descriptor and six-byte body as the candidate, but a different
    // holder. The linked verifier must reject it before module entry.
    public static Object referenceArrayStore(Object[] values, int index,
                                              Object value) {
        values[index] = value;
        return value;
    }
}
