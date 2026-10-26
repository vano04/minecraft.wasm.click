// Opt-in memory profile, run on its own Worker (web/memory-profile.js starts it).
//
// It allocates ArrayBuffers in fixed steps and fills every word of each one
// with non-repeating pseudo-random data, until it reaches the limit, an
// allocation throws, or the page asks it to stop. Filling faults in the pages
// and avoids trivially compressible zero-filled allocations. The reported
// MiB count filled ArrayBuffers, not measured physical footprint. Before
// every step it durably records
// (OPFS, synchronous access handle, flushed) the amount it is about to try,
// and a step counts as completed only after its buffer is fully filled, so a
// page that is killed mid-step can report afterwards both the last completed
// amount and the attempted one. It never resumes by itself. The page
// terminates this Worker when a run ends, which releases every allocation
// with it.
//
// Storage: two alternating slot files under mcweb-memory-profile/ in this
// origin's private file system, each a whole JSON record with a sequence
// number; readers take the valid slot with the highest number, so a write cut
// off half way still leaves the previous record. Nothing else in OPFS is
// opened, so installed game files and saves are untouched.
//
// The launch memory the player applies from a profile is kept apart from the
// run record and its history, in its own two alternating slots
// (budget-a.json, budget-b.json; same synchronous handles, flush and
// highest-valid-sequence rule as above, so a cut-off write leaves the
// previous entry). Only an explicit Apply (op 'select-budget') writes an
// entry, and only Reset ('clear-budget') writes a cleared one. The entry
// holds the page's limits (mobile-runtime.js memoryBudgetLimits: the profile
// amount less a 32 MiB recovery headroom, then less a reserve outside
// WebAssembly); the page re-derives them when it reads the entry. The basis is re-checked against the profile record here:
// only a completed run (a lower bound), a run the browser refused an
// allocation in, or an interrupted or page-left run the player confirmed the
// browser ended qualifies; a stopped or failed-checkpoint run never does, and
// the confirmation never overrides a Stop. The entry's amount is always the
// record's last fully filled amount (stableMiB), never the attempted one.
//
// Stop: the page notes the run id synchronously (localStorage), asks the
// running Worker to stop, and has a short-lived Worker (op 'record-stop')
// write the run's id to its own two alternating slots (stop-a.json,
// stop-b.json), which the running Worker never opens and which need no lock.
// The running Worker fills each step in bounded chunks and yields between
// them, so it sees the stop message within a chunk and drops the partly
// filled step. If it still has to be terminated, its record stays 'running'
// on disk; settling it (op 'settle', or Apply) treats it as cancelled, not
// interrupted, when either the stop slots or the page's note (stoppedRunId in
// the message) name its run, and Apply refuses such a record.
//
// A run whose page noted being hidden or unloaded before it ended is stored
// as 'page-left', not interrupted: the page passes that note's run id here as
// exitedRunId. Endings without a note stay 'interrupted'. Neither is evidence
// of running out of memory, and the note is not proof that the player left
// (Safari can fire those events before it reloads a tab itself), so Apply
// takes either only with the player's confirmation that the browser ended it
// (acknowledgedBrowserEnded).
'use strict';

const MiB = 1048576;
const DIRECTORY = 'mcweb-memory-profile';
const SLOTS = ['checkpoint-a.json', 'checkpoint-b.json'];
const LOCK = 'mcweb-memory-profile';
const BUDGET_SLOTS = ['budget-a.json', 'budget-b.json'];
const STOP_SLOTS = ['stop-a.json', 'stop-b.json'];
// Words filled between yields to the event loop (4 MiB).
const FILL_CHUNK_WORDS = 4 * MiB / 4;
const BUDGET_KIND = 'mcweb-launch-memory-budget';
const HISTORY = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// xorshift32 (not cryptographic): seeded once per run from crypto, its state
// carries across steps. Its period of 2^32-1 words (16 GiB) exceeds the
// largest limit, so no word sequence repeats within a run.
function fill(view, state) {
  let x = state;
  for (let i = 0; i < view.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    view[i] = x;
  }
  return x;
}

let stopRequested = false;
let busy = false;

const post = (message) => self.postMessage(message);

