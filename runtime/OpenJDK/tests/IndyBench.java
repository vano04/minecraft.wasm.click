import java.util.function.IntSupplier;
public class IndyBench {
    enum Dir { DOWN, UP, NORTH, SOUTH, WEST, EAST }
    static final Dir[] DIRS = Dir.values();
    // javac emits invokedynamic SwitchBootstraps.enumSwitch for a switch with case null.
    static int indySwitch(Dir d) {
        return switch (d) { case null -> 7; case DOWN -> 1; case UP -> 2; case NORTH -> 3; case SOUTH -> 4; case WEST -> 5; case EAST -> 6; };
    }
    static int plainSwitch(Dir d) {
        if (d == null) return 7;
        return switch (d) { case DOWN -> 1; case UP -> 2; case NORTH -> 3; case SOUTH -> 4; case WEST -> 5; case EAST -> 6; };
    }
    static final class Cap implements IntSupplier { final int a, b; Cap(int a, int b) { this.a = a; this.b = b; } public int getAsInt() { return a + b; } }
    static int lambda(int a, int b) { IntSupplier s = () -> a + b; return s.getAsInt(); }
    static int handClass(int a, int b) { IntSupplier s = new Cap(a, b); return s.getAsInt(); }
    public static void main(String[] args) {
        int n = 2_000_000;
        for (int round = 0; round < 6; round++) {
            long t0 = System.nanoTime(); int acc = 0;
            for (int i = 0; i < n; i++) acc += indySwitch(DIRS[i % 6]);
            long t1 = System.nanoTime();
            for (int i = 0; i < n; i++) acc += plainSwitch(DIRS[i % 6]);
            long t2 = System.nanoTime();
            for (int i = 0; i < n; i++) acc += lambda(i, round);
            long t3 = System.nanoTime();
            for (int i = 0; i < n; i++) acc += handClass(i, round);
            long t4 = System.nanoTime();
            System.out.printf("round %d: indySwitch %.1f ns  plainSwitch %.1f ns  lambda %.1f ns  handClass %.1f ns  (%d)%n", round,
                (t1 - t0) / (double) n, (t2 - t1) / (double) n, (t3 - t2) / (double) n, (t4 - t3) / (double) n, acc);
        }
    }
}
