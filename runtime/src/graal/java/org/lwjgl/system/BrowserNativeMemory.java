package org.lwjgl.system;

import java.nio.Buffer;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.CharBuffer;
import java.nio.DoubleBuffer;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import java.nio.LongBuffer;
import java.nio.ShortBuffer;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ConcurrentSkipListMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Synthetic address space for browser LWJGL. Allocations are heap {@code byte[]}
 * blocks; NIO views are registered so {@code memAddress} can recover the token.
 */
public final class BrowserNativeMemory {
    public static final int POINTER_SIZE = 8;

    private static final AtomicLong NEXT = new AtomicLong(0x1_0000L);
    /**
     * Live blocks by base address. Ordered, not hashed: every interior-address lookup
     * ({@link #block}, {@link #realloc}, {@link #free}) is a {@code floorEntry}, which a
     * {@code ConcurrentHashMap} cannot answer without scanning every entry.
     *
     * <p>The values are the {@link Block}s themselves, made once per allocation, so a
     * lookup that misses the per-thread cache allocates nothing, and freeing one can
     * empty its {@link Block#limit} where every cache entry for it will see that.</p>
     */
    private static final ConcurrentSkipListMap<Long, Block> BLOCKS = new ConcurrentSkipListMap<>();
    private static final BrowserBufferAddresses BUFFER_ADDRESSES = new BrowserBufferAddresses();
    private static final AtomicLong LIVE_BYTES = new AtomicLong();
    private static final AtomicLong PEAK_BYTES = new AtomicLong();
    private static final AtomicLong ALLOCATIONS = new AtomicLong();

    /**
     * Reuse large native backing arrays after their NIO view is freed. These arrays are
     * Java objects in this browser port, so repeatedly allocating a new 16-128 MiB
     * payload is also repeatedly asking the non-moving WasmLM heap for a large
     * contiguous object. Keeping a small bounded pool makes the first asset/terrain
     * allocation pay that cost once and lets later churn reuse the same storage.
     *
     * <p>The pool is deliberately byte-array based rather than a collection of
     * {@code ByteBuffer}s: a new synthetic address is assigned on each borrow, while
     * the old view has already been removed from {@link #BLOCKS}. That keeps stale NIO
     * addresses invalid and makes reuse invisible to callers.</p>
     */
    private static final int LARGE_POOL_MIN_BYTES = 1 * 1024 * 1024;
    private static final int LARGE_POOL_MAX_BYTES = 128 * 1024 * 1024;
    /**
     * {@code -Dmcweb.nativePoolMB}: 256 by default. The OpenJDK lane's page
     * sets 16: HotSpot allocates a large array as cheaply as it reuses one,
     * and pooled arrays are live heap -- 89 MB of it, flying.
     */
    private static final long LARGE_POOL_LIMIT_BYTES = Long.getLong("mcweb.nativePoolMB", 256L) * 1024 * 1024;
    private static final int LARGE_POOL_SLOTS = 12;
    private static final Object LARGE_POOL_LOCK = new Object();
    private static final byte[][] LARGE_POOL = new byte[LARGE_POOL_SLOTS][];
    private static long pooledBytes;

    private BrowserNativeMemory() {
    }

    /**
     * Soft cap for a single allocation; larger requests fail with a clear size.
     *
     * <p>This is this port's own guard, not a browser limit. 64 MiB was fine
     * until the client actually entered a world: the terrain renderer asks for
     * a single 98 MiB buffer once chunks start meshing, and the guard turned
     * that into an OutOfMemoryError that killed the frame pump the moment the
     * player spawned. The Wasm heap has room (native usage peaked around 88 MiB
     * across all blocks), so the cap is raised rather than the request refused.
     */
    private static final int MAX_SINGLE_ALLOCATION = 512 * 1024 * 1024;

    /** Report allocations this large so a runaway buffer stays visible. */
    private static final int LARGE_ALLOCATION_REPORT = 16 * 1024 * 1024;

