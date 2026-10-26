"""Generate owned Java code that repeatedly changes profiled call targets."""
import pathlib, sys
out=pathlib.Path(sys.argv[1]); out.parent.mkdir(parents=True,exist_ok=True)
lines=['public final class RetirementStress {','  interface Op { int apply(int x); }']
for n in range(8):
 lines.append(f'  static final class Op{n} implements Op {{ public int apply(int x) {{ return (x ^ {n*7919+17}) + (x >>> {n%5+1}); }} }}')
for n in range(3000):
 lines.append(f'  static int m{n}(Op op,int x) {{ return op.apply(x + {n}) ^ {n*17+3}; }}')
for group in range(30):
 lines.append(f'  static int g{group}(int i,Op op,int x) {{ switch(i) {{')
 for k in range(100): lines.append(f'    case {k}: return m{group*100+k}(op,x);')
 lines.append('    default: throw new AssertionError(i); } }')
lines.append('  static int dispatch(int i,Op op,int x) { switch(i/100) {')
for group in range(30): lines.append(f'    case {group}: return g{group}(i%100,op,x);')
lines.extend(['    default: throw new AssertionError(i); } }','  public static void main(String[] args) {','    Op[] ops={'+','.join(f'new Op{i}()' for i in range(8))+'};','    int sum=1;','    for(Op op:ops) for(int round=0;round<100;round++) for(int i=0;i<3000;i++) sum=sum*31+dispatch(i,op,sum);','    System.out.println("RETIREMENT-CHECKSUM "+Integer.toUnsignedString(sum));','  }','}'])
out.write_text('\n'.join(lines)+'\n')
