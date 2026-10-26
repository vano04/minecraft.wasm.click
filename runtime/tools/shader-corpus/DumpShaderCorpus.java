import com.mojang.renderpearl.api.pipeline.BindGroupLayout;
import com.mojang.renderpearl.api.pipeline.BlendEquation;
import com.mojang.renderpearl.api.pipeline.ColorTargetState;
import com.mojang.renderpearl.api.pipeline.CompiledRenderPipeline;
import com.mojang.renderpearl.api.pipeline.DepthStencilState;
import com.mojang.renderpearl.api.pipeline.RenderPipeline;
import com.mojang.renderpearl.api.pipeline.ShaderType;
import com.mojang.renderpearl.api.pipeline.UniformType;
import com.mojang.renderpearl.api.vertex.VertexFormat;
import com.mojang.renderpearl.api.vertex.VertexFormatElement;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.client.renderer.ShaderDefines;
import net.minecraft.resources.Identifier;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Shader corpus for 26.3 (docs/SHADERS.md): dump every render pipeline of the
 * local client jar - required, optional and post-effect - with each stage's
 * GLSL as the port hands it to the host. 26.3's own frontend compiles raw
 * stage text with native shaderc, which the browser does not have, so the
 * port prepares the text itself and this dump does the same: every
 * #include <ns:path> expanded in place (the include files carry their own
 * #ifndef guards), then one #define per pipeline define, plus the backend
 * macros the port's device facts imply, after the leading #version and
 * #extension lines. The pipeline spec is written in the shape the port's
 * Java sends the host, with each bind group's samplers split from its
 * uniform and texel buffers.
 *
 * The output is derived from Mojang's shaders: it goes to a gitignored
 * directory and must never be committed or shipped.
 *
 *   java -cp <26.3 jar>:<its libraries> tools/shader-corpus/DumpShaderCorpus.java build/shader-corpus-26.3 [MACRO...]
 *
 * MACRO: extra backend macros to define; RENDERPEARL_DEPTH_IS_ZERO_TO_ONE is
 * always defined, because the port's device reports a zero-to-one depth range.
 */
public final class DumpShaderCorpus {
    private static final Pattern INCLUDE = Pattern.compile("^[ \\t]*#include\\s*<([^>]+)>[^\\n]*$", Pattern.MULTILINE);
    // Blank or comment lines, #version and #extension: the defines go after these.
    private static final Pattern HEADER = Pattern.compile("\\A(?:[ \\t]*(?://[^\\n]*)?\\n|[ \\t]*#(?:version|extension)[^\\n]*\\n)*");

