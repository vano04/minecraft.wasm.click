import java.util.concurrent.TimeUnit;

/**
 * A single writer only increases a volatile field. A concurrent reader must
 * never observe it decreasing, even when a later guard in a writer's inlined
 * callee fails. Null mode also acknowledges a publication before forcing that
 * guard; only a replay can then see the acknowledgement at the callee's entry.
 * Run with -XX:ZeroWasmJITOnly=JitVolatileReplay$Writer so observers and the
 * JDK run interpreted. The monotonic profile case remains scheduler-dependent;
 * a run without a decrease does not exonerate the original compiler.
 */
public class JitVolatileReplay {
    static final class Cell {
        volatile int value;
        volatile int noise;
        volatile boolean ready;
        volatile boolean done;
        volatile Throwable failure;
        long checksum;
        int guardedCalls;
    }

    static final int ACK_WARM_ROUNDS = 40000;
    static final int ACK_IMPOSSIBLE = -777;
    static final int ACK_MISS = -778;

    static final class AckValue {
        int value = 7;
    }

    static final class AckCell {
        volatile int seq;
        volatile int ack;
        volatile int armed;
        volatile int expected;
        volatile int done;
        volatile AckValue cold;
        volatile boolean stop;
        volatile Throwable failure;
    }

    interface Gate { int read(int value); }
    static final class Hot implements Gate {
        public int read(int value) { return value ^ 0x13579; }
    }
    static final class Cold implements Gate {
        public int read(int value) { return value ^ 0x24680; }
    }
    static final class Later implements Gate {
        public int read(int value) { return value ^ 0x36912; }
    }

    static final class Writer implements Runnable {
        final Cell cell;
        final int rounds;
        final long deadline;
        final boolean nullGuards;
        final Gate hot = new Hot(), cold = new Cold(), later = new Later();

        Writer(Cell cell, int rounds, long deadline, boolean nullGuards) {
            this.cell = cell;
            this.rounds = rounds;
            this.deadline = deadline;
            this.nullGuards = nullGuards;
        }

        static int publish(Cell cell, int next, Gate gate) {
            cell.value = next;
            // Keep a straight-line, inline-admissible observation window. A
            // polling loop cannot be spliced by this compiler (forward edges
            // only), and a native pause would change the effect classification.
            int salt = cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            salt += cell.noise;
            // The receiver guard runs AFTER the volatile store. Restoring the
            // old field before retrying this call violates volatile ordering.
            return gate.read(next + salt);
        }

        static int drive(Cell cell, int next, Gate gate) {
            return publish(cell, next, gate) + 1;
        }

        // Each window stays below the compiler's 180-byte inline limit. The
        // nested straight-line calls make one long observation interval while
        // keeping ackPublish itself eligible for a splice.
        static int ackWindow0(AckCell cell) {
            int ignored = cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack;
            return ackWindow1(cell);
        }

        static int ackWindow1(AckCell cell) {
            int ignored = cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack;
            return ackWindow2(cell);
        }

        static int ackWindow2(AckCell cell) {
            int ignored = cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack;
            return ackWindow3(cell);
        }

        static int ackWindow3(AckCell cell) {
            int ignored = cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack;
            return ackWindow4(cell);
        }

        static int ackWindow4(AckCell cell) {
            int ignored = cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack
                    + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack + cell.ack;
            return cell.ack;
        }

        static int ackPublish(AckCell cell, int next) {
            // During measured attempts expected equals next. An acknowledgement
            // at entry is therefore possible only after this invocation was
            // restarted following its volatile seq publication. Warmup sets
            // expected to zero so it can train the guarded dereference path.
            if (cell.ack == next && cell.expected == next) return ACK_IMPOSSIBLE;
            cell.seq = next;
            int seen = ackWindow0(cell);
            if (seen != next) return ACK_MISS;
            // Acquiring ack also acquires the observer's preceding null store.
            // A correct framed call must throw at this plain field access.
            return cell.cold.value;
        }

        static int ackDrive(AckCell cell, int next) {
            return ackPublish(cell, next);
        }

        public void run() {
            try {
                while (!cell.ready) {
                    if (System.nanoTime() >= deadline) throw new AssertionError("Observer did not become ready");
                    Thread.onSpinWait();
                }
                long checksum = 0;
                for (int next = 1; next <= rounds; next++) {
                    if ((next & 4095) == 0 && System.nanoTime() >= deadline)
                        throw new AssertionError("Publication probe deadline before completing its fixed rounds");
                    Gate gate = hot;
                    if (next > 40000 && (next & 1023) == 0) {
                        cell.guardedCalls++;
                        gate = nullGuards ? null : ((next & 2047) == 0 ? cold : later);
                    }
                    try {
                        checksum += drive(cell, next, gate);
                    } catch (NullPointerException expected) {
                        if (gate != null) throw expected;
                        // The Java store preceding the null dereference must
                        // remain published. This is a specified test input.
                        checksum += next;
                    }
                }
                cell.checksum = checksum;
            } catch (Throwable failure) {
                cell.failure = failure;
            } finally {
                cell.done = true;
            }
        }
    }

    static void awaitArmed(AckCell cell, int next, long deadline) {
        while (cell.armed != next) {
            if (cell.failure != null) throw new AssertionError("ACK observer failed", cell.failure);
            if (System.nanoTime() >= deadline)
                throw new AssertionError("Finite ACK arm deadline expected=" + next + " armed=" + cell.armed);
            Thread.onSpinWait();
        }
    }

