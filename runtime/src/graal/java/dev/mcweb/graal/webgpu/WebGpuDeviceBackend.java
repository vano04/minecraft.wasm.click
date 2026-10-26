package dev.mcweb.graal.webgpu;

import com.mojang.renderpearl.api.GpuFormat;
import com.mojang.renderpearl.api.pipeline.PrimitiveTopology;
import com.mojang.renderpearl.api.buffers.GpuBuffer;
import com.mojang.renderpearl.api.pipeline.BindGroupLayout;
import com.mojang.renderpearl.api.pipeline.BlendEquation;
import com.mojang.renderpearl.api.pipeline.BlendFunction;
import com.mojang.renderpearl.api.pipeline.ColorTargetState;
import com.mojang.renderpearl.api.pipeline.DepthStencilState;
import com.mojang.renderpearl.api.pipeline.RenderPipeline;
import com.mojang.renderpearl.api.pipeline.PolygonMode;
import com.mojang.renderpearl.api.pipeline.ShaderSource;
import com.mojang.renderpearl.api.pipeline.ShaderType;
import com.mojang.renderpearl.api.pipeline.UniformType;
import net.minecraft.client.renderer.ShaderDefines;
import net.minecraft.resources.Identifier;
import com.mojang.renderpearl.backend.api.BackendRenderPipeline;
import com.mojang.renderpearl.backend.api.CommandEncoderBackend;
import com.mojang.renderpearl.api.device.DeviceFeatures;
import com.mojang.renderpearl.api.device.DeviceInfo;
import com.mojang.renderpearl.api.device.DeviceLimits;
import com.mojang.renderpearl.api.device.DeviceType;
import com.mojang.renderpearl.backend.api.GpuDeviceBackend;
import com.mojang.renderpearl.api.commands.GpuQueryPool;
import com.mojang.renderpearl.backend.api.GpuSurfaceBackend;
import com.mojang.renderpearl.api.device.HintsAndWorkarounds;
import com.mojang.renderpearl.api.vertex.VertexFormat;
import com.mojang.renderpearl.api.vertex.VertexFormatElement;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalDouble;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.lwjgl.system.MemoryUtil;
import org.lwjgl.util.shaderc.ShadercIncludeResult;

public final class WebGpuDeviceBackend implements GpuDeviceBackend {
    // DIAG one-shot dedupe sets for the atlas-upload trace. Remove with the trace.
    static final Set<String> diagCopyTexLabels = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    static final Set<String> diagWriteTexLabels = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    /** Nested #include depth past which the source is taken to include itself. */
    private static final int MAX_INCLUDE_DEPTH = 32;

    private final DeviceInfo deviceInfo;
    private final WebGpuCommandEncoderBackend commandEncoder =
            new WebGpuCommandEncoderBackend(this);
    private final WebGpuTransientMemory transientMemory = new WebGpuTransientMemory();

    /**
     * The macros 26.3's shader compiler defines for the device it compiles
     * for. The shaders branch on them (the OIT depth maths on
     * RENDERPEARL_DEPTH_IS_ZERO_TO_ONE), so they follow this device's info.
     */
    private final String backendDirectives;

    public WebGpuDeviceBackend() {
        if (!BrowserGpu.isReady()) {
            throw new IllegalStateException("The browser WebGPU device is not initialized");
        }
        deviceInfo = new DeviceInfo(
                BrowserGpu.adapterName(),
                "browser",
                "WebGPU",
                true,
                "WebGPU",
                1.0F,
                // maxDrawIndirectDrawCount 0: core WebGPU has no multi-draw
                // indirect, and LevelRenderer only takes the indirect terrain
                // path (MULTIDRAW_TERRAIN pipelines) when this is positive.
                new DeviceLimits(16, 256, 8192, 1L << 30, 512, 8, 0),
                // Core WebGPU: no wireframe fill, no shader draw parameters,
                // no multi-draw; drawIndirect + nonZeroFirstInstance are
                // supported; persistent mapping stays off (browser maps are
                // asynchronous).
                new DeviceFeatures(false, false, false, false, false, true, true, false),
                Set.of("browser-webgpu"),
                new HintsAndWorkarounds(false, false, false, false),
                DeviceType.OTHER
        );
        StringBuilder directives = new StringBuilder();
        if (deviceInfo.isZZeroToOne()) {
            directives.append("#define RENDERPEARL_DEPTH_IS_ZERO_TO_ONE\n");
        }
        if (deviceInfo.hintsAndWorkarounds().isExplicitDepthRequired()) {
            directives.append("#define RENDERPEARL_EXPLICIT_DEPTH_INVARIANCE\n");
        }
        if (deviceInfo.features().shaderDrawParameters()) {
            directives.append("#define RENDERPEARL_INSTANCE_INDEX_INCLUDES_BASE_INSTANCE\n");
        }
        backendDirectives = directives.toString();
    }

