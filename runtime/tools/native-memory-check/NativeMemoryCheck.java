import org.lwjgl.system.BrowserNativeMemory;

import java.nio.ByteBuffer;

/**
 * Semantics check for the ordered-lookup rewrite of BrowserNativeMemory: the
 * interior-address resolution, cross-block set/copy runs, and the free/realloc
 * fallbacks must behave exactly as the old per-byte linear-scan version did.
 */
public final class NativeMemoryCheck {

    private static int failures;

    private static void check(String what, long expected, long actual) {
        if (expected != actual) {
            System.out.println("FAIL " + what + ": expected " + expected + " got " + actual);
            failures++;
        }
    }

    public static void main(String[] args) {
        // Several live blocks so an ordered lookup has to pick the right one.
        long a = BrowserNativeMemory.malloc(64);
        long b = BrowserNativeMemory.malloc(128);
        long c = BrowserNativeMemory.malloc(256);

        // Interior addresses resolve into the containing block, not a neighbour.
        BrowserNativeMemory.putInt(a + 8, 0x11223344);
        check("interior int in a", 0x11223344, BrowserNativeMemory.getInt(a + 8));
        BrowserNativeMemory.putInt(b + 120, -1);
        check("int at end of b", 0xFFFFFFFFL, BrowserNativeMemory.getInt(b + 120) & 0xFFFFFFFFL);
        check("a untouched by b write", 0x11223344, BrowserNativeMemory.getInt(a + 8));

        // Byte order and widths.
        BrowserNativeMemory.putLong(c, 0x0102030405060708L);
        check("long round trip", 0x0102030405060708L, BrowserNativeMemory.getLong(c));
        check("low byte is little-endian", 0x08, BrowserNativeMemory.getByte(c) & 0xFF);
        BrowserNativeMemory.putShort(c + 16, (short) 0x7F80);
        check("short round trip", (short) 0x7F80, BrowserNativeMemory.getShort(c + 16));
        BrowserNativeMemory.putFloat(c + 32, 0.5f);
        check("float round trip", Float.floatToRawIntBits(0.5f),
                Float.floatToRawIntBits(BrowserNativeMemory.getFloat(c + 32)));

        // set() must fill exactly the requested range, no more.
        BrowserNativeMemory.set(b, 0xAB, 128);
        for (int i = 0; i < 128; i++) {
            check("set byte " + i, 0xAB, BrowserNativeMemory.getByte(b + i) & 0xFF);
        }
        check("set did not spill into c", 0x08, BrowserNativeMemory.getByte(c) & 0xFF);

        // copy() across two distinct blocks -- the case the old per-byte version
        // resolved once per byte because the one-entry cache alternated.
        BrowserNativeMemory.set(c, 0, 256);
        BrowserNativeMemory.copy(b, c, 128);
        for (int i = 0; i < 128; i++) {
            check("copied byte " + i, 0xAB, BrowserNativeMemory.getByte(c + i) & 0xFF);
        }
        check("copy stopped at length", 0, BrowserNativeMemory.getByte(c + 128) & 0xFF);

        // Overlapping copy inside one block must move, not smear.
        for (int i = 0; i < 16; i++) {
            BrowserNativeMemory.putByte(c + i, (byte) i);
        }
        BrowserNativeMemory.copy(c, c + 4, 8);
        for (int i = 0; i < 8; i++) {
            check("overlapping copy byte " + i, i, BrowserNativeMemory.getByte(c + 4 + i) & 0xFF);
        }

        // wrapByte view aliases the block at the interior offset.
        ByteBuffer view = BrowserNativeMemory.wrapByte(a + 8, 16);
        check("view capacity", 16, view.capacity());
        check("view sees the write", 0x44, view.get(0) & 0xFF);
        view.put(0, (byte) 0x55);
        check("view write is visible", 0x55, BrowserNativeMemory.getByte(a + 8) & 0xFF);

        // realloc from an interior address preserves the tail from that offset.
        long grown = BrowserNativeMemory.realloc(a + 8, 64);
        check("realloc preserved", 0x55, BrowserNativeMemory.getByte(grown) & 0xFF);

        // free at an interior address must release the containing block.
        BrowserNativeMemory.free(b + 64);
        String stats = BrowserNativeMemory.stats();
        System.out.println("stats after frees: " + stats);

        // A previously freed base must not be served from a stale locality cache.
        long reused = BrowserNativeMemory.malloc(128);
        BrowserNativeMemory.putInt(reused, 0x5A5A5A5A);
        check("reused block readable", 0x5A5A5A5A, BrowserNativeMemory.getInt(reused));

        // Unmapped probe addresses are lazily scratch-mapped rather than crashing.
        long probe = 0x8000_0000L;
        BrowserNativeMemory.putInt(probe, 7);
        check("scratch mapped probe", 7, BrowserNativeMemory.getInt(probe));

        System.out.println(failures == 0 ? "NativeMemoryCheck OK" : ("NativeMemoryCheck FAILED: " + failures));
        if (failures != 0) {
            System.exit(1);
        }
    }
}