    public static long malloc(long size) {
        int bytes = sanitize(size);
        if (bytes > MAX_SINGLE_ALLOCATION) {
            throw new OutOfMemoryError(
                    "browser single allocation too large: " + bytes + " bytes"
            );
        }
        boolean reportLarge = bytes >= LARGE_ALLOCATION_REPORT;
        if (reportLarge) {
            try {
                // The boot stage names the caller cheaply: a stack trace per
                // large allocation would be a frame walk in the interpreter
                // each time, and the stage is enough to trace a 98 MiB block
                // that shows up as the largest live allocation at OOM time.
                dev.mcweb.graal.webgpu.BrowserGpu.reportProgress(
                        "native:large-alloc " + (bytes / (1024 * 1024)) + "MiB live="
                                + (LIVE_BYTES.get() / (1024 * 1024)) + "MiB blocks=" + BLOCKS.size()
                                + " during=" + dev.mcweb.graal.MinecraftInitProgress.lastStage
                );
            } catch (Throwable ignored) {
                // Telemetry must never break an allocation.
            }
        }
        try {
            byte[] block = takePooled(bytes);
            if (block == null) {
                block = new byte[bytes];
            } else {
                // Preserve the visible zero-filled behavior of the old new byte[] path
                // without clearing unused capacity when a larger pooled block is reused
                // for a smaller request.
                Arrays.fill(block, 0, bytes, (byte) 0);
            }
            // Reserve address space for the block that actually exists, not for
            // the size that was asked for.
            //
            // takePooled returns the smallest pooled array that *can satisfy*
            // the request, so it is routinely larger than `bytes` — while
            // block() resolves an address by `address < base + data.length`.
            // Advancing NEXT by `bytes + 32` therefore let a pooled block's
            // apparent span swallow the addresses handed out after it, and any
            // lookup landing in that overlap resolved to the wrong block with a
            // bogus offset. wrapByte then clamped the view to whatever remained
            // of the wrong block and returned it silently: a 16x16 RGBA image
            // came back with 640 of its 1024 bytes, and the failure surfaced
            // much later as CommandEncoder's "Copy would overrun the source
            // buffer", killing the whole resource reload — which is why a
            // server's resource pack intermittently did not apply at all.
            long address = NEXT.getAndAdd(block.length + 32L);
            if (reportLarge) {
                dev.mcweb.graal.webgpu.BrowserGpu.reportProgress("native:large-array-ready " + (bytes / (1024 * 1024)) + "MiB");
            }
            BLOCKS.put(address, new Block(address, block));
            if (reportLarge) {
                dev.mcweb.graal.webgpu.BrowserGpu.reportProgress("native:large-mapped " + (bytes / (1024 * 1024)) + "MiB");
            }
            noteAllocated(bytes);
            return address;
        } catch (OutOfMemoryError error) {
            throw new OutOfMemoryError(
                    "browser heap exhausted allocating " + bytes + " bytes ("
                            + BLOCKS.size() + " live blocks, "
                            + LIVE_BYTES.get() + " live bytes)"
            );
        }
    }

    private static void noteAllocated(long bytes) {
        ALLOCATIONS.incrementAndGet();
        long live = LIVE_BYTES.addAndGet(bytes);
        long peak;
        do {
            peak = PEAK_BYTES.get();
            if (live <= peak) {
                return;
            }
        } while (!PEAK_BYTES.compareAndSet(peak, live));
    }

    /** Live/peak synthetic-native usage for init progress traces. */
    public static String stats() {
        return "native=" + (LIVE_BYTES.get() / 1024L) + "KiB/"
                + (PEAK_BYTES.get() / 1024L) + "KiB-peak #"
                + ALLOCATIONS.get() + "allocs/"
                + BLOCKS.size() + "blocks pooled=" + (pooledBytes / 1024L) + "KiB";
    }

