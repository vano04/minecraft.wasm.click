/* Emscripten compatibility shim: prctl(2) does not exist under wasm.
 * HotSpot uses it for thread naming, timer slack and THP hints; every caller
 * checks the return value, so a failing stub is safe. */
#ifndef _MCWEB_COMPAT_SYS_PRCTL_H
#define _MCWEB_COMPAT_SYS_PRCTL_H
#include <errno.h>
#ifdef __cplusplus
extern "C" {
#endif
#define PR_SET_NAME               15
#define PR_GET_NAME               16
#define PR_SET_TIMERSLACK         29
#define PR_GET_TIMERSLACK         30
#define PR_SET_THP_DISABLE        41
#define PR_GET_THP_DISABLE        42
#define PR_SET_VMA                0x53564d41
#define PR_SET_VMA_ANON_NAME      0
static inline int prctl(int option, ...) { (void)option; errno = EINVAL; return -1; }
#ifdef __cplusplus
}
#endif
#endif
