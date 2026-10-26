import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.jar.*;

/** M2: verify a locally supplied JAR loads through a normal ClassLoader,
 *  byte-for-byte unchanged, with resources and deterministic failures. */
public class JarLoad {
    public static void main(String[] args) throws Exception {
        Path jar = Path.of(args[0]);
        byte[] before = Files.readAllBytes(jar);
        System.out.println("jar: " + jar.getFileName() + " " + before.length + " bytes sha256=" + sha(before));

        try (JarFile jf = new JarFile(jar.toFile())) {
            System.out.println("entries: " + jf.stream().count());
            System.out.println("manifest main-class: "
                + jf.getManifest().getMainAttributes().getValue("Main-Class"));
        }

        try (URLClassLoader cl = new URLClassLoader(new URL[]{ jar.toUri().toURL() }, null)) {
            Class<?> c = cl.loadClass("Plugin");
            String out = (String) c.getMethod("greet", String.class).invoke(null, "wasm");
            System.out.println("loaded+invoked: " + out);

            try (InputStream in = cl.getResourceAsStream("data/hello.txt")) {
                System.out.println("resource: " + new String(in.readAllBytes()).trim());
            }

            try { cl.loadClass("does.not.Exist"); System.out.println("FAIL: missing class did not throw"); }
            catch (ClassNotFoundException e) { System.out.println("missing class: ClassNotFoundException (ok)"); }
        }

        byte[] after = Files.readAllBytes(jar);
        System.out.println("jar unchanged after load: " + java.util.Arrays.equals(before, after));

        Path bad = Files.createTempFile("broken", ".jar");
        Files.write(bad, "not a zip at all".getBytes());
        try (URLClassLoader cl = new URLClassLoader(new URL[]{ bad.toUri().toURL() }, null)) {
            cl.loadClass("Plugin");
            System.out.println("FAIL: malformed archive did not throw");
        } catch (Exception e) {
            System.out.println("malformed archive: " + e.getClass().getSimpleName() + " (ok)");
        }
        Files.delete(bad);
        System.out.println("ALL OK");
    }

    static String sha(byte[] b) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (byte x : MessageDigest.getInstance("SHA-256").digest(b)) sb.append(String.format("%02x", x));
        return sb.substring(0, 16);
    }
}
