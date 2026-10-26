import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Original developer fixture only; no game classes, textures or extracted data. */
public class MakeServerPackFixture {
    public static void main(String[] args) throws Exception {
        if (args.length > 1) throw new IllegalArgumentException("usage: MakeServerPackFixture.java [output.zip]");
        Path output = Path.of(args.length == 0 ? "build/fixtures/c10-original-pack.zip" : args[0]);
        // These original contents were checked with pinned 26.2's pack metadata
        // codec (resource format 88.0) and language reader. The label is visible
        // on Minecraft's own multiplayer PauseScreen after an accepted reload.
        Map<String, String> contents = new LinkedHashMap<>();
        contents.put("pack.mcmeta", "{\"pack\":{\"description\":\"MC-Web C10 original fixture\",\"min_format\":88,\"max_format\":[88,0]}}");
        contents.put("assets/minecraft/lang/en_us.json", "{\"menu.disconnect\":\"MC-Web C10 pack active\"}");
        Files.createDirectories(output.toAbsolutePath().getParent());
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(output))) {
            for (var item : contents.entrySet()) {
                ZipEntry entry = new ZipEntry(item.getKey());
                entry.setTime(0);
                zip.putNextEntry(entry);
                zip.write(item.getValue().getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
        }
        try (ZipFile zip = new ZipFile(output.toFile())) {
            if (zip.size() != contents.size()) throw new IllegalStateException("unexpected ZIP entries");
            for (var item : contents.entrySet()) {
                ZipEntry entry = zip.getEntry(item.getKey());
                if (entry == null) throw new IllegalStateException("missing ZIP entry: " + item.getKey());
                try (var input = zip.getInputStream(entry)) {
                    String actual = new String(input.readAllBytes(), StandardCharsets.UTF_8);
                    if (!actual.equals(item.getValue())) throw new IllegalStateException("ZIP content differs: " + item.getKey());
                }
            }
        }
        byte[] bytes = Files.readAllBytes(output);
        String sha1 = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest(bytes));
        System.out.println("PASS file=" + output + " bytes=" + bytes.length + " sha1=" + sha1);
        System.out.println("entries=" + String.join(",", contents.keySet()));
        System.out.println("format=88.0 own-label=MC-Web C10 pack active");
    }
}
