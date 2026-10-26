/*
 * Generated-OSS-only fixture for the opt-in ZeroWasmBaseline spike.
 *
 * The class is deliberately small and has no Minecraft or third-party input.
 * The runtime compiler verifies these method bytecodes before it emits the
 * one-module baseline unit. Unsupported methods stay in the interpreter.
 */
public final class ZeroBaselineFixture {
    public static final class Box {
        public Box child;
        public final int tag;

        public Box(int tag) {
            this.tag = tag;
        }
    }

    public static final class Trace {
        public static int initOkRuns;
        public static int initOkLeafRuns;
        public static int failRuns;
    }

    public static final class InitOK {
        private static int VALUE;

        static {
            Trace.initOkRuns++;
            VALUE = 42;
        }

        public static int leaf() {
            Trace.initOkLeafRuns++;
            return VALUE;
        }
    }

    public static final class InitFail {
        static {
            Trace.failRuns++;
            if (Trace.failRuns == 1) {
                throw new RuntimeException("synthetic init failure");
            }
        }

        public static int leaf() {
            return 99;
        }
    }

    public interface Shape {
        int value(int x);
    }

    public static class Base {
        public int value(int x) {
            return 29 - x;
        }

        // Wrong owner and instance shape: this must never enter the static
        // Zero linked int[] classifier even though its bytecodes are similar.
        public int intArrayLoad(int[] values, int index) {
            return values[index];
        }

        public int intArrayStore(int[] values, int index, int value) {
            values[index] = value;
            return value;
        }
    }

    public static class Good extends Base implements Shape {
        @Override
        public int value(int x) {
            return x + 11;
        }
    }

    public static final class SubGood extends Good {
    }

    public static class Other extends Base implements Shape {
        @Override
        public int value(int x) {
            return 29 - x;
        }
    }

    public static final int leaf(int x) {
        return x + 3;
    }

    public static final int caller(int x) {
        return leaf(x) * 2;
    }

    public static int virtualValue(Shape shape, int x) {
        return shape.value(x);
    }

    public static int dispatch(Base receiver, int x) {
        return receiver.value(x);
    }

    public static int storeChild(Box box, Box child) {
        box.child = child;
        return child.tag;
    }

    public static int storeChildCaller(Box box, Box child) {
        return storeChild(box, child);
    }

    public static int intArrayLoad(int[] values, int index) {
        return values[index];
    }

    public static int intArrayStore(int[] values, int index, int value) {
        values[index] = value;
        return value;
    }

    private static String exceptionDetail(Throwable error) {
        return error.getClass().getName() + "|" + String.valueOf(error.getMessage());
    }

    // Same-name descriptor near miss. The linked ABI is intentionally exact
    // ([II)I and must leave this overload in the interpreter.
    public static int intArrayLoad(int[] values, long index) {
        return values[(int) index];
    }

    // Same-name descriptor near miss for the store classifier.
    public static int intArrayStore(int[] values, int index, long value) {
        values[index] = (int) value;
        return (int) value;
    }

    public static int byteArrayLoad(byte[] values, int index) {
        return values[index];
    }

    public static int objectArrayLoad(Object[] values, int index) {
        return ((Integer) values[index]).intValue();
    }

    public static int byteArrayStore(byte[] values, int index, int value) {
        values[index] = (byte) value;
        return value;
    }

    public static int objectArrayStore(Object[] values, int index, Object value) {
        values[index] = value;
        return ((Integer) value).intValue();
    }

    public static int intArrayStoreAltered(int[] values, int index, int value) {
        values[index] = value;
        return value + 1;
    }

    // The caller is verifier-eligible, but the target allocLeaf is deliberately
    // not: allocation and its safepoint stay in the real interpreter frame.
    public static int allocLeaf(Box box, int tag) {
        Box child = new Box(tag);
        box.child = child;
        return child.tag;
    }

    public static int allocCaller(Box box, int tag) {
        return allocLeaf(box, tag);
    }

    public static int initCaller(boolean trigger) {
        if (!trigger) {
            return 0;
        }
        return InitOK.leaf();
    }

    public static int failCaller() {
        return InitFail.leaf();
    }

