# Deploy the relay to Cloudflare

You need a Cloudflare account and Node 24 LTS. You do not need Go, Docker or a domain. The deployment command creates the required SQLite-backed Durable Object class automatically.

## First deployment

1. [Download the relay branch ZIP](https://github.com/vano04/minecraft.wasm.click/archive/refs/heads/relay.zip), then extract it. Or run `git clone --branch relay --single-branch https://github.com/vano04/minecraft.wasm.click.git mcwc-relay`.
2. Open Terminal or PowerShell in the extracted repo folder.
3. Run these commands one at a time:

~~~sh
npm ci
npm run cloudflare:login
npm run cloudflare:deploy
~~~

The login command opens Cloudflare in your browser. Sign in and allow Wrangler to deploy Workers to your account.

The deploy command creates a random owner token and uploads it as an encrypted Cloudflare secret. It also checks the Worker's health. When it finishes, it prints the Worker address and the path to your connection file.

## Connect Minecraft

1. Open .mcwc/cloudflare/mcwc-relay-connection.txt in a text editor.
2. Copy its entire line.
3. Open minecraft.wasm.click, sign in, and open Settings.
4. Select Self-hosted relay URL, paste the line into the URL field, and choose Use self-hosted URL.
5. Start Minecraft and connect to your server.

The URL has this form:

~~~text
wss://mcwc-relay.YOUR_SUBDOMAIN.workers.dev/tcp/?token=YOUR_TOKEN
~~~

Use the URL from your connection file. Do not add a Minecraft server address to it. The launcher adds the server address when it connects.

You can close the deployment terminal after setup. Cloudflare runs the relay. Multiplayer through this URL needs no local relay CLI or pairing code.

## Check the Worker

Open the Worker address with /healthz at the end:

~~~text
https://mcwc-relay.YOUR_SUBDOMAIN.workers.dev/healthz
~~~

A configured Worker returns:

~~~json
{"status":"ok","protocol":"tcp"}
~~~

The address without /healthz returns 403. That is expected. The relay accepts WebSocket connections with the owner token and the minecraft.wasm.click Origin.

Each authenticated connection runs in a separate Durable Object. Incoming WebSocket messages renew its CPU budget. An active TCP or pack stream keeps its object awake; the relay does not store traffic, tokens or account data in the object.

The Worker supports both Minecraft TCP at `/tcp/` and server resource-pack downloads at `/pack/`. The launcher selects the pack route when a direct HTTPS download is blocked by CORS. Both routes require the owner token and allowed Origin. Pack hosts receive no Microsoft credentials or cookies.

A passing health check confirms the Worker has its token. Connecting to a Minecraft server also checks outbound TCP.

## Update

Pull the new repo version, keep the .mcwc folder, and run:

~~~sh
npm ci
npm run cloudflare:deploy
~~~

The command reuses the saved token. The existing URL continues to work.

If you downloaded a new ZIP, copy your old .mcwc folder into the new repo folder before deploying. Deleting the saved token causes the next deployment to create a new one. Old connection URLs then stop working.

The default Worker name is `mcwc-relay`. For a custom name, keep the saved secrets filename as `<worker-name>-secrets.json` and use the same `--name` on each deployment.

## Use a different Worker name

~~~sh
npm run cloudflare:deploy -- --name my-mc-relay
~~~

Its connection file will be .mcwc/cloudflare/my-mc-relay-connection.txt. Use the same name for later updates.

To check the bundle without deploying:

~~~sh
npm run cloudflare:deploy -- --dry-run
~~~

## Private files

The .mcwc/cloudflare/ folder contains the token and connection URL. Git ignores it. Keep it private and back it up before moving the repo. Do not paste its contents into an issue, commit or screenshot.

The token permits TCP connections through your Worker. Microsoft account tokens stay with minecraft.wasm.click and never go to this relay.

## Limits and troubleshooting

- Cloudflare Worker and Durable Object request/duration quotas apply. SQLite-backed Durable Objects are available on the Free plan. Active connections do not hibernate, so they consume object duration even while a player stands still. This does not provide unlimited multiplayer capacity.
- Cloudflare blocks TCP connections to private/local addresses and Cloudflare IP ranges. Use the local CLI for a LAN Minecraft server.
- A 403 response to a relay connection means the token, path or browser Origin is wrong. Copy the full connection-file URL again and use it on minecraft.wasm.click.
- If deployment says you are not signed in, run npm run cloudflare:login, then deploy again.
- A new workers.dev address may take a short time to respond. The deploy command retries its health check. If it still fails, open /healthz again before redeploying.
- If you have several Cloudflare accounts, select the intended account when Wrangler asks.

Cloudflare documents [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Durable Object pricing and Free-plan quotas](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [outbound TCP restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#troubleshooting).
