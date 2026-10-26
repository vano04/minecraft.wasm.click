import com.mojang.blaze3d.platform.NativeImage;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/**
 * Minecraft's texture decode, driven headless: every PNG under a prefix of the
 * client jar through NativeImage.read, then the pixels read back through
 * getPixel - the same NativeImage (native memory, port shadows) every sprite
 * and atlas is built from. Prints a hash and the opaque-pixel count per
 * round; they must be identical on every JVM. A decoder or native-memory
 * fault shows up in the game only as empty sprites (buttons and hotbar
 * missing, terrain black), so here it is caught as a number.
 *
 *   java -cp <port jar + massaged jar + libraries>:classes McImageBench <client.jar> [rounds] [prefix]
 */
public class McImageBench {
    public static void main(String[] args) throws Exception {
        String jarPath = args[0];
        int rounds = args.length > 1 ? Integer.parseInt(args[1]) : 3;
        String prefix = args.length > 2 ? args[2] : "assets/minecraft/textures/gui/sprites/hud/";
        long total = 0;
        try (JarFile jar = new JarFile(jarPath)) {
            for (int round = 0; round < rounds; round++) {
                long start = System.nanoTime();
                long hash = 1125899906842597L;
                long opaque = 0, pixels = 0, bulkOpaque = 0, bulkHash = 1125899906842597L;
                int images = 0;
                for (Enumeration<JarEntry> e = jar.entries(); e.hasMoreElements(); ) {
                    JarEntry entry = e.nextElement();
                    String name = entry.getName();
                    if (!name.startsWith(prefix) || !name.endsWith(".png")) continue;
                    try (InputStream in = jar.getInputStream(entry);
                         NativeImage image = NativeImage.read(in)) {
                        images++;
                        for (int y = 0; y < image.getHeight(); y++) {
                            for (int x = 0; x < image.getWidth(); x++) {
                                int argb = image.getPixel(x, y);
                                hash = 31 * hash + argb;
                                if ((argb >>> 24) != 0) opaque++;
                                pixels++;
                            }
                        }
                        // What CommandEncoder.writeToTexture actually uploads:
                        // the pixel buffer, bulk-copied as the port's backend does.
                        java.nio.ByteBuffer px = image.getPixelBytes();
                        byte[] bytes = new byte[image.getWidth() * image.getHeight() * 4];
                        px.duplicate().get(bytes, 0, bytes.length);
                        for (int i = 0; i < bytes.length; i += 4) {
                            bulkHash = 31 * bulkHash + (bytes[i] & 0xFF) + ((bytes[i + 1] & 0xFF) << 8)
                                    + ((bytes[i + 2] & 0xFF) << 16) + ((bytes[i + 3] & 0xFF) << 24);
                            if (bytes[i + 3] != 0) bulkOpaque++;
                        }
                        if (round == 0 && images <= 3) {
                            System.out.printf("IMAGE %s %dx%d%n", name.substring(prefix.length()),
                                    image.getWidth(), image.getHeight());
                        }
                    }
                }
                long ns = System.nanoTime() - start;
                total = total * 31 + hash;
                System.out.printf("IMAGES round=%d images=%d pixels=%d opaque=%d bulkOpaque=%d ms=%.1f hash=%016x bulk=%016x%n",
                        round, images, pixels, opaque, bulkOpaque, ns / 1e6, hash, bulkHash);
            }
        }
        System.out.printf("IMAGES checksum=%016x%n", total);
    }
}
