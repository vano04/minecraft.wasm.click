// A benchmark shaped like Minecraft's hot loops rather than like a compiler
// test: small virtual calls through a polymorphic interface, getters, field
// reads, short-lived allocation and array indexing. JitBench measures the
// interpreter's arithmetic; this measures what the client actually spends its
// time on, which is the call sequence.
public class ShapeBench {
  interface Block { int light(int x, int y, int z); boolean solid(); }
  static final class Stone implements Block {
    public int light(int x, int y, int z) { return 0; }
    public boolean solid() { return true; }
  }
  static final class Air implements Block {
    public int light(int x, int y, int z) { return 15; }
    public boolean solid() { return false; }
  }
  static final class Leaves implements Block {
    int tint;
    Leaves(int t) { tint = t; }
    public int light(int x, int y, int z) { return (x + y + z + tint) & 15; }
    public boolean solid() { return false; }
  }
  static final class Water implements Block {
    public int light(int x, int y, int z) { return (y & 7) + 2; }
    public boolean solid() { return false; }
  }

  static final class Pos {
    final int x, y, z;
    Pos(int x, int y, int z) { this.x = x; this.y = y; this.z = z; }
    int getX() { return x; }
    int getY() { return y; }
    int getZ() { return z; }
    Pos offset(int dx, int dy, int dz) { return new Pos(x + dx, y + dy, z + dz); }
  }

  static Block[] palette = new Block[16];
  static byte[] ids = new byte[16 * 16 * 16];

  // getter-only: measures the pure call sequence
  static int getters(Pos p) { return p.getX() + p.getY() + p.getZ(); }

  public static void main(String[] args) {
    palette[0] = new Air();
    for (int i = 1; i < 16; i++)
      palette[i] = (i % 4 == 0) ? new Stone() : (i % 4 == 1) ? new Water() : (i % 4 == 2) ? new Leaves(i) : new Air();
    for (int i = 0; i < ids.length; i++) ids[i] = (byte)(i & 15);

    long t;
    int sink = 0;

    // 1. polymorphic virtual dispatch over a chunk section, the mesher's shape
    t = System.nanoTime();
    for (int rep = 0; rep < 60; rep++) {
      for (int y = 0; y < 16; y++)
        for (int z = 0; z < 16; z++)
          for (int x = 0; x < 16; x++) {
            Block b = palette[ids[(y << 8) | (z << 4) | x] & 15];
            if (!b.solid()) sink += b.light(x, y, z);
          }
    }
    System.out.println("poly-dispatch  " + (System.nanoTime() - t) / 1000000 + " ms   sink=" + sink);

    // 2. tiny final getters, no polymorphism
    Pos p = new Pos(3, 4, 5);
    t = System.nanoTime();
    for (int i = 0; i < 3000000; i++) sink += getters(p);
    System.out.println("getters        " + (System.nanoTime() - t) / 1000000 + " ms   sink=" + sink);

    // 3. allocation of short-lived objects, BlockPos.offset's shape
    t = System.nanoTime();
    for (int i = 0; i < 1000000; i++) { Pos q = p.offset(i & 7, i & 3, i & 1); sink += q.x + q.z; }
    System.out.println("alloc          " + (System.nanoTime() - t) / 1000000 + " ms   sink=" + sink);

    // 4. straight-line arithmetic, the part the JIT already covers
    t = System.nanoTime();
    int acc = 0;
    for (int i = 0; i < 20000000; i++) acc += (i * 31) ^ (i >>> 3);
    System.out.println("arith          " + (System.nanoTime() - t) / 1000000 + " ms   sink=" + acc);

    // 5. static calls with a couple of arguments
    t = System.nanoTime();
    for (int i = 0; i < 3000000; i++) sink += clamp(i & 255, 10, 200) + floor(i * 0.5);
    System.out.println("static-calls   " + (System.nanoTime() - t) / 1000000 + " ms   sink=" + sink);
  }

  static int clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
  static int floor(double d) { int i = (int)d; return d < i ? i - 1 : i; }
}
