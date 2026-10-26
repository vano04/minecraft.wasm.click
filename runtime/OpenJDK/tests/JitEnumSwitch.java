import java.lang.classfile.ClassFile;
import java.lang.constant.ClassDesc;
import java.lang.constant.ConstantDescs;
import java.lang.constant.DirectMethodHandleDesc;
import java.lang.constant.DynamicCallSiteDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.invoke.MethodHandles;

/**
 * Switches over enums that javac links through SwitchBootstraps.enumSwitch,
 * which the JIT emits as a table lookup under -XX:ZeroWasmJITIndyFast bit 4
 * (see emit_enum_switch in zeroWasmCompiler.cpp). A `case null` switch over
 * every constant (a frameless leaf, and inlined into its caller); a big enum
 * with a few labels and a default; constants with bodies (subclasses of the
 * enum); a guarded pattern among the constants (a Class label, so a
 * typeSwitch that stays a call); a site built with the class-file API whose
 * labels name a constant that does not exist (as separate compilation
 * leaves it) and repeat a name, given restart indexes, the ones it rejects
 * included (javac never restarts a switch whose labels are all names); an
 * enum the switch has only seen null for when the method is compiled; a
 * null selector in a switch without `case null`; a typeSwitch over a sealed
 * interface, which stays a call; and several threads switching at once.
 *
 * Lines starting with "esw" must be identical with and without the JIT.
 */
public class JitEnumSwitch {
    enum Color { RED, GREEN, BLUE, YELLOW }
    enum Op {
        PLUS { int apply(int a, int b) { return a + b; } },
        MINUS { int apply(int a, int b) { return a - b; } },
        TIMES { int apply(int a, int b) { return a * b; } },
        PLAIN;
        int apply(int a, int b) { return a ^ b; }
    }
    enum Big {
        B00, B01, B02, B03, B04, B05, B06, B07, B08, B09, B10, B11, B12, B13, B14, B15, B16, B17, B18, B19,
        B20, B21, B22, B23, B24, B25, B26, B27, B28, B29, B30, B31, B32, B33, B34, B35, B36, B37, B38, B39,
        B40, B41, B42, B43, B44, B45, B46, B47, B48, B49, B50, B51, B52, B53, B54, B55, B56, B57, B58, B59,
        B60, B61, B62, B63, B64, B65, B66, B67, B68, B69
    }
    enum Rare { ONE, TWO, THREE }

    sealed interface Shape permits Circle, Square, Tri {}
    record Circle(int r) implements Shape {}
    record Square(int s) implements Shape {}
    record Tri(int a, int b) implements Shape {}

    public interface Sw { int sw(Color c, int restart); }

    static final Color[] COLORS = Color.values();
    static final Op[] OPS = Op.values();
    static final Big[] BIGS = Big.values();
    static final Rare[] RARES = Rare.values();

    // Every constant and null: a call-free leaf once the switch is a table.
    static int full(Color c) {
        return switch (c) {
            case null -> 100;
            case RED -> 1;
            case GREEN -> 2;
            case BLUE -> 3;
            case YELLOW -> 4;
        };
    }
    static int fullLoop(int n) {
        int h = 0;
        for (int i = 0; i < n; i++) {
            Color c = (i % 7 == 6) ? null : COLORS[i % 4];
            h = h * 31 + full(c);
        }
        return h;
    }

    // A few labels out of 70, and a default.
    static int partial(Big b) {
        return switch (b) {
            case B00 -> 11;
            case B07 -> 12;
            case B33 -> 13;
            case B68 -> 14;
            case B69 -> 15;
            case null -> -5;
            default -> b.ordinal() * 2;
        };
    }

    // Constants with bodies are subclasses of the enum.
    static int body(Op o, int a, int b) {
        return switch (o) {
            case PLUS -> o.apply(a, b) + 1000;
            case TIMES -> o.apply(a, b) + 2000;
            case null -> -1;
            default -> o.apply(a, b);
        };
    }

    // A guard needs a pattern label, which enumSwitch gets as a Class: a
    // typeSwitch, whose failed guard re-enters the switch with a restart
    // index. Not a table.
    static int guarded(Color c, int x) {
        return switch (c) {
            case RED -> 2;
            case Color k when k == Color.GREEN && (x & 1) == 0 -> 3;
            case Color k when k == Color.BLUE && x % 3 == 0 -> 4;
            case GREEN -> 6;
            case null -> 0;
            default -> 9;
        };
    }

    // No `case null`: javac checks the selector before the switch.
    static int noNull(Color c, int x) {
        return switch (c) {
            case Color k when x > 0 && k == Color.RED -> 1;
            case GREEN -> 2;
            default -> 3;
        };
    }

    // Compiled while only null has reached the switch.
    static int rare(Rare r) {
        return switch (r) {
            case null -> 7;
            case ONE -> 1;
            case THREE -> 3;
            default -> 2;
        };
    }

    // A typeSwitch: not a table, still a call.
    static int shape(Shape s) {
        return switch (s) {
            case null -> -1;
            case Circle c when c.r() > 10 -> 100 + c.r();
            case Circle c -> c.r();
            case Square q -> 2 * q.s();
            case Tri t -> t.a() + t.b();
        };
    }

