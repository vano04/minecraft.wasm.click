package org.lwjgl.system;

import java.nio.Buffer;
import java.nio.BufferOverflowException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.DoubleBuffer;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import java.nio.LongBuffer;
import java.nio.ShortBuffer;
import java.nio.charset.StandardCharsets;

/**
 * {@link MemoryUtil#BACKEND} for the browser: LWJGL 3.4.3's pluggable memory
 * backend over {@link BrowserNativeMemory}'s synthetic address space.
 *
 * <p>3.4.3 moved {@code MemoryStack} and {@code APIUtil} off MemoryUtil's
 * static helpers and onto this interface (every stack malloc, ASCII, UTF8 and
 * UTF16 goes through {@code BACKEND.wrapBuffer*}/{@code putString*}). Upstream
 * picks an Unsafe or FFM implementation in MemoryUtil's static initializer;
 * neither can address these heap {@code byte[]} blocks, so the shadow installs
 * this one instead. The {@code *Unaligned} variants equal the aligned ones:
 * every access here is assembled byte by byte anyway.
 */
final class BrowserMemoryBackend implements MemoryBackend {
    BrowserMemoryBackend() {
    }

    // ---- scalar access ----------------------------------------------------

    @Override
    public boolean getBoolean(long ptr) {
        return BrowserNativeMemory.getByte(ptr) != 0;
    }

    @Override
    public byte getByte(long ptr) {
        return BrowserNativeMemory.getByte(ptr);
    }

    @Override
    public char getChar(long ptr) {
        return (char) BrowserNativeMemory.getShort(ptr);
    }

    @Override
    public char getCharUnaligned(long ptr) {
        return getChar(ptr);
    }

    @Override
    public short getShort(long ptr) {
        return BrowserNativeMemory.getShort(ptr);
    }

    @Override
    public short getShortUnaligned(long ptr) {
        return getShort(ptr);
    }

    @Override
    public int getInt(long ptr) {
        return BrowserNativeMemory.getInt(ptr);
    }

    @Override
    public int getIntUnaligned(long ptr) {
        return getInt(ptr);
    }

    @Override
    public long getLong(long ptr) {
        return BrowserNativeMemory.getLong(ptr);
    }

    @Override
    public long getLongUnaligned(long ptr) {
        return getLong(ptr);
    }

    /** Little-endian, like every block access: the offset is a plain array index. */
    @Override
    public long getLong(byte[] array, long offset) {
        int o = Math.toIntExact(offset);
        long value = 0L;
        for (int i = 7; i >= 0; i--) {
            value = (value << 8) | (array[o + i] & 0xFFL);
        }
        return value;
    }

    @Override
    public float getFloat(long ptr) {
        return BrowserNativeMemory.getFloat(ptr);
    }

    @Override
    public float getFloatUnaligned(long ptr) {
        return getFloat(ptr);
    }

    @Override
    public double getDouble(long ptr) {
        return BrowserNativeMemory.getDouble(ptr);
    }

    @Override
    public double getDoubleUnaligned(long ptr) {
        return getDouble(ptr);
    }

    /** C long is 64-bit here, as {@link MemoryUtil#memGetCLong} already assumes. */
    @Override
    public long getCLong(long ptr) {
        return BrowserNativeMemory.getLong(ptr);
    }

    @Override
    public long getCLongUnaligned(long ptr) {
        return getCLong(ptr);
    }

    @Override
    public long getAddress(long ptr) {
        return BrowserNativeMemory.getAddress(ptr);
    }

    @Override
    public long getAddressUnaligned(long ptr) {
        return getAddress(ptr);
    }

    @Override
    public void putBoolean(long ptr, boolean value) {
        BrowserNativeMemory.putByte(ptr, value ? (byte) 1 : (byte) 0);
    }

    @Override
    public void putByte(long ptr, byte value) {
        BrowserNativeMemory.putByte(ptr, value);
    }

    @Override
    public void putChar(long ptr, char value) {
        BrowserNativeMemory.putShort(ptr, (short) value);
    }

    @Override
    public void putCharUnaligned(long ptr, char value) {
        putChar(ptr, value);
    }

