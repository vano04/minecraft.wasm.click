/* Emscripten compatibility shim for <linux/random.h>.
 * Callers guard uses of GRND_* with #ifdef, so leaving them undefined selects
 * the portable /dev/urandom path. */
#ifndef _MCWEB_COMPAT_LINUX_RANDOM_H
#define _MCWEB_COMPAT_LINUX_RANDOM_H
#endif
