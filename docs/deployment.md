# Install and operate

The default install runs one Docker Compose service on this computer. It uses the included reviewed runtime archive. You do not need a cloud-provider account or a native JVM build.

## Start locally

Install Docker with Compose 2.17 or later. Check out the `main` and `relay` branches into sibling directories:

~~~sh
git clone --branch main --single-branch https://github.com/vano04/minecraft.wasm.click.git minecraft.wasm.click
git clone --branch relay --single-branch https://github.com/vano04/minecraft.wasm.click.git relay
cd minecraft.wasm.click
docker compose up --build -d
~~~

Open [http://localhost:8080](http://localhost:8080). Compose binds the service to 127.0.0.1:8080. The default PUBLIC_ORIGIN is http://localhost:8080. Use that address consistently because cookies and saved browser files belong to an origin.

The Docker build uses `../relay` as an additional source context for the TCP connector, TCP byte acknowledgements and public-destination checks. The launcher keeps its account verification, session ownership and resource-pack adapter. Only the selected source modules enter the image; relay credentials, native CLI builds and local helper scripts are not included. A direct Docker build needs `docker build --build-context relay=../relay .`.

Check the running service:

~~~sh
docker compose ps
docker compose logs --tail=100
curl --fail http://localhost:8080/healthz
~~~

The health endpoint should return HTTP 200. Open / to confirm that the account-import page renders. Import the account through its browser file picker. Do not mount an account file into the container or include it in the Docker build context.

## Use an HTTPS host

To serve another computer, configure a hostname and a TLS reverse proxy that forwards to the loopback service. Preserve the original Host header. Forward WebSocket upgrades for multiplayer and pack streams. The account-import page must load through the proxy. A successful health request alone does not verify the Host configuration.

Set PUBLIC_ORIGIN to the exact HTTPS origin used by players, without a path:

~~~sh
PUBLIC_ORIGIN=https://play.example.com docker compose up --build -d
~~~

Replace the example hostname with your own. A non-loopback origin must use HTTPS. Verify the public /healthz endpoint and account-import page through the proxy. The server checks request origins against PUBLIC_ORIGIN.

Do not expose the container port directly as a substitute for HTTPS. Restrict proxy access to the intended audience. Imported Minecraft credentials reach the server, and its operator can access them while the session is active.

Changing the hostname, scheme or port changes the browser origin. Export worlds before moving users to another origin. Existing browser files do not move with a Docker container.

## Update or stop

Keep copies of both reviewed checkouts for rollback. Update the launcher and sibling relay source to the selected release, then rebuild and start from the launcher directory:

~~~sh
docker compose up --build -d
~~~

Then check container health, the entry page, and `/notices/source.json`. Confirm that the running source and runtime manifest identify the intended release. A server restart ends all account sessions. Players import refreshed accounts again.

To stop the service:

~~~sh
docker compose down
~~~

Stopping or replacing the container does not delete worlds stored in players' browsers. Clearing browser storage can delete them.

## Runtime and source

artifacts/runtime.tar.gz contains the reviewed browser runtime. artifacts/runtime.json records its exact files and archive identity. The Docker build verifies these inputs before serving them. The runtime excludes Minecraft client/server code and game assets.

The server publishes corresponding source, runtime checksums and licenses at /notices/. Keep those files with the runtime they describe. [Runtime provenance](runtime-integration.md) explains the source and artifact records. [Runtime build instructions](runtime-build.md) cover the optional source build.