    @Override
    public void putShort(long ptr, short value) {
        BrowserNativeMemory.putShort(ptr, value);
    }

    @Override
    public void putShortUnaligned(long ptr, short value) {
        putShort(ptr, value);
    }

    @Override
    public void putInt(long ptr, int value) {
        BrowserNativeMemory.putInt(ptr, value);
    }

    @Override
    public void putIntUnaligned(long ptr, int value) {
        putInt(ptr, value);
    }

    @Override
    public void putLong(long ptr, long value) {
        BrowserNativeMemory.putLong(ptr, value);
    }

    @Override
    public void putLongUnaligned(long ptr, long value) {
        putLong(ptr, value);
    }

    @Override
    public void putFloat(long ptr, float value) {
        BrowserNativeMemory.putFloat(ptr, value);
    }

    @Override
    public void putFloatUnaligned(long ptr, float value) {
        putFloat(ptr, value);
    }

    @Override
    public void putDouble(long ptr, double value) {
        BrowserNativeMemory.putDouble(ptr, value);
    }

    @Override
    public void putDoubleUnaligned(long ptr, double value) {
        putDouble(ptr, value);
    }

    @Override
    public void putCLong(long ptr, long value) {
        BrowserNativeMemory.putLong(ptr, value);
    }

    @Override
    public void putCLongUnaligned(long ptr, long value) {
        putCLong(ptr, value);
    }

    @Override
    public void putAddress(long ptr, long value) {
        BrowserNativeMemory.putAddress(ptr, value);
    }

    @Override
    public void putAddressUnaligned(long ptr, long value) {
        putAddress(ptr, value);
    }

    // ---- buffer addresses -------------------------------------------------

    /** Address of element 0; only views made by this shadow are known (see BrowserNativeMemory#register). */
    @Override
    public long getAddress0(Buffer buffer) {
        return BrowserNativeMemory.addressOf(buffer);
    }

    @Override
    public long getAddress0(ByteBuffer buffer) {
        return BrowserNativeMemory.addressOf(buffer);
    }

    @Override
    public long getAddress0(CharBuffer buffer) {
        return BrowserNativeMemory.addressOf(buffer);
    }

    @Override
    public long getAddress0(ShortBuffer buffer) {
        return BrowserNativeMemory.addressOf(buffer);
    }

    @Override
    public long getAddress0(IntBuffer buffer) {
        return BrowserNativeMemory.addressOf(buffer);
    }

    @Override
    public long getAddress0(LongBuffer buffer) {
        return BrowserNativeMemory.addressOf(buffer);
    }

    @Override
    public long getAddress0(FloatBuffer buffer) {
        return BrowserNativeMemory.addressOf(buffer);
    }

    @Override
    public long getAddress0(DoubleBuffer buffer) {
        return BrowserNativeMemory.addressOf(buffer);
    }

    @Override
    public long getAddress(Buffer buffer) {
        return getAddress(buffer, buffer.position());
    }

    @Override
    public long getAddress(Buffer buffer, int position) {
        return BrowserNativeMemory.addressOf(buffer) + ((long) position << elementShift(buffer));
    }

    @Override
    public long getAddress(ByteBuffer buffer) {
        return getAddress(buffer, buffer.position());
    }

    @Override
    public long getAddress(ByteBuffer buffer, int position) {
        return BrowserNativeMemory.addressOf(buffer) + position;
    }

    @Override
    public long getAddress(CharBuffer buffer) {
        return getAddress(buffer, buffer.position());
    }

    @Override
    public long getAddress(CharBuffer buffer, int position) {
        return BrowserNativeMemory.addressOf(buffer) + ((long) position << 1);
    }

    @Override
    public long getAddress(ShortBuffer buffer) {
        return getAddress(buffer, buffer.position());
    }

    @Override
    public long getAddress(ShortBuffer buffer, int position) {
        return BrowserNativeMemory.addressOf(buffer) + ((long) position << 1);
    }

    @Override
    public long getAddress(IntBuffer buffer) {
        return getAddress(buffer, buffer.position());
    }

    @Override
    public long getAddress(IntBuffer buffer, int position) {
        return BrowserNativeMemory.addressOf(buffer) + ((long) position << 2);
    }