    /** Live blocks by power-of-two size class: "&lt;=size:count/totalKiB", largest first. */
    public static String sizeClasses() {
        int[] counts = new int[32];
        long[] totals = new long[32];
        for (Block block : BLOCKS.values()) {
            int length = block.data.length;
            int c = 32 - Integer.numberOfLeadingZeros(Math.max(1, length - 1));
            counts[c]++;
            totals[c] += length;
        }
        StringBuilder out = new StringBuilder("native-classes:");
        for (int c = 31; c >= 0; c--) {
            if (counts[c] > 0 && totals[c] >= 1024 * 1024) {
                out.append(' ').append((1L << c) / 1024).append("KiB:").append(counts[c]).append('/')
                        .append(totals[c] / 1024).append("KiB");
            }
        }
        return out.toString();
    }

    /**
     * Largest live blocks at failure time, for OOM attribution. Fixed-size
     * scan so it stays usable while the heap is already exhausted.
     */
    public static String describeLargest(int count) {
        long[] sizes = new long[count];
        long[] addresses = new long[count];
        int tracked = 0;
        for (Map.Entry<Long, Block> entry : BLOCKS.entrySet()) {
            long size = entry.getValue().data.length;
            int slot = -1;
            for (int i = 0; i < tracked; i++) {
                if (size > sizes[i]) {
                    slot = i;
                    break;
                }
            }
            if (slot < 0) {
                if (tracked < count) {
                    slot = tracked++;
                } else {
                    continue;
                }
            }
            for (int i = tracked - 1; i > slot; i--) {
                sizes[i] = sizes[i - 1];
                addresses[i] = addresses[i - 1];
            }
            sizes[slot] = size;
            addresses[slot] = entry.getKey();
        }
        StringBuilder result = new StringBuilder("largest-native-blocks:");
        for (int i = 0; i < tracked; i++) {
            result.append(' ')
                    .append(addresses[i])
                    .append('=')
                    .append(sizes[i] / 1024L)
                    .append("KiB");
        }
        return result.toString();
    }

    public static long calloc(long num, long size) {
        return malloc(Math.multiplyExact(num, size));
    }

    public static long realloc(long ptr, long size) {
        if (ptr == 0L) {
            return malloc(size);
        }
        // Callers may pass interior addresses, so resolve the containing
        // block and copy from the offset rather than requiring an exact
        // base hit (an exact-only lookup silently dropped the old data).
        Block previous = BLOCKS.get(ptr);
        if (previous == null) {
            previous = containing(ptr);
        }
        long next = malloc(size);
        if (previous != null) {
            int sourceOffset = (int) (ptr - previous.base);
            Block allocated = BLOCKS.get(next);
            if (allocated != null) {
                System.arraycopy(
                        previous.data,
                        sourceOffset,
                        allocated.data,
                        0,
                        Math.min(previous.data.length - sourceOffset, allocated.data.length)
                );
            }
            if (BLOCKS.remove(previous.base, previous)) {
                retire(previous);
            }
        }
        return next;
    }

    /** The live block containing {@code address}, or null. Never maps anything. */
    private static Block containing(long address) {
        Map.Entry<Long, Block> entry = BLOCKS.floorEntry(address);
        return entry != null && address < entry.getKey() + entry.getValue().data.length
                ? entry.getValue() : null;
    }

    /**
     * After {@code block} has left {@link #BLOCKS}: empties its span, so no cache entry
     * can answer for it any more, drops the references that would keep its array alive,
     * and offers the array to the pool. The span is emptied before the array can be
     * handed out again, so an access that is ordered after the free never reaches the
     * new owner's bytes through an old cache entry.
     */
    private static void retire(Block block) {
        block.limit = 0;
        LIVE_BYTES.addAndGet(-block.data.length);
        forget(block);
        releasePooled(block.data);
    }

    public static void free(long ptr) {
        if (ptr == 0L) {
            return;
        }
        Block removed = BLOCKS.remove(ptr);
        if (removed == null) {
            // Buffers may be freed at an interior address (e.g. an NIO view's
            // memAddress after its position moved). Fall back to the block
            // that contains the address so the allocation does not leak.
            Block inner = containing(ptr);
            if (inner != null && BLOCKS.remove(inner.base, inner)) {
                removed = inner;
            }
        }
        if (removed != null) {
            retire(removed);
        }
    }

