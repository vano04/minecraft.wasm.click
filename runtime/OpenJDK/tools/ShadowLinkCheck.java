import java.io.IOException;
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;
import java.lang.classfile.constantpool.FieldRefEntry;
import java.lang.classfile.constantpool.InterfaceMethodRefEntry;
import java.lang.classfile.constantpool.MemberRefEntry;
import java.lang.classfile.constantpool.MethodRefEntry;
import java.lang.classfile.constantpool.PoolEntry;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.jar.JarFile;

/**
 * Does every call the transformed client jar makes into a port shadow class
 * resolve against the port's copy of that class?
 *
 * The port replaces some Mojang classes outright (src/graal/java/net/minecraft,
 * com/mojang, ...), and the build.gradle ASM transforms rewrite calls to use
 * members only those shadows define. When the two drift apart, the game
 * compiles, packages and boots, then dies at the first call with a
 * NoSuchMethodError. This finds all of them in a second, without a browser.
 *
 *   java OpenJDK/tools/ShadowLinkCheck.java <transformed.jar> <mcweb-port.jar>
 *
 * Exit status 1 if any reference is missing.
 */
public class ShadowLinkCheck {
    public static void main(String[] args) throws IOException {
        Map<String, Set<String>> shadows = new HashMap<>();
        Map<String, String> supers = new HashMap<>();
        try (JarFile port = new JarFile(args[1])) {
            for (var e : java.util.Collections.list(port.entries())) {
                if (!e.getName().endsWith(".class")) continue;
                ClassModel cm = ClassFile.of().parse(port.getInputStream(e).readAllBytes());
                String name = cm.thisClass().asInternalName();
                if (name.startsWith("dev/mcweb/")) continue;
                Set<String> members = new TreeSet<>();
                cm.methods().forEach(m -> members.add(m.methodName().stringValue() + m.methodType().stringValue()));
                cm.fields().forEach(f -> members.add(f.fieldName().stringValue() + ":" + f.fieldType().stringValue()));
                shadows.put(name, members);
                supers.put(name, cm.superclass().map(c -> c.asInternalName()).orElse("java/lang/Object"));
            }
        }
        Set<String> missing = new TreeSet<>();
        Set<String> inherited = new TreeSet<>();
        int checked = 0;
        for (String jar : new String[] { args[0], args[1] }) {
            try (JarFile in = new JarFile(jar)) {
                for (var e : java.util.Collections.list(in.entries())) {
                    if (!e.getName().endsWith(".class")) continue;
                    ClassModel cm = ClassFile.of().parse(in.getInputStream(e).readAllBytes());
                    String self = cm.thisClass().asInternalName();
                    // The client jar's own copy of a shadowed class never loads.
                    if (jar.equals(args[0]) && shadows.containsKey(self)) continue;
                    // Nor do its nested classes that the shadow does not have:
                    // nothing but the replaced outer class referred to them.
                    if (jar.equals(args[0]) && self.contains("$")
                            && shadows.containsKey(self.substring(0, self.indexOf('$')))) continue;
                    for (PoolEntry pe : cm.constantPool()) {
                        if (!(pe instanceof MemberRefEntry ref)) continue;
                        String owner = ref.owner().asInternalName();
                        Set<String> members = shadows.get(owner);
                        if (members == null) continue;
                        checked++;
                        String key = pe instanceof FieldRefEntry
                                ? ref.name().stringValue() + ":" + ref.type().stringValue()
                                : ref.name().stringValue() + ref.type().stringValue();
                        // Inherited members resolve through the superclass; only
                        // flag what the shadow cannot have got elsewhere.
                        if (members.contains(key) || inheritedLooking(ref)) continue;
                        // A member the shadow does not declare may still be
                        // inherited; only a shadow whose superclass is Object
                        // (or another shadow that lacks it too) is certain.
                        String up = supers.get(owner);
                        while (up != null && shadows.containsKey(up) && !shadows.get(up).contains(key)) up = supers.get(up);
                        if (up != null && shadows.containsKey(up)) continue;
                        if (up != null && !up.equals("java/lang/Object")) {
                            inherited.add(owner + "." + key + "   (via " + up + ")");
                            continue;
                        }
                        missing.add(owner + "." + key + "   <- " + self);
                    }
                }
            }
        }
        if (args.length > 2 && args[2].equals("-v")) inherited.forEach(m -> System.out.println("inherited? " + m));
        missing.forEach(m -> System.out.println("MISSING " + m));
        System.out.println(shadows.size() + " shadow classes, " + checked + " references checked, "
                + missing.size() + " missing, " + inherited.size() + " assumed inherited (-v lists them)");
        System.exit(missing.isEmpty() ? 0 : 1);
    }

    // Object's methods, reached through a shadow owner, resolve without the
    // shadow declaring them.
    private static boolean inheritedLooking(MemberRefEntry ref) {
        if (!(ref instanceof MethodRefEntry) && !(ref instanceof InterfaceMethodRefEntry)) return false;
        return switch (ref.name().stringValue() + ref.type().stringValue()) {
            case "toString()Ljava/lang/String;", "hashCode()I", "equals(Ljava/lang/Object;)Z",
                 "getClass()Ljava/lang/Class;", "clone()Ljava/lang/Object;" -> true;
            default -> false;
        };
    }
}
