package dev.mcweb.graal.webgpu;

import com.mojang.renderpearl.api.buffers.GpuBuffer;
import com.mojang.renderpearl.api.buffers.GpuBufferSlice;
import com.mojang.renderpearl.api.buffers.TransientMemory;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Browser transient memory. The browser host cannot share synchronous GPU
 * mappings, so CPU-visible scratch is heap-backed and GPU-visible scratch is
 * COPY_DST buffers flushed through queue.writeBuffer on unmap, matching
 * Mojang's MappableRingBuffer replacement pattern from the port boundary.
 */
final class WebGpuTransientMemory implements TransientMemory {
    // These cap reuse after submit, never a caller's allocation or rendering.
    private static final long MAX_RETAINED_BYTES = 64L * 1024L * 1024L;
    private static final long MAX_RETAINED_SHADOW_BYTES = 16L * 1024L * 1024L;
    private static final int MAX_RETAINED_BUFFERS = 512;
    private static final long LARGE_BUFFER_BYTES = 1024L * 1024L;
    /**
     * A transient slice is borrowed until submit, not owned by its caller.
     * Keep backing buffers per usage and reuse slots only after submit has
     * queued their consumers. All mappings here are CPU shadows, not native
     * GPU mappings, so the next upload follows the prior submit in queue order
     * without waiting for GPU completion on the Java thread.
     */
    private final CpuArena cpuArena = new CpuArena();
    private final Map<Integer, BufferPool> bufferPools = new HashMap<>();
    @Override
    public ByteBuffer allocateCpu(long size, long alignment, long offset, long padding) {
        return cpuArena.allocate(size, alignment);
    }

    @Override
    public GpuBufferSlice.MappedView allocateStaging(
            long size,
            long alignment,
            int usage,
            long offset,
            long padding
    ) {
        WebGpuBuffer buffer = acquire(size, mappableUsage(usage), true);
        return buffer.map(0L, size, false, true);
    }

    @Override
    public GpuBufferSlice allocateGpu(long size, long alignment, int usage, long offset, long padding) {
        // Native allocateGpu is device-local and never exposes a mapped CPU
        // view. COPY_DST is the browser replacement for the later writeToBuffer
        // operation, while skipping the shadow avoids mirroring transient GPU
        // allocations in the Java heap.
        WebGpuBuffer buffer = acquire(size, usage | GpuBuffer.USAGE_COPY_DST, false);
        return buffer.slice(0L, size);
    }

    @Override
    public GpuBufferSlice.MappedView allocateGpuMapped(
            long size,
            long alignment,
            int usage,
            long offset,
            long padding
    ) {
        WebGpuBuffer buffer = acquire(size, mappableUsage(usage), true);
        return buffer.map(0L, size, false, true);
    }

    @Override
    public GpuBufferSlice uploadStaging(ByteBuffer data, long alignment, int usage, long offset, long padding) {
        return upload(data, usage, offset, padding, true);
    }

    @Override
    public GpuBufferSlice uploadGpu(ByteBuffer data, long alignment, int usage, long offset, long padding) {
        return upload(data, usage, offset, padding, false);
    }

    @Override
    public GpuBufferSlice uploadStaging(List<ByteBuffer> dataParts, long alignment, int usage, long offset, long padding) {
        return upload(gather(dataParts), usage, offset, padding, true);
    }

    @Override
    public GpuBufferSlice uploadGpu(List<ByteBuffer> dataParts, long alignment, int usage, long offset, long padding) {
        return upload(gather(dataParts), usage, offset, padding, false);
    }

    @Override
    public List<GpuBufferSlice> multiUploadStaging(List<ByteBuffer> dataParts, long alignment, int usage) {
        return multiUpload(dataParts, usage, true);
    }

    @Override
    public List<GpuBufferSlice> multiUploadGpu(List<ByteBuffer> dataParts, long alignment, int usage) {
        return multiUpload(dataParts, usage, false);
    }

