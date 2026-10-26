import java.lang.classfile.ClassFile;
import java.lang.classfile.Label;
import java.lang.constant.ConstantDescs;
import java.lang.constant.MethodTypeDesc;

/** Minimal classfile-api workload that repeatedly enters DirectCodeBuilder$4.writeBody. */
public class DirectCodeProbe {
  public static void main(String[] args) {
    ClassFile cf = ClassFile.of();
    MethodTypeDesc mt = MethodTypeDesc.of(ConstantDescs.CD_boolean,
        ConstantDescs.CD_Object.arrayType());
    long bytes = 0;
    for (int i = 0; i < 3000; i++) {
      final int n = i;
      byte[] out = cf.build(java.lang.constant.ClassDesc.of("Probe" + n), cb ->
          cb.withMethodBody("m", mt, ClassFile.ACC_PUBLIC | ClassFile.ACC_STATIC, code -> {
            Label yes = code.newLabel();
            code.aload(0);
            code.ifnull(yes);
            code.iconst_0();
            code.ireturn();
            code.labelBinding(yes);
            code.iconst_1();
            code.ireturn();
          }));
      bytes += out.length;
    }
    System.out.println("direct-code " + bytes);
  }
}
