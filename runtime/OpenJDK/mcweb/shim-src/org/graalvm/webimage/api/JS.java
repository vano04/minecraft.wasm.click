package org.graalvm.webimage.api;

import java.lang.annotation.*;

/**
 * Compile-only stand-in for GraalVM Web Image's @JS. This lane runs on HotSpot,
 * where the JS body is supplied by a generated JNI bridge instead; the
 * annotation is kept only so the MC-Web sources compile unchanged.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.CONSTRUCTOR})
public @interface JS {
    String value() default "";
    String[] args() default {};

    @Retention(RetentionPolicy.RUNTIME)
    @Target({ElementType.METHOD, ElementType.CONSTRUCTOR, ElementType.TYPE})
    @interface Coerce {
    }

    @Retention(RetentionPolicy.RUNTIME)
    @Target({ElementType.METHOD, ElementType.CONSTRUCTOR, ElementType.TYPE})
    @interface Export {
    }
}
