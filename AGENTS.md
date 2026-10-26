# Agent-aided installation

Help the user run this checkout. Prefer the Docker install unless the task needs a source rebuild. Finish reversible setup and checks without asking for approval of routine choices. Ask only when missing information changes the install, such as a remote hostname.

## Install and inspect

1. Confirm Docker and Compose with `docker version` and `docker compose version`.
2. Confirm that the `relay` branch is checked out in the sibling `../relay` directory. Compose uses it as a separate build context for the TCP connector, WebSocket transport and destination checks. From the launcher repository root, run `docker compose up --build -d`.
3. Inspect `docker compose ps` and `docker compose logs --tail=100`.
4. Request `http://localhost:8080/healthz` and confirm HTTP 200. Open `http://localhost:8080/` and confirm the account-import page renders.
5. Verify the running container and those HTTP responses. A successful image build alone does not prove the server started.

The default endpoint binds to loopback. Set `PUBLIC_ORIGIN` only when the user needs a different origin. Non-loopback origins require HTTPS. For remote access, use the user's hostname and a TLS reverse proxy, forward WebSocket upgrades, and verify the final HTTPS address. Do not invent a production domain or cloud-provider setup. See [installation and operation](docs/deployment.md).

The default image uses the checked, prebuilt browser runtime. Do not rebuild OpenJDK for an ordinary install. [Runtime build instructions](docs/runtime-build.md) cover source changes that require a rebuild.

## Accounts and data

The user imports a Prism `accounts.json` through the browser. Explain where to find that file. Do not request its contents, print its values, or import an account on the user's behalf. Never place account files, tokens, cookies, worlds, or private keys in Git, a Docker build context, an image, a log, or a report. Tests use synthetic accounts and mocked provider responses.

The browser sends only the selected short-lived Minecraft credential and profile. The server must verify ownership and profile identity upstream before it authorizes a session. Keep sessions isolated by browser. Limit their lifetime. Revoke sockets on logout or expiry. Do not add a shared-account mode or an offline bypass.

Worlds and installed game files live in browser storage. Do not clear storage to troubleshoot unless you explain the data loss and the user directs you to proceed. Export accessible backups first.

## Verify changes

For source and application changes, run `npm ci`, `npm ci --prefix runtime`, and `npm run check`. Use `npm run verify:source` when checking runtime provenance. Run the affected browser flow after UI changes, and inspect desktop and mobile layouts. For install changes, build and start a container from a fresh context, then check its health and entry page.

Before publication, inspect the final source tree, Git history, and Docker context for private configuration, credentials, and player data. Check the published source and notice files against the selected runtime. Preserve upstream licenses and original source-manifest hashes. Record sanitized source and patch derivatives in `testing/public-source.json`. After an intentional runtime source or README change, run `node tools/update-public-source.mjs` and review the derived record. Do not replace checksums only to make a check pass.

Sounds and panorama images must download in the player's browser. Try Mojang first, then the version-pinned GitHub raw files. Keep size and hash checks. Do not proxy those downloads through the server.

Resource-pack rendering changes require moving and turning after the pack loads. Treat shader compilation, GPU validation, and pipeline errors as failures. A completed download or one screenshot does not prove correct rendering.

Update affected instructions, UI copy, and privacy text when behavior changes. Use plain sentences and the project's existing styles. Report only checks you actually ran. Distinguish local files, container behavior, and public deployment. Name any account, GPU, or physical-device checks that remain untested.
