/** A callee with exactly two forward branch targets -- the shape that broke. */
public class JitBranch {
    static int clamp(int v, int lo, int hi) {
        if (v < lo) return lo;
        if (v > hi) return hi;
        return v;
    }
    static int one(int v) {          // a single target, known good
        if (v < 0) return 0;
        return v;
    }
    static int hot(int n) {
        int a = 0;
        for (int i = 0; i < n; i++) a += clamp(i - 50, 0, 100) + one(i - 900);
        return a;
    }
    public static void main(String[] args) {
        long s = 0;
        for (int r = 0; r < 400; r++) s += hot(1000);
        System.out.println("branch " + s);
    }
}
