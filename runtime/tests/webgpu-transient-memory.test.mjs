// Runs the real transient allocator and WebGpuBuffer on the host JVM. Only
// the browser queue is replaced; GPU ordering is covered by texture-readback.spec.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, delimiter} from "node:path";
import {fileURLToPath} from "node:url";
import {hostJdk} from "../tools/host-jdk.mjs";
import vm from "node:vm";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const game = join(repo, "build/massaged/minecraft-26.3-massaged.jar");
const portJar = process.env.MCWEB_TEST_PORT_JAR;
if (portJar && !existsSync(portJar)) throw new Error("Missing requested port JAR: " + portJar);

const browserBoundary = `package dev.mcweb.graal.webgpu;
import java.util.HashMap;
import java.util.Map;
public final class BrowserGpu {
  static final Map<Integer, byte[]> buffers = new HashMap<>();
  static int created, destroyed;
  public static int createBuffer(String label, int usage, int size) {
    int handle = ++created; buffers.put(handle, new byte[size]); return handle;
  }
  public static void destroyBuffer(int handle) {
    if (buffers.remove(handle) == null) throw new AssertionError("double destroy");
    destroyed++;
  }
  static void writeBuffer(int handle, int destination, byte[] source, int offset, int length) {
    System.arraycopy(source, offset, buffers.get(handle), destination, length);
  }
  static byte[] allocate(int size, String label) { return new byte[size]; }
  public static void reportProgress(String stage) {}
}`;

