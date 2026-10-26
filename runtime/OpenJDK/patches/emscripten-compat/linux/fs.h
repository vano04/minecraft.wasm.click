/* Emscripten compatibility shim for <linux/fs.h>.
 *
 * The wasm virtual filesystem has no block devices, so the ioctl() below is
 * unreachable in practice (it is guarded by S_ISBLK). The constant is defined
 * with its real Linux value only so the guarded code compiles. */
#ifndef _MCWEB_COMPAT_LINUX_FS_H
#define _MCWEB_COMPAT_LINUX_FS_H

#ifndef BLKGETSIZE64
#define BLKGETSIZE64 0x80081272 /* _IOR(0x12, 114, size_t) */
#endif

#endif
