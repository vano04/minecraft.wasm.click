# Notices

This repository contains the launcher, browser runtime source, OpenJDK build patches, JSON authentication server, authenticated relay, and distribution tools for minecraft.wasm.click. The reviewed runtime archive contains the browser JVM, project adapters, and open-source support libraries. It excludes Minecraft client/server code and game assets, player data, and account credentials.

A developer build may download Minecraft files into an ignored cache to compile adapters against the expected API and verify transformations. Those inputs must not enter the distributed runtime. The player's browser downloads the client and required libraries from Mojang. Sounds and panorama images use Mojang's asset host first, then a version-pinned GitHub raw-file fallback. The browser checks the downloaded bytes against Mojang's asset index. The server does not proxy sounds or panorama images.

Project-authored platform code uses the GNU General Public License v3.0. See LICENSE. OpenJDK, libffi, Emscripten, Java libraries, Rust crates and other dependencies retain their respective licenses. OpenJDK patches preserve upstream copyright and license headers. OpenJDK-derived JIT files marked GPLv2-only remain GPLv2-only.

The `licenses/` directory includes the pinned OpenJDK GPLv2 text, Classpath licensing clarification, assembly exception, and shared java.base component notices. It also contains libffi, Emscripten, and dependency notices. `testing/runtime-source.json` records upstream revisions and notice checksums. Runtime packaging records the selected Java libraries and Naga crate graph.

The running server publishes license texts, the dependency inventory, runtime checksums, and corresponding source at `/notices/`. The source manifest identifies the archive checksum, upstream source revisions, and custom patches. The archive includes source and build recipes. It excludes game files, private credentials, and generated caches.

Project-owned PWA icons are the checked-in raster artwork. Game textures, player skins and capes, sounds, resource packs, and worlds must not enter the source tree or distributed runtime. Control drawings are inline SVG and CSS made with Minecraft screenshot references. That history does not establish independent rights in the drawings. The control implementation contains no extracted texture sheet.

Minecraft and third-party services remain subject to their respective terms. This experimental project is not affiliated with, endorsed by, or associated with Mojang or Microsoft. The operator of each host is responsible for that service.
