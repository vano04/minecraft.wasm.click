package dev.mcweb.graal;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

/**
 * A trace of SectionRenderDispatcher's copy lock, for one fault.
 *
 * <p>The client's section compile tasks have died with an
 * IllegalMonitorStateException from {@code copyLock.unlock()} after a plain
 * {@code lock(); try { ... } finally { unlock(); }} (docs/STATUS.md,
 * 2026-10-11 night): the unlocking thread was not the lock's owner, which a
 * correct JVM never allows. When it was reported the lock was free, with no
 * waiters, so the frame pump's lock-state report alone cannot say whether
 * another thread took the lock while the compile task held it, or the task's
 * {@code lock()} returned without it.
 *
 * <p>Every {@code ReentrantLock.lock/unlock} on the copy lock in
 * SectionRenderDispatcher, its RenderSection and CompileTask is redirected
 * here (tools/wasmjvm-massage-plan.mjs) and does exactly that call, after
 * recording it in a small ring: which thread, whether the lock then names it
 * as owner, the hold count. An unlock by a thread the lock does not name is
 * recorded with the lock's own description (its owner) before the call
 * throws as before; {@link #describe} hands the ring to the frame pump's
 * failure report, since a report from a worker thread does not reach the
 * page. {@code -Dmcweb.copyLockTrace=false} (the page's
 * {@code ?copyLockTrace=0}) leaves only the calls.
 */
public final class BrowserCopyLockTrace {

    private static final boolean ON = !"false".equals(System.getProperty("mcweb.copyLockTrace", "true"));
    private static final int SIZE = 64;

    private static final AtomicInteger next = new AtomicInteger();
    private static final Thread[] threads = new Thread[SIZE];
    private static final long[] nanos = new long[SIZE];
    /** 'L' lock, 'U' unlock, '!' an unlock by a thread the lock does not name. */
    private static final char[] ops = new char[SIZE];
    private static final boolean[] heldAfter = new boolean[SIZE];
    private static final int[] holds = new int[SIZE];
    private static volatile String fault;

    private BrowserCopyLockTrace() {
    }

    public static void lock(ReentrantLock lock) {
        lock.lock();
        if (ON) {
            record('L', lock);
        }
    }

    public static void unlock(ReentrantLock lock) {
        if (ON) {
            if (!lock.isHeldByCurrentThread()) {
                record('!', lock);
                if (fault == null) {
                    Thread self = Thread.currentThread();
                    fault = "unlock by " + self.getName() + " id=" + self.threadId()
                            + " ih=" + Integer.toHexString(System.identityHashCode(self))
                            + " lock=" + lock + " holds=" + lock.getHoldCount()
                            + " queued=" + lock.getQueueLength() + " ring=" + ring();
                }
            } else {
                record('U', lock);
            }
        }
        lock.unlock();
    }

    private static void record(char op, ReentrantLock lock) {
        int i = Math.floorMod(next.getAndIncrement(), SIZE);
        threads[i] = Thread.currentThread();
        nanos[i] = System.nanoTime();
        ops[i] = op;
        heldAfter[i] = lock.isHeldByCurrentThread();
        holds[i] = lock.getHoldCount();
    }

    /** The ring, oldest first: op thread(ih) held/holds +microseconds from the first. */
    private static String ring() {
        int end = next.get();
        StringBuilder out = new StringBuilder("[");
        long first = 0;
        for (int k = Math.max(0, end - SIZE); k < end; k++) {
            int i = Math.floorMod(k, SIZE);
            Thread t = threads[i];
            if (t == null) {
                continue;
            }
            if (first == 0) {
                first = nanos[i];
            }
            out.append(ops[i]).append(' ').append(t.getName())
                    .append('(').append(Integer.toHexString(System.identityHashCode(t))).append(')')
                    .append(heldAfter[i] ? " held/" : " free/").append(holds[i])
                    .append(" +").append((nanos[i] - first) / 1000).append("us; ");
        }
        return out.append(']').toString();
    }

    /** The first fault seen, or "" (for the frame pump's lock-state report). */
    public static String describe() {
        String f = fault;
        return f == null ? (ON ? " copyLockTrace=no-fault-seen" : " copyLockTrace=off") : " copyLockTrace=" + f;
    }
}
