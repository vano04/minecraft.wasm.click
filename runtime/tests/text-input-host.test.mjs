import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

// The GPU Worker half of the native-keyboard bridge: the production worker
// environment and host (web/webgpu-host.js). Input and text handling need no
// GPU, so the host is loaded without WebGPU and its boot stops at once (the
// failure path, caught by the host). Java's side is the progress marker
// BrowserTextInput sends and the mailbox lines its input bridge reads
// (dev.mcweb.graal.BrowserInputBridge); the page's side is the
// { mcwebTextInput } it receives and the { mcwebText } it sends.
const source = await Promise.all([
  "OpenJDK/browser/worker-env.js", "web/webgpu-texture-lifetime.js",
  "web/render-command-stream.js", "web/shader-glue.js", "web/webgpu-host.js",
].map(async (path) => [path, await readFile(new URL("../" + path, import.meta.url), "utf8")]));
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const plain = (value) => JSON.parse(JSON.stringify(value));

async function loadHost() {
  const posted = [], messageListeners = [], logs = [];
  const context = vm.createContext({
    URL, URLSearchParams, Uint8Array, Uint16Array, Uint32Array, Float32Array, Int32Array, ArrayBuffer, DataView,
    TextEncoder, TextDecoder,
    performance: { now: () => 100 }, location: { search: "", href: "https://fixture.invalid/" },
    console: Object.fromEntries(["log", "warn", "error", "table"].map((method) =>
      [method, (...args) => logs.push([method, args.map(String).join(" ")])])),
    navigator: {},
    // Nothing here draws: the offscreen canvas is never asked for a context.
    __mcWebOffscreen: { width: 64, height: 4 },
    addEventListener(type, listener) { if (type === "message") messageListeners.push(listener); },
    removeEventListener() {},
    postMessage(message) { posted.push(plain(message)); },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    atob: (text) => Buffer.from(text, "base64").toString("binary"),
    GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
    GPUBufferUsage: { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 }, GPUMapMode: { READ: 1 },
  });
  for (const [name, text] of source) vm.runInContext(text, context, { filename: name });
  await settle();
  // The input bridge gpu-rpc-worker.js registers: one mailbox line per call.
  const lines = [];
  context.mcWebInput.register((name, a, b, c, d) => lines.push([name, a, b, c, d].join(" ")));
  const fromPage = (data) => { for (const listener of messageListeners) listener({ data }); };
  const textStates = () => posted.filter((m) => m.mcwebTextInput).map((m) => m.mcwebTextInput);
  return { context, host: context.mcWebGpu, posted, lines, logs, fromPage, textStates };
}

test("a text-input marker becomes the page's state, not a logged progress stage", async () => {
  const h = await loadHost();
  const stageBefore = h.context.__mcWebLastStage;
  const logsBefore = h.logs.length;
  h.host.reportProgress("evt:text-input 1 1 412 306 1 21 2 400 300 480 40 1 400 360 480 40 0");
  assert.deepEqual(h.textStates(), [{
    active: true,
    owner: "widget",
    area: { x: 412, y: 306, w: 1, h: 21 },
    fields: [{ x: 400, y: 300, w: 480, h: 40, focused: true }, { x: 400, y: 360, w: 480, h: 40, focused: false }],
    seq: 1,
  }]);
  assert.equal(h.context.__mcWebLastStage, stageBefore);
  assert.equal(h.logs.length, logsBefore);

  // The sign editor: the screen owns text input, no field is listed.
  h.host.reportProgress("evt:text-input 1 2 600 200 1 21 0");
  assert.deepEqual(h.textStates().at(-1),
    { active: true, owner: "screen", area: { x: 600, y: 200, w: 1, h: 21 }, fields: [], seq: 2 });

  h.host.reportProgress("evt:text-input 0 0 -1 -1 0 0 0");
  assert.deepEqual(h.textStates().at(-1), { active: false, owner: null, area: null, fields: [], seq: 3 });
  // A page that attached late asks once and gets the current state.
  h.fromPage({ mcwebTextInputQuery: true });
  assert.deepEqual(h.textStates().at(-1), { active: false, owner: null, area: null, fields: [], seq: 3 });
  // A torn marker changes nothing.
  h.host.reportProgress("evt:text-input 1 1 2 x");
  assert.equal(h.textStates().length, 4);
});

test("committed text is one charInput per code point, astral planes included", async () => {
  const h = await loadHost();
  h.fromPage({ mcwebText: { kind: "commit", text: "hé😀日" } });
  assert.deepEqual(h.lines, ["charInput 104 0 0 0", "charInput 233 0 0 0", "charInput 128512 0 0 0",
    "charInput 26085 0 0 0"]);
});

test("a composition is spelled out for one SDL_EVENT_TEXT_EDITING, an empty one clears it", async () => {
  const h = await loadHost();
  h.fromPage({ mcwebText: { kind: "preedit", text: "にほ", cursor: 2, selection: 0 } });
  h.fromPage({ mcwebText: { kind: "preedit", text: "", cursor: 0, selection: 0 } });
  assert.deepEqual(h.lines, [
    "textPreeditBegin 0 0 0 0", "textPreeditChar 12395 0 0 0", "textPreeditChar 12411 0 0 0",
    "textPreeditEnd 2 0 0 0",
    "textPreeditBegin 0 0 0 0", "textPreeditEnd 0 0 0 0",
  ]);
});

test("a key the page's textarea forwards is one SDL key, never also text", async () => {
  const h = await loadHost();
  for (const [code, key] of [["Backspace", "Backspace"], ["Enter", "Enter"]]) {
    h.context.__mcWebDomEvent("keydown", { code, key, repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
    h.context.__mcWebDomEvent("keyup", { code, key, repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
  }
  assert.deepEqual(h.lines, ["key 42 0 1 0", "key 42 0 0 0", "key 40 0 1 0", "key 40 0 0 0"]);
});

test("text sent before the game registered its input bridge is dropped, not queued", async () => {
  const h = await loadHost();
  h.context.mcWebInput.bridge = null;
  h.fromPage({ mcwebText: { kind: "commit", text: "x" } });
  assert.deepEqual(h.lines, []);
});
