/* Emscripten compatibility shim: no eventfd(2) under wasm.
 *
 * java.base's NIO selector uses an eventfd purely as a self-pipe to wake a
 * blocked poll. A real pipe has the same semantics for that use, so this
 * implements the eventfd API on top of pipe(2), which emscripten does provide.
 * The counter semantics are approximated: each write pushes 8 bytes, each read
 * drains them, which is all the wakeup path relies on.
 */
#ifndef _MCWEB_COMPAT_SYS_EVENTFD_H
#define _MCWEB_COMPAT_SYS_EVENTFD_H

#include <stdint.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef uint64_t eventfd_t;

#define EFD_SEMAPHORE 00000001
#define EFD_CLOEXEC   02000000
#define EFD_NONBLOCK  00004000

/* The read end is returned; the write end is stashed so writes can find it.
 * Only a handful of eventfds ever exist, so a small table is sufficient. */
#define _MCWEB_EVENTFD_MAX 64
static int _mcweb_eventfd_write_end[_MCWEB_EVENTFD_MAX];
static int _mcweb_eventfd_init;

static inline int eventfd(unsigned int initval, int flags) {
  int fds[2];
  (void)initval;
  if (!_mcweb_eventfd_init) {
    for (int i = 0; i < _MCWEB_EVENTFD_MAX; i++) _mcweb_eventfd_write_end[i] = -1;
    _mcweb_eventfd_init = 1;
  }
  if (pipe(fds) != 0) return -1;
  if (flags & EFD_NONBLOCK) {
    fcntl(fds[0], F_SETFL, fcntl(fds[0], F_GETFL, 0) | O_NONBLOCK);
    fcntl(fds[1], F_SETFL, fcntl(fds[1], F_GETFL, 0) | O_NONBLOCK);
  }
  if (fds[0] < 0 || fds[0] >= _MCWEB_EVENTFD_MAX) { close(fds[0]); close(fds[1]); errno = EMFILE; return -1; }
  _mcweb_eventfd_write_end[fds[0]] = fds[1];
  return fds[0];
}

static inline int eventfd_write(int fd, eventfd_t value) {
  int w = (fd >= 0 && fd < _MCWEB_EVENTFD_MAX) ? _mcweb_eventfd_write_end[fd] : -1;
  if (w < 0) { errno = EBADF; return -1; }
  return write(w, &value, sizeof value) == (ssize_t)sizeof value ? 0 : -1;
}

static inline int eventfd_read(int fd, eventfd_t *value) {
  eventfd_t v = 0;
  if (read(fd, &v, sizeof v) != (ssize_t)sizeof v) return -1;
  if (value) *value = v;
  return 0;
}

#ifdef __cplusplus
}
#endif

#endif