const behavior = `package dev.mcweb.graal.webgpu;
import java.nio.ByteBuffer;
import com.mojang.renderpearl.api.buffers.GpuBuffer;
import com.mojang.renderpearl.api.buffers.GpuBufferSlice;
public final class TransientPoolBehavior {
  static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
  static void pixels(GpuBufferSlice slice, int value, int length) {
    check(slice.length() == length, "slice must expose request size, not retained capacity");
    byte[] bytes = BrowserGpu.buffers.get(((WebGpuBuffer) slice.buffer()).handle());
    for (int i = 0; i < length; i++) check((bytes[(int) slice.offset() + i] & 255) == value, "stale upload byte " + i);
  }
  static ByteBuffer bytes(int size, int value) {
    byte[] bytes = new byte[size]; java.util.Arrays.fill(bytes, (byte) value); return ByteBuffer.wrap(bytes);
  }
  public static void main(String[] args) {
    WebGpuTransientMemory memory = new WebGpuTransientMemory();
    GpuBufferSlice a = memory.uploadGpu(bytes(64, 11), 4, GpuBuffer.USAGE_VERTEX, 0, 0);
    GpuBufferSlice b = memory.uploadGpu(bytes(64, 22), 4, GpuBuffer.USAGE_VERTEX, 0, 0);
    check(a.buffer() != b.buffer(), "simultaneous borrowed slices must not alias");
    pixels(a, 11, 64); pixels(b, 22, 64);
    int first = ((WebGpuBuffer) a.buffer()).handle();
    memory.resetAfterSubmit();
    GpuBufferSlice next = memory.uploadGpu(bytes(16, 33), 4, GpuBuffer.USAGE_VERTEX, 0, 0);
    check(((WebGpuBuffer) next.buffer()).handle() == first, "reuse after submitted consumers");
    pixels(next, 33, 16);
    memory.resetAfterSubmit();
    GpuBufferSlice grown = memory.uploadGpu(bytes(128, 44), 4, GpuBuffer.USAGE_VERTEX, 0, 0);
    pixels(grown, 44, 128);
    check(BrowserGpu.destroyed == 2, "unused peak slot and obsolete backing released once");
    memory.resetAfterSubmit();
    int warmed;
    try (GpuBufferSlice.MappedView mapped = memory.allocateStaging(64, 4, GpuBuffer.USAGE_COPY_SRC, 0, 0)) {
      mapped.data().put(bytes(64, 55));
    }
    memory.resetAfterSubmit();
    memory.uploadGpu(bytes(128, 251), 4, GpuBuffer.USAGE_VERTEX, 0, 0);
    memory.uploadGpu(bytes(32, 251), 4, GpuBuffer.USAGE_VERTEX, 0, 0);
    try (GpuBufferSlice.MappedView mapped = memory.allocateStaging(64, 4, GpuBuffer.USAGE_COPY_SRC, 0, 0)) {}
    memory.resetAfterSubmit();
    warmed = BrowserGpu.created;
    for (int frame = 0; frame < 1000; frame++) {
      int value = (frame % 250) + 1;
      GpuBufferSlice one = memory.uploadGpu(bytes(16 + frame % 100, value), 4, GpuBuffer.USAGE_VERTEX, 0, 0);
      GpuBufferSlice two = memory.uploadGpu(bytes(32, 251), 4, GpuBuffer.USAGE_VERTEX, 0, 0);
      pixels(one, value, 16 + frame % 100); pixels(two, 251, 32);
      try (GpuBufferSlice.MappedView mapped = memory.allocateStaging(64, 4, GpuBuffer.USAGE_COPY_SRC, 0, 0)) {
        mapped.data().put(bytes(64, value));
      }
      memory.resetAfterSubmit();
    }
    check(BrowserGpu.created == warmed, "steady frame allocations must plateau");
    memory.close();
    check(BrowserGpu.buffers.isEmpty(), "device teardown must release every pooled buffer");
    check(BrowserGpu.destroyed == BrowserGpu.created, "all backing storage released once");

    memory = new WebGpuTransientMemory();
    int large;
    try (GpuBufferSlice.MappedView mapped = memory.allocateStaging(8 * 1024 * 1024, 4, GpuBuffer.USAGE_COPY_SRC, 0, 0)) {
      large = ((WebGpuBuffer) mapped.slice().buffer()).handle();
    }
    memory.resetAfterSubmit();
    check(BrowserGpu.buffers.containsKey(large), "useful peak buffer may be reused within cap");
    try (GpuBufferSlice.MappedView mapped = memory.allocateStaging(16, 4, GpuBuffer.USAGE_COPY_SRC, 0, 0)) {}
    check(BrowserGpu.buffers.containsKey(large), "borrowed buffer must survive until submit");
    memory.resetAfterSubmit();
    check(!BrowserGpu.buffers.containsKey(large), "peak capacity released after smaller submit");
    check(org.lwjgl.system.BrowserNativeMemory.stats().startsWith("native=0KiB/"), "retired shadow leaves live native address map");
    try (GpuBufferSlice.MappedView mapped = memory.allocateStaging(17 * 1024 * 1024, 4, GpuBuffer.USAGE_COPY_SRC, 0, 0)) {}
    check(BrowserGpu.buffers.size() == 1, "oversized request is fully allocated before submit");
    memory.resetAfterSubmit();
    check(BrowserGpu.buffers.isEmpty(), "over-budget mapped capacity not retained");
    for (int i = 0; i < 2; i++) {
      try (GpuBufferSlice.MappedView mapped = memory.allocateStaging(9 * 1024 * 1024, 4, GpuBuffer.USAGE_COPY_SRC, 0, 0)) {}
    }
    memory.resetAfterSubmit();
    check(BrowserGpu.buffers.size() == 1, "combined mapped shadow retention cap");
    memory.resetAfterSubmit();
    check(BrowserGpu.buffers.isEmpty(), "unused mapped high-water slot released");
    memory.allocateGpu(65 * 1024 * 1024, 4, GpuBuffer.USAGE_VERTEX, 0, 0);
    check(BrowserGpu.buffers.size() == 1, "GPU request is never quality-clamped");
    memory.resetAfterSubmit();
    check(BrowserGpu.buffers.isEmpty(), "GPU retention byte cap");
    for (int i = 0; i < 520; i++) memory.allocateGpu(4, 4, GpuBuffer.USAGE_VERTEX, 0, 0);
    check(BrowserGpu.buffers.size() == 520, "all simultaneous requested slices allocated");
    memory.resetAfterSubmit();
    check(BrowserGpu.buffers.size() == 512, "aggregate slot retention cap");
    memory.resetAfterSubmit();
    check(BrowserGpu.buffers.isEmpty(), "idle submit releases unused slots");
    memory.close();
    check(BrowserGpu.destroyed == BrowserGpu.created, "trim and teardown destroy exactly once");
  }
}`;