    /** Returns the smallest pooled array that can satisfy {@code bytes}. */
    private static byte[] takePooled(int bytes) {
        if (bytes < LARGE_POOL_MIN_BYTES) {
            return null;
        }
        synchronized (LARGE_POOL_LOCK) {
            int best = -1;
            int bestLength = Integer.MAX_VALUE;
            for (int i = 0; i < LARGE_POOL.length; i++) {
                byte[] candidate = LARGE_POOL[i];
                if (candidate != null && candidate.length >= bytes && candidate.length < bestLength) {
                    best = i;
                    bestLength = candidate.length;
                }
            }
            if (best < 0) {
                return null;
            }
            byte[] reused = LARGE_POOL[best];
            LARGE_POOL[best] = null;
            pooledBytes -= reused.length;
            return reused;
        }
    }

    /** Retains a bounded large array for a later native allocation. */
    private static void releasePooled(byte[] block) {
        int length = block.length;
        if (length < LARGE_POOL_MIN_BYTES || length > LARGE_POOL_MAX_BYTES) {
            return;
        }
        synchronized (LARGE_POOL_LOCK) {
            if (pooledBytes + length > LARGE_POOL_LIMIT_BYTES) {
                return;
            }
            for (int i = 0; i < LARGE_POOL.length; i++) {
                if (LARGE_POOL[i] == null) {
                    LARGE_POOL[i] = block;
                    pooledBytes += length;
                    return;
                }
            }
        }
    }

    public static ByteBuffer wrapByte(long address, int capacity) {
        if (address == 0L || capacity <= 0) {
            ByteBuffer empty = ByteBuffer.allocate(0).order(ByteOrder.nativeOrder());
            register(empty, address);
            return empty;
        }
        Block block = block(address);
        int offset = (int) (address - block.base);
        int available = block.data.length - offset;
        int length = Math.min(capacity, Math.max(available, 0));
        if (length < capacity) {
            // Silent truncation turns an allocator fault into a wrong picture
            // or an exception many frames away: a caller that asked for a
            // 16x16 RGBA image and got 640 of the 1024 bytes fails inside
            // CommandEncoder.writeToTexture as "Copy would overrun the source
            // buffer", naming neither the address nor the allocation. Say so
            // here, where the block that was actually resolved is still known.
            reportTruncation(address, capacity, block, offset, available);
        }
        ByteBuffer buffer = ByteBuffer.wrap(block.data, offset, length)
                .slice()
                .order(ByteOrder.nativeOrder());
        register(buffer, address);
        return buffer;
    }

    /*
     * Typed views over wrapByte, each registered at its own address so that
     * memAddress/BACKEND.getAddress0 of a stack- or memAlloc-made IntBuffer
     * (and memFree of it) resolve; asIntBuffer() alone yields an unknown view.
     */

    public static CharBuffer wrapChar(long address, int capacity) {
        CharBuffer view = wrapByte(address, Math.multiplyExact(capacity, 2)).asCharBuffer();
        register(view, address);
        return view;
    }

    public static ShortBuffer wrapShort(long address, int capacity) {
        ShortBuffer view = wrapByte(address, Math.multiplyExact(capacity, 2)).asShortBuffer();
        register(view, address);
        return view;
    }

    public static IntBuffer wrapInt(long address, int capacity) {
        IntBuffer view = wrapByte(address, Math.multiplyExact(capacity, 4)).asIntBuffer();
        register(view, address);
        return view;
    }

    public static LongBuffer wrapLong(long address, int capacity) {
        LongBuffer view = wrapByte(address, Math.multiplyExact(capacity, 8)).asLongBuffer();
        register(view, address);
        return view;
    }

    public static FloatBuffer wrapFloat(long address, int capacity) {
        FloatBuffer view = wrapByte(address, Math.multiplyExact(capacity, 4)).asFloatBuffer();
        register(view, address);
        return view;
    }

    public static DoubleBuffer wrapDouble(long address, int capacity) {
        DoubleBuffer view = wrapByte(address, Math.multiplyExact(capacity, 8)).asDoubleBuffer();
        register(view, address);
        return view;
    }

    private static int truncationReports;

