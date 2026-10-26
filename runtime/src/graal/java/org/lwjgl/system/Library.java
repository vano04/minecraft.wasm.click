package org.lwjgl.system;

import java.nio.ByteBuffer;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Browser substitution for LWJGL's native-library loader. Minecraft's constructor
 * path touches MemoryUtil/SDL types that would otherwise call
 * {@code System.loadLibrary("lwjgl")}; the browser has no native LWJGL libraries.
 * Function addresses remain zero: only managed NIO and browser shims are used.
 * An un-shimmed binding therefore fails in its {@code Functions} holder's static
 * initializer ("A required function is missing", as ExceptionInInitializerError,
 * then NoClassDefFoundError), before LWJGL 3.4.3's FFM-based JNI is reached.
 */
public final class Library {
    public static final String JNI_LIBRARY_NAME = "lwjgl";

    private Library() {
    }

    public static void initialize() {
        // No JNI library is extracted or loaded in the browser image.
    }

    public static void loadSystem(String module, String name) {
    }

    public static void loadSystem(
            Consumer<String> load,
            Consumer<String> loadLibrary,
            Class<?> context,
            String module,
            String name
    ) {
    }

    public static SharedLibrary loadNative(String module, String name) {
        return new NoopSharedLibrary(name);
    }

    public static SharedLibrary loadNative(Class<?> context, String module, String name) {
        return new NoopSharedLibrary(name);
    }

    public static SharedLibrary loadNative(
            Class<?> context,
            String module,
            String name,
            boolean bundledWithLWJGL
    ) {
        return new NoopSharedLibrary(name);
    }

    public static SharedLibrary loadNative(
            Class<?> context,
            String module,
            Configuration<String> libraryName,
            String... defaultNames
    ) {
        String name = defaultNames != null && defaultNames.length > 0
                ? defaultNames[0]
                : module;
        return new NoopSharedLibrary(name);
    }

    public static SharedLibrary loadNative(
            Class<?> context,
            String module,
            Configuration<String> libraryName,
            Supplier<SharedLibrary> fallback,
            String... defaultNames
    ) {
        return loadNative(context, module, libraryName, defaultNames);
    }

    private static final class NoopSharedLibrary implements SharedLibrary {
        private final String name;

        private NoopSharedLibrary(String name) {
            this.name = name == null ? "lwjgl" : name;
        }

        @Override
        public String getName() {
            return name;
        }

        @Override
        public String getPath() {
            return null;
        }

        @Override
        public long getFunctionAddress(ByteBuffer functionName) {
            return 0L;
        }

        @Override
        public void free() {
        }

        @Override
        public long address() {
            return 0L;
        }
    }
}
