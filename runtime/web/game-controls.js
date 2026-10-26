// MC-Web game controls: a PE-style touch overlay, standard-mapping Gamepad
// API support, and the fullscreen wrapper for the in-tab Minecraft canvas.
//
// Nothing here is a Minecraft UI. Every action becomes an ordinary keyboard or
// mouse event on the input path the page already has: the `mcwebDom` message
// pre.js posts to the GPU Worker (globalThis.__mcWebGpuWorker), whose
// webgpu-host.js listeners turn DOM events into SDL events. Coordinates are
// canvas backing-store pixels, exactly as pre.js's own forwarder sends them.
// Without a GPU Worker the same events are dispatched as synthetic DOM events
// on the canvas/window, where pre.js forwards them unchanged.
//
// Key bindings are vanilla Java Edition defaults: W/A/S/D, Space jump,
// Left Shift sneak, Left Control sprint, E inventory, Q drop, F swap hands,
// F5 perspective, Tab player list, T chat, Escape pause, 1-9 hotbar, left
// mouse attack/break, right mouse use/place, middle mouse pick block.
//
// Typing on a touch screen uses the device's own keyboard: a tap on one of
// the game's text fields focuses a hidden textarea inside that tap (see
// "native keyboard" below), and what it types is sent back as SDL text.
//
// Usage:
//   const controls = globalThis.mcWebGameControls.create({
//     container,                       // element that wraps the canvas
//     getCanvas: () => canvasOrNull,   // looked up lazily; may change
//     onStatus: (status) => {},        // optional
//   });
//   controls.setReady(true);           // once the game renders frames
//   button.onclick = () => controls.enterFullscreen();  // trusted gesture
(() => {
  "use strict";
  if (globalThis.mcWebGameControls) return;

  // Shortest phase a key or button stays down or up. Minecraft samples held
  // keys once per client tick, and at a 20 FPS cap a shorter phase can fall
  // between two samples; flight's double jump needs both phases seen.
  const DEFAULT_MIN_PHASE_MS = 120;
  const LOOK_HOLD_MS = 320;        // still finger on the look area -> break
  const HOTBAR_DROP_MS = 550;      // still finger on a hotbar slot -> drop
  const LATCH_TAP_MS = 260;        // shorter press on sneak/sprint latches it
  const TAP_SLOP_PX = 10;          // CSS px a tap may wander
  const MENU_PRESS_DELAY_MS = 140; // menu touch waits for a second finger
  const SCROLL_STEP_PX = 36;       // CSS px of two-finger drag per wheel notch
  const STICK_DEADZONE = 0.15;
  const DIR_ON = 0.38;             // analogue -> WASD hysteresis
  const DIR_OFF = 0.26;
  const POINTER_RECORDS = 12;
  const STORAGE_KEY = "mcweb.gameControls.touchMode";

  const KEYS = {
    forward: ["KeyW", "w"], back: ["KeyS", "s"], left: ["KeyA", "a"], right: ["KeyD", "d"],
    jump: ["Space", " "], sneak: ["ShiftLeft", "Shift"], sprint: ["ControlLeft", "Control"],
    inventory: ["KeyE", "e"], drop: ["KeyQ", "q"], swapHands: ["KeyF", "f"],
    perspective: ["F5", "F5"], playerList: ["Tab", "Tab"], chat: ["KeyT", "t"], pause: ["Escape", "Escape"],
  };
  const MOUSE_ATTACK = 0;
  const MOUSE_PICK = 1;
  const MOUSE_USE = 2;

  // Holder bits: who is holding a key. A key goes up only when no holder is
  // left, so touch, controller and keyboard never release each other's keys.
  const HOLD_KEYBOARD = 1 << 0;
  const T_STICK = 1 << 1;
  const T_JUMP = 1 << 2;
  const T_SNEAK = 1 << 3;
  const T_SPRINT = 1 << 4;
  const T_ATTACK = 1 << 5;
  const T_USE = 1 << 6;
  const T_LOOK = 1 << 7;
  const T_UTIL = 1 << 8;
  const T_MENU = 1 << 9;
  const T_HOTBAR = 1 << 10;
  const TOUCH_MASK = 0x7fe;
  const PAD_BUTTON_SHIFT = 12;     // pad button i holds with bit 12 + i (0..16)
  const P_STICK = 1 << 29;
  const PAD_MASK = (((1 << 17) - 1) << PAD_BUTTON_SHIFT) | P_STICK;
  const ALL_MASK = 0x7fffffff;

  // Standard Gamepad mapping: https://w3c.github.io/gamepad/#remapping
  const PAD_BUTTONS = 17;
  const PAD_NAMES = ["A / Cross", "B / Circle", "X / Square", "Y / Triangle",
    "LB / L1", "RB / R1", "LT / L2", "RT / R2", "View / Share", "Menu / Options",
    "Left stick press", "Right stick press", "D-pad up", "D-pad down",
    "D-pad left", "D-pad right", "Home / PS"];

  const MAPPING_HELP = Object.freeze({
    controller: Object.freeze([
      ["Left stick", "Move (W/A/S/D)", "Move cursor"],
      ["Right stick", "Look", "Scroll"],
      ["A / Cross", "Jump (double tap: fly)", "Left click"],
      ["B / Circle", "Sneak (hold)", "Back (Escape)"],
      ["X / Square", "Drop item (Q)", "Right click"],
      ["Y / Triangle", "Inventory (E)", "Close inventory (Escape)"],
      ["LB / RB", "Hotbar previous / next", "Scroll up / down"],
      ["LT / L2", "Use / place (right mouse)", "-"],
      ["RT / R2", "Attack / break (left mouse)", "-"],
      ["Left stick press", "Sprint (Left Ctrl)", "Shift (quick move)"],
      ["Right stick press", "Pick block (middle mouse)", "-"],
      ["D-pad up / down", "Perspective (F5) / swap hands (F)", "-"],
      ["D-pad left / right", "Hotbar previous / next", "Scroll up / down"],
      ["View / Share", "Player list (Tab)", "-"],
      ["Menu / Options", "Pause (Escape)", "Back (Escape)"],
      ["Home / PS", "This help", "This help"],
    ]),
    touch: Object.freeze([
      ["Left pad", "Move; joystick snaps W/A/S/D"],
      ["Drag right side", "Look"],
      ["Tap right side", "Use / place"],
      ["Hold still on right side", "Attack / break"],
      ["Jump button", "Jump; hold to swim/fly up; double tap to fly"],
      ["Sneak / sprint", "Tap to toggle, hold for momentary"],
      ["Sword / hand buttons", "Attack (hold) / use (hold)"],
      ["Tap hotbar slot", "Select slot; hold to drop"],
      ["Arrows beside hotbar", "Previous / next slot"],
      ["Three-dot button (top, next to pause)", "Open inventory (E); tap again to close (Escape)"],
      ["Speech-bubble button (top)", "Open chat (T)"],
      ["Tap a text field", "Type with this device's keyboard"],
      ["Menus", "Tap = click, drag = drag, two fingers = scroll"],
    ]),
  });

  const ICONS = {
    pause: '<path d="M5 6h14v3H5zm0 5h14v3H5zm0 5h14v3H5z"/>',
    inventory: '<path d="M3 10h5v5H3zm6.5 0h5v5h-5zM16 10h5v5h-5z"/>',
    perspective: '<path d="M4 11h4V9h8v2h4v2h-4v2H8v-2H4zm6 0v2h4v-2z"/>',
    sprint: '<path d="M7 12h8l12 12-12 12H7l12-12zm14 0h8l12 12-12 12h-8l12-12z"/>',
    jump: '<path d="M20 9h8v4h4v4h4v4h-8v12h-8V21h-8v-4h4v-4h4zm-8 29h24v4H12z"/>',
    sneak: '<path d="M20 7h8v12h8v4h-4v4h-4v4h-8v-4h-4v-4h-4v-4h8zm-8 27h24v4h-4v4H16v-4h-4z"/>',
    attack: '<path d="M34 6h8v8h-4v4h-4v4h-4v4h-4v-4h-4v-4h4v-4h4v-4h4zM14 26h4v4h4v4h-4v4h-4v4h-4v-4H6v-4h4v-4h4z"/>',
    use: '<path d="M12 12h12v4h4v-4h8v12h-4v8h-4v8H16v-4h-4v-8H8v-8h4z"/>',
    prev: '<path d="M16 4 7 12l9 8v-4l-5-4 5-4z"/>',
    next: '<path d="m8 4 9 8-9 8v-4l5-4-5-4z"/>',
    touch: '<path d="M9 3h4v8h2v-3h3v3h2v-2h3v11h-2v3H9v-3H7v-4H5v-3h4z"/>',
    chat: '<path d="M3 4h18v12H10l-5 4v-4H3zm4 4v2h10V8zm0 4v2h7v-2z"/>',
    help: '<path d="M8 4h8v2h2v5h-2v2h-2v2h-4v-3h2v-2h2V7h-4v2H8zm2 13h4v3h-4z"/>',
    fullscreen: '<path d="M3 3h7v3H6v4H3zm11 0h7v7h-3V6h-4zM3 14h3v4h4v3H3zm15 0h3v7h-7v-3h4z"/>',
    exit: '<path d="M5 5h4v2h2v2h2V7h2V5h4v4h-2v2h-2v2h2v2h2v4h-4v-2h-2v-2h-2v2H9v2H5v-4h2v-2h2v-2H7V9H5z"/>',
  };
  const svg = (name, box) => `<svg viewBox="0 0 ${box} ${box}" aria-hidden="true">${ICONS[name]}</svg>`;

  // Ordinary hold/latch/tap controls of the touch overlay.
  //   key/mouse  what the control presses
  //   latch      a short tap latches it down, the next tap releases it
  const TOUCH_CONTROLS = {
    jump: { key: KEYS.jump, bit: T_JUMP },
    sneak: { key: KEYS.sneak, bit: T_SNEAK, latch: true },
    sprint: { key: KEYS.sprint, bit: T_SPRINT, latch: true },
    attack: { mouse: MOUSE_ATTACK, bit: T_ATTACK },
    use: { mouse: MOUSE_USE, bit: T_USE },
    pause: { key: KEYS.pause, bit: T_UTIL },
    inventory: { key: KEYS.inventory, bit: T_UTIL },
    chat: { key: KEYS.chat, bit: T_UTIL },
    perspective: { key: KEYS.perspective, bit: T_UTIL },
    prev: { wheel: -1 },
    next: { wheel: 1 },
  };

  const OVERLAY_HTML = `
<div class="mcweb-gc-toolbar" role="toolbar" aria-label="Game controls">
  <button type="button" class="mcweb-gc-tool" data-gc-tool="touch" aria-pressed="false" aria-label="Touch controls">${svg("touch", 24)}</button>
  <button type="button" class="mcweb-gc-tool" data-gc-tool="help" aria-expanded="false" aria-label="Controls help">${svg("help", 24)}</button>
  <button type="button" class="mcweb-gc-tool" data-gc-tool="fullscreen" aria-label="Enter fullscreen">${svg("fullscreen", 24)}</button>
</div>
<div class="mcweb-gc-touch" aria-label="Touch controls">
  <div class="mcweb-gc-utility" role="group" aria-label="Game menu controls">
    <button type="button" class="mcweb-gc-btn mcweb-gc-small" data-gc="pause" aria-label="Pause or back">${svg("pause", 24)}</button>
    <button type="button" class="mcweb-gc-btn mcweb-gc-small mcweb-gc-inventory" data-gc="inventory" aria-label="Open or close inventory">${svg("inventory", 24)}</button>
    <button type="button" class="mcweb-gc-btn mcweb-gc-small mcweb-gc-play" data-gc="chat" aria-label="Open chat">${svg("chat", 24)}</button>
    <button type="button" class="mcweb-gc-btn mcweb-gc-small mcweb-gc-play" data-gc="perspective" aria-label="Change perspective">${svg("perspective", 24)}</button>
  </div>
  <div class="mcweb-gc-move mcweb-gc-play" data-gc-stick role="application" aria-label="Movement joystick" aria-valuetext="Centered">
    <div class="mcweb-gc-knob" aria-hidden="true"></div>
  </div>
  <button type="button" class="mcweb-gc-btn mcweb-gc-action mcweb-gc-play mcweb-gc-attack" data-gc="attack" aria-label="Attack or break">${svg("attack", 48)}</button>
  <button type="button" class="mcweb-gc-btn mcweb-gc-action mcweb-gc-play mcweb-gc-sprint" data-gc="sprint" aria-pressed="false" aria-label="Sprint">${svg("sprint", 48)}</button>
  <button type="button" class="mcweb-gc-btn mcweb-gc-action mcweb-gc-play mcweb-gc-use" data-gc="use" aria-label="Use or place">${svg("use", 48)}</button>
  <button type="button" class="mcweb-gc-btn mcweb-gc-action mcweb-gc-play mcweb-gc-jump" data-gc="jump" aria-label="Jump">${svg("jump", 48)}</button>
  <button type="button" class="mcweb-gc-btn mcweb-gc-action mcweb-gc-play mcweb-gc-sneak" data-gc="sneak" aria-pressed="false" aria-label="Sneak">${svg("sneak", 48)}</button>
  <div class="mcweb-gc-hotbar-tools mcweb-gc-play" role="group" aria-label="Hotbar">
    <button type="button" class="mcweb-gc-btn mcweb-gc-small" data-gc="prev" aria-label="Previous hotbar slot">${svg("prev", 24)}</button>
    <button type="button" class="mcweb-gc-btn mcweb-gc-small" data-gc="next" aria-label="Next hotbar slot">${svg("next", 24)}</button>
  </div>
</div>
<div class="mcweb-gc-cursor" aria-hidden="true" hidden></div>
<div class="mcweb-gc-help" role="dialog" aria-label="Controls help" hidden>
  <div class="mcweb-gc-help-body"></div>
  <button type="button" class="mcweb-gc-help-close" data-gc-tool="help-close">Close</button>
</div>
<div class="mcweb-gc-toast" role="status" aria-live="polite"></div>`;

  let instance = null;

  function create(options) {
    if (instance) throw new Error("mcWebGameControls: destroy() the existing instance first");
    const opts = Object.assign({
      container: null,
      getCanvas: null,
      canvas: null,
      isReady: null,
      isGrabbed: null,
      onStatus: null,
      send: null,
      sendText: null,          // custom transport for native-keyboard text ({ kind, text, ... })
      transport: "auto",       // "auto" | "worker" | "dom"
      touchMode: null,         // "auto" | "on" | "off"; null: stored or "auto"
      tapToUse: true,          // PE gestures on the look area
      guiScale: 0,             // Minecraft GUI scale, 0 = auto
      minPhaseMs: DEFAULT_MIN_PHASE_MS,
      touchLookSpeed: 1.0,     // canvas px of xrel per CSS px dragged
      padLookSpeed: 1400,      // canvas px of xrel per second at full tilt
      padInvertY: false,
      padDeadzone: 0.2,
      padLookDeadzone: 0.14,
    }, options || {});
    const container = opts.container;
    if (!container || typeof container.appendChild !== "function") {
      throw new TypeError("mcWebGameControls.create: options.container must be an element");
    }
    const getCanvasOption = typeof opts.getCanvas === "function"
      ? opts.getCanvas : () => opts.canvas || container.querySelector("canvas");

    const listeners = new AbortController();
    const signal = listeners.signal;
    const now = () => performance.now();

    // ------------------------------------------------------------ DOM
    if (getComputedStyle(container).position === "static") container.classList.add("mcweb-gc-host-positioned");
    container.classList.add("mcweb-gc-host");
    const root = document.createElement("div");
    root.className = "mcweb-gc-root";
    root.hidden = true;
    root.innerHTML = OVERLAY_HTML;
    container.appendChild(root);
    const exitButton = document.createElement("button");
    exitButton.type = "button";
    exitButton.className = "mcweb-gc-exit";
    exitButton.hidden = true;
    exitButton.setAttribute("aria-label", "Exit fullscreen");
    exitButton.innerHTML = `${svg("exit", 24)}<span>Exit</span>`;
    container.appendChild(exitButton);
    // The native keyboard's target. It sits outside the overlay root, which
    // stays display:none until the first frames, and the game's menus need
    // typing before then. Never hit-tested (pointer-events: none): taps still
    // reach the game, which focuses its own field.
    const textProxy = document.createElement("textarea");
    textProxy.className = "mcweb-gc-text-proxy";
    textProxy.tabIndex = -1;
    textProxy.rows = 1;
    textProxy.spellcheck = false;
    // The game's field holds the text; the textarea is emptied after every
    // edit, so the keyboard must not try to rewrite words it cannot see.
    for (const [name, value] of [["autocapitalize", "off"], ["autocomplete", "off"], ["autocorrect", "off"],
      ["inputmode", "text"], ["aria-label", "Minecraft text input"]]) {
      textProxy.setAttribute(name, value);
    }
    container.appendChild(textProxy);

    const q = (selector) => root.querySelector(selector);
    const touchLayer = q(".mcweb-gc-touch");
    const utilityButtons = Array.from(root.querySelectorAll(".mcweb-gc-utility [data-gc]"));
    const stickZone = q("[data-gc-stick]");
    const knob = q(".mcweb-gc-knob");
    const hotbarTools = q(".mcweb-gc-hotbar-tools");
    const cursorEl = q(".mcweb-gc-cursor");
    const helpPanel = q(".mcweb-gc-help");
    const toast = q(".mcweb-gc-toast");
    const touchTool = q('[data-gc-tool="touch"]');
    const helpTool = q('[data-gc-tool="help"]');
    const fullscreenTool = q('[data-gc-tool="fullscreen"]');
    const controlEls = new Map();
    for (const el of root.querySelectorAll("[data-gc]")) {
      controlEls.set(el.dataset.gc, el);
      // Touch targets only: a focused one would also take Space/Enter.
      el.tabIndex = -1;
    }
    const controls = new Map();
    for (const [name, def] of Object.entries(TOUCH_CONTROLS)) {
      controls.set(name, {
        name, def, el: controlEls.get(name), pointer: -1, latched: false,
        slot: null, // resolved below, once slots exist
      });
    }
    helpPanel.querySelector(".mcweb-gc-help-body").innerHTML = helpHtml();

    // ------------------------------------------------------------ state
    const status = {
      ready: false,
      mode: "menu",              // "menu" (cursor free) | "gameplay" (cursor grabbed)
      touch: false,
      touchMode: "auto",
      gamepad: null,             // id of the active controller
      gamepadMapping: null,      // "standard" | "non-standard"
      fullscreen: "off",         // "off" | "pending" | "native" | "css-fallback"
      orientation: "not-attempted", // "not-attempted" | "locked" | "unsupported" | "denied"
      transport: "none",         // "worker" | "dom" | "custom" | "none"
      message: "",
      keyboard: "closed",        // "open" while the native keyboard's textarea has focus
    };
    let readyFlag = false;
    let ready = false;
    let canvas = null;
    let grabbed = false;
    let attachedWorker = null;
    let touchDetected = false;
    let destroyed = false;
    let helpOpen = false;
    let lastGrabbedCallback = null;
    // The inventory button stays on screen in the menu the inventory key
    // opened, so the same button closes it. Other menus (title, chat, signs)
    // hide it: there E would type a letter.
    let inventoryKeyAt = -Infinity;
    let inventoryOpen = false;

    // Canvas geometry, refreshed by measure(): CSS box and backing store.
    const rect = { left: 0, top: 0, width: 0, height: 0, cw: 1, ch: 1 };
    // Overlay root's own page offset (the canvas box is offset inside it).
    const rootBox = { left: 0, top: 0 };
    // Virtual cursor in canvas pixels; every mouse event carries it.
    let cursorX = 0;
    let cursorY = 0;
    let mouseButtons = 0;

    try {
      const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
      status.touchMode = opts.touchMode || (stored === "on" || stored === "off" ? stored : "auto");
    } catch {
      status.touchMode = opts.touchMode || "auto";
    }
    touchDetected = globalThis.matchMedia?.("(any-pointer: coarse)")?.matches === true
      || (navigator.maxTouchPoints || 0) > 0;

    // ------------------------------------------------------------ transport
    // One reusable message: postMessage clones synchronously, and pre.js's
    // forwarder sends exactly these fields.
    const init = {
      clientX: 0, clientY: 0, movementX: 0, movementY: 0, button: 0, buttons: 0,
      code: "", key: "", repeat: false, ctrlKey: false, shiftKey: false,
      altKey: false, metaKey: false, deltaX: 0, deltaY: 0, deltaMode: 0,
    };
    const domMessage = { mcwebDom: { type: "", init } };

    function deliver(type) {
      if (typeof opts.send === "function") {
        setTransport("custom");
        try { opts.send(type, init); } catch (error) { console.warn("[game-controls] send:", error); }
        return;
      }
      if (opts.transport !== "dom") {
        const worker = globalThis.__mcWebGpuWorker;
        if (worker && typeof worker.postMessage === "function") {
          setTransport("worker");
          domMessage.mcwebDom.type = type;
          worker.postMessage(domMessage);
          return;
        }
        if (opts.transport === "worker") { setTransport("none"); return; }
      }
      dispatchDom(type);
    }

    // Synthetic DOM events reach pre.js's own forwarder, which converts
    // client coordinates back to canvas pixels; convert to client first.
    function dispatchDom(type) {
      const isKey = type === "keydown" || type === "keyup";
      if (!isKey && !canvas) { setTransport("none"); return; }
      setTransport("dom");
      const base = { bubbles: true, cancelable: true, shiftKey: init.shiftKey, ctrlKey: init.ctrlKey };
      if (isKey) {
        base.code = init.code;
        base.key = init.key;
        globalThis.dispatchEvent(new KeyboardEvent(type, base));
        return;
      }
      const sx = rect.cw > 0 ? rect.width / rect.cw : 1;
      const sy = rect.ch > 0 ? rect.height / rect.ch : 1;
      base.clientX = rect.left + init.clientX * sx;
      base.clientY = rect.top + init.clientY * sy;
      base.button = init.button;
      base.buttons = init.buttons;
      let event;
      if (type === "wheel") {
        base.deltaX = init.deltaX;
        base.deltaY = init.deltaY;
        base.deltaMode = init.deltaMode;
        event = new WheelEvent(type, base);
      } else {
        const mx = init.movementX * sx;
        const my = init.movementY * sy;
        base.movementX = mx;
        base.movementY = my;
        event = new MouseEvent(type, base);
        // Some engines leave movementX out of MouseEventInit or round it.
        if (event.movementX !== mx || event.movementY !== my) {
          Object.defineProperty(event, "movementX", { value: mx });
          Object.defineProperty(event, "movementY", { value: my });
        }
      }
      canvas.dispatchEvent(event);
    }

    function setTransport(name) {
      if (status.transport === name) return;
      status.transport = name;
      emitStatus();
    }

    function prepareInit() {
      init.clientX = cursorX;
      init.clientY = cursorY;
      init.movementX = 0;
      init.movementY = 0;
      init.buttons = mouseButtons;
      init.shiftKey = shiftSlot.down;
      init.ctrlKey = ctrlSlot.down;
      init.deltaX = 0;
      init.deltaY = 0;
      init.deltaMode = 0;
      init.repeat = false;
    }

    function sendKey(code, key, down) {
      prepareInit();
      init.code = code;
      init.key = key;
      init.button = 0;
      deliver(down ? "keydown" : "keyup");
    }

    const BUTTON_BITS = [1, 4, 2]; // DOM `buttons` bits for left, middle, right
    function sendButton(button, down) {
      if (down) mouseButtons |= BUTTON_BITS[button];
      else mouseButtons &= ~BUTTON_BITS[button];
      prepareInit();
      init.code = "";
      init.key = "";
      init.button = button;
      deliver(down ? "mousedown" : "mouseup");
    }

    function sendMove(dx, dy) {
      prepareInit();
      init.code = "";
      init.key = "";
      init.button = 0;
      init.movementX = dx;
      init.movementY = dy;
      deliver("mousemove");
    }

    function sendWheel(deltaX, deltaY, deltaMode) {
      prepareInit();
      init.code = "";
      init.key = "";
      init.button = 0;
      init.deltaX = deltaX;
      init.deltaY = deltaY;
      init.deltaMode = deltaMode;
      deliver("wheel");
    }

    // Absolute cursor move (menus): canvas pixels, clamped to the canvas.
    function moveCursorTo(x, y) {
      x = x < 0 ? 0 : x > rect.cw - 1 ? rect.cw - 1 : x;
      y = y < 0 ? 0 : y > rect.ch - 1 ? rect.ch - 1 : y;
      const dx = x - cursorX;
      const dy = y - cursorY;
      cursorX = x;
      cursorY = y;
      sendMove(dx, dy);
    }

    // ------------------------------------------------------------ held-input accounting
    function Slot(code, key, button) {
      this.code = code;
      this.key = key;
      this.button = button;       // -1 for keys
      this.held = 0;              // holder bits
      this.down = false;          // what the game was last told
      this.changedAt = -Infinity;
      this.pulse = false;         // a press that must reach the game even if already released
      this.timer = 0;
      this.flush = () => { this.timer = 0; reconcile(this); };
    }
    const keySlots = new Map();
    function keySlot(code, key) {
      let slot = keySlots.get(code);
      if (!slot) {
        slot = new Slot(code, key, -1);
        keySlots.set(code, slot);
      } else if (key && !slot.key) {
        slot.key = key;
      }
      return slot;
    }
    const mouseSlots = [new Slot("", "", 0), new Slot("", "", 1), new Slot("", "", 2)];
    const shiftSlot = keySlot(KEYS.sneak[0], KEYS.sneak[1]);
    const ctrlSlot = keySlot(KEYS.sprint[0], KEYS.sprint[1]);
    const dirSlots = [keySlot(...KEYS.forward), keySlot(...KEYS.back), keySlot(...KEYS.left), keySlot(...KEYS.right)];
    const hotbarSlots = [];
    for (let i = 1; i <= 9; i++) hotbarSlots.push(keySlot("Digit" + i, String(i)));
    const dropSlot = keySlot(...KEYS.drop);
    const inventorySlot = keySlot(...KEYS.inventory);
    const escapeSlot = keySlot(...KEYS.pause);
    for (const control of controls.values()) {
      const def = control.def;
      if (def.key) control.slot = keySlot(def.key[0], def.key[1]);
      else if (def.mouse !== undefined) control.slot = mouseSlots[def.mouse];
    }

    function emitSlot(slot, down) {
      slot.down = down;
      slot.changedAt = now();
      if (down) slot.pulse = false;
      if (down && slot === inventorySlot) inventoryKeyAt = slot.changedAt;
      if (slot.button >= 0) sendButton(slot.button, down);
      else sendKey(slot.code, slot.key, down);
    }

    // Bring the game's view of a slot to what its holders want, never
    // shorter than one phase.
    function reconcile(slot) {
      if (slot.timer) return;
      const want = slot.held !== 0 || slot.pulse;
      if (want === slot.down) return;
      const wait = opts.minPhaseMs - (now() - slot.changedAt);
      if (wait > 0) {
        slot.timer = setTimeout(slot.flush, wait);
        return;
      }
      emitSlot(slot, want);
      if (!slot.held && slot.down) reconcile(slot); // a pulse: schedule its release
    }

    function press(slot, bit) {
      if (slot.held & bit) return;
      const wasHeld = slot.held !== 0;
      slot.held |= bit;
      if (!wasHeld && !slot.down) slot.pulse = true;
      reconcile(slot);
    }

    function release(slot, bit) {
      if (!(slot.held & bit)) return;
      slot.held &= ~bit;
      reconcile(slot);
    }

    function pressFor(slot, bit, down) {
      if (down) press(slot, bit); else release(slot, bit);
    }

    // Release everything a set of holders has, optionally at once.
    let releaseMaskBits = 0;
    let releaseImmediate = false;
    function releaseSlotByMask(slot) {
      if (!(slot.held & releaseMaskBits)) return;
      slot.held &= ~releaseMaskBits;
      if (releaseImmediate && slot.held === 0) {
        if (slot.timer) { clearTimeout(slot.timer); slot.timer = 0; }
        slot.pulse = false;
        if (slot.down) emitSlot(slot, false);
        return;
      }
      reconcile(slot);
    }
    function releaseMask(mask, immediate) {
      releaseMaskBits = mask;
      releaseImmediate = Boolean(immediate);
      keySlots.forEach(releaseSlotByMask);
      for (let i = 0; i < mouseSlots.length; i++) releaseSlotByMask(mouseSlots[i]);
    }

    // Analogue vector -> W/S/A/D with hysteresis. y is positive forward.
    function applyDirectional(x, y, bit, state) {
      const values = DIR_VALUES;
      values[0] = y; values[1] = -y; values[2] = -x; values[3] = x;
      for (let i = 0; i < 4; i++) {
        const on = state[i] ? values[i] > DIR_OFF : values[i] > DIR_ON;
        if (on === Boolean(state[i])) continue;
        state[i] = on ? 1 : 0;
        pressFor(dirSlots[i], bit, on);
      }
    }
    const DIR_VALUES = new Float64Array(4);

    // ------------------------------------------------------------ real keyboard
    // Real keys still travel through pre.js's own forwarder. The capture
    // listener keeps the books: a physical key up while touch or a
    // controller still holds the same key would release it under them, so
    // that one event is stopped before the forwarder sees it.
    //
    // Keys typed into the launcher's own controls (text fields, selects, a
    // focused button's Space/Enter) belong to the launcher. The bubble
    // listener, registered here before pre.js registers its forwarder at
    // Play, stops them reaching the forwarder; the control's native action
    // is untouched (no preventDefault).
    function editableTarget(target) {
      if (!target || target.nodeType !== 1) return false;
      if (root.contains(target)) return false;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
    }
    const ACTIVATION_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "color", "file"]);
    function launcherOwnsKey(event) {
      const target = event.target;
      if (!target || target.nodeType !== 1) return false;
      const tag = target.tagName;
      if (tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true) return true;
      let activationOnly = tag === "BUTTON" || tag === "SUMMARY" || (tag === "A" && target.hasAttribute("href"));
      if (tag === "INPUT") {
        if (!ACTIVATION_INPUTS.has(String(target.type || "text").toLowerCase())) return true;
        activationOnly = true;
      }
      return activationOnly && (event.code === "Space" || event.code === "Enter" || event.code === "NumpadEnter");
    }
    let launcherEvent = null;           // the event the bubble listener stops
    const launcherCodes = new Set();    // keys whose down went to the launcher
    function onKeyDownCapture(event) {
      if (!event.isTrusted) return;
      // The native-keyboard textarea forwards its own keys (onProxyKeyDown).
      if (event.target === textProxy) return;
      if (launcherOwnsKey(event)) {
        launcherEvent = event;
        // A key the game already has down (focus moved mid-press) keeps its
        // keyup, or the game would hold it forever; only its repeats stop.
        const booked = event.code ? keySlots.get(event.code) : null;
        if (event.code && !(booked && (booked.held & HOLD_KEYBOARD))) launcherCodes.add(event.code);
        return;
      }
      // Game keys must not also invoke browser focus navigation or button
      // activation. Launcher-owned keys returned above before this point.
      if (ready && event.cancelable) event.preventDefault();
      if (!ready || !event.code) return;
      const slot = keySlot(event.code, event.key);
      if (slot === inventorySlot && !event.repeat) inventoryKeyAt = now();
      if (slot.held & ~HOLD_KEYBOARD) {
        slot.held |= HOLD_KEYBOARD;
        event.stopImmediatePropagation();
        return;
      }
      slot.held |= HOLD_KEYBOARD;
      slot.down = true;
      slot.changedAt = now();
    }
    function onKeyUpCapture(event) {
      if (!event.isTrusted || !event.code) return;
      if (event.target === textProxy) return;
      // The game never saw this key go down; it must not see it go up.
      if (launcherCodes.delete(event.code)) {
        launcherEvent = event;
        return;
      }
      const slot = keySlots.get(event.code);
      if (!slot || !(slot.held & HOLD_KEYBOARD)) return;
      slot.held &= ~HOLD_KEYBOARD;
      if (slot.held) {
        event.stopImmediatePropagation();
        return;
      }
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = 0; }
      slot.pulse = false;
      slot.down = false;
      slot.changedAt = now();
    }
    function onKeyBubble(event) {
      if (event !== launcherEvent) return;
      launcherEvent = null;
      event.stopImmediatePropagation();
    }

    // ------------------------------------------------------------ geometry
    function measure() {
      const next = getCanvasOption() || null;
      if (next !== canvas) {
        if (canvas && resizeObserver) resizeObserver.unobserve(canvas);
        canvas = next;
        if (canvas && resizeObserver) resizeObserver.observe(canvas);
      }
      if (!canvas) return false;
      const r = canvas.getBoundingClientRect();
      rect.left = r.left;
      rect.top = r.top;
      rect.width = r.width;
      rect.height = r.height;
      rect.cw = canvas.width || r.width || 1;
      rect.ch = canvas.height || r.height || 1;
      return r.width > 0 && r.height > 0;
    }
    const toCanvasX = (clientX) => (clientX - rect.left) * (rect.width > 0 ? rect.cw / rect.width : 1);
    const toCanvasY = (clientY) => (clientY - rect.top) * (rect.height > 0 ? rect.ch / rect.height : 1);

    // Minecraft's automatic GUI scale: the largest step that still leaves
    // 320 x 240 GUI pixels, so the hotbar can be hit-tested from outside.
    function guiScale() {
      const w = rect.cw;
      const h = rect.ch;
      let scale = 1;
      const limit = opts.guiScale > 0 ? opts.guiScale : Infinity;
      while (scale < limit && scale < w && scale < h && w / (scale + 1) >= 320 && h / (scale + 1) >= 240) scale++;
      return scale;
    }
    function hotbarSlotAt(x, y) {
      const scale = guiScale();
      const left = rect.cw / 2 - 91 * scale;
      if (y < rect.ch - 23 * scale || y > rect.ch || x < left || x >= left + 182 * scale) return -1;
      const index = Math.floor((x - left - scale) / (20 * scale));
      return index < 0 ? 0 : index > 8 ? 8 : index;
    }

    function layout() {
      if (destroyed) return;
      const hasCanvas = measure();
      if (canvas) container.style.setProperty("--mcweb-gc-aspect", String((canvas.width || 16) / (canvas.height || 9)));
      const fullscreen = status.fullscreen === "native" || status.fullscreen === "css-fallback";
      const hostBox = container.getBoundingClientRect();
      // Windowed, the overlay covers exactly the canvas; fullscreen, it
      // covers the whole screen so the letterbox bands hold controls too.
      // The root's page offset is derived, never measured: the root is
      // display:none until the game is ready, and a hidden box reads 0,0,
      // which once pushed the hotbar buttons below the canvas, where the
      // root's overflow clipped them.
      let rootWidth;
      let rootHeight;
      if (!fullscreen && hasCanvas) {
        root.style.left = (rect.left - hostBox.left - container.clientLeft) + "px";
        root.style.top = (rect.top - hostBox.top - container.clientTop) + "px";
        root.style.width = rect.width + "px";
        root.style.height = rect.height + "px";
        rootBox.left = rect.left;
        rootBox.top = rect.top;
        rootWidth = rect.width;
        rootHeight = rect.height;
      } else {
        root.style.left = "0px";
        root.style.top = "0px";
        root.style.width = "100%";
        root.style.height = "100%";
        rootBox.left = hostBox.left + container.clientLeft;
        rootBox.top = hostBox.top + container.clientTop;
        rootWidth = container.clientWidth;
        rootHeight = container.clientHeight;
      }
      render();
      dockHotbarTools(hasCanvas, rootWidth, rootHeight);
      placeCursor();
      if (textState.open) {
        placeTextProxy();
        adjustForKeyboard();
      }
      uncoverTextFields();
    }

    // The hotbar arrows sit just right of Minecraft's hotbar, as on PE, and
    // are always clamped inside the overlay. When they cannot be placed (no
    // canvas, hidden) the stylesheet's bottom-right corner applies.
    function dockHotbarTools(hasCanvas, rootWidth, rootHeight) {
      hotbarTools.classList.remove("is-docked");
      hotbarTools.style.left = "";
      hotbarTools.style.top = "";
      if (!hasCanvas || root.hidden || touchLayer.hidden || !grabbed) return;
      const width = hotbarTools.offsetWidth;
      const height = hotbarTools.offsetHeight;
      if (!width || !height) return;
      const margin = 4;
      const scale = guiScale();
      const cssPerPx = rect.width / rect.cw;
      const hotbarLeft = (rect.cw / 2 - 91 * scale) * cssPerPx + rect.left - rootBox.left;
      const hotbarRight = (rect.cw / 2 + 91 * scale) * cssPerPx + rect.left - rootBox.left;
      const hotbarTop = (rect.ch - 22 * scale) * cssPerPx + rect.top - rootBox.top;
      const hotbarHeight = 22 * scale * cssPerPx;
      let left = hotbarRight + 6;
      let top = hotbarTop + (hotbarHeight - height) / 2;
      if (left + width > rootWidth - margin) {
        // No room beside the hotbar: sit above its right end instead.
        left = Math.max(hotbarLeft, hotbarRight - width);
        top = hotbarTop - height - 6;
      }
      left = Math.max(margin, Math.min(left, rootWidth - width - margin));
      top = Math.max(margin, Math.min(top, rootHeight - height - margin));
      hotbarTools.style.left = left + "px";
      hotbarTools.style.top = top + "px";
      hotbarTools.classList.add("is-docked");
    }

    // ------------------------------------------------------------ render/status
    function touchEnabled() {
      return status.touchMode === "on" || (status.touchMode === "auto" && touchDetected);
    }

    function render() {
      const visible = ready && canvas !== null;
      root.hidden = !visible;
      const touch = touchEnabled();
      root.classList.toggle("is-touch", touch);
      root.classList.toggle("is-gameplay", grabbed);
      root.classList.toggle("is-menu", !grabbed);
      root.classList.toggle("is-inventory", inventoryOpen && !grabbed);
      touchLayer.hidden = !touch;
      touchTool.setAttribute("aria-pressed", String(touch));
      touchTool.setAttribute("aria-label", touch ? "Touch controls on (tap to hide)" : "Touch controls off (tap to show)");
      const fullscreen = status.fullscreen === "native" || status.fullscreen === "css-fallback";
      fullscreenTool.hidden = fullscreen;
      exitButton.hidden = !(fullscreen || status.fullscreen === "pending");
      helpPanel.hidden = !helpOpen;
      helpTool.setAttribute("aria-expanded", String(helpOpen));
      if (status.touch !== touch) {
        status.touch = touch;
        emitStatus();
      }
    }

    function emitStatus() {
      if (typeof opts.onStatus === "function") {
        try { opts.onStatus(status); } catch (error) { console.warn("[game-controls] onStatus:", error); }
      }
    }

    let toastTimer = 0;
    function say(message) {
      status.message = message;
      toast.textContent = message;
      toast.classList.add("is-visible");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 4500);
      emitStatus();
    }

    function setReadyState(next) {
      next = Boolean(next);
      if (next === ready) return;
      ready = next;
      status.ready = next;
      if (!next) releaseAll();
      else {
        // Play is a DOM button, so it can retain keyboard focus after launch.
        // Clear that one stale launcher focus before game keys begin; later
        // clicks on launcher fields still keep their normal browser behavior.
        const active = document.activeElement;
        if (active && active !== document.body && !root.contains(active)
            && typeof active.blur === "function") active.blur();
        attachWorker();
      }
      layout();
      if (next && !cursorX && !cursorY) { cursorX = rect.cw / 2; cursorY = rect.ch / 2; }
      emitStatus();
    }

    // ------------------------------------------------------------ mode
    function attachWorker() {
      const worker = globalThis.__mcWebGpuWorker || null;
      if (worker === attachedWorker) return;
      if (attachedWorker && typeof attachedWorker.removeEventListener === "function") {
        attachedWorker.removeEventListener("message", onWorkerMessage);
      }
      attachedWorker = worker;
      if (worker && typeof worker.addEventListener === "function") {
        worker.addEventListener("message", onWorkerMessage);
      }
      setGrabbed(false);
    }
    // worker-env.js posts { mcwebCursorWanted } whenever Minecraft grabs or
    // frees the cursor; the same message drives pre.js's pointer lock.
    function onWorkerMessage(event) {
      const data = event.data;
      if (data && typeof data.mcwebCursorWanted === "boolean") setGrabbed(data.mcwebCursorWanted);
    }

    function setGrabbed(next) {
      next = Boolean(next);
      if (next === grabbed) return;
      grabbed = next;
      status.mode = next ? "gameplay" : "menu";
      // A cursor freed right after the inventory key is the inventory screen.
      inventoryOpen = !next && now() - inventoryKeyAt < 1500;
      // A gesture or button press begun in one mode never acts in the other:
      // Shift held into an inventory would turn every click into a quick move.
      cancelAllPointers();
      releaseMask(TOUCH_MASK, false);
      for (const control of controls.values()) setLatched(control, false);
      releasePad(false);
      if (!next) { cursorX = rect.cw / 2; cursorY = rect.ch / 2; }
      // Gameplay-only controls change visibility: place them again.
      layout();
      emitStatus();
    }

    // ------------------------------------------------------------ touch overlay
    const K_NONE = 0, K_STICK = 1, K_CONTROL = 2, K_LOOK = 3, K_HOTBAR = 4, K_MENU = 5, K_SCROLL = 6, K_IGNORED = 7;
    const L_PENDING = 0, L_LOOK = 1, L_BREAK = 2;
    function PointerRecord() {
      this.id = -1;
      this.kind = K_NONE;
      this.control = null;
      this.startX = 0; this.startY = 0;
      this.lastX = 0; this.lastY = 0;
      this.startTime = 0;
      this.state = 0;
      this.slot = -1;
      this.wasLatched = false;
      this.pressed = false;
      this.timer = 0;
      this.onTimer = () => { this.timer = 0; recordTimer(this); };
    }
    const records = [];
    for (let i = 0; i < POINTER_RECORDS; i++) records.push(new PointerRecord());
    function findRecord(id) {
      for (let i = 0; i < records.length; i++) if (records[i].id === id) return records[i];
      return null;
    }
    function countKind(kind) {
      let n = 0;
      for (let i = 0; i < records.length; i++) if (records[i].id !== -1 && records[i].kind === kind) n++;
      return n;
    }
    function otherRecord(kind, except) {
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (r !== except && r.id !== -1 && r.kind === kind) return r;
      }
      return null;
    }
    function freeRecord(rec) {
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; }
      rec.id = -1;
      rec.kind = K_NONE;
      rec.control = null;
      rec.pressed = false;
    }

    // The stick zone's centre and radius, read once per gesture.
    const stick = { cx: 0, cy: 0, radius: 1, state: new Uint8Array(4) };

    function onPointerDown(event) {
      if (!ready || destroyed) return;
      if (event.pointerType === "touch" && !touchDetected) {
        touchDetected = true;
        if (status.touchMode === "auto") { render(); uncoverTextFields(); }
      }
      const target = event.target;
      if (target.closest(".mcweb-gc-toolbar, .mcweb-gc-help, .mcweb-gc-toast")) return;
      if (!touchEnabled() || event.button > 0) return;
      const rec = findRecord(-1);
      if (!rec) return;
      event.preventDefault();
      if (!measure()) return;
      attachWorker();
      padCursorVisible = false;
      placeCursor();
      rec.id = event.pointerId;
      rec.startX = rec.lastX = event.clientX;
      rec.startY = rec.lastY = event.clientY;
      rec.startTime = now();
      try { root.setPointerCapture(event.pointerId); } catch {}

      const controlEl = target.closest("[data-gc]");
      if (controlEl) {
        const control = controls.get(controlEl.dataset.gc);
        if (!control || control.pointer !== -1) { rec.kind = K_IGNORED; return; }
        rec.kind = K_CONTROL;
        rec.control = control;
        controlDown(control, rec);
        return;
      }
      if (grabbed && target.closest("[data-gc-stick]")) {
        if (countKind(K_STICK)) { rec.kind = K_IGNORED; return; }
        rec.kind = K_STICK;
        const zone = stickZone.getBoundingClientRect();
        stick.cx = zone.left + zone.width / 2;
        stick.cy = zone.top + zone.height / 2;
        stick.radius = Math.max(1, zone.width / 2);
        stickZone.classList.add("is-active");
        stickMove(event.clientX, event.clientY);
        return;
      }
      const x = toCanvasX(event.clientX);
      const y = toCanvasY(event.clientY);
      if (grabbed) {
        const slot = hotbarSlotAt(x, y);
        if (slot >= 0) {
          rec.kind = K_HOTBAR;
          rec.slot = slot;
          press(hotbarSlots[slot], T_HOTBAR);
          rec.timer = setTimeout(rec.onTimer, HOTBAR_DROP_MS);
          return;
        }
        rec.kind = K_LOOK;
        // Only the first finger on the look area turns the camera.
        if (countKind(K_LOOK) > 1) { rec.kind = K_IGNORED; return; }
        rec.state = L_PENDING;
        if (opts.tapToUse) rec.timer = setTimeout(rec.onTimer, LOOK_HOLD_MS);
        else rec.state = L_LOOK;
        return;
      }
      // Menu: a finger is the mouse. Hover at once; press after a short
      // wait so a second finger can turn the gesture into a scroll.
      const other = otherRecord(K_MENU, rec);
      if (other && !other.pressed) {
        if (other.timer) { clearTimeout(other.timer); other.timer = 0; }
        other.kind = K_SCROLL;
        rec.kind = K_SCROLL;
        rec.state = 0;
        other.state = 0;
        return;
      }
      if (other || countKind(K_SCROLL)) { rec.kind = K_IGNORED; return; }
      rec.kind = K_MENU;
      rec.pressed = false;
      moveCursorTo(x, y);
      rec.timer = setTimeout(rec.onTimer, MENU_PRESS_DELAY_MS);
    }

    function onPointerMove(event) {
      const rec = findRecord(event.pointerId);
      if (!rec) return;
      event.preventDefault();
      const dx = event.clientX - rec.lastX;
      const dy = event.clientY - rec.lastY;
      rec.lastX = event.clientX;
      rec.lastY = event.clientY;
      switch (rec.kind) {
        case K_STICK:
          stickMove(event.clientX, event.clientY);
          break;
        case K_LOOK: {
          if (rec.state === L_PENDING) {
            if (Math.hypot(event.clientX - rec.startX, event.clientY - rec.startY) <= TAP_SLOP_PX) break;
            if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; }
            rec.state = L_LOOK;
          }
          const speed = opts.touchLookSpeed;
          sendMove(dx * speed, dy * speed);
          break;
        }
        case K_HOTBAR:
          if (rec.timer && Math.hypot(event.clientX - rec.startX, event.clientY - rec.startY) > TAP_SLOP_PX) {
            clearTimeout(rec.timer);
            rec.timer = 0;
          }
          break;
        case K_MENU:
          if (!rec.pressed && Math.hypot(event.clientX - rec.startX, event.clientY - rec.startY) > TAP_SLOP_PX) {
            if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; }
            menuPress(rec);
          }
          moveCursorTo(toCanvasX(event.clientX), toCanvasY(event.clientY));
          break;
        case K_SCROLL: {
          // Average the two fingers: each contributes half its travel.
          rec.state += dy / 2;
          const partner = otherRecord(K_SCROLL, rec);
          let total = rec.state + (partner ? partner.state : 0);
          while (Math.abs(total) >= SCROLL_STEP_PX) {
            const step = total > 0 ? SCROLL_STEP_PX : -SCROLL_STEP_PX;
            // Fingers moving up scroll the content down, as on any touch screen.
            sendWheel(0, step > 0 ? -100 : 100, 0);
            rec.state -= step;
            total -= step;
          }
          break;
        }
        default:
          break;
      }
    }

    function onPointerEnd(event) {
      const rec = findRecord(event.pointerId);
      if (!rec) return;
      const cancelled = event.type !== "pointerup";
      finishRecord(rec, cancelled);
      if (event.type === "pointerup") {
        try { root.releasePointerCapture(event.pointerId); } catch {}
      }
    }

    function finishRecord(rec, cancelled) {
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; }
      switch (rec.kind) {
        case K_CONTROL:
          controlUp(rec.control, rec, cancelled);
          break;
        case K_STICK:
          stickZone.classList.remove("is-active");
          applyDirectional(0, 0, T_STICK, stick.state);
          knob.style.transform = "";
          stickZone.setAttribute("aria-valuetext", "Centered");
          break;
        case K_LOOK:
          if (rec.state === L_BREAK) release(mouseSlots[MOUSE_ATTACK], T_LOOK);
          else if (rec.state === L_PENDING && !cancelled && opts.tapToUse) {
            // A tap: press and let go; reconcile keeps it down one phase.
            press(mouseSlots[MOUSE_USE], T_LOOK);
            release(mouseSlots[MOUSE_USE], T_LOOK);
          }
          break;
        case K_HOTBAR:
          release(hotbarSlots[rec.slot], T_HOTBAR);
          release(dropSlot, T_HOTBAR);
          break;
        case K_MENU:
          if (!cancelled && !rec.pressed) menuPress(rec);
          if (rec.pressed) release(mouseSlots[MOUSE_ATTACK], T_MENU);
          break;
        default:
          break;
      }
      freeRecord(rec);
    }

    function recordTimer(rec) {
      if (rec.id === -1) return;
      if (rec.kind === K_LOOK && rec.state === L_PENDING) {
        rec.state = L_BREAK;
        press(mouseSlots[MOUSE_ATTACK], T_LOOK);
      } else if (rec.kind === K_MENU && !rec.pressed) {
        menuPress(rec);
      } else if (rec.kind === K_HOTBAR) {
        press(dropSlot, T_HOTBAR);
      }
    }

    function menuPress(rec) {
      rec.pressed = true;
      press(mouseSlots[MOUSE_ATTACK], T_MENU);
    }

    function stickMove(clientX, clientY) {
      let x = (clientX - stick.cx) / stick.radius;
      let y = (clientY - stick.cy) / stick.radius;
      const m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
      knob.style.transform = "translate3d(" + (x * stick.radius) + "px," + (y * stick.radius) + "px,0)";
      const live = m > STICK_DEADZONE;
      applyDirectional(live ? x : 0, live ? -y : 0, T_STICK, stick.state);
    }

    function setLatched(control, latched) {
      if (control.latched === latched) return;
      control.latched = latched;
      if (control.el) {
        control.el.classList.toggle("is-latched", latched);
        control.el.setAttribute("aria-pressed", String(latched));
      }
      if (!latched && control.slot && control.pointer === -1) release(control.slot, control.def.bit);
    }

    function controlDown(control, rec) {
      control.pointer = rec.id;
      control.el?.classList.add("is-active");
      const def = control.def;
      if (def.wheel) {
        sendWheel(0, def.wheel * 100, 0);
        return;
      }
      rec.wasLatched = control.latched;
      // In a menu the inventory button closes with Escape, not E: E would
      // type into the creative search field instead of closing.
      control.activeSlot = control.name === "inventory" && !grabbed ? escapeSlot : control.slot;
      press(control.activeSlot, def.bit);
    }

    function controlUp(control, rec, cancelled) {
      control.pointer = -1;
      control.el?.classList.remove("is-active");
      const def = control.def;
      if (def.wheel) return;
      if (def.latch && !cancelled) {
        const short = now() - rec.startTime < LATCH_TAP_MS;
        if (!rec.wasLatched && short) {
          setLatched(control, true);
          return;              // stays held by this control's bit
        }
        setLatched(control, false);
      } else if (def.latch) {
        setLatched(control, false);
      }
      release(control.activeSlot || control.slot, def.bit);
    }

    function cancelAllPointers() {
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (rec.id === -1) continue;
        // The finger is still down: leave the record claimed but inert.
        if (rec.kind !== K_IGNORED) {
          const id = rec.id;
          finishRecord(rec, true);
          rec.id = id;
          rec.kind = K_IGNORED;
        }
      }
    }

    function onWheel(event) {
      if (!ready || !touchEnabled() || event.target.closest(".mcweb-gc-help")) return;
      event.preventDefault();
      sendWheel(event.deltaX, event.deltaY, event.deltaMode);
    }

    // ------------------------------------------------------------ toolbar
    function onToolClick(event) {
      const tool = event.target.closest("[data-gc-tool]");
      if (!tool) return;
      // A pointer-activated tool must not keep focus, or the next Space for
      // jumping would press it again.
      if (event.detail !== 0) tool.blur();
      const name = tool.dataset.gcTool;
      if (name === "touch") setTouchMode(touchEnabled() ? "off" : "on");
      else if (name === "help") toggleHelp();
      else if (name === "help-close") toggleHelp(false);
      else if (name === "fullscreen") enterFullscreen();
    }

    function toggleHelp(force) {
      helpOpen = typeof force === "boolean" ? force : !helpOpen;
      render();
    }

    function setTouchMode(mode) {
      if (mode !== "auto" && mode !== "on" && mode !== "off") throw new TypeError("touch mode must be auto, on or off");
      const was = touchEnabled();
      status.touchMode = mode;
      try { globalThis.localStorage?.setItem(STORAGE_KEY, mode); } catch {}
      if (was && !touchEnabled()) {
        cancelAllPointers();
        for (const control of controls.values()) setLatched(control, false);
        releaseMask(TOUCH_MASK, false);
      }
      layout();
      emitStatus();
    }

    // ------------------------------------------------------------ gamepad
    const padPrev = new Uint8Array(PAD_BUTTONS);
    const padActions = new Array(PAD_BUTTONS).fill(null);
    const padStickState = new Uint8Array(4);
    let padIndex = -1;
    let padRaf = 0;
    let padLast = 0;
    let padScroll = 0;
    let padCursorVisible = false;

    const keyAction = (key) => ({ slot: keySlot(key[0], key[1]) });
    const mouseAction = (button) => ({ slot: mouseSlots[button] });
    const wheelAction = (dir) => ({ wheel: dir });
    const HELP_ACTION = { help: true };
    const GAME_ACTIONS = [
      keyAction(KEYS.jump), keyAction(KEYS.sneak), keyAction(KEYS.drop), keyAction(KEYS.inventory),
      wheelAction(-1), wheelAction(1), mouseAction(MOUSE_USE), mouseAction(MOUSE_ATTACK),
      keyAction(KEYS.playerList), keyAction(KEYS.pause), keyAction(KEYS.sprint), mouseAction(MOUSE_PICK),
      keyAction(KEYS.perspective), keyAction(KEYS.swapHands), wheelAction(-1), wheelAction(1), HELP_ACTION,
    ];
    const MENU_ACTIONS = [
      { slot: mouseSlots[MOUSE_ATTACK], atCursor: true }, keyAction(KEYS.pause),
      { slot: mouseSlots[MOUSE_USE], atCursor: true }, keyAction(KEYS.pause),
      wheelAction(-1), wheelAction(1), null, null,
      null, keyAction(KEYS.pause), keyAction(KEYS.sneak), null,
      null, null, wheelAction(-1), wheelAction(1), HELP_ACTION,
    ];

    function runPadAction(action, down, bit) {
      if (action.help) { if (down) toggleHelp(); return; }
      if (action.wheel) { if (down) sendWheel(0, action.wheel * 100, 0); return; }
      if (down && action.atCursor) moveCursorTo(cursorX, cursorY);
      pressFor(action.slot, bit, down);
    }

    function releasePad(resetEdges) {
      for (let i = 0; i < PAD_BUTTONS; i++) padActions[i] = null;
      if (resetEdges !== false) padPrev.fill(0);
      padStickState.fill(0);
      padScroll = 0;
      releaseMask(PAD_MASK, resetEdges !== false);
    }

    function padAnyPressed(pad) {
      const buttons = pad.buttons;
      for (let i = 0; i < buttons.length; i++) if (buttons[i] && buttons[i].pressed) return true;
      return false;
    }

    function selectPad(list) {
      let current = padIndex >= 0 ? list[padIndex] : null;
      if (current && !current.connected) current = null;
      for (let i = 0; i < list.length; i++) {
        const pad = list[i];
        if (!pad || !pad.connected || pad === current) continue;
        if (!current || padAnyPressed(pad)) {
          if (current) releasePad();
          current = pad;
          break;
        }
      }
      if (current && current.index !== padIndex) {
        padIndex = current.index;
        status.gamepad = current.id;
        status.gamepadMapping = current.mapping === "standard" ? "standard" : "non-standard";
        say(current.mapping === "standard"
          ? "Controller ready: " + current.id + ". Home/PS or ? shows the button map."
          : "Controller " + current.id + " has no standard mapping; buttons may differ from the help.");
      }
      return current;
    }

    function editableFocused() {
      const active = document.activeElement;
      return editableTarget(active);
    }

    function startPadLoop() {
      if (!padRaf && !destroyed) padRaf = requestAnimationFrame(padFrame);
    }

    function padFrame(timestamp) {
      padRaf = 0;
      if (destroyed) return;
      const list = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : null;
      const pad = list ? selectPad(list) : null;
      if (!pad) {
        if (padIndex !== -1) {
          releasePad();
          padIndex = -1;
          status.gamepad = null;
          status.gamepadMapping = null;
          emitStatus();
        }
        padLast = 0;
        return;            // gamepadconnected restarts the loop
      }
      const dt = padLast ? Math.min(0.05, Math.max(0, (timestamp - padLast) / 1000)) : 0;
      padLast = timestamp;
      padRaf = requestAnimationFrame(padFrame);
      if (!ready || document.visibilityState === "hidden" || editableFocused()) {
        releasePad();
        return;
      }
      const buttons = pad.buttons;
      const actions = grabbed ? GAME_ACTIONS : MENU_ACTIONS;
      let used = false;
      for (let i = 0; i < PAD_BUTTONS; i++) {
        const button = buttons[i];
        const value = button ? (typeof button.value === "number" && button.value > 0 ? button.value : (button.pressed ? 1 : 0)) : 0;
        const was = padPrev[i] === 1;
        const on = was ? value > 0.3 : value > 0.55;
        if (on === was) continue;
        padPrev[i] = on ? 1 : 0;
        used = true;
        const bit = 1 << (PAD_BUTTON_SHIFT + i);
        if (on) {
          const action = actions[i];
          padActions[i] = action;
          if (action) runPadAction(action, true, bit);
        } else {
          const action = padActions[i];
          padActions[i] = null;
          if (action) runPadAction(action, false, bit);
        }
      }
      const axes = pad.axes;
      let lx = axes[0] || 0;
      let ly = axes[1] || 0;
      const rx = axes[2] || 0;
      const ry = axes[3] || 0;
      const lm = Math.hypot(lx, ly);
      if (lm < opts.padDeadzone) { lx = 0; ly = 0; }
      const rm = Math.hypot(rx, ry);
      if (lm >= opts.padDeadzone || rm >= opts.padLookDeadzone) used = true;
      if (grabbed) {
        applyDirectional(lx, -ly, P_STICK, padStickState);
        if (rm > opts.padLookDeadzone && dt > 0) {
          const scaled = Math.min(1, (rm - opts.padLookDeadzone) / (1 - opts.padLookDeadzone));
          const k = scaled * scaled * opts.padLookSpeed * dt / rm;
          sendMove(rx * k, (opts.padInvertY ? -ry : ry) * k);
        }
      } else if (dt > 0) {
        if (lm >= opts.padDeadzone) {
          const scaled = Math.min(1, (lm - opts.padDeadzone) / (1 - opts.padDeadzone));
          const speed = rect.cw * 0.9 * (0.15 + 0.85 * scaled * scaled) * dt / lm;
          moveCursorTo(cursorX + lx * speed, cursorY + ly * speed);
          placeCursor();
        }
        if (Math.abs(ry) > opts.padDeadzone) {
          padScroll += ry * 10 * dt;
          while (padScroll >= 1) { sendWheel(0, 100, 0); padScroll -= 1; }
          while (padScroll <= -1) { sendWheel(0, -100, 0); padScroll += 1; }
        } else {
          padScroll = 0;
        }
      }
      if (used && !grabbed && !padCursorVisible) {
        padCursorVisible = true;
        placeCursor();
      }
    }

    function placeCursor() {
      const show = padCursorVisible && !grabbed && ready && canvas !== null;
      if (cursorEl.hidden === show) cursorEl.hidden = !show;
      if (!show || rect.cw <= 0) return;
      const x = cursorX * rect.width / rect.cw + rect.left - rootBox.left;
      const y = cursorY * rect.height / rect.ch + rect.top - rootBox.top;
      cursorEl.style.transform = "translate3d(" + x + "px," + y + "px,0)";
    }

    function onGamepadConnected() {
      startPadLoop();
    }
    function onGamepadDisconnected(event) {
      if (event.gamepad && event.gamepad.index === padIndex) {
        releasePad();
        padIndex = -1;
        status.gamepad = null;
        status.gamepadMapping = null;
        padCursorVisible = false;
        placeCursor();
        say("Controller disconnected; its buttons were released.");
      }
      startPadLoop();
    }

    // ------------------------------------------------------------ fullscreen
    const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
    // The user's current intent. Exit while a request is still pending
    // clears it, and a success that lands afterwards is undone at once.
    let fullscreenWanted = false;
    let fullscreenWaiter = null;
    let fullscreenWaitTimer = 0;

    function setFullscreenState(state) {
      status.fullscreen = state;
      const on = state === "native" || state === "css-fallback";
      container.classList.toggle("mcweb-gc-fullscreen", on);
      container.classList.toggle("mcweb-gc-css-fullscreen", state === "css-fallback");
      document.documentElement.classList.toggle("mcweb-gc-scroll-locked", state === "css-fallback");
      if (on) container.dataset.mcwebFullscreen = state;
      else delete container.dataset.mcwebFullscreen;
      // Fullscreen and a resize both move the canvas under fingers.
      releaseAll();
      layout();
      emitStatus();
    }

    function settleFullscreen(result) {
      clearTimeout(fullscreenWaitTimer);
      fullscreenWaitTimer = 0;
      const waiter = fullscreenWaiter;
      fullscreenWaiter = null;
      if (waiter) waiter(result);
    }

    function fullscreenFailed(error) {
      status.orientation = "not-attempted";
      setFullscreenState("css-fallback");
      const reason = error && error.name ? error.name : "unavailable";
      say("Fullscreen " + (reason === "unavailable" ? "is not available here" : "was refused (" + reason + ")")
        + "; the game now fills the page. Use Exit to leave.");
      settleFullscreen(status.fullscreen);
      return status.fullscreen;
    }

    // Must run inside a trusted click/tap: the request is made synchronously.
    function enterFullscreen() {
      if (destroyed) return Promise.resolve("off");
      fullscreenWanted = true;
      if (fullscreenElement() === container) return Promise.resolve("native");
      if (status.fullscreen === "css-fallback" || status.fullscreen === "pending") return Promise.resolve(status.fullscreen);
      const request = container.requestFullscreen || container.webkitRequestFullscreen;
      if (typeof request !== "function") return Promise.resolve(fullscreenFailed(null));
      status.fullscreen = "pending";
      render();
      emitStatus();
      const settled = new Promise((resolve) => { fullscreenWaiter = resolve; });
      let result;
      try {
        result = request.call(container, { navigationUI: "hide" });
      } catch (error) {
        return Promise.resolve(fullscreenFailed(error));
      }
      if (result && typeof result.then === "function") {
        result.then(onFullscreenChange, (error) => { if (status.fullscreen === "pending") fullscreenFailed(error); });
      }
      // The prefixed API returns nothing and may report neither outcome.
      fullscreenWaitTimer = setTimeout(() => {
        if (status.fullscreen === "pending") fullscreenFailed({ name: "Timeout" });
      }, 2000);
      return settled;
    }

    function leaveNativeFullscreen() {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      try {
        const result = exit?.call(document);
        result?.catch?.(() => {});
      } catch {}
    }

    function onFullscreenChange() {
      const active = fullscreenElement() === container;
      if (active && !fullscreenWanted) {
        // A request that succeeded after Exit was chosen: leave again, no lock.
        leaveNativeFullscreen();
        return;
      }
      if (active && status.fullscreen !== "native") {
        // Also a late success after the CSS fallback took over: still wanted.
        setFullscreenState("native");
        settleFullscreen("native");
        lockLandscape();
      } else if (!active && status.fullscreen === "native") {
        fullscreenWanted = false;
        unlockOrientation();
        setFullscreenState("off");
        say("Left fullscreen.");
      }
    }

    function onFullscreenError() {
      if (status.fullscreen === "pending") fullscreenFailed({ name: "Refused" });
    }

    // Only after fullscreen succeeded: every engine that implements the lock
    // requires it, and WebKit may not implement the lock at all.
    function lockLandscape() {
      const orientation = globalThis.screen?.orientation;
      if (!orientation || typeof orientation.lock !== "function") {
        status.orientation = "unsupported";
        say("Fullscreen on. This browser cannot lock landscape; rotate the device yourself.");
        return;
      }
      let pending;
      try { pending = orientation.lock("landscape"); } catch (error) { pending = Promise.reject(error); }
      Promise.resolve(pending).then(() => {
        if (status.fullscreen !== "native") {
          try { orientation.unlock?.(); } catch {}
          return;
        }
        status.orientation = "locked";
        say("Fullscreen on, landscape locked.");
      }, (error) => {
        if (status.fullscreen !== "native") return;
        status.orientation = error && error.name === "NotSupportedError" ? "unsupported" : "denied";
        say("Fullscreen on. Landscape lock " + (status.orientation === "unsupported" ? "is not supported" : "was refused")
          + " here; rotate the device yourself.");
      });
    }

    function unlockOrientation() {
      if (status.orientation === "locked") {
        try { globalThis.screen?.orientation?.unlock?.(); } catch {}
      }
      status.orientation = "not-attempted";
    }

    function exitFullscreen() {
      fullscreenWanted = false;
      if (fullscreenElement() === container) {
        leaveNativeFullscreen();
        return;
      }
      if (status.fullscreen === "css-fallback" || status.fullscreen === "pending") {
        unlockOrientation();
        setFullscreenState("off");
        settleFullscreen("off");
      }
    }

    // ------------------------------------------------------------ native keyboard
    // iOS opens its keyboard only for an element focused inside the user's
    // tap, and the game learns of that tap a frame later, on other threads.
    // So the game tells the page, ahead of time, which text input it wants
    // (dev.mcweb.graal.BrowserTextInput via webgpu-host.js): whether text
    // input is started, the caret rectangle and the rectangles of the visible
    // text fields on the current screen, in canvas pixels. A tap that ends on
    // one of those fields focuses textProxy inside the same touchend, while
    // the tap itself still reaches the game as a click and focuses the field
    // there. Taps elsewhere (buttons, movement or the look area) never open it.
    // Two cases have no field under the finger:
    //   - text input belongs to a screen that edits text without a widget
    //     (the sign editor; Java names the owner): any tap on the game opens it;
    //   - the chat button: focus its proxy during the trusted touch and keep a
    //     bounded confirmation window while a slow Java frame opens chat.
    // The keyboard closes when the game stops text input (field left, screen
    // closed, Enter in chat), when the player dismisses it, and on abort.
    //
    // Typed text goes back as { mcwebText } messages (commit or preedit), and
    // the keys that edit rather than type (Backspace, Enter, arrows, Escape,
    // shortcuts) as ordinary key events, each exactly once: the textarea is
    // emptied after every edit, and a key forwarded as a key is prevented, so
    // the browser never also turns it into an edit.
    const TEXT_CONFIRM_MS = 2500;    // a tapped field must start text input promptly
    const CHAT_CONFIRM_MS = 30000;   // slow mobile Java may need several frames to open chat
    const TEXT_STOP_GRACE_MS = 300;  // focus moving between two fields stops, then restarts
    const KEYBOARD_MARGIN_PX = 8;    // CSS px kept between the field and the keyboard
    const MAX_TEXT_MESSAGE = 1024;   // code points per commit (a paste)
    // Keys the soft keyboard reports without a code.
    const KEY_CODES = {
      Backspace: "Backspace", Enter: "Enter", Tab: "Tab", Escape: "Escape", Delete: "Delete",
      ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
      Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
      Shift: "ShiftLeft", Control: "ControlLeft", Alt: "AltLeft", Meta: "MetaLeft",
    };
    const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);
    const textState = {
      active: false,
      owner: null,        // what owns text input: "widget", "screen" or null (unknown)
      area: null,
      fields: [],
      reports: 0,
      sentCodePoints: 0,  // committed to the game, for checks that typing really arrived
      sentKeys: 0,        // key downs forwarded from the textarea
      starts: 0,          // how often text input went from stopped to started
      open: false,        // textProxy focused by us
      confirmed: false,   // the game has had text input started since it opened
      composing: false,
      target: null,       // the tapped field, until the game reports its own
      shift: 0,           // CSS px the stage is lifted above the keyboard
      scrollX: 0,
      scrollY: 0,
      confirmTimer: 0,
      stopTimer: 0,
      worker: null,
    };
    const textKeys = new Map();      // code -> key of keys the textarea forwarded down
    const taps = new Map();          // touch identifier -> tap record

    function onTextWorkerMessage(event) {
      const data = event.data;
      if (data && data.mcwebTextInput) applyTextInputState(data.mcwebTextInput);
    }
    function onTextInputEvent(event) {
      if (event.detail) applyTextInputState(event.detail);
    }
    // The host reports changes only, so a page that starts listening late
    // asks for the current state once. Where the host runs on the page it
    // announces through the "mcweb-text-input" event instead.
    function attachTextWorker() {
      const worker = globalThis.__mcWebGpuWorker || null;
      if (worker === textState.worker) return;
      if (textState.worker && typeof textState.worker.removeEventListener === "function") {
        textState.worker.removeEventListener("message", onTextWorkerMessage);
      }
      textState.worker = worker;
      if (worker && typeof worker.addEventListener === "function") {
        worker.addEventListener("message", onTextWorkerMessage);
        try { worker.postMessage({ mcwebTextInputQuery: true }); } catch {}
      }
    }

    function applyTextInputState(state) {
      if (destroyed || !state) return;
      const active = state.active === true;
      if (active && !textState.active) textState.starts++;
      textState.active = active;
      textState.owner = active && (state.owner === "widget" || state.owner === "screen") ? state.owner : null;
      textState.area = validRect(state.area);
      textState.fields = Array.isArray(state.fields) ? state.fields.filter(validRect) : [];
      textState.reports++;
      uncoverTextFields();
      if (!textState.open) return;
      if (active) {
        textState.confirmed = true;
        if (textState.confirmTimer) { clearTimeout(textState.confirmTimer); textState.confirmTimer = 0; }
        if (textState.stopTimer) { clearTimeout(textState.stopTimer); textState.stopTimer = 0; }
        textState.target = null;
        placeTextProxy();
        adjustForKeyboard();
      } else if (textState.confirmed && !textState.stopTimer) {
        textState.stopTimer = setTimeout(() => {
          textState.stopTimer = 0;
          if (!textState.active) closeKeyboard();
        }, TEXT_STOP_GRACE_MS);
      }
    }
    function validRect(r) {
      return r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0 ? r : null;
    }

    function fieldAt(x, y) {
      const fields = textState.fields;
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        if (x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h) return f;
      }
      return null;
    }
    // The menu's Pause/back button sits top centre, which is where vanilla
    // puts a form's first text field (Create New World's World Name, a
    // server's name): on a phone the button covered the field, and a tap
    // meant for it pressed Escape and left the screen. A utility button over
    // a reported field is hidden (visibility, so the row keeps its layout
    // and the overlap test stays stable) and the tap reaches the field; the
    // screen's own Cancel/Done buttons still leave it.
    function uncoverTextFields() {
      const fields = textState.fields;
      const measured = fields.length > 0 && measure();
      const sx = rect.width / rect.cw;
      const sy = rect.height / rect.ch;
      for (const button of utilityButtons) {
        let covers = false;
        if (measured) {
          const b = button.getBoundingClientRect();
          for (let i = 0; i < fields.length && !covers && b.width > 0; i++) {
            const f = fields[i];
            const left = rect.left + f.x * sx;
            const top = rect.top + f.y * sy;
            covers = left < b.right && left + f.w * sx > b.left && top < b.bottom && top + f.h * sy > b.top;
          }
        }
        button.classList.toggle("is-over-text-field", covers);
      }
    }
    // The rectangle to keep visible: the focused field, else the caret, else
    // the field that was tapped.
    function textTarget() {
      const fields = textState.fields;
      if (textState.active) {
        for (let i = 0; i < fields.length; i++) if (fields[i].focused) return fields[i];
        if (textState.area) return textState.area;
      }
      return textState.target;
    }

    function onTextTouchStart(event) {
      if (destroyed) return;
      attachTextWorker();
      const multi = event.touches.length > 1;
      if (multi) for (const tap of taps.values()) tap.multi = true;
      const target = event.target && event.target.nodeType === 1 ? event.target : null;
      for (const touch of event.changedTouches) {
        taps.set(touch.identifier, {
          x: touch.clientX,
          y: touch.clientY,
          starts: textState.starts,
          multi,
          chat: Boolean(target?.closest('[data-gc="chat"]')),
          ui: Boolean(target?.closest(".mcweb-gc-toolbar, .mcweb-gc-help, .mcweb-gc-toast, .mcweb-gc-exit, [data-gc], [data-gc-stick]")),
        });
      }
    }
    function onTextTouchCancel(event) {
      for (const touch of event.changedTouches) taps.delete(touch.identifier);
    }
    // Runs inside the touchend, the only place the keyboard may be opened.
    function onTextTouchEnd(event) {
      for (const touch of event.changedTouches) {
        const tap = taps.get(touch.identifier);
        taps.delete(touch.identifier);
        if (!tap || tap.multi || event.touches.length > 0 || destroyed) continue;
        if (Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > TAP_SLOP_PX) continue;
        if (tap.chat) {
          openKeyboard(null, CHAT_CONFIRM_MS);
          continue;
        }
        if (tap.ui || !measure()) continue;
        const field = fieldAt(toCanvasX(touch.clientX), toCanvasY(touch.clientY));
        if (field) {
          openKeyboard(field);
        } else if (textState.active && textState.owner === "screen") {
          openKeyboard(null);
        }
      }
    }

    function openKeyboard(field, confirmMs = TEXT_CONFIRM_MS) {
      if (!textProxy.isConnected) return;
      if (textState.stopTimer) { clearTimeout(textState.stopTimer); textState.stopTimer = 0; }
      if (field) textState.target = field;
      placeTextProxy();
      if (document.activeElement !== textProxy) {
        textState.scrollX = globalThis.scrollX || 0;
        textState.scrollY = globalThis.scrollY || 0;
        textProxy.value = "";
        try { textProxy.focus({ preventScroll: true }); } catch { textProxy.focus(); }
      }
      if (document.activeElement !== textProxy) return;
      if (!textState.open) {
        textState.open = true;
        textState.confirmed = textState.active;
        status.keyboard = "open";
        emitStatus();
      }
      if (!textState.confirmed && !textState.confirmTimer) {
        // A field the game did not take (it may not be editable).
        textState.confirmTimer = setTimeout(() => {
          textState.confirmTimer = 0;
          if (!textState.active) closeKeyboard();
        }, confirmMs);
      }
      adjustForKeyboard();
    }

    function closeKeyboard() {
      if (textState.confirmTimer) { clearTimeout(textState.confirmTimer); textState.confirmTimer = 0; }
      if (textState.stopTimer) { clearTimeout(textState.stopTimer); textState.stopTimer = 0; }
      const wasOpen = textState.open;
      textState.open = false;
      textState.confirmed = false;
      textState.target = null;
      releaseTextKeys();
      if (textState.composing) {
        // A composition the blur did not end would stay drawn in the game.
        textState.composing = false;
        sendTextMessage({ kind: "preedit", text: "", cursor: 0, selection: 0 });
      }
      if (document.activeElement === textProxy) textProxy.blur();
      textProxy.value = "";
      setKeyboardShift(0);
      if (wasOpen) {
        // iOS scrolls the page while its keyboard is up; put it back.
        if ((globalThis.scrollX || 0) !== textState.scrollX || (globalThis.scrollY || 0) !== textState.scrollY) {
          try { globalThis.scrollTo(textState.scrollX, textState.scrollY); } catch {}
        }
        status.keyboard = "closed";
        emitStatus();
      }
    }

    // The textarea lies over the field it types into, so the browser's own
    // caret-into-view logic agrees with the lift below. Its position is the
    // unlifted one: the lift moves it with the canvas.
    function placeTextProxy() {
      const target = textTarget();
      if (!target || !measure()) return;
      const hostBox = container.getBoundingClientRect();
      const sx = rect.width / rect.cw;
      const sy = rect.height / rect.ch;
      textProxy.style.left = (rect.left - hostBox.left - container.clientLeft + target.x * sx) + "px";
      textProxy.style.top = (rect.top + textState.shift - hostBox.top - container.clientTop + target.y * sy) + "px";
      textProxy.style.width = Math.max(1, target.w * sx) + "px";
      textProxy.style.height = Math.max(1, target.h * sy) + "px";
    }

    // Lift the stage's contents (CSS translate only: the canvas keeps its
    // size and framebuffer) just enough that the field stays above the
    // keyboard, as the visual viewport reports it.
    //
    // Coordinates: getBoundingClientRect is relative to the layout viewport
    // (Chrome and Safari alike; https://developer.chrome.com/blog/visual-viewport-api),
    // and visualViewport.offsetTop/height place the visible part inside that
    // same layout viewport (MDN VisualViewport.offsetTop). When iOS pans the
    // page for the keyboard, offsetTop grows and the field's rectangle does
    // not, so the visible band is [offsetTop, offsetTop + height].
    function keyboardGeometry() {
      const viewport = globalThis.visualViewport;
      const target = textState.open ? textTarget() : null;
      if (!viewport || !target || !measure()) return null;
      const sy = rect.height / rect.ch;
      const top = rect.top + textState.shift + target.y * sy;
      return {
        top,
        bottom: top + Math.max(1, target.h * sy),
        visibleTop: viewport.offsetTop,
        visibleBottom: viewport.offsetTop + viewport.height,
      };
    }
    // Up when the keyboard covers the field, down when the visible band was
    // panned below it; a field taller than the band keeps its top visible.
    function adjustForKeyboard() {
      const g = keyboardGeometry();
      if (!g) { setKeyboardShift(0); return; }
      let lift = 0;
      if (g.bottom + KEYBOARD_MARGIN_PX > g.visibleBottom) {
        lift = Math.min(g.bottom + KEYBOARD_MARGIN_PX - g.visibleBottom, g.top - g.visibleTop - KEYBOARD_MARGIN_PX);
      } else if (g.top - KEYBOARD_MARGIN_PX < g.visibleTop) {
        lift = g.top - KEYBOARD_MARGIN_PX - g.visibleTop;
      }
      setKeyboardShift(Math.round(lift));
    }
    function setKeyboardShift(px) {
      if (px === textState.shift) return;
      textState.shift = px;
      container.style.setProperty("--mcweb-gc-kb-shift", px + "px");
      container.classList.toggle("mcweb-gc-kb-shifted", px !== 0);
    }

    function sendTextMessage(message) {
      if (typeof opts.sendText === "function") {
        try { opts.sendText(message); } catch (error) { console.warn("[game-controls] sendText:", error); }
        return;
      }
      if (opts.transport !== "dom") {
        const worker = globalThis.__mcWebGpuWorker;
        if (worker && typeof worker.postMessage === "function") {
          worker.postMessage({ mcwebText: message });
          return;
        }
        if (opts.transport === "worker") return;
      }
      globalThis.mcWebInput?.applyTextMessage?.(message);
    }
    function commitText(text) {
      if (!text) return;
      const points = Array.from(text.replace(/\r\n?/g, "\n")).slice(0, MAX_TEXT_MESSAGE);
      if (!points.length) return;
      textState.sentCodePoints += points.length;
      sendTextMessage({ kind: "commit", text: points.join("") });
    }

    function sendTextKey(type, code, key, event) {
      prepareInit();
      if (type === "keydown") textState.sentKeys++;
      init.code = code;
      init.key = key;
      init.button = 0;
      init.repeat = Boolean(event && event.repeat);
      init.shiftKey = Boolean(event && event.shiftKey);
      init.ctrlKey = Boolean(event && event.ctrlKey);
      init.altKey = Boolean(event && event.altKey);
      init.metaKey = Boolean(event && event.metaKey);
      deliver(type);
      init.altKey = false;
      init.metaKey = false;
    }
    // A key the textarea has no edit for, typed by hand.
    function pressTextKey(code, key, mods) {
      sendTextKey("keydown", code, key, mods);
      sendTextKey("keyup", code, key, mods);
    }
    function releaseTextKeys() {
      for (const [code, key] of textKeys) sendTextKey("keyup", code, key, null);
      textKeys.clear();
    }

    function onProxyKeyDown(event) {
      // Nothing typed here may reach the page's own key forwarder as well.
      event.stopPropagation();
      if (!event.isTrusted || event.isComposing || event.keyCode === 229) return;
      const key = event.key || "";
      const named = key.length > 1 && key !== "Unidentified" && key !== "Dead" && key !== "Process";
      const shortcut = (event.ctrlKey || event.metaKey) && !MODIFIER_KEYS.has(key);
      // A printable key types through beforeinput; only keys that edit,
      // move or command are keys to the game.
      if (!named && !shortcut) return;
      const code = event.code || KEY_CODES[key] || "";
      if (!MODIFIER_KEYS.has(key)) event.preventDefault();
      if (!code) return;
      textKeys.set(code, key);
      sendTextKey("keydown", code, key, event);
    }
    function onProxyKeyUp(event) {
      event.stopPropagation();
      if (!event.isTrusted) return;
      const code = event.code || KEY_CODES[event.key] || "";
      if (!code || !textKeys.has(code)) return;
      textKeys.delete(code);
      sendTextKey("keyup", code, event.key || "", event);
    }

    function onProxyBeforeInput(event) {
      const type = event.inputType || "";
      if (event.isComposing || type === "insertCompositionText" || type === "deleteCompositionText"
          || type === "insertFromComposition") {
        return;                     // composition events carry it
      }
      if (event.cancelable) event.preventDefault();
      if (!textState.open) return;
      const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
      switch (type) {
        case "insertText":
        case "insertReplacementText":
        case "insertFromPaste":
        case "insertFromDrop":
        case "insertFromPasteAsQuotation":
        case "insertFromYank": {
          const text = event.data ?? event.dataTransfer?.getData?.("text/plain") ?? "";
          commitText(text);
          break;
        }
        // Reached only when no prevented keydown already sent the key.
        case "insertLineBreak":
        case "insertParagraph":
          pressTextKey("Enter", "Enter", mods);
          break;
        case "deleteContentBackward":
          pressTextKey("Backspace", "Backspace", mods);
          break;
        case "deleteWordBackward":
          mods.ctrlKey = true;
          pressTextKey("Backspace", "Backspace", mods);
          break;
        case "deleteContentForward":
          pressTextKey("Delete", "Delete", mods);
          break;
        case "deleteWordForward":
          mods.ctrlKey = true;
          pressTextKey("Delete", "Delete", mods);
          break;
        default:
          break;
      }
    }
    function onProxyInput() {
      // Whatever a non-cancelable edit left behind was already sent.
      if (!textState.composing && textProxy.value) textProxy.value = "";
    }
    function onCompositionStart() {
      textState.composing = true;
    }
    function onCompositionUpdate(event) {
      if (!textState.composing) textState.composing = true;
      const text = event.data || "";
      const length = Array.from(text).length;
      sendTextMessage({ kind: "preedit", text, cursor: length, selection: 0 });
    }
    function onCompositionEnd(event) {
      if (!textState.composing) return;
      textState.composing = false;
      sendTextMessage({ kind: "preedit", text: "", cursor: 0, selection: 0 });
      commitText(event.data || "");
      textProxy.value = "";
      // Some engines write the committed text after this event.
      setTimeout(() => { if (!textState.composing) textProxy.value = ""; }, 0);
    }
    function onProxyBlur() {
      if (textState.open) closeKeyboard();
    }

    // ------------------------------------------------------------ lifecycle
    function releaseAll() {
      cancelAllPointers();
      for (let i = 0; i < records.length; i++) freeRecord(records[i]);
      for (const control of controls.values()) {
        control.pointer = -1;
        control.el?.classList.remove("is-active");
        setLatched(control, false);
      }
      stickZone.classList.remove("is-active");
      knob.style.transform = "";
      stick.state.fill(0);
      releasePad();
      releaseMask(ALL_MASK, true);
      mouseButtons = 0;
      launcherCodes.clear();
      launcherEvent = null;
      taps.clear();
      if (textState.open || document.activeElement === textProxy) closeKeyboard();
    }

    function onBlurOrHide() {
      if (document.visibilityState === "hidden" || !document.hasFocus()) releaseAll();
    }

    // Callback inputs (isReady, isGrabbed, a replaced canvas, a new GPU
    // Worker) are cheap to read; a slow timer keeps them current without any
    // per-frame work.
    function sync() {
      if (destroyed) return;
      if (typeof opts.isReady === "function") {
        let value = false;
        try { value = Boolean(opts.isReady()); } catch {}
        if (value !== ready) setReadyState(value);
      }
      if (ready) attachWorker();
      // Text fields come before the first frames (title, world creation), so
      // this follows the GPU Worker whether or not the controls are ready.
      attachTextWorker();
      if (typeof opts.isGrabbed === "function") {
        let value = false;
        try { value = Boolean(opts.isGrabbed()); } catch {}
        if (value !== lastGrabbedCallback) { lastGrabbedCallback = value; setGrabbed(value); }
      }
      if ((getCanvasOption() || null) !== canvas) layout();
    }

    let resizeObserver = null;
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => layout());
      resizeObserver.observe(container);
    }
    const syncTimer = setInterval(sync, 250);

    root.addEventListener("pointerdown", onPointerDown, { signal });
    root.addEventListener("pointermove", onPointerMove, { signal });
    root.addEventListener("pointerup", onPointerEnd, { signal });
    root.addEventListener("pointercancel", onPointerEnd, { signal });
    root.addEventListener("lostpointercapture", onPointerEnd, { signal });
    root.addEventListener("wheel", onWheel, { signal, passive: false });
    root.addEventListener("contextmenu", (event) => { if (touchEnabled()) event.preventDefault(); }, { signal });
    root.addEventListener("click", onToolClick, { signal });
    exitButton.addEventListener("click", exitFullscreen, { signal });
    container.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch" && !touchDetected) {
        touchDetected = true;
        if (status.touchMode === "auto") { render(); uncoverTextFields(); }
      }
    }, { signal, capture: true });
    container.addEventListener("touchstart", onTextTouchStart, { signal, capture: true, passive: true });
    container.addEventListener("touchend", onTextTouchEnd, { signal, capture: true, passive: true });
    container.addEventListener("touchcancel", onTextTouchCancel, { signal, capture: true, passive: true });
    // The tap that focused the textarea is then replayed as compatibility
    // mouse events, and a mousedown on the canvas would move focus back to
    // the page: the keyboard closed again the moment it opened. Only that
    // default action is prevented; the event still reaches the canvas, whose
    // forwarder (pre.js) gives the game its click (that is how the field gets
    // focus in the game).
    container.addEventListener("mousedown", (event) => {
      if (textState.open && document.activeElement === textProxy) event.preventDefault();
    }, { signal, capture: true });
    textProxy.addEventListener("keydown", onProxyKeyDown, { signal });
    textProxy.addEventListener("keyup", onProxyKeyUp, { signal });
    textProxy.addEventListener("beforeinput", onProxyBeforeInput, { signal });
    textProxy.addEventListener("input", onProxyInput, { signal });
    textProxy.addEventListener("compositionstart", onCompositionStart, { signal });
    textProxy.addEventListener("compositionupdate", onCompositionUpdate, { signal });
    textProxy.addEventListener("compositionend", onCompositionEnd, { signal });
    textProxy.addEventListener("blur", onProxyBlur, { signal });
    addEventListener("mcweb-text-input", onTextInputEvent, { signal });
    globalThis.visualViewport?.addEventListener("resize", adjustForKeyboard, { signal });
    globalThis.visualViewport?.addEventListener("scroll", adjustForKeyboard, { signal });
    addEventListener("keydown", onKeyDownCapture, { signal, capture: true });
    addEventListener("keyup", onKeyUpCapture, { signal, capture: true });
    addEventListener("keydown", onKeyBubble, { signal });
    addEventListener("keyup", onKeyBubble, { signal });
    addEventListener("blur", onBlurOrHide, { signal });
    addEventListener("pagehide", releaseAll, { signal });
    document.addEventListener("visibilitychange", onBlurOrHide, { signal });
    addEventListener("resize", layout, { signal });
    addEventListener("orientationchange", layout, { signal });
    addEventListener("gamepadconnected", onGamepadConnected, { signal });
    addEventListener("gamepaddisconnected", onGamepadDisconnected, { signal });
    document.addEventListener("fullscreenchange", onFullscreenChange, { signal });
    document.addEventListener("webkitfullscreenchange", onFullscreenChange, { signal });
    document.addEventListener("fullscreenerror", onFullscreenError, { signal });
    document.addEventListener("webkitfullscreenerror", onFullscreenError, { signal });

    // Controllers already connected before the page listened (Chromium) show
    // up in getGamepads without an event.
    startPadLoop();

    const api = {
      setReady(value) {
        readyFlag = Boolean(value);
        if (typeof opts.isReady !== "function") setReadyState(readyFlag);
      },
      setTouchMode,
      enterFullscreen,
      exitFullscreen,
      toggleHelp,
      releaseAll,
      layout,
      setOptions(next) {
        for (const key of ["tapToUse", "guiScale", "minPhaseMs", "touchLookSpeed", "padLookSpeed", "padInvertY", "padDeadzone", "padLookDeadzone", "transport"]) {
          if (next && key in next) opts[key] = next[key];
        }
        layout();
      },
      getState() {
        const held = [];
        keySlots.forEach((slot) => { if (slot.down) held.push(slot.code); });
        for (let i = 0; i < mouseSlots.length; i++) if (mouseSlots[i].down) held.push("Mouse" + i);
        return Object.assign({}, status, {
          held,
          cursor: { x: cursorX, y: cursorY },
          canvas: { cssWidth: rect.width, cssHeight: rect.height, width: rect.cw, height: rect.ch, guiScale: guiScale() },
          textInput: {
            active: textState.active,
            owner: textState.owner,
            fields: textState.fields.length,
            // Canvas pixels, as Java reported them: where a tap opens the keyboard.
            fieldRects: textState.fields.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, owner: f.focused === true })),
            reports: textState.reports,
            focused: document.activeElement === textProxy,
            composing: textState.composing,
            shift: textState.shift,
            // Measured now, for device checks: the field's unlifted top and
            // bottom and the visible band, all in client CSS px.
            geometry: keyboardGeometry(),
            sentCodePoints: textState.sentCodePoints,
            sentKeys: textState.sentKeys,
          },
        });
      },
      mapping: MAPPING_HELP,
      destroy() {
        if (destroyed) return;
        releaseAll();
        if (status.fullscreen !== "off") exitFullscreen();
        destroyed = true;
        listeners.abort();
        clearInterval(syncTimer);
        clearTimeout(toastTimer);
        settleFullscreen("off");
        if (padRaf) cancelAnimationFrame(padRaf);
        resizeObserver?.disconnect();
        if (attachedWorker && typeof attachedWorker.removeEventListener === "function") {
          attachedWorker.removeEventListener("message", onWorkerMessage);
        }
        root.remove();
        exitButton.remove();
        if (textState.worker && typeof textState.worker.removeEventListener === "function") {
          textState.worker.removeEventListener("message", onTextWorkerMessage);
        }
        textProxy.remove();
        container.style.removeProperty("--mcweb-gc-kb-shift");
        container.classList.remove("mcweb-gc-host", "mcweb-gc-host-positioned", "mcweb-gc-fullscreen", "mcweb-gc-css-fullscreen",
          "mcweb-gc-kb-shifted");
        document.documentElement.classList.remove("mcweb-gc-scroll-locked");
        delete container.dataset.mcwebFullscreen;
        instance = null;
      },
    };
    instance = api;
    layout();
    emitStatus();
    return api;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  function helpHtml() {
    const rows = (list, cells) => list.map((row) =>
      "<tr>" + row.slice(0, cells).map((cell, i) => (i ? "<td>" : "<th scope=\"row\">") + escapeHtml(cell) + (i ? "</td>" : "</th>")).join("") + "</tr>").join("");
    return "<h2>Controller (standard mapping)</h2>"
      + "<table><thead><tr><th scope=\"col\">Button</th><th scope=\"col\">Playing</th><th scope=\"col\">Menus</th></tr></thead><tbody>"
      + rows(MAPPING_HELP.controller, 3) + "</tbody></table>"
      + "<h2>Touch</h2><table><tbody>" + rows(MAPPING_HELP.touch, 2) + "</tbody></table>"
      + "<p>Keyboard and mouse keep Minecraft's own bindings. Controls follow vanilla defaults; rebinding keys in Minecraft's options does not move them.</p>";
  }

  globalThis.mcWebGameControls = Object.freeze({
    create,
    mapping: MAPPING_HELP,
    padButtonNames: Object.freeze(PAD_NAMES.slice()),
    version: 1,
  });
})();
