package dev.mcweb.graal.webgpu;

import com.mojang.renderpearl.api.textures.AddressMode;
import com.mojang.renderpearl.api.textures.FilterMode;
import com.mojang.renderpearl.api.textures.GpuSampler;
import java.util.OptionalDouble;

final class WebGpuSampler implements GpuSampler {
    private final AddressMode addressModeU;
    private final AddressMode addressModeV;
    private final FilterMode minFilter;
    private final FilterMode magFilter;
    private final int maxAnisotropy;
    private final OptionalDouble maxLod;
    private final int handle;
    private boolean closed;

    WebGpuSampler(
            AddressMode addressModeU,
            AddressMode addressModeV,
            FilterMode minFilter,
            FilterMode magFilter,
            int maxAnisotropy,
            OptionalDouble maxLod
    ) {
        this.addressModeU = addressModeU;
        this.addressModeV = addressModeV;
        this.minFilter = minFilter;
        this.magFilter = magFilter;
        this.maxAnisotropy = maxAnisotropy;
        this.maxLod = maxLod;
        StringBuilder spec = new StringBuilder("{");
        spec.append("\"addressU\":\"").append(addressModeU.name()).append("\",");
        spec.append("\"addressV\":\"").append(addressModeV.name()).append("\",");
        spec.append("\"min\":\"").append(minFilter.name()).append("\",");
        spec.append("\"mag\":\"").append(magFilter.name()).append("\",");
        spec.append("\"anisotropy\":").append(maxAnisotropy).append(",");
        spec.append("\"maxLod\":").append(maxLod.isPresent() ? Double.toString(maxLod.getAsDouble()) : "null");
        spec.append("}");
        this.handle = BrowserGpu.createSamplerJson(spec.toString());
    }

    int handle() {
        return handle;
    }

    @Override
    public AddressMode getAddressModeU() {
        return addressModeU;
    }

    @Override
    public AddressMode getAddressModeV() {
        return addressModeV;
    }

    @Override
    public FilterMode getMinFilter() {
        return minFilter;
    }

    @Override
    public FilterMode getMagFilter() {
        return magFilter;
    }

    @Override
    public int getMaxAnisotropy() {
        return maxAnisotropy;
    }

    @Override
    public OptionalDouble getMaxLod() {
        return maxLod;
    }

    @Override
    public boolean isClosed() {
        return closed;
    }

    @Override
    public void close() {
        if (!closed) {
            BrowserGpu.destroyObject(handle);
            closed = true;
        }
    }
}
