package dev.mcweb.graal.webgpu;

import com.mojang.renderpearl.api.GpuFormat;
import com.mojang.renderpearl.api.buffers.GpuBuffer;
import com.mojang.renderpearl.api.commands.CommandEncoder;
import com.mojang.renderpearl.api.commands.GpuQueryPool;
import com.mojang.renderpearl.api.device.DeviceInfo;
import com.mojang.renderpearl.api.device.GpuDevice;
import com.mojang.renderpearl.api.device.GpuSurface;
import com.mojang.renderpearl.api.pipeline.BindGroupLayout;
import com.mojang.renderpearl.api.pipeline.CompiledRenderPipeline;
import com.mojang.renderpearl.api.pipeline.PolygonMode;
import com.mojang.renderpearl.api.pipeline.RenderPipeline;
import com.mojang.renderpearl.api.pipeline.ShaderSource;
import com.mojang.renderpearl.api.textures.AddressMode;
import com.mojang.renderpearl.api.textures.FilterMode;
import com.mojang.renderpearl.api.textures.GpuSampler;
import com.mojang.renderpearl.api.textures.GpuTexture;
import com.mojang.renderpearl.api.textures.GpuTextureView;
import com.mojang.renderpearl.frontend.FrontendCommandEncoder;
import com.mojang.renderpearl.frontend.FrontendGpuSurface;
import com.mojang.renderpearl.frontend.FrontendRenderPipeline;
import it.unimi.dsi.fastutil.objects.Object2IntOpenHashMap;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.OptionalDouble;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * The GpuDevice the game renders with. 26.3's own FrontendGpuDevice cannot be
 * built in the tab: its constructor creates the shaderc/SPIRV-Cross pipeline
 * compiler, an LWJGL upcall over native libraries a browser does not have.
 * This class stands in for it. Commands and surfaces still go through
 * Mojang's frontend classes, so render-pass and encoder validation stay
 * Mojang's; resources come straight from {@link WebGpuDeviceBackend}; and
 * pipelines are built from the game's GLSL, which the host translates to
 * WGSL as in 26.2.
 */
final class WebGpuDevice implements GpuDevice {
    private final WebGpuDeviceBackend backend;
    private final CommandEncoder encoder;

    WebGpuDevice(WebGpuDeviceBackend backend) {
        this.backend = backend;
        // No Tracy GPU zones in a browser; the frontend encoder takes a null profiler.
        this.encoder = new FrontendCommandEncoder(null, backend, backend.createCommandEncoder());
    }

    @Override
    public GpuSurface createSurface(long window, BooleanSupplier isIconified) {
        return new FrontendGpuSurface(backend.createSurface(window, isIconified));
    }

    @Override
    public CommandEncoder createCommandEncoder() {
        return encoder;
    }

    @Override
    public GpuSampler createSampler(
            AddressMode addressModeU,
            AddressMode addressModeV,
            FilterMode minFilter,
            FilterMode magFilter,
            int maxAnisotropy,
            OptionalDouble maxLod
    ) {
        return backend.createSampler(addressModeU, addressModeV, minFilter, magFilter, maxAnisotropy, maxLod);
    }

    @Override
    public GpuTexture createTexture(
            Supplier<String> label,
            int usage,
            GpuFormat format,
            int width,
            int height,
            int depthOrLayers,
            int mipLevels
    ) {
        return backend.createTexture(label.get(), usage, format, width, height, depthOrLayers, mipLevels);
    }

    @Override
    public GpuTexture createTexture(
            String label,
            int usage,
            GpuFormat format,
            int width,
            int height,
            int depthOrLayers,
            int mipLevels
    ) {
        return backend.createTexture(label, usage, format, width, height, depthOrLayers, mipLevels);
    }

    @Override
    public GpuTextureView createTextureView(GpuTexture texture) {
        return backend.createTextureView(texture, 0, texture.getMipLevels());
    }

    @Override
    public GpuTextureView createTextureView(GpuTexture texture, int baseMipLevel, int mipLevels) {
        return backend.createTextureView(texture, baseMipLevel, mipLevels);
    }

    @Override
    public GpuBuffer createBuffer(Supplier<String> label, int usage, long size) {
        return backend.createBuffer(label, usage, size);
    }

    @Override
    public GpuBuffer createBuffer(Supplier<String> label, int usage, ByteBuffer data) {
        return backend.createBuffer(label, usage, data);
    }

    @Override
    public List<String> getLastDebugMessages() {
        return backend.getLastDebugMessages();
    }

    @Override
    public boolean isDebuggingEnabled() {
        return backend.isDebuggingEnabled();
    }

    /**
     * All of the work happens in {@code finishCompile}, on the thread that
     * finishes the compile: the game executor for ShaderManager's reload, the
     * caller for PipelineCache. That keeps the host pipeline RPC on the
     * render thread, where 26.2 made it, and keeps PipelineCache's
     * render-thread join off the shared background pool, which may be busy
     * meshing sections. The Java half is string assembly; the host's
     * translation dominates either way.
     */
    @Override
    public CompletableFuture<CompiledRenderPipeline.Pending> compilePipeline(
            RenderPipeline pipeline,
            ShaderSource shaderSource,
            Executor executor
    ) {
        if (pipeline.getPolygonMode() == PolygonMode.WIREFRAME
                && !getDeviceInfo().features().wireframeFillMode()) {
            // WebGPU has no wireframe fill. Like Mojang's frontend, report no
            // pipeline; RenderSystem then reports wireframe as unavailable.
            return CompletableFuture.completedFuture(CompiledRenderPipeline.Pending.NULL);
        }
        return CompletableFuture.completedFuture(() -> finishCompile(pipeline, shaderSource));
    }

    /**
     * The frontend render pass binds by name through {@code uniformIndices}
     * and hands the backend the index; the backend pipeline maps it back to
     * the name the host protocol uses. Both come from the same flattened
     * bind-group list, so every declared binding has an index.
     */
    private CompiledRenderPipeline finishCompile(RenderPipeline pipeline, ShaderSource shaderSource) {
        List<BindGroupLayout.UniformDescription> uniforms =
                BindGroupLayout.flattenUniforms(pipeline.getBindGroupLayouts());
        WebGpuCompiledPipeline compiled = backend.createPipeline(pipeline, shaderSource, uniforms);
        Object2IntOpenHashMap<String> uniformIndices = new Object2IntOpenHashMap<>(uniforms.size());
        for (int i = 0; i < uniforms.size(); i++) {
            uniformIndices.putIfAbsent(uniforms.get(i).name(), i);
        }
        return new FrontendRenderPipeline(
                pipeline.getLocation().toString(),
                compiled,
                pipeline.getVertexFormatBindings(),
                uniformIndices,
                uniforms,
                pipeline.getColorTargetStates(),
                pipeline.wantsDepthTexture(),
                pipeline.pushConstantSize()
        );
    }

    @Override
    public void close() {
        backend.close();
    }

    @Override
    public GpuQueryPool createTimestampQueryPool(int size) {
        return backend.createTimestampQueryPool(size);
    }

    @Override
    public DeviceInfo getDeviceInfo() {
        return backend.getDeviceInfo();
    }
}
