// A present reserves one of two GPU frame credits until its work completes.
// Request slots are released after copying, so ordinary RPCs remain available
// while the independent credits bound queued GPU frames.
export function createFrameBackpressure({ getFence, onError = () => {}, now = () => performance.now() }) {
  if (typeof getFence !== 'function') throw new TypeError('A GPU completion fence is required');
  const state = { pending: 0, maximumPending: 0, submitted: 0, completed: 0,
    failed: 0, skippedPumps: 0, lastCompletionMs: 0, maximumCompletionMs: 0 };
  const reportError = error => {
    state.failed++;
    try { onError(error); } catch { /* Reporting cannot strand a frame credit. */ }
  };
  return {
    retain(release) {
      if (typeof release !== 'function') throw new TypeError('A frame-slot release is required');
      if (state.pending >= 2) throw new Error('Both GPU frame credits are already occupied');
      state.pending++;
      state.submitted++;
      state.maximumPending = Math.max(state.maximumPending, state.pending);
      let armed = false;
      let settled = false;
      const finish = started => {
        if (settled) return;
        settled = true;
        state.pending--;
        state.completed++;
        state.lastCompletionMs = Math.max(0, now() - started);
        state.maximumCompletionMs = Math.max(state.maximumCompletionMs, state.lastCompletionMs);
        release();
      };
      // Arm only after the entire synchronous acquire/render/present batch:
      // the last composite submission must be covered by this fence too.
      return () => {
        if (armed) return;
        armed = true;
        const started = now();
        let fence;
        try { fence = getFence(); }
        catch (error) { reportError(error); finish(started); return; }
        Promise.resolve(fence).then(
          () => finish(started),
          error => { reportError(error); finish(started); }
        );
      };
    },
    shouldPump() {
      if (state.pending < 2) return true;
      state.skippedPumps++;
      return false;
    },
    report() { return { ...state, limit: 2 }; }
  };
}
