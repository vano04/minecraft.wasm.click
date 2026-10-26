"use strict";
let mcWebLocalSocketId = 0;
const mcWebLocalSockets = new Map();
function mcWebAttachLocalSocket(socket, host, port) {
  const relay = globalThis.mcWebLocalRelayPort;
  if (!relay) return false;
  if (!relay.mcwebListening) {
    relay.mcwebListening = true;
    relay.onmessage = ({ data }) => {
      const entry = mcWebLocalSockets.get(data?.id);
      entry?.worker.postMessage({ type: 'relay', event: data });
    };
  }
  socket.localId = ++mcWebLocalSocketId;
  mcWebLocalSockets.set(socket.localId, socket);
  relay.postMessage({ type: 'open', id: socket.localId, host, port });
  return true;
}
// Packet-WebSocket interface used by mc-net; all wire work runs separately.
globalThis.MinecraftWispSocket = class {
  constructor(host, port, path) {
    this.url = new URL(path, globalThis.location.href).toString();
    this.worker = new Worker(new URL('mc-wisp-worker.js', globalThis.location.href));
    this.worker.onerror = () => this.onerror?.({ message: 'Minecraft networking worker failed' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'relay-send' || data.type === 'relay-close') {
        globalThis.mcWebLocalRelayPort?.postMessage({ id: this.localId, type: data.type === 'relay-send' ? 'send' : 'close', value: data.value });
      } else if (data.type === 'ready') this.onmessage?.({ data: '{"connected":true}' });
      else if (data.type === 'packet') {
        this.onmessage?.({ data: data.bytes });
        this.worker.postMessage({ type: 'ack', bytes: data.bytes.byteLength });
      }
      else if (data.type === 'error') {
        this.onclose?.({ code: 1011, reason: data.error }); this.close();
      } else if (data.type === 'close') {
        this.onclose?.({ code: data.code, reason: data.reason }); this.close();
      }
    };
    const local = globalThis.mcWebConfig?.gateway?.transport === 'local';
    this.worker.postMessage({ type: 'open', host, port, path, local });
    if (local && !mcWebAttachLocalSocket(this, host, port)) {
      queueMicrotask(() => this.onclose?.({ code: 1011, reason: 'Local relay is not paired' })); this.worker.terminate();
    }
  }
  send(value) {
    if (typeof value === 'string') {
      const control = JSON.parse(value);
      if (control.keepAlive) this.worker.postMessage({ type: 'keepAlive', value: control.keepAlive });
    } else {
      const bytes = new Uint8Array(value).slice(); this.worker.postMessage({ type: 'send', bytes: bytes.buffer }, [bytes.buffer]);
    }
  }
  close() {
    if (this.localId) {
      globalThis.mcWebLocalRelayPort?.postMessage({ type: 'close', id: this.localId });
      mcWebLocalSockets.delete(this.localId); this.localId = 0;
    }
    this.worker.terminate();
  }
};