    static void awaitAck(AckCell cell, int next, long deadline) {
        while (cell.done != next) {
            if (cell.failure != null) throw new AssertionError("ACK observer failed", cell.failure);
            if (System.nanoTime() >= deadline)
                throw new AssertionError("Finite ACK deadline expected=" + next + " done=" + cell.done);
            Thread.onSpinWait();
        }
    }

    static void runAckWitness(int rounds, int seconds) throws Exception {
        AckCell cell = new AckCell();
        AckValue live = new AckValue();
        cell.cold = live;
        long warmChecksum = 0;
        for (int next = 1; next <= ACK_WARM_ROUNDS; next++) {
            cell.ack = next;
            warmChecksum += Writer.ackDrive(cell, next);
        }
        if (warmChecksum != (long) ACK_WARM_ROUNDS * live.value)
            throw new AssertionError("ACK warmup changed: " + warmChecksum);

        int attempts = Math.min(16000, Math.max(4000, rounds / 80));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(Math.min(seconds, 45));
        Thread observer = new Thread(() -> {
            int completed = ACK_WARM_ROUNDS;
            try {
                while (!cell.stop) {
                    int next = cell.expected;
                    if (next <= completed) {
                        if (System.nanoTime() >= deadline) throw new AssertionError("ACK observer deadline");
                        Thread.onSpinWait();
                        continue;
                    }
                    // Publish null before arming the caller. ackPublish still
                    // dereferences only after this observer sees seq and
                    // acknowledges it with the following release store.
                    cell.cold = null;
                    cell.armed = next;
                    while (!cell.stop && cell.seq != next) {
                        if (System.nanoTime() >= deadline)
                            throw new AssertionError("ACK observer did not see seq=" + next);
                        Thread.onSpinWait();
                    }
                    if (cell.stop) break;
                    cell.ack = next;
                    cell.done = next;
                    completed = next;
                }
            } catch (Throwable failure) {
                cell.failure = failure;
            }
        }, "volatile-replay-ack-observer");
        observer.setDaemon(true);
        observer.start();
        int nullGuards = 0, impossibleReturns = 0, misses = 0;
        try {
            for (int attempt = 1; attempt <= attempts; attempt++) {
                int next = ACK_WARM_ROUNDS + attempt;
                cell.cold = live;
                cell.expected = next;
                awaitArmed(cell, next, deadline);
                try {
                    int value = Writer.ackDrive(cell, next);
                    if (value == ACK_IMPOSSIBLE) impossibleReturns++;
                    else if (value == ACK_MISS) misses++;
                    else throw new AssertionError("ACK helper returned unexpected value: " + value);
                } catch (NullPointerException expected) {
                    nullGuards++;
                }
                awaitAck(cell, next, deadline);
            }
        } finally {
            cell.stop = true;
            observer.join(2000);
        }
        if (observer.isAlive()) throw new AssertionError("ACK observer did not stop");
        if (cell.failure != null) throw new AssertionError("ACK observer failed", cell.failure);
        System.out.println("volatile-ack attempts=" + attempts + " nullGuards=" + nullGuards
                + " impossibleReturns=" + impossibleReturns + " misses=" + misses
                + " warmChecksum=" + warmChecksum);
        if (impossibleReturns != 0)
            throw new AssertionError("Volatile publication was undone and replayed: " + impossibleReturns);
        if (nullGuards == 0)
            throw new AssertionError("ACK witness never reached the post-publication null guard");
    }

    public static void main(String[] args) throws Exception {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 1000000;
        int seconds = args.length > 1 ? Integer.parseInt(args[1]) : 90;
        String mode = args.length > 2 ? args[2] : "null";
        if (rounds < 50000 || rounds > 20000000 || seconds < 1 || seconds > 300
                || !(mode.equals("null") || mode.equals("profile")))
            throw new IllegalArgumentException("rounds=50000..20000000 seconds=1..300 mode=null|profile");
        if (mode.equals("null")) runAckWitness(rounds, seconds);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        Cell cell = new Cell();
        Thread writer = new Thread(new Writer(cell, rounds, deadline, mode.equals("null")), "volatile-replay-writer");
        writer.setDaemon(true);
        writer.start();
        int maximum = 0, decreases = 0, firstFrom = 0, firstTo = 0;
        long observations = 0;
        cell.ready = true;
        while (!cell.done && System.nanoTime() < deadline) {
            int observed = cell.value;
            observations++;
            if (observed < maximum) {
                if (decreases++ == 0) { firstFrom = maximum; firstTo = observed; }
            } else maximum = observed;
        }
        writer.join(2000);
        if (writer.isAlive()) throw new AssertionError("Writer did not finish before the finite deadline");
        if (cell.failure != null) throw new AssertionError("Writer failed", cell.failure);
        if (cell.value != rounds || cell.guardedCalls == 0 || observations == 0)
            throw new AssertionError("Incomplete actual publication coverage: final=" + cell.value
                    + " guards=" + cell.guardedCalls + " observations=" + observations);
        System.out.println("volatile-replay mode=" + mode + " rounds=" + rounds + " guardedCalls=" + cell.guardedCalls
                + " observations=" + observations + " decreases=" + decreases + " firstFrom=" + firstFrom
                + " firstTo=" + firstTo + " checksum=" + cell.checksum);
        if (decreases != 0) throw new AssertionError("Published volatile value decreased: " + firstFrom + " -> " + firstTo);
        System.out.println("PASS volatile-replay: no observed monotonicity violation; not proof the original rollback was unobservable");
    }
}
