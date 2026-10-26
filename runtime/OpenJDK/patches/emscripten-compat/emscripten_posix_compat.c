/* POSIX facilities HotSpot/java.base reference that Emscripten's libc does not
 * provide. These are linked into the MAIN_MODULE so the side modules
 * (libjvm.so, libjava.so, ...) resolve them dynamically at load time.
 *
 * Every stub here is either a faithful emulation or a documented, visible
 * failure. Nothing silently pretends to succeed. */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE   /* for cpu_set_t / sched_getaffinity prototypes */
#endif

#include <errno.h>
#include <sched.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/threading.h>
#endif

/* ---- CPU affinity ---------------------------------------------------------
 * There is no affinity concept in a browser. Report every logical processor
 * the host says it has, so HotSpot sizes its GC/worker pools sensibly. */
int sched_getaffinity(pid_t pid, size_t cpusetsize, cpu_set_t *mask) {
  (void)pid;
  if (mask == 0 || cpusetsize == 0) { errno = EINVAL; return -1; }
  memset(mask, 0, cpusetsize);
#ifdef __EMSCRIPTEN__
  int n = emscripten_num_logical_cores();
#else
  int n = 1;
#endif
  if (n < 1) n = 1;
  size_t bits = cpusetsize * 8;
  if ((size_t)n > bits) n = (int)bits;
  unsigned char *bytes = (unsigned char *)mask;
  for (int i = 0; i < n; i++) bytes[i / 8] |= (unsigned char)(1u << (i % 8));
  return 0;
}

int sched_setaffinity(pid_t pid, size_t cpusetsize, const cpu_set_t *mask) {
  (void)pid; (void)cpusetsize; (void)mask;
  errno = ENOSYS;
  return -1;
}

/* glibc's CPU_COUNT() expands to this helper; emscripten's libc has no copy. */
int __sched_cpucount(size_t setsize, const cpu_set_t *setp) {
  const unsigned char *bytes = (const unsigned char *)setp;
  int count = 0;
  for (size_t i = 0; i < setsize; i++) {
    unsigned char b = bytes[i];
    while (b) { count += b & 1; b >>= 1; }
  }
  return count;
}

/* ---- Current CPU ----------------------------------------------------------
 * A wasm thread has no observable CPU affinity and NUMA does not exist here,
 * so every thread reports CPU 0. HotSpot only uses this to pick a NUMA node
 * or to stripe per-CPU data structures; a constant is correct, just uniform. */
int sched_getcpu(void) { return 0; }

/* ---- Facilities with no wasm equivalent -----------------------------------
 * These are declared by the JDK's Linux sources but absent from emscripten's
 * libc. Each fails visibly rather than pretending to work. */
#include <sys/sysinfo.h>
#include <dlfcn.h>

int sysinfo(struct sysinfo *info) {
  /* There is no kernel to ask. Callers in HotSpot treat a failure as "memory
   * information unavailable" and fall back to the -Xmx bounds. */
  (void)info;
  errno = ENOSYS;
  return -1;
}

int dlinfo(void *handle, int request, void *info) {
  (void)handle; (void)request; (void)info;
  return -1;
}

/* Extended attributes: the wasm virtual filesystem stores none. */
ssize_t fgetxattr(int fd, const char *name, void *value, size_t size) {
  (void)fd; (void)name; (void)value; (void)size; errno = ENOTSUP; return -1;
}
ssize_t flistxattr(int fd, char *list, size_t size) {
  (void)fd; (void)list; (void)size; errno = ENOTSUP; return -1;
}
int fremovexattr(int fd, const char *name) {
  (void)fd; (void)name; errno = ENOTSUP; return -1;
}
int fsetxattr(int fd, const char *name, const void *value, size_t size, int flags) {
  (void)fd; (void)name; (void)value; (void)size; (void)flags; errno = ENOTSUP; return -1;
}

/* ---- Forced linkage -------------------------------------------------------
 * These do exist in emscripten's libc, but nothing in the MAIN_MODULE
 * references them, so the linker would drop them and the side modules would
 * fail to resolve them at dlopen time. Referencing them here pulls them in. */
#include <netdb.h>
#include <signal.h>
#include <stdlib.h>

__attribute__((used))
static void *const mcweb_forced_symbols[] = {
  (void *)&getaddrinfo,
  (void *)&getnameinfo,
  (void *)&freeaddrinfo,
  (void *)&gai_strerror,
  (void *)&exit,
};

/* No signals are ever delivered under wasm, so a suspend that waits for one
 * would block forever. Sleep briefly and report the standard EINTR so callers
 * take their "interrupted, loop again" path instead of deadlocking. */
int sigsuspend(const sigset_t *mask) {
  (void)mask;
  usleep(100000);
  errno = EINTR;
  return -1;
}