    @Override
    public long getAddress(LongBuffer buffer) {
        return getAddress(buffer, buffer.position());
    }

    @Override
    public long getAddress(LongBuffer buffer, int position) {
        return BrowserNativeMemory.addressOf(buffer) + ((long) position << 3);
    }

    @Override
    public long getAddress(FloatBuffer buffer) {
        return getAddress(buffer, buffer.position());
    }

    @Override
    public long getAddress(FloatBuffer buffer, int position) {
        return BrowserNativeMemory.addressOf(buffer) + ((long) position << 2);
    }

    @Override
    public long getAddress(DoubleBuffer buffer) {
        return getAddress(buffer, buffer.position());
    }

    @Override
    public long getAddress(DoubleBuffer buffer, int position) {
        return BrowserNativeMemory.addressOf(buffer) + ((long) position << 3);
    }

    private static int elementShift(Buffer buffer) {
        if (buffer instanceof ByteBuffer) {
            return 0;
        }
        if (buffer instanceof ShortBuffer || buffer instanceof CharBuffer) {
            return 1;
        }
        if (buffer instanceof IntBuffer || buffer instanceof FloatBuffer) {
            return 2;
        }
        return 3;
    }

    // ---- buffer views -----------------------------------------------------
    //
    // Every view is made by BrowserNativeMemory.wrap*, which registers its
    // address; a JDK duplicate()/slice() would not be registered and would
    // report address 0.

    @Override
    public ByteBuffer wrapBufferByte(long address, int capacity) {
        return BrowserNativeMemory.wrapByte(address, capacity);
    }

    @Override
    public CharBuffer wrapBufferChar(long address, int capacity) {
        return BrowserNativeMemory.wrapChar(address, capacity);
    }

    @Override
    public ShortBuffer wrapBufferShort(long address, int capacity) {
        return BrowserNativeMemory.wrapShort(address, capacity);
    }

    @Override
    public IntBuffer wrapBufferInt(long address, int capacity) {
        return BrowserNativeMemory.wrapInt(address, capacity);
    }

    @Override
    public LongBuffer wrapBufferLong(long address, int capacity) {
        return BrowserNativeMemory.wrapLong(address, capacity);
    }

    @Override
    public FloatBuffer wrapBufferFloat(long address, int capacity) {
        return BrowserNativeMemory.wrapFloat(address, capacity);
    }

    @Override
    public DoubleBuffer wrapBufferDouble(long address, int capacity) {
        return BrowserNativeMemory.wrapDouble(address, capacity);
    }

    /** Same memory, capacity, position and limit; the order is native like every view here. */
    private static <T extends Buffer> T sameWindow(T view, Buffer source) {
        view.limit(source.limit());
        view.position(source.position());
        return view;
    }

    @Override
    public ByteBuffer duplicate(ByteBuffer buffer) {
        return sameWindow(wrapBufferByte(getAddress0(buffer), buffer.capacity()), buffer);
    }

    @Override
    public CharBuffer duplicate(CharBuffer buffer) {
        return sameWindow(wrapBufferChar(getAddress0(buffer), buffer.capacity()), buffer);
    }

    @Override
    public ShortBuffer duplicate(ShortBuffer buffer) {
        return sameWindow(wrapBufferShort(getAddress0(buffer), buffer.capacity()), buffer);
    }

    @Override
    public IntBuffer duplicate(IntBuffer buffer) {
        return sameWindow(wrapBufferInt(getAddress0(buffer), buffer.capacity()), buffer);
    }

    @Override
    public LongBuffer duplicate(LongBuffer buffer) {
        return sameWindow(wrapBufferLong(getAddress0(buffer), buffer.capacity()), buffer);
    }

    @Override
    public FloatBuffer duplicate(FloatBuffer buffer) {
        return sameWindow(wrapBufferFloat(getAddress0(buffer), buffer.capacity()), buffer);
    }

    @Override
    public DoubleBuffer duplicate(DoubleBuffer buffer) {
        return sameWindow(wrapBufferDouble(getAddress0(buffer), buffer.capacity()), buffer);
    }

