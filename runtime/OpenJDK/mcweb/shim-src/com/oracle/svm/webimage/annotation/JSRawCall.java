package com.oracle.svm.webimage.annotation;

import java.lang.annotation.*;

/** Compile-only stand-in; see org.graalvm.webimage.api.JS. */
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.CONSTRUCTOR})
public @interface JSRawCall {
}
