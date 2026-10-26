package dev.mcweb.graal;

/**
 * Browser policy for libraries whose normal implementation extracts a native
 * shared object from a dependency JAR.
 *
 * <p>The OpenJDK wasm runtime still needs Emscripten's generic Wasm side-module
 * loader for its own {@code libjava.so}, {@code libjvm.so}, and the MC-Web
 * bridge.  This policy is deliberately scoped to JNA's loader properties: an
 * ELF {@code libjnidispatch.so} is not a Wasm side module and must never be
 * handed to that generic loader. OSHI is separately shadowed by
 * {@code oshi.SystemInfo} so its normal hardware probes fail closed without
 * initialising JNA.</p>
 */
public final class BrowserNativePolicy {
    private BrowserNativePolicy() {
    }

    /** Install before any JNA or OSHI class can be initialised. */
    public static void install() {
        // Do not search host/system paths: the browser has no compatible native
        // ABI, and a path supplied by an input JAR must not escape this policy.
        System.setProperty("jna.nosys", "true");
        System.setProperty("jna.boot.library.path", "");
        // Do not extract com/sun/jna/<platform>/libjnidispatch.* from a JAR.
        // Together with jna.nosys this makes an accidental JNA use fail as a
        // normal UnsatisfiedLinkError at the API boundary, not in Emscripten's
        // Wasm parser after an ELF has been copied to a temporary file.
        System.setProperty("jna.noclasspath", "true");
        System.setProperty("jna.nounpack", "true");
    }
}
