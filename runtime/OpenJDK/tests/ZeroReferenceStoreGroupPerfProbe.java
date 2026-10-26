// OSS-only deterministic driver for the measurement-only C3a module.
import java.util.SplittableRandom;

public final class ZeroReferenceStoreGroupPerfProbe {
    private static final int SPAN = 64;
    private static final int WARM_N = 100_000;
    private static volatile long sink;

    private ZeroReferenceStoreGroupPerfProbe() {
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    private static void age(Object[] values) {
        for (int i = 0; i < 512; i++) {
            byte[] pressure = new byte[8192];
            pressure[0] = (byte) i;
        }
        System.gc();
        require(values.length == 2048, "array root lost");
    }

    private static long invoke(int lane, int n, Object[] values) {
        values = ZeroReferenceArrayStoreFixture
                .prepareReferenceArrayStoreCardProbe(values);
        int start = ZeroReferenceStoreGroupPerfFixture.preparedStartIndex(values);
        require(start >= 0 && start + SPAN <= values.length, "prepared start");
        Object valueA = new Object();
        Object valueB = new Object();
        long result;
        switch (lane) {
            case 0:
                result = ZeroReferenceStoreGroupPerfFixture.inlineLoop(
                        n, values, start, SPAN, valueA, valueB);
                break;
            case 1:
                result = ZeroReferenceStoreGroupPerfFixture.directLoop(
                        n, values, start, SPAN, valueA, valueB);
                break;
            case 2:
                result = ZeroReferenceStoreGroupPerfFixture.indirectLoop(
                        n, values, start, SPAN, valueA, valueB);
                break;
            default:
                throw new AssertionError("lane " + lane);
        }
        for (Object value : values) {
            require(value == null, "adapter did not clear span");
        }
        return result;
    }

    private static long invokeAndConsumeElapsed(int lane, int n, Object[] values) {
        sink ^= invoke(lane, n, values);
        long elapsed = ZeroReferenceStoreGroupPerfFixture.lastElapsedNanos();
        require(elapsed > 0, "elapsed publication");
        return elapsed;
    }

    public static void main(String[] args) {
        require(args.length == 1
                && (args[0].equals("dump") || args[0].equals("publication")
                    || args[0].equals("perf") || args[0].equals("diagnostics")),
                "mode");
        require(ZeroReferenceStoreGroupPerfFixture.installOnly() == 1,
                "measurement module install");
        Object[] values = new Object[2048];
        System.out.println("PERF_PREWARMUP_AGE_BEGIN pressure=512 system-gc=1");
        age(values);
        System.out.println("PERF_PREWARMUP_AGE_END array-length=2048 result=pass");
        if (args[0].equals("dump")) {
            invokeAndConsumeElapsed(0, WARM_N, values);
            System.out.println("ZERO_REFERENCE_STORE_GROUP_PERF_DUMP result=pass");
            return;
        }
        if (args[0].equals("publication")) {
            System.out.println("PERF_PUBLICATION_BEGIN lane=direct n=1,64,65");
            long one = invoke(1, 1, values);
            require((one >>> 32) == 0, "n=1 checksum high32");
            require(ZeroReferenceStoreGroupPerfFixture.lastElapsedNanos() > 0,
                    "n=1 elapsed publication");
            sink ^= one;
            long span = invoke(1, SPAN, values);
            require((span >>> 32) != 0, "n=64 checksum high32");
            require(ZeroReferenceStoreGroupPerfFixture.lastElapsedNanos() > 0,
                    "n=64 elapsed publication");
            sink ^= span;
            long wrap = invoke(1, SPAN + 1, values);
            require((wrap >>> 32) != 0, "n=65 checksum high32");
            require(ZeroReferenceStoreGroupPerfFixture.lastElapsedNanos() > 0,
                    "n=65 elapsed publication");
            sink ^= wrap;
            System.out.println("PERF_PUBLICATION_END windows=3 high32=zero,nonzero,nonzero sink-consumed=1");
            System.out.println("ZERO_REFERENCE_STORE_GROUP_PERF_PUBLICATION result=pass");
            return;
        }
        if (args[0].equals("diagnostics")) {
            System.out.println("PERF_DIAGNOSTICS_BEGIN acceptance=0");
            System.out.println("PERF_SCALING_BEGIN acceptance=0");
            int[] scale = {1, SPAN, SPAN + 1, 1_000_000, 5_000_000};
            for (int n : scale) {
                for (int lane = 0; lane < 3; lane++) {
                    invokeAndConsumeElapsed(lane, n, values);
                }
            }
            System.out.println("PERF_SCALING_END windows=15");
            System.out.println("PERF_MAP_EDGE_BEGIN acceptance=0 n=1,64,65 lane=direct");
            invokeAndConsumeElapsed(1, 1, values);
            invokeAndConsumeElapsed(1, SPAN, values);
            invokeAndConsumeElapsed(1, SPAN + 1, values);
            System.out.println("PERF_MAP_EDGE_END windows=3 result=pass");
            System.out.println("PERF_AMORTIZATION_UNBATCHED_BEGIN acceptance=0 calls=32 n=1 lane=direct");
            for (int i = 0; i < 32; i++) {
                invokeAndConsumeElapsed(1, 1, values);
            }
            System.out.println("PERF_AMORTIZATION_UNBATCHED_END windows=32");
            System.out.println("PERF_AMORTIZATION_BATCHED_BEGIN acceptance=0 calls=1 n=32 lane=direct");
            invokeAndConsumeElapsed(1, 32, values);
            System.out.println("PERF_AMORTIZATION_BATCHED_END windows=1");
            System.out.println("PERF_DIAGNOSTICS_END acceptance=0 result=pass");
            System.out.println("ZERO_REFERENCE_STORE_GROUP_PERF_DIAGNOSTICS result=pass");
            return;
        }
        System.out.println("PERF_WARMUP_BEGIN lanes=3 iterations=10 n=" + WARM_N);
        for (int lane = 0; lane < 3; lane++) {
            for (int i = 0; i < 10; i++) {
                invokeAndConsumeElapsed(lane, WARM_N, values);
            }
        }
        System.out.println("PERF_WARMUP_END windows=30");

        int[] candidates = {5_000_000, 25_000_000, 50_000_000,
                100_000_000, 200_000_000};
        int timedN = -1;
        System.out.println("PERF_CALIBRATION_BEGIN candidates=5000000,25000000,50000000,100000000,200000000 triads=5");
        for (int candidate : candidates) {
            boolean eligible = true;
            System.out.println("PERF_CANDIDATE_BEGIN n=" + candidate);
            for (int lane = 0; lane < 3; lane++) {
                long elapsed = invokeAndConsumeElapsed(lane, candidate, values);
                eligible &= elapsed >= 50_000_000L && elapsed <= 250_000_000L;
            }
            System.out.println("PERF_CANDIDATE_END n=" + candidate
                    + " windows=3 eligible=" + (eligible ? 1 : 0));
            if (eligible && timedN < 0) {
                timedN = candidate;
            }
        }
        require(timedN > 0, "no supported calibration candidate");
        System.out.println("PERF_CALIBRATION_END chosen=" + timedN
                + " smallest-supported=1");
        System.out.println("PERF_CONFIRMATIONS_BEGIN n=" + timedN
                + " triads=2 acceptance=0");
        for (int confirmation = 0; confirmation < 2; confirmation++) {
            for (int lane = 0; lane < 3; lane++) {
                long elapsed = invokeAndConsumeElapsed(lane, timedN, values);
                require(elapsed >= 50_000_000L && elapsed <= 250_000_000L,
                        "confirmation outside calibrated interval");
            }
        }
        System.out.println("PERF_CONFIRMATIONS_END windows=6 excluded=1");

        SplittableRandom random = new SplittableRandom(0x5eed5eedL);
        int[][] permutations = {
                {0, 1, 2}, {0, 2, 1}, {1, 0, 2},
                {1, 2, 0}, {2, 0, 1}, {2, 1, 0}
        };
        int[][] orders = new int[31][3];
        for (int i = 0; i < 30; i++) {
            orders[i] = permutations[i % permutations.length].clone();
        }
        for (int i = 29; i > 0; i--) {
            int j = random.nextInt(i + 1);
            int[] swap = orders[i];
            orders[i] = orders[j];
            orders[j] = swap;
        }
        orders[30] = permutations[random.nextInt(permutations.length)].clone();
        System.out.println("PERF_TRIADS_BEGIN seed=0x5eed5eed rounds=31 n=" + timedN);
        for (int round = 0; round < 31; round++) {
            int[] order = orders[round];
            System.out.println("PERF_TRIAD round=" + round + " order="
                    + order[0] + "," + order[1] + "," + order[2]);
            for (int lane : order) {
                invokeAndConsumeElapsed(lane, timedN, values);
            }
        }
        System.out.println("PERF_TRIADS_END windows=93 sink-consumed=1");
        System.out.println("ZERO_REFERENCE_STORE_GROUP_PERF_DONE result=pass");
    }
}