async function openSlots(names = SLOTS) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(DIRECTORY, { create: true });
  const handles = [];
  try {
    for (const name of names) {
      const file = await directory.getFileHandle(name, { create: true });
      if (typeof file.createSyncAccessHandle !== 'function') {
        throw new Error('this browser has no synchronous OPFS access, so a checkpoint cannot be '
          + 'made durable before each step');
      }
      handles.push(await file.createSyncAccessHandle());
    }
  } catch (failure) {
    for (const handle of handles) await handle.close();
    throw failure;
  }
  return handles;
}

async function readSlot(handle) {
  const size = await handle.getSize();
  if (!size) return null;
  const bytes = new Uint8Array(size);
  await handle.read(bytes, { at: 0 });
  try {
    const record = JSON.parse(decoder.decode(bytes));
    return record && record.schema === 1 && Number.isInteger(record.seq) ? record : null;
  } catch {
    return null;
  }
}

async function latest(handles) {
  let best = null;
  for (const handle of handles) {
    const record = await readSlot(handle);
    if (record && (!best || record.seq > best.seq)) best = record;
  }
  return best;
}

async function persist(handles, record) {
  record.seq += 1;
  record.updatedAt = new Date().toISOString();
  const handle = handles[record.seq % handles.length];
  const bytes = encoder.encode(JSON.stringify(record));
  await handle.truncate(0);
  const written = await handle.write(bytes, { at: 0 });
  if (written !== bytes.length) throw new Error('short checkpoint write');
  await handle.flush();
}

/** The previous record's outcome, for the history list. */
function summary(record, state = record.state) {
  return {
    runId: record.runId, state, startedAt: record.startedAt, endedAt: record.endedAt || null,
    stepMiB: record.stepMiB, limitMiB: record.limitMiB, stableMiB: record.stableMiB,
    pendingMiB: ['interrupted', 'allocation-failed', 'page-left'].includes(state) ? record.pendingMiB : null,
    failure: record.failure || null, context: record.context || null,
  };
}

/**
 * What an unfinished (still running on disk) record ended as. ends holds the
 * newest recorded Stop's run id (stoppedRunId) and the run id the page saw
 * leave (exitedRunId). Stop wins, then the page leaving, else interrupted.
 */
function unfinishedState(record, ends) {
  if (!record.runId) return 'interrupted';
  if (record.runId === ends.stoppedRunId) return 'cancelled';
  return record.runId === ends.exitedRunId ? 'page-left' : 'interrupted';
}

/** Moves an unfinished or finished record into history; returns the new history. */
function archive(previous, ends) {
  const history = Array.isArray(previous?.history) ? previous.history.slice() : [];
  if (previous && previous.runId && !history.some((item) => item.runId === previous.runId)) {
    history.push(summary(previous, previous.state === 'running' ? unfinishedState(previous, ends) : previous.state));
  }
  return history.slice(-HISTORY);
}

/**
 * The run id of the Stop that applies to record: the newest durable Stop, or
 * noted (the page's synchronous note) when that names record's run.
 */
async function stoppedRunId(record, noted = null) {
  if (typeof noted === 'string' && noted && noted === record?.runId) return noted;
  const handles = await openSlots(STOP_SLOTS);
  try {
    return (await latest(handles))?.runId ?? null;
  } finally {
    for (const handle of handles) await handle.close();
  }
}

/** Durably records that the player stopped this run, before it is asked to stop. */
async function recordStop({ runId }) {
  if (typeof runId !== 'string' || !runId) throw new Error('no run to stop');
  const handles = await openSlots(STOP_SLOTS);
  try {
    const previous = await latest(handles);
    await persist(handles, { schema: 1, seq: previous ? previous.seq : 0, runId, requestedAt: new Date().toISOString() });
  } finally {
    for (const handle of handles) await handle.close();
  }
}

async function withLock(task) {
  if (!navigator.locks) return task();
  return navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('a memory profile is already running in another tab of this site');
    return task();
  });
}

