import java.util.ArrayList;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.SharedConstants;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.IdMap;
import net.minecraft.core.registries.Registries;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.LevelHeightAccessor;
import net.minecraft.world.level.StructureManager;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.BiomeManager;
import net.minecraft.world.level.biome.MultiNoiseBiomeSource;
import net.minecraft.world.level.biome.MultiNoiseBiomeSourceParameterLists;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.PalettedContainerFactory;
import net.minecraft.world.level.chunk.ProtoChunk;
import net.minecraft.world.level.chunk.Strategy;
import net.minecraft.world.level.chunk.UpgradeData;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.levelgen.NoiseBasedChunkGenerator;
import net.minecraft.world.level.levelgen.NoiseGeneratorSettings;
import net.minecraft.world.level.levelgen.RandomState;
import net.minecraft.world.level.levelgen.WorldGenerationContext;
import net.minecraft.world.level.levelgen.blending.Blender;
import net.minecraft.world.level.levelgen.structure.Structure;
import net.minecraft.world.level.levelgen.structure.StructureStart;

/**
 * Minecraft's chunk generation steps on real ProtoChunks, headless: biomes,
 * noise fill and surface, the part of the server's serial worldgen executor
 * that is not features (which need a WorldGenRegion). Surface runs on this
 * thread, as it does on the game's worldgen lane; biomes and noise run where
 * the generator sends them (the background executor) and are joined.
 *
 * No structures (a StructureManager that finds none), no blending: vanilla
 * terrain as a fresh world makes it.
 *
 *   java -cp <client jar + libraries>:classes McChunkBench [rounds] [chunks-per-side] [x z]
 *
 * x z: the square's first chunk (default 0 0). An ocean exercises the fluid
 * paths the land at the origin does not.
 *
 * Every round generates the same square of chunks, afresh. The checksum (block-state ids
 * and heightmaps of every chunk) must be identical on every JVM.
 */
public class McChunkBench {
    /** Finds no structure starts, so every chunk's Beardifier is EMPTY. */
    static final class NoStructures extends StructureManager {
        NoStructures() { super(null, null, null); }
        @Override
        public List<StructureStart> startsForStructure(int chunkX, int chunkZ, Predicate<Structure> filter) {
            return List.of();
        }
    }

    /** The biome ids a chunk's biome palette stores. */
    static final class HolderIds<T> implements IdMap<T> {
        final List<T> list;
        final Map<T, Integer> ids = new IdentityHashMap<>();
        HolderIds(List<T> list) {
            this.list = list;
            for (int i = 0; i < list.size(); i++) ids.put(list.get(i), i);
        }
        @Override public int getId(T t) { Integer i = ids.get(t); return i == null ? DEFAULT : i; }
        @Override public T byId(int id) { return id >= 0 && id < list.size() ? list.get(id) : null; }
        @Override public int size() { return list.size(); }
        @Override public Iterator<T> iterator() { return list.iterator(); }
    }

    public static void main(String[] args) {
        try {
            run(args);
        } catch (Throwable t) {
            for (Throwable c = t; c != null; c = c.getCause()) {
                System.out.printf("BENCH failed: %s: %s%n", c.getClass().getName(), c.getMessage());
                for (StackTraceElement e : c.getStackTrace()) System.out.printf("    at %s%n", e);
            }
            System.exit(1);
        }
    }

