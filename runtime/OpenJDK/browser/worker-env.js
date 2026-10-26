// Minimal page-surface emulation for web/webgpu-host.js loaded in the OpenJDK
// lane's GPU Worker.
//
// The canonical host was written for the app page: it sizes the canvas from
// getBoundingClientRect, mirrors diagnostics into document.body.dataset, and
// reads document.visibilityState. The OpenJDK lane runs the host on a
// dedicated Worker with an OffscreenCanvas, so this shim supplies the small
// number of DOM globals the host touches, with worker-correct values.
// gpu-rpc-worker.js importScripts it before the unmodified host.
(() => {
  "use strict";
  if (globalThis.__mcWebWorkerEnv) return;
  globalThis.__mcWebWorkerEnv = true;

  // The canvas is an OffscreenCanvas transferred from the page. It has no
  // layout box; the backing store is driven by mcWebGpu.configureCanvas.
  // getBoundingClientRect reports the logical display size, which the page
  // passes at transfer time (the host multiplies it by devicePixelRatio for
  // the backing store).
  const canvas = globalThis.__mcWebOffscreen;
  const state = globalThis.__mcWebCanvasState || (globalThis.__mcWebCanvasState = {
    cssWidth: canvas ? canvas.width : 1280,
    cssHeight: canvas ? canvas.height : 720,
    dpr: 1,
  });
  if (canvas && typeof canvas.getBoundingClientRect !== "function") {
    canvas.getBoundingClientRect = () => ({
      width: state.cssWidth,
      height: state.cssHeight,
      top: 0, left: 0, right: state.cssWidth, bottom: state.cssHeight,
      x: 0, y: 0, toJSON: () => ({})
    });
  }
  if (typeof globalThis.devicePixelRatio !== "number" || globalThis.devicePixelRatio === 0) {
    Object.defineProperty(globalThis, "devicePixelRatio", {
      get: () => globalThis.__mcWebCanvasState.dpr || 1
    });
  }

  // Custom properties the host sets on the elements it mirrors state into
  // (reportSuccess paints --jar-color on the root). Nothing on a Worker
  // renders CSS; accept and forget.
  const style = () => ({
    cssText: "", setProperty() {}, removeProperty() {}, getPropertyValue: () => "",
  });

  const stubElement = () => ({
    textContent: "", hidden: false, focus() {}, style: style(),
    dataset: {}, addEventListener() {}, removeEventListener() {},
    appendChild() {}, append() {}, getContext: () => null, width: 0, height: 0,
  });

  const elements = new Map();

  // Diagnostic counters the host mirrors into dataset. Kept in a plain proxy
  // so the render loop stays free of real DOM work; the page can ask for the
  // latest values over the log if it needs them.
  const dataset = new Proxy({}, {
    set(target, key, value) {
      target[key] = String(value);
      return true;
    },
    get(target, key) { return target[key]; }
  });

  // ---------------------------------------------------------------------
  // DOM input replay.
  //
  // The host installs its input listeners on the canvas and on the global
  // (window, on a page). Here the canvas is an OffscreenCanvas and the global
  // is a Worker, so neither ever sees a real event — but the translation from
  // DOM event to GLFW call is worth keeping, so the listeners are recorded and
  // the page replays its events through __mcWebDomEvent instead.
  // ---------------------------------------------------------------------
  const INPUT_EVENTS = new Set([
    "keydown", "keyup", "mousemove", "mousedown", "mouseup", "wheel",
    "contextmenu", "pointerlockchange", "pointerlockerror",
  ]);
  const listeners = new Map();
  const record = (type, fn) => {
    if (typeof fn !== "function") return;
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  if (canvas) {
    canvas.addEventListener = (type, fn) => record(type, fn);
    canvas.removeEventListener = () => {};
    canvas.focus = () => {};
    canvas.requestPointerLock = () => {};
  }
  const globalAddEventListener = globalThis.addEventListener.bind(globalThis);
  globalThis.addEventListener = (type, fn, options) => {
    // Only the input types are diverted; "message" and "error" must still
    // reach the Worker's own machinery.
    if (INPUT_EVENTS.has(type)) return record(type, fn);
    return globalAddEventListener(type, fn, options);
  };

  globalThis.__mcWebDomEvent = (type, init) => {
    // The page holds the real pointer lock (pre.js); this mirrors it before
    // the host's handlers look.
    if (type === "pointerlockchange") globalThis.document.pointerLockElement = init.locked ? canvas : null;
    const fns = listeners.get(type);
    if (!fns || !fns.length) return;
    const event = Object.assign({
      type,
      target: canvas,
      currentTarget: canvas,
      preventDefault() {},
      stopPropagation() {},
    }, init);
    for (const fn of fns.slice()) {
      try {
        fn(event);
      } catch (failure) {
        console.warn("[input] " + type + " listener threw: " + (failure && failure.message || failure));
      }
    }
  };

  // Sound. The JVM's SoundManager calls mcWebAudio over the RPC, which lands
  // here, but WebAudio has no Worker API, so the real host (audio-host.js)
  // runs on the page and this forwards to it. Handles are allocated here so
  // playInstance answers at once; the page reports finished sounds back, so
  // isPlaying -- asked for every sound every tick -- never leaves the Worker.
  globalThis.mcWebAudio = (() => {
    let nextHandle = 1;
    let enabled = true;
    const playing = new Set();
    const post = (m, a) => globalThis.postMessage({ mcwebAudio: { m, a } });
    globalAddEventListener("message", (e) => {
      const ended = e.data && e.data.mcwebAudioEnded;
      if (ended) {
        for (const handle of ended) playing.delete(handle);
        (globalThis.__mcWebAudioEnded ||= []).push(...ended);
      }
    });
    return {
      playInstance(name, source, volume, pitch, looping) {
        if (!enabled) return 0;
        const handle = nextHandle++;
        playing.add(handle);
        post("playInstance", [handle, name, source, volume, pitch, looping]);
        return handle;
      },
      positionInstance(handle, x, y, z) { post("positionInstance", [handle, x, y, z]); },
      isPlaying(handle) { return playing.has(handle); },
      stopInstance(handle) { playing.delete(handle); post("stopInstance", [handle]); },
      stopAll() { playing.clear(); post("stopAll", []); },
      setCategoryVolume(source, volume) { post("setCategoryVolume", [source, volume]); },
      setListener(x, y, z) { post("setListener", [x, y, z]); },
      setListenerPose(x, y, z, forwardX, forwardY, forwardZ, upX, upY, upZ) {
        post("setListenerPose", [x, y, z, forwardX, forwardY, forwardZ, upX, upY, upZ]);
      },
      setVolume(v) { post("setVolume", [v]); },
      setEnabled(e) { enabled = Boolean(e); if (!enabled) playing.clear(); post("setEnabled", [enabled]); },
      isEnabled() { return enabled; },
      state() { return "forwarded"; },
      preloadEvent(name) { post("preloadEvent", [name]); },
      probe0() { return 1; }, probe1() {}, probe2() { return 2; }, probe3() { return 3; }, probe4() { return 4; },
    };
  })();

  // The host arms pointer lock by setting mcWebInput.lockPointerOnNextClick
  // (BrowserInputCompat.setCursorDisabled); the page, which can take the
  // lock, is told whenever that changes.
  let mcWebInput;
  Object.defineProperty(globalThis, "mcWebInput", {
    configurable: true,
    get() { return mcWebInput; },
    set(input) {
      mcWebInput = input;
      if (!input || typeof input !== "object") return;
      let armed = Boolean(input.lockPointerOnNextClick);
      // The JVM Worker's write of lockPointerOnNextClick, carried over by the
      // RPC (pre.js); centring the virtual cursor is what setCursorDisabled
      // does on a page.
      input.setLockPointerOnNextClick = (v) => {
        if (v && canvas) {
          input.syntheticX = canvas.width / 2;
          input.syntheticY = canvas.height / 2;
        }
        input.lockPointerOnNextClick = v;
      };
      Object.defineProperty(input, "lockPointerOnNextClick", {
        configurable: true, enumerable: true,
        get() { return armed; },
        set(v) {
          v = Boolean(v);
          if (v !== armed) globalThis.postMessage({ mcwebCursorWanted: v });
          armed = v;
        },
      });
    },
  });

  globalThis.document = {
    documentElement: { style: style(), dataset: {} },
    body: { dataset, appendChild() {}, append() {}, style: style() },
    createElement: () => stubElement(),
    getElementById(id) {
      if (id === "minecraft-canvas") return canvas;
      if (!elements.has(id)) elements.set(id, stubElement());
      return elements.get(id);
    },
    get visibilityState() {
      // The Worker's event loop only runs while the page is visible, so from
      // the game's perspective the document is always visible here.
      return globalThis.__mcWebVisibility || "visible";
    },
    pointerLockElement: null,
    exitPointerLock() { globalThis.postMessage({ mcwebCursorWanted: false }); },
    addEventListener(type, fn) { record(type, fn); },
    removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
})();
