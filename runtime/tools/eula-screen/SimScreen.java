// EULA similarity screen: bytecode-level LCS similarity of port methods vs Mojang methods.
// Port classes call Mojang APIs and do not restate Mojang method bodies. Provenance audits
// catch copied files and shader text. This screen catches re-typed logic. It reads Mojang's
// jar locally and writes scores only.
// Usage: java SimScreen.java <portClassesDir> <mojangJar> <outDir> [minTokens=15] [flag=0.6]
//   e.g. java -Xmx6g tools/eula-screen/SimScreen.java OpenJDK/mcweb/classes \
//          build/mojang-cache/versions/26.3/26.3.jar build/eula-screen
// Score >= 0.6 is the top decile on 26.3 (2026-10-13: 62 of 613 methods, all structural
// coincidences with unrelated Mojang methods on review); a hit against the port method's
// own Mojang namesake is what needs a human look.
// Tokens: one per instruction = mnemonic (slot/offset free) + member/type/constant where relevant.
// Score = LCS(a,b) / max(|a|,|b|). Search is exact within the 3x length window: candidates are
// ranked by the multiset-intersection upper bound (LCS <= |A ∩ B| as multisets) and LCS is
// computed until the bound cannot beat the best found.
import java.io.*;
import java.lang.classfile.*;
import java.lang.classfile.constantpool.*;
import java.lang.classfile.instruction.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.*;
import java.util.stream.*;
import java.util.zip.*;

public class SimScreen {
    static final Map<String, Integer> TOK = new HashMap<>();
    static final List<String> TOKNAME = new ArrayList<>();

    static synchronized int tok(String s) {
        Integer i = TOK.get(s);
        if (i == null) { i = TOKNAME.size(); TOK.put(s, i); TOKNAME.add(s); }
        return i;
    }

    record M(String id, int[] seq, int[] dTok, int[] dCnt) {}

    static String normOp(Opcode op) {
        String n = op.name();
        // drop implicit slot numbers: ALOAD_0 -> ALOAD, ISTORE_3 -> ISTORE; keep ICONST_n etc.
        if (n.matches("[AILFD](LOAD|STORE)_[0-3]")) return n.substring(0, n.length() - 2);
        if (n.endsWith("_W") && (n.contains("LOAD") || n.contains("STORE"))) return n.substring(0, n.length() - 2);
        if (n.equals("GOTO_W")) return "GOTO";
        if (n.equals("JSR_W")) return "JSR";
        if (n.equals("LDC_W") || n.equals("LDC2_W")) return "LDC";
        return n;
    }

    static String constStr(java.lang.constant.ConstantDesc d) {
        if (d instanceof String s) return "String:" + s;
        if (d instanceof Integer i) return "Integer:" + i;
        if (d instanceof Long l) return "Long:" + l;
        if (d instanceof Float f) return "Float:" + f;
        if (d instanceof Double x) return "Double:" + x;
        if (d instanceof java.lang.constant.ClassDesc c) return "Class:" + c.descriptorString();
        return d.getClass().getSimpleName() + ":" + d;
    }

