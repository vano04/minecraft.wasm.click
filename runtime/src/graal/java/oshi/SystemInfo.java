package oshi;

import oshi.hardware.HardwareAbstractionLayer;
import oshi.software.os.OperatingSystem;

/**
 * Browser shadow for OSHI's native system-information entry point.
 *
 * <p>OSHI's stock {@code SystemInfo} initialiser calls JNA to select and load
 * platform bindings. The browser has no host ELF ABI, and returning invented
 * CPU/OS data would be worse than a visible unsupported result. Keep the
 * platform identity deterministic and make the two expensive/native branches
 * fail closed; Minecraft's system/crash report already treats these groups as
 * optional and records the failure.</p>
 */
public class SystemInfo {
    public SystemInfo() {
    }

    public static PlatformEnum getCurrentPlatform() {
        return PlatformEnum.UNKNOWN;
    }

    public OperatingSystem getOperatingSystem() {
        throw unavailable();
    }

    public HardwareAbstractionLayer getHardware() {
        throw unavailable();
    }

    private static UnsupportedOperationException unavailable() {
        return new UnsupportedOperationException(
                "OSHI native system inspection is unavailable on the WebAssembly runtime"
        );
    }
}
