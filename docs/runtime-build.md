# Build the browser runtime

The normal installation uses artifacts/runtime.tar.gz. Build the runtime only when changing its source or selecting new runtime bytes. This optional build needs a native toolchain and substantially more work than starting the Docker service.

Run build commands from the repository root. The wrapper uses runtime/, verifies its source lock and invokes the build tools there. It compiles OpenJDK, the Java browser adapters and their JNI bridge. No sibling checkout is required.

If you extracted a corresponding-source archive instead of cloning Git, run git init in the extracted directory before verification. The verifier uses Git to detect tracked generated files. The source archive excludes Git internals.

## Dependencies

| Input | Selected version or revision |
| --- | --- |
| OpenJDK | jdk-25-ga, commit 6c48f4ed707bf0b15f9b6098de30db8aae6fa40f |
| JDK patches | runtime/OpenJDK/patches/0001, then 0003 through 0026 in setup order |
| libffi | c575818ce67cb471467c580a01ae8f7b6538a6e2, with patch 0002 |
| Emscripten SDK | 6.0.10, compiler source d6c521a7f05449857c76bd99e396895583cf2083 |
| Naga | 30.0.1, with transitive crates pinned by runtime/tools/naga-wasm/Cargo.lock |
| Minecraft compile input | Version and expected client hash in runtime/tools/mc-version.mjs |

Build on Linux or macOS with JDK 25, Node.js 24 LTS, Rust with the wasm32-unknown-unknown target, Git, Python 3, GNU Make 4 and Clang. Install the host libraries required by OpenJDK's configure checks. macOS uses gmake; Linux uses make. Set BOOT_JDK if JDK discovery does not find your installation.

runtime/OpenJDK/setup.sh fetches pinned upstream sources and applies the checked-in patches transactionally. The wrapper checks upstream revisions after setup. Naga builds with Cargo's locked dependency graph.

The library resolver applies Mojang's OS rules to the build host. The selected Linux artifact contains 53 payload JARs. A macOS build can select a different library set. A different host, toolchain or archive metadata can also change artifact hashes. A successful build does not imply a byte-identical release.

## Build

Inspect the source and plan first:

~~~sh
npm run verify:source
npm run build:runtime -- --plan
~~~

Then build:

~~~sh
npm run build:runtime -- --jobs 8
~~~

By default, the packager downloads pinned Minecraft compile and verification inputs from Mojang into runtime/build/mojang-cache. To read a matching existing installation instead:

~~~sh
npm run build:runtime -- --jobs 8 --mc-dir /path/to/minecraft
~~~

The client must match the pinned version and checksum. The build must not redistribute its Minecraft compile inputs.

The wrapper installs locked build dependencies, builds Naga, sets up and configures OpenJDK, builds wasm-zero, compiles the port and bridge, assembles the JDK image, links the browser JVM and writes runtime/dist/wasmjvm.

The port bootstrap runs before the browser JVM is linked. The wrapper accepts only the expected incomplete-runtime stop after checking the generated port outputs. Other failures stop the build. A local build receipt records completed steps.

Do not run concurrent builds in one checkout. If a build stops, check that no process remains before removing its active build lock. Build caches belong in ignored runtime/OpenJDK/work/ and runtime/build/ directories.

## Review new output

Run npm run check. Inspect the new runtime inventory, notices and provenance before selecting it for distribution. Do not replace expected hashes merely to make the old artifact checks pass.

After reviewing a replacement bundle, package it with:

~~~sh
node tools/prepare-public-runtime.mjs /path/to/reviewed/bundle --reference-client /path/to/original-Minecraft-client.jar
~~~

The preparation tool writes the public runtime archive and its manifest. Include matching source and notices, then build and start a fresh Docker image. Changes to selected runtime source or its README also require reviewing the derivation produced by node tools/update-public-source.mjs.

A changed Java startup or own-profile path also needs its real constructor and authlib checks when the massaged game inputs and port exist:

~~~sh
MCWEB_REQUIRE_GAME_TESTS=1 node --test runtime/tests/own-profile-startup.test.mjs
~~~

Use MCWEB_TEST_PORT_JAR to select a reviewed packaged port if needed. The requirement flag makes absent inputs fail rather than skip.

Shader changes need a real GPU check. Runtime browser tests and OpenJDK tests require their built inputs and suitable hardware. After a resource pack loads, move and turn with it active and check shader, pipeline and GPU validation errors. A build or a still image does not replace that check.
