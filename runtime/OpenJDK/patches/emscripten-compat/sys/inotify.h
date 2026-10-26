/* Emscripten compatibility shim: no inotify(7) under wasm.
 *
 * There is no kernel to deliver filesystem change events, so every entry point
 * fails with ENOSYS. LinuxWatchService then reports that watching is
 * unavailable rather than silently missing events, which is the honest
 * behaviour for this target.
 */
#ifndef _MCWEB_COMPAT_SYS_INOTIFY_H
#define _MCWEB_COMPAT_SYS_INOTIFY_H

#include <stdint.h>
#include <errno.h>

#ifdef __cplusplus
extern "C" {
#endif

struct inotify_event {
  int      wd;
  uint32_t mask;
  uint32_t cookie;
  uint32_t len;
  char     name[];
};

#define IN_MODIFY        0x00000002
#define IN_ATTRIB        0x00000004
#define IN_MOVED_FROM    0x00000040
#define IN_MOVED_TO      0x00000080
#define IN_CREATE        0x00000100
#define IN_DELETE        0x00000200
#define IN_UNMOUNT       0x00002000
#define IN_Q_OVERFLOW    0x00004000
#define IN_IGNORED       0x00008000
#define IN_NONBLOCK      00004000
#define IN_CLOEXEC       02000000

static inline int inotify_init(void)  { errno = ENOSYS; return -1; }
static inline int inotify_init1(int flags) { (void)flags; errno = ENOSYS; return -1; }
static inline int inotify_add_watch(int fd, const char *path, uint32_t mask) {
  (void)fd; (void)path; (void)mask; errno = ENOSYS; return -1;
}
static inline int inotify_rm_watch(int fd, int wd) {
  (void)fd; (void)wd; errno = ENOSYS; return -1;
}

#ifdef __cplusplus
}
#endif

#endif
