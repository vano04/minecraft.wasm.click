import net.minecraft.world.level.levelgen.XoroshiroRandomSource;
import net.minecraft.world.level.levelgen.synth.NormalNoise;
import net.minecraft.world.level.levelgen.synth.Noise;

/**
 * Minecraft's own noise, without bootstrapping the game: NormalNoise over
 * PerlinNoise over ImprovedNoise, the arithmetic core of every density
 * function. Seconds to set up, so it can be run on every JIT change.
 *
 *   java -cp <client jar + libraries>:classes McNoiseBench [rounds] [grid]
 */
public class McNoiseBench {
    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 5;
        int grid = args.length > 1 ? Integer.parseInt(args[1]) : 16;
        long t0 = System.nanoTime();
        // The overworld's continentalness parameters: 9 octaves from -9.
        Noise noise = NormalNoise.createParity(-9, 1.0, 1.0, 2.0, 2.0, 2.0, 1.0, 1.0, 1.0, 1.0).create(new XoroshiroRandomSource(12345L));
        System.out.printf("BENCH setup=%dms%n", (System.nanoTime() - t0) / 1_000_000);
        for (int round = 0; round < rounds; round++) {
            long start = System.nanoTime();
            double sum = 0;
            int points = 0;
            for (int x = 0; x < grid; x++) {
                for (int z = 0; z < grid; z++) {
                    for (int y = -64; y < 320; y += 32) {
                        sum += noise.get(x * 4.0, y, z * 4.0);
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