    static void run(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 5;
        int side = args.length > 1 ? Integer.parseInt(args[1]) : 3;
        int ox = args.length > 3 ? Integer.parseInt(args[2]) : 0;
        int oz = args.length > 3 ? Integer.parseInt(args[3]) : 0;
        long seed = 12345L;
        long t0 = System.nanoTime();
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
        HolderLookup.Provider lookup = VanillaRegistries.createWorldLookup();
        List<Holder<Biome>> biomes = new ArrayList<>();
        lookup.lookupOrThrow(Registries.BIOME).listElements().forEach(biomes::add);
        Holder<Biome> plains = lookup.lookupOrThrow(Registries.BIOME).getOrThrow(net.minecraft.world.level.biome.Biomes.PLAINS);
        BlockState air = Blocks.AIR.defaultBlockState();
        PalettedContainerFactory containers = new PalettedContainerFactory(
                Strategy.createForBlockStates(Block.BLOCK_STATE_REGISTRY), air, null,
                Strategy.createForBiomes(new HolderIds<>(biomes)), plains, null);
        NoiseBasedChunkGenerator generator = new NoiseBasedChunkGenerator(
                MultiNoiseBiomeSource.createFromPreset(lookup.lookupOrThrow(Registries.MULTI_NOISE_BIOME_SOURCE_PARAMETER_LIST)
                        .getOrThrow(MultiNoiseBiomeSourceParameterLists.OVERWORLD)),
                lookup.lookupOrThrow(Registries.NOISE_SETTINGS).getOrThrow(NoiseGeneratorSettings.OVERWORLD));
        RandomState random = RandomState.create(lookup.lookupOrThrow(Registries.NOISE), seed, generator.generatorSettings().value());
        LevelHeightAccessor height = LevelHeightAccessor.create(-64, 384);
        WorldGenerationContext context = new WorldGenerationContext(generator, height);
        StructureManager structures = new NoStructures();
        long t1 = System.nanoTime();
        System.out.printf("BENCH setup=%dms%n", (t1 - t0) / 1_000_000);

        for (int round = 0; round < rounds; round++) {
            long biomeNs = 0, noiseNs = 0, surfaceNs = 0;
            long sum = 0;
            int water = 0;
            for (int i = 0; i < side * side; i++) {
                ChunkPos pos = new ChunkPos(ox + i % side, oz + i / side);
                ProtoChunk chunk = new ProtoChunk(pos, UpgradeData.EMPTY, height, containers, null);
                long a = System.nanoTime();
                generator.createBiomes(random, Blender.empty(), structures, chunk).join();
                chunk.setPersistedStatus(ChunkStatus.BIOMES);
                long b = System.nanoTime();
                Set<Holder<Biome>> possible = new HashSet<>(biomes);
                generator.buildTerrain(chunk, Blender.empty(), random, structures,
                        new BiomeManager(chunk, BiomeManager.obfuscateSeed(seed)), null, possible).join();
                chunk.setPersistedStatus(ChunkStatus.TERRAIN);
                long c = System.nanoTime();
                long d = System.nanoTime();
                biomeNs += b - a; noiseNs += c - b; surfaceNs += d - c;
                sum = sum * 31 + checksum(chunk);
                water += waterColumns(chunk);
            }
            int n = side * side;
            System.out.printf("BENCH round=%d chunks=%d biomes=%.1fms terrain=%.1fms overhead=%.1fms (per chunk %.2f/%.2f/%.2f) checksum=%d%n",
                    round, n, biomeNs / 1e6, noiseNs / 1e6, surfaceNs / 1e6,
                    biomeNs / 1e6 / n, noiseNs / 1e6 / n, surfaceNs / 1e6 / n, sum);
            System.out.printf("CHUNKS round=%d chunks=%d water=%d checksum=%d%n", round, n, water, sum);   // mc-gate.sh
        }
        System.exit(0);   // the background executor's threads are not daemons
    }

    static int waterColumns(ProtoChunk chunk) {
        int n = 0, minX = chunk.getPos().getMinBlockX(), minZ = chunk.getPos().getMinBlockZ();
        net.minecraft.core.BlockPos.MutableBlockPos p = new net.minecraft.core.BlockPos.MutableBlockPos();
        for (int x = 0; x < 16; x++)
            for (int z = 0; z < 16; z++)
                if (!chunk.getBlockState(p.set(minX + x, 62, minZ + z)).getFluidState().isEmpty()) n++;
        return n;
    }

    static long checksum(ProtoChunk chunk) {
        long h = 0;
        int minX = chunk.getPos().getMinBlockX(), minZ = chunk.getPos().getMinBlockZ();
        net.minecraft.core.BlockPos.MutableBlockPos p = new net.minecraft.core.BlockPos.MutableBlockPos();
        for (int x = 0; x < 16; x++) {
            for (int z = 0; z < 16; z++) {
                h = h * 131 + chunk.getHeight(Heightmap.Types.WORLD_SURFACE_WG, x, z);
                for (int y = -64; y < 320; y += 3) {
                    h = h * 31 + Block.BLOCK_STATE_REGISTRY.getId(chunk.getBlockState(p.set(minX + x, y, minZ + z)));
                }
            }
        }
        return h;
    }
}
