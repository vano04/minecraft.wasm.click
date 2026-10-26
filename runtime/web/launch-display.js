// Launch framebuffer for the play page.
//
// The OffscreenCanvas handed to the GPU Worker keeps the size it had when it
// was transferred, and the Worker's page shim reports that size as its layout
// box at devicePixelRatio 1 (OpenJDK/browser/worker-env.js). So the size picked
// here, before Play, is the framebuffer the host configures and the size
// Minecraft reads through its window: it is not a CSS scale. Later window and
// fullscreen changes only scale that surface on the page.
//
// The default is the display-pixel 16:9 fit of the viewport (the 26.3 release's
// resolution follow-up), with no devicePixelRatio cap. A scale below 100% and
// the old fixed 1280x720 / 640x360 launch exist only to compare cost against
// native size; the page always prints the exact size it launched with.
globalThis.mcWebLaunchDisplay = (() => {
  const STORAGE_KEY = 'mcweb.launchDisplay';
  const BASES = {
    viewport: 'Viewport, display pixels',
    screen: 'Full screen landscape, display pixels',
    legacy: 'Fixed 1280x720 (640x360 on iPhone/iPad)',
    custom: 'Custom',
  };
  const SCALES = [1, 0.75, 0.5, 0.25];
  const MIN_SCALE = 0.25, MAX_SCALE = 1;
  const MIN_DIMENSION = 64, MAX_DIMENSION = 8192;

  function validDimension(value) {
    const dimension = Number(value);
    return Number.isInteger(dimension) && dimension >= MIN_DIMENSION && dimension <= MAX_DIMENSION
      ? dimension : null;
  }

  /** The largest whole 16:9 multiple that fits width x height device pixels. */
  function canvasSize(width, height, pixelRatio = 1) {
    const scale = Math.max(1, Math.floor(Math.min(width * pixelRatio / 16, height * pixelRatio / 9)));
    return [scale * 16, scale * 9];
  }

  function validScale(value) {
    const scale = Number(value);
    return Number.isFinite(scale) && scale >= MIN_SCALE && scale <= MAX_SCALE ? scale : null;
  }

  /** The launch size for a selection, from the current window and screen. */
  function resolve({ basis, scale, width, height }, ios, view = globalThis) {
    const ratio = view.devicePixelRatio || 1;
    if (basis === 'custom') {
      if (validDimension(width) === null || validDimension(height) === null)
        throw new RangeError('Enter whole-number dimensions from ' + MIN_DIMENSION + ' to ' + MAX_DIMENSION + ' pixels.');
      return { basis, scale: null, pixelRatio: ratio, width: Number(width), height: Number(height) };
    }
    if (basis === 'legacy') {
      const [fixedWidth, fixedHeight] = ios ? [640, 360] : [1280, 720];
      return { basis, scale: null, pixelRatio: ratio, width: fixedWidth, height: fixedHeight };
    }
    let cssWidth = view.innerWidth, cssHeight = view.innerHeight;
    if (basis === 'screen') {
      // screen.width/height follow the device's natural orientation on
      // iPadOS; the game is landscape, so take the long side as the width.
      cssWidth = Math.max(view.screen.width, view.screen.height);
      cssHeight = Math.min(view.screen.width, view.screen.height);
    }
    const [resolvedWidth, resolvedHeight] = canvasSize(cssWidth, cssHeight, ratio * scale);
    return { basis, scale, pixelRatio: ratio, cssWidth, cssHeight, width: resolvedWidth, height: resolvedHeight };
  }

  function describe(size) {
    const pixels = (size.width * size.height / 1e6).toFixed(2);
    const detail = size.basis === 'legacy' || size.basis === 'custom'
      ? (size.basis === 'custom' ? 'custom launch size' : 'fixed launch size')
      : Math.round(size.scale * 100) + '% of ' + size.cssWidth + 'x' + size.cssHeight
        + ' CSS px at devicePixelRatio ' + size.pixelRatio;
    return size.width + 'x' + size.height + ' (' + pixels + ' MP, ' + detail + ')';
  }

  /**
   * Builds the resolution controls in container. Selection order: the query
 * (?mcweb_resolution=viewport|screen|legacy|custom, ?mcweb_resolution_scale=0.25..1),
   * then the last choice saved in this browser, then the native viewport.
   */
  function mount({ container, query, ios, write = () => {} }) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { saved = {}; }
    const notes = [];
    let basis = Object.hasOwn(BASES, saved.basis) ? saved.basis : 'viewport';
    let scale = validScale(saved.scale) ?? 1;
    if (query.has('mcweb_resolution')) {
      const requested = query.get('mcweb_resolution');
      if (Object.hasOwn(BASES, requested)) basis = requested;
      else notes.push('ignored ?mcweb_resolution=' + requested);
    }
    if (query.has('mcweb_resolution_scale')) {
      const requested = validScale(query.get('mcweb_resolution_scale'));
      if (requested !== null) scale = requested;
      else notes.push('ignored ?mcweb_resolution_scale=' + query.get('mcweb_resolution_scale')
        + ' (allowed ' + MIN_SCALE + '..' + MAX_SCALE + ')');
    }

    const label = document.createElement('div');
    label.className = 'launch-option';
    const resolutionLabel = document.createElement('label');
    resolutionLabel.htmlFor = 'launch-resolution';
    resolutionLabel.textContent = 'Resolution';
    const basisSelect = document.createElement('select');
    basisSelect.id = 'launch-resolution';
    for (const [value, text] of Object.entries(BASES)) basisSelect.add(new Option(text, value));
    const scaleSelect = document.createElement('select');
    scaleSelect.id = 'launch-resolution-scale';
    scaleSelect.title = 'Fraction of display pixels, for comparison only';
    const scales = SCALES.includes(scale) ? SCALES : [...SCALES, scale].sort((a, b) => b - a);
    for (const value of scales) scaleSelect.add(new Option(Math.round(value * 100) + '%', String(value)));
    basisSelect.value = basis;
    scaleSelect.value = String(scale);
    const custom = document.createElement('div');
    custom.className = 'launch-custom-resolution';
    const dimensions = ['width', 'height'].map(name => {
      const fieldLabel = document.createElement('label');
      fieldLabel.htmlFor = 'launch-resolution-' + name;
      fieldLabel.textContent = name === 'width' ? 'Width' : 'Height';
      const input = document.createElement('input');
      input.id = fieldLabel.htmlFor;
      input.type = 'number';
      input.inputMode = 'numeric';
      input.min = String(MIN_DIMENSION);
      input.max = String(MAX_DIMENSION);
      input.step = '1';
      input.required = true;
      input.value = String(validDimension(saved[name]) ?? (name === 'width' ? 1280 : 720));
      custom.append(fieldLabel, input);
      return input;
    });
    const output = document.createElement('output');
    output.id = 'launch-resolution-size';
    output.className = 'sub';
    output.setAttribute('aria-live', 'polite');
    label.append(resolutionLabel, basisSelect, scaleSelect, custom, output);
    container.append(label);

    let locked = null;
    const selection = () => ({ basis: basisSelect.value, scale: Number(scaleSelect.value),
      width: Number(dimensions[0].value), height: Number(dimensions[1].value) });
    const validate = () => basisSelect.value !== 'custom'
      || dimensions.every(input => validDimension(input.value) !== null);
    const render = () => {
      custom.hidden = basisSelect.value !== 'custom';
      for (const input of dimensions) input.disabled = Boolean(locked) || custom.hidden;
      scaleSelect.hidden = basisSelect.value === 'custom';
      scaleSelect.disabled = Boolean(locked) || ['legacy', 'custom'].includes(basisSelect.value);
      if (!validate()) {
        output.value = 'Enter whole-number width and height from ' + MIN_DIMENSION + ' to ' + MAX_DIMENSION + ' pixels.';
        return;
      }
      const size = locked || resolve(selection(), ios);
      output.value = (locked ? 'launched at ' : '') + describe(size)
        + (notes.length ? ' - ' + notes.join('; ') : '');
    };
    const save = () => {
      if (validate()) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(selection())); } catch { /* private mode */ }
      }
      render();
    };
    basisSelect.addEventListener('change', save);
    scaleSelect.addEventListener('change', save);
    for (const input of dimensions) input.addEventListener('input', save);
    addEventListener('resize', render);
    globalThis.visualViewport?.addEventListener('resize', render);
    render();

    return {
      validate,
      reportValidity() { for (const input of dimensions) if (!input.reportValidity()) break; },
      /** Fixes the size for this page's only launch and returns it. */
      launch() {
        locked = resolve(selection(), ios);
        basisSelect.disabled = true;
        render();
        write('[display] launch framebuffer ' + describe(locked));
        return locked;
      },
    };
  }

  return { canvasSize, resolve, describe, mount, BASES, MIN_SCALE, MAX_SCALE, MIN_DIMENSION, MAX_DIMENSION };
})();
