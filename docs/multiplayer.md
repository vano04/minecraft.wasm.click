# Multiplayer and resource packs

The included Node server provides an authenticated TCP relay. After account import, the browser can connect to public Minecraft servers through that relay. This distribution does not provide LAN access or local CLI pairing.

The Docker image builds its TCP connector, TCP bridge and destination checks from the sibling `relay` branch checkout. The launcher authenticates each browser and binds its connections to that browser's session. See [installation](deployment.md) for the two-checkout layout.

## Connection flow

The browser opens an authenticated control connection and requests a Minecraft target. The server checks the target and DNS results before opening TCP. Private, loopback and local destinations remain rejected. A hostname that resolves to a disallowed address does not bypass those checks.

The server handles the purpose-bound Minecraft session-join request with the selected account's in-memory token. It generates connection-specific encryption material and returns it to the browser. The browser handles Minecraft encryption and compression. The TCP relay then forwards game bytes between the browser and the Minecraft server.

DNS lookup uses the address families configured on the server. An IPv4-only Docker network does not request unusable IPv6 answers, including DNS64 synthesis. Every returned address must still pass the public-destination checks, and TCP connects to a validated address without another DNS lookup. The same rule applies to server resource-pack downloads.

The relay receives no account token from the browser networking code. Account import and session join belong to the authentication server in the same process. The server operator can access the retained token and connection keys. Import an account only into a host you trust.

Session expiry, logout and server restart end the session and close its connections. Refresh the account in Prism and import it again after expiry. The server does not refresh an imported token.

## Resource packs

Minecraft asks before applying a server resource pack. The browser first tries the pack's HTTPS URL. If the host blocks browser reads, the authenticated server relay can fetch and stream the pack to the browser.

Pack downloads retain their size limits, hash checks and confirmation flow. The fallback must apply public-destination and DNS checks. It must not become an arbitrary unauthenticated download proxy.

The pack host sees the address of the browser or server that makes the request. The launcher server sees the pack URL and contents when it makes the fallback request. This differs from sounds and panorama images, which download directly in the browser and do not use the relay.

## Hosting and troubleshooting

A remote installation needs HTTPS and a reverse proxy that forwards WebSocket upgrades. See [installation](deployment.md).

If a join fails, check the server hostname and port, the imported account's expiry, container logs and the proxy's WebSocket configuration. Local and private destinations are intentionally unsupported. Do not paste account files, tokens or cookies into a report.

For pack rendering changes, test movement and camera turns after the pack applies. Check shader compilation, GPU validation and pipeline errors. A completed download does not establish correct rendering.