    WebGpuTransientMemory webTransientMemory() {
        return transientMemory;
    }

    @Override
    public GpuSurfaceBackend createSurface(long window, BooleanSupplier isIconified) {
        return new WebGpuSurfaceBackend();
    }

    @Override
    public CommandEncoderBackend createCommandEncoder() {
        // Mojang's native backends expose one persistent encoder backend.
        // Sharing it preserves commands recorded by temporary facade objects
        // that intentionally do not submit on their own.
        return commandEncoder;
    }

    @Override
    public com.mojang.renderpearl.api.textures.GpuSampler createSampler(
            com.mojang.renderpearl.api.textures.AddressMode addressModeU,
            com.mojang.renderpearl.api.textures.AddressMode addressModeV,
            com.mojang.renderpearl.api.textures.FilterMode minFilter,
            com.mojang.renderpearl.api.textures.FilterMode magFilter,
            int maxAnisotropy,
            OptionalDouble maxLod
    ) {
        return new WebGpuSampler(
                addressModeU,
                addressModeV,
                minFilter,
                magFilter,
                maxAnisotropy,
                maxLod
        );
    }

    @Override
    public com.mojang.renderpearl.api.textures.GpuTexture createTexture(
            String label,
            int usage,
            GpuFormat format,
            int width,
            int height,
            int depthOrLayers,
            int mipLevels
    ) {
        return new WebGpuTexture(
                usage,
                label,
                format,
                width,
                height,
                depthOrLayers,
                mipLevels
        );
    }

    @Override
    public com.mojang.renderpearl.api.textures.GpuTextureView createTextureView(
            com.mojang.renderpearl.api.textures.GpuTexture texture,
            int baseMipLevel,
            int mipLevels
    ) {
        return new WebGpuTextureView(texture, baseMipLevel, mipLevels);
    }

    @Override
    public GpuBuffer createBuffer(Supplier<String> label, int usage, long size) {
        return new WebGpuBuffer(label.get(), usage, size);
    }

    @Override
    public GpuBuffer createBuffer(Supplier<String> label, int usage, ByteBuffer data) {
        return new WebGpuBuffer(label.get(), usage, data);
    }

    @Override
    public List<String> getLastDebugMessages() {
        return List.of();
    }

    @Override
    public boolean isDebuggingEnabled() {
        return false;
    }

    /**
     * Mojang's frontend calls this with SPIR-V from shaderc, which the tab
     * does not have. WebGpuDevice replaces that frontend and builds pipelines
     * from GLSL through {@link #createPipeline} instead, so nothing reaches
     * this.
     */
    @Override
    public BackendRenderPipeline.Pending compilePipeline(BackendRenderPipeline.CreateInfo createInfo) {
        throw new UnsupportedOperationException("The WebGPU backend compiles pipelines from GLSL, not SPIR-V");
    }

