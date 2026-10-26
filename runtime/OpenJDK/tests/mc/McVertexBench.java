import com.mojang.renderpearl.api.pipeline.PrimitiveTopology;
import com.mojang.blaze3d.vertex.BufferBuilder;
import com.mojang.blaze3d.vertex.ByteBufferBuilder;
import com.mojang.blaze3d.vertex.DefaultVertexFormat;
import com.mojang.blaze3d.vertex.MeshData;
import com.mojang.renderpearl.api.vertex.VertexFormat;
import java.nio.ByteBuffer;

/**
 * Minecraft's vertex writer, driven headless: what every terrain section and
 * entity model goes through before a single byte reaches the GPU.
 *
 * BufferBuilder writes floats, packed colours, packed light and bytes of
 * normal straight into native memory through LWJGL's MemoryUtil (Unsafe
 * underneath): float arguments, int bit packing, long addresses, several
 * vertex formats and both the fast whole-vertex path and the chained setters.
 * A JIT that gets any of that subtly wrong still runs the game, and the only
 * symptom is geometry the GPU draws black or not at all. This makes the bytes
 * themselves the output: the checksum over every vertex buffer must be the
 * same on every JVM.
 *
 *   java -cp <client jar + libraries>:classes McVertexBench [rounds] [quads]
 */
public class McVertexBench {
    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 5;
        int quads = args.length > 1 ? Integer.parseInt(args[1]) : 4096;
        long total = 0;
        for (int round = 0; round < rounds; round++) {
            long start = System.nanoTime();
            long block = build(DefaultVertexFormat.BLOCK, quads, round, true);
            long chained = build(DefaultVertexFormat.BLOCK, quads, round, false);
            long entity = build(DefaultVertexFormat.ENTITY, quads, round, true);
            long ns = System.nanoTime() - start;
            total = total * 31 + block * 7 + chained * 3 + entity;
            System.out.printf("VERTEX round=%d quads=%d ms=%.1f block=%016x chained=%016x entity=%016x%n",
                    round, quads, ns / 1e6, block, chained, entity);
        }
        System.out.printf("VERTEX checksum=%016x%n", total);
    }

    // One mesh of `quads` quads, deterministic from (quads, seed); returns a
    // hash of the vertex bytes in buffer order.
    static long build(VertexFormat format, int quads, int seed, boolean whole) {
        try (ByteBufferBuilder bytes = new ByteBufferBuilder(format.getVertexSize() * 4 * quads)) {
            BufferBuilder b = new BufferBuilder(bytes, PrimitiveTopology.QUADS, format);
            for (int q = 0; q < quads; q++) {
                for (int v = 0; v < 4; v++) {
                    int i = q * 4 + v + seed;
                    float x = (i % 16) + v * 0.25f, y = (i / 16 % 16) - 0.5f, z = (i / 256) * 1.0625f;
                    int color = 0xFF000000 | (i * 2654435761L > 0 ? i * 40503 : ~i) & 0xFFFFFF;
                    float u = (i % 64) / 64f + 0.001953125f, w = ((i >> 6) % 64) / 64f;
                    int overlay = (i & 15) | ((i >> 4 & 15) << 16);
                    int light = (i * 17 & 0xF0) | ((i * 29 & 0xF0) << 16);
                    float nx = (v - 1.5f) / 1.5f, ny = (q & 1) == 0 ? 1f : -1f, nz = 0.5f * (v & 1);
                    if (whole) {
                        b.addVertex(x, y, z, color, u, w, overlay, light, nx, ny, nz);
                    } else {
                        b.addVertex(x, y, z).setColor(color).setUv(u, w).setLight(light).setNormal(nx, ny, nz);
                    }
                }
            }
            try (MeshData mesh = b.buildOrThrow()) {
                return hash(mesh.vertexBuffer());
            }
        }
    }

    static long hash(ByteBuffer buf) {
        long h = 1125899906842597L;
        for (int i = buf.position(); i < buf.limit(); i++) h = 31 * h + (buf.get(i) & 0xFF);
        return h ^ buf.remaining();
    }
}