    private GpuBufferSlice upload(
            ByteBuffer data,
            int usage,
            long offset,
            long padding,
            boolean staging
    ) {
        ByteBuffer source = data.duplicate();
        // uploadStaging needs a CPU shadow because copyBufferToTexture is a
        // synchronous browser seam. uploadGpu is device-local by contract and
        // can stream the source directly from WasmLM linear memory instead.
        int bufferUsage = staging
                ? mappableUsage(usage)
                : usage | GpuBuffer.USAGE_COPY_DST;
        int length = source.remaining();
        WebGpuBuffer buffer = acquire(length, bufferUsage, staging);
        buffer.upload(0L, source);
        return new GpuBufferSlice(buffer, 0L, length);
    }

    private List<GpuBufferSlice> multiUpload(
            List<ByteBuffer> dataParts,
            int usage,
            boolean staging
    ) {
        List<GpuBufferSlice> slices = new ArrayList<>(dataParts.size());
        for (ByteBuffer part : dataParts) {
            slices.add(upload(part, usage, 0L, 0L, staging));
        }
        return slices;
    }

    /** Called only after the encoder's consumers have entered the GPU queue. */
    void resetAfterSubmit() {
        cpuArena.reset();
        long retainedBytes = 0L, retainedShadowBytes = 0L;
        int retainedBuffers = 0;
        var pools = bufferPools.values().iterator();
        while (pools.hasNext()) {
            BufferPool pool = pools.next();
            int kept = 0;
            for (int i = 0; i < pool.buffers.size(); i++) {
                BufferSlot slot = pool.buffers.get(i);
                long capacity = slot.buffer.size();
                long shadowBytes = pool.shadow ? capacity : 0L;
                boolean excessiveCapacity = capacity > LARGE_BUFFER_BYTES
                        && capacity > slot.requestedBytes * 4L;
                if (i >= pool.cursor || slot.buffer.isClosed() || excessiveCapacity
                        || retainedBuffers >= MAX_RETAINED_BUFFERS
                        || capacity > MAX_RETAINED_BYTES - retainedBytes
                        || shadowBytes > MAX_RETAINED_SHADOW_BYTES - retainedShadowBytes) {
                    // Consumers have entered the GPU queue. The host's existing
                    // deferred destruction keeps their native buffers alive.
                    slot.buffer.close();
                } else {
                    pool.buffers.set(kept++, slot);
                    retainedBytes += capacity;
                    retainedShadowBytes += shadowBytes;
                    retainedBuffers++;
                }
            }
            pool.buffers.subList(kept, pool.buffers.size()).clear();
            pool.cursor = 0;
            if (kept == 0) pools.remove();
        }
    }

    void close() {
        for (BufferPool pool : bufferPools.values()) {
            for (BufferSlot slot : pool.buffers) slot.buffer.close();
        }
        bufferPools.clear();
    }

    private WebGpuBuffer acquire(long size, int usage, boolean shadow) {
        long capacity = allocationSize(size);
        int key = (usage << 1) | (shadow ? 1 : 0);
        BufferPool pool = bufferPools.get(key);
        if (pool == null) {
            pool = new BufferPool(shadow);
            bufferPools.put(key, pool);
        }
        int slot = pool.cursor++;
        if (slot == pool.buffers.size()) {
            WebGpuBuffer buffer = new WebGpuBuffer("transient pooled", usage, capacity, shadow);
            pool.buffers.add(new BufferSlot(buffer, size));
            return buffer;
        }
        BufferSlot retained = pool.buffers.get(slot);
        WebGpuBuffer buffer = retained.buffer;
        if (buffer.isClosed() || buffer.size() < capacity) {
            buffer.close();
            buffer = new WebGpuBuffer("transient pooled", usage, capacity, shadow);
            retained.buffer = buffer;
        }
        retained.requestedBytes = size;
        return buffer;
    }

    private static final class BufferPool {
        final List<BufferSlot> buffers = new ArrayList<>();
        final boolean shadow;
        int cursor;

        BufferPool(boolean shadow) { this.shadow = shadow; }
    }

    private static final class BufferSlot {
        WebGpuBuffer buffer;
        long requestedBytes;