    /**
     * Creates the host pipeline for one RenderPipeline. {@code uniforms} is
     * the pipeline's flattened bind-group order, the index space of the
     * frontend's setUniform calls. A host pipeline always comes back: the
     * host draws a pipeline whose shaders fail with its error shader, and a
     * spec that cannot even be built falls back to a structural one, because
     * ShaderManager treats a missing required pipeline as a fatal reload
     * failure.
     */
    WebGpuCompiledPipeline createPipeline(
            RenderPipeline pipeline,
            ShaderSource shaderSource,
            List<BindGroupLayout.UniformDescription> uniforms
    ) {
        String[] uniformNames = new String[uniforms.size()];
        for (int i = 0; i < uniformNames.length; i++) {
            uniformNames[i] = uniforms.get(i).name();
        }
        try {
            Map<ShaderType, Identifier> shaders = pipeline.getShaders();
            Identifier vertexShaderId = shaders.get(ShaderType.VERTEX);
            Identifier fragmentShaderId = shaders.get(ShaderType.FRAGMENT);
            String vertexShader = vertexShaderId != null
                    ? vertexShaderId.toString() : "minecraft:core/screenquad";
            String fragmentShader = fragmentShaderId != null ? fragmentShaderId.toString() : "";

            StringBuilder spec = new StringBuilder(512);
            spec.append("{");
            spec.append("\"label\":").append(jsonString(
                    pipeline.getLocation() != null ? pipeline.getLocation().toString() : "unknown")).append(",");
            spec.append("\"vertexShader\":").append(jsonString(vertexShader)).append(",");
            spec.append("\"fragmentShader\":").append(jsonString(fragmentShader)).append(",");

            spec.append("\"defines\":[");
            boolean first = true;
            ShaderDefines defines = pipeline.getShaderDefines();
            Iterable<String> flags = defines != null ? defines.flags() : null;
            if (flags != null) {
                for (String flag : flags) {
                    if (!first) {
                        spec.append(",");
                    }
                    spec.append(jsonString(flag));
                    first = false;
                }
            }
            Map<String, String> defineValues = defines != null ? defines.values() : null;
            if (defineValues != null) {
                for (Map.Entry<String, String> value : defineValues.entrySet()) {
                    if (!first) {
                        spec.append(",");
                    }
                    spec.append(jsonString(value.getKey() + "=" + value.getValue()));
                    first = false;
                }
            }
            spec.append("],");

            PrimitiveTopology topology = pipeline.getPrimitiveTopology();
            spec.append("\"topology\":").append(jsonString(topology != null ? topology.name() : "TRIANGLES")).append(",");
            spec.append("\"cull\":").append(pipeline.isCull()).append(",");
            PolygonMode polygonMode = pipeline.getPolygonMode();
            spec.append("\"polygonMode\":").append(jsonString(polygonMode != null ? polygonMode.name() : "FILL")).append(",");

            // The host reads the array index as the vertex buffer slot. 26.3
            // pads the bindings with nulls up to the maximum slot count; the
            // trailing ones are dropped, and a gap stays a null so the slots
            // after it keep their numbers.
            spec.append("\"vertexFormats\":[");
            List<VertexFormat> bindings = pipeline.getVertexFormatBindings();
            int slotCount = bindings.size();
            while (slotCount > 0 && bindings.get(slotCount - 1) == null) {
                slotCount--;
            }
            for (int i = 0; i < slotCount; i++) {
                if (i > 0) {
                    spec.append(",");
                }
                VertexFormat format = bindings.get(i);
                if (format == null) {
                    spec.append("null");
                    continue;
                }
                spec.append("{\"stride\":").append(format.getVertexSize());
                spec.append(",\"stepRate\":").append(format.getStepRate());
                spec.append(",\"elements\":[");
                boolean firstElement = true;
                for (VertexFormatElement element : format.getElements()) {
                    if (element == null || element.format() == null) {
                        continue;
                    }
                    if (!firstElement) {
                        spec.append(",");
                    }
                    spec.append("{\"name\":").append(jsonString(element.name()));
                    spec.append(",\"offset\":").append(element.offset());
                    spec.append(",\"format\":").append(jsonString(element.format().name()));
                    spec.append("}");
                    firstElement = false;
                }
                spec.append("]}");
            }
            spec.append("],");

            spec.append("\"colorTargets\":[");
            List<ColorTargetState> targets = pipeline.getColorTargetStates();
            for (int i = 0; i < targets.size(); i++) {
                if (i > 0) {
                    spec.append(",");
                }
                ColorTargetState target = targets.get(i);
                if (target == null || target.format() == null) {
                    spec.append("null");
                    continue;
                }
                spec.append("{\"format\":").append(jsonString(target.format().name()));
                spec.append(",\"writeMask\":").append(target.writeMask());
                Optional<BlendFunction> blendFunction = target.blendFunction();
                if (blendFunction != null && blendFunction.isPresent()) {
                    BlendFunction blend = blendFunction.get();
                    BlendEquation color = blend.color();
                    BlendEquation alpha = blend.alpha();
                    if (color != null && alpha != null) {
                        spec.append(",\"blend\":{\"colorSrc\":").append(jsonString(color.sourceFactor().name()));
                        spec.append(",\"colorDst\":").append(jsonString(color.destFactor().name()));
                        spec.append(",\"colorOp\":").append(jsonString(color.op().name()));
                        spec.append(",\"alphaSrc\":").append(jsonString(alpha.sourceFactor().name()));
                        spec.append(",\"alphaDst\":").append(jsonString(alpha.destFactor().name()));
                        spec.append(",\"alphaOp\":").append(jsonString(alpha.op().name()));
                        spec.append("}");
                    }
                }
                spec.append("}");
            }
            spec.append("],");

            DepthStencilState depthStencil = pipeline.getDepthStencilState();
            if (depthStencil != null && depthStencil.depthTest() != null) {
                spec.append("\"depthStencil\":{");
                spec.append("\"depthTest\":").append(jsonString(depthStencil.depthTest().name()));
                spec.append(",\"writeDepth\":").append(depthStencil.writeDepth());
                spec.append(",\"biasScale\":").append(depthStencil.depthBiasScaleFactor());
                spec.append(",\"biasConstant\":").append(depthStencil.depthBiasConstant());
                spec.append("},");
            } else {
                spec.append("\"depthStencil\":null,");
            }

            appendBindGroups(spec, pipeline);
            appendShaderText(spec, shaderSource, vertexShaderId, ShaderType.VERTEX, pipeline);
            appendShaderText(spec, shaderSource, fragmentShaderId, ShaderType.FRAGMENT, pipeline);

            spec.append("}");
            return new WebGpuCompiledPipeline(BrowserGpu.createPipeline(spec.toString()), uniformNames);
        } catch (RuntimeException failure) {
            // Build a structural fallback spec from the pipeline's own
            // bind-group layouts (the only thing that must match at bind
            // time) and let the host compile a generic shader against it.
            // The deep failure that got us here is in some accessor the
            // blanked wasm stack won't name; the fallback sidesteps all of it.
            try {
                StringBuilder fallback = new StringBuilder(256);
                fallback.append("{\"label\":").append(jsonString(
                        pipeline.getLocation() != null ? pipeline.getLocation().toString() : "fallback")).append(",");
                fallback.append("\"vertexShader\":\"minecraft:core/screenquad\",");
                fallback.append("\"fragmentShader\":\"\",");
                fallback.append("\"defines\":[],\"topology\":\"TRIANGLES\",\"cull\":false,\"polygonMode\":\"FILL\",");
                fallback.append("\"vertexFormats\":[],\"colorTargets\":[],\"depthStencil\":null,");
                appendBindGroups(fallback, pipeline);
                fallback.append("}");
                int handle = BrowserGpu.createPipeline(fallback.toString());
                BrowserGpu.reportProgress(
                        "pipeline-fallback:" + pipeline.getLocation() + ":" + failure.getClass().getSimpleName()
                                + (handle == 0 ? ":HOST_REJECTED" : ":ok")
                );
                return new WebGpuCompiledPipeline(handle, uniformNames);
            } catch (RuntimeException fallbackFailure) {
                BrowserGpu.reportProgress(
                        "pipeline-failed:" + pipeline.getLocation() + ":" + failure.getClass().getSimpleName()
                                + "/fallback:" + fallbackFailure.getClass().getSimpleName()
                );
                return new WebGpuCompiledPipeline(0, uniformNames);
            }
        }
    }

