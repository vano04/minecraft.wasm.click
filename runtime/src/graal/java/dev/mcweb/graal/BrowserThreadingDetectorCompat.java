package dev.mcweb.graal;

import net.minecraft.util.ThreadingDetector;

/**
 * Mojang's {@link ThreadingDetector} guard, as this runtime runs it.
 *
 * <p>Every block write into a {@code PalettedContainer} (world generation, and
 * anything else that sets a block) goes {@code PalettedContainer.getAndSet} /
 * {@code set} -&gt; {@code acquire} / {@code release} -&gt;
 * {@code ThreadingDetector.checkAndLock} / {@code checkAndUnlock}, which take a
 * {@link java.util.concurrent.Semaphore} and a {@link java.util.concurrent.locks.Lock}
 * per write. The semaphore's {@code tryAcquire} is a CAS the JIT will not inline
 * (a guard on a state it could not re-establish would re-run the CAS), so each
 * write is a chain of framed calls: {@code acquire}, then {@code checkAndLock},
 * which itself calls {@code Lock.lock}, {@code Semaphore.tryAcquire} and
 * {@code Lock.unlock}. That is what STATUS records as the worldgen lane being
 * ~12x HotSpot.
 *
 * <p>The detector exists only to report concurrent access to one container. This
 * runtime does not have that hazard: a chunk's block writes run on the one
 * generation thread that owns it, and the port's executors never share a
 * container between threads (the same property
 * {@code BrowserChunkCompat}'s single-owner dispatcher relies on). So the
 * acquire/release pair is redirected here, and by default it does nothing at
 * all - which removes the CAS from the write path and leaves
 * {@code acquire}/{@code release} small enough to inline into their callers.
 *
 * <p>{@code -Dmcweb.threadingDetector=on} (the page's {@code ?threadingDetector=1})
 * restores Mojang's guard exactly, for A/B: same redirect, same descriptor, one
 * static-final branch.
 */
public final class BrowserThreadingDetectorCompat {

    /**
     * Vanilla's guard, or none: {@code -Dmcweb.threadingDetector=on|1|true}.
     * Off by default, and off when the property is {@code off} or unset.
     */
    private static final boolean ENABLED = isOn(System.getProperty("mcweb.threadingDetector"));

    private static boolean isOn(String value) {
        return "on".equals(value) || "1".equals(value) || "true".equals(value);
    }

    /**
     * Stands in for {@code ThreadingDetector.checkAndLock} (redirected at its
     * one call site, {@code PalettedContainer.acquire}).
     */
    public static void checkAndLock(ThreadingDetector detector) {
        if (ENABLED) {
            detector.checkAndLock();
        }
    }

    /**
     * Stands in for {@code ThreadingDetector.checkAndUnlock} (redirected at its
     * one call site, {@code PalettedContainer.release}). Paired with
     * {@link #checkAndLock}, so with the guard off neither half runs and the
     * semaphore is never taken or released.
     */
    public static void checkAndUnlock(ThreadingDetector detector) {
        if (ENABLED) {
            detector.checkAndUnlock();
        }
    }

    private BrowserThreadingDetectorCompat() {
    }
}