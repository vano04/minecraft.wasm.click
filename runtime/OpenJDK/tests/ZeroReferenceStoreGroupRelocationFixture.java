// OSS-only M2-C3b Stage-1 structure. Runtime relocation remains disabled.
public final class ZeroReferenceStoreGroupRelocationFixture {
    private ZeroReferenceStoreGroupRelocationFixture() {
    }

    private static Object leaf(Object value) {
        return value;
    }

    private static Object relay(Object value) {
        return leaf(value);
    }

    private static Object commit(Object[] values, int index, Object value) {
        values[index] = value;
        return value;
    }

    private static Object phase0(Object value) {
        return relay(value);
    }

    private static Object phase1(Object[] values, int index, Object original,
                                 Object kept, int token) {
        if (original != kept || token == 0) {
            throw new IllegalStateException();
        }
        return commit(values, index, relay(kept));
    }

    public static Object groupedReferenceStoreAcrossRelocation(
            Object[] values, int index, Object value) {
        Object kept = phase0(value);
        int token = 1;
        ZeroReferenceStoreGroupRelocationProbe.forceYoungRelocation();
        return phase1(values, index, value, kept, token);
    }
}
