/* Emscripten compatibility shim: musl/emscripten has no dlvsym(3).
 * HotSpot only uses it to pick a versioned libnuma symbol, and libnuma does
 * not exist here, so falling back to dlsym is the correct behaviour. */
#ifndef _MCWEB_COMPAT_DLFCN_H
#define _MCWEB_COMPAT_DLFCN_H
#include_next <dlfcn.h>
#ifdef __cplusplus
extern "C" {
#endif
static inline void *dlvsym(void *handle, const char *name, const char *version) {
  (void)version;
  return dlsym(handle, name);
}
#ifdef __cplusplus
}
#endif
#endif
