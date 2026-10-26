import java.util.*;
import java.util.stream.*;

public class Hello {
    record Point(int x, int y) {}

    public static void main(String[] args) throws Exception {
        System.out.println("hello from " + System.getProperty("java.vm.name")
                           + " " + System.getProperty("java.version")
                           + " on " + System.getProperty("os.arch"));

        // exceptions
        try { Object o = null; o.toString(); }
        catch (NullPointerException e) { System.out.println("NPE caught: ok"); }
        try { throw new IllegalStateException("thrown"); }
        catch (IllegalStateException e) { System.out.println("catch: " + e.getMessage()); }

        // collections, generics, records, streams, lambdas
        var pts = IntStream.range(0, 5).mapToObj(i -> new Point(i, i * i)).toList();
        System.out.println("records: " + pts);
        System.out.println("sum: " + pts.stream().mapToInt(Point::y).sum());

        // string concat (invokedynamic) and switch
        for (var s : List.of("a", "b", "z")) {
            System.out.println(switch (s) { case "a" -> "first"; case "b" -> "second"; default -> "other:" + s; });
        }

        // reflection
        var m = Hello.class.getDeclaredMethod("main", String[].class);
        System.out.println("reflection: " + m.getName() + " " + m.getParameterCount());

        // allocation + GC
        long before = Runtime.getRuntime().totalMemory();
        List<byte[]> junk = new ArrayList<>();
        for (int i = 0; i < 2000; i++) junk.add(new byte[8192]);
        junk.clear();
        System.gc();
        System.out.println("gc: survived, heap " + before / 1024 + "K -> "
                           + Runtime.getRuntime().totalMemory() / 1024 + "K");

        // concurrency
        var t = new Thread(() -> System.out.println("thread: ran on " + Thread.currentThread().getName()));
        t.start(); t.join();

        // files
        var p = java.nio.file.Files.createTempFile("mcweb", ".txt");
        java.nio.file.Files.writeString(p, "round trip");
        System.out.println("file: " + java.nio.file.Files.readString(p));
        java.nio.file.Files.delete(p);

        System.out.println("ALL OK");
    }
}
