package com.oracle.svm.webimage.wasmgc.annotation;

import java.lang.annotation.*;

/** Compile-only stand-in; see org.graalvm.webimage.api.JS. */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface WasmExport {
    String value();
    String comment() default "";
}
