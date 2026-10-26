import net.minecraft.SharedConstants;
import net.minecraft.core.HolderLookup;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.levelgen.densityfunction.DensityFunction;
import net.minecraft.world.level.levelgen.NoiseGeneratorSettings;
import net.minecraft.world.level.levelgen.RandomState;

/**
 * Minecraft's own worldgen noise, driven headless: no renderer, no browser.
 *
 * Bootstraps the game, builds the vanilla worldgen registries in code (no
 * data packs), creates the overworld RandomState and samples the noise
 * router's finalDensity - the density function tree every chunk's terrain
 * comes from - over a fixed grid. That tree is interface dispatch over dozens
 * of small DensityFunction records, noise math in doubles and tiny getters:
 * the shape of Minecraft's hot code, and a fair test of any JIT.
 *
 *   java -cp <client jar + libraries>:classes McWorldgenBench [rounds] [grid]
 *
 * The checksum is the correctness gate: it must be identical on every JVM.
 */
public class McWorldgenBench {
    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 5;
        int grid = args.length > 1 ? Integer.parseInt(args[1]) : 16;
        long t0 = System.nanoTime();
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
        long t1 = System.nanoTime();
        HolderLookup.Provider lookup = VanillaRegistries.createWorldLookup();
        long t2 = System.nanoTime();
        NoiseGeneratorSettings settings = lookup.lookupOrThrow(net.minecraft.core.registries.Registries.NOISE_SETTINGS).getOrThrow(NoiseGeneratorSettings.OVERWORLD).value();
        RandomState state = RandomState.create(lookup.lookupOrThrow(net.minecraft.core.registries.Registries.NOISE), 12345L, settings);
        DensityFunction density = settings.noiseRouter().finalDensity();
        long t3 = System.nanoTime();
        System.out.printf("BENCH bootstrap=%dms registries=%dms randomstate=%dms%n",
                (t1 - t0) / 1_000_000, (t2 - t1) / 1_000_000, (t3 - t2) / 1_000_000);

        // A grid of grid x grid columns, 4 blocks apart, at 24 heights: the
        // spacing NoiseChunk's interpolation cells sample at.
        for (int round = 0; round < rounds; round++) {
            long start = System.nanoTime();
            double sum = 0;
            int points = 0;
            for (int gx = 0; gx < grid; gx++) {
                for (int gz = 0; gz < grid; gz++) {
                    for (int y = -64; y < 320; y += 16) {
                        sum += state.sampleBlockValueUncached(density, gx * 4, y, gz * 4);
                        points++;
                    }
                }
            }
            long ns = System.nanoTime() - start;
            System.out.printf("BENCH round=%d points=%d ms=%.1f us/point=%.2f checksum=%.6f%n",
                    round, points, ns / 1e6, ns / 1e3 / points, sum);
        }
    }
}
