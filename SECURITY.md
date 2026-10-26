# Security reporting

Use [GitHub private vulnerability reporting](https://github.com/vano04/minecraft.wasm.click/security/advisories/new). If GitHub does not offer a private reporting form, contact the maintainer through the [project profile](https://github.com/vano04) to arrange a private report. Do not open a public issue with credentials, an exploit against a live account or details that expose player data.

Describe the affected revision, route, required access, reproduction steps and observed impact. Use test accounts and redacted request examples. Exclude access tokens, session cookies, account JSON, private keys and player files. Test only accounts, servers and environments you control.

## Authentication and hosting

The server accepts the selected short-lived Minecraft credential from a browser import of a Prism account file. It verifies Java Edition entitlement and the selected profile with Minecraft Services before it creates an isolated browser session. It keeps the credential in memory until logout, expiry, or restart. It does not refresh tokens or persist imported account files.

An operator who controls the server can access in-memory credentials and game encryption keys. Import an account only into a host you trust. Use HTTPS for remote access. The default Docker install binds to loopback.

The server's authenticated TCP and resource-pack relays accept public destinations only. DNS resolution, redirect handling, origin checks, and session binding are security boundaries. Private and local network targets must remain rejected. When you change sessions, protected runtime delivery, signed profiles, file paths, or request-size limits, add denied-request tests.

Security fixes target the latest published revision and the release identified by `/notices/source.json`. Older revisions and experimental branches have no separate support commitment. Maintainers should enable and check private vulnerability reporting before they publish the repository.