    private static Box storeFreshChild(Box box) {
        Box child = new Box(42);
        if (storeChildCaller(box, child) != 42) {
            throw new AssertionError("linked store returned the wrong tag");
        }
        // The child is deliberately not returned. After this helper returns,
        // the only Java root for it is box.child.
        return box;
    }

    public static int safeDiv(int x, int y) {
        try {
            return x / y;
        } catch (ArithmeticException e) {
            return -1;
        }
    }

    public static int throwLeaf(int x) {
        if (x == 0) {
            throw new IllegalStateException();
        }
        return x;
    }

    public static int throwCaller(int x) {
        try {
            return throwLeaf(x) + 1;
        } catch (IllegalStateException e) {
            return 77;
        }
    }

    // Benchmark-only entry shapes. The Zero adapter verifies these exact
    // trivial bodies, then replaces one outer invocation with a Wasm loop.
    // The Java methods remain valid reference behavior when the flag is off.
    public static int benchmarkPrimitiveCandidate(int n, int base) {
        return base;
    }

    public static int benchmarkPrimitiveReference(int n, int base) {
        return base;
    }

    public static int benchmarkDispatchCandidate(Base receiverA, Base receiverB, int n) {
        return n;
    }

    public static int benchmarkDispatchReference(Base receiverA, Base receiverB, int n) {
        return n;
    }

    public static int benchmarkStoreCandidate(int n, Box box, Box childA, Box childB) {
        return n;
    }

    public static int benchmarkStoreReference(int n, Box box, Box childA, Box childB) {
        return n;
    }

    public static int benchmarkDivCandidate(int n, int base) {
        return base;
    }

    public static int benchmarkDivReference(int n, int base) {
        return base;
    }

    public static int benchmarkThrowCandidate(int n, int base) {
        return base;
    }

    public static int benchmarkThrowReference(int n, int base) {
        return base;
    }

