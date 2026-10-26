// Compile the real memory implementation, without a built port jar or game files.
// Only the unrelated browser progress sinks are replaced in this JVM fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const localJdk = join(REPO, "OpenJDK/work/temurin25/bin");
const javac = existsSync(join(localJdk, "javac")) ? join(localJdk, "javac") : "javac";
const java = javac === "javac" ? "java" : join(localJdk, "java");
const version = spawnSync(javac, ["-version"], { encoding: "utf8" });
const jdkMajor = Number((`${version.stdout || ""}${version.stderr || ""}`).match(/javac (\d+)/)?.[1]);

const PROBE = String.raw`
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import org.lwjgl.system.BrowserNativeMemory;

public final class LongAccessBehavior {
    private static final long VALUE = 0x89ABCDEF_FEDCBA98L;

    private static void equal(long expected, long actual, String label) {
        if (expected != actual) {
            throw new AssertionError(label + ": expected " + Long.toHexString(expected)
                    + ", got " + Long.toHexString(actual));
        }
    }

    private static void bytes(byte[] expected, byte[] actual, String label) {
        if (!Arrays.equals(expected, actual)) {
            throw new AssertionError(label + ": expected " + Arrays.toString(expected)
                    + ", got " + Arrays.toString(actual));
        }
    }

    private static ByteBuffer little(byte[] storage) {
        return ByteBuffer.wrap(storage).order(ByteOrder.LITTLE_ENDIAN);
    }

    private static void bounds(Runnable action, String label) {
        try {
            action.run();
        } catch (ArrayIndexOutOfBoundsException expected) {
            return;
        }
        throw new AssertionError(label + ": expected ArrayIndexOutOfBoundsException");
    }

    private static void ordinary() {
        long[] values = {0, 1, -1, Long.MIN_VALUE, Long.MAX_VALUE,
                0x00000000_FFFFFFFFL, 0xFFFFFFFF_00000000L,
                0x01234567_89ABCDEFL, VALUE};
        byte[] storage = new byte[48];
        long base = BrowserNativeMemory.registerExternal(storage);
        try {
            for (int offset : new int[] {0, 1, 7, 40}) {
                for (long value : values) {
                    Arrays.fill(storage, (byte) 0x5A);
                    byte[] expected = storage.clone();
                    little(expected).putLong(offset, value);
                    BrowserNativeMemory.putLong(base + offset, value);
                    bytes(expected, storage, "write bytes/guards at " + offset);

                    // Seed the reader independently; a symmetric endian bug must fail.
                    little(storage).putLong(offset, ~value);
                    equal(~value, BrowserNativeMemory.getLong(base + offset),
                            "read at " + offset);
                }
            }
        } finally {
            BrowserNativeMemory.free(base);
        }
        long exact = BrowserNativeMemory.malloc(8);
        try {
            BrowserNativeMemory.putLong(exact, VALUE);
            equal(VALUE, BrowserNativeMemory.getLong(exact), "exact eight-byte allocation");
        } finally {
            BrowserNativeMemory.free(exact);
        }
    }

    private static void inherited() {
        byte[] storage = new byte[17];
        long base = BrowserNativeMemory.registerExternal(storage);
        try {
            long[] bits = {0, Long.MIN_VALUE, 1, 0x3FF00000_00000000L,
                    0x7FF00000_00000000L, 0xFFF00000_00000000L,
                    0x7FF81234_56789ABCL, 0xFFF8FEDC_BA987654L};
            for (int offset : new int[] {0, 1, 9}) {
                for (long raw : bits) {
                    Arrays.fill(storage, (byte) 0x5A);
                    byte[] expected = storage.clone();
                    little(expected).putLong(offset, raw);
                    BrowserNativeMemory.putDouble(base + offset, Double.longBitsToDouble(raw));
                    bytes(expected, storage, "double raw write/guards");
                    little(storage).putLong(offset, raw);
                    equal(raw, Double.doubleToRawLongBits(BrowserNativeMemory.getDouble(base + offset)),
                            "double raw read, including NaN payload");
                }
                for (long address : new long[] {0, 0x12345678_90ABCDEFL, VALUE, -1}) {
                    Arrays.fill(storage, (byte) 0x5A);
                    byte[] expected = storage.clone();
                    little(expected).putLong(offset, address);
                    BrowserNativeMemory.putAddress(base + offset, address);
                    bytes(expected, storage, "address write/guards");
                    little(storage).putLong(offset, ~address);
                    equal(~address, BrowserNativeMemory.getAddress(base + offset), "address read");
                }
            }
        } finally {
            BrowserNativeMemory.free(base);
        }
    }

    private static void partial() {
        // With four bytes remaining the second half resolves a new scratch block;
        // with 1..3 or 5..7 remaining an individual int overruns the original array.
        for (int remaining : new int[] {1, 2, 3, 5, 6, 7}) {
            byte[] storage = new byte[16];
            Arrays.fill(storage, (byte) 0x5A);
            long base = BrowserNativeMemory.registerExternal(storage);
            long at = base + storage.length - remaining;
            try {
                byte[] unchanged = storage.clone();
                bounds(() -> BrowserNativeMemory.getLong(at), "near-end read " + remaining);
                bytes(unchanged, storage, "failed read is not a write");
                byte[] expected = storage.clone();
                byte[] encoded = new byte[8];
                little(encoded).putLong(0, VALUE);
                System.arraycopy(encoded, 0, expected, storage.length - remaining, remaining);
                bounds(() -> BrowserNativeMemory.putLong(at, VALUE), "near-end write " + remaining);
                bytes(expected, storage, "legacy partial write " + remaining);
            } finally {
                BrowserNativeMemory.free(base);
            }
        }
    }

    private static void secondResolution() {
        byte[] storage = new byte[16];
        long base = BrowserNativeMemory.registerExternal(storage);
        long end = base + storage.length;
        try {
            little(storage).putInt(12, (int) VALUE);
            BrowserNativeMemory.putInt(end, (int) (VALUE >>> 32));
            equal(VALUE, BrowserNativeMemory.getLong(end - 4), "ordinary end to gap scratch");
            BrowserNativeMemory.putLong(end - 4, ~VALUE);
            equal((int) ~VALUE, little(storage).getInt(12), "ordinary low half");
            equal((int) (~VALUE >>> 32), BrowserNativeMemory.getInt(end), "gap high half");
        } finally {
            BrowserNativeMemory.free(base);
            BrowserNativeMemory.free(end);
        }

        // A scratch array also has a real end: its high half must resolve there.
        long scratch = 0x70000000L;
        BrowserNativeMemory.putByte(scratch, (byte) 1);
        long tail = scratch + 4092;
        try {
            BrowserNativeMemory.putInt(tail, (int) VALUE);
            BrowserNativeMemory.putInt(tail + 4, (int) (VALUE >>> 32));
            equal(VALUE, BrowserNativeMemory.getLong(tail), "scratch end read");
            BrowserNativeMemory.putLong(tail, ~VALUE);
            equal((int) ~VALUE, BrowserNativeMemory.getInt(tail), "scratch end low write");
            equal((int) (~VALUE >>> 32), BrowserNativeMemory.getInt(tail + 4), "scratch end high write");
        } finally {
            BrowserNativeMemory.free(scratch);
            BrowserNativeMemory.free(tail + 4);
        }
    }

    private static void scratchOverlap() {
        byte[] live = new byte[16];
        Arrays.fill(live, (byte) 0x5A);
        long base = BrowserNativeMemory.registerExternal(live);
        long scratch = base - 4;
        try {
            BrowserNativeMemory.putInt(scratch, (int) VALUE);
            little(live).putInt(0, (int) (VALUE >>> 32));
            equal(VALUE, BrowserNativeMemory.getLong(scratch), "scratch low/live high read");
            byte[] expected = live.clone();
            little(expected).putInt(0, (int) (~VALUE >>> 32));
            BrowserNativeMemory.putLong(scratch, ~VALUE);
            equal((int) ~VALUE, BrowserNativeMemory.getInt(scratch), "scratch low write");
            bytes(expected, live, "high write reaches live block, not overlapping scratch");
            equal(~VALUE, BrowserNativeMemory.getAddress(scratch), "inherited split address read");

            // Reading the live block after touching scratch must not use scratch bytes.
            equal(little(live).getLong(0), BrowserNativeMemory.getLong(base), "live cache remains valid");
        } finally {
            BrowserNativeMemory.free(scratch);
            BrowserNativeMemory.free(base);
        }
    }

    private static void freedCache() throws Exception {
        for (int size : new int[] {16, 16 * 1024}) {
            byte[] storage = new byte[size];
            long base = BrowserNativeMemory.registerExternal(storage);
            BrowserNativeMemory.putLong(base, VALUE);
            CountDownLatch cached = new CountDownLatch(1);
            CountDownLatch freed = new CountDownLatch(1);
            AtomicReference<Throwable> failure = new AtomicReference<>();
            Thread reader = new Thread(() -> {
                try {
                    equal(VALUE, BrowserNativeMemory.getLong(base), "other-thread warm cache");
                    cached.countDown();
                    freed.await();
                    equal(0, BrowserNativeMemory.getLong(base), "freed address lazily remaps, not stale cache");
                    BrowserNativeMemory.putLong(base, ~VALUE);
                    equal(~VALUE, BrowserNativeMemory.getLong(base), "remapped scratch write/read");
                } catch (Throwable error) {
                    failure.set(error);
                } finally {
                    cached.countDown();
                }
            });
            reader.start();
            cached.await();
            // Interior free is supported too; join/latches order all accesses after it.
            BrowserNativeMemory.free(base + 1);
            freed.countDown();
            reader.join();
            try {
                if (failure.get() != null) throw new AssertionError("cache invalidation", failure.get());
                equal(VALUE, little(storage).getLong(0), "remap must not write freed storage");
                equal(~VALUE, BrowserNativeMemory.getLong(base), "freeing thread must not retain old block");
            } finally {
                BrowserNativeMemory.free(base);
            }
        }

        // Realloc retires cached blocks through the same invalidation path.
        long old = BrowserNativeMemory.malloc(16);
        BrowserNativeMemory.putLong(old + 1, VALUE);
        long next = BrowserNativeMemory.realloc(old, 24);
        try {
            equal(VALUE, BrowserNativeMemory.getLong(next + 1), "realloc preserves unaligned value");
            equal(0, BrowserNativeMemory.getLong(old + 1), "realloc invalidates old cached block");
        } finally {
            BrowserNativeMemory.free(old + 1);
            BrowserNativeMemory.free(next);
        }
    }

    public static void main(String[] args) throws Exception {
        switch (args[0]) {
            case "ordinary" -> ordinary();
            case "inherited" -> inherited();
            case "partial" -> partial();
            case "second-resolution" -> secondResolution();
            case "scratch-overlap" -> scratchOverlap();
            case "freed-cache" -> freedCache();
            default -> throw new AssertionError("unknown scenario: " + args[0]);
        }
        System.out.println("PASS " + args[0]);
    }
}
`;

