/* Emscripten compatibility shim: no futex(2) syscall under wasm.
 *
 * Emscripten implements the same wait/wake semantics on top of the wasm
 * threads proposal (memory.atomic.wait32 / memory.atomic.notify), exposed as
 * emscripten_futex_wait/emscripten_futex_wake. This header maps HotSpot's
 * futex uses onto them and reports Linux-style return values.
 *
 * NOTE: emscripten_futex_wait blocks, which the browser forbids on the main
 * thread. This build must therefore run the VM on a Worker (-sPROXY_TO_PTHREAD).
 */
#ifndef _MCWEB_COMPAT_LINUX_FUTEX_H
#define _MCWEB_COMPAT_LINUX_FUTEX_H

#include <errno.h>
#include <limits.h>
#include <stdint.h>

#define FUTEX_WAIT              0
#define FUTEX_WAKE              1
#define FUTEX_PRIVATE_FLAG      128
#define FUTEX_WAIT_PRIVATE      (FUTEX_WAIT | FUTEX_PRIVATE_FLAG)
#define FUTEX_WAKE_PRIVATE      (FUTEX_WAKE | FUTEX_PRIVATE_FLAG)

#ifdef __cplusplus
extern "C" {
#endif

extern int emscripten_futex_wait(volatile void *addr, unsigned int val, double max_wait_ms);
extern int emscripten_futex_wake(volatile void *addr, int count);

/* Returns Linux futex(2) conventions: 0 / count on success, -1 + errno. */
static inline long mcweb_futex(volatile int *addr, int op, int val) {
  switch (op & ~FUTEX_PRIVATE_FLAG) {
    case FUTEX_WAIT: {
      int rc = emscripten_futex_wait(addr, (unsigned int)val, (double)(1.0 / 0.0));
      if (rc == 0) return 0;
      errno = -rc;            /* -EWOULDBLOCK / -ETIMEDOUT / -EINVAL */
      return -1;
    }
    case FUTEX_WAKE:
      return emscripten_futex_wake(addr, val);
    default:
      errno = ENOSYS;
      return -1;
  }
}

#ifdef __cplusplus
}
#endif

#endif
