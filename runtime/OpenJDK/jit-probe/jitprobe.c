/*
 * Feasibility gate for a wasm JIT under Zero.
 *
 * wasm has no writable-executable memory: you cannot emit bytes into linear
 * memory and jump to them. The only runtime code path a browser offers is
 * building a *new* WebAssembly.Module from bytes and calling it indirectly
 * through the shared function table. This probe answers, in isolation, the
 * three questions any JIT design depends on:
 *
 *   1. can code generated at runtime read and write the JVM's own linear
 *      memory (it must: Java objects, the operand stack and locals all live
 *      there, and the GC scans it),
 *   2. what does compiling one method cost (module build + instantiate),
 *   3. what does calling into it cost, against a direct call.
 */
#include <emscripten.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Emits a module that imports the main memory and exports one function:
 *   (i32 ptr) -> i32 { i32.store(ptr, i32.load(ptr) + addend); return load; }
 * The addend is baked in as a constant, which is what makes each compiled
 * body distinct — the same thing a real JIT does with a method's constants. */
static unsigned char *leb_u(unsigned char *p, unsigned v) {
  do { unsigned char b = v & 0x7f; v >>= 7; if (v) b |= 0x80; *p++ = b; } while (v);
  return p;
}
static unsigned char *leb_s(unsigned char *p, int v) {
  for (;;) {
    unsigned char b = v & 0x7f; v >>= 7;
    if ((v == 0 && !(b & 0x40)) || (v == -1 && (b & 0x40))) { *p++ = b; return p; }
    *p++ = b | 0x80;
  }
}
/* id + LEB(size) + body, so no section length is ever hand-counted. */
static unsigned char *section(unsigned char *p, int id,
                              const unsigned char *body, int len) {
  *p++ = (unsigned char)id;
  p = leb_u(p, (unsigned)len);
  memcpy(p, body, len);
  return p + len;
}

/* Emits a module that imports the main memory and exports one function:
 *   (i32 ptr) -> i32 { store(ptr, load(ptr) + addend); return load(ptr); }
 * The addend is baked in as a constant, so every body is distinct and nothing
 * in the engine can cache a previous compile -- the same property a real JIT
 * has, where each method compiles to different code. */
static int build_module(unsigned char *out, int addend) {
  unsigned char *p = out;
  static const unsigned char magic[] = { 0x00,0x61,0x73,0x6d, 0x01,0x00,0x00,0x00 };
  memcpy(p, magic, sizeof(magic)); p += sizeof(magic);

  unsigned char buf[128], *b;

  /* type: one functype (i32) -> (i32) */
  b = buf;
  *b++ = 0x01; *b++ = 0x60; *b++ = 0x01; *b++ = 0x7f; *b++ = 0x01; *b++ = 0x7f;
  p = section(p, 1, buf, (int)(b - buf));

  /* import: env.memory. Shared (flags 0x03) with a maximum wide enough to
     accept whatever the host negotiated: an import's declared limits must
     contain the real ones. */
  b = buf;
  *b++ = 0x01;                                  /* one import */
  *b++ = 3; memcpy(b, "env", 3); b += 3;
  *b++ = 6; memcpy(b, "memory", 6); b += 6;
  *b++ = 0x02;                                  /* kind: memory */
  *b++ = 0x03;                                  /* shared + has max */
  b = leb_u(b, 0);                              /* min pages */
  b = leb_u(b, 65536);                          /* max pages */
  p = section(p, 2, buf, (int)(b - buf));

  /* function: one func, type 0 */
  b = buf; *b++ = 0x01; *b++ = 0x00;
  p = section(p, 3, buf, (int)(b - buf));

  /* export: "f" -> func 0 */
  b = buf;
  *b++ = 0x01; *b++ = 1; *b++ = 'f'; *b++ = 0x00; *b++ = 0x00;
  p = section(p, 7, buf, (int)(b - buf));

  /* code */
  unsigned char body[64], *c = body;
  *c++ = 0x00;                             /* no locals */
  *c++ = 0x20; *c++ = 0x00;                /* local.get 0            (ptr) */
  *c++ = 0x20; *c++ = 0x00;                /* local.get 0            (ptr) */
  *c++ = 0x28; *c++ = 0x02; *c++ = 0x00;   /* i32.load  align=2 off=0     */
  *c++ = 0x41; c = leb_s(c, addend);       /* i32.const <addend>          */
  *c++ = 0x6a;                             /* i32.add                     */
  *c++ = 0x36; *c++ = 0x02; *c++ = 0x00;   /* i32.store align=2 off=0     */
  *c++ = 0x20; *c++ = 0x00;                /* local.get 0                 */
  *c++ = 0x28; *c++ = 0x02; *c++ = 0x00;   /* i32.load  -> result         */
  *c++ = 0x0b;                             /* end                         */
  int bodyLen = (int)(c - body);

  b = buf;
  *b++ = 0x01;                             /* one function body */
  b = leb_u(b, (unsigned)bodyLen);
  memcpy(b, body, bodyLen); b += bodyLen;
  p = section(p, 10, buf, (int)(b - buf));

  return (int)(p - out);
}