test("transient GPU backing plateaus across submits without aliasing active slices", {
  skip: !existsSync(game) ? "requires the local massaged game's public buffer API" : false,
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "mcweb-transient-pool-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const sources = {
    "dev/mcweb/graal/webgpu/BrowserGpu.java": browserBoundary,
    "dev/mcweb/graal/webgpu/TransientPoolBehavior.java": behavior,
    "dev/mcweb/graal/MinecraftInitProgress.java": "package dev.mcweb.graal; public final class MinecraftInitProgress { public static String lastStage = \"fixture\"; }",
    "com/oracle/svm/webimage/wasmgc/annotation/WasmExport.java": "package com.oracle.svm.webimage.wasmgc.annotation; public @interface WasmExport { String value(); String comment() default \"\"; }",
  };
  for (const [path, body] of Object.entries(sources)) {
    const target = join(root, "src", path);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, body);
  }
  const classes = join(root, "classes"), jdk = hostJdk(repo);
  const compileClasspath = [portJar, game].filter(Boolean).join(delimiter);
  const compile = spawnSync(join(jdk, "bin/javac"), ["-nowarn", "-cp", compileClasspath, "-d", classes,
    ...Object.keys(sources).map((path) => join(root, "src", path)),
    ...(!portJar ? [join(repo, "src/graal/java/dev/mcweb/graal/webgpu/WebGpuBuffer.java"),
    join(repo, "src/graal/java/dev/mcweb/graal/webgpu/WebGpuTransientMemory.java"),
    join(repo, "src/graal/java/org/lwjgl/system/BrowserNativeMemory.java"),
    join(repo, "src/graal/java/org/lwjgl/system/BrowserBufferAddresses.java")] : []),
  ], {encoding: "utf8", timeout: 60000});
  assert.equal(compile.status, 0, `${compile.error || ""}\n${compile.stdout}\n${compile.stderr}`);
  const run = spawnSync(join(jdk, "bin/java"), ["-Dmcweb.nativePoolMB=16", "-cp", [classes, portJar, game].filter(Boolean).join(delimiter),
    "dev.mcweb.graal.webgpu.TransientPoolBehavior"], {encoding: "utf8", timeout: 30000});
  assert.equal(run.status, 0, `${run.error || ""}\n${run.stdout}\n${run.stderr}`);
});

test("post-submit pool retirement waits for the existing host GPU completion fence", async () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(join(repo, "web/webgpu-texture-lifetime.js"), "utf8"), context);
  let complete;
  const fence = new Promise(resolve => { complete = resolve; });
  const lifetime = context.mcWebTextureLifetime.createDeferredDestroyQueue({getQueue: () => ({onSubmittedWorkDone: () => fence})});
  let destroyed = 0;
  const encoder = {encoder: {}};
  const buffer = {_mcEnc: encoder, destroy() { destroyed++; }};
  lifetime.deferDestroyBuffer(buffer);
  assert.equal(lifetime.flush(), false, "recorded consumer cannot be destroyed before submit");
  encoder.encoder = null;
  assert.equal(lifetime.flush(), true);
  assert.equal(destroyed, 0, "Java pool closure must not destroy an in-flight GPU consumer");
  complete();
  await fence;
  await Promise.resolve();
  assert.equal(destroyed, 1);
  assert.equal(lifetime.fencedCount(), 0);
});
