/* Emscripten compatibility shim: no Linux UAPI headers under wasm.
 * The JDK sources that include <linux/types.h> guard every use of its contents
 * with #ifdef, so an empty header yields the correct "feature absent" path. */
#ifndef _MCWEB_COMPAT_LINUX_TYPES_H
#define _MCWEB_COMPAT_LINUX_TYPES_H
#endif
