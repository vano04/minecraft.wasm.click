# Architecture

The browser runs Minecraft: Java Edition through a WebAssembly build of OpenJDK. The distribution includes the browser JVM, project adapters, rendering and input code, and a Node server. The player supplies a short-lived Minecraft session through a Prism account-file import. The game itself downloads in the player's browser.

## Request flow

1. The browser opens / and reads a selected Prism accounts.json locally. Its parser chooses the active account, or the first account when none is active. It sends only that account's short-lived Minecraft token and profile to the server.
2. The Node server checks Java Edition entitlement and the profile with Minecraft Services. It creates an independent in-memory session and sends an opaque HttpOnly cookie to that browser. Refresh tokens and other accounts remain outside the request.
3. The authenticated launcher at /play/ loads the reviewed runtime. Install downloads the pinned Minecraft client and required libraries from Mojang into browser storage.
4. During play, the browser runs the JVM, renders with WebGPU and stores worlds, settings and resource packs locally.
5. Multiplayer opens an authenticated TCP connection through the same Node server. The server resolves and checks public targets before connecting. It authorizes the Minecraft session join with Mojang and returns connection-specific encryption material. The browser handles game encryption and compression.
6. The browser first tries a server resource pack's HTTPS URL. When the pack host blocks browser reads, the authenticated server relay can download and stream the pack. The same public-target restrictions apply to those downloads.

Sounds and panorama images use direct browser downloads. The browser tries Mojang's asset host first and a version-pinned GitHub raw-file fallback second. It verifies the asset index and downloaded sizes and hashes. These files do not pass through the Node server.

## Source layout

| Location | Purpose |
| --- | --- |
| server/ | HTTP delivery, account verification, in-memory sessions and authenticated network routes |
| public/ | Launcher styles and browser code, storage controls, PWA and public pages |
| runtime/src/, runtime/web/, runtime/OpenJDK/ | Java adapters, browser hosts, JNI bridge and custom OpenJDK patches |
| runtime/tools/, runtime/tests/ | Runtime builds, packaging and behavior checks |
| artifacts/ | Reviewed runtime archive and its exact manifest |
| testing/ | Runtime source locks, historical patches and artifact records |
| tools/ | Publication checks, runtime verification and source/notice packaging |
| licenses/ | Dependency copyright and license texts |
| docs/ | Install, development, and provenance instructions |

The source audit defines the publication file inventory. The runtime source lock and the artifact manifest answer different questions. The source lock identifies build inputs. The artifact manifest identifies the exact shipped bytes.

## Session and storage boundaries

The server retains only the selected validated short-lived token and profile in each session. A session ends at logout, server restart, its expiry timer, or the imported token's expiry. Its maximum lifetime is four hours. Expiry and logout close associated network sockets. The server does not refresh tokens.

Worlds, settings and installed game files stay in browser storage. They are not Docker volumes or server backups. Changing the browser origin changes the storage available to the launcher.

The server operator can inspect in-memory credentials and game keys. The configured origin must use HTTPS for non-loopback access. The server's TCP and pack relays reject local and private destinations, including disallowed DNS answers. This distribution has no LAN relay or local CLI pairing.

## Verification

`npm run check` covers source and application contracts. Container checks must build and start the supplied image, then request `/healthz` and `/`. Browser layout, live account import, authenticated Install/Play, online joining, and GPU rendering are separate checks. Report each check within its actual scope.

See [installation](deployment.md), [runtime build](runtime-build.md), and [runtime provenance](runtime-integration.md).
