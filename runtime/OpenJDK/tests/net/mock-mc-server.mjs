#!/usr/bin/env node
// A Minecraft server stand-in for the stage 3 network probes
// (docs/NET-MIGRATION.md): just enough of the protocol for a client to ping it,
// log in, and reach configuration, written for MC-Web from the encodings
// WebSocketLinkProbe prints ("formats" mode, Mojang's own codecs). It runs no
// game. The client's intention host selects the script: "<host>#refuse" is
// refused at login; anything else logs in, turns on compression (threshold
// 64, so the gateway's compressed hand-over is exercised) and, in
// configuration, disconnects with a reason long enough to be compressed.
//
//   node OpenJDK/tests/net/mock-mc-server.mjs [--port 25565]
import net from "node:net";
import zlib from "node:zlib";
import { MC_VERSION } from "../../../tools/mc-version.mjs";

const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf("--port") + 1] || 25565);
const THRESHOLD = 64;
const LONG_REASON = "mock: configuration reached; " + "this reason is padded so that it is above the compression threshold. ".repeat(3);

const varInt = (value) => {
  const out = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
};
const string = (text) => {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([varInt(bytes.length), bytes]);
};
const readVarInt = (buf, at) => {
  let value = 0;
  let shift = 0;
  while (at < buf.length) {
    const b = buf[at++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: value >>> 0, next: at };
    shift += 7;
  }
  return null;
};
const readString = (buf, at) => {
  const length = readVarInt(buf, at);
  return { value: buf.subarray(length.next, length.next + length.value).toString("utf8"), next: length.next + length.value };
};

net.createServer((socket) => {
  let pending = Buffer.alloc(0);
  let phase = "handshake";
  let script = "ok";
  let protocol = 0;
  let compressed = false;
  const log = (line) => console.log(`[mock ${socket.remotePort}] ${line}`);

  const send = (body) => {
    let payload = body;
    if (compressed) {
      payload = body.length >= THRESHOLD
        ? Buffer.concat([varInt(body.length), zlib.deflateSync(body)])
        : Buffer.concat([varInt(0), body]);
    }
    socket.write(Buffer.concat([varInt(payload.length), payload]));
  };

  const handle = (body) => {
    const id = readVarInt(body, 0);
    if (phase === "handshake") {
      const version = readVarInt(body, id.next);
      const host = readString(body, version.next);
      const next = readVarInt(body, host.next + 2);
      protocol = version.value;
      script = host.value.includes("#") ? host.value.split("#")[1] : "ok";
      phase = next.value === 1 ? "status" : "login";
      log(`intention protocol=${protocol} host=${host.value} -> ${phase}`);
    } else if (phase === "status") {
      if (id.value === 0x00) {
        send(Buffer.concat([varInt(0x00), string(JSON.stringify({
          version: { name: MC_VERSION, protocol },
          players: { max: 20, online: 3, sample: [] },
          description: { text: "MC-Web mock server" },
        }))]));
      } else if (id.value === 0x01) {
        send(Buffer.concat([varInt(0x01), body.subarray(id.next, id.next + 8)]));
      }
    } else if (phase === "login") {
      if (id.value === 0x00) {
        const name = readString(body, id.next);
        const uuid = body.subarray(name.next, name.next + 16);
        log(`hello ${name.value} script=${script}`);
        if (script === "refuse") {
          send(Buffer.concat([varInt(0x00), string(JSON.stringify("mock: login refused"))]));
          socket.end();
          return;
        }
        send(Buffer.concat([varInt(0x03), varInt(THRESHOLD)]));
        compressed = true;
        send(Buffer.concat([varInt(0x02), uuid, string(name.value), varInt(0), uuid]));
      } else if (id.value === 0x03) {
        phase = "configuration";
        log("login acknowledged; configuration");
        const reason = Buffer.from(LONG_REASON, "utf8");
        const tag = Buffer.alloc(3);
        tag[0] = 0x08;
        tag.writeUInt16BE(reason.length, 1);
        send(Buffer.concat([varInt(0x02), tag, reason]));
        socket.end();
      }
    }
  };

  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const length = readVarInt(pending, 0);
      if (!length || pending.length - length.next < length.value) return;
      let body = pending.subarray(length.next, length.next + length.value);
      pending = pending.subarray(length.next + length.value);
      if (compressed) {
        const size = readVarInt(body, 0);
        body = size.value === 0 ? body.subarray(size.next) : zlib.inflateSync(body.subarray(size.next));
      }
      handle(body);
    }
  });
  socket.on("error", (error) => log(`error ${error.message}`));
}).listen(PORT, "127.0.0.1", () => console.log(`mock Minecraft server on 127.0.0.1:${PORT}`));
