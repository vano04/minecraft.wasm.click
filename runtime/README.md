# Runtime source

This directory contains the source selected for the browser runtime. Java adapters are in src/, browser hosts and controls in web/, and the OpenJDK/JIT patch stack and JNI bridge in OpenJDK/. Packaging tools and tests are in tools/ and tests/.

The normal Docker install uses the reviewed archive in artifacts/. It does not compile this directory. Run npm run build:runtime from the repository root only when rebuilding the JVM or adapters. See [runtime build instructions](../docs/runtime-build.md), [source provenance](../docs/runtime-integration.md) and the [source lock](../testing/runtime-source.json).

OpenJDK/work/, build/, dist/, dependencies and test outputs are ignored local caches. Minecraft compile inputs are not distribution files. The setup scripts fetch pinned public OpenJDK and toolchain sources, then apply the included patches.

The source verifier checks selected file hashes, sizes and executable modes. testing/public-source.json records the public source derivation against the original source locks. It also records the historical patch's sanitation of a machine-specific acceptance-pack path. The patch's code changes are already present here. Do not apply it again.
