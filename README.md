# minecraft.wasm.click

A browser launcher for Minecraft: Java Edition. It runs a modified OpenJDK 25 runtime through WebAssembly and renders with WebGPU. You need an account that owns Java Edition and a browser with WebGPU, enough memory and browser storage.

## Run with Docker

Install Docker with Compose 2.17 or later. Clone both branches into sibling directories, then start the launcher:

~~~sh
git clone --branch main --single-branch https://github.com/vano04/minecraft.wasm.click.git minecraft.wasm.click
git clone --branch relay --single-branch https://github.com/vano04/minecraft.wasm.click.git relay
cd minecraft.wasm.click
docker compose up --build -d
~~~

Open [http://localhost:8080](http://localhost:8080). The default install binds to this computer's loopback address. It needs no cloud account, application registration or client secret.

The image includes the reviewed browser runtime from artifacts/runtime.tar.gz. The Docker build checks it against artifacts/runtime.json. It does not rebuild the JVM or include Minecraft client/server code or game assets.

Compose takes the TCP connector, TCP bridge and destination checks from `../relay`, the `relay` branch checkout. These run inside the launcher process with its account sessions. No separate relay service or relay token is needed.

Check the server or stop it:

~~~sh
docker compose logs --tail=100
docker compose down
~~~

See [installation and operation](docs/deployment.md) for updates and an optional HTTPS setup for other computers.

## Import your account and play

1. Sign in to [Prism Launcher](https://prismlauncher.org/) with an account that owns Minecraft: Java Edition. Refresh that account before importing it here.
2. Open the web launcher and select your Prism accounts.json file. The page uses its active account, or the first account when none is active. It sends only that account's short-lived Minecraft token and profile for verification. It does not upload refresh tokens or other accounts.
3. Select Install. Your browser downloads the pinned Minecraft client and required libraries from Mojang into browser storage.
4. Select Play. Use Settings for controls, resolution, memory, worlds and resource packs.

Find Prism's account file in its data directory. Common locations are %APPDATA%\PrismLauncher\accounts.json on Windows, ~/Library/Application Support/PrismLauncher/accounts.json on macOS and ~/.local/share/PrismLauncher/accounts.json on Linux. Flatpak commonly uses ~/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher/accounts.json. Portable installations use their own data directory.

Treat that file as a credential. Select it in the browser file picker. Do not copy it into this repository, a Docker image, an issue or a public upload.

The server verifies ownership and the selected profile with Minecraft Services. Each browser gets its own session. Sessions last at most four hours and end earlier when the imported token expires. Logout or a server restart ends them too. To continue after expiry, refresh the account in Prism and import it again. The server does not refresh tokens.

## Worlds and multiplayer

Worlds, settings, installed files and imported resource packs stay in your browser's storage. Export backups through Settings before clearing site data or changing browsers. Storage eviction, a different browser profile or a different site address can make those files unavailable.

The included server provides an authenticated TCP relay for public Minecraft servers. It checks DNS results and rejects private and local addresses. It also downloads accepted server resource packs when the pack host blocks direct browser reads. LAN servers and local CLI pairing are not supported by this distribution. Read [multiplayer](docs/multiplayer.md) for the request flow and limits.

Sounds and panorama images download in the player's browser. The browser tries Mojang first, then the version-pinned [Minecraft assets repository on GitHub](https://github.com/InventivetalentDev/minecraft-assets/tree/26.3/assets). It checks asset sizes and hashes. The launcher server does not proxy these files.

## Development

Use Node.js 24 LTS for local checks:

~~~sh
npm ci
npm ci --prefix runtime
npm run check
~~~

[AGENTS.md](AGENTS.md) describes agent-aided installation and verification. [Contributing](CONTRIBUTING.md) covers changes and tests. [Runtime build instructions](docs/runtime-build.md) describe the optional source build and its larger toolchain requirements.

Report reproducible bugs through [GitHub issues](https://github.com/vano04/minecraft.wasm.click/issues). Follow [SECURITY.md](SECURITY.md) for vulnerabilities. Remove credentials and player data from reports.

Project-authored code uses GPLv3. Dependencies retain their own licenses. See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md) and the running server's /notices/ page for license texts, runtime checksums and corresponding source.

NOT AN OFFICIAL MINECRAFT PRODUCT OR SERVICE. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