async function run({ runId, stepMiB, limitMiB, pauseMs, context, exitedRunId = null, stoppedRunId: noted = null }) {
  const handles = await openSlots();
  const allocations = [];
  // Any non-zero 32-bit seed; xorshift never reaches zero from one.
  let random = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  let record;
  try {
    const previous = await latest(handles);
    record = {
      schema: 1, seq: previous ? previous.seq : 0, runId, state: 'running',
      startedAt: new Date().toISOString(), updatedAt: null, endedAt: null,
      stepMiB, limitMiB, stableMiB: 0, pendingMiB: null, failure: null, context,
      history: archive(previous, previous?.state === 'running'
        ? { stoppedRunId: await stoppedRunId(previous, noted), exitedRunId } : {}),
    };
    await persist(handles, record);
    post({ type: 'progress', record });
    while (!stopRequested) {
      const next = Math.min(limitMiB, record.stableMiB + stepMiB);
      if (next <= record.stableMiB) { record.state = 'completed'; break; }
      // The checkpoint is durable before the allocation is attempted.
      record.pendingMiB = next;
      await persist(handles, record);
      post({ type: 'progress', record });
      let buffer;
      let words;
      try {
        buffer = new ArrayBuffer((next - record.stableMiB) * MiB);
        words = new Uint32Array(buffer);
      } catch (failure) {
        buffer = null;
        record.state = 'allocation-failed';
        record.failure = (failure && failure.name || 'Error') + ': ' + (failure && failure.message || failure);
        break;
      }
      // Filled in chunks with a yield between them, so a stop message is
      // handled within one chunk; a step stopped part way is not counted.
      let filled = 0;
      while (filled < words.length && !stopRequested) {
        const end = Math.min(words.length, filled + FILL_CHUNK_WORDS);
        random = fill(words.subarray(filled, end), random);
        filled = end;
        if (filled < words.length) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (filled < words.length) { buffer = words = null; break; }
      allocations.push(buffer);
      record.stableMiB = next;
      record.pendingMiB = null;
      await persist(handles, record);
      post({ type: 'progress', record });
      if (next >= limitMiB) { record.state = 'completed'; break; }
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    if (record.state === 'running') record.state = 'cancelled';
  } catch (failure) {
    if (record) {
      record.state = 'checkpoint-failed';
      record.failure = String(failure && failure.message || failure);
    }
    throw failure;
  } finally {
    // Dropped here; the page then terminates this Worker, which frees them.
    allocations.length = 0;
    if (record) {
      // A refused allocation keeps the amount it tried, as the upper bound shown.
      if (record.state !== 'allocation-failed') record.pendingMiB = null;
      record.endedAt = new Date().toISOString();
      try { await persist(handles, record); } catch { /* reported by the caller */ }
    }
    for (const handle of handles) await handle.close();
  }
  return record;
}

/**
 * Persists an unfinished (running) record as ended: cancelled if the player
 * stopped that run, page-left if the page noted being hidden or unloaded
 * during it, otherwise interrupted (see unfinishedState). Returns it.
 */
async function endUnfinished(handles, previous, ends) {
  const state = unfinishedState(previous, ends);
  const record = { ...previous, state, endedAt: null };
  if (state === 'cancelled') record.pendingMiB = null;
  record.history = archive(previous, ends);
  await persist(handles, record);
  return record;
}

/** Records an unfinished run as stopped, page-left or interrupted without starting a new one. */
async function settle({ exitedRunId = null, stoppedRunId: noted = null } = {}) {
  const handles = await openSlots();
  try {
    const previous = await latest(handles);
    if (!previous || previous.state !== 'running') return previous;
    return await endUnfinished(handles, previous, { stoppedRunId: await stoppedRunId(previous, noted), exitedRunId });
  } finally {
    for (const handle of handles) await handle.close();
  }
}

/** Appends a budget entry (a selection or a reset) as the newest slot. */
async function writeBudget(entry) {
  const handles = await openSlots(BUDGET_SLOTS);
  try {
    const previous = await latest(handles);
    entry.seq = previous ? previous.seq : 0;
    await persist(handles, entry);
  } finally {
    for (const handle of handles) await handle.close();
  }
}

/**
 * Writes the launch memory from the latest profile record. basis is the
 * record the page showed (startedAt, stableMiB); limits are the page's
 * mcWebMobileRuntime.memoryBudgetLimits(stableMiB).limits. Only a run made
 * in this browser and version (its userAgent) qualifies, and never a run the
 * player stopped, even one whose Worker had to be terminated before it
 * recorded the stop, and even with acknowledgedBrowserEnded. An unfinished
 * record is ended first; an interrupted or page-left one (the page noted
 * leaving, exitedRunId) counts only with acknowledgedBrowserEnded.
 */
async function selectBudget({ basis, acknowledgedBrowserEnded, limits, context, exitedRunId = null, stoppedRunId: noted = null }) {
  const handles = await openSlots();
  let record, state;
  try {
    record = await latest(handles);
    if (!record || record.startedAt !== basis?.startedAt || record.stableMiB !== basis?.stableMiB) {
      throw new Error('the profile record changed since this page read it; reload the page');
    }
    if (record.context?.userAgent !== navigator.userAgent || context?.userAgent !== navigator.userAgent) {
      throw new Error('the profile ran in another browser or browser version; run a new one here');
    }
    const ends = { stoppedRunId: await stoppedRunId(record, noted), exitedRunId };
    // A record settled as interrupted is re-checked too: Stop and the page's note win.
    state = ['running', 'interrupted'].includes(record.state) ? unfinishedState(record, ends) : record.state;
    if (state === 'cancelled' || (record.runId && record.runId === ends.stoppedRunId)) {
      // A stopped run whose Worker was terminated is stored as what it was.
      if (record.state === 'running') await endUnfinished(handles, record, ends);
      throw new Error('a stopped profile cannot become launch memory');
    }
    if ((state === 'interrupted' || state === 'page-left') && acknowledgedBrowserEnded !== true) {
      throw new Error(state === 'page-left'
        ? 'the page noted being hidden or unloaded before that profile ended; it counts only if you confirm that the '
          + 'browser reloaded or closed the tab by itself'
        : 'an interrupted profile needs your confirmation that the browser ended it');
    }
    if (!['completed', 'allocation-failed', 'interrupted', 'page-left'].includes(state)) {
      throw new Error('a ' + state + ' profile cannot become launch memory');
    }
    // The caps and the reserve outside WebAssembly must sit inside the bound:
    // the profile amount less the headroom.
    if (!Number.isInteger(record.stableMiB) || record.stableMiB <= 0 || limits?.profileMiB !== record.stableMiB
        || !Number.isInteger(limits.headroomMiB) || limits.headroomMiB <= 0
        || limits.boundMiB !== record.stableMiB - limits.headroomMiB
        || !Number.isInteger(limits.reserveMiB) || limits.reserveMiB <= 0
        || !Number.isInteger(limits.wasmMaxMiB) || limits.wasmMaxMiB + limits.reserveMiB > limits.boundMiB) {
      throw new Error('the launch limits do not match the profile');
    }
    if (record.state === 'running') record = await endUnfinished(handles, record, ends);
  } finally {
    for (const handle of handles) await handle.close();
  }
  const selected = {
    schema: 1, kind: BUDGET_KIND, seq: 0, selectedAt: new Date().toISOString(), limits, context,
    basis: { state: record.state, acknowledgedBrowserEnded: ['interrupted', 'page-left'].includes(state), startedAt: record.startedAt,
      endedAt: record.endedAt || null, stepMiB: record.stepMiB, limitMiB: record.limitMiB, stableMiB: record.stableMiB,
      pendingMiB: record.pendingMiB ?? null, failure: record.failure || null },
  };
  await writeBudget(selected);
  return { selected, record };
}

async function clearBudget() {
  await writeBudget({ schema: 1, kind: BUDGET_KIND, seq: 0, cleared: true, clearedAt: new Date().toISOString() });
}

self.addEventListener('message', async (event) => {
  const message = event.data || {};
  if (message.op === 'stop') { stopRequested = true; return; }
  if (busy) { post({ type: 'error', message: 'the profile worker is busy' }); return; }
  busy = true;
  try {
    if (message.op === 'start') {
      const record = await withLock(() => run(message));
      post({ type: 'done', record });
    } else if (message.op === 'settle') {
      const record = await withLock(() => settle(message));
      post({ type: 'settled', record });
    } else if (message.op === 'select-budget') {
      const { selected, record } = await withLock(() => selectBudget(message));
      post({ type: 'budget-selected', selected, record });
    } else if (message.op === 'clear-budget') {
      await withLock(clearBudget);
      post({ type: 'budget-cleared' });
    } else if (message.op === 'record-stop') {
      // Not under the profile lock: the run being stopped holds it, and the
      // stop slots are opened by nothing else while a run is active.
      await recordStop(message);
      post({ type: 'stop-recorded', runId: message.runId });
    }
  } catch (failure) {
    post({ type: 'error', message: String(failure && failure.message || failure) });
  } finally {
    busy = false;
  }
});