    public static void main(String[] args) {
        if (args.length > 0 && "array-benchmark".equals(args[0])) {
            main(new String[] {"array"});
            Base warmReceiver = new Good();
            int warm = dispatch(warmReceiver, 7);
            if (warm != 18) {
                throw new AssertionError("combined dispatch warm resolution failed");
            }
            int benchmark = benchmarkPrimitiveCandidate(100000, 7);
            System.out.println("COMBINED_RESULT array-and-benchmark " + benchmark);
            return;
        }
        if (args.length > 0 && "safeDiv".equals(args[0])) {
            int normal = safeDiv(7, 3);
            int zero = safeDiv(7, 0);
            int minOverMinusOne = safeDiv(Integer.MIN_VALUE, -1);
            int minOverZero = safeDiv(Integer.MIN_VALUE, 0);
            System.out.println("safeDiv normal " + normal + " zero " + zero
                    + " min-over-minus-one " + minOverMinusOne
                    + " min-over-zero " + minOverZero);
            if (normal != 2 || zero != -1 || minOverMinusOne != Integer.MIN_VALUE
                    || minOverZero != -1) {
                throw new AssertionError("safeDiv edge semantics failed");
            }
            return;
        }
        if (args.length > 0 && "array".equals(args[0])) {
            try {
                Class.forName("ZeroBaselineFixture$Box");
            } catch (ClassNotFoundException e) {
                throw new AssertionError(e);
            }
            int[] values = {Integer.MIN_VALUE, 42, 99};
            System.out.println("CASE_BEGIN valid-first");
            int validFirst = intArrayLoad(values, 0);
            System.out.println("CASE_END valid-first");
            values[1] = Integer.MIN_VALUE;
            System.out.println("CASE_BEGIN mutated");
            int mutated = intArrayLoad(values, 1);
            System.out.println("CASE_END mutated");
            values[1] = 42;
            System.out.println("CASE_BEGIN valid-last");
            int validLast = intArrayLoad(values, values.length - 1);
            System.out.println("CASE_END valid-last");
            int nullNpe = 0;
            int negativeAioobe = 0;
            int lengthAioobe = 0;
            int minIndexAioobe = 0;
            int emptyAioobe = 0;
            String nullDetail = "";
            String negativeDetail = "";
            String lengthDetail = "";
            String minIndexDetail = "";
            String emptyDetail = "";
            System.out.println("CASE_BEGIN null");
            try {
                intArrayLoad(null, 0);
            } catch (NullPointerException expected) {
                nullNpe = 1;
                nullDetail = exceptionDetail(expected);
            }
            System.out.println("CASE_END null");
            System.out.println("CASE_BEGIN negative");
            try {
                intArrayLoad(values, -1);
            } catch (ArrayIndexOutOfBoundsException expected) {
                negativeAioobe = 1;
                negativeDetail = exceptionDetail(expected);
            }
            System.out.println("CASE_END negative");
            System.out.println("CASE_BEGIN length");
            try {
                intArrayLoad(values, values.length);
            } catch (ArrayIndexOutOfBoundsException expected) {
                lengthAioobe = 1;
                lengthDetail = exceptionDetail(expected);
            }
            System.out.println("CASE_END length");
            System.out.println("CASE_BEGIN min-index");
            try {
                intArrayLoad(values, Integer.MIN_VALUE);
            } catch (ArrayIndexOutOfBoundsException expected) {
                minIndexAioobe = 1;
                minIndexDetail = exceptionDetail(expected);
            }
            System.out.println("CASE_END min-index");
            int[] empty = new int[0];
            System.out.println("CASE_BEGIN empty");
            try {
                intArrayLoad(empty, 0);
            } catch (ArrayIndexOutOfBoundsException expected) {
                emptyAioobe = 1;
                emptyDetail = exceptionDetail(expected);
            }
            System.out.println("CASE_END empty");
            System.out.println("array valid-first " + validFirst
                    + " mutated " + mutated
                    + " valid-last " + validLast + " null-npe " + nullNpe
                    + " negative-aioobe " + negativeAioobe
                    + " length-aioobe " + lengthAioobe
                    + " min-index-aioobe " + minIndexAioobe
                    + " empty-aioobe " + emptyAioobe);
            System.out.println("array-exceptions null=" + nullDetail
                    + " negative=" + negativeDetail
                    + " length=" + lengthDetail
                    + " min-index=" + minIndexDetail
                    + " empty=" + emptyDetail);
            if (validFirst != Integer.MIN_VALUE || mutated != Integer.MIN_VALUE
                    || validLast != 99
                    || nullNpe != 1 || negativeAioobe != 1
                    || lengthAioobe != 1 || minIndexAioobe != 1
                    || emptyAioobe != 1) {
                throw new AssertionError("int[] load fixture failed");
            }
            return;
        }
        if (args.length > 0 && "array-store".equals(args[0])) {
            int[] values = {7, 8, 9};
            boolean firstOnly;
            boolean middleOnly;
            boolean lastOnly;
            System.out.println("CASE_BEGIN first");
            int first = intArrayStore(values, 0, Integer.MIN_VALUE);
            firstOnly = values[0] == Integer.MIN_VALUE && values[1] == 8
                    && values[2] == 9;
            System.out.println("CASE_END first");
            System.out.println("CASE_BEGIN middle");
            int middle = intArrayStore(values, 1, 42);
            middleOnly = values[0] == Integer.MIN_VALUE && values[1] == 42
                    && values[2] == 9;
            System.out.println("CASE_END middle");
            System.out.println("CASE_BEGIN last");
            int last = intArrayStore(values, 2, Integer.MAX_VALUE);
            lastOnly = values[0] == Integer.MIN_VALUE && values[1] == 42
                    && values[2] == Integer.MAX_VALUE;
            System.out.println("CASE_END last");
            System.out.println("CASE_BEGIN values");
            int[] probeValues = {0, 0, 0, 0, 0};
            int[] probeInputs = {0, 1, 42, Integer.MIN_VALUE, Integer.MAX_VALUE};
            for (int i = 0; i < probeInputs.length; i++) {
                int probeResult = intArrayStore(probeValues, i, probeInputs[i]);
                if (probeResult != probeInputs[i] || probeValues[i] != probeInputs[i]) {
                    throw new AssertionError("int[] store value probe failed at " + i);
                }
            }
            System.out.println("CASE_END values");
            System.out.println("array-store-values 0,1,42,MIN,MAX semantics=1");
            int nullNpe = 0;
            int negativeAioobe = 0;
            int lengthAioobe = 0;
            int minIndexAioobe = 0;
            int emptyAioobe = 0;
            int invalidBefore0 = values[0];
            int invalidBefore1 = values[1];
            int invalidBefore2 = values[2];
            String nullDetail = "";
            String negativeDetail = "";
            String lengthDetail = "";
            String minIndexDetail = "";
            String emptyDetail = "";
            System.out.println("CASE_BEGIN null");
            try {
                intArrayStore(null, 0, 7);
            } catch (NullPointerException expected) {
                nullNpe = 1;
                nullDetail = exceptionDetail(expected);
            }
            System.out.println("CASE_END null");
            System.out.println("CASE_BEGIN negative");
            try {
                intArrayStore(values, -1, 7);
            } catch (ArrayIndexOutOfBoundsException expected) {
                negativeAioobe = 1;
                negativeDetail = exceptionDetail(expected);
            }
            System.out.println("CASE_END negative");
            System.out.println("CASE_BEGIN length");
            try {
                intArrayStore(values, values.length, 7);
            } catch (ArrayIndexOutOfBoundsException expected) {
                lengthAioobe = 1;
                lengthDetail = exceptionDetail(expected);
            }
            System.out.println("CASE_END length");
            System.out.println("CASE_BEGIN min-index");
            try {
                intArrayStore(values, Integer.MIN_VALUE, 7);
            } catch (ArrayIndexOutOfBoundsException expected) {
                minIndexAioobe = 1;
                minIndexDetail = exceptionDetail(expected);
            }
            System.out.println("CASE_END min-index");
            int[] empty = new int[0];
            System.out.println("CASE_BEGIN empty");
            try {
                intArrayStore(empty, 0, 7);
            } catch (ArrayIndexOutOfBoundsException expected) {
                emptyAioobe = 1;
                emptyDetail = exceptionDetail(expected);
            }
            System.out.println("CASE_END empty");
            boolean invalidNeighborsUnchanged = values[0] == invalidBefore0
                    && values[1] == invalidBefore1
                    && values[2] == invalidBefore2
                    && empty.length == 0;
            System.out.println("array-store first=" + first + " middle=" + middle
                    + " last=" + last + " values=" + values[0] + "," + values[1]
                    + "," + values[2] + " null-npe=" + nullNpe
                    + " negative-aioobe=" + negativeAioobe
                    + " length-aioobe=" + lengthAioobe
                    + " min-index-aioobe=" + minIndexAioobe
                    + " empty-aioobe=" + emptyAioobe
                    + " neighbors-unchanged="
                    + ((firstOnly && middleOnly && lastOnly) ? 1 : 0)
                    + " invalid-neighbors-unchanged="
                    + (invalidNeighborsUnchanged ? 1 : 0));
            System.out.println("array-store-exceptions null=" + nullDetail
                    + " negative=" + negativeDetail + " length=" + lengthDetail
                    + " min-index=" + minIndexDetail + " empty=" + emptyDetail);
            if (first != Integer.MIN_VALUE || middle != 42 || last != Integer.MAX_VALUE
                    || values[0] != Integer.MIN_VALUE || values[1] != 42
                    || values[2] != Integer.MAX_VALUE || nullNpe != 1
                    || negativeAioobe != 1 || lengthAioobe != 1
                    || minIndexAioobe != 1 || emptyAioobe != 1
                    || !invalidNeighborsUnchanged) {
                throw new AssertionError("int[] store fixture failed");
            }
            return;
        }
        if (args.length > 0 && "array-negatives".equals(args[0])) {
            int[] values = {41, 42};
            System.out.println("CASE_BEGIN near-misses");
            int wrongDescriptor = intArrayLoad(values, 1L);
            int wrongOwner = new Base().intArrayLoad(values, 1);
            int wrongOpcode = byteArrayLoad(new byte[] {7}, 0);
            int wrongReferenceOpcode = objectArrayLoad(new Object[] {8}, 0);
            int wrongStoreDescriptor = intArrayStore(values, 1, 9L);
            int wrongStoreOwner = new Base().intArrayStore(values, 0, 7);
            int wrongStoreOpcode = byteArrayStore(new byte[] {0}, 0, 7);
            int wrongStoreReferenceOpcode = objectArrayStore(new Object[] {8}, 0, 8);
            int wrongStoreShape = intArrayStoreAltered(new int[] {0}, 0, 9);
            System.out.println("CASE_END near-misses");
            System.out.println("array-negatives descriptor " + wrongDescriptor
                    + " owner " + wrongOwner + " baload " + wrongOpcode
                    + " aaload " + wrongReferenceOpcode
                    + " store-descriptor " + wrongStoreDescriptor
                    + " store-owner " + wrongStoreOwner
                    + " store-baload " + wrongStoreOpcode
                    + " store-aastore " + wrongStoreReferenceOpcode
                    + " store-altered " + wrongStoreShape);
            if (wrongDescriptor != 42 || wrongOwner != 42
                    || wrongOpcode != 7 || wrongReferenceOpcode != 8
                    || wrongStoreDescriptor != 9 || wrongStoreOwner != 7
                    || wrongStoreOpcode != 7 || wrongStoreReferenceOpcode != 8
                    || wrongStoreShape != 10) {
                throw new AssertionError("array near-miss fixture failed");
            }
            return;
        }
        if (args.length > 0 && "throw".equals(args[0])) {
            // The linked group is a deterministic superset that also carries
            // the real Box field/barrier metadata. Load that OSS fixture
            // class before the first group entry so install-time resolution
            // cannot depend on an unrelated earlier method.
            try {
                Class.forName("ZeroBaselineFixture$Box");
            } catch (ClassNotFoundException e) {
                throw new AssertionError(e);
            }
            // Resolve the real invokestatic entry once in the interpreter;
            // the linked caller is entered only after that metadata exists.
            throwLeaf(5);
            int normal = throwCaller(5);
            int caught = throwCaller(0);
            System.out.println("throw normal " + normal + " caught " + caught);
            if (normal != 6 || caught != 77) {
                throw new AssertionError("throwCaller edge semantics failed");
            }
            return;
        }
        if (args.length > 0 && "perf".equals(args[0])) {
            try {
                // The shared linear-memory module requires the real Box
                // field metadata even though this lane does not store a Box.
                Class.forName("ZeroBaselineFixture$Box");
            } catch (ClassNotFoundException e) {
                throw new AssertionError(e);
            }
            Base goodBaseA = new Good();
            Base goodBaseB = new Good();
            Box storeRoot = new Box(0);
            Box storeChildA = new Box(41);
            Box storeChildB = new Box(42);
            // Resolve the real invokevirtual entry in the interpreter before
            // the benchmark-only module is installed. This call is outside
            // all timed lanes and is excluded from their checksums/timings.
            int warmDispatchResolve = dispatch(goodBaseA, 7);
            if (warmDispatchResolve != 18) {
                throw new AssertionError("benchmark dispatch warm resolution failed");
            }
            System.out.println("BENCH_RESOLVE_WARM result " + warmDispatchResolve
                    + " excluded 1");
            final int warmupN = 100000;
            final int timedN = 5000000;
            final int trials = 31;
            int warmPrimCandidate = benchmarkPrimitiveCandidate(warmupN, 7);
            int warmPrimReference = benchmarkPrimitiveReference(warmupN, 7);
            int warmDispatchCandidate = benchmarkDispatchCandidate(goodBaseA, goodBaseB, warmupN);
            int warmDispatchReference = benchmarkDispatchReference(goodBaseA, goodBaseB, warmupN);
            if (warmPrimCandidate != warmPrimReference
                    || warmDispatchCandidate != warmDispatchReference) {
                throw new AssertionError("benchmark warmup checksum mismatch");
            }
            int warmStoreCandidate = benchmarkStoreCandidate(warmupN, storeRoot, storeChildA, storeChildB);
            int warmStoreReference = benchmarkStoreReference(warmupN, storeRoot, storeChildA, storeChildB);
            int warmDivCandidate = benchmarkDivCandidate(warmupN, 7);
            int warmDivReference = benchmarkDivReference(warmupN, 7);
            int warmThrowCandidate = benchmarkThrowCandidate(warmupN, 7);
            int warmThrowReference = benchmarkThrowReference(warmupN, 7);
            if (warmStoreCandidate != warmStoreReference || warmDivCandidate != warmDivReference
                    || warmThrowCandidate != warmThrowReference) {
                throw new AssertionError("extended benchmark warmup checksum mismatch");
            }
            System.out.println("BENCH_WINDOW_BEGIN");
            System.out.println("BENCH_WARMUP n " + warmupN + " calls 10");
            long seed = 0x5eed5eedL;
            StringBuilder order = new StringBuilder(trials);
            for (int trial = 0; trial < trials; trial++) {
                seed = (seed * 6364136223846793005L + 1442695040888963407L);
                boolean candidateFirst = ((seed >>> 32) & 1L) == 0L;
                order.append(candidateFirst ? 'C' : 'R');

                long primCandidateNs;
                long primReferenceNs;
                int primCandidate;
                int primReference;
                if (candidateFirst) {
                    long start = System.nanoTime();
                    primCandidate = benchmarkPrimitiveCandidate(timedN, 7);
                    primCandidateNs = System.nanoTime() - start;
                    start = System.nanoTime();
                    primReference = benchmarkPrimitiveReference(timedN, 7);
                    primReferenceNs = System.nanoTime() - start;
                } else {
                    long start = System.nanoTime();
                    primReference = benchmarkPrimitiveReference(timedN, 7);
                    primReferenceNs = System.nanoTime() - start;
                    start = System.nanoTime();
                    primCandidate = benchmarkPrimitiveCandidate(timedN, 7);
                    primCandidateNs = System.nanoTime() - start;
                }
                if (primCandidate != primReference) {
                    throw new AssertionError("primitive benchmark checksum mismatch");
                }

                long dispatchCandidateNs;
                long dispatchReferenceNs;
                int dispatchCandidate;
                int dispatchReference;
                if (candidateFirst) {
                    long start = System.nanoTime();
                    dispatchCandidate = benchmarkDispatchCandidate(goodBaseA, goodBaseB, timedN);
                    dispatchCandidateNs = System.nanoTime() - start;
                    start = System.nanoTime();
                    dispatchReference = benchmarkDispatchReference(goodBaseA, goodBaseB, timedN);
                    dispatchReferenceNs = System.nanoTime() - start;
                } else {
                    long start = System.nanoTime();
                    dispatchReference = benchmarkDispatchReference(goodBaseA, goodBaseB, timedN);
                    dispatchReferenceNs = System.nanoTime() - start;
                    start = System.nanoTime();
                    dispatchCandidate = benchmarkDispatchCandidate(goodBaseA, goodBaseB, timedN);
                    dispatchCandidateNs = System.nanoTime() - start;
                }
                if (dispatchCandidate != dispatchReference) {
                    throw new AssertionError("dispatch benchmark checksum mismatch");
                }
                long storeCandidateNs;
                long storeReferenceNs;
                int storeCandidate;
                int storeReference;
                if (candidateFirst) {
                    long start = System.nanoTime();
                    storeCandidate = benchmarkStoreCandidate(timedN, storeRoot, storeChildA, storeChildB);
                    storeCandidateNs = System.nanoTime() - start;
                    start = System.nanoTime();
                    storeReference = benchmarkStoreReference(timedN, storeRoot, storeChildA, storeChildB);
                    storeReferenceNs = System.nanoTime() - start;
                } else {
                    long start = System.nanoTime();
                    storeReference = benchmarkStoreReference(timedN, storeRoot, storeChildA, storeChildB);
                    storeReferenceNs = System.nanoTime() - start;
                    start = System.nanoTime();
                    storeCandidate = benchmarkStoreCandidate(timedN, storeRoot, storeChildA, storeChildB);
                    storeCandidateNs = System.nanoTime() - start;
                }
                if (storeCandidate != storeReference) {
                    throw new AssertionError("store benchmark checksum mismatch");
                }
                long divCandidateNs;
                long divReferenceNs;
                int divCandidate;
                int divReference;
                if (candidateFirst) {
                    long start = System.nanoTime();
                    divCandidate = benchmarkDivCandidate(timedN, 7);
                    divCandidateNs = System.nanoTime() - start;
                    start = System.nanoTime();
                    divReference = benchmarkDivReference(timedN, 7);
                    divReferenceNs = System.nanoTime() - start;
                } else {
                    long start = System.nanoTime();
                    divReference = benchmarkDivReference(timedN, 7);
                    divReferenceNs = System.nanoTime() - start;
                    start = System.nanoTime();
                    divCandidate = benchmarkDivCandidate(timedN, 7);
                    divCandidateNs = System.nanoTime() - start;
                }
                if (divCandidate != divReference) {
                    throw new AssertionError("div benchmark checksum mismatch");
                }
                long throwCandidateNs;
                long throwReferenceNs;
                int throwCandidate;
                int throwReference;
                if (candidateFirst) {
                    long start = System.nanoTime();
                    throwCandidate = benchmarkThrowCandidate(timedN, 7);
                    throwCandidateNs = System.nanoTime() - start;
                    start = System.nanoTime();
                    throwReference = benchmarkThrowReference(timedN, 7);
                    throwReferenceNs = System.nanoTime() - start;
                } else {
                    long start = System.nanoTime();
                    throwReference = benchmarkThrowReference(timedN, 7);
                    throwReferenceNs = System.nanoTime() - start;
                    start = System.nanoTime();
                    throwCandidate = benchmarkThrowCandidate(timedN, 7);
                    throwCandidateNs = System.nanoTime() - start;
                }
                if (throwCandidate != throwReference) {
                    throw new AssertionError("throw benchmark checksum mismatch");
                }
                System.out.println("BENCH_PRIM trial " + trial + " candidate-ns "
                        + primCandidateNs + " reference-ns " + primReferenceNs
                        + " candidate-checksum " + primCandidate
                        + " reference-checksum " + primReference);
                System.out.println("BENCH_DISPATCH trial " + trial + " candidate-ns "
                        + dispatchCandidateNs + " reference-ns " + dispatchReferenceNs
                        + " candidate-checksum " + dispatchCandidate
                        + " reference-checksum " + dispatchReference);
                System.out.println("BENCH_STORE trial " + trial + " candidate-ns "
                        + storeCandidateNs + " reference-ns " + storeReferenceNs
                        + " candidate-checksum " + storeCandidate
                        + " reference-checksum " + storeReference);
                System.out.println("BENCH_DIV trial " + trial + " candidate-ns "
                        + divCandidateNs + " reference-ns " + divReferenceNs
                        + " candidate-checksum " + divCandidate
                        + " reference-checksum " + divReference);
                System.out.println("BENCH_THROW trial " + trial + " candidate-ns "
                        + throwCandidateNs + " reference-ns " + throwReferenceNs
                        + " candidate-checksum " + throwCandidate
                        + " reference-checksum " + throwReference);
            }
            System.out.println("BENCH_ORDER seed 0x5eed5eed sequence " + order);
            System.out.println("BENCH_WINDOW_END");
            return;
        }
        int n = args.length == 0 || "alloc".equals(args[0]) || "init".equals(args[0])
                || "dispatch".equals(args[0])
                ? 10000 : Integer.parseInt(args[0]);
        Shape good = new Good();
        Shape other = new Other();
        Box root = new Box(7);

        if (args.length > 0 && "alloc".equals(args[0])) {
            for (int i = 0; i < 512; i++) {
                byte[] agePressure = new byte[8192];
                agePressure[0] = (byte)i;
            }
            System.gc();
            int allocatedTag = allocCaller(root, 43);
            for (int i = 0; i < 1024; i++) {
                byte[] pressure = new byte[16384];
                pressure[0] = (byte)i;
            }
            System.gc();
            if (root.child == null || root.child.tag != 43 || allocatedTag != 43) {
                throw new AssertionError("allocation bail fixture failed");
            }
            System.out.println("alloc-bail stored-tag " + root.child.tag
                    + " child-tag " + root.child.tag);
            return;
        }

        if (args.length > 0 && "init".equals(args[0])) {
            int warm = initCaller(false);
            int first = initCaller(true);
            int second = initCaller(true);
            int firstFail = 0;
            int secondFail = 0;
            try {
                failCaller();
            } catch (ExceptionInInitializerError expected) {
                firstFail = 1;
            }
            try {
                failCaller();
            } catch (NoClassDefFoundError expected) {
                secondFail = 1;
            }
            if (warm != 0 || first != 42 || second != 42
                    || firstFail != 1 || secondFail != 1
                    || Trace.initOkRuns != 1 || Trace.initOkLeafRuns != 2
                    || Trace.failRuns != 1) {
                throw new AssertionError("class-init fixture failed");
            }
            System.out.println("init-ok warm " + warm + " first " + first
                    + " second " + second + " runs " + Trace.initOkRuns
                    + " leaf-runs " + Trace.initOkLeafRuns);
            System.out.println("init-fail first-eiie " + firstFail
                    + " second-ncdef " + secondFail + " fail-runs "
                    + Trace.failRuns);
            return;
        }

        if (args.length > 0 && "dispatch".equals(args[0])) {
            Base goodBase = new Good();
            Base subGood = new SubGood();
            Base otherBase = new Other();
            int warmGoodResult = dispatch(goodBase, 7);
            int goodResult = dispatch(goodBase, 7);
            int subGoodResult = dispatch(subGood, 7);
            int otherResult = dispatch(otherBase, 7);
            int nullNpe = 0;
            try {
                dispatch(null, 7);
            } catch (NullPointerException expected) {
                nullNpe = 1;
            }
            if (warmGoodResult != 18 || goodResult != 18 || subGoodResult != 18
                    || otherResult != 22
                    || nullNpe != 1) {
                throw new AssertionError("dispatch fixture failed");
            }
            System.out.println("dispatch warm " + warmGoodResult + " good " + goodResult + " subgood "
                    + subGoodResult + " other " + otherResult + " null-npe "
                    + nullNpe);
            return;
        }

        // Force a collection while root is the only Box reference so the
        // later store is an old-root -> young-child edge under SerialGC.
        for (int i = 0; i < 512; i++) {
            byte[] agePressure = new byte[8192];
            agePressure[0] = (byte)i;
        }
        System.gc();
        long checksum = 0;

        long t0 = System.nanoTime();
        for (int i = 0; i < n; i++) checksum += caller(i);
        long t1 = System.nanoTime();

        long t2 = System.nanoTime();
        for (int i = 0; i < n; i++) checksum += virtualValue(good, i);
        long t3 = System.nanoTime();

        long t4 = System.nanoTime();
        for (int i = 0; i < n; i++) checksum += virtualValue(other, i);
        long t5 = System.nanoTime();

        long t6 = System.nanoTime();
        for (int i = 0; i < n; i++) checksum += safeDiv(i + 1, 3);
        int caught = safeDiv(7, 0);
        long t7 = System.nanoTime();

        if (caller(7) != 20 || virtualValue(good, 7) != 18
                || virtualValue(other, 7) != 22 || safeDiv(7, 0) != -1) {
            throw new AssertionError("fixture semantic check failed");
        }

        root = storeFreshChild(root);
        for (int i = 0; i < 1024; i++) {
            byte[] pressure = new byte[16384];
            pressure[0] = (byte)i;
        }
        System.gc();
        if (root.child == null || root.child.tag != 42) {
            throw new AssertionError("linked GC fixture failed");
        }
        System.out.println("baseline-fixture checksum " + checksum
                + " caught " + caught);
        System.out.println("linked-gc stored-tag " + root.child.tag
                + " child-tag " + root.child.tag);
        System.out.println("baseline-caller-ns " + (t1 - t0)
                + " baseline-virtual-hit-ns " + (t3 - t2)
                + " baseline-virtual-miss-ns " + (t5 - t4)
                + " baseline-div-ns " + (t7 - t6));
    }

}