    static int[] tokenize(CodeModel code) {
        List<Integer> out = new ArrayList<>();
        for (CodeElement e : code) {
            if (!(e instanceof Instruction ins)) continue; // labels, line numbers, local vars, stack maps
            String op = normOp(ins.opcode());
            String t;
            switch (ins) {
                case InvokeInstruction ii -> t = op + " " + ii.owner().asInternalName() + "." + ii.name().stringValue() + ii.type().stringValue();
                case FieldInstruction fi -> t = op + " " + fi.owner().asInternalName() + "." + fi.name().stringValue() + ":" + fi.type().stringValue();
                case InvokeDynamicInstruction di -> t = op + " " + di.name().stringValue() + di.type().stringValue() + " bsm=" + di.bootstrapMethod().owner().descriptorString() + "." + di.bootstrapMethod().methodName();
                case ConstantInstruction.LoadConstantInstruction lc -> t = "LDC " + constStr(lc.constantValue());
                case ConstantInstruction.ArgumentConstantInstruction ac -> t = op + " " + ac.constantValue();
                case NewObjectInstruction no -> t = op + " " + no.className().asInternalName();
                case NewReferenceArrayInstruction na -> t = op + " " + na.componentType().asInternalName();
                case NewPrimitiveArrayInstruction np -> t = op + " " + np.typeKind();
                case NewMultiArrayInstruction nm -> t = op + " " + nm.arrayType().asInternalName() + "/" + nm.dimensions();
                case TypeCheckInstruction tc -> t = op + " " + tc.type().asInternalName();
                case IncrementInstruction inc -> t = op + " " + inc.constant();
                default -> t = op; // loads/stores (slot dropped), branches (offset dropped), arithmetic, etc.
            }
            out.add(tok(t));
        }
        int[] a = new int[out.size()];
        for (int i = 0; i < a.length; i++) a[i] = out.get(i);
        return a;
    }

    static M mk(String id, int[] seq) {
        TreeMap<Integer, Integer> c = new TreeMap<>();
        for (int x : seq) c.merge(x, 1, Integer::sum);
        int[] dt = new int[c.size()], dc = new int[c.size()];
        int k = 0;
        for (var en : c.entrySet()) { dt[k] = en.getKey(); dc[k] = en.getValue(); k++; }
        return new M(id, seq, dt, dc);
    }

    static void addClass(byte[] bytes, List<M> out, int minTok) {
        ClassModel cm = ClassFile.of().parse(bytes);
        String cn = cm.thisClass().asInternalName();
        for (MethodModel mm : cm.methods()) {
            Optional<CodeModel> co = mm.code();
            if (co.isEmpty()) continue;
            int[] seq = tokenize(co.get());
            if (seq.length < minTok) continue;
            out.add(mk(cn + "." + mm.methodName().stringValue() + mm.methodType().stringValue(), seq));
        }
    }

    static int lcs(int[] a, int[] b) {
        if (a.length < b.length) { int[] t = a; a = b; b = t; }
        int[] prev = new int[b.length + 1], cur = new int[b.length + 1];
        for (int i = 1; i <= a.length; i++) {
            int ai = a[i - 1];
            for (int j = 1; j <= b.length; j++) {
                cur[j] = ai == b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
            }
            int[] t = prev; prev = cur; cur = t;
        }
        return prev[b.length];
    }

    record Hit(M port, M moj, double score, double jaccard, int lcsCalls) {}

    // inverted index over Mojang methods
    static int[][] postM, postC; // per token: mojang method idx, count
    static List<M> MOJ;

    static Hit search(M q, int excludeIdx) {
        int n = MOJ.size();
        int[] inter = new int[n];
        int[] touched = new int[n];
        int nt = 0;
        int ql = q.seq.length;
        for (int k = 0; k < q.dTok.length; k++) {
            int t = q.dTok[k], qc = q.dCnt[k];
            if (t >= postM.length || postM[t] == null) continue;
            int[] pm = postM[t], pc = postC[t];
            for (int i = 0; i < pm.length; i++) {
                int mi = pm[i];
                int ml = MOJ.get(mi).seq.length;
                if (ml * 3 < ql || ql * 3 < ml) continue; // length within 3x
                if (inter[mi] == 0) touched[nt++] = mi;
                inter[mi] += Math.min(qc, pc[i]);
            }
        }
        // order candidates by upper bound inter/max(len)
        long[] keyed = new long[nt];
        for (int i = 0; i < nt; i++) {
            int mi = touched[i];
            if (mi == excludeIdx) { keyed[i] = Long.MIN_VALUE; continue; }
            double ub = inter[mi] / (double) Math.max(ql, MOJ.get(mi).seq.length);
            keyed[i] = ((long) (ub * 1_000_000_000L) << 20) | mi; // mi < 2^20
        }
        Arrays.sort(keyed);
        double best = -1; int bestIdx = -1; int calls = 0;
        for (int i = nt - 1; i >= 0; i--) {
            if (keyed[i] == Long.MIN_VALUE) continue;
            int mi = (int) (keyed[i] & ((1 << 20) - 1));
            double ub = inter[mi] / (double) Math.max(ql, MOJ.get(mi).seq.length);
            if (ub <= best) break;
            int l = lcs(q.seq, MOJ.get(mi).seq);
            calls++;
            double s = l / (double) Math.max(ql, MOJ.get(mi).seq.length);
            if (s > best) { best = s; bestIdx = mi; }
        }
        if (bestIdx < 0) return new Hit(q, null, 0, 0, calls);
        M m = MOJ.get(bestIdx);
        double jac = inter[bestIdx] / (double) (ql + m.seq.length - inter[bestIdx]);
        return new Hit(q, m, best, jac, calls);
    }

