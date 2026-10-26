# minecraft.wasm.click relay

A Minecraft TCP and server resource-pack relay for https://minecraft.wasm.click. Run it on your computer, in Docker or in your Cloudflare account. Microsoft sign-in, entitlement checks and session joining stay on minecraft.wasm.click; provider credentials never go to this relay. The relay sees Minecraft traffic and destinations, so use one you trust.

Choose the CLI for a computer on the same device/network, Docker for an existing server, or your own Cloudflare Worker. Docker/Worker hosting is optional and does not make cloud quotas unlimited.

The relay source is on this repository's `relay` branch. Clone it with:

```sh
git clone --branch relay --single-branch https://github.com/vano04/minecraft.wasm.click.git mcwc-relay
cd mcwc-relay
```

Or [download the relay branch ZIP](https://github.com/vano04/minecraft.wasm.click/archive/refs/heads/relay.zip) and extract it.

For the launcher's Docker release, name this checkout `relay` and place it beside the `main` checkout named `minecraft.wasm.click`. Its Compose build reads `tcp.mjs`, `transport.mjs` and `public-target.mjs` from this directory. The launcher handles account authentication and runs the shared transport in its own process, so this use needs no separate relay service or owner token.

## Local CLI

Follow https://minecraft.wasm.click/relay/. The shell/PowerShell launcher downloads the correct self-contained executable, verifies its published SHA-256, and runs it in your terminal. It opens no helper page. No admin access, background service, certificate installation or Node/Python runtime is needed. Windows, macOS and Linux have amd64 and arm64 downloads. Downloads are currently unsigned.

Scan its terminal QR or enter its eight-character code in launcher Settings → Local relay. On the same device you can open the printed pairing link. Type `y` at the terminal approval prompt. Keep the terminal open while playing; Ctrl+C stops it. Both QR and typed codes require approval, expire after ten minutes, and pair one browser. Restart for a new code.

The CLI uses Pion WebRTC directly for Safari/Firefox/Chrome and LAN play, with no TURN server. Same-device browsers can use a capability-protected loopback WebSocket. Allow local-network access when requested. Firewalls, Wi-Fi isolation and browser privacy restrictions can prevent direct connections. Provider credentials remain on minecraft.wasm.click.

### Build the CLI yourself

Install Go 1.27.3 for development only, then run:

```sh
cd native
go test -race ./...
go build -mod=readonly -trimpath -o mcwc-relay .
./mcwc-relay
```

Windows: build with `-o mcwc-relay.exe`, then run `.\mcwc-relay.exe`. Run `--licenses` to read the embedded project and dependency licenses. `go.mod` and `go.sum` pin dependencies. Maintainers with Node can run `node native/build.mjs build/cli` to cross-build all six downloads and checksums using Go 1.27.3. The build uses `CGO_ENABLED=0` and includes no game bytes. The default commands use the native CLI.

## Your Cloudflare Worker

Install Node 24 LTS, download this repo, and open a terminal in its folder. Run:

```sh
npm ci
npm run cloudflare:login
npm run cloudflare:deploy
```

The deploy command creates a token, uploads it as a Cloudflare secret, and checks the Worker. It saves your private connection URL in `.mcwc/cloudflare/mcwc-relay-connection.txt`. Copy that file's contents into minecraft.wasm.click Settings > Self-hosted relay URL, then choose Use self-hosted URL. Keep the `.mcwc` folder when updating so your URL continues to work.

No Go build, Docker or domain is needed. Deployment creates a SQLite-backed Durable Object class automatically. Each authenticated TCP or pack connection gets its own object; active streams stay in memory and do not write traffic or account data to storage. Cloudflare Worker and Durable Object request/duration quotas apply, including on the Free plan. See [the Cloudflare guide](CLOUDFLARE.md) for setup steps, updates and troubleshooting.

## Docker on your existing server

Create an untracked `.env` containing `RELAY_TOKEN=<at least 32 random characters>`. For a localhost health check:

```sh
docker compose up --build -d --wait
curl --fail http://127.0.0.1:8080/healthz
```

The default port binds to loopback. For browsers, configure a real public domain pointing at the server and reachable ports 80/443; add `RELAY_DOMAIN=relay.example.com` to `.env`, then:

```sh
docker compose -f compose.yaml -f compose.https.yaml up --build -d --wait
```

Caddy obtains/renews HTTPS automatically. Use `wss://relay.example.com/tcp/?token=YOUR_TOKEN` in launcher Settings. Alternatively put an existing HTTPS reverse proxy in front of localhost port 8080 and preserve WebSocket upgrades. Do not import certificates or enable insecure browser flags.

The container runs as a non-root user, drops capabilities, uses a read-only filesystem, and limits memory/processes. `MAX_CONNECTIONS` defaults to 64 per process. Node validates all DNS results and connects to the validated public IP. This intentionally prevents using a remote relay to reach its own private network; the local CLI handles LAN servers.

## Protocol and validation

Minecraft asks before applying a server resource pack. The browser first tries the server's HTTPS pack URL. If the pack host blocks browser reads, the selected relay can download and stream the pack. The local relay streams packs over WebRTC or its capability-protected loopback socket; hosted relays expose an authenticated `/pack/` endpoint.

Pack downloads allow public HTTPS destinations only, reject private DNS answers, limit redirects and cap downloads at 512 MiB. The browser requests bounded chunks, and disconnecting cancels the upstream request. Provider credentials, cookies and arbitrary request headers are not forwarded to pack hosts.

Each WebSocket or WebRTC data channel carries one TCP connection. Binary messages contain raw TCP bytes. Small JSON controls select the destination and acknowledge byte windows in each direction. The browser keeps Minecraft packet parsing, compression and encryption in a separate networking worker. Provider tokens stay with the launcher. UDP and arbitrary HTTP proxying are unsupported. Project source is GPL-3.0-only.

Build downloads use `mcwc-relay-<os>-<arch>`; publish the matching launchers, manifest and binaries together when updating the website.

Run `npm test`. It verifies the real Node relay against a local TCP fixture, exact large transfers, backpressure, token/Origin checks, target locking and private DNS rejection. Browser/gameplay acceptance is separate. `.env`, `.wrangler`, `.mcwc`, account data and downloaded game bytes must never enter Git or images.