/* Instantiate the module and install its export in the main module's table.
 * Returns the table index, which in Emscripten *is* a C function pointer. */
EM_JS(int, install_wasm, (const unsigned char *bytes, int len), {
  try {
    const src = HEAPU8.subarray(bytes, bytes + len);
    const mod = new WebAssembly.Module(src);
    const inst = new WebAssembly.Instance(mod, { env: { memory: wasmMemory } });
    globalThis.__probeLast = inst.exports.f;
    const idx = wasmTable.grow(1);
    wasmTable.set(idx, inst.exports.f);
    return idx;
  } catch (e) {
    if (!Module.__jitErr) { Module.__jitErr = 1; err('install failed: ' + e); }
    return -1;
  }
});

typedef int (*jitfn)(int *);

/* The JIT cannot use the table (Emscripten's dynamic linker owns it), so it
 * calls generated code through an import instead. Whether compiled code can be
 * re-entered after every interpreter-handled call depends entirely on what
 * that crossing costs, so measure it against the table call. */
EM_JS(int, call_via_js, (int idx, int cell), {
  return globalThis.__probeFns[idx](cell);
});
EM_JS(void, stash_last, (void), {
  globalThis.__probeFns ||= [];
  globalThis.__probeFns[0] = globalThis.__probeLast;
});

static volatile int installed_index = -1;
static volatile int other_thread_ok = -1;

/* Calls the index the main thread installed. If tables are per-thread this
 * either traps (nothing at that index) or hits an unrelated function. */
static void *probe_other_thread(void *unused) {
  (void)unused;
  int cell = 100;
  int table_len = EM_ASM_INT({ return wasmTable.length; });
  if (table_len <= installed_index) { other_thread_ok = 0; return NULL; }
  jitfn f = (jitfn)(long)installed_index;
  int r = f(&cell);
  other_thread_ok = (r == 107 && cell == 107) ? 1 : 2;
  return NULL;
}

static int interpreted(int *cell, int addend) { *cell += addend; return *cell; }

int main(void) {
  static unsigned char mod[256];
  int cell = 0;

  int len = build_module(mod, 7);
  printf("module is %d bytes\n", len);
  int idx = install_wasm(mod, len);
  printf("installed at table index %d\n", idx);
  if (idx < 0) return 1;

  jitfn f = (jitfn)(long)idx;
  int r = f(&cell);
  printf("generated code returned %d, cell=%d  %s\n",
         r, cell, (r == 7 && cell == 7) ? "OK -- it read and wrote OUR memory" : "WRONG");
  if (r != 7) return 1;

  /* 2. compile cost: distinct bodies, so nothing can be cached */
  const int N = 200;
  double t0 = emscripten_get_now();
  for (int i = 0; i < N; i++) {
    int n = build_module(mod, i + 1);
    if (install_wasm(mod, n) < 0) { printf("install %d failed\n", i); return 1; }
  }
  double t1 = emscripten_get_now();
  printf("compile+install: %.3f ms per method (%d methods in %.0f ms)\n",
         (t1 - t0) / N, N, t1 - t0);

  /* 3b. crossing cost: import call vs table call */
  {
    int n = build_module(mod, 7);
    EM_ASM({ globalThis.__probeKeep = 1; });
    int i2 = install_wasm(mod, n);
    (void)i2;
    stash_last();
    cell = 0;
    const int K = 500000;
    double a0 = emscripten_get_now();
    for (int i = 0; i < K; i++) call_via_js(0, (int)(long)&cell);
    double a1 = emscripten_get_now();
    printf("call through JS import: %.4f us  (cell=%d)\n", (a1 - a0) * 1000.0 / K, cell);
  }

  /* 3. call cost, generated vs direct */
  const int M = 2000000;
  cell = 0;
  double t2 = emscripten_get_now();
  for (int i = 0; i < M; i++) f(&cell);
  double t3 = emscripten_get_now();
  cell = 0;
  for (int i = 0; i < M; i++) interpreted(&cell, 7);
  double t4 = emscripten_get_now();
  printf("call through table: %.4f us   direct call: %.4f us\n",
         (t3 - t2) * 1000.0 / M, (t4 - t3) * 1000.0 / M);
  /* 4. Threads. With pthreads every worker instantiates the module again, so
   * each thread may hold its OWN WebAssembly.Table. If so, a table index is
   * only meaningful on the thread that installed it, and the JIT's code cache
   * has to be thread-local rather than global. This is the check that decides
   * that, and it must be answered before any code-cache design. */
  installed_index = idx;
  pthread_t t;
  pthread_create(&t, NULL, probe_other_thread, NULL);
  pthread_join(t, NULL);
  printf("other thread calling index %d: %s\n", installed_index,
         other_thread_ok == 1 ? "OK -- tables are shared, cache can be global"
       : other_thread_ok == 0 ? "TRAPPED -- tables are per-thread, cache must be thread-local"
                              : "installed its own index instead");
  return 0;
}
