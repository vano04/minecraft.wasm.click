// Opt-in memory profile panel for the play page, and the launch memory bound
// applied from it.
//
// Profile: nothing runs unless the player opens the panel, confirms the
// warning and presses Start; it never starts with Minecraft and refuses to
// start once Play has been pressed in this page. The allocation itself runs in
// memory-profile-worker.js, which checkpoints to OPFS before each step. This
// page only reads that record (to report a run that ended without finishing),
// starts and stops runs, and terminates the Worker when a run ends so its
// allocations are released. While a run is active the screen wake lock is
// held (the page's mobile wake lock), so a phone does not sleep mid-run; it is
// released when the run ends for any reason. After a run, Play stays blocked
// until a reload, so a profile and a play session never share a page.
//
// The reported figure counts ArrayBuffer bytes filled with pseudo-random data
// rather than sparse writes to zero pages. It does not measure physical
// footprint, the page's total, JVM usage, or a device limit. An interrupted run
// shows where the tab stopped, not why it stopped. While a run is active the
// page records synchronously (localStorage, EXIT_KEY) when it is hidden or
// unloaded, and a run that ends after such a note is stored as 'page-left'.
// That note is not proof that the player left: Safari can fire the same
// events before it reloads a tab by itself. A run that ended without a note
// is not a proven memory kill either: the browser ending the tab, a crash, or
// a reload the page could not note look the same. Either kind applies only
// after the player confirms that the browser reloaded or closed the tab by
// itself; its last fully filled amount is then an observed reload boundary,
// never an out-of-memory diagnosis.
//
// Launch memory: the player may Apply the last profile's fully filled amount
// for the iPhone/iPad runtime. mobile-runtime.js memoryBudgetLimits subtracts
// a 32 MiB recovery headroom to get the bound, keeps an uncalibrated reserve
// of max(256 MiB, 20%) of it for memory outside WebAssembly, and caps the
// game's WebAssembly memory (Java heap inside it) at the rest; memory
// outside WebAssembly is not bounded, and the panel says so. The Worker stores
// it with synchronous OPFS handles in two alternating slots beside, but apart
// from, the run record and history (budget-a.json, budget-b.json; Reset
// writes a cleared entry); loadSelectedBudget reads the newest valid entry
// once at page load and the page's Play waits for that read. Applying or
// resetting blocks Play in that page until a reload, so the game starts with
// limits fixed before its memory exists and after the profile's memory is
// gone. budgetBasis decides which runs qualify: a completed run (a lower bound
// only), a run in which the browser refused an allocation, or an interrupted
// or page-left run the player confirms the browser ended. A stopped run, one
// whose checkpoint failed, one from another browser version or one with
// nothing filled never does, and the confirmation never overrides a Stop. A
// run still active in another tab holds the profile lock, which Apply needs.
// Stop notes the run id synchronously
// (localStorage, STOP_KEY), asks the run to stop at once, and then stores it
// durably (stop-a.json, stop-b.json, keyed by run id); the page passes its
// note to every settle and Apply, so a run whose Worker had to be ended, or
// whose tab ended before the durable record was written, is still known as
// stopped. If the browser refuses both, the page says so; the stop cannot be
// remembered across a reload then. Without an applied bound Play keeps the
// defaults.
globalThis.mcWebMemoryProfile = (() => {
  const DIRECTORY = 'mcweb-memory-profile';
  const SLOTS = ['checkpoint-a.json', 'checkpoint-b.json'];
  const BUDGET_SLOTS = ['budget-a.json', 'budget-b.json'];
  const STOP_SLOTS = ['stop-a.json', 'stop-b.json'];
  const BUDGET_KIND = 'mcweb-launch-memory-budget';
  const LOCK = 'mcweb-memory-profile';
  const STEPS = [16, 32, 64, 128];
  // Where the page notes that it was hidden or unloaded during a run.
  const EXIT_KEY = 'mcweb-memory-profile-exit';
  // Where Stop notes its run id synchronously, before anything asynchronous:
  // a tab ended while the durable OPFS stop record is still being written
  // keeps this. Run ids are unique, so an older note never matches a newer
  // run and is not cleared.
  const STOP_KEY = 'mcweb-memory-profile-stop';
  // A run looks for the tab's ceiling, so its default limit is the highest.
  const LIMIT_MIN = 64, LIMIT_MAX = 8192, LIMIT_DEFAULT = 8192;
  const PAUSE_MS = 250;

  let worker = null;
  let profiledThisPage = false;
  let budgetChangedThisPage = false;
  let budgetBusy = false;
  let playStarted = false;
  let panel = null;

  /** Synchronously notes how this page left run runId ('hidden', 'unloaded') or that it is visible again (null). */
  function recordExit(runId, how) {
    try {
      globalThis.localStorage?.setItem(EXIT_KEY, JSON.stringify({ runId, how, at: new Date().toISOString() }));
    } catch { /* storage refused: the run stays an unexplained interruption that needs confirmation */ }
  }
  /** The run the page saw itself leave, as { runId, how }, or null. */
  function readExit() {
    try {
      const exit = JSON.parse(globalThis.localStorage?.getItem(EXIT_KEY) || 'null');
      return typeof exit?.runId === 'string' && (exit.how === 'hidden' || exit.how === 'unloaded') ? exit : null;
    } catch {
      return null;
    }
  }
  /** Synchronously notes that the player stopped run runId; false if the browser refused the write. */
  function recordStopNote(runId) {
    try {
      globalThis.localStorage.setItem(STOP_KEY, JSON.stringify({ runId, at: new Date().toISOString() }));
      return readStopNote() === runId;
    } catch {
      return false;
    }
  }
  /** The run id of the page's newest Stop note, or null. */
  function readStopNote() {
    try {
      const note = JSON.parse(globalThis.localStorage?.getItem(STOP_KEY) || 'null');
      return typeof note?.runId === 'string' ? note.runId : null;
    } catch {
      return null;
    }
  }

  async function profileDirectory() {
    if (!navigator.storage?.getDirectory) return null;
    try {
      return await (await navigator.storage.getDirectory()).getDirectoryHandle(DIRECTORY);
    } catch (failure) {
      if (failure?.name === 'NotFoundError') return null;
      throw failure;
    }
  }

  /** The valid slot entry with the highest sequence number, or null. */
  async function readNewest(names) {
    const directory = await profileDirectory();
    if (!directory) return null;
    let best = null;
    for (const name of names) {
      try {
        const file = await (await directory.getFileHandle(name)).getFile();
        const record = JSON.parse(await file.text());
        if (record?.schema === 1 && Number.isInteger(record.seq) && (!best || record.seq > best.seq)) best = record;
      } catch { /* missing or partly written slot: the other one stands */ }
    }
    return best;
  }
  const readRecord = () => readNewest(SLOTS);
  /**
   * The newest profile record, the run id of the newest Stop (the durable OPFS
   * record or the page's synchronous note; the one naming this record wins)
   * and the run this page's tab was seen leaving.
   */
  async function readProfile() {
    const [record, stop] = await Promise.all([readRecord(), readNewest(STOP_SLOTS)]);
    const durable = typeof stop?.runId === 'string' ? stop.runId : null, noted = readStopNote();
    const stoppedRunId = [durable, noted].find((id) => id && id === record?.runId) ?? durable ?? noted;
    return { record, stoppedRunId, exit: readExit() };
  }

  const stoppedReason = (stable) => 'The last profile was stopped at ' + stable + ' MiB, which says nothing about the '
    + 'ceiling. Run one to its limit or until the browser stops it.';
  // What the page's lifecycle note (readExit's how) recorded before a run ended.
  const noteText = (how) => (how === 'hidden' ? 'going to the background' : 'being hidden or unloaded');
  /** The last fully filled and the attempted amounts of a run that did not finish. */
  const endedAt = (stable, pending) => stable + ' MiB was the last amount fully filled'
    + (pending ? ' and ' + pending + ' MiB was being tried' : '');
  // Both endings that need the player's confirmation say what it means.
  const CONFIRM_TEXT = 'Confirm below only if the browser or the system reloaded or closed this tab by itself. The '
    + 'filled amount is then used as the reload point you saw, an observed boundary, not a proven out-of-memory limit.';
  /** How a stored entry names its profile: endings the player confirmed as the browser's are reload points. */
  const basisName = (state) => (['interrupted', 'page-left'].includes(state) ? 'confirmed browser-reload' : state) + ' profile';

  /**
   * Whether a profile record may become launch memory in the browser with
   * this userAgent, its profile amount (the last fully filled amount) and an
   * honest description of what it shows. A run made in another browser or
   * browser version never qualifies, nor a run the player stopped
   * (stoppedRunId, the newest recorded Stop), even if its Worker had to be
   * ended before the record said so. A run that did not finish, with or
   * without the page's lifecycle note (exit, from readProfile), needs the
   * player's confirmation that the browser ended it (needsAck).
   */
  function budgetBasis(record, userAgent, stoppedRunId = null, exit = null) {
    if (!record) return { applicable: false, reason: 'No profile has run in this browser for this site.' };
    const stable = record.stableMiB, pending = record.pendingMiB;
    if (!Number.isInteger(stable) || stable <= 0) {
      return { applicable: false, reason: 'The last profile filled no step, so there is nothing to apply.' };
    }
    if (record.context?.userAgent !== userAgent) {
      return { applicable: false, reason: 'The last profile ran in another browser or browser version. Run a new one here.' };
    }
    if (record.runId && record.runId === stoppedRunId) return { applicable: false, reason: stoppedReason(stable) };
    const left = record.runId && record.runId === exit?.runId && ['running', 'interrupted'].includes(record.state);
    switch (left ? 'page-left' : record.state) {
      case 'completed':
        return { applicable: true, needsAck: false, profileMiB: stable,
          bound: 'Lower bound only: the tab held ' + stable + ' MiB filled and the run stopped at its own limit, '
            + 'so the ceiling is at least that and otherwise unknown.' };
      case 'allocation-failed':
        return { applicable: true, needsAck: false, profileMiB: stable,
          bound: 'The browser refused ' + (pending ? 'the step to ' + pending + ' MiB' : 'the next step') + ' after '
            + stable + ' MiB was filled (' + record.failure + ').' };
      case 'running':
      case 'interrupted':
        return { applicable: true, needsAck: true, profileMiB: stable,
          bound: 'The tab ended without the page noting that it was hidden or unloaded first; ' + endedAt(stable, pending)
            + '. The cause is not recorded: the browser ending the tab for memory looks the same as a crash, or as a '
            + 'reload this page could not note. ' + CONFIRM_TEXT };
      case 'page-left':
        // Safari can fire visibilitychange or pagehide just before it reloads a
        // tab itself, so the note alone does not show that the player left.
        return { applicable: true, needsAck: true, profileMiB: stable,
          bound: 'The page noted ' + noteText(left ? exit.how : null) + ' before the tab ended; ' + endedAt(stable, pending)
            + '. Safari also does that just before it reloads a tab by itself, so the note does not show whether you '
            + 'left or the browser ended it. If you switched away, reloaded, closed or left the page, this is not a '
            + 'reload point. ' + CONFIRM_TEXT };
      case 'cancelled':
        return { applicable: false, reason: stoppedReason(stable) };
      default:
        return { applicable: false, reason: 'A ' + record.state + ' profile cannot become launch memory.' };
    }
  }

  /**
   * Validates the newest stored entry against the current policy and
   * browser. policy.check (mobile-runtime.js appliedMemoryLimits) re-derives
   * the caps from the entry's profile amount; an entry from the earlier
   * policy is re-derived under this one, never with larger caps (legacy).
   */
  function checkSelectedBudget(stored, policy, userAgent) {
    if (!stored || stored.cleared === true) return { budget: null, note: null, present: false };
    const ignored = (why) => ({ budget: null, present: true,
      note: 'The saved launch memory ' + why + '; Play uses the defaults until a profile is applied again.' });
    if (stored?.schema !== 1 || stored.kind !== BUDGET_KIND || !Number.isInteger(stored.basis?.stableMiB)) return ignored('is unreadable');
    if (stored.context?.userAgent !== userAgent) return ignored('was applied in another browser or browser version');
    const applied = policy.check(stored);
    if (!applied.ok) return ignored('was sized under another policy');
    const { limits } = applied;
    return { budget: { ...stored, limits, legacy: applied.legacy }, present: true,
      note: 'Using launch memory applied ' + stored.selectedAt + ' from a ' + limits.profileMiB + ' MiB '
        + basisName(stored.basis.state) + ': bound ' + limits.boundMiB + ' MiB, ' + limitsText(limits) + '.'
        + (applied.legacy ? ' It was applied under the earlier policy and is re-derived under the current one, '
          + 'which never gives larger caps.' : '') };
  }

  /**
   * The launch budget for Play: { budget, note, present }. budget is null
   * (the defaults) when none is saved, it is invalid, the policy does not
   * apply to this browser, or it cannot be read; it never rejects.
   */
  async function loadSelectedBudget(policy) {
    if (!policy.applies) return { budget: null, note: null, present: false };
    try {
      return checkSelectedBudget(await readNewest(BUDGET_SLOTS), policy, navigator.userAgent);
    } catch (failure) {
      return { budget: null, present: false,
        note: 'Could not read the saved launch memory (' + (failure?.message || failure) + '); Play uses the defaults.' };
    }
  }

  async function runningElsewhere() {
    if (!navigator.locks?.query) return false;
    const state = await navigator.locks.query();
    return (state.held || []).some((lock) => lock.name === LOCK);
  }

  function measuredMemory() {
    const parts = [];
    const legacy = performance.memory;
    if (legacy && typeof legacy.usedJSHeapSize === 'number') {
      parts.push('performance.memory (Chromium, this page\'s JS heap only): used '
        + mib(legacy.usedJSHeapSize) + ' of limit ' + mib(legacy.jsHeapSizeLimit));
    }
    if (typeof navigator.deviceMemory === 'number') {
      parts.push('navigator.deviceMemory (rounded device RAM hint): ' + navigator.deviceMemory + ' GB');
    }
    return parts;
  }

  const mib = (bytes) => (bytes / 1048576).toFixed(0) + ' MiB';
  const limitsText = (limits) => 'WebAssembly memory capped at ' + limits.wasmMaxMiB + ' MiB, Java heap at most '
    + limits.javaMaxMiB + ' MiB (initial ' + limits.javaInitialMiB + ' MiB) inside it';
  // What an applied bound does and does not cover (mobile-runtime.js). The iPad
  // figures are a physical measurement from 2026-10-21.
  const ENFORCED_TEXT = 'The browser refuses to grow the game\'s WebAssembly memory past the cap, so the Java heap and the '
    + 'JVM\'s native memory (class metadata, compiled-code tables, thread stacks, buffers) stay inside it: the game stops '
    + 'with an out-of-memory error instead of exceeding it. The cap limits allocation; the physical memory in use is only '
    + 'the pages actually touched, at most the cap, and it does not shrink while the game runs. The loader grows memory '
    + 'with some slack, so allocations can fail up to 5% (at most 96 MiB) below the cap.';
  const UNBOUNDED_TEXT = 'Not bounded by this setting: memory outside WebAssembly, that is, the in-memory file system '
    + '(game files and worlds), JavaScript and Worker heaps, compiled code, audio, and GPU memory in the browser\'s '
    + 'separate GPU process. The reserve kept for it is a policy assumption, not a measurement. On a physical iPad the '
    + 'page\'s WebContent process measured 3017-3685 MiB with the default 1152 MiB cap, so at least 1.8 GiB lay '
    + 'outside it, more than this reserve, and the GPU process has its own limit. The tab as a whole can exceed the '
    + 'bound, and the browser can still reload it. Export any world you want to keep before playing.';

  function element(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  /**
   * Builds the panel in container (a <details>).
   * policy: { applies, defaults, limitsFor, check } from mobile-runtime.js
   * (memoryLimits(null), memoryBudgetLimits, appliedMemoryLimits).
   * launch: this page's loadSelectedBudget(policy) promise.
   * desktopCaps: { javaMaxMiB, javaInitialMiB, wasmMaxMiB } where policy.applies is false.
   * wake: the page's screen wake lock ({ start, stop }), held while a run is active.
   * onPlayBlocked(reason): the page disables Install and Play until it is reloaded.
   */
  function mount({ container, policy, launch, desktopCaps, releaseKey, wake, onPlayBlocked = () => {}, write = () => {} }) {
    const workerURL = 'memory-profile-worker.js' + (releaseKey ? '?release=' + releaseKey : '');
    const intro = element('p', {},
      'Optional. Looks for this tab\'s memory ceiling: allocates extra memory in steps and fills it with '
      + 'pseudo-random data until it reaches the limit, an allocation fails, or you press Stop. ',
      element('strong', {}, 'This can make Safari reload or close this tab, and may discard other tabs. '),
      'It never starts Minecraft and does not open worlds, settings or the installed game files. '
      + 'Close other tabs and keep this page in front until it ends. Before each step it saves the amount it is '
      + 'about to try in this site\'s private storage, so after an interruption this panel shows the last completed '
      + 'amount and the amount being tried. A reload is not an exact device limit: the browser can '
      + 'stop a tab for other reasons, and the point differs between runs. It does not resume by itself.');
    const scope = element('p', { className: 'sub' },
      'The figures below are memory this page fills, not the game\'s usage. The game\'s own limits are under '
      + 'Launch memory, and change only when you apply a profile there: 32 MiB less than the last amount filled '
      + 'becomes the bound, and the game\'s WebAssembly memory is capped below it.');
    const step = element('select', { id: 'memory-profile-step' });
    for (const value of STEPS) step.add(new Option(value + ' MiB', String(value)));
    step.value = '32';
    const limit = element('input', { id: 'memory-profile-limit', type: 'number', min: String(LIMIT_MIN),
      max: String(LIMIT_MAX), step: '64', value: String(LIMIT_DEFAULT) });
    const consent = element('input', { id: 'memory-profile-consent', type: 'checkbox' });
    const start = element('button', { id: 'memory-profile-start', type: 'button', disabled: true }, 'Start profile');
    const stop = element('button', { id: 'memory-profile-stop', type: 'button', disabled: true }, 'Stop');
    const dismiss = element('button', { id: 'memory-profile-dismiss', type: 'button', hidden: true }, 'Dismiss');
    const state = element('p', { id: 'memory-profile-state', role: 'status' });
    const measured = element('p', { id: 'memory-profile-measured', className: 'sub' });
    const history = element('ol', { id: 'memory-profile-history', className: 'sub' });
    const budgetState = element('p', { id: 'memory-budget-state', role: 'status' }, 'Reading the saved launch memory...');
    const budgetPlan = element('p', { id: 'memory-budget-plan', className: 'sub' });
    const budgetScope = element('p', { id: 'memory-budget-scope', className: 'sub', hidden: true });
    const ack = element('input', { id: 'memory-budget-ack', type: 'checkbox' });
    const ackRow = element('label', { className: 'profile-row', hidden: true }, ack,
      ' The browser or the system reloaded or closed this tab by itself during that profile. I did not reload, close or '
      + 'leave it, and did not switch to another tab or app.');
    const apply = element('button', { id: 'memory-budget-apply', type: 'button', disabled: true }, 'Apply as launch memory');
    const reset = element('button', { id: 'memory-budget-reset', type: 'button', hidden: true }, 'Reset to defaults');
    const reload = element('button', { id: 'memory-budget-reload', type: 'button', hidden: true }, 'Reload now');
    container.append(intro, scope,
      element('div', { className: 'profile-row' },
        element('label', {}, 'Step ', step),
        element('label', {}, 'Limit (MiB, ' + LIMIT_MIN + '-' + LIMIT_MAX + ') ', limit)),
      element('label', { className: 'profile-row' }, consent,
        ' I understand this may reload or close this tab and that the result is not an exact limit.'),
      element('div', { className: 'profile-row' }, start, stop, dismiss),
      state, measured, history,
      element('p', {}, element('strong', {}, 'Launch memory')),
      budgetState, budgetPlan, budgetScope, ackRow,
      element('div', { className: 'profile-row' }, apply, reset, reload));

    let latestRecord = null;
    // The run id of the newest recorded Stop, the run this page's tab was seen
    // leaving (readExit), and this page's own run.
    let stoppedRun = null;
    let exit = null;
    let currentRunId = null;
    let elsewhere = false;
    let loaded = null;
    let budgetSaved = false;

    const showMeasured = () => {
      const parts = measuredMemory();
      measured.textContent = parts.length ? parts.join('; ')
        : 'This browser reports no page memory measurement; only the profile\'s own allocation is shown.';
    };
    const showHistory = (record) => {
      history.replaceChildren(...(record?.history || []).slice().reverse().map((item) =>
        element('li', {}, item.startedAt + ': ' + item.state + ', ' + item.stableMiB + ' MiB completed'
          + (item.pendingMiB ? ', was trying ' + item.pendingMiB + ' MiB' : '')
          + ' (step ' + item.stepMiB + ', limit ' + item.limitMiB + ')'
          + (item.failure ? ' - ' + item.failure : ''))));
    };
    const refreshStart = () => {
      start.disabled = Boolean(worker) || !consent.checked || playStarted || profiledThisPage || budgetBusy;
    };
    const showBudgetState = () => {
      if (budgetChangedThisPage || !loaded) return;
      if (!policy.applies) {
        budgetState.textContent = 'Play in this browser uses its desktop limits: Java heap at most ' + desktopCaps.javaMaxMiB
          + ' MiB (initial ' + desktopCaps.javaInitialMiB + ' MiB), WebAssembly maximum ' + desktopCaps.wasmMaxMiB + ' MiB.';
      } else if (loaded.budget) {
        const limits = loaded.budget.limits;
        budgetState.textContent = 'Play uses launch memory applied ' + loaded.budget.selectedAt + ': bound '
          + limits.boundMiB + ' MiB (a ' + limits.profileMiB + ' MiB ' + basisName(loaded.budget.basis.state) + ' less the '
          + limits.headroomMiB + ' MiB recovery headroom), ' + limits.reserveMiB + ' MiB of it reserved outside WebAssembly, '
          + limitsText(limits) + '.'
          + (loaded.budget.legacy ? ' Applied under the earlier policy and re-derived under the current one.' : '')
          + (limits.belowDefaults ? ' This is below the tested defaults, so the game may run out of memory.' : '');
      } else {
        budgetState.textContent = 'Play uses the defaults: ' + limitsText(policy.defaults) + '.' + (loaded.note ? ' ' + loaded.note : '');
      }
    };
    const refreshBudget = () => {
      const basis = budgetBasis(latestRecord, navigator.userAgent, stoppedRun, exit);
      const plan = basis.applicable ? policy.limitsFor(basis.profileMiB) : null;
      ackRow.hidden = !(policy.applies && basis.applicable && basis.needsAck);
      budgetScope.hidden = !policy.applies;
      budgetScope.textContent = ENFORCED_TEXT + ' ' + UNBOUNDED_TEXT;
      if (!policy.applies) {
        budgetPlan.textContent = 'Applied launch memory changes only the iPhone/iPad runtime; this browser keeps its own limits.';
      } else if (elsewhere) {
        budgetPlan.textContent = 'A profile is running in another tab of this site.';
      } else if (!basis.applicable) {
        budgetPlan.textContent = basis.reason;
      } else if (!plan.ok) {
        budgetPlan.textContent = basis.bound + ' ' + plan.reason + ' Play keeps the defaults (' + limitsText(policy.defaults)
          + '), which are larger than this bound.';
      } else {
        const limits = plan.limits;
        budgetPlan.textContent = basis.bound + ' Bound: ' + limits.profileMiB + ' MiB less the ' + limits.headroomMiB
          + ' MiB recovery headroom, ' + limits.boundMiB + ' MiB. Applying keeps ' + limits.reserveMiB
          + ' MiB of it for memory outside WebAssembly (max(256 MiB, 20%), uncalibrated) and sets ' + limitsText(limits)
          + (limits.wasmMaxMiB === 4096 && limits.boundMiB - limits.reserveMiB >= 4096 + 64 ? ' (the loader\'s 4 GiB maximum)' : '')
          + '.' + (limits.belowDefaults ? ' This is below the tested defaults (' + limitsText(policy.defaults) + '): the game '
            + 'may exhaust its capped WebAssembly memory at startup or in a world; this does not cap the whole tab.' : '');
      }
      apply.hidden = !policy.applies;
      apply.disabled = !policy.applies || elsewhere || !basis.applicable || !plan?.ok || (basis.needsAck && !ack.checked)
        || Boolean(worker) || budgetBusy || playStarted || !loaded;
      reset.hidden = !policy.applies || !budgetSaved;
      reset.disabled = Boolean(worker) || budgetBusy || playStarted || elsewhere;
      refreshStart();
    };
    const describe = (record) => {
      switch (record.state) {
        case 'running':
          return 'Running: ' + record.stableMiB + ' MiB extra filled'
            + (record.pendingMiB ? ', now trying ' + record.pendingMiB + ' MiB.' : '.');
        case 'completed':
          return 'Reached the ' + record.limitMiB + ' MiB limit with ' + record.stableMiB
            + ' MiB extra filled (a lower bound, not a ceiling). Released.';
        case 'cancelled':
          return 'Stopped at ' + record.stableMiB + ' MiB extra filled. Released.';
        case 'allocation-failed':
          return 'The browser refused the step after ' + record.stableMiB + ' MiB extra filled ('
            + record.failure + '). Released.';
        case 'checkpoint-failed':
          return 'Stopped: the checkpoint could not be saved (' + record.failure + '). Released.';
        case 'interrupted':
        case 'page-left':
          return 'Ended before it finished' + (record.state === 'page-left' ? ', after the page noted being hidden or unloaded' : '')
            + ': ' + record.stableMiB + ' MiB extra filled' + (record.pendingMiB ? ', was trying ' + record.pendingMiB + ' MiB' : '')
            + '. Launch memory below says whether it can be used.';
        default:
          return 'Last run: ' + record.state + ', ' + record.stableMiB + ' MiB.';
      }
    };
    const finish = (message) => {
      if (worker) { worker.terminate(); worker = null; }
      wake?.stop();
      profiledThisPage = true;
      stop.disabled = true;
      state.textContent = message + ' Reload this page before Play, so the game does not share a page with the profile.';
      onPlayBlocked('memory profile in this page - reload it before Play');
      refreshBudget();
      showMeasured();
    };
    const budgetChanged = (message) => {
      budgetChangedThisPage = true;
      budgetState.textContent = message + ' Reload this page before Play.';
      reload.hidden = false;
      onPlayBlocked('launch memory changed - reload this page before Play');
    };
    // One short-lived Worker per Apply or Reset; it takes the profile lock.
    const budgetOp = (message, done) => {
      budgetBusy = true;
      refreshBudget();
      const helper = new Worker(workerURL);
      const end = (data) => {
        helper.terminate();
        budgetBusy = false;
        done(data);
        refreshBudget();
      };
      helper.onmessage = ({ data }) => end(data);
      helper.onerror = (event) => {
        event.preventDefault();
        end({ type: 'error', message: event.message || 'the profile worker failed' });
      };
      helper.postMessage(message);
    };

    consent.addEventListener('change', refreshStart);
    ack.addEventListener('change', refreshBudget);
    // While this page's run is active, note synchronously when the page goes to
    // the background or unloads, and clear the note when it is back in front.
    const noteExit = (how) => { if (worker && currentRunId) recordExit(currentRunId, how); };
    document.addEventListener('visibilitychange', () => noteExit(document.visibilityState === 'hidden' ? 'hidden' : null));
    addEventListener('pagehide', () => noteExit('unloaded'));
    // A page restored from the back-forward cache resumes its run in front.
    addEventListener('pageshow', (event) => { if (event.persisted && document.visibilityState === 'visible') noteExit(null); });
    start.addEventListener('click', () => {
      if (worker || playStarted || profiledThisPage || budgetBusy || !consent.checked) return;
      const limitMiB = Math.round(Number(limit.value));
      const stepMiB = Number(step.value);
      if (!Number.isFinite(limitMiB) || limitMiB < LIMIT_MIN || limitMiB > LIMIT_MAX) {
        state.textContent = 'Choose a limit from ' + LIMIT_MIN + ' to ' + LIMIT_MAX + ' MiB.';
        return;
      }
      dismiss.hidden = true;
      worker = new Worker(workerURL);
      wake?.start();
      onPlayBlocked('memory profile in this page - reload it before Play');
      stop.disabled = false;
      refreshBudget();
      state.textContent = 'Starting...';
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          state.textContent = describe(data.record);
        } else if (data.type === 'done') {
          write('[memory-profile] ' + data.record.state + ' at ' + data.record.stableMiB + ' MiB extra');
          latestRecord = data.record;
          showHistory(data.record);
          finish(describe(data.record));
        } else if (data.type === 'error') {
          write('[memory-profile] ' + data.message, 'err');
          finish('The profile stopped: ' + data.message + '.');
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        finish('The profile worker failed: ' + (event.message || 'unknown error') + '.');
      };
      currentRunId = crypto.randomUUID();
      worker.postMessage({ op: 'start', runId: currentRunId, stepMiB, limitMiB, pauseMs: PAUSE_MS, exitedRunId: exit?.runId ?? null,
        stoppedRunId: stoppedRun, context: { userAgent: navigator.userAgent, launchPolicy: policy.defaults.policy } });
    });
    stop.addEventListener('click', () => {
      if (!worker || stop.disabled) return;
      stop.disabled = true;
      const current = worker, runId = currentRunId;
      // This page never applies the run it stopped, whatever is stored.
      stoppedRun = runId;
      // Noted synchronously first, so a tab ended while the durable record
      // below is written still knows the run was stopped; then the run is
      // asked to stop at once.
      const noted = recordStopNote(runId);
      current.postMessage({ op: 'stop' });
      state.textContent = noted ? 'Stopping...' : 'Stopping... This browser refused to note the stop; it is saved '
        + 'only if the record below succeeds.';
      if (!noted) write('[memory-profile] could not note the stop in localStorage', 'err');
      // The durable OPFS record, which the Worker also reads.
      budgetOp({ op: 'record-stop', runId }, (data) => {
        if (data.type === 'stop-recorded') return;
        write('[memory-profile] could not store the stop: ' + data.message, 'err');
        if (!noted) {
          state.textContent = 'The stop could not be saved in this browser (' + data.message + '). After a reload this '
            + 'run may look like an interruption: it was not one, so do not confirm it or apply it.';
        }
      });
      // The Worker yields every 4 MiB it fills; if it still does not answer,
      // ending it releases its memory all the same.
      setTimeout(() => {
        if (worker !== current) return;
        finish('The profile worker did not answer and was ended. Released.');
        budgetOp({ op: 'settle', stoppedRunId: runId }, (settled) => {
          if (settled.type !== 'settled') {
            write('[memory-profile] the stopped run is recorded on the next load: ' + settled.message, 'err');
            return;
          }
          latestRecord = settled.record;
          showHistory(settled.record);
        });
      }, 10000);
    });
    dismiss.addEventListener('click', () => {
      dismiss.disabled = true;
      budgetOp({ op: 'settle', exitedRunId: exit?.runId ?? null, stoppedRunId: stoppedRun }, (data) => {
        dismiss.hidden = true;
        dismiss.disabled = false;
        if (data.type === 'settled') {
          latestRecord = data.record;
          showHistory(data.record);
          state.textContent = { cancelled: 'Recorded as stopped.',
            'page-left': 'Recorded as ended after the page noted being hidden or unloaded.' }[
            data.record?.state] || 'Recorded as interrupted.';
        } else state.textContent = 'Could not update the record: ' + data.message;
      });
    });
    apply.addEventListener('click', () => {
      const basis = budgetBasis(latestRecord, navigator.userAgent, stoppedRun, exit);
      const plan = basis.applicable ? policy.limitsFor(basis.profileMiB) : null;
      if (apply.disabled || !plan?.ok) return;
      budgetOp({ op: 'select-budget', basis: { startedAt: latestRecord.startedAt, stableMiB: latestRecord.stableMiB },
        acknowledgedBrowserEnded: basis.needsAck && ack.checked, limits: plan.limits, exitedRunId: exit?.runId ?? null,
        stoppedRunId: stoppedRun, context: { userAgent: navigator.userAgent, releaseKey } }, (data) => {
        if (data.type !== 'budget-selected') { budgetState.textContent = 'Not applied: ' + data.message + '.'; return; }
        latestRecord = data.record;
        showHistory(data.record);
        dismiss.hidden = true;
        state.textContent = describe(data.record);
        budgetSaved = true;
        const limits = data.selected.limits;
        write('[memory] applied launch memory: bound ' + limits.boundMiB + ' MiB from a ' + limits.profileMiB + ' MiB '
          + basisName(data.selected.basis.state) + '; WebAssembly cap ' + limits.wasmMaxMiB + ' MiB, -Xmx' + limits.javaMaxMiB + 'm');
        budgetChanged('Applied: after a reload, Play uses the ' + limits.boundMiB + ' MiB bound: ' + limitsText(limits) + '.');
      });
    });
    reset.addEventListener('click', () => {
      if (reset.disabled) return;
      budgetOp({ op: 'clear-budget' }, (data) => {
        if (data.type !== 'budget-cleared') { budgetState.textContent = 'Not reset: ' + data.message + '.'; return; }
        budgetSaved = false;
        write('[memory] reset the launch memory to the defaults');
        budgetChanged('Reset: after a reload, Play uses the defaults: ' + limitsText(policy.defaults) + '.');
      });
    });
    reload.addEventListener('click', () => location.reload());

    showMeasured();
    launch.then((result) => {
      loaded = result;
      budgetSaved = result.present;
      showBudgetState();
      refreshBudget();
    });
    (async () => {
      const profile = await readProfile();
      const { record, stoppedRunId } = profile;
      latestRecord = record;
      stoppedRun ??= stoppedRunId;
      exit = profile.exit;
      showHistory(record);
      if (!record) { state.textContent = 'No profile has run in this browser for this site.'; return; }
      if (record.state === 'running') {
        if (await runningElsewhere()) {
          elsewhere = true;
          state.textContent = 'A profile is running in another tab of this site.';
          return;
        }
        container.open = true;
        dismiss.hidden = false;
        if (record.runId && record.runId === stoppedRunId) {
          state.textContent = 'The previous profile was stopped at ' + record.stableMiB + ' MiB extra filled; its worker '
            + 'had to be ended before it saved that. Dismiss records it as stopped. It was not restarted.';
          return;
        }
        const noted = record.runId && record.runId === exit?.runId;
        state.textContent = 'The previous profile did not finish: ' + record.stableMiB + ' MiB extra had completed'
          + (record.pendingMiB ? ' and it was trying ' + record.pendingMiB + ' MiB' : '')
          + ' when the page stopped (step ' + record.stepMiB + ' MiB, saved ' + record.updatedAt + '). '
          + (noted ? 'The page noted ' + noteText(exit.how) + ' first. Safari does that when you leave, and also just '
            + 'before it reloads a tab by itself. ' : 'The page did not note being hidden or unloaded first. ')
          + 'That is not proof of the cause. It was not restarted. Launch memory below says whether it can be used.';
        return;
      }
      state.textContent = describe(record);
    })().catch((failure) => { state.textContent = 'Could not read the previous profile: ' + (failure?.message || failure); })
      .finally(refreshBudget);

    panel = { refreshBudget, state };
    return panel;
  }

  return {
    mount,
    loadSelectedBudget,
    budgetBasis,
    readProfile,
    checkSelectedBudget,
    /** True once a profile ran here or the launch memory was changed here: Play waits for a reload. */
    blocksPlay: () => Boolean(worker) || profiledThisPage || budgetChangedThisPage || budgetBusy,
    /** Play was pressed: no profile or budget change in this page from now on. */
    playStarted() {
      playStarted = true;
      if (panel) {
        panel.refreshBudget();
        panel.state.textContent = 'Play has started in this page; reload it to run a profile.';
      }
    },
  };
})();