        BufferSlot(WebGpuBuffer buffer, long requestedBytes) {
            this.buffer = buffer;
            this.requestedBytes = requestedBytes;
        }
    }

    private static ByteBuffer gather(List<ByteBuffer> dataParts) {
        int total = 0;
        for (ByteBuffer part : dataParts) {
            total += part.remaining();
        }
        byte[] gathered = BrowserGpu.allocate(total, "transientGather");
        int position = 0;
        for (ByteBuffer part : dataParts) {
            ByteBuffer source = part.duplicate();
            int remaining = source.remaining();
            source.get(gathered, position, remaining);
            position += remaining;
        }
        return ByteBuffer.wrap(gathered);
    }

    private static int mappableUsage(int usage) {
        // WebGPU forbids MAP_WRITE combined with UNIFORM/VERTEX/INDEX; the
        // browser buffer keeps a CPU shadow and flushes through COPY_DST.
        // MAP_WRITE also keeps uploads shadow-routed, which tolerates
        // non-four-byte-aligned data that writeBuffer64 would reject.
        return usage | GpuBuffer.USAGE_COPY_DST | GpuBuffer.USAGE_MAP_WRITE;
    }

    /**
     * The extra TransientMemory arguments are block-allocator rollover hints,
     * not bytes to prepend to the returned slice. Native backends normally
     * allocate the requested size at an allocator-chosen offset (zero for a
     * fresh browser buffer); adding the hint again doubled every small
     * transient allocation in this single-buffer implementation.
     */
    private static long allocationSize(long size) {
        if (size < 0 || size > Integer.MAX_VALUE - 3L) {
            throw new IllegalArgumentException("Transient allocation is out of range: " + size);
        }
        return Math.max(1L, size);
    }

    /**
     * A submit-scoped byte arena for the CPU side of TransientMemory. The first
     * block is deliberately modest; a larger request gets one appropriately sized
     * block which is then retained and reused on later submits.
     */
    private static final class CpuArena {
        private static final int BLOCK_BYTES = 4 * 1024 * 1024;
        private final List<byte[]> blocks = new ArrayList<>();
        private int blockIndex;
        private int cursor;

        ByteBuffer allocate(long size, long alignment) {
            int bytes = (int) allocationSize(size);
            int align = checkedAlignment(alignment);
            long minimumLong = (long) bytes + align - 1L;
            if (minimumLong > Integer.MAX_VALUE) {
                throw new IllegalArgumentException("Transient allocation alignment overflows: " + size);
            }
            int minimum = (int) minimumLong;
            for (;;) {
                byte[] block = block(blockIndex, minimum);
                int start = alignUp(cursor, align);
                if (start <= block.length - bytes) {
                    cursor = start + bytes;
                    // Native transient memory is scratch, not zero-initialized storage;
                    // callers fill the returned range before the GPU consumes it.
                    return ByteBuffer.wrap(block, start, bytes).slice();
                }
                blockIndex++;
                cursor = 0;
            }
        }

        void reset() {
            blockIndex = 0;
            cursor = 0;
        }

        private byte[] block(int index, int minimum) {
            while (blocks.size() <= index) {
                int capacity = Math.max(BLOCK_BYTES, minimum);
                blocks.add(BrowserGpu.allocate(capacity, "transientCpuArena"));
            }
            byte[] block = blocks.get(index);
            if (block.length >= minimum) {
                return block;
            }
            byte[] replacement = BrowserGpu.allocate(minimum, "transientCpuArenaGrow");
            blocks.set(index, replacement);
            return replacement;
        }

        private static int checkedAlignment(long alignment) {
            if (alignment <= 1L) {
                return 1;
            }
            if (alignment > Integer.MAX_VALUE || (alignment & (alignment - 1L)) != 0L) {
                throw new IllegalArgumentException("Transient alignment is out of range: " + alignment);
            }
            return (int) alignment;
        }

        private static int alignUp(int value, int alignment) {
            int mask = alignment - 1;
            if (value > Integer.MAX_VALUE - mask) {
                return Integer.MAX_VALUE;
            }
            return (value + mask) & ~mask;
        }
    }
}
