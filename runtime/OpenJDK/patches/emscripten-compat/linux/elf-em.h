/* Emscripten compatibility shim: no Linux UAPI headers.
 * HotSpot uses only the EM_* machine constants from this header. */
#ifndef _MCWEB_COMPAT_LINUX_ELF_EM_H
#define _MCWEB_COMPAT_LINUX_ELF_EM_H
#include <elf.h>
/* EM_486 is a Linux-UAPI-only alias that never shipped in glibc's <elf.h>. */
#ifndef EM_486
#define EM_486 6
#endif
#endif
