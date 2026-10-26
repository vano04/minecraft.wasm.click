package org.lwjgl.system;

import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.nio.Buffer;
import java.util.HashMap;

/** Weak identity keys: a buffer's position and contents must not affect its address. */
final class BrowserBufferAddresses {
    private final ReferenceQueue<Buffer> collected = new ReferenceQueue<>();
    private final HashMap<Object, Long> addresses = new HashMap<>();
    private final Lookup lookup = new Lookup();

    private static final class Key extends WeakReference<Buffer> {
        private final int hash;

        Key(Buffer buffer, int hash, ReferenceQueue<Buffer> queue) {
            super(buffer, queue);
            this.hash = hash;
        }

        @Override public int hashCode() { return hash; }

        @Override public boolean equals(Object other) {
            if (this == other) return true;
            Buffer buffer = get();
            return buffer != null && (other instanceof Key key && buffer == key.get()
                    || other instanceof Lookup lookup && buffer == lookup.buffer);
        }
    }

    private static final class Lookup {
        Buffer buffer;
        int hash;

        @Override public int hashCode() { return hash; }

        @Override public boolean equals(Object other) {
            return buffer != null && other instanceof Key key && buffer == key.get();
        }
    }

    synchronized void put(Buffer buffer, long address) {
        drain();
        lookup.buffer = buffer;
        lookup.hash = System.identityHashCode(buffer);
        try {
            addresses.put(new Key(buffer, lookup.hash, collected), address);
        } finally {
            lookup.buffer = null;
        }
    }

    synchronized Long get(Buffer buffer) {
        drain();
        lookup.buffer = buffer;
        lookup.hash = System.identityHashCode(buffer);
        try {
            return addresses.get(lookup);
        } finally {
            // The reusable lookup keeps the argument alive during access, never between calls.
            lookup.buffer = null;
        }
    }

    private void drain() {
        // Spread bookkeeping cleanup across calls after a large GC.
        for (int i = 0; i < 32; i++) {
            Key key = (Key) collected.poll();
            if (key == null) return;
            addresses.remove(key);
        }
    }
}
