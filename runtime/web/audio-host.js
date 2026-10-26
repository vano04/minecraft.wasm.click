// Minecraft's sound engine, on WebAudio.
//
// Java's SoundManager shadow hands us sound *event* ids
// ("minecraft:ui.button.click"); resolving those to files is normally
// SoundEngine's job, but the ogg files are not in the client JAR -- they live
// in the launcher's asset object store and are staged next to this page by the
// stageMinecraftAudio Gradle task, together with sounds.json.
//
// Kept out of webgpu-host.js so audio can run with no WebGPU device, no canvas,
// and no Wasm image.
globalThis.mcWebAudio = (() => {
  // pre.js also loads this script after the JVM starts. Retain only the API
  // object created by this version, including its gesture-activated elements.
  const HOST_KEY = Symbol.for('mcweb.audio.stream-pool.v2');
  if (globalThis[HOST_KEY] && globalThis[HOST_KEY] === globalThis.mcWebAudio) return globalThis[HOST_KEY];
  const ROOT = "mcweb-audio";
  const NAMESPACE_SEPARATOR = ":";

  let ctx = null;
  let masterGain = null;
  let masterVolume = 1;
  let masterLimiter = null;
  let disposed = false;
  let disposal = null;
  let disposalState = null;
  /** Headroom the master bus keeps below full scale; see ensureContext. */
  const MASTER_HEADROOM = 0.7;
  // Audio decode is asynchronous from Java's point of view, but Chromium can
  // still spend a long synchronous slice in decodeAudioData while the menu
  // music is being prepared. Keep the normal experience enabled, with an
  // opt-in switch for bootstrap diagnostics and low-power hosts.
  let enabled = !new URLSearchParams(location.search).has("mcweb_no_audio");
  let soundDefinitions = null;
  let definitionsPromise = null;
  let nextHandle = 1;
  let playCount = 0;
  let missing = new Set();

  const categoryGains = new Map();
  const categoryVolumes = new Map();
  const buffers = new Map();
  const decodedUrls = new Set();
  const preparedEvents = new Map();
  const probeLog = [];
  const live = new Map();
  const listener = {x: 0, y: 0, z: 0, forwardX: 0, forwardY: 0, forwardZ: -1, upX: 0, upY: 1, upZ: 0};
  const MAX_STREAM_ENCODED_BYTES = 16 * 1024 * 1024;
  const ownedStreamURLs = new Set();
  const MAX_STREAM_ELEMENTS = 4;
  const STREAM_PRIME_TIMEOUT_MS = 5000; // Optional audio must not hold JVM startup indefinitely.
  const streamElements = [];
  let streamPoolExhaustions = 0, streamPrimeFailures = 0;
  let decodeAudioDataCalls = 0;
  let streamRequests = 0, streamStarts = 0, streamFailures = 0, streamLateDiscards = 0;

  function ensureContext() {
    if (disposed) throw new Error("The audio runtime has shut down");
    if (!ctx) {
      ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      masterGain = ctx.createGain();
      // Headroom. Web Audio sums sources and then hard-clips at full scale, and
      // Minecraft plays many at once — a bell (volume 1.0, close range) landing
      // on top of footsteps and block breaks was reported as ear-piercing and
      // audibly cutting out, which is that clip, not the sample.
      masterGain.gain.value = masterVolume * MASTER_HEADROOM;
      // A limiter behind the headroom, so a loud stack is compressed rather than
      // clipped. Fast attack catches transients (a bell, an anvil); the slower
      // release stops it pumping on continuous sound like rain.
      masterLimiter = ctx.createDynamicsCompressor();
      masterLimiter.threshold.value = -6;
      masterLimiter.knee.value = 0;
      masterLimiter.ratio.value = 20;
      masterLimiter.attack.value = 0.002;
      masterLimiter.release.value = 0.15;
      masterGain.connect(masterLimiter);
      masterLimiter.connect(ctx.destination);
      applyListenerPose();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function categoryGain(source) {
    ensureContext();
    let gain = categoryGains.get(source);
    if (!gain) {
      gain = ctx.createGain();
      gain.gain.value = categoryVolumes.get(source) ?? 1.0;
      gain.connect(masterGain);
      categoryGains.set(source, gain);
    }
    return gain;
  }

  function loadDefinitions() {
    if (disposed) return Promise.resolve({});
    if (definitionsPromise) return definitionsPromise;
    definitionsPromise = fetch(`/${ROOT}/minecraft/sounds.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`sounds.json ${response.status}`);
        return response.json();
      })
      .then((json) => {
        if (disposed) return {};
        soundDefinitions = json;
        missing.delete("sounds.json");
        console.log(`[mcweb-audio] sounds.json: ${Object.keys(json).length} events`);
        return json;
      })
      .catch((error) => {
        if (disposed) return {};
        // A transient failure must not disable all later sound events.
        if (!missing.has("sounds.json")) {
          missing.add("sounds.json");
          console.warn("[mcweb-audio] could not load sounds.json; next playback will retry", error);
        }
        definitionsPromise = null;
        return {};
      });
    return definitionsPromise;
  }

  function shortName(identifier) {
    const index = identifier.indexOf(NAMESPACE_SEPARATOR);
    return index < 0 ? identifier : identifier.slice(index + 1);
  }

  function namespaceOf(identifier) {
    const index = identifier.indexOf(NAMESPACE_SEPARATOR);
    return index < 0 ? "minecraft" : identifier.slice(0, index);
  }

  // sounds.json entries hold a weighted list; each element is either a bare
  // path or {name, volume, pitch, weight, type, stream}. type "event" redirects to
  // another event, which is how the music and several block groups are wired.
  function resolve(eventId, depth = 0) {
    if (!soundDefinitions || depth > 4) return null;
    const definition = soundDefinitions[shortName(eventId)];
    if (!definition || !Array.isArray(definition.sounds) || definition.sounds.length === 0) {
      return null;
    }

    const entries = definition.sounds.map((entry) =>
      typeof entry === "string" ? {name: entry} : entry
    );
    const total = entries.reduce((sum, entry) => sum + (entry.weight ?? 1), 0);
    let roll = Math.random() * total;
    let chosen = entries[entries.length - 1];
    for (const entry of entries) {
      roll -= entry.weight ?? 1;
      if (roll <= 0) {
        chosen = entry;
        break;
      }
    }

    if (chosen.type === "event") {
      return resolve(chosen.name, depth + 1);
    }

    return {
      url: `/${ROOT}/${namespaceOf(chosen.name)}/sounds/${shortName(chosen.name)}.ogg`,
      volume: chosen.volume ?? 1.0,
      pitch: chosen.pitch ?? 1.0,
      attenuationDistance: chosen.attenuation_distance ?? 16,
      stream: chosen.stream === true
    };
  }

  // ?mcweb_audio_direct: never read sound bytes, always play from Mojang.
  const directOnly = new URLSearchParams(location.search).has("mcweb_audio_direct");
  let directStarts = 0;

  function decode(url) {
    if (directOnly || disposed) return Promise.resolve(null);
    let pending = buffers.get(url);
    if (pending) return pending;
    pending = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => {
        if (disposed) return null;
        decodeAudioDataCalls++;
        return ensureContext().decodeAudioData(bytes);
      })
      .then((buffer) => {
        if (disposed) return null;
        decodedUrls.add(url);
        missing.delete(url);
        return buffer;
      })
      .catch((error) => {
        // Share in-flight work and successful buffers, but let the next play
        // retry a failed fetch/decode instead of caching permanent silence.
        if (buffers.get(url) === pending) buffers.delete(url);
        if (disposed) return null;
        if (!missing.has(url)) {
          missing.add(url);
          console.warn("[mcweb-audio] missing", url, String(error));
        }
        return null;
      });
    buffers.set(url, pending);
    return pending;
  }

  /**
   * Resolves one event before the game loop starts. Streamed selections retain
   * only their metadata; ordinary sounds retain their existing decoded buffer.
   *
   * Chromium may spend a long main-thread slice entering/completing
   * decodeAudioData for menu music. The app shell awaits this one preparation
   * before loading WebGPU/Wasm, so the same selected sound is ready when
   * Minecraft asks for it and no live frame pays that first-decode cost.
   */
  async function preloadEvent(name) {
    if (!enabled || preparedEvents.has(name)) return null;
    await loadDefinitions();
    if (disposed) return null;
    const resolved = resolve(name);
    if (!resolved) return null;
    if (resolved.stream) {
      preparedEvents.set(name, { resolved });
      return resolved.url;
    }
    const buffer = await decode(resolved.url);
    if (!buffer || disposed) return null;
    preparedEvents.set(name, { resolved, buffer });
    return resolved.url;
  }

  function playInstance(name, source, volume, pitch, looping) {
    if (!enabled || disposed) return 0;
    const handle = nextHandle++;
    const entry = {
      handle,
      source: source || "master",
      volume,
      pitch,
      looping: !!looping,
      node: null,
      gain: null,
      panner: null,
      finished: false,
      startedAt: (ctx && ctx.currentTime) || 0
    };
    live.set(handle, entry);

    loadDefinitions()
      .then(() => {
        if (entry.finished || entry.stopRequested) return null;
        const prepared = preparedEvents.get(name);
        if (prepared) {
          preparedEvents.delete(name);
          entry.resolved = prepared.resolved;
          if (entry.resolved.stream && !directOnly) { entry.streamed = true; return null; }
          return prepared.buffer;
        }
        const resolved = resolve(name);
        if (!resolved) {
          entry.finished = true;
          if (!missing.has(name)) {
            missing.add(name);
            console.warn("[mcweb-audio] unresolved event", name);
          }
          return null;
        }
        entry.resolved = resolved;
        missing.delete(name);
        if (resolved.stream && !directOnly) { entry.streamed = true; return null; }
        return decode(resolved.url);
      })
      .then(async (buffer) => {
        if (entry.finished || entry.stopRequested) {
          entry.finished = true;
          return;
        }
        if (entry.streamed) {
          await startStream(entry);
          return;
        }
        if (buffer) {
          start(entry, buffer);
          return;
        }
        // No bytes (Mojang's asset host lets no page read them): play the
        // file itself from Mojang with an <audio> element instead.
        const url = entry.resolved && await directUrl(entry.resolved.url);
        if (!url || entry.finished || entry.stopRequested) {
          entry.finished = true;
          return;
        }
        startElement(entry, url);
      })
      .catch((error) => {
        stopInstance(handle);
        const asset = entry.resolved?.url || name;
        if (!missing.has(asset)) {
          missing.add(asset);
          console.warn("[mcweb-audio] could not start", asset, String(error));
        }
      });

    playCount++;
    return handle;
  }

  function start(entry, buffer) {
    const ac = ensureContext();
    const node = ac.createBufferSource();
    entry.node = node;
    node.buffer = buffer;
    node.loop = !!entry.looping;
    node.playbackRate.value = Math.max(0.05, entry.pitch * (entry.resolved.pitch ?? 1.0));
    connectSource(entry, node);
    node.onended = () => finishBuffer(entry);
    node.start();
  }

  function finishBuffer(entry) {
    entry.finished = true;
    for (const node of [entry.node, entry.gain, entry.panner]) {
      try { node?.disconnect(); } catch {}
    }
    entry.node = entry.gain = entry.panner = null;
    if (live.get(entry.handle) === entry) live.delete(entry.handle);
  }

  function connectSource(entry, node) {
    const ac = ensureContext();
    const gain = ac.createGain();
    entry.gain = gain;
    gain.gain.value = Math.max(0, entry.volume) * (entry.resolved.volume ?? 1.0);

    let tail = gain;
    if (entry.position) {
      const panner = createPanner(entry);
      gain.connect(panner);
      tail = panner;
    }

    tail.connect(categoryGain(entry.source));
    node.connect(gain);
  }

  function createPanner(entry) {
    const panner = ensureContext().createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "linear";
    // Minecraft's own rolloff: audible to 16 blocks for a unit-volume sound.
    panner.refDistance = 0;
    panner.maxDistance = soundRange(entry);
    panner.positionX.value = entry.position.x;
    panner.positionY.value = entry.position.y;
    panner.positionZ.value = entry.position.z;
    entry.panner = panner;
    return panner;
  }

  const streamCurrent = (entry) => live.get(entry.handle) === entry && !entry.finished && !entry.stopRequested;

  function newStreamElement() {
    const slot = { id: streamElements.length + 1, element: new Audio(), node: null, entry: null, priming: null, primeAttempt: null, primeTimer: null, primeURL: null, primeState: 'unprepared' };
    streamElements.push(slot); // Creation failures also consume a bounded slot.
    try { slot.node = ensureContext().createMediaElementSource(slot.element); }
    catch (error) { slot.primeState = 'failed'; throw error; }
    return slot;
  }

  function clearStreamElement(slot) {
    const element = slot.element;
    element.onended = element.onerror = null;
    try { element.pause(); } catch {}
    element.removeAttribute('src');
    try { element.load(); } catch {}
    try { slot.node?.disconnect(); } catch {}
  }

  function reserveStreamElement(entry) {
    const idle = streamElements.filter(slot => slot.node && !slot.entry);
    const slot = idle.find(slot => slot.primeState === 'ready') || idle[0]
      || (streamElements.length < MAX_STREAM_ELEMENTS ? newStreamElement() : null);
    if (!slot) {
      streamPoolExhaustions++;
      throw new Error('All four streaming audio elements are busy or unavailable');
    }
    slot.entry = entry;
    entry.streamSlot = slot;
    return slot;
  }

  function silentPrimeBlob() {
    // Original 100 ms mono 8 kHz PCM WAV, containing only zero-valued samples.
    // This is a tiny unmuted audio source, not a decoded/cached music buffer.
    const bytes = new Uint8Array(44 + 1600), view = new DataView(bytes.buffer);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
    text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, 1600, true);
    return new Blob([bytes], { type: 'audio/wav' });
  }

  function prepareStreaming() {
    if (!enabled) return Promise.resolve({ disabled: true, ready: 0, limit: MAX_STREAM_ELEMENTS, errors: [] });
    if (streamElements.length === MAX_STREAM_ELEMENTS && streamElements.every(s => s.primeState === 'ready' && !s.priming))
      return Promise.resolve({ disabled: false, ready: MAX_STREAM_ELEMENTS, limit: MAX_STREAM_ELEMENTS, errors: [] });
    const needsGesture = streamElements.length < MAX_STREAM_ELEMENTS
      || streamElements.some(s => !s.entry && !s.priming && s.primeState !== 'ready');
    if (needsGesture && globalThis.navigator?.userActivation?.isActive === false)
      return Promise.resolve({ disabled: false, ready: streamElements.filter(s => s.primeState === 'ready').length, limit: MAX_STREAM_ELEMENTS, errors: ['Streaming preparation requires an active user gesture'] });
    const attempts = [], errors = [];
    try { ensureContext(); } catch (error) {
      streamPrimeFailures++;
      return Promise.resolve({ disabled: false, ready: 0, limit: MAX_STREAM_ELEMENTS, errors: [String(error).slice(0, 350)] });
    }
    // Every native play() below runs synchronously in the caller's gesture.
    // Only completion/cleanup is deferred; no fetch or await precedes play().
    for (let i = 0; i < MAX_STREAM_ELEMENTS; i++) {
      let slot = streamElements[i];
      try {
        slot ||= newStreamElement();
        if (!slot.node) throw new Error('Streaming media source is unavailable');
        if (slot.priming) { attempts.push(slot.priming); continue; }
        if (slot.entry || slot.primeState === 'ready') continue;
        slot.primeState = 'pending';
        const element = slot.element;
        element.muted = false; element.volume = 1; element.loop = false;
        element.playsInline = true; element.defaultPlaybackRate = element.playbackRate = 1;
        slot.node.connect(masterGain);
        slot.primeURL = URL.createObjectURL(silentPrimeBlob());
        element.src = slot.primeURL;
        const playing = element.play();
        const attempt = slot.primeAttempt = {};
        let timer;
        // The native promise has no side effects on settlement. Once the race
        // times out, its late fulfillment/rejection cannot affect a new lease.
        const outcome = Promise.resolve(playing).then(() => null, error => String(error).slice(0, 350));
        const deadline = new Promise(resolve => {
          attempt.cancel = () => resolve('Audio runtime shut down');
          slot.primeTimer = timer = setTimeout(() => resolve('Streaming preparation timed out after 5000 ms'), STREAM_PRIME_TIMEOUT_MS);
        });
        slot.priming = Promise.race([outcome, deadline]).then(error => {
          if (slot.primeAttempt !== attempt) return 'Streaming preparation was superseded';
          if (error) { slot.primeState = 'failed'; streamPrimeFailures++; return error; }
          slot.primeState = 'ready'; return null;
        }).finally(() => {
          clearTimeout(timer);
          if (slot.primeTimer === timer) slot.primeTimer = null;
          if (slot.primeAttempt !== attempt) return;
          clearStreamElement(slot);
          if (slot.primeURL) URL.revokeObjectURL(slot.primeURL);
          slot.primeURL = null; slot.priming = slot.primeAttempt = null;
        });
        attempts.push(slot.priming);
      } catch (error) {
        streamPrimeFailures++; errors.push(String(error).slice(0, 350));
        if (slot) {
          slot.primeState = 'failed'; clearStreamElement(slot);
          if (slot.primeURL) URL.revokeObjectURL(slot.primeURL);
          slot.primeURL = null;
        }
      }
    }
    return Promise.all(attempts).then(results => ({ disabled: false, ready: streamElements.filter(s => s.primeState === 'ready').length,
      limit: MAX_STREAM_ELEMENTS, errors: errors.concat(results.filter(result => typeof result === 'string')) }));
  }

  function finishStream(entry) {
    if (entry.streamCleaned) return;
    entry.streamCleaned = true;
    entry.finished = true;
    if (entry.streamReader) {
      try { Promise.resolve(entry.streamReader.cancel()).catch(() => {}); } catch {}
      entry.streamReader = null;
    }
    const slot = entry.streamSlot;
    if (slot?.entry === entry) {
      // A cancelled wait must not stop the slot's in-flight gesture priming.
      if (!slot.priming) clearStreamElement(slot);
      slot.entry = null;
    }
    entry.element = entry.streamSlot = null;
    for (const node of [entry.gain, entry.panner]) {
      try { node?.disconnect(); } catch {}
    }
    entry.mediaSource = entry.gain = entry.panner = null;
    if (entry.streamURL) {
      URL.revokeObjectURL(entry.streamURL);
      ownedStreamURLs.delete(entry.streamURL);
      entry.streamURL = null;
    }
    entry.encodedBytes = 0;
    if (live.get(entry.handle) === entry) live.delete(entry.handle);
  }

  function failStream(entry, error) {
    if (streamCurrent(entry)) {
      streamFailures++;
      if (!missing.has(entry.resolved.url)) {
        missing.add(entry.resolved.url);
        console.warn('[mcweb-audio] stream failed', entry.resolved.url, String(error));
      }
    }
    finishStream(entry);
  }

  async function streamBlob(entry) {
    const url = new URL(entry.resolved.url, location.href);
    const receiver = globalThis.mcWebUpstream?.installed;
    if (url.origin !== location.origin || !url.pathname.startsWith('/' + ROOT + '/') || typeof receiver?.fetch !== 'function')
      throw new Error('Streaming requires the verified same-origin asset receiver');
    streamRequests++;
    const response = await receiver.fetch(url.href);
    if (!streamCurrent(entry)) {
      streamLateDiscards++;
      try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
      return null;
    }
    if (!response.ok || !response.body?.getReader) {
      try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
      throw new Error('Streaming asset response is unavailable');
    }
    const length = response.headers.get('Content-Length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_STREAM_ENCODED_BYTES)) {
      try { Promise.resolve(response.body.cancel()).catch(() => {}); } catch {}
      throw new Error('Streaming encoded asset exceeds its byte bound');
    }
    const reader = response.body.getReader();
    entry.streamReader = reader;
    const chunks = [];
    let size = 0, done = false;
    try {
      for (;;) {
        const part = await reader.read();
        if (!streamCurrent(entry)) { streamLateDiscards++; return null; }
        if (part.done) { done = true; break; }
        if (!(part.value instanceof Uint8Array) || part.value.byteLength > MAX_STREAM_ENCODED_BYTES - size)
          throw new Error('Streaming encoded asset exceeds its byte bound');
        size += part.value.byteLength;
        chunks.push(part.value);
      }
      if (!size || (length !== null && size !== Number(length))) throw new Error('Streaming encoded asset length mismatch');
      entry.encodedBytes = size;
      return new Blob(chunks, { type: 'audio/ogg' });
    } finally {
      if (!done && entry.streamReader === reader) { try { await reader.cancel(); } catch {} }
      try { reader.releaseLock(); } catch {}
      if (entry.streamReader === reader) entry.streamReader = null;
    }
  }

  async function startStream(entry) {
    try {
      const slot = reserveStreamElement(entry);
      if (slot.priming) await slot.priming;
      if (!streamCurrent(entry)) return;
      if (slot.primeState === 'failed') throw new Error('Streaming preparation failed; another trusted gesture is required');
      let blob = await streamBlob(entry);
      if (!blob || !streamCurrent(entry)) return;
      if (blob.size > MAX_STREAM_ENCODED_BYTES) throw new Error('Streaming encoded asset exceeds its byte bound');
      entry.streamURL = URL.createObjectURL(blob);
      blob = null; // The object URL owns the encoded bytes until finishStream.
      ownedStreamURLs.add(entry.streamURL);
      const element = entry.element = slot.element;
      element.preload = 'metadata';
      element.preservesPitch = false;
      element.loop = entry.looping;
      // Loading src resets playbackRate to defaultPlaybackRate.
      element.defaultPlaybackRate = Math.min(16, Math.max(0.0625, entry.pitch * (entry.resolved.pitch ?? 1.0)));
      element.playbackRate = element.defaultPlaybackRate;
      element.volume = 1;
      entry.mediaSource = slot.node;
      connectSource(entry, entry.mediaSource);
      element.onended = () => finishStream(entry);
      element.onerror = () => failStream(entry, new Error('Media element error'));
      element.src = entry.streamURL;
      await element.play();
      if (streamCurrent(entry)) { slot.primeState = 'ready'; streamStarts++; }
    } catch (error) {
      if (error?.name === 'NotAllowedError' && entry.streamSlot?.entry === entry) entry.streamSlot.primeState = 'failed';
      failStream(entry, error);
    }
  }

  // ---- direct playback --------------------------------------------------
  // Mojang serves Minecraft's sounds only from resources.download.minecraft.net,
  // which sends no CORS headers: a page cannot read the bytes, so WebAudio
  // cannot have them. An <audio> element can still play them (the page's
  // embedder policy is credentialless, so no Cross-Origin-Resource-Policy is
  // needed). What WebAudio added is approximated: volume, category and master
  // gain multiply into element.volume; pitch is playbackRate without pitch
  // preservation (as OpenAL's pitch, Minecraft's); distance is Minecraft's
  // own linear rolloff, recomputed when the sound or the listener moves. There
  // is no left/right panning: a cross-origin element routed into WebAudio
  // without CORS plays silence.
  async function directUrl(resolvedUrl) {
    const upstream = globalThis.mcWebUpstream && globalThis.mcWebUpstream.installed;
    if (!upstream || typeof upstream.assetDirectUrl !== "function") return null;
    const prefix = "/" + ROOT + "/";
    if (!resolvedUrl.startsWith(prefix)) return null;
    return upstream.assetDirectUrl(decodeURIComponent(resolvedUrl.slice(prefix.length)));
  }

  function elementVolume(entry) {
    let volume = Math.max(0, entry.volume) * (entry.resolved.volume ?? 1.0)
      * categoryGain(entry.source).gain.value
      * (masterGain ? masterGain.gain.value : MASTER_HEADROOM);
    if (entry.position) {
      const range = soundRange(entry);
      const d = Math.hypot(entry.position.x - listener.x, entry.position.y - listener.y,
        entry.position.z - listener.z);
      volume *= Math.max(0, 1 - d / range);
    }
    return Math.max(0, Math.min(1, volume));
  }

  function soundRange(entry) {
    return (entry.resolved.attenuationDistance ?? 16)
      * Math.max(1, entry.volume * (entry.resolved.volume ?? 1.0));
  }

  function startElement(entry, url) {
    const element = new Audio();
    element.preload = "auto";
    element.preservesPitch = false;
    element.loop = !!entry.looping;
    element.playbackRate = Math.min(16, Math.max(0.0625, entry.pitch * (entry.resolved.pitch ?? 1.0)));
    element.volume = elementVolume(entry);
    element.onended = () => { entry.finished = true; };
    element.onerror = () => {
      entry.finished = true;
      if (!missing.has(url)) {
        missing.add(url);
        console.warn("[mcweb-audio] could not play", url);
      }
    };
    element.src = url;
    entry.element = element;
    if (++directStarts <= 3) console.log("[mcweb-audio] playing from Mojang:", url);
    element.play().catch(() => { entry.finished = true; });
  }

  function refreshElements() {
    for (const entry of live.values()) {
      if (entry.element && !entry.mediaSource) entry.element.volume = elementVolume(entry);
    }
  }

  function positionInstance(handle, x, y, z) {
    const entry = live.get(handle);
    if (!entry) return;
    entry.position = {x, y, z};
    if (entry.element && !entry.mediaSource) entry.element.volume = elementVolume(entry);
    // Cached buffers can start before the JVM's separate position RPC arrives.
    if (entry.gain && !entry.panner) {
      const panner = createPanner(entry);
      entry.gain.disconnect();
      entry.gain.connect(panner);
      panner.connect(categoryGain(entry.source));
    }
    if (entry.panner) {
      entry.panner.positionX.value = x;
      entry.panner.positionY.value = y;
      entry.panner.positionZ.value = z;
    }
  }

  function setListener(x, y, z) {
    setListenerPose(x, y, z, listener.forwardX, listener.forwardY, listener.forwardZ,
      listener.upX, listener.upY, listener.upZ);
  }

  function setListenerPose(x, y, z, forwardX, forwardY, forwardZ, upX, upY, upZ) {
    if (![x, y, z, forwardX, forwardY, forwardZ, upX, upY, upZ].every(Number.isFinite))
      throw new TypeError("Listener pose must contain finite coordinates");
    listener.x = x;
    listener.y = y;
    listener.z = z;
    listener.forwardX = forwardX;
    listener.forwardY = forwardY;
    listener.forwardZ = forwardZ;
    listener.upX = upX;
    listener.upY = upY;
    listener.upZ = upZ;
    refreshElements();
    applyListenerPose();
  }

  function applyListenerPose() {
    if (!ctx) return;
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = listener.x;
      l.positionY.value = listener.y;
      l.positionZ.value = listener.z;
    } else if (l.setPosition) {
      l.setPosition(listener.x, listener.y, listener.z);
    }
    if (l.forwardX) {
      l.forwardX.value = listener.forwardX;
      l.forwardY.value = listener.forwardY;
      l.forwardZ.value = listener.forwardZ;
      l.upX.value = listener.upX;
      l.upY.value = listener.upY;
      l.upZ.value = listener.upZ;
    } else if (l.setOrientation) {
      l.setOrientation(listener.forwardX, listener.forwardY, listener.forwardZ,
        listener.upX, listener.upY, listener.upZ);
    }
  }

  // True while decoding as well as while sounding: MusicManager treats a
  // false answer as "the track ended" and immediately starts another.
  function isPlaying(handle) {
    const entry = live.get(handle);
    if (!entry) return false;
    if (entry.finished) {
      live.delete(handle);
      return false;
    }
    return true;
  }

  function stopInstance(handle) {
    const entry = live.get(handle);
    if (!entry) return;
    entry.stopRequested = true;
    if (entry.streamed) { finishStream(entry); return; }
    entry.finished = true;
    if (entry.node) {
      try {
        entry.node.stop();
      } catch (e) { /* already stopped */ }
    }
    finishBuffer(entry);
    if (entry.element) {
      entry.element.pause();
      entry.element.removeAttribute("src");
    }
    live.delete(handle);
  }

  function stopAll() {
    for (const handle of Array.from(live.keys())) stopInstance(handle);
  }

  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    disposalState = "closing";
    enabled = false;
    for (const entry of live.values()) {
      stopInstance(entry.handle);
      entry.node?.disconnect();
      entry.gain?.disconnect();
      entry.panner?.disconnect();
      if (entry.element) {
        entry.element.onended = entry.element.onerror = null;
        entry.element.load();
      }
      entry.node = entry.gain = entry.panner = entry.element = null;
    }
    for (const slot of streamElements) {
      slot.primeAttempt?.cancel();
      clearTimeout(slot.primeTimer);
      slot.primeTimer = slot.primeAttempt = slot.priming = null;
      clearStreamElement(slot);
      if (slot.primeURL) URL.revokeObjectURL(slot.primeURL);
      slot.primeURL = null;
      slot.node = slot.entry = null;
    }
    streamElements.length = 0;
    for (const url of ownedStreamURLs) URL.revokeObjectURL(url);
    ownedStreamURLs.clear();
    for (const gain of categoryGains.values()) gain.disconnect();
    categoryGains.clear();
    categoryVolumes.clear();
    masterGain?.disconnect();
    masterLimiter?.disconnect();
    masterGain = masterLimiter = null;
    buffers.clear();
    decodedUrls.clear();
    preparedEvents.clear();
    missing.clear();
    soundDefinitions = definitionsPromise = null;
    const closing = ctx;
    ctx = null;
    let close;
    try { close = closing && closing.state !== "closed" ? closing.close() : Promise.resolve(); }
    catch (error) { close = Promise.reject(error); }
    disposal = close.then(() => { disposalState = "closed"; }, error => {
      disposalState = "close-failed";
      throw error;
    });
    return disposal;
  }

  function setCategoryVolume(source, volume) {
    if (!source || source === "master") {
      setVolume(volume);
      return;
    }
    const value = Math.max(0, Math.min(1, volume));
    categoryVolumes.set(source, value);
    const gain = categoryGains.get(source);
    if (gain) gain.gain.value = value;
    refreshElements();
  }

  function setVolume(v) {
    masterVolume = Math.max(0, Math.min(1, v));
    // Scales the headroom rather than overwriting it: assigning the slider value
    // straight in would push the bus back to unity and reintroduce the clipping.
    if (masterGain) {
      masterGain.gain.value = masterVolume * MASTER_HEADROOM;
    }
    refreshElements();
  }

  function setEnabled(e) {
    enabled = e && !disposed;
    if (!enabled) stopAll();
  }

  function isEnabled() { return enabled; }
  function state() { return disposed ? disposalState : ctx ? ctx.state : "uninitialized"; }
  function count() { return playCount; }
  function liveCount() { return live.size; }
  function resolvedCount() { return soundDefinitions ? Object.keys(soundDefinitions).length : 0; }

  // Argument-shape probes for the Java @JS bridge self-test. Each simply
  // echoes, so a wrong answer or a Java-side throw isolates the shape.
  function probe0() { return 1; }
  function probe1(name) { probeLog.push("probe1:" + name); }
  function probe2(name) { probeLog.push("probe2:" + name); return 2; }
  function probe3(name, volume) { probeLog.push("probe3:" + name + ":" + volume); return 3; }
  function probe4(name, source, volume, pitch, looping) {
    probeLog.push(`probe4:${name}:${source}:${volume}:${pitch}:${looping}`);
    return 4;
  }

  function diagnostics() {
    let sounding = 0;
    let direct = 0;
    for (const entry of live.values()) {
      if (entry.node) sounding++;
      if (entry.element && !entry.element.paused) { sounding++; if (!entry.mediaSource) direct++; }
    }
    const decodedBuffers = decodedUrls.size;
    return {
      events: resolvedCount(),
      plays: playCount,
      live: live.size,
      sounding,
      direct,
      requested: buffers.size,
      decodedBuffers,
      decodeAudioDataCalls,
      streaming: {
        activeHandles: [...live.values()].filter(entry => entry.streamed).map(entry => ({
          handle: entry.handle, asset: entry.resolved.url, encodedBytes: entry.encodedBytes || 0,
          sounding: !!entry.element && !entry.element.paused, graphConnected: !!entry.mediaSource,
          slotId: entry.streamSlot?.id || null, currentTime: entry.element?.currentTime ?? null,
        })),
        ownedObjectURLs: ownedStreamURLs.size,
        maxEncodedBytes: MAX_STREAM_ENCODED_BYTES,
        pool: { limit: MAX_STREAM_ELEMENTS, primeTimeoutMs: STREAM_PRIME_TIMEOUT_MS, elements: streamElements.length,
          busy: streamElements.filter(s => s.entry).length, ready: streamElements.filter(s => s.primeState === 'ready').length,
          priming: streamElements.filter(s => s.priming).length, primeObjectURLs: streamElements.filter(s => s.primeURL).length,
          primeFailures: streamPrimeFailures, exhaustions: streamPoolExhaustions,
          slots: streamElements.map(s => ({ id: s.id, handle: s.entry?.handle || null, state: s.primeState,
            hasSource: !!s.node, priming: !!s.priming, ownsPrimeURL: !!s.primeURL })) },
        requests: streamRequests, starts: streamStarts, failures: streamFailures, lateDiscards: streamLateDiscards,
      },
      preparedEvents: preparedEvents.size,
      missing: Array.from(missing),
      probeLog,
      contextState: state()
    };
  }

  const api = {
    playInstance, positionInstance, isPlaying, stopInstance, stopAll, dispose,
    setCategoryVolume, setListener, setListenerPose, setVolume, setEnabled, isEnabled,
    state, count, liveCount, resolvedCount, diagnostics, ensureContext, loadDefinitions,
    preloadEvent, prepareStreaming,
    probe0, probe1, probe2, probe3, probe4
  };
  globalThis[HOST_KEY] = api;
  // A discarded runtime must not create another AudioContext on a later tap.
  document.addEventListener("pointerdown", () => {
    if (!disposed) ensureContext();
  }, { once: true });
  return api;
})();