    // enumSwitch(Color, restart) with the labels GREEN, NOPE, RED, GREEN, BLUE:
    // NOPE names no constant, GREEN is there twice (the first wins), YELLOW
    // matches nothing (the number of labels).
    static Sw generated() throws Exception {
        ClassDesc self = ClassDesc.of("JitEnumSwitchGen");
        ClassDesc color = ClassDesc.of("JitEnumSwitch$Color");
        MethodTypeDesc swType = MethodTypeDesc.of(ConstantDescs.CD_int, color, ConstantDescs.CD_int);
        DirectMethodHandleDesc bsm = ConstantDescs.ofCallsiteBootstrap(
                ClassDesc.of("java.lang.runtime.SwitchBootstraps"), "enumSwitch",
                ConstantDescs.CD_CallSite, ConstantDescs.CD_Object.arrayType());
        DynamicCallSiteDesc site = DynamicCallSiteDesc.of(bsm, "enumSwitch", swType,
                "GREEN", "NOPE", "RED", "GREEN", "BLUE");
        byte[] bytes = ClassFile.of().build(self, cb -> {
            cb.withFlags(ClassFile.ACC_PUBLIC | ClassFile.ACC_FINAL);
            cb.withInterfaceSymbols(ClassDesc.of("JitEnumSwitch$Sw"));
            cb.withMethodBody("<init>", ConstantDescs.MTD_void, ClassFile.ACC_PUBLIC, b -> b
                    .aload(0).invokespecial(ConstantDescs.CD_Object, "<init>", ConstantDescs.MTD_void).return_());
            cb.withMethodBody("sw", swType, ClassFile.ACC_PUBLIC, b -> b
                    .aload(1).iload(2).invokedynamic(site).ireturn());
        });
        Class<?> k = MethodHandles.lookup().defineClass(bytes);
        return (Sw) k.getConstructor().newInstance();
    }
    static int viaSw(Sw s, Color c, int restart) {
        try {
            return s.sw(c, restart);
        } catch (IndexOutOfBoundsException e) {
            return -1000 - restart;
        }
    }

    static int threads() throws Exception {
        int[] out = new int[4];
        Thread[] t = new Thread[4];
        for (int k = 0; k < 4; k++) {
            final int id = k;
            t[k] = new Thread(() -> {
                int h = 0;
                for (int i = 0; i < 60000; i++) {
                    Color c = COLORS[(i + id) % 4];
                    h = h * 31 + full(c) + guarded(c, i + id) * 7 + partial(BIGS[(i * 13 + id) % 70]);
                }
                out[id] = h;
            });
            t[k].start();
        }
        int h = 0;
        for (int k = 0; k < 4; k++) { t[k].join(); h = h * 17 + out[k]; }
        return h;
    }

    public static void main(String[] args) throws Exception {
        for (int round = 0; round < 3; round++) {
            System.out.println("esw full " + round + " " + fullLoop(50000));
        }

        int h = 0;
        int[] counts = new int[16];
        for (int i = 0; i < 60000; i++) {
            Big b = (i % 71 == 70) ? null : BIGS[(i * 13) % 70];
            int r = partial(b);
            h = h * 31 + r;
            counts[r == -5 ? 0 : (r >= 11 && r <= 15) ? r - 10 : 6]++;
        }
        System.out.println("esw partial " + h + " " + java.util.Arrays.toString(counts));

        h = 0;
        for (int i = 0; i < 60000; i++) {
            Op o = (i % 9 == 8) ? null : OPS[i % 4];
            h = h * 31 + body(o, i, i % 13);
        }
        System.out.println("esw body " + h);

        h = 0;
        int[] g = new int[10];
        for (int i = 0; i < 80000; i++) {
            Color c = (i % 11 == 10) ? null : COLORS[(i / 3) % 4];
            int r = guarded(c, i % 10);
            g[r]++;
            h = h * 31 + r;
        }
        System.out.println("esw guarded " + h + " " + java.util.Arrays.toString(g));

        h = 0;
        int npes = 0;
        for (int i = 0; i < 40000; i++) {
            Color c = (i % 50 == 49) ? null : COLORS[i % 4];
            try {
                h = h * 31 + noNull(c, i % 3 - 1);
            } catch (NullPointerException e) {
                npes++;
            }
        }
        System.out.println("esw noNull " + h + " npes=" + npes);

        h = 0;
        for (int i = 0; i < 30000; i++) h = h * 31 + rare(null);
        for (int i = 0; i < 30000; i++) h = h * 31 + rare((i % 5 == 4) ? null : RARES[i % 3]);
        System.out.println("esw rare " + h);

        Sw sw = generated();
        h = 0;
        int[] gs = new int[8];
        for (int i = 0; i < 60000; i++) {
            Color c = (i % 13 == 12) ? null : COLORS[i % 4];
            int r = viaSw(sw, c, 0);
            gs[r + 1]++;
            h = h * 31 + r;
        }
        System.out.println("esw generated " + h + " " + java.util.Arrays.toString(gs));
        h = 0;
        for (int i = 0; i < 30000; i++) {
            Color c = (i % 13 == 12) ? null : COLORS[i % 4];
            int restart = (i % 17 == 0) ? (i / 17) % 8 - 1 : 0;    // -1 .. 6, past the labels too
            h = h * 31 + viaSw(sw, c, restart);
        }
        System.out.println("esw restart " + h);

        h = 0;
        for (int i = 0; i < 60000; i++) {
            Shape s = switch (i % 5) {
                case 0 -> new Circle(i % 20);
                case 1 -> new Square(i % 7);
                case 2 -> new Tri(i % 3, i % 4);
                case 3 -> null;
                default -> new Circle(3);
            };
            h = h * 31 + shape(s);
        }
        System.out.println("esw shape " + h);

        System.out.println("esw threads " + threads());
        System.out.println("esw done");
    }
}