    public static void main(String[] args) throws Exception {
        Path out = Path.of(args.length > 0 ? args[0] : "build/shader-corpus-26.3");
        List<String> macros = new ArrayList<>(List.of("RENDERPEARL_DEPTH_IS_ZERO_TO_ONE"));
        for (int i = 1; i < args.length; i++) {
            macros.add(args[i]);
        }
        Files.createDirectories(out);
        Map<String, String> texts = new TreeMap<>();
        List<RenderPipeline> all = new ArrayList<>(RenderPipelines.requiredPipelines());
        int required = all.size();
        all.addAll(RenderPipelines.optionalPipelines());
        int listed = all.size();
        all.addAll(postPipelines());
        StringBuilder json = new StringBuilder("[\n");
        boolean first = true;
        for (RenderPipeline p : all) {
            Identifier vsh = p.getShaders().get(ShaderType.VERTEX);
            Identifier fsh = p.getShaders().get(ShaderType.FRAGMENT);
            String vs = stage(vsh, "vsh", p.getShaderDefines(), macros, texts);
            String fs = stage(fsh, "fsh", p.getShaderDefines(), macros, texts);
            json.append(first ? "" : ",\n");
            first = false;
            json.append("{\"location\":").append(q(p.getLocation()))
                .append(",\"vertexShader\":").append(q(vsh))
                .append(",\"fragmentShader\":").append(q(fsh))
                .append(",\"vertexSource\":").append(q(vs))
                .append(",\"fragmentSource\":").append(q(fs))
                .append(",\"bindGroups\":[");
            boolean g1 = true;
            for (BindGroupLayout g : p.getBindGroupLayouts()) {
                json.append(g1 ? "" : ",").append("{\"uniforms\":[");
                g1 = false;
                List<String> samplers = new ArrayList<>();
                boolean u1 = true;
                for (var u : g.uniforms()) {
                    if (u.type() == UniformType.COMBINED_IMAGE_SAMPLER) {
                        samplers.add(q(u.name()));
                        continue;
                    }
                    json.append(u1 ? "" : ",").append("{\"name\":").append(q(u.name()))
                        .append(",\"type\":").append(q(u.type())).append(",\"format\":")
                        .append(u.gpuFormat() == null ? "null" : q(u.gpuFormat())).append("}");
                    u1 = false;
                }
                json.append("],\"samplers\":[").append(String.join(",", samplers)).append("]}");
            }
            json.append("],\"vertexFormats\":[");
            boolean v1 = true;
            for (VertexFormat vf : p.getVertexFormatBindings()) {
                json.append(v1 ? "" : ",");
                v1 = false;
                if (vf == null) {
                    json.append("null");
                    continue;
                }
                json.append("{\"stride\":").append(vf.getVertexSize()).append(",\"stepRate\":").append(vf.getStepRate())
                    .append(",\"elements\":[");
                boolean e1 = true;
                for (VertexFormatElement el : vf.getElements()) {
                    json.append(e1 ? "" : ",").append("{\"name\":").append(q(el.name()))
                        .append(",\"offset\":").append(el.offset()).append(",\"format\":").append(q(el.format())).append("}");
                    e1 = false;
                }
                json.append("]}");
            }
            json.append("],\"colorTargets\":[");
            boolean c1 = true;
            for (ColorTargetState t : p.getColorTargetStates()) {
                json.append(c1 ? "" : ",").append(colorTarget(t));
                c1 = false;
            }
            DepthStencilState d = p.getDepthStencilState();
            json.append("],\"depthStencil\":").append(d == null ? "null" : "{\"depthTest\":" + q(d.depthTest())
                    + ",\"writeDepth\":" + d.writeDepth() + ",\"biasScale\":" + d.depthBiasScaleFactor()
                    + ",\"biasConstant\":" + d.depthBiasConstant() + "}")
                .append(",\"topology\":").append(q(p.getPrimitiveTopology()))
                .append(",\"cull\":").append(p.isCull())
                .append(",\"polygonMode\":").append(q(p.getPolygonMode()))
                .append(",\"pushConstantSize\":").append(p.pushConstantSize()).append("}");
        }
        json.append("\n]\n");
        Files.writeString(out.resolve("pipelines.json"), json);
        for (var e : texts.entrySet()) {
            Files.writeString(out.resolve(e.getKey() + ".glsl"), e.getValue());
        }
        System.out.println("pipelines: " + all.size() + " (" + required + " required, " + (listed - required) + " optional, "
            + (all.size() - listed) + " post-effect), distinct stage texts: " + texts.size() + ", macros: " + macros + " -> " + out);
    }

    /** A colour target as the port's spec carries it: format, write mask and blend factors by name. */
    private static String colorTarget(ColorTargetState t) {
        if (t == null || t.format() == null) {
            return "null";
        }
        StringBuilder s = new StringBuilder("{\"format\":").append(q(t.format())).append(",\"writeMask\":").append(t.writeMask());
        t.blendFunction().ifPresent(b -> {
            BlendEquation c = b.color();
            BlendEquation a = b.alpha();
            s.append(",\"blend\":{\"colorSrc\":").append(q(c.sourceFactor())).append(",\"colorDst\":").append(q(c.destFactor()))
                .append(",\"colorOp\":").append(q(c.op())).append(",\"alphaSrc\":").append(q(a.sourceFactor()))
                .append(",\"alphaDst\":").append(q(a.destFactor())).append(",\"alphaOp\":").append(q(a.op())).append("}");
        });
        return s.append("}").toString();
    }

