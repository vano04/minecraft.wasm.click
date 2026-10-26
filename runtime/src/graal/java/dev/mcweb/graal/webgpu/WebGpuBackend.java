package dev.mcweb.graal.webgpu;

import com.mojang.renderpearl.api.device.BackendCreationException;
import com.mojang.renderpearl.api.device.GpuBackend;
import com.mojang.renderpearl.api.device.GpuDebugOptions;
import com.mojang.renderpearl.api.device.GpuDevice;
import dev.mcweb.graal.BrowserWindowCompat;

/** Browser implementation of Minecraft 26.3's GpuBackend seam. */
public final class WebGpuBackend implements GpuBackend {
    /**
     * The redirect target for {@code PreferredGraphicsApi.getBackendsToTry()}
     * in {@code Minecraft}'s constructor: whatever API the options name, the
     * browser has exactly one backend.
     */
    public static GpuBackend[] backendsToTry(net.minecraft.client.PreferredGraphicsApi preferred) {
        return new GpuBackend[] {new WebGpuBackend()};
    }

    @Override
    public String getName() {
        return "WebGPU";
    }

    @Override
    public void loadLibrary() throws BackendCreationException {
        // The host acquires the adapter and device before Java starts.
    }

    @Override
    public void unloadLibrary() {
    }

    @Override
    public long createWindow(String title, int width, int height, long flags) {
        // The canvas already exists and is sized by the page.
        return BrowserWindowCompat.CANVAS_WINDOW;
    }

    @Override
    public GpuDevice createDevice(GpuDebugOptions debugOptions) throws BackendCreationException {
        return new WebGpuDevice(new WebGpuDeviceBackend());
    }
}
