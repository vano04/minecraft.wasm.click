# Contributing

Use [GitHub issues](https://github.com/vano04/minecraft.wasm.click/issues) for reproducible bugs and proposed changes. Follow [SECURITY.md](SECURITY.md) for vulnerabilities. Do not attach account files, tokens, cookies, worlds or downloaded game files.

## Set up

For a running launcher, use the [Docker install](README.md#run-with-docker). For source checks, use Node.js 24 LTS and run these commands from the repository root:

~~~sh
npm ci
npm ci --prefix runtime
npm run check
~~~

The default install uses the reviewed runtime archive and does not require a JVM build. Read [architecture](docs/architecture.md) before changing server or runtime boundaries. Read [runtime build instructions](docs/runtime-build.md) when a change needs new Java adapters, browser runtime modules or OpenJDK output.

## Change and verify

Keep each change focused on an observable result. In the pull request, explain the problem, the resulting behavior, and the checks you ran. Add tests for behavior that could regress. Authentication tests use fixture credentials and mocked provider responses. Do not point tests at live authentication services or use somebody else's account.

Run `npm run check` before submitting. Verify UI changes in the rendered page. Verify Docker changes by building and starting the image, then requesting `/healthz` and `/`. List checks that need a real account, GPU, runtime rebuild, or physical device separately from the checks that passed.

When you change authentication, test rejected imports, ownership and profile mismatches, duplicate cookies, expiry, logout, and browser-session isolation. When you change networking, test public-target restrictions and DNS results as well as successful connections. Do not send provider tokens to a browser or a Minecraft relay.

World storage, browser encryption, resource-pack checks, and signed profile verification must keep their existing behavior. Rendering changes need an actual GPU check. After a resource pack loads, move and turn with the pack active. Inspect shader, pipeline, and GPU validation errors.

## Source and notices

Keep generated build caches, downloaded Minecraft files, and player data outside Git. The reviewed `artifacts/runtime.tar.gz` is a distribution input. `artifacts/runtime.json` records its exact bytes. Do not replace the archive or its manifest without reviewing the runtime, corresponding source, and notices together.

Preserve upstream copyright and license texts. Keep original manifest hashes as provenance. `testing/public-source.json` records the sanitized public source and patch derivatives. After an intentional runtime source or README change, regenerate that record with `node tools/update-public-source.mjs` and review the differences. Do not regenerate expected hashes only to silence a failed check. The source archive at `/notices/` must identify the source that accompanies the shipped runtime.

Describe actual requests in privacy text. The browser downloads game files, sounds, and panorama images. The server verifies imported Minecraft credentials, authorizes online joins, and carries authenticated relay traffic. Resource-pack fallback downloads run on the server. Update the affected documentation when one of these paths changes.