    /**
     * A short view means the address did not resolve to the allocation the
     * caller believes it holds — a freed block, an interior address, or the
     * lazy scratch mapping in {@link #block}. Bounded so a repeating fault
     * cannot flood the marker ring (see the CDP console-pipe limit).
     */
    private static void reportTruncation(
            long address, int capacity, Block block, int offset, int available) {
        if (truncationReports >= 12) {
            return;
        }
        truncationReports++;
        try {
            dev.mcweb.graal.webgpu.BrowserGpu.reportProgress(
                    "native:short-view addr=" + address
                            + " want=" + capacity
                            + " got=" + Math.max(available, 0)
                            + " blockBase=" + block.base
                            + " blockLen=" + block.data.length
                            + " offset=" + offset
                            + " exactBase=" + (offset == 0)
                            + " liveBlocks=" + BLOCKS.size());
        } catch (Throwable ignored) {
            // Diagnostics never break the allocation they describe.
        }
    }

    public static void register(Buffer buffer, long address) {
        if (buffer == null) {
            return;
        }
        BUFFER_ADDRESSES.put(buffer, address);
    }

    /**
     * Add an existing managed byte array to the synthetic native address
     * space. Browser GPU mappings are backed by Java arrays rather than native
     * allocations, but Minecraft still writes their vertices through LWJGL's
     * {@code memPut*} address APIs. Registering the same array (without copying
     * it) makes those writes visible to the buffer's later WebGPU flush.
     */
    public static long registerExternal(byte[] storage) {
        if (storage == null) {
            throw new NullPointerException("storage");
        }
        long address = NEXT.getAndAdd(storage.length + 32L);
        BLOCKS.put(address, new Block(address, storage));
        noteAllocated(storage.length);
        return address;
    }

    /** Base address of the buffer's storage, independent of its position. */
    public static long addressOf(Buffer buffer) {
        if (buffer == null) {
            return 0L;
        }
        Long mapped = BUFFER_ADDRESSES.get(buffer);
        if (mapped != null) {
            return mapped;
        }
        return 0L;
    }

    public static byte getByte(long address) {
        Block b = block(address);
        return b.data[(int) (address - b.base)];
    }

    public static void putByte(long address, byte value) {
        Block b = block(address);
        b.data[(int) (address - b.base)] = value;
    }

    public static short getShort(long address) {
        Block b = block(address);
        byte[] d = b.data;
        int o = (int) (address - b.base);
        return (short) ((d[o] & 0xFF) | ((d[o + 1] & 0xFF) << 8));
    }

    public static void putShort(long address, short value) {
        Block b = block(address);
        byte[] d = b.data;
        int o = (int) (address - b.base);
        d[o] = (byte) value;
        d[o + 1] = (byte) (value >>> 8);
    }

    public static int getInt(long address) {
        Block b = block(address);
        byte[] d = b.data;
        int o = (int) (address - b.base);
        return (d[o] & 0xFF)
                | ((d[o + 1] & 0xFF) << 8)
                | ((d[o + 2] & 0xFF) << 16)
                | ((d[o + 3] & 0xFF) << 24);
    }

    public static void putInt(long address, int value) {
        Block b = block(address);
        byte[] d = b.data;
        int o = (int) (address - b.base);
        d[o] = (byte) value;
        d[o + 1] = (byte) (value >>> 8);
        d[o + 2] = (byte) (value >>> 16);
        d[o + 3] = (byte) (value >>> 24);
    }

    public static long getLong(long address) {
        Block b = block(address);
        byte[] d = b.data;
        int o = (int) (address - b.base);
        int low = (d[o] & 0xFF)
                | ((d[o + 1] & 0xFF) << 8)
                | ((d[o + 2] & 0xFF) << 16)
                | ((d[o + 3] & 0xFF) << 24);
        int high;
        // Scratch can overlap a higher live block: the high half must resolve again.
        if (!b.scratch && o <= d.length - 8) {
            high = (d[o + 4] & 0xFF)
                    | ((d[o + 5] & 0xFF) << 8)
                    | ((d[o + 6] & 0xFF) << 16)
                    | ((d[o + 7] & 0xFF) << 24);
        } else {
            high = getInt(address + 4);
        }
        return (low & 0xFFFF_FFFFL) | ((long) high << 32);
    }

