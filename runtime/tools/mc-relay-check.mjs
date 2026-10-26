/**
 * Proves the relay carries a real Minecraft conversation, with no wasm image
 * involved: performs a Server List Ping through it, exactly as the browser will.
 *
 * Isolating this first is the repo rule. The relay, the WebSocket framing and the
 * VarInt packet framing are three new failure modes; a status ping exercises all
 * three and nothing else, and the server's answer is self-verifying (its MOTD).
 *
 * Usage: node tools/mc-relay-check.mjs [ws://127.0.0.1:25585] [host] [port]
 */
import { MC_PROTOCOL_VERSION } from "./mc-version.mjs";

const relay = process.argv[2] ?? "ws://127.0.0.1:25585";
const host = process.argv[3] ?? "127.0.0.1";
const port = Number(process.argv[4] ?? 25565);
const PROTOCOL_VERSION = Number(process.env.MC_PROTOCOL ?? MC_PROTOCOL_VERSION);

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}
function readVarInt(buffer, offset) {
  let value = 0, shift = 0, cursor = offset;
  for (;;) {
    const b = buffer[cursor++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: value >>> 0, next: cursor };
    shift += 7;
  }
}
const writeString = (text) => {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([writeVarInt(bytes.length), bytes]);
};

const socket = new WebSocket(`${relay}/?host=${encodeURIComponent(host)}&port=${port}`);
socket.binaryType = "arraybuffer";

const fail = (why) => { console.error("FAIL:", why); process.exit(1); };
const timer = setTimeout(() => fail("no status response within 10s"), 10_000);

const LOGIN = process.argv.includes("--login");

socket.addEventListener("open", () => {
  console.log(`connected to ${relay} -> ${host}:${port}`);
  // Handshake: id 0x00, protocol version, address, port, next state 1 (status).
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port, 0);
  socket.send(Buffer.concat([
    writeVarInt(0x00),
    writeVarInt(PROTOCOL_VERSION),
    writeString(host),
    portBytes,
    writeVarInt(LOGIN ? 2 : 1)
  ]));
  if (LOGIN) {
    // Hello: name + UUID. The relay rewrites both to the authenticated account,
    // so what is sent here only has to be well formed.
    socket.send(Buffer.concat([
      writeVarInt(0x00),
      writeString("Probe"),
      Buffer.alloc(16)
    ]));
  } else {
    socket.send(writeVarInt(0x00));   // status request
  }
});

socket.addEventListener("message", (event) => {
  const body = Buffer.from(event.data);
  const id = readVarInt(body, 0);
  if (LOGIN) {
    // 0x02 Login Finished means the server accepted the session: encryption and
    // the Mojang join both succeeded, and none of it reached this client.
    if (id.value === 0x02) {
      const nameLen = readVarInt(body, id.next + 16);
      const who = body.subarray(nameLen.next, nameLen.next + nameLen.value).toString("utf8");
      console.log(`PASS: authenticated login finished as "${who}"`);
      clearTimeout(timer);
      socket.close();
      process.exit(0);
    }
    if (id.value === 0x00) {
      const len = readVarInt(body, id.next);
      console.error("FAIL: server disconnected:",
        body.subarray(len.next, len.next + len.value).toString("utf8"));
      process.exit(1);
    }
    console.log(`login packet id 0x${id.value.toString(16)} (${body.length} bytes)`);
    return;
  }
  if (id.value !== 0x00) {
    console.log(`ignoring packet id 0x${id.value.toString(16)} (${body.length} bytes)`);
    return;
  }
  const length = readVarInt(body, id.next);
  const json = body.subarray(length.next, length.next + length.value).toString("utf8");
  clearTimeout(timer);
  try {
    const status = JSON.parse(json);
    console.log("PASS: server answered through the relay");
    console.log("  version:", status.version?.name, "protocol", status.version?.protocol);
    console.log("  players:", `${status.players?.online}/${status.players?.max}`);
    const motd = status.description?.text ?? JSON.stringify(status.description);
    console.log("  motd:", motd);
    if (status.version?.protocol !== PROTOCOL_VERSION) {
      console.log(`  NOTE: client sent protocol ${PROTOCOL_VERSION};`
        + ` server speaks ${status.version?.protocol}. Set MC_PROTOCOL to match.`);
    }
    socket.close();
    process.exit(0);
  } catch {
    fail(`status JSON did not parse: ${json.slice(0, 200)}`);
  }
});

socket.addEventListener("error", () => fail("websocket error"));
socket.addEventListener("close", () => {
  clearTimeout(timer);
});
