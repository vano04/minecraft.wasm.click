#!/usr/bin/env node
// Exercise the active runtime host with CSS-sized and high-density canvases.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../runtime/web/webgpu-host.js', import.meta.url), 'utf8');
const start = source.indexOf('  // SDL_Keymod bits,');
const end = source.indexOf('  // Text input for a touch screen', start);
assert.ok(start >= 0 && end > start);
for (const [width, height, cssWidth, cssHeight] of [[640, 360, 640, 360], [1280, 720, 640, 360], [1000, 1200, 500, 400]]) {
  const listeners = new Map(), events = [];
  const add = (name, handler) => { const handlers = listeners.get(name) || []; handlers.push(handler); listeners.set(name, handlers); };
  const canvas = { width, height, addEventListener: add, focus() {},
    getBoundingClientRect: () => ({ left: 10, top: 20, width: cssWidth, height: cssHeight }) };
  const document = { body: { dataset: {} }, pointerLockElement: null, addEventListener: add, querySelector: () => canvas };
  const context = vm.createContext({ canvas, document, navigator: { vendor: 'Apple Computer, Inc.' },
    performance: { now: () => 1000 }, addEventListener: add, recordStage() {}, Date, console });
  vm.runInContext(source.slice(start, end), context);
  context.mcWebInput.register((...args) => events.push(args));
  const move = values => { for (const handler of listeners.get('mousemove') || []) handler({ target: canvas, ...values }); };
  move({ clientX: 22, clientY: 35, movementX: 7, movementY: -3 });
  assert.deepEqual(events.pop(), ['cursorPos', 12 * width / cssWidth, 15 * height / cssHeight, 7, -3]);
  const beforeX = context.mcWebInput.syntheticX, beforeY = context.mcWebInput.syntheticY;
  document.pointerLockElement = canvas;
  move({ movementX: 7, movementY: -3 });
  assert.deepEqual(events.pop(), ['cursorPos', beforeX + 7, beforeY - 3, 7, -3]);
  move({ webkitMovementX: 4, webkitMovementY: 5 });
  assert.deepEqual(events.pop().slice(-2), [4, 5]);
  document.pointerLockElement = null;
  move({ target: {}, clientX: 22, clientY: 35, movementX: 7, movementY: -3 });
  assert.equal(events.length, 0, 'Free cursor movement outside the canvas must not reach Minecraft');
}
console.log('test-input-mapping: pass');