    /**
     * The pipeline of every pass of every post_effect/*.json in the jar, built
     * by the game itself: PostChainConfig.CODEC decodes the file and
     * PostChain.createPass (private, so reflectively) builds each pass, which
     * asks the fallback PipelineCache, and so GpuDevice.compilePipeline, for
     * its pipeline. A recording device installed for the dump captures it
     * there; whatever createPass does after that may fail, and is irrelevant.
     */
    private static List<RenderPipeline> postPipelines() throws Exception {
        List<RenderPipeline> recorded = new ArrayList<>();
        Class<?> deviceType = com.mojang.renderpearl.api.device.GpuDevice.class;
        var device = (com.mojang.renderpearl.api.device.GpuDevice) java.lang.reflect.Proxy.newProxyInstance(
            deviceType.getClassLoader(), new Class<?>[] {deviceType},
            (proxy, method, margs) -> {
                if (method.getName().equals("compilePipeline") && margs != null && margs[0] instanceof RenderPipeline rp) {
                    recorded.add(rp);
                    CompiledRenderPipeline compiled = new CompiledRenderPipeline() {
                        @Override
                        public boolean isClosed() {
                            return false;
                        }

                        @Override
                        public void close() {
                        }
                    };
                    return CompletableFuture.completedFuture((CompiledRenderPipeline.Pending) () -> compiled);
                }
                Class<?> r = method.getReturnType();
                return r == boolean.class ? false : r == int.class ? 0 : r == long.class ? 0L
                    : r == float.class ? 0f : r == double.class ? 0d : null;
            });
        var deviceField = com.mojang.blaze3d.systems.RenderSystem.class.getDeclaredField("DEVICE");
        deviceField.setAccessible(true);
        deviceField.set(null, device);
        com.mojang.blaze3d.systems.RenderSystem.setFallbackPipelineCache(new com.mojang.blaze3d.pipeline.PipelineCache(device, null));

        var create = net.minecraft.client.renderer.PostChain.class.getDeclaredMethod("createPass",
            net.minecraft.client.renderer.texture.TextureManager.class,
            net.minecraft.client.renderer.PostChainConfig.Pass.class, Identifier.class);
        create.setAccessible(true);
        Path jar = Path.of(net.minecraft.client.renderer.PostChain.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        int passes = 0;
        try (var zip = new java.util.zip.ZipFile(jar.toFile())) {
            var names = zip.stream().map(java.util.zip.ZipEntry::getName)
                .filter(n -> n.startsWith("assets/minecraft/post_effect/") && n.endsWith(".json")).sorted().toList();
            for (String name : names) {
                var json = com.google.gson.JsonParser.parseString(resource(name));
                var config = net.minecraft.client.renderer.PostChainConfig.CODEC
                    .parse(com.mojang.serialization.JsonOps.INSTANCE, json).getOrThrow();
                String stem = name.substring("assets/minecraft/post_effect/".length(), name.length() - 5);
                int i = 0;
                for (var pass : config.passes()) {
                    passes++;
                    int before = recorded.size();
                    try {
                        create.invoke(null, null, pass, Identifier.withDefaultNamespace("post_effect/" + stem + "/" + i++));
                    } catch (java.lang.reflect.InvocationTargetException e) {
                        if (recorded.size() == before && System.getenv("CORPUS_DEBUG") != null) e.getCause().printStackTrace();
                    }
                }
            }
        }
        // One pipeline per distinct location: several effects reuse a pass.
        var unique = new LinkedHashMap<String, RenderPipeline>();
        for (RenderPipeline p : recorded) unique.putIfAbsent(p.getLocation().toString(), p);
        System.out.println("post-effect passes: " + passes + ", pipelines recorded: " + recorded.size());
        return new ArrayList<>(unique.values());
    }

    /** One stage, prepared as the port prepares it; returns the hash naming its text file. */
    private static String stage(Identifier id, String ext, ShaderDefines defines, List<String> macros,
            Map<String, String> texts) throws Exception {
        String body = expand(resource("assets/" + id.getNamespace() + "/shaders/" + id.getPath() + "." + ext), id.toString(), 0);
        StringBuilder defs = new StringBuilder();
        for (String flag : defines.flags()) defs.append("#define ").append(flag).append('\n');
        for (var e : defines.values().entrySet()) defs.append("#define ").append(e.getKey()).append(' ').append(e.getValue()).append('\n');
        for (String macro : macros) defs.append("#define ").append(macro).append('\n');
        Matcher header = HEADER.matcher(body);
        header.find();
        String text = body.substring(0, header.end()) + defs + body.substring(header.end());
        String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
            .digest(text.getBytes(StandardCharsets.UTF_8))).substring(0, 16);
        texts.putIfAbsent(hash, text);
        return hash;
    }

    /** Every #include <ns:path> replaced by shaders/include/path, recursively. */
    private static String expand(String text, String from, int depth) throws Exception {
        if (depth > 16) {
            throw new IllegalStateException("include depth exceeded in " + from);
        }
        Matcher m = INCLUDE.matcher(text);
        StringBuilder sb = new StringBuilder();
        while (m.find()) {
            String name = m.group(1);
            int c = name.indexOf(':');
            String ns = c < 0 ? "minecraft" : name.substring(0, c);
            String included = expand(resource("assets/" + ns + "/shaders/include/" + name.substring(c + 1)), name, depth + 1);
            m.appendReplacement(sb, Matcher.quoteReplacement(included));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    private static String resource(String name) throws Exception {
        try (InputStream in = DumpShaderCorpus.class.getClassLoader().getResourceAsStream(name)) {
            if (in == null) {
                throw new IllegalStateException("not in the jar: " + name);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String q(Object s) {
        return "\"" + String.valueOf(s).replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\n", "\\n") + "\"";
    }
}
