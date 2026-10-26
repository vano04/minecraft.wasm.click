/*
 * OSS-only executed near miss for the M2-B int[] store gate.
 *
 * This method has the same name and ([III)I descriptor as the exact
 * ZeroBaselineFixture target, but its exception table makes it ineligible for
 * the dedicated linked shape. It is deliberately a separate holder so the
 * immutable M2-A/P1 fixture class and module bytes remain unchanged.
 */
public final class ZeroExceptionStoreNearMiss {
    public static int intArrayStore(int[] values, int index, int value) {
        try {
            values[index] = value;
            return value;
        } catch (ArrayIndexOutOfBoundsException expected) {
            return -1;
        }
    }

    public static void main(String[] args) {
        int[] values = {7, 8, 9};
        int valid = intArrayStore(values, 1, 42);
        int before0 = values[0];
        int before1 = values[1];
        int before2 = values[2];
        int invalid = intArrayStore(values, values.length, 99);
        boolean neighborsUnchanged = values[0] == before0
                && values[1] == before1 && values[2] == before2;
        System.out.println("array-exception valid=" + valid + " invalid=" + invalid
                + " neighbors-unchanged=" + (neighborsUnchanged ? 1 : 0));
        if (valid != 42 || invalid != -1 || !neighborsUnchanged) {
            throw new AssertionError("exception-table store near miss failed");
        }
    }
}