    public static void main(String[] args) throws Exception {
        Path portDir = Path.of(args[0]), jar = Path.of(args[1]), outDir = Path.of(args[2]);
        int minTok = args.length > 3 ? Integer.parseInt(args[3]) : 15;
        double flag = args.length > 4 ? Double.parseDouble(args[4]) : 0.6;
        long t0 = System.currentTimeMillis();

        List<M> port = new ArrayList<>();
        int portAllMethods;
        {
            List<M> all = new ArrayList<>();
            try (Stream<Path> s = Files.walk(portDir)) {
                for (Path p : s.filter(p -> p.toString().endsWith(".class")).sorted().toList())
                    addClass(Files.readAllBytes(p), all, 1);
            }
            portAllMethods = all.size();
            for (M m : all) if (m.seq.length >= minTok) port.add(m);
        }
        List<M> moj = new ArrayList<>();
        int mojClasses = 0;
        try (ZipFile z = new ZipFile(jar.toFile())) {
            for (ZipEntry e : Collections.list(z.entries())) {
                if (!e.getName().endsWith(".class")) continue;
                try (InputStream in = z.getInputStream(e)) { addClass(in.readAllBytes(), moj, 1); }
                mojClasses++;
            }
        }
        MOJ = moj;
        if (moj.size() >= (1 << 20)) throw new IllegalStateException("too many methods");
        System.out.printf("port: %d methods with code, %d with >=%d tokens; mojang: %d classes, %d methods with code; %d distinct tokens; load %d ms%n",
                portAllMethods, port.size(), minTok, mojClasses, moj.size(), TOKNAME.size(), System.currentTimeMillis() - t0);

        // build inverted index
        int T = TOKNAME.size();
        int[] df = new int[T];
        for (M m : moj) for (int t : m.dTok) df[t]++;
        postM = new int[T][]; postC = new int[T][];
        for (int t = 0; t < T; t++) if (df[t] > 0) { postM[t] = new int[df[t]]; postC[t] = new int[df[t]]; }
        int[] fill = new int[T];
        for (int i = 0; i < moj.size(); i++) {
            M m = moj.get(i);
            for (int k = 0; k < m.dTok.length; k++) { int t = m.dTok[k]; postM[t][fill[t]] = i; postC[t][fill[t]++] = m.dCnt[k]; }
        }

        // self-check: 3 Mojang methods vs themselves (direct LCS) and through the search
        StringBuilder self = new StringBuilder();
        Map<String, Integer> mojIdx = new HashMap<>();
        for (int i = 0; i < moj.size(); i++) mojIdx.putIfAbsent(moj.get(i).id, i);
        List<Integer> picks = new ArrayList<>();
        Random r = new Random(263);
        while (picks.size() < 3) { int i = r.nextInt(moj.size()); if (moj.get(i).seq.length >= 40 && moj.get(i).id.startsWith("net/minecraft/")) picks.add(i); }
        for (int i : picks) {
            M m = moj.get(i);
            double direct = lcs(m.seq, m.seq) / (double) m.seq.length;
            Hit h = search(m, -1);
            self.append(String.format("self-check %s (%d tok): direct=%.3f search-best=%.3f -> %s%n", m.id, m.seq.length, direct, h.score, h.moj == null ? "-" : h.moj.id));
        }
        System.out.print(self);

        AtomicInteger done = new AtomicInteger();
        List<Hit> hits = port.parallelStream().map(p -> {
            Hit h = search(p, -1);
            int d = done.incrementAndGet();
            if (d % 200 == 0) System.out.printf("  %d/%d (%d ms)%n", d, port.size(), System.currentTimeMillis() - t0);
            return h;
        }).collect(Collectors.toList());
        hits.sort(Comparator.comparingDouble((Hit h) -> -h.score).thenComparing(h -> h.port.id));

        Files.createDirectories(outDir);
        try (PrintWriter w = new PrintWriter(Files.newBufferedWriter(outDir.resolve("all-scores.tsv")))) {
            w.println("score\tportTokens\tmojangTokens\tjaccardUB\tlcsCalls\tportMethod\tmojangMethod");
            for (Hit h : hits) w.printf("%.4f\t%d\t%d\t%.4f\t%d\t%s\t%s%n", h.score, h.port.seq.length, h.moj == null ? 0 : h.moj.seq.length, h.jaccard, h.lcsCalls, h.port.id, h.moj == null ? "-" : h.moj.id);
        }
        // distribution
        int[] bins = new int[10];
        for (Hit h : hits) bins[Math.min(9, (int) (h.score * 10))]++;
        double[] sc = hits.stream().mapToDouble(Hit::score).sorted().toArray();
        StringBuilder cal = new StringBuilder();
        cal.append(String.format("best-score distribution over %d port methods (>=%d tokens):%n", sc.length, minTok));
        for (int b = 0; b < 10; b++) cal.append(String.format("  [%.1f,%.1f%s %5d%n", b / 10.0, (b + 1) / 10.0, b == 9 ? "]" : ")", bins[b]));
        if (sc.length > 0) {
            double[] qs = {0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99};
            cal.append("  quantiles:");
            for (double q : qs) cal.append(String.format(" p%d=%.3f", (int) Math.round(q * 100), sc[Math.min(sc.length - 1, (int) (q * sc.length))]));
            cal.append(String.format(" max=%.3f mean=%.3f%n", sc[sc.length - 1], Arrays.stream(sc).average().orElse(0)));
        }
        // same-name check: port methods whose owner+name+desc also exists in the Mojang jar (shadows)
        int same = 0;
        for (M p : port) {
            Integer mi = mojIdx.get(p.id);
            if (mi == null) continue;
            M m = moj.get(mi);
            same++;
            cal.append(String.format("same-name %.3f (%d vs %d tok) %s%n", lcs(p.seq, m.seq) / (double) Math.max(p.seq.length, m.seq.length), p.seq.length, m.seq.length, p.id));
        }
        cal.append(String.format("same-name methods (>=%d tokens) also present in Mojang jar: %d%n", minTok, same));
        long flagged = hits.stream().filter(h -> h.score >= flag).count();
        cal.append(String.format("flagged (score >= %.2f): %d%n", flag, flagged));
        cal.append(self);
        System.out.print(cal);
        try (PrintWriter w = new PrintWriter(Files.newBufferedWriter(outDir.resolve("calibration.txt")))) { w.print(cal); }
        try (PrintWriter w = new PrintWriter(Files.newBufferedWriter(outDir.resolve("flagged.tsv")))) {
            w.println("score\tportTokens\tmojangTokens\tportMethod\tmojangMethod");
            for (Hit h : hits) if (h.score >= flag) w.printf("%.4f\t%d\t%d\t%s\t%s%n", h.score, h.port.seq.length, h.moj.seq.length, h.port.id, h.moj.id);
        }
        System.out.printf("done in %d ms%n", System.currentTimeMillis() - t0);
    }
}
