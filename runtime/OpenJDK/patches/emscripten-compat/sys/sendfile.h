/* Emscripten compatibility shim: musl-on-wasm has no sendfile(2).
 * HotSpot only uses it for os::Linux::sendfile (a copy fast path), so a
 * read/write loop is a correct, if slower, substitute. */
#ifndef _MCWEB_COMPAT_SYS_SENDFILE_H
#define _MCWEB_COMPAT_SYS_SENDFILE_H

#include <sys/types.h>
#include <unistd.h>
#include <errno.h>

#ifdef __cplusplus
extern "C" {
#endif

static inline ssize_t sendfile(int out_fd, int in_fd, off_t *offset, size_t count) {
  char buf[8192];
  size_t remaining = count;
  ssize_t total = 0;
  if (offset != 0 && lseek(in_fd, *offset, SEEK_SET) == (off_t)-1) return -1;
  while (remaining > 0) {
    size_t want = remaining < sizeof buf ? remaining : sizeof buf;
    ssize_t got = read(in_fd, buf, want);
    if (got < 0) return total > 0 ? total : -1;
    if (got == 0) break;
    ssize_t put = 0;
    while (put < got) {
      ssize_t w = write(out_fd, buf + put, (size_t)(got - put));
      if (w < 0) return total > 0 ? total : -1;
      put += w;
    }
    total += got;
    remaining -= (size_t)got;
  }
  if (offset != 0) *offset += total;
  return total;
}

#ifdef __cplusplus
}
#endif

#endif
