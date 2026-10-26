// Reproduces the classfile-writer path Minecraft's boot hammers: every lambda
// and every method reference spins a hidden class through
// jdk.internal.classfile, which is the JDK code the JIT compiles most of.
import java.util.function.*;
import java.util.*;
public class LambdaStress {
  interface F0 { int a(int x); }
  interface F1 { long b(long x, int y); }
  public static void main(String[] args) {
    long acc = 0;
    List<Supplier<String>> sups = new ArrayList<>();
    for (int i = 0; i < 400; i++) {
      final int k = i;
      IntUnaryOperator op = v -> v * k + 1;
      Function<String, Integer> f = st -> st.length() + k;
      BiFunction<Integer, Integer, Long> g = (a, b) -> (long) a * b + k;
      Supplier<String> sp = () -> "s" + k;
      Predicate<Object> p = o -> o != null && o.hashCode() != k;
      Comparator<String> cmp = Comparator.comparingInt(String::length);
      sups.add(sp);
      acc += op.applyAsInt(i) + f.apply("abc") + g.apply(i, 3) + (p.test(sp) ? 1 : 0);
      acc += cmp.compare("aa", "b");
      acc += sp.get().length();
    }
    for (Supplier<String> sp : sups) acc += sp.get().hashCode();
    Map<String, Integer> m = new HashMap<>();
    for (int i = 0; i < 20000; i++) m.merge("k" + (i % 500), i, Integer::sum);
    for (Map.Entry<String, Integer> en : m.entrySet()) acc += en.getValue();
    acc += String.join(",", m.keySet()).length();
    System.out.println("lambda " + acc);
  }
}