    /**
     * 26.3 lists a group's samplers among its uniforms, as
     * COMBINED_IMAGE_SAMPLER entries in binding order. The host spec keeps
     * 26.2's shape, uniforms then samplers per group, so its layout and
     * binding remap stay as they are; names, not indices, cross the bridge.
     */
    private void appendBindGroups(StringBuilder spec, RenderPipeline pipeline) {
        spec.append("\"bindGroups\":[");
        List<BindGroupLayout> layouts = pipeline.getBindGroupLayouts();
        for (int i = 0; i < layouts.size(); i++) {
            if (i > 0) {
                spec.append(",");
            }
            BindGroupLayout layout = layouts.get(i);
            List<BindGroupLayout.UniformDescription> entries =
                    layout != null ? layout.uniforms() : List.of();
            spec.append("{\"uniforms\":[");
            boolean firstUniform = true;
            for (BindGroupLayout.UniformDescription uniform : entries) {
                if (uniform == null || uniform.name() == null || uniform.type() == null
                        || uniform.type() == UniformType.COMBINED_IMAGE_SAMPLER) {
                    continue;
                }
                if (!firstUniform) {
                    spec.append(",");
                }
                spec.append("{\"name\":").append(jsonString(uniform.name()));
                spec.append(",\"type\":").append(jsonString(uniform.type().name()));
                if (uniform.gpuFormat() != null) {
                    spec.append(",\"format\":").append(jsonString(uniform.gpuFormat().name()));
                }
                spec.append("}");
                firstUniform = false;
            }
            spec.append("],\"samplers\":[");
            boolean firstSampler = true;
            for (BindGroupLayout.UniformDescription uniform : entries) {
                if (uniform == null || uniform.name() == null
                        || uniform.type() != UniformType.COMBINED_IMAGE_SAMPLER) {
                    continue;
                }
                if (!firstSampler) {
                    spec.append(",");
                }
                spec.append(jsonString(uniform.name()));
                firstSampler = false;
            }
            spec.append("]}");
        }
        spec.append("]");
    }

