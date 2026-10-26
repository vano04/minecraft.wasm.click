/**
 * checkcast and instanceof against classes that are still unresolved when
 * the method compiles: the rare path that first touches them runs only after
 * many iterations. Compiled code reads the constant pool's resolved-class
 * slot at run time instead of bailing. Includes a failing cast.
 */
public class JitLateClass {
    static class LateA { int v = 3; }
    static class LateB extends LateA { LateB() { v = 5; } }
    interface LateI { int w(); }
    static class LateC implements LateI { public int w() { return 11; } }

    static Object make(int i, int n) {
        if (i < n / 2) return (i & 1) == 0 ? "s" : Integer.valueOf(i);
        switch (i % 4) { case 0: return new LateA(); case 1: return new LateB(); case 2: return new LateC(); default: return "t"; }
    }

    static volatile int SV;
    static volatile boolean SB;
    static volatile Object SO;
    static long step(Object o) {
        long h = 0;
        SV = SV + 1; SB = !SB; SO = (SV & 3) == 0 ? o : null;     // static volatiles, compiled as atomics
        h += (SB ? 1 : 2) + (SO == null ? 0 : 5);
        if (o instanceof LateA) h += ((LateA) o).v;
        if (o instanceof LateI) h += ((LateI) o).w() * 3;
        if (o instanceof LateB) h += 100;
        try { h += ((LateB) o).v * 7; } catch (ClassCastException e) { h += 1; }
        return h;
    }

    public static void main(String[] args) {
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 200000;
        long h = 0;
        for (int i = 0; i < n; i++) h = h * 31 + step(make(i, n));
        System.out.println("late " + h + " " + SV);
    }
}
