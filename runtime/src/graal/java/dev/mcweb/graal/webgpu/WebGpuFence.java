package dev.mcweb.graal.webgpu;

import com.mojang.renderpearl.api.commands.GpuFence;

final class WebGpuFence implements GpuFence {
    @Override
    public void close() {
    }

    @Override
    public boolean awaitCompletion(long timeoutNanos) {
        return true;
    }
}