    /**
     * Element index of a sub-slice's start, with LWJGL's bounds contract: the
     * start must lie within [0, limit] and the slice within the capacity.
     */
    private static int sliceStart(Buffer buffer, int offset, int capacity) {
        int start = buffer.position() + offset;
        if ((offset | start) < 0 || buffer.limit() < start) {
            throw new IllegalArgumentException();
        }
        if (capacity < 0 || buffer.capacity() - start < capacity) {
            throw new IllegalArgumentException();
        }
        return start;
    }

    @Override
    public ByteBuffer slice(ByteBuffer buffer) {
        return wrapBufferByte(getAddress(buffer), buffer.remaining());
    }

    @Override
    public ByteBuffer slice(ByteBuffer buffer, int offset, int capacity) {
        return wrapBufferByte(getAddress(buffer, sliceStart(buffer, offset, capacity)), capacity);
    }

    @Override
    public CharBuffer slice(CharBuffer buffer) {
        return wrapBufferChar(getAddress(buffer), buffer.remaining());
    }

    @Override
    public CharBuffer slice(CharBuffer buffer, int offset, int capacity) {
        return wrapBufferChar(getAddress(buffer, sliceStart(buffer, offset, capacity)), capacity);
    }

    @Override
    public ShortBuffer slice(ShortBuffer buffer) {
        return wrapBufferShort(getAddress(buffer), buffer.remaining());
    }

    @Override
    public ShortBuffer slice(ShortBuffer buffer, int offset, int capacity) {
        return wrapBufferShort(getAddress(buffer, sliceStart(buffer, offset, capacity)), capacity);
    }

    @Override
    public IntBuffer slice(IntBuffer buffer) {
        return wrapBufferInt(getAddress(buffer), buffer.remaining());
    }

    @Override
    public IntBuffer slice(IntBuffer buffer, int offset, int capacity) {
        return wrapBufferInt(getAddress(buffer, sliceStart(buffer, offset, capacity)), capacity);
    }

    @Override
    public LongBuffer slice(LongBuffer buffer) {
        return wrapBufferLong(getAddress(buffer), buffer.remaining());
    }

    @Override
    public LongBuffer slice(LongBuffer buffer, int offset, int capacity) {
        return wrapBufferLong(getAddress(buffer, sliceStart(buffer, offset, capacity)), capacity);
    }

    @Override
    public FloatBuffer slice(FloatBuffer buffer) {
        return wrapBufferFloat(getAddress(buffer), buffer.remaining());
    }

    @Override
    public FloatBuffer slice(FloatBuffer buffer, int offset, int capacity) {
        return wrapBufferFloat(getAddress(buffer, sliceStart(buffer, offset, capacity)), capacity);
    }

    @Override
    public DoubleBuffer slice(DoubleBuffer buffer) {
        return wrapBufferDouble(getAddress(buffer), buffer.remaining());
    }

    @Override
    public DoubleBuffer slice(DoubleBuffer buffer, int offset, int capacity) {
        return wrapBufferDouble(getAddress(buffer, sliceStart(buffer, offset, capacity)), capacity);
    }

    // ---- bulk memory ------------------------------------------------------
    //
    // Array offsets and lengths are in elements, as upstream.

    @Override
    public void memset(long ptr, int value, long bytes) {
        BrowserNativeMemory.set(ptr, value, bytes);
    }

    @Override
    public void memcpy(long src, long dst, long bytes) {
        BrowserNativeMemory.copy(src, dst, bytes);
    }

    @Override
    public void memcpy(byte[] src, long dst, int offset, int length) {
        BrowserNativeMemory.write(src, offset, dst, length);
    }

    @Override
    public void memcpy(char[] src, long dst, int offset, int length) {
        for (int i = 0; i < length; i++) {
            BrowserNativeMemory.putShort(dst + ((long) i << 1), (short) src[offset + i]);
        }
    }

    @Override
    public void memcpy(short[] src, long dst, int offset, int length) {
        MemoryUtil.memCopy(src, dst, offset, length);
    }

    @Override
    public void memcpy(int[] src, long dst, int offset, int length) {
        MemoryUtil.memCopy(src, dst, offset, length);
    }

