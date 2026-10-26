/**
 * Record hashCode folds whose reference components' hashCode allocates, run
 * with a small heap so collections happen inside the fold. Per shape: how
 * many hashes differ from the one taken before anything was compiled.
 * Lines starting with "rgc" must be identical with and without the JIT.
 */
public class JitRecordGc {
    static final class Name {
        final int v;
        Name(int v) { this.v = v; }
        static Object[] keep = new Object[64];
        static int next;
        @Override public int hashCode() { keep[next++ & 63] = new byte[2048]; return v * 17; }
    }
    record R1(Name a) { }
    record R2(Name a, float f) { }
    record R3(float f, Name a) { }
    record R4(Name a, Name b) { }
    record R5(Name a, int i, Name b, float f) { }
    record R6(R1 inner, float f) { }
    record R7(float[] arr, float f) { }
    record R8(java.util.List<R1> list, float f) { }
    interface Fn { }
    record Impl(Name n) implements Fn { }
    record R9<I extends Fn>(I fn, float f) { }
    record R10(Name a, float[] arr) { }
    static final class C11 {
        final Name a; final float[] arr;
        C11(Name a, float[] arr) { this.a = a; this.arr = arr; }
        @Override public int hashCode() { return 31 * java.util.Objects.hashCode(a) + java.util.Objects.hashCode(arr); }
    }
    static final class C12 {
        final Name a; final float[] arr;
        C12(Name a, float[] arr) { this.a = a; this.arr = arr; }
        @Override public int hashCode() { return 31 * a.hashCode() + System.identityHashCode(arr); }
    }

    static int check(Object[] objs, int[] first) {
        int drift = 0;
        for (int i = 0; i < objs.length; i++) if (objs[i].hashCode() != first[i]) drift++;
        return drift;
    }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 3000;
        String[] names = {"R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "C11", "C12"};
        Object[][] sets = new Object[12][16];
        for (int i = 0; i < 16; i++) {
            sets[0][i] = new R1(new Name(i));
            sets[1][i] = new R2(new Name(i), i * 0.5f);
            sets[2][i] = new R3(i * 0.25f, new Name(i + 1));
            sets[3][i] = new R4(new Name(i), new Name(i * 3));
            sets[4][i] = new R5(new Name(i), i * 7, new Name(i + 2), -i * 1.5f);
            sets[5][i] = new R6(new R1(new Name(i * 5)), i + 0.125f);
            sets[6][i] = new R7(new float[] {i, i * 2f}, i + 0.5f);
            sets[7][i] = new R8(java.util.List.of(new R1(new Name(i)), new R1(new Name(i + 9))), i * 3f);
            sets[8][i] = new R9<>(new Impl(new Name(i * 11)), i - 0.75f);
            sets[9][i] = new R10(new Name(i), new float[] {i});
            sets[10][i] = new C11(new Name(i), new float[] {i});
            sets[11][i] = new C12(new Name(i), new float[] {i});
        }
        int[][] first = new int[12][16];
        for (int s = 0; s < 12; s++) for (int i = 0; i < 16; i++) first[s][i] = sets[s][i].hashCode();
        int[] drift = new int[12];
        for (int r = 0; r < rounds; r++) for (int s = 0; s < 12; s++) drift[s] += check(sets[s], first[s]);
        for (int s = 0; s < 12; s++) System.out.println("rgc " + names[s] + " drift " + drift[s]);
    }
}
