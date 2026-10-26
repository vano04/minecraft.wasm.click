// OSS-only measurement stubs for the C3a grouped reference-store experiment.
public final class ZeroReferenceStoreGroupPerfFixture {
    private ZeroReferenceStoreGroupPerfFixture() {
    }

    public static int installOnly() {
        return 0;
    }

    public static long lastElapsedNanos() {
        return 0L;
    }

    public static int preparedStartIndex(Object[] values) {
        return -1;
    }

    public static long inlineLoop(int n, Object[] values, int startIndex,
                                  int spanCount, Object valueA, Object valueB) {
        return 0L;
    }

    public static long directLoop(int n, Object[] values, int startIndex,
                                  int spanCount, Object valueA, Object valueB) {
        return 0L;
    }

    public static long indirectLoop(int n, Object[] values, int startIndex,
                                    int spanCount, Object valueA, Object valueB) {
        return 0L;
    }
}