    public static void putLong(long address, long value) {
        Block b = block(address);
        byte[] d = b.data;
        int o = (int) (address - b.base);
        int low = (int) value;
        d[o] = (byte) low;
        d[o + 1] = (byte) (low >>> 8);
        d[o + 2] = (byte) (low >>> 16);
        d[o + 3] = (byte) (low >>> 24);
        int high = (int) (value >>> 32);
        // Keep legacy half-by-half resolution and partial writes at block ends.
        if (!b.scratch && o <= d.length - 8) {
            d[o + 4] = (byte) high;
            d[o + 5] = (byte) (high >>> 8);
            d[o + 6] = (byte) (high >>> 16);
            d[o + 7] = (byte) (high >>> 24);
        } else {
            putInt(address + 4, high);
        }
    }

    public static float getFloat(long address) {
        return Float.intBitsToFloat(getInt(address));
    }

    public static void putFloat(long address, float value) {
        putInt(address, Float.floatToRawIntBits(value));
    }

    public static double getDouble(long address) {
        return Double.longBitsToDouble(getLong(address));
    }

    public static void putDouble(long address, double value) {
        putLong(address, Double.doubleToRawLongBits(value));
    }

    public static long getAddress(long address) {
        return getLong(address);
    }

    public static void putAddress(long address, long value) {
        putLong(address, value);
    }

    /**
     * Fill, one {@link Arrays#fill} per block rather than one resolve per byte. These are
     * {@code memset}/{@code memcpy}: Minecraft's asset load moves megabytes through them,
     * and resolving per byte made each call linear in the number of live blocks *times*
     * its length.
     */
    public static void set(long address, int value, long bytes) {
        long remaining = bytes;
        long at = address;
        while (remaining > 0) {
            Block b = block(at);
            int offset = (int) (at - b.base);
            int run = (int) Math.min(remaining, b.data.length - offset);
            Arrays.fill(b.data, offset, offset + run, (byte) value);
            at += run;
            remaining -= run;
        }
    }

    /** {@code length} bytes of {@code src} from {@code offset} to native {@code dst}, one arraycopy per block. */
    public static void write(byte[] src, int offset, long dst, int length) {
        int done = 0;
        while (done < length) {
            Block b = block(dst + done);
            int at = (int) (dst + done - b.base);
            int run = Math.min(length - done, b.data.length - at);
            System.arraycopy(src, offset + done, b.data, at, run);
            done += run;
        }
    }

    /** {@code length} native bytes at {@code src} into {@code dst} from {@code offset}, one arraycopy per block. */
    public static void read(long src, byte[] dst, int offset, int length) {
        int done = 0;
        while (done < length) {
            Block b = block(src + done);
            int at = (int) (src + done - b.base);
            int run = Math.min(length - done, b.data.length - at);
            System.arraycopy(b.data, at, dst, offset + done, run);
            done += run;
        }
    }

    /** Copy, one {@link System#arraycopy} per source/destination block pair. */
    public static void copy(long src, long dst, long bytes) {
        long remaining = bytes;
        long from = src;
        long to = dst;
        while (remaining > 0) {
            // Resolved separately every iteration (both stay in this thread's cache), and
            // the run length is bounded by whichever side reaches its block end first.
            Block source = block(from);
            int sourceOffset = (int) (from - source.base);
            int sourceRun = source.data.length - sourceOffset;
            Block target = block(to);
            int targetOffset = (int) (to - target.base);
            int run = (int) Math.min(remaining, Math.min(sourceRun, target.data.length - targetOffset));
            System.arraycopy(source.data, sourceOffset, target.data, targetOffset, run);
            from += run;
            to += run;
            remaining -= run;
        }
    }

    private static int sanitize(long size) {
        if (size <= 0L) {
            return 1;
        }
        if (size > Integer.MAX_VALUE) {
            throw new OutOfMemoryError("browser allocation too large: " + size);
        }
        return (int) size;
    }

