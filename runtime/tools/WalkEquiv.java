import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.stream.Stream;

/**
 * Does the pruned walk return exactly what the old filter-after-walk returned?
 *
 * The stutter fix replaced Files.walk(...).filter(isClientOwned) with a
 * walkFileTree that prunes excluded directories. A pruning bug that returned
 * *fewer* files would remove the stutter and silently stop persisting player
 * data, so equivalence is the thing to prove, not the speed.
 */
public class WalkEquiv {
    static Path gameRoot;
    static final String SERVER_PACK_ROOT = "server-resource-packs";

    static boolean isClientOwned(Path path) {
        Path relative = gameRoot.relativize(path);
        if (relative.getNameCount() == 0) return false;
        String first = relative.getName(0).toString();
        return !"saves".equals(first) && !"logs".equals(first)
                && !"crash-reports".equals(first)
                && !SERVER_PACK_ROOT.equals(first);
    }

    /** The original implementation. */
    static List<Path> oldWay() throws IOException {
        try (Stream<Path> paths = Files.walk(gameRoot)) {
            return paths.filter(Files::isRegularFile)
                    .filter(WalkEquiv::isClientOwned)
                    .sorted()
                    .toList();
        }
    }

    /** The new implementation, copied verbatim from BrowserPersistentStorage. */
    static List<Path> newWay() throws IOException {
        List<Path> found = new ArrayList<>();
        Files.walkFileTree(gameRoot, new SimpleFileVisitor<Path>() {
            @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes a) {
                if (dir.equals(gameRoot) || isClientOwned(dir)) return FileVisitResult.CONTINUE;
                return FileVisitResult.SKIP_SUBTREE;
            }
            @Override public FileVisitResult visitFile(Path file, BasicFileAttributes a) {
                if (a.isRegularFile() && isClientOwned(file)) found.add(file);
                return FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult visitFileFailed(Path file, IOException e) {
                return FileVisitResult.CONTINUE;
            }
        });
        found.sort(null);
        return found;
    }

    static void touch(String rel) throws IOException {
        Path p = gameRoot.resolve(rel);
        Files.createDirectories(p.getParent());
        Files.writeString(p, "x");
    }

    public static void main(String[] args) throws Exception {
        gameRoot = Files.createTempDirectory("mcweb-walk");
        // A realistic game root, including every excluded root and the deep,
        // many-file server pack that caused the stall.
        touch("options.txt");
        touch("servers.dat");
        touch("usercache.json");
        touch("resourcepacks/MyPack/pack.mcmeta");
        touch("resourcepacks/MyPack/assets/minecraft/textures/block/stone.png");
        touch("config/some-mod.toml");
        touch("saves/World1/level.dat");
        touch("saves/World1/region/r.0.0.mca");
        touch("logs/latest.log");
        touch("crash-reports/crash.txt");
        for (int i = 0; i < 500; i++) {
            touch(SERVER_PACK_ROOT + "/pack/assets/minecraft/textures/gen/t" + i + ".png");
        }
        // An excluded root that is also a file, and an empty excluded dir.
        Files.createDirectories(gameRoot.resolve("logs/subdir"));

        List<Path> a = oldWay();
        List<Path> b = newWay();
        System.out.println("old returned " + a.size() + ", new returned " + b.size());
        if (!a.equals(b)) {
            Set<Path> onlyOld = new TreeSet<>(a); onlyOld.removeAll(b);
            Set<Path> onlyNew = new TreeSet<>(b); onlyNew.removeAll(a);
            System.out.println("MISMATCH\n  only old: " + onlyOld + "\n  only new: " + onlyNew);
            System.exit(1);
        }
        for (Path p : a) System.out.println("  " + gameRoot.relativize(p));

        long t0 = System.nanoTime();
        for (int i = 0; i < 20; i++) oldWay();
        long oldNs = System.nanoTime() - t0;
        t0 = System.nanoTime();
        for (int i = 0; i < 20; i++) newWay();
        long newNs = System.nanoTime() - t0;
        System.out.printf("EQUAL. 20 scans: old %.1f ms, new %.1f ms (%.1fx less work)%n",
                oldNs / 1e6, newNs / 1e6, (double) oldNs / newNs);
    }
}
