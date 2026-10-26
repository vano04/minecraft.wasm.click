// The in-tab edits to Mojang's client jar (OpenJDK/browser/jar-massage.js),
// shared by tools/build-wasmjvm.mjs and tools/verify-massaged-jar.mjs.
// What the browser must do to Mojang's jar before the JVM can load it. This is
// data, not code: pre.js carries it in the payload manifest and executes it, so
// adding a patch does not mean relinking the runtime.
//
// Kept deliberately small. Each entry earned its place by being the failure
// that actually stopped a boot, not by being in the desktop transform - most
// of that transform exists for GraalVM Web Image's limitations, which a real
// JVM does not share.
export const MASSAGE_PLAN = {
  // Applied only to the verified in-memory derived client on iOS/iPadOS.
  // The generic mobile helper reads these decisions from this same plan.
  mobile: {
    clientJar: "minecraft-26.3-client.jar",
    terrain: {
      entry: "net/minecraft/client/renderer/chunk/SectionRenderDispatcher.class",
      sourceSha256: "b2f89fd98f312a4c9ae786a387c11ed8a55f107745e36dd481539031efffbcbc",
      derivedSha256: "40e1a82eab600aea31d00de8f3d26c2e71a29814a37fa23bea19d161610ff581",
      constants: [[134217728, 16777216], [33554432, 4194304], [102760448, 8388608]],
      expectEach: 1,
    },
    manifest: {
      entry: "META-INF/MANIFEST.MF",
      sourceBytes: 5072373,
      sourceSha256: "09bba44b7c18dcd70789ef7bedf4fbc58984b773e84fec2dacc9ffda6fa3e448",
      prefixBytes: 64,
      derivedSha256: "135accdbc99ebeeb5d0ac7f5c7d94e1e7e3fdf66debe321106e6aa665659a45f",
    },
  },
  // The platform MXBeans do not work on this runtime: libmanagement.so loads
  // and then reports "Unsupported Management version", so ManagementFactory's
  // clinit fails and takes the whole client down from Minecraft's constructor.
  // Only the three accessors BrowserManagementCompat implements are
  // retargeted; getThreadMXBean and getPlatformMBeanServer are left pointing
  // at the real class, exactly as the desktop transform leaves them.
  targets: [
    "net/minecraft/SystemReport.class",
    "net/minecraft/client/Minecraft.class",
    "net/minecraft/client/gui/components/debug/DebugEntryMemory$AllocationRateCalculator.class",
    "net/minecraft/client/gui/components/debug/DebugEntryDetailedMemory.class",
  ],
  // Minecraft writes a world-icon screenshot on entering a world. That path
  // reaches LWJGL's STBIWriteCallback -> Callback -> Upcalls, whose clinit
  // needs libffi natives this runtime does not have, and the ReportedException
  // it raises kills the frame loop and freezes chunk loading. The desktop
  // build empties the same method; nothing else calls it.
  stub: [
    {
      entry: "net/minecraft/client/renderer/GameRenderer.class",
      name: "tryTakeScreenshotIfNeeded",
      desc: "()V",
    },
  ],
  // The frame pump drives Minecraft.runTick directly instead of its blocking
  // run() loop, and runTick is private on the desktop.
  // Everything the port reaches into Minecraft for. Found by listing the
  // class's private members and cross-referencing the port's sources, rather
  // than one IllegalAccessError per five-minute browser run.
  // The fixes the desktop transform makes by inserting calls (build.gradle:
  // ChunkNoWait, MoveIntoPendingChunk, LocalPlayerEdge, UncompiledSeeThrough),
  // made here the only way an in-place edit can: an instruction swapped for a
  // static call into BrowserChunkCompat, or a constant changed. Each rule
  // states how many sites it expects (see jar-massage.js).
  redirect: [
    // Deployment-owned browser file picker and signed player texture seams.
    {"entry":"net/minecraft/client/gui/screens/packs/PackSelectionScreen.class","in":"lambda$init$0","inDesc":"(Lnet/minecraft/client/gui/components/Button;)V","ops":[184],"owner":"com/mojang/blaze3d/Blaze3D","name":"openPath","desc":"(Ljava/nio/file/Path;)V","newOwner":"dev/mcweb/browser/BrowserPackFolder","newName":"openPath","newDesc":"(Ljava/nio/file/Path;)V","expect":1},
    {"entry":"net/minecraft/client/renderer/texture/SkinTextureDownloader.class","in":"downloadSkin","ops":[182],"owner":"java/net/URL","name":"openConnection","desc":"(Ljava/net/Proxy;)Ljava/net/URLConnection;","newOwner":"dev/mcweb/browser/BrowserPlayerTextures","newName":"openConnection","newDesc":"(Ljava/net/URL;Ljava/net/Proxy;)Ljava/net/URLConnection;","expect":1},
    {"entry":"net/minecraft/client/renderer/texture/SkinTextureDownloader.class","in":"downloadAndRegisterSkin","ops":[184],"owner":"java/util/concurrent/CompletableFuture","name":"supplyAsync","desc":"(Ljava/util/function/Supplier;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;","newOwner":"dev/mcweb/browser/BrowserPlayerTextures","newName":"supplyAsync","newDesc":"(Ljava/util/function/Supplier;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;","expect":1},
    {"entry":"net/minecraft/client/resources/SkinManager$1.class","in":"load","ops":[184],"owner":"java/util/concurrent/CompletableFuture","name":"supplyAsync","desc":"(Ljava/util/function/Supplier;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;","newOwner":"dev/mcweb/browser/BrowserPlayerTextures","newName":"supplyAsync","newDesc":"(Ljava/util/function/Supplier;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;","expect":1},
    {"entry":"net/minecraft/client/resources/SkinManager$1.class","in":"lambda$load$0","ops":[185],"owner":"com/mojang/authlib/minecraft/SessionService","name":"unpackTextures","desc":"(Lcom/mojang/authlib/properties/Property;)Lcom/mojang/authlib/minecraft/MinecraftProfileTextures;","newOwner":"dev/mcweb/browser/BrowserPlayerTextures","newName":"unpackTextures","newDesc":"(Lcom/mojang/authlib/minecraft/SessionService;Lcom/mojang/authlib/properties/Property;)Lcom/mojang/authlib/minecraft/MinecraftProfileTextures;","expect":1},
    // Own signed properties are preloaded by the authenticated page, avoiding
    // a blocking browser HTTP request while Minecraft is still constructing.
    { entry: "net/minecraft/client/Minecraft.class", in: "lambda$new$0",
      inDesc: "()Lcom/mojang/authlib/services/ProfileResult;", ops: [185],
      owner: "com/mojang/authlib/minecraft/SessionService", name: "fetchProfile",
      desc: "(Ljava/util/UUID;Z)Lcom/mojang/authlib/services/ProfileResult;",
      newOwner: "dev/mcweb/browser/BrowserPlayerTextures", newName: "fetchProfile",
      newDesc: "(Lcom/mojang/authlib/minecraft/SessionService;Ljava/util/UUID;Z)Lcom/mojang/authlib/services/ProfileResult;", expect: 1 },
    // BrowserMinecraftMain keeps offline service discovery, so this constructor
    // branch must consume the identity-bound preload instead of a null profile.
    { entry: "net/minecraft/client/Minecraft.class", in: "<init>",
      inDesc: "(Lnet/minecraft/client/main/GameConfig;)V", ops: [184],
      owner: "java/util/concurrent/CompletableFuture", name: "completedFuture",
      desc: "(Ljava/lang/Object;)Ljava/util/concurrent/CompletableFuture;",
      newOwner: "dev/mcweb/browser/BrowserPlayerTextures", newName: "offlineProfileFuture",
      newDesc: "(Ljava/lang/Object;)Ljava/util/concurrent/CompletableFuture;", expect: 1 },
    // DownloadQueue must wait off the client, which pumps HTTP completions.
    // Its own ConsecutiveExecutor still sequences the original download work.
    { entry: "net/minecraft/server/packs/DownloadQueue.class", in: "<init>",
      inDesc: "(Ljava/nio/file/Path;)V",
      ops: [0xb8], owner: "net/minecraft/util/Util", name: "nonCriticalIoPool",
      desc: "()Lnet/minecraft/TracingExecutor;",
      newOwner: "dev/mcweb/graal/BrowserAsyncCompat", newName: "serverPackDownloadTracingExecutor",
      newDesc: "()Lnet/minecraft/TracingExecutor;", expect: 1 },
    // Only the resource-pack downloader's HTTP connection crosses into fetch.
    // Vanilla retains its cache, hash/size checks, progress, ZIP and reload.
    { entry: "net/minecraft/util/HttpUtil.class", in: "downloadFile",
      inDesc: "(Ljava/nio/file/Path;Ljava/net/URL;Ljava/util/Map;Lcom/google/common/hash/HashFunction;Lcom/google/common/hash/HashCode;ILjava/net/Proxy;Lnet/minecraft/util/HttpUtil$DownloadProgressListener;)Ljava/nio/file/Path;",
      ops: [0xb6], owner: "java/net/URL", name: "openConnection",
      desc: "(Ljava/net/Proxy;)Ljava/net/URLConnection;",
      newOwner: "dev/mcweb/graal/BrowserPackHttp", newName: "openConnection",
      newDesc: "(Ljava/net/URL;Ljava/net/Proxy;)Ljava/net/URLConnection;", expect: 1 },
    { entry: "net/minecraft/server/level/ServerChunkCache.class", in: "getChunk",
      inDesc: "(IILnet/minecraft/world/level/chunk/status/ChunkStatus;Z)Lnet/minecraft/world/level/chunk/ChunkAccess;",
      ops: [0xb6, 0xb7], owner: "net/minecraft/server/level/ServerChunkCache", name: "getChunkFutureMainThread",
      desc: "(IILnet/minecraft/world/level/chunk/status/ChunkStatus;Z)Ljava/util/concurrent/CompletableFuture;",
      newOwner: "dev/mcweb/graal/BrowserChunkCompat", newName: "getChunkFutureNoWait",
      newDesc: "(Lnet/minecraft/server/level/ServerChunkCache;IILnet/minecraft/world/level/chunk/status/ChunkStatus;Z)Ljava/util/concurrent/CompletableFuture;",
      expect: 1 },
    { entry: "net/minecraft/server/network/ServerGamePacketListenerImpl.class", in: "handleMovePlayer",
      ops: [0xb8], owner: "net/minecraft/network/protocol/PacketUtils", name: "ensureRunningOnSameThread",
      desc: "(Lnet/minecraft/network/protocol/Packet;Lnet/minecraft/network/PacketListener;Lnet/minecraft/server/level/ServerLevel;)V",
      newOwner: "dev/mcweb/graal/BrowserChunkCompat", newName: "ensureRunningOnSameThread",
      newDesc: "(Lnet/minecraft/network/protocol/Packet;Lnet/minecraft/network/PacketListener;Lnet/minecraft/server/level/ServerLevel;)V",
      expect: 1 },
    { entry: "net/minecraft/server/network/ServerGamePacketListenerImpl.class", in: "handleMovePlayer",
      ops: [0xb4], owner: "net/minecraft/server/level/ServerPlayer", name: "wonGame", desc: "Z",
      newOwner: "dev/mcweb/graal/BrowserChunkCompat", newName: "wonGameOrHold",
      newDesc: "(Lnet/minecraft/server/level/ServerPlayer;)Z", expect: 1 },
    { entry: "net/minecraft/world/entity/LivingEntity.class",
      ops: [0xb6], owner: "net/minecraft/world/entity/LivingEntity", name: "move",
      desc: "(Lnet/minecraft/world/entity/MoverType;Lnet/minecraft/world/phys/Vec3;)V",
      newOwner: "dev/mcweb/graal/BrowserChunkCompat", newName: "move",
      newDesc: "(Lnet/minecraft/world/entity/LivingEntity;Lnet/minecraft/world/entity/MoverType;Lnet/minecraft/world/phys/Vec3;)V",
      expect: 7 },
    // A spawn probe does not wait for a chunk that is not generated
    // (BrowserChunkCompat.isSpawnPositionOk). Every caller of
    // SpawnPlacements.isSpawnPositionOk funnels through that one dispatch, and
    // the two spawners that reach a placement type directly are the rest: all
    // three sites that reach one at all. The probe then answers "not here"
    // for a chunk the server has not generated - which is what the wait would
    // have answered, and what vanilla answers for a chunk not loaded at all -
    // instead of parking the Server thread in ServerChunkCache.getChunk for
    // the whole breadth-first generation of that chunk (no ticks, so no chunk
    // sends either: client, visible and renderable froze with it).
    { entry: "net/minecraft/world/entity/SpawnPlacements.class", in: "isSpawnPositionOk",
      inDesc: "(Lnet/minecraft/world/entity/EntityType;Lnet/minecraft/world/level/LevelReader;Lnet/minecraft/core/BlockPos;)Z",
      ops: [0xb9], owner: "net/minecraft/world/entity/SpawnPlacementType", name: "isSpawnPositionOk",
      desc: "(Lnet/minecraft/world/level/LevelReader;Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/entity/EntityType;)Z",
      newOwner: "dev/mcweb/graal/BrowserChunkCompat", newName: "isSpawnPositionOk",
      newDesc: "(Lnet/minecraft/world/entity/SpawnPlacementType;Lnet/minecraft/world/level/LevelReader;Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/entity/EntityType;)Z",
      expect: 1 },
    { entry: "net/minecraft/world/entity/npc/wanderingtrader/WanderingTraderSpawner.class",
      in: "findSpawnPositionNear",
      inDesc: "(Lnet/minecraft/world/level/LevelReader;Lnet/minecraft/core/BlockPos;I)Lnet/minecraft/core/BlockPos;",
      ops: [0xb9], owner: "net/minecraft/world/entity/SpawnPlacementType", name: "isSpawnPositionOk",
      desc: "(Lnet/minecraft/world/level/LevelReader;Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/entity/EntityType;)Z",
      newOwner: "dev/mcweb/graal/BrowserChunkCompat", newName: "isSpawnPositionOk",
      newDesc: "(Lnet/minecraft/world/entity/SpawnPlacementType;Lnet/minecraft/world/level/LevelReader;Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/entity/EntityType;)Z",
      expect: 1 },
    { entry: "net/minecraft/world/entity/raid/Raid.class", in: "findRandomSpawnPos",
      inDesc: "(Lnet/minecraft/server/level/ServerLevel;I)Lnet/minecraft/core/BlockPos;",
      ops: [0xb9], owner: "net/minecraft/world/entity/SpawnPlacementType", name: "isSpawnPositionOk",
      desc: "(Lnet/minecraft/world/level/LevelReader;Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/entity/EntityType;)Z",
      newOwner: "dev/mcweb/graal/BrowserChunkCompat", newName: "isSpawnPositionOk",
      newDesc: "(Lnet/minecraft/world/entity/SpawnPlacementType;Lnet/minecraft/world/level/LevelReader;Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/entity/EntityType;)Z",
      expect: 1 },
    // Chunks sent once complete, not once ticking (BrowserChunkCompat).
    // getChunkToSend, blockChanged, sectionLightChanged: changes to a chunk
    // sent early are recorded, and go out when it starts ticking (vanilla
    // then queues its holder for broadcast).
    { entry: "net/minecraft/server/level/ChunkHolder.class",
      ops: [0xb6], owner: "net/minecraft/server/level/ChunkHolder", name: "getTickingChunk",
      desc: "()Lnet/minecraft/world/level/chunk/LevelChunk;",
      newOwner: "dev/mcweb/graal/BrowserChunkCompat", newName: "chunkToSend",
      newDesc: "(Lnet/minecraft/server/level/ChunkHolder;)Lnet/minecraft/world/level/chunk/LevelChunk;",
      expect: 3 },
    { entry: "net/minecraft/server/level/ChunkMap.class",
      ops: [0xb8], owner: "net/minecraft/server/level/ChunkMap", name: "markChunkPendingToSend",
      desc: "(Lnet/minecraft/server/level/ServerPlayer;Lnet/minecraft/world/level/chunk/LevelChunk;)V",
      newOwner: "dev/mcweb/graal/BrowserChunkCompat", newName: "markChunkPendingToSend",
      newDesc: "(Lnet/minecraft/server/level/ServerPlayer;Lnet/minecraft/world/level/chunk/LevelChunk;)V",
      expect: 2 },
    { entry: "net/minecraft/server/level/ChunkMap.class",
      ops: [0xb6], owner: "net/minecraft/server/network/PlayerChunkSender", name: "dropChunk",
      desc: "(Lnet/minecraft/server/level/ServerPlayer;Lnet/minecraft/world/level/ChunkPos;)V",
      newOwner: "dev/mcweb/graal/BrowserChunkCompat", newName: "dropChunk",
      newDesc: "(Lnet/minecraft/server/network/PlayerChunkSender;Lnet/minecraft/server/level/ServerPlayer;Lnet/minecraft/world/level/ChunkPos;)V",
      expect: 1 },
    // Where a chunk generation step runs (BrowserWorldgenSteps): the
    // statuses ?offloadSteps= names (default none) go to the background
    // pool, as Mojang sends the terrain step; the rest run in place, timed
    // with ?chunkDiag=1.
    { entry: "net/minecraft/world/level/chunk/status/ChunkStep.class", in: "apply",
      ops: [0xb9], owner: "net/minecraft/world/level/chunk/status/ChunkStatusTask", name: "doWork",
      desc: "(Lnet/minecraft/world/level/chunk/status/WorldGenContext;Lnet/minecraft/world/level/chunk/status/ChunkStep;Lnet/minecraft/util/StaticCache2D;Lnet/minecraft/world/level/chunk/ChunkAccess;)Ljava/util/concurrent/CompletableFuture;",
      newOwner: "dev/mcweb/graal/BrowserWorldgenSteps", newName: "doWork",
      newDesc: "(Lnet/minecraft/world/level/chunk/status/ChunkStatusTask;Lnet/minecraft/world/level/chunk/status/WorldGenContext;Lnet/minecraft/world/level/chunk/status/ChunkStep;Lnet/minecraft/util/StaticCache2D;Lnet/minecraft/world/level/chunk/ChunkAccess;)Ljava/util/concurrent/CompletableFuture;",
      expect: 2 },
    // SectionRenderDispatcher's copy lock, traced (BrowserCopyLockTrace):
    // every lock/unlock of it in the dispatcher, its RenderSection and
    // CompileTask makes the same call after noting it in a ring, which the
    // frame pump reports if an unlock by a non-owner (the "Batching
    // sections" IllegalMonitorStateException) happens again.
    { entry: "net/minecraft/client/renderer/chunk/SectionRenderDispatcher.class",
      ops: [0xb6], owner: "java/util/concurrent/locks/ReentrantLock", name: "lock", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserCopyLockTrace", newName: "lock",
      newDesc: "(Ljava/util/concurrent/locks/ReentrantLock;)V", expect: 2 },
    { entry: "net/minecraft/client/renderer/chunk/SectionRenderDispatcher.class",
      ops: [0xb6], owner: "java/util/concurrent/locks/ReentrantLock", name: "unlock", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserCopyLockTrace", newName: "unlock",
      newDesc: "(Ljava/util/concurrent/locks/ReentrantLock;)V", expect: 3 },
    { entry: "net/minecraft/client/renderer/chunk/SectionRenderDispatcher$RenderSection.class",
      ops: [0xb6], owner: "java/util/concurrent/locks/ReentrantLock", name: "lock", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserCopyLockTrace", newName: "lock",
      newDesc: "(Ljava/util/concurrent/locks/ReentrantLock;)V", expect: 2 },
    { entry: "net/minecraft/client/renderer/chunk/SectionRenderDispatcher$RenderSection.class",
      ops: [0xb6], owner: "java/util/concurrent/locks/ReentrantLock", name: "unlock", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserCopyLockTrace", newName: "unlock",
      newDesc: "(Ljava/util/concurrent/locks/ReentrantLock;)V", expect: 4 },
    { entry: "net/minecraft/client/renderer/chunk/SectionRenderDispatcher$RenderSection$CompileTask.class",
      ops: [0xb6], owner: "java/util/concurrent/locks/ReentrantLock", name: "lock", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserCopyLockTrace", newName: "lock",
      newDesc: "(Ljava/util/concurrent/locks/ReentrantLock;)V", expect: 2 },
    { entry: "net/minecraft/client/renderer/chunk/SectionRenderDispatcher$RenderSection$CompileTask.class",
      ops: [0xb6], owner: "java/util/concurrent/locks/ReentrantLock", name: "unlock", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserCopyLockTrace", newName: "unlock",
      newDesc: "(Ljava/util/concurrent/locks/ReentrantLock;)V", expect: 4 },
    // RenderBuffers' section builder packs, one per core, are Java arrays
    // here: capped (BrowserBufferCompat.sectionBuilderPacks).
    { entry: "net/minecraft/client/renderer/GameRenderer.class", in: "<init>",
      ops: [0xb6], owner: "java/lang/Runtime", name: "availableProcessors", desc: "()I",
      newOwner: "dev/mcweb/graal/BrowserBufferCompat", newName: "sectionBuilderPacks",
      newDesc: "(Ljava/lang/Runtime;)I", expect: 1 },
    // Background work on the port's own executors (BrowserAsyncCompat,
    // AgentExecutorService: sized for this runtime, worldgen on its own lane)
    // instead of Mojang's ForkJoinPools, as the desktop transform does.
    // Util.<clinit> builds Worker-Main, IO-Worker and Download from these
    // factories, so its accessors then return the port's executors too; the
    // server's chunk map takes its worldgen executor by the server's policy.
    { entry: "net/minecraft/util/Util.class", in: "<clinit>",
      ops: [0xb8], owner: "net/minecraft/util/Util", name: "makeExecutor",
      desc: "(Ljava/lang/String;)Lnet/minecraft/TracingExecutor;",
      newOwner: "dev/mcweb/graal/BrowserAsyncCompat", newName: "makeExecutor",
      newDesc: "(Ljava/lang/String;)Lnet/minecraft/TracingExecutor;", expect: 1 },
    { entry: "net/minecraft/util/Util.class", in: "<clinit>",
      ops: [0xb8], owner: "net/minecraft/util/Util", name: "makeIoExecutor",
      desc: "(Ljava/lang/String;Z)Lnet/minecraft/TracingExecutor;",
      newOwner: "dev/mcweb/graal/BrowserAsyncCompat", newName: "makeIoExecutor",
      newDesc: "(Ljava/lang/String;Z)Lnet/minecraft/TracingExecutor;", expect: 2 },
    // MinecraftServer.executor, the one ChunkMap builds its "worldgen" and
    // "light" executors on: each gets a long-lived thread of its own, with one
    // warm JIT code cache (AgentExecutorService.serverExecutor).
    { entry: "net/minecraft/server/MinecraftServer.class", in: "<init>",
      ops: [0xb8], owner: "net/minecraft/util/Util", name: "backgroundExecutor",
      desc: "()Lnet/minecraft/TracingExecutor;",
      newOwner: "dev/mcweb/graal/AgentExecutorService", newName: "serverExecutor",
      newDesc: "()Ljava/util/concurrent/ExecutorService;", expect: 1 },
    { entry: "net/minecraft/server/level/ChunkMap.class",
      ops: [0xb8], owner: "net/minecraft/util/Util", name: "backgroundExecutor",
      desc: "()Lnet/minecraft/TracingExecutor;",
      newOwner: "dev/mcweb/graal/BrowserAsyncCompat", newName: "serverBackgroundTracingExecutor",
      newDesc: "()Lnet/minecraft/TracingExecutor;", expect: 3 },
    // Every block write into a PalettedContainer goes acquire/release ->
    // ThreadingDetector.checkAndLock/checkAndUnlock, a semaphore and a lock per
    // write: the CAS in Semaphore.tryAcquire is a callee the JIT will not inline
    // (a guard on state it could not re-establish would re-run the CAS), so the
    // write path is a chain of framed calls. The detector exists only to report
    // concurrent access to one container, which this runtime's single-owner
    // chunk generation cannot produce. The redirect is unconditional; the port
    // helper skips the guard unless -Dmcweb.threadingDetector=on
    // (?threadingDetector=1), so vanilla is one query flag away. These two are
    // the only ThreadingDetector locks in the jar (LegacyRandomSource calls
    // only the static exception maker).
    { entry: "net/minecraft/world/level/chunk/PalettedContainer.class", in: "acquire",
      ops: [0xb6], owner: "net/minecraft/util/ThreadingDetector", name: "checkAndLock",
      desc: "()V", newOwner: "dev/mcweb/graal/BrowserThreadingDetectorCompat",
      newName: "checkAndLock",
      newDesc: "(Lnet/minecraft/util/ThreadingDetector;)V", expect: 1 },
    { entry: "net/minecraft/world/level/chunk/PalettedContainer.class", in: "release",
      ops: [0xb6], owner: "net/minecraft/util/ThreadingDetector", name: "checkAndUnlock",
      desc: "()V", newOwner: "dev/mcweb/graal/BrowserThreadingDetectorCompat",
      newName: "checkAndUnlock",
      newDesc: "(Lnet/minecraft/util/ThreadingDetector;)V", expect: 1 },
    // The two spawn finders, as build.gradle's initial-spawn and
    // prepare-spawn finder transforms replace them. getSpawnPosInChunk asks
    // the threaded world synchronously for a full chunk per probe, which is
    // what dominates setInitialSpawn before the server can publish isReady;
    // findSpawn is the respawn search the configuration phase waits on. The
    // port's helpers keep the real chunk pipeline and hand back a bounded
    // position (BrowserIntegratedServerCompat).
    { entry: "net/minecraft/server/MinecraftServer.class",
      in: "setInitialSpawn",
      inDesc: "(Lnet/minecraft/server/level/ServerLevel;Lnet/minecraft/world/level/storage/ServerLevelData;ZZLnet/minecraft/server/level/progress/LevelLoadListener;)V",
      ops: [0xb8], owner: "net/minecraft/server/level/PlayerSpawnFinder",
      name: "getSpawnPosInChunk",
      desc: "(Lnet/minecraft/server/level/ServerLevel;Lnet/minecraft/world/level/ChunkPos;)Lnet/minecraft/core/BlockPos;",
      newOwner: "dev/mcweb/graal/BrowserIntegratedServerCompat",
      newName: "browserInitialSpawn",
      newDesc: "(Lnet/minecraft/server/level/ServerLevel;Lnet/minecraft/world/level/ChunkPos;)Lnet/minecraft/core/BlockPos;",
      expect: 1 },
    { entry: "net/minecraft/server/network/config/PrepareSpawnTask.class",
      in: "lambda$start$3",
      inDesc: "(Lnet/minecraft/server/level/ServerLevel;Lnet/minecraft/world/level/storage/LevelData$RespawnData;)Ljava/util/concurrent/CompletableFuture;",
      ops: [0xb8], owner: "net/minecraft/server/level/PlayerSpawnFinder",
      name: "findSpawn",
      desc: "(Lnet/minecraft/server/level/ServerLevel;Lnet/minecraft/core/BlockPos;)Ljava/util/concurrent/CompletableFuture;",
      newOwner: "dev/mcweb/graal/BrowserIntegratedServerCompat",
      newName: "browserPrepareSpawnPosition",
      newDesc: "(Lnet/minecraft/server/level/ServerLevel;Lnet/minecraft/core/BlockPos;)Ljava/util/concurrent/CompletableFuture;",
      expect: 1 },
    // LevelLoadingScreen's one readiness call. The vanilla tracker decides;
    // the port's gate only reports why the screen is still up, because a hold
    // that never ends is otherwise silent (BrowserTerrainEntryGate).
    { entry: "net/minecraft/client/gui/screens/LevelLoadingScreen.class",
      in: "tick", inDesc: "()V",
      ops: [0xb6], owner: "net/minecraft/client/multiplayer/LevelLoadTracker",
      name: "isLevelReady", desc: "()Z",
      newOwner: "dev/mcweb/graal/BrowserTerrainEntryGate",
      newName: "isLevelReady",
      newDesc: "(Lnet/minecraft/client/multiplayer/LevelLoadTracker;)Z",
      expect: 1 },
    // What the port's shadows of these three classes used to do, as call-site
    // redirects into MC-Web's own code, so Mojang's classes stay Mojang's:
    // the one graphics backend there is, a frame limiter that leaves pacing to
    // the host, and world-load progress reported to the page.
    { entry: "net/minecraft/client/Minecraft.class", in: "<init>",
      ops: [0xb6], owner: "net/minecraft/client/PreferredGraphicsApi", name: "getBackendsToTry",
      desc: "()[Lcom/mojang/renderpearl/api/device/GpuBackend;",
      newOwner: "dev/mcweb/graal/webgpu/WebGpuBackend", newName: "backendsToTry",
      newDesc: "(Lnet/minecraft/client/PreferredGraphicsApi;)[Lcom/mojang/renderpearl/api/device/GpuBackend;",
      expect: 1 },
    // 26.3 boot steps a page cannot take, each replaced at its one call site
    // (BrowserBootCompat): SDL's log callback is an LWJGL upcall; the Vulkan
    // probe and feature-set bootstrap are for a backend the browser never
    // picks; authlib 10 fetches service discovery at once.
    { entry: "com/mojang/blaze3d/systems/RenderSystem.class", in: "initBackendSystem",
      ops: [0xb8], owner: "com/mojang/blaze3d/platform/SdlDebug", name: "init", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserBootCompat", newName: "sdlDebugInit", newDesc: "()V", expect: 1 },
    { entry: "net/minecraft/client/ClientBootstrap.class", in: "bootstrap",
      ops: [0xb8], owner: "com/mojang/renderpearl/backend/vulkan/VulkanFeatureSets", name: "bootstrap", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserBootCompat", newName: "vulkanFeatureSetsBootstrap", newDesc: "()V", expect: 1 },
    { entry: "net/minecraft/client/Minecraft.class", in: "<init>",
      ops: [0xb8], owner: "com/mojang/renderpearl/backend/vulkan/VulkanBackend", name: "checkBackendAvailable",
      desc: "()Lcom/mojang/renderpearl/api/device/BackendCreationException;",
      newOwner: "dev/mcweb/graal/BrowserBootCompat", newName: "vulkanUnavailable",
      newDesc: "()Lcom/mojang/renderpearl/api/device/BackendCreationException;", expect: 1 },
    { entry: "net/minecraft/client/Minecraft.class", in: "<init>",
      ops: [0xb8], owner: "com/mojang/authlib/services/MinecraftServicesDiscoveryService", name: "create",
      desc: "(Ljava/net/Proxy;Z)Lcom/mojang/authlib/services/MinecraftServicesDiscoveryService;",
      newOwner: "dev/mcweb/graal/BrowserBootCompat", newName: "servicesDiscovery",
      newDesc: "(Ljava/net/Proxy;Z)Lcom/mojang/authlib/services/MinecraftServicesDiscoveryService;", expect: 1 },
    // The client tick and its phases, through BrowserFrameTiming, which makes
    // the same call and with ?frameSplit=1 also times it.
    { entry: "net/minecraft/client/Minecraft.class", in: "runTick",
      ops: [0xb6], owner: "net/minecraft/client/Minecraft", name: "tick", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserFrameTiming", newName: "clientTick", newDesc: "(Lnet/minecraft/client/Minecraft;)V", expect: 1 },
    { entry: "net/minecraft/client/Minecraft.class", in: "tick",
      ops: [0xb6], owner: "net/minecraft/client/multiplayer/ClientLevel", name: "tick", desc: "(Ljava/util/function/BooleanSupplier;)V",
      newOwner: "dev/mcweb/graal/BrowserFrameTiming", newName: "levelTick", newDesc: "(Lnet/minecraft/client/multiplayer/ClientLevel;Ljava/util/function/BooleanSupplier;)V", expect: 1 },
    { entry: "net/minecraft/client/Minecraft.class", in: "tick",
      ops: [0xb6], owner: "net/minecraft/client/multiplayer/ClientLevel", name: "tickEntities", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserFrameTiming", newName: "tickEntities", newDesc: "(Lnet/minecraft/client/multiplayer/ClientLevel;)V", expect: 1 },
    { entry: "net/minecraft/client/Minecraft.class", in: "tick",
      ops: [0xb6], owner: "net/minecraft/client/multiplayer/ClientLevel", name: "animateTick", desc: "(III)V",
      newOwner: "dev/mcweb/graal/BrowserFrameTiming", newName: "animateTick", newDesc: "(Lnet/minecraft/client/multiplayer/ClientLevel;III)V", expect: 1 },
    { entry: "net/minecraft/client/Minecraft.class", in: "tick",
      ops: [0xb6], owner: "net/minecraft/client/particle/ParticleEngine", name: "tick", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserFrameTiming", newName: "particleTick", newDesc: "(Lnet/minecraft/client/particle/ParticleEngine;)V", expect: 1 },
    { entry: "net/minecraft/client/Minecraft.class",
      ops: [0xb6], owner: "net/minecraft/client/renderer/texture/TextureManager", name: "tick", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserFrameTiming", newName: "textureTick", newDesc: "(Lnet/minecraft/client/renderer/texture/TextureManager;)V", expect: 1 },
    { entry: "net/minecraft/client/Minecraft.class", in: "tick",
      ops: [0xb6], owner: "net/minecraft/client/renderer/GameRenderer", name: "tick", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserFrameTiming", newName: "rendererTick", newDesc: "(Lnet/minecraft/client/renderer/GameRenderer;)V", expect: 1 },
    { entry: "net/minecraft/client/Minecraft.class", in: "renderFrame",
      ops: [0xb6], owner: "net/minecraft/client/renderer/GameRenderer", name: "render", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserFrameTiming", newName: "render", newDesc: "(Lnet/minecraft/client/renderer/GameRenderer;)V", expect: 1 },
    { entry: "net/minecraft/client/multiplayer/ClientLevel.class", in: "tickNonPassenger",
      ops: [0xb6], owner: "net/minecraft/world/entity/Entity", name: "commonTick", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserFrameTiming", newName: "entityCommonTick", newDesc: "(Lnet/minecraft/world/entity/Entity;)V", expect: 1 },
    { entry: "net/minecraft/client/multiplayer/ClientLevel.class", in: "tickNonPassenger",
      ops: [0xb6], owner: "net/minecraft/world/entity/Entity", name: "tick", desc: "()V",
      newOwner: "dev/mcweb/graal/BrowserFrameTiming", newName: "entityTick", newDesc: "(Lnet/minecraft/world/entity/Entity;)V", expect: 1 },
    { entry: "net/minecraft/client/Minecraft.class", in: "renderFrame",
      ops: [0xb8], owner: "net/minecraft/client/FramerateLimiter", name: "limitDisplayFPS", desc: "(I)V",
      newOwner: "dev/mcweb/graal/BrowserWindowCompat", newName: "limitDisplayFPS", newDesc: "(I)V",
      expect: 1 },
    // The listener goes straight into LevelLoadListener.compose, so the wider
    // return type verifies.
    { entry: "net/minecraft/client/Minecraft.class", in: "doWorldLoad",
      ops: [0xb8], owner: "net/minecraft/server/level/progress/LoggingLevelLoadListener",
      name: "forSingleplayer", desc: "()Lnet/minecraft/server/level/progress/LoggingLevelLoadListener;",
      newOwner: "dev/mcweb/graal/BrowserLevelLoadReporter", newName: "forSingleplayer",
      newDesc: "()Lnet/minecraft/server/level/progress/LevelLoadListener;", expect: 1 },
    // Networking is Mojang's own Connection over Netty's in-memory transport
    // (docs/NET-MIGRATION.md). What a page cannot do is declined with the
    // IOException each caller already handles, before the attempt: LAN
    // discovery's MulticastSocket throws an Error on this JVM that escapes
    // the multiplayer screen, and a page cannot listen on a TCP port.
    { entry: "net/minecraft/client/server/LanServerDetection$LanServerDetector.class", in: "<init>",
      inDesc: "(Lnet/minecraft/client/server/LanServerDetection$LanServerList;)V",
      ops: [0xb6], owner: "net/minecraft/client/server/LanServerDetection$LanServerDetector",
      name: "setUncaughtExceptionHandler", desc: "(Ljava/lang/Thread$UncaughtExceptionHandler;)V",
      newOwner: "dev/mcweb/graal/net/BrowserNet", newName: "refuseLanDetection",
      newDesc: "(Ljava/lang/Thread;Ljava/lang/Thread$UncaughtExceptionHandler;)V", expect: 1 },
    { entry: "net/minecraft/client/server/IntegratedServer.class", in: "publishServer",
      inDesc: "(Lnet/minecraft/server/MinecraftServer$MultiplayerScope;I)Z",
      ops: [0xb6], owner: "net/minecraft/server/network/ServerConnectionListener",
      name: "startTcpServerListener", desc: "(Ljava/net/InetAddress;I)V",
      newOwner: "dev/mcweb/graal/net/BrowserNet", newName: "refuseTcpListener",
      newDesc: "(Lnet/minecraft/server/network/ServerConnectionListener;Ljava/net/InetAddress;I)V", expect: 1 },
    // Multiplayer on Mojang's own Connection.connect (docs/NET-MIGRATION.md,
    // stage 3). R1: remote connections use dev.mcweb.graal.net.WebSocketChannel
    // instead of an NIO group, which this JVM cannot run.
    ...[["net/minecraft/client/gui/screens/ConnectScreen$1.class", "run", "()V"],
      ["net/minecraft/client/gui/screens/multiplayer/ServerSelectionList$OnlineServerEntry.class",
        "lambda$extractContent$0", "()V"],
      ["net/minecraft/realms/RealmsConnect$1.class", "run", "()V"]].map(([entry, method, inDesc]) => ({
      entry, in: method, inDesc, ops: [0xb8], owner: "net/minecraft/server/network/EventLoopGroupHolder",
      name: "remote", desc: "(Z)Lnet/minecraft/server/network/EventLoopGroupHolder;",
      newOwner: "dev/mcweb/graal/net/BrowserNet", newName: "remote",
      newDesc: "(Z)Lnet/minecraft/server/network/EventLoopGroupHolder;", expect: 1 })),
    // R7a/R7b: ServerNameResolver cannot initialise here (no javax.naming), and
    // its NoClassDefFoundError escapes catch (Exception). The gateway resolves
    // names (and SRV records); the page keeps the host name.
    ...[["net/minecraft/client/gui/screens/ConnectScreen$1.class", "run", "()V"],
      ["net/minecraft/client/multiplayer/ServerStatusPinger.class", "pingServer",
        "(Lnet/minecraft/client/multiplayer/ServerData;Ljava/lang/Runnable;Ljava/lang/Runnable;Lnet/minecraft/server/network/EventLoopGroupHolder;)V"],
    ].flatMap(([entry, method, inDesc]) => [
      { entry, in: method, inDesc, ops: [0xb2], owner: "net/minecraft/client/multiplayer/resolver/ServerNameResolver",
        name: "DEFAULT", desc: "Lnet/minecraft/client/multiplayer/resolver/ServerNameResolver;",
        newOwner: "dev/mcweb/graal/net/BrowserNet", newName: "noResolver",
        newDesc: "()Lnet/minecraft/client/multiplayer/resolver/ServerNameResolver;", expect: 1 },
      { entry, in: method, inDesc, ops: [0xb6], owner: "net/minecraft/client/multiplayer/resolver/ServerNameResolver",
        name: "resolveAddress", desc: "(Lnet/minecraft/client/multiplayer/resolver/ServerAddress;)Ljava/util/Optional;",
        newOwner: "dev/mcweb/graal/net/BrowserNet", newName: "resolveAddress",
        newDesc: "(Lnet/minecraft/client/multiplayer/resolver/ServerNameResolver;Lnet/minecraft/client/multiplayer/resolver/ServerAddress;)Ljava/util/Optional;",
        expect: 1 },
    ]),
    // R4: no pre-1.7 ping after a failed one; the gateway speaks only the
    // modern protocol, and the entry already shows the failure.
    { entry: "net/minecraft/client/multiplayer/ServerStatusPinger$1.class", in: "onDisconnect",
      inDesc: "(Lnet/minecraft/network/DisconnectionDetails;)V",
      ops: [0xb6], owner: "net/minecraft/client/multiplayer/ServerStatusPinger",
      name: "pingLegacyServer",
      desc: "(Ljava/net/InetSocketAddress;Lnet/minecraft/client/multiplayer/resolver/ServerAddress;Lnet/minecraft/client/multiplayer/ServerData;Lnet/minecraft/server/network/EventLoopGroupHolder;)V",
      newOwner: "dev/mcweb/graal/net/BrowserNet", newName: "skipLegacyPing",
      newDesc: "(Lnet/minecraft/client/multiplayer/ServerStatusPinger;Ljava/net/InetSocketAddress;Lnet/minecraft/client/multiplayer/resolver/ServerAddress;Lnet/minecraft/client/multiplayer/ServerData;Lnet/minecraft/server/network/EventLoopGroupHolder;)V",
      expect: 1 },
  ],
  // No value patches for the spawn search. build.gradle also shrinks
  // setInitialSpawn's 11x11 spiral to 3x3, but with getSpawnPosInChunk
  // redirected above to a helper that never returns null, the spiral accepts
  // its first candidate (dx = dz = 0) and stops, so its loop bound and box
  // bounds are never consulted. The PrepareSpawnTask ticket radius stays at
  // vanilla's 3, where build.gradle's equivalent transform defaults to 1: the
  // level-load progress the server reports still describes the untrimmed
  // 47-chunk area, so trimming it froze progress at 0.169 and left the client
  // on LevelLoadingScreen (docs/WASMJVM-BUNDLE.md, "What was wrong").
  patchCode: [
    // UNCOMPILED.facesCanSeeEachother: iconst_0; ireturn -> iconst_1; ireturn.
    { entry: "net/minecraft/client/renderer/chunk/CompiledSectionMesh$1.class",
      name: "facesCanSeeEachother",
      desc: "(Lnet/minecraft/core/Direction;Lnet/minecraft/core/Direction;)Z", from: "03ac", to: "04ac" },
  ],
  widen: [
    { entry: "net/minecraft/client/Minecraft.class", name: "runTick", desc: "(Z)V" },
    // The frame pump replaces run(), which hands this to RenderSystem.pollEvents.
    { entry: "net/minecraft/client/Minecraft.class", kind: "field", name: "sdlEventHandler" },
    { entry: "net/minecraft/server/level/ServerChunkCache.class", name: "getChunkFutureMainThread" },
    ...["instance", "isLocalServer", "lastTime", "pendingConnection"].map((name) => ({
      entry: "net/minecraft/client/Minecraft.class", kind: "field", name,
    })),
    // What the port reads or drives on the server, as the desktop transform
    // widens it. Found by compiling the port against this plan's output
    // (javac -cp <massaged jar>): each access error there was an
    // IllegalAccessError here -- the chunk-pipeline report threw every sample.
    ...["worldgenTaskDispatcher", "lightTaskDispatcher"].map((name) => ({
      entry: "net/minecraft/server/level/ChunkMap.class", kind: "field", name,
    })),
    { entry: "net/minecraft/server/level/ChunkTaskDispatcher.class", kind: "field", name: "sleeping" },
    ...["desiredChunksPerTick", "batchQuota", "unacknowledgedBatches", "maxUnacknowledgedBatches",
      "pendingChunks"].map((name) => ({
      entry: "net/minecraft/server/network/PlayerChunkSender.class", kind: "field", name,
    })),
    ...["isReady", "nextTickTimeNanos", "mayHaveDelayedTasks", "delayedTasksMaxNextTickTimeNanos"]
      .map((name) => ({ entry: "net/minecraft/server/MinecraftServer.class", kind: "field", name })),
    { entry: "net/minecraft/util/thread/BlockableEventLoop.class", name: "runAllTasks", desc: "()V" },
    { entry: "net/minecraft/client/server/IntegratedServer.class", name: "initServer", desc: "()Z" },
    { entry: "net/minecraft/client/server/IntegratedServer.class", name: "tickServer",
      desc: "(Ljava/util/function/BooleanSupplier;)V" },
    // BrowserNet.remote's holder subclasses Mojang's (stage 3, R1).
    { entry: "net/minecraft/server/network/EventLoopGroupHolder.class", name: "<init>",
      desc: "(Ljava/lang/String;Ljava/lang/Class;Ljava/lang/Class;)V" },
  ],
  // R3: inbound packets wait for the client thread's frame pump
  // (BrowserSocketPump), which a world load or a resource pack can stall for
  // longer than vanilla's 30 s read timeout.
  intArg: [
    { entry: "net/minecraft/network/Connection$1.class", in: "initChannel", inDesc: "(Lio/netty/channel/Channel;)V",
      ops: [0xb7], owner: "io/netty/handler/timeout/ReadTimeoutHandler", name: "<init>", desc: "(I)V",
      from: 30, to: 120, expect: 1 },
  ],
  rules: [
    ...["getGarbageCollectorMXBeans", "getMemoryMXBean", "getRuntimeMXBean"]
      .map((name) => ({
        owner: "java/lang/management/ManagementFactory",
        name,
        newOwner: "dev/mcweb/graal/BrowserManagementCompat",
      })),
  ],
};