    /**
     * A block: its base, the array behind it and how much of it a cache hit may
     * address, made once per allocation. The cache below hands these out without
     * looking at {@link #BLOCKS}.
     *
     * <p>{@code limit} is the array's length while the block is live, and
     * {@link #retire} sets it to 0 once the block has left the map, before its array
     * can go back to the pool. A hit is {@code 0 <= address - base < limit}, so a cache
     * entry never answers for a freed block, including one whose base a later scratch
     * mapping reuses ({@link #blockSlow}), and the test costs nothing extra. A plain
     * int is enough: it only ever goes from the length to 0 (a 32-bit store cannot
     * tear), 0 is also what a thread sees of a block it was handed by a race before
     * the constructor's write reached it (a miss, which is always safe), and a thread
     * whose access is ordered after the free sees the 0. A thread racing the free is
     * using memory while it is freed, which no lookup could make safe, the map's
     * included.</p>
     */
    private static final class Block {
        final long base;
        final byte[] data;
        /** A lazy mapping of an unmapped probe ({@link #blockSlow}): never cached. */
        final boolean scratch;
        int limit;

        Block(long base, byte[] data) {
            this(base, data, false);
        }

        Block(long base, byte[] data, boolean scratch) {
            this.base = base;
            this.data = data;
            this.scratch = scratch;
            this.limit = data.length;
        }
    }

    /**
     * Recently used blocks, newest first, of the threads whose ids share this row.
     * Empty entries hold {@link #NONE}, so a hit test needs no null check.
     */
    private static final class Row {
        Block first = NONE;
        Block second = NONE;
        Block third = NONE;
        Block fourth = NONE;

        /** {@code found} to the front; the others move down and the oldest drops out. */
        void push(Block found) {
            if (found != first) {
                if (found != second) {
                    if (found != third) {
                        fourth = third;
                    }
                    third = second;
                }
                second = first;
                first = found;
            }
        }

        void drop(Block freed) {
            if (first == freed) {
                first = NONE;
            }
            if (second == freed) {
                second = NONE;
            }
            if (third == freed) {
                third = NONE;
            }
            if (fourth == freed) {
                fourth = NONE;
            }
        }
    }

    /** Matches no address: {@code limit} is 0. */
    private static final Block NONE = new Block(0L, new byte[0]);

    /**
     * The cache: a row of recently used blocks per thread, picked by thread id.
     *
     * <p>Per thread rather than one shared entry: the boot decodes and edits textures
     * on five workers at once, and image code reads one image while writing another.
     * A single shared entry missed on nearly every access then, and each miss was a
     * skip-list search whose acquire fences are full fences here
     * ({@code Unsafe.loadFence} falls back to {@code fullFence}) plus a volatile
     * store: about a quarter of the boot's worker samples.</p>
     *
     * <p>No fence or volatile on the hit path. The old shared entry was volatile so
     * that a block published by one thread was whole when another read it. Here every
     * entry is checked against the address it is asked for, so what matters is that a
     * thread never sees a half-made block, and the final fields give that: the
     * constructor ends in a storestore fence (in the interpreter and in the wasm
     * JIT's code), and a racing reader of {@code limit} sees the length or 0. So a row
     * needs no owner either: two threads whose ids share one race on its entries, and
     * each still gets a block that contains its address or a miss. Plain stores also
     * keep 64-bit atomics (which trap here when 4-byte aligned) out of the picture.</p>
     */
    private static final int ROW_SLOTS = 64;
    private static final Row[] ROWS = new Row[ROW_SLOTS];

    static {
        for (int i = 0; i < ROW_SLOTS; i++) {
            ROWS[i] = new Row();
        }
    }

    private static Row row() {
        return ROWS[(int) Thread.currentThread().threadId() & (ROW_SLOTS - 1)];
    }

    /**
     * Freed blocks at least this large are also blanked out of the other threads'
     * rows, so an idle thread's cache does not keep a large array alive. Smaller ones
     * are dropped only from the freeing thread's row and age out of the others: four
     * entries a row, so what they can hold stays small.
     */
    private static final int FORGET_EVERYWHERE_BYTES = 16 * 1024;