    @Override
    public void memcpy(long[] src, long dst, int offset, int length) {
        MemoryUtil.memCopy(src, dst, offset, length);
    }

    @Override
    public void memcpy(float[] src, long dst, int offset, int length) {
        MemoryUtil.memCopy(src, dst, offset, length);
    }

    @Override
    public void memcpy(double[] src, long dst, int offset, int length) {
        MemoryUtil.memCopy(src, dst, offset, length);
    }

    @Override
    public void memcpy(long src, byte[] dst, int offset, int length) {
        BrowserNativeMemory.read(src, dst, offset, length);
    }

    @Override
    public void memcpy(long src, char[] dst, int offset, int length) {
        for (int i = 0; i < length; i++) {
            dst[offset + i] = (char) BrowserNativeMemory.getShort(src + ((long) i << 1));
        }
    }

    @Override
    public void memcpy(long src, short[] dst, int offset, int length) {
        MemoryUtil.memCopy(src, dst, offset, length);
    }

    @Override
    public void memcpy(long src, int[] dst, int offset, int length) {
        MemoryUtil.memCopy(src, dst, offset, length);
    }

    @Override
    public void memcpy(long src, long[] dst, int offset, int length) {
        MemoryUtil.memCopy(src, dst, offset, length);
    }

    @Override
    public void memcpy(long src, float[] dst, int offset, int length) {
        MemoryUtil.memCopy(src, dst, offset, length);
    }

    @Override
    public void memcpy(long src, double[] dst, int offset, int length) {
        MemoryUtil.memCopy(src, dst, offset, length);
    }

    // ---- strings ----------------------------------------------------------
    //
    // The getString* defaults (strlen + memcpy into a thread-local array) work
    // as they are over the members above. Encoders use the JDK's charsets so
    // that lengths agree with MemoryUtil.memLength*, which the callers use to
    // size the target before writing.

    @Override
    public void putStringASCII(String text, boolean nullTerminated, long target) {
        putStringASCII((CharSequence) text, nullTerminated, target);
    }

    @Override
    public void putStringASCII(CharSequence text, boolean nullTerminated, long target) {
        int length = text.length();
        for (int i = 0; i < length; i++) {
            BrowserNativeMemory.putByte(target + i, (byte) text.charAt(i));
        }
        if (nullTerminated) {
            BrowserNativeMemory.putByte(target + length, (byte) 0);
        }
    }

    @Override
    public ByteBuffer allocateUTF8(String text, boolean nullTerminated, MemoryUtil.MemoryAllocator allocator) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        int length = MemoryUtil.memLengthNT1(bytes, nullTerminated);
        long target = allocator.malloc(length);
        writeNT1(bytes, nullTerminated, target);
        return wrapBufferByte(target, length);
    }

    @Override
    public void putStringUTF8(CharSequence text, boolean nullTerminated, long target) {
        writeNT1(text.toString().getBytes(StandardCharsets.UTF_8), nullTerminated, target);
    }

    @Override
    public int putStringUTF8(String text, boolean nullTerminated, long target, int maxLength) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        int length = MemoryUtil.memLengthNT1(bytes, nullTerminated);
        if (maxLength < length) {
            throw new BufferOverflowException();
        }
        writeNT1(bytes, nullTerminated, target);
        return length;
    }

    private static void writeNT1(byte[] bytes, boolean nullTerminated, long target) {
        BrowserNativeMemory.write(bytes, 0, target, bytes.length);
        if (nullTerminated) {
            BrowserNativeMemory.putByte(target + bytes.length, (byte) 0);
        }
    }

    @Override
    public void putStringUTF16(String text, boolean nullTerminated, long target) {
        putStringUTF16((CharSequence) text, nullTerminated, target);
    }

    @Override
    public void putStringUTF16(CharSequence text, boolean nullTerminated, long target) {
        int length = text.length();
        for (int i = 0; i < length; i++) {
            BrowserNativeMemory.putShort(target + ((long) i << 1), (short) text.charAt(i));
        }
        if (nullTerminated) {
            BrowserNativeMemory.putShort(target + ((long) length << 1), (short) 0);
        }
    }
}