test("BrowserNativeMemory long access preserves byte and lifetime behavior", {
  skip: !(version.status === 0 && jdkMajor >= 19) && "JDK 19+ is required (Thread.threadId)",
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mcweb-native-long-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = {
    "LongAccessBehavior.java": PROBE,
    "dev/mcweb/graal/webgpu/BrowserGpu.java": `package dev.mcweb.graal.webgpu;
      public final class BrowserGpu { public static void reportProgress(String message) {} }`,
    "dev/mcweb/graal/MinecraftInitProgress.java": `package dev.mcweb.graal;
      public final class MinecraftInitProgress { public static String lastStage = "fixture"; }`,
  };
  for (const [path, body] of Object.entries(sources)) {
    const target = join(root, "src", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  const classes = join(root, "classes");
  const compile = spawnSync(javac, ["-nowarn", "-d", classes,
    ...Object.keys(sources).map((path) => join(root, "src", path)),
    join(REPO, "src/graal/java/org/lwjgl/system/BrowserNativeMemory.java"),
    join(REPO, "src/graal/java/org/lwjgl/system/BrowserBufferAddresses.java"),
  ], { encoding: "utf8", timeout: 60_000 });
  assert.equal(compile.status, 0, `${compile.error || ""}\n${compile.stdout}\n${compile.stderr}`);

  for (const scenario of ["ordinary", "inherited", "partial", "second-resolution", "scratch-overlap", "freed-cache"]) {
    await t.test(scenario, () => {
      const result = spawnSync(java, ["-cp", classes, "LongAccessBehavior", scenario], {
        encoding: "utf8", timeout: 30_000,
      });
      assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
    });
  }
});