    private static void forget(Block freed) {
        if (freed.data.length >= FORGET_EVERYWHERE_BYTES) {
            for (Row row : ROWS) {
                row.drop(freed);
            }
        } else {
            row().drop(freed);
        }
    }

    /**
     * Block containing {@code address}, allocation-free on a cache hit.
     *
     * <p>Blocks never overlap - {@link #NEXT} hands out strictly increasing bases with a
     * gap - so "the block containing this address" is exactly "the highest base at or
     * below it", which is one {@link ConcurrentSkipListMap#floorEntry} rather than a walk
     * over every live block. That walk was the boot's dominant cost: {@link #copy} and
     * {@link #set} resolved per byte, and a copy between two blocks missed the one-entry
     * cache of the time on every single byte, so the scan ran once per byte over hundreds
     * of blocks.</p>
     *
     * <p>Only the two newest entries are tested here, to keep this small enough for the
     * JIT to inline into every accessor; {@code Thread.currentThread} is a single load
     * in its code.</p>
     */
    private static Block block(long address) {
        Row row = row();
        Block hit = row.first;
        long offset = address - hit.base;
        if (offset >= 0 && offset < hit.limit) {
            return hit;
        }
        hit = row.second;
        offset = address - hit.base;
        if (offset >= 0 && offset < hit.limit) {
            return hit;
        }
        return blockSlow(address, row);
    }

    /**
     * The cache miss, out of line: kept apart so that {@link #block} is a few
     * bytecodes a JIT can inline into every accessor (the wasm JVM's inlines a
     * call that is rarely made as a cold path, but not a map search or an
     * allocation), which made each vertex attribute BufferBuilder writes a chain
     * of four calls. Tries the row's older two entries, then the map, and moves
     * what it finds to the front of the row.
     */
    private static Block blockSlow(long address, Row row) {
        Block hit = row.third;
        long offset = address - hit.base;
        if (offset < 0 || offset >= hit.limit) {
            hit = row.fourth;
            offset = address - hit.base;
            if (offset < 0 || offset >= hit.limit) {
                hit = containing(address);
            }
        }
        if (hit != null) {
            // A scratch block can span live blocks allocated after the address it
            // was made for (it is 4096 bytes wherever it starts). The map resolves
            // those addresses to the live block above it, but a cached scratch
            // would answer for them first, with zeros, and take their writes.
            if (!hit.scratch) {
                row.push(hit);
            }
            return hit;
        }
        // Lazy-map unmapped probes so field-offset discovery and temporary
        // addresses do not crash; grow a small scratch block.
        //
        // The scratch starts at the probe itself and is never cached. A
        // page-aligned scratch started below the probe, over the live blocks
        // between the page start and the probe, and once cached it answered
        // for them with zeros: a NUL scan that ran off an unterminated string
        // into the gap after its block blanked every struct in that page.
        // Starting at the probe it cannot cover a live block below it (that
        // block would have contained the probe), and floorEntry prefers any
        // live block above it.
        return BLOCKS.computeIfAbsent(address, at -> new Block(at, new byte[4096], true));
    }

    /*
     * Runs every path of the cache once, so that each field it reads is resolved
     * before any caller is compiled. The wasm JIT inlines block() only when all of
     * its field loads are resolved, and a method is compiled once from its first
     * profile: a caller compiled while its thread had touched only one block (so
     * row.second had never been read) kept calling block() for good, at about five
     * times the cost of the inlined accessor.
     */
    static {
        long a = malloc(8);
        long b = malloc(8);
        long c = malloc(8);
        long d = malloc(FORGET_EVERYWHERE_BYTES);
        // The row after each: [a] [b a] [c b a] [d c b a], then hits on the third
        // entry [b d c a], the fourth [a b d c] and the second; the first is hit by
        // every putByte.
        for (long at : new long[] {a, b, c, d, b, a, b}) {
            putByte(at, getByte(at));
        }
        free(a);
        free(b);
        free(c);
        free(d);
    }
}
