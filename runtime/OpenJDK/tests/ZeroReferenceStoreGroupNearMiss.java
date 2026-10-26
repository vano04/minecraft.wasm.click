// Wrong-holder near miss for the M2-C3a exact group classifier.
public final class ZeroReferenceStoreGroupNearMiss {
    private ZeroReferenceStoreGroupNearMiss() {
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

    public static Object groupedReferenceStore(Object[] values, int index,
                                                Object value) {
        return commit(values, index, relay(value));
    }
}
