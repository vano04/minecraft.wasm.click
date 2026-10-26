public class JitStaticStoreReplay {
    static int plainCount;
    static volatile int volatileCount;

    static final class Cell {
        int value = 7;
    }

    static int publishPlain(Cell cell) {
        plainCount++;
        return cell.value;
    }

    static int drivePlain(Cell cell) {
        return publishPlain(cell) + 1;
    }

    static int publishVolatile(Cell cell) {
        volatileCount++;
        return cell.value;
    }

    static int driveVolatile(Cell cell) {
        return publishVolatile(cell) + 1;
    }

    static void expectNull(Runnable action) {
        try {
            action.run();
        } catch (NullPointerException expected) {
            return;
        }
        throw new AssertionError("The field read must throw for a null cell");
    }

    public static void main(String[] args) {
        Cell cell = new Cell();
        long checksum = 0;
        for (int n = 0; n < 40000; n++) {
            checksum += drivePlain(cell);
            checksum += driveVolatile(cell);
        }
        if (checksum != 640000 || plainCount != 40000 || volatileCount != 40000)
            throw new AssertionError("Warm calls lost or duplicated a static store");

        // The cold guard follows the store in the spliced callee. Replaying
        // that call must not publish the static increment a second time.
        int before = plainCount;
        expectNull(() -> drivePlain(null));
        if (plainCount - before != 1)
            throw new AssertionError("Plain static store replayed: delta=" + (plainCount - before));
        before = volatileCount;
        expectNull(() -> driveVolatile(null));
        if (volatileCount - before != 1)
            throw new AssertionError("Volatile static store replayed: delta=" + (volatileCount - before));

        before = plainCount;
        expectNull(() -> publishPlain(null));
        if (plainCount - before != 1)
            throw new AssertionError("Framed root plain store changed: delta=" + (plainCount - before));
        before = volatileCount;
        expectNull(() -> publishVolatile(null));
        if (volatileCount - before != 1)
            throw new AssertionError("Framed root volatile store changed: delta=" + (volatileCount - before));
        System.out.println("PASS static-store-replay plain=" + plainCount + " volatile=" + volatileCount + " checksum=" + checksum);
    }
}