    static String jsonString(String value) {
        StringBuilder result = new StringBuilder(value.length() + 2);
        result.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> result.append("\\\"");
                case '\\' -> result.append("\\\\");
                case '\n' -> result.append("\\n");
                case '\r' -> result.append("\\r");
                case '\t' -> result.append("\\t");
                default -> {
                    if (c < 0x20) {
                        result.append(String.format("\\u%04x", (int) c));
                    } else {
                        result.append(c);
                    }
                }
            }
        }
        result.append('"');
        return result.toString();
    }

    /**
     * Appends one stage's GLSL as the host translator takes it (it becomes
     * WGSL in the GPU worker, docs/SHADERS.md): the stage text from the
     * player's jar, never leaving the tab. 26.3 hands the raw text to shaderc
     * with the defines as compiler macros and shaderc resolving #include, so
     * the port does both here. Omitted when there is no text; the host then
     * draws the pipeline with its error shader.
     */
    private void appendShaderText(StringBuilder spec, ShaderSource source,
            Identifier id, ShaderType type, RenderPipeline pipeline) {
        if (source == null || id == null) {
            return;
        }
        String text = source.getShader(id, type);
        if (text == null) {
            return;
        }
        ShaderDefines defines = pipeline.getShaderDefines();
        String directives = backendDirectives + (defines != null ? defines.asSourceDirectives() : "");
        StringBuilder glsl = new StringBuilder(text.length() * 2);
        appendExpanded(glsl, injectAfterHeader(text, directives), source, 0);
        spec.append(type == ShaderType.VERTEX ? ",\"vertexSource\":" : ",\"fragmentSource\":")
                .append(jsonString(glsl.toString()));
    }

    /**
     * Inserts {@code directives} after the #version line and the #extension
     * lines that follow it, the first place a #define may go and still be
     * seen by every line of the stage, includes included.
     */
    private static String injectAfterHeader(String text, String directives) {
        if (directives.isEmpty()) {
            return text;
        }
        int insertAt = 0;
        boolean seenVersion = false;
        int lineStart = 0;
        while (lineStart < text.length()) {
            int lineEnd = text.indexOf('\n', lineStart);
            int next = lineEnd < 0 ? text.length() : lineEnd + 1;
            String line = text.substring(lineStart, lineEnd < 0 ? text.length() : lineEnd).trim();
            if (line.startsWith("#version")) {
                seenVersion = true;
                insertAt = next;
            } else if (seenVersion && line.startsWith("#extension")) {
                insertAt = next;
            } else if (!line.isEmpty() && !line.startsWith("//")) {
                break;
            }
            lineStart = next;
        }
        String separator = insertAt > 0 && text.charAt(insertAt - 1) != '\n' ? "\n" : "";
        return text.substring(0, insertAt) + separator + directives + text.substring(insertAt);
    }

    /**
     * Copies {@code text} with each {@code #include <namespace:path>} line
     * replaced by that include, recursively. Expansion is purely textual:
     * 26.3's include files carry their own #ifndef guards.
     */
    private static void appendExpanded(StringBuilder out, String text, ShaderSource source, int depth) {
        if (depth > MAX_INCLUDE_DEPTH) {
            throw new IllegalStateException("Shader includes nest deeper than " + MAX_INCLUDE_DEPTH);
        }
        int lineStart = 0;
        while (lineStart < text.length()) {
            int lineEnd = text.indexOf('\n', lineStart);
            int next = lineEnd < 0 ? text.length() : lineEnd + 1;
            String include = includeName(text.substring(lineStart, lineEnd < 0 ? text.length() : lineEnd));
            if (include == null) {
                out.append(text, lineStart, next);
            } else {
                appendExpanded(out, includeText(source, include), source, depth + 1);
                if (out.length() > 0 && out.charAt(out.length() - 1) != '\n') {
                    out.append('\n');
                }
            }
            lineStart = next;
        }
    }

    /** The name an #include line names, without its delimiters, or null for any other line. */
    private static String includeName(String line) {
        String trimmed = line.trim();
        if (!trimmed.startsWith("#")) {
            return null;
        }
        String directive = trimmed.substring(1).trim();
        if (!directive.startsWith("include")) {
            return null;
        }
        String rest = directive.substring("include".length()).trim();
        if (rest.length() < 2) {
            return null;
        }
        char open = rest.charAt(0);
        char close = open == '<' ? '>' : open == '"' ? '"' : 0;
        int end = close != 0 ? rest.indexOf(close, 1) : -1;
        return end > 1 ? rest.substring(1, end) : null;
    }

    /**
     * An include's text. ShaderManager keeps it only as the native shaderc
     * include result it prepares for the compiler (UTF-8 with a length and no
     * terminator, so LWJGL's NUL-terminated contentString does not apply);
     * reading those bytes back needs no shaderc native.
     */
    private static String includeText(ShaderSource source, String name) {
        Identifier id = Identifier.tryParse(name);
        ShaderSource.CachedIncludeSource include = id != null ? source.getInclude(id) : null;
        if (include == null) {
            throw new IllegalStateException("Unknown shader include <" + name + ">");
        }
        long result = include.includeResultPtr();
        long length = ShadercIncludeResult.ncontent_length(result);
        if (length == 0) {
            return "";
        }
        return MemoryUtil.memUTF8(MemoryUtil.memGetAddress(result + ShadercIncludeResult.CONTENT), (int) length);
    }

    @Override
    public void close() {
        transientMemory.close();
    }

    @Override
    public GpuQueryPool createTimestampQueryPool(int size) {
        return new WebGpuQueryPool(size);
    }

    /** Timestamps are written from System.nanoTime, already the CPU clock. */
    @Override
    public long getTimestampCalibrationOffset() {
        return 0L;
    }

    @Override
    public DeviceInfo getDeviceInfo() {
        return deviceInfo;
    }
}
