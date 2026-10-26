/* Minecraft packet bodies <-> authenticated TCP relay, off the render worker. */
"use strict";
const runtimeBase = new URL(new URLSearchParams(location.search).get('runtime') || '/', location.href);
if (runtimeBase.origin !== location.origin) throw Error('Cross-origin runtime refused');
importScripts(new URL('aes-js.js', runtimeBase).href);
const MAX_PACKET = 16 * 1024 * 1024, MAX_QUEUED = 32 * 1024 * 1024;
const textEncoder = new TextEncoder(), textDecoder = new TextDecoder('utf-8', { fatal: true });
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out;
};
function varInt(value) {
  const bytes = []; do { let byte = value & 127; value >>>= 7; if (value) byte |= 128; bytes.push(byte); } while (value);
  return new Uint8Array(bytes);
}
function readInt(bytes, start = 0) {
  let value = 0, at = start;
  for (let shift = 0; shift < 35; shift += 7) {
    if (at === bytes.length) return null;
    const byte = bytes[at++]; value |= (byte & 127) << shift;
    if (!(byte & 128)) {
      if (value < 0 || (shift === 28 && (byte & 240))) throw Error('Invalid Minecraft VarInt');
      return { value, next: at };
    }
  }
  throw Error('Minecraft VarInt too long');
}
function base64(bytes) {
  let value = ''; for (let at = 0; at < bytes.length; at += 32768) value += String.fromCharCode(...bytes.subarray(at, at + 32768));
  return btoa(value);
}
const unbase64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
async function transform(bytes, stream, maximum) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maximum) { await reader.cancel(); throw Error('Minecraft packet exceeds limit'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return concat(...parts);
}

const MAX_WINDOW = 1024 * 1024;
let ws, host, port, metadata, available = 0, inFlight = 0, announced = false, ready = false, closed = false;
let tcp = new Uint8Array(), queued = 0, outputBytes = 0, outgoingBytes = 0, unackedBytes = 0, phase = 'handshake', threshold = -1;
let cipher, decipher, incoming = Promise.resolve(), outgoing = Promise.resolve();
const output = [];
let keepAlive, lastActivity = Date.now(); const answered = new Set();
const notify = (type, fields = {}) => postMessage({ type, ...fields });
class LocalSocket {
  constructor() { this.bufferedAmount = 0; }
  send(value) { notify('relay-send', { value }); }
  close() { notify('relay-close'); }
}
function fail(error) {
  if (closed) return;
  closed = true; notify('error', { error: String(error?.message || error) });
  try { ws?.close(); } catch {}
}
function flush() {
  while (!closed && output.length && available >= output[0].length && ws.bufferedAmount < MAX_WINDOW) {
    const value = output.shift(); outputBytes -= value.length;
    available -= value.length; inFlight += value.length;
    ws.send(value);
  }
}
function write(bytes) {
  const wire = cipher ? cipher.encrypt(bytes) : bytes;
  for (let at = 0; at < wire.length; at += 32768) {
    const part = wire.slice(at, at + 32768); output.push(part); outputBytes += part.length;
  }
  if (outputBytes > MAX_QUEUED) throw Error('Minecraft send queue exceeded');
  flush();
}
async function frame(body) {
  let payload = body;
  if (threshold >= 0) payload = body.length < threshold ? concat(varInt(0), body)
    : concat(varInt(body.length), await transform(body, new CompressionStream('deflate'), MAX_PACKET));
  return concat(varInt(payload.length), payload);
}
function sendBody(body) {
  const queuedLength = body.length;
  outgoingBytes += body.length;
  if (outgoingBytes > MAX_QUEUED) return fail('Minecraft outgoing packet backlog exceeded');
  outgoing = outgoing.then(async () => {
    if (closed) return;
    if (!body.length || body.length > MAX_PACKET) throw Error('Invalid Minecraft packet size');
    if (phase === 'handshake') {
      let at = readInt(body)?.next;
      at = readInt(body, at)?.next;
      const name = readInt(body, at); if (!name) throw Error('Invalid Minecraft handshake');
      const next = readInt(body, name.next + name.value + 2);
      if (!next || ![1, 2].includes(next.value)) throw Error('Invalid Minecraft intention');
      phase = next.value === 1 ? 'status' : 'login';
    } else if (phase === 'login' && readInt(body)?.value === 0) {
      const identity = metadata.profile, name = textEncoder.encode(identity.name);
      if (!/^[a-f0-9]{32}$/i.test(identity.id)) throw Error('Invalid authenticated Minecraft profile');
      const uuid = Uint8Array.from(identity.id.match(/../g), byte => Number.parseInt(byte, 16));
      body = concat(varInt(0), varInt(name.length), name, uuid);
    }
    if (keepAlive && body.length === keepAlive.length && body[0] === keepAlive.serverbound
        && answered.delete(base64(body.subarray(1)))) return;
    write(await frame(body));
  }).catch(fail).finally(() => { outgoingBytes -= queuedLength; });
}
async function encryptionRequest(body) {
  let at = readInt(body).next;
  const field = maximum => {
    const length = readInt(body, at); if (!length || length.value > maximum || length.next + length.value > body.length) throw Error('Invalid Minecraft encryption request');
    const value = body.slice(length.next, length.next + length.value); at = length.next + length.value; return value;
  };
  const serverId = textDecoder.decode(field(20)), publicKey = field(1024), verifyToken = field(32);
  const response = await fetch(new URL('/mcweb/minecraft/join', location.href), {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId: metadata.connectionId, serverId, publicKey: base64(publicKey), verifyToken: base64(verifyToken) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error('Minecraft sign-in failed; return to the launcher and sign in again');
  const material = await response.json(), secret = unbase64(material.secret);
  if (closed) return;
  if (secret.length !== 16) throw Error('Invalid Minecraft game secret');
  await outgoing;
  write(await frame(unbase64(material.response)));
  cipher = new aesjs.ModeOfOperation.cfb(secret, secret, 1);
  decipher = new aesjs.ModeOfOperation.cfb(secret, secret, 1);
}
async function serverBody(payload) {
  let body = payload;
  if (threshold >= 0) {
    const size = readInt(payload); if (!size || size.value > MAX_PACKET) throw Error('Invalid compressed Minecraft packet');
    body = payload.subarray(size.next);
    if (size.value) {
      body = await transform(body, new DecompressionStream('deflate'), size.value);
      if (body.length !== size.value || body.length < threshold) throw Error('Invalid Minecraft compressed size');
    }
  }
  const id = readInt(body)?.value;
  if (phase === 'login') {
    if (id === 1) { await encryptionRequest(body); return; }
    if (id === 3) {
      const value = readInt(body, readInt(body).next);
      if (!value || value.value > MAX_PACKET) throw Error('Invalid compression threshold');
      threshold = value.value; return;
    }
    if (id === 2) phase = 'play';
  }
  if (phase === 'play' && keepAlive && body.length === keepAlive.length && id === keepAlive.clientbound
      && Date.now() - lastActivity > 5000) {
    const token = base64(body.subarray(1)); answered.add(token);
    if (answered.size > 64) answered.delete(answered.values().next().value);
    outgoing = outgoing.then(async () => write(await frame(concat(varInt(keepAlive.serverbound), body.subarray(1))))).catch(fail);
    return;
  }
  unackedBytes += body.length;
  if (unackedBytes > MAX_QUEUED) throw Error('Minecraft renderer receive backlog exceeded');
  const bytes = body.slice(); postMessage({ type: 'packet', bytes: bytes.buffer }, [bytes.buffer]);
}
async function receive(bytes) {
  const plaintext = decipher ? decipher.decrypt(bytes) : bytes;
  tcp = concat(tcp, plaintext);
  if (tcp.length > MAX_QUEUED) throw Error('Minecraft receive queue exceeded');
  for (;;) {
    const size = readInt(tcp); if (!size) return;
    if (!size.value || size.value > MAX_PACKET) throw Error('Invalid Minecraft wire packet size');
    if (tcp.length < size.next + size.value) return;
    const payload = tcp.slice(size.next, size.next + size.value);
    tcp = tcp.slice(size.next + size.value);
    await serverBody(payload);
  }
}
function maybeReady() {
  if (ready || !announced || !metadata) return;
  ready = true;
  ws.send(JSON.stringify({ connect: { host: metadata.target.hostname, port: metadata.target.port } }));
}
onmessage = ({ data }) => {
  try {
    if (data.type === 'relay' && ws instanceof LocalSocket) {
      if (data.event.type === 'message') ws.onmessage?.({ data: data.event.value });
      else if (data.event.type === 'close') ws.onclose?.({ code: data.event.code, reason: data.event.reason });
    } else if (data.type === 'open') {
      if (ws) throw Error('Minecraft worker already connected');
      host = data.host; port = data.port;
      const url = new URL(data.path, location.href);
      if (url.origin !== location.origin) throw Error('Cross-origin TCP relay endpoint refused');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('host', host); url.searchParams.set('port', String(port));
      ws = data.local ? new LocalSocket() : new WebSocket(url); ws.binaryType = 'arraybuffer';
      ws.onmessage = event => {
        try {
          if (typeof event.data === 'string') {
            if (event.data.length > 4096) throw Error('Invalid TCP relay control');
            const control = JSON.parse(event.data);
            if (control.error) throw Error(String(control.error));
            if (control.connected === true && ready) { notify('ready'); return; }
            if (control.relay) {
              if (announced || control.relay.version !== 1 || control.relay.windowBytes !== MAX_WINDOW) throw Error('Invalid TCP relay window');
              announced = true; available = control.relay.windowBytes; maybeReady(); flush(); return;
            }
            if (Object.hasOwn(control, 'written')) {
              if (!Number.isInteger(control.written) || control.written < 1 || control.written > inFlight) throw Error('Invalid TCP write acknowledgement');
              inFlight -= control.written; available += control.written; flush(); return;
            }
            metadata = control.minecraft;
            if (!metadata?.connectionId || !metadata?.profile || !metadata?.target) throw Error('Invalid Minecraft connection metadata');
            maybeReady(); return;
          }
          const bytes = new Uint8Array(event.data);
          if (!ready || !bytes.length || bytes.length > 65536) throw Error('Invalid TCP relay packet');
          queued += bytes.length;
          if (queued > MAX_QUEUED) throw Error('Minecraft receive backlog exceeded');
          incoming = incoming.then(async () => {
            if (closed) return;
            await receive(bytes);
            if (!closed) ws.send(JSON.stringify({ received: bytes.length }));
          }).catch(fail).finally(() => { queued -= bytes.length; });
        } catch (error) { fail(error); }
      };
      ws.onerror = () => fail('Minecraft TCP connection failed');
      ws.onclose = event => {
        incoming = incoming.then(() => {
          if (!closed) { closed = true; notify('close', { code: event.code, reason: event.reason }); }
        }).catch(fail);
      };
      const pump = setInterval(() => { if (closed) clearInterval(pump); else flush(); }, 20);
    } else if (data.type === 'send') {
      lastActivity = Date.now(); sendBody(new Uint8Array(data.bytes));
    } else if (data.type === 'keepAlive') keepAlive = data.value;
    else if (data.type === 'ack' && Number.isInteger(data.bytes) && data.bytes >= 0) unackedBytes = Math.max(0, unackedBytes - data.bytes);
    else if (data.type === 'close') { closed = true; ws?.close(1000, 'Minecraft disconnected'); close(); }
  } catch (error) { fail(error); }
};
