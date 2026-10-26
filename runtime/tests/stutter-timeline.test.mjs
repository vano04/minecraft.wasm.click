import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeStutterInputs, correlateStutter, stutterTimelineMain } from '../tools/stutter-timeline.mjs';

const input = (text, label = 'run') => ({ label, name: `${label}.jsonl`, text });
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n');
const frame = (timeMs, max = 150, clock = 'capture') => ({ timeMs, clock, text: `[MC-STAGE] frametime: n=10 max=${max}ms hitches=3 screen=-` });
const gc = '[3.757s][info][gc] GC(0) Pause Young (Allocation Failure) 4M->0M(95M) 7.800ms';
const analyze = (rows, options = {}) => correlateStutter(normalizeStutterInputs([input(jsonl(rows))], options), options);

test('real captured frame/phase/worker formats parse, cumulative snapshots do not multiply frames', () => {
  // Public diagnostic rows from ipad-stack16-fps-split-01; provenance in doc.
  const events = [
    { utc: '2026-10-16T22:14:56.525Z', time: 751903.86, text: '[MC-STAGE] frametime: n=10 max=155ms hitches=10 screen=-' },
    { utc: '2026-10-16T22:09:12.633Z', time: 408012.44, text: '[MC-STAGE] framesplit: frames=19 tickFrames=19 ticks=20 tickFrame[p50=47.9 p90=62.9] plainFrame[-] | per tick ms: tick=13.68 level=0.08 entities=5.64 animate=6.36 particles=0.53 textures=12.32 rendererTick=0.47 | per frame ms: render=14.12' },
    { utc: '2026-10-16T22:09:15.419Z', time: 410798.36, text: '[frame-split] batches=257 java=9505ms (94.8%) gpuWorker=523ms (5.2%) calls=9007 callsPerBatch=35.0 roundTripsPerSecond=26' },
  ];
  const report = analyze([{ utc: '2026-10-16T22:14:57.000Z', timing: events }, { utc: '2026-10-16T22:15:02.000Z', timing: events }]);
  assert.equal(report.summary.frameReportWindows, 1); assert.equal(report.summary.duplicatesRemoved, 3);
  assert.equal(report.summary.windowMaxWorkMs.worst, 155);
  assert.equal(report.events.find(e => e.kind === 'client-phase-window').metrics.render, 14.12);
  const worker = report.events.find(e => e.kind === 'gpu-worker-window');
  assert.equal(worker.metrics.betweenBatchMs, 9505); assert.equal(worker.metrics.workerCallMs, 523);
  assert.equal(worker.metrics.includesPacingAndWait, true); assert.equal(worker.metrics.deviceGpuTime, false);
});

test('delayed GC observation is not treated as wall-clock pause time', () => {
  const report = analyze([{ utc: '2026-10-17T01:14:43.306Z', text: '[MC-STAGE] frametime: n=10 max=150ms hitches=3 screen=-' },
    { observedUTC: '2026-10-17T01:14:43.306Z', gcId: 0, line: gc }]);
  assert.deepEqual(report.summary.clocks, ['jvm-uptime:run', 'utc']);
  assert.equal(report.hitches[0].links.length, 0);
  const pause = report.events.find(e => e.kind === 'gc-pause');
  assert.equal(pause.endMs, 3757); assert.equal(pause.startMs, 3749.2);
  assert.equal(pause.observedUTC, '2026-10-17T01:14:43.306Z');
  assert(report.coverageWarnings.some(w => w.includes('No timestamped gc-pause in frame domain run/utc')));
});

test('explicit uncertain clock mapping enables possible proximity without claiming causation', () => {
  const at = Date.parse('2026-10-17T01:14:43.306Z');
  const report = analyze([{ utc: new Date(at).toISOString(), text: frame(0).text }, { observedUTC: new Date(at + 60000).toISOString(), line: gc }],
    { anchors: [{ clock: 'jvm-uptime:run', to: 'utc', offsetMs: at - 3757, uncertaintyMs: 20, evidence: 'Test calibration, not collector receipt' }] });
  assert.equal(report.hitches[0].links[0].kind, 'gc-pause');
  assert.equal(report.hitches[0].links[0].uncertaintyMs, 20);
  assert.equal(report.hitches[0].links[0].relation, 'receipt-report-proximity');
  assert(report.limitations[0].includes('not a cause'));
});

test('native UTC GC decoration takes precedence over uptime and delayed collection', () => {
  const report = analyze([{ utc: '2026-10-17T01:14:43.306Z', text: frame(0).text },
    { observedUTC: '2026-10-17T02:14:43.306Z', line: '[2026-10-17T01:14:43.300+0000]' + gc }]);
  const pause = report.events.find(e => e.kind === 'gc-pause');
  assert.equal(pause.clock, 'utc'); assert.equal(pause.endMs, Date.parse('2026-10-17T01:14:43.300Z'));
  assert.equal(report.hitches[0].links[0].kind, 'gc-pause');
});

test('raw JIT aggregates retain compile/install subset and remain unplaced without timestamps', () => {
  const text = '[zwc] compile time 27.3 ms (install 12.6) in the last 1.0 s: 379 compiles, 22 units (570 bodies), slowest 1.7 ms (install 1.5) example.Public.method()V | why: new 283 dependent 5 sweep 0 bails 0 profile 17 | thread main';
  const n = normalizeStutterInputs([input(text)]);
  assert.equal(n.events.length, 0); assert.equal(n.unplaced[0].kind, 'jit-window');
  assert.equal(n.unplaced[0].metrics.compileMs, 27.3); assert.equal(n.unplaced[0].metrics.installSubsetMs, 12.6);
  const placed = analyze([frame(1000), { timeMs: 1000, clock: 'capture', text }]);
  assert.equal(placed.hitches[0].links[0].kind, 'jit-window');
  assert.equal(placed.events.find(e => e.kind === 'jit-window').spanMs, 1000);
});

test('relative collector clocks remain isolated across runs', () => {
  const n = normalizeStutterInputs([input('[2.5] '+frame(0).text, 'a'), input('[2.5] [zwc] slow install 12.0 ms: compile 10', 'b')]);
  const report = correlateStutter(n);
  assert.equal(report.hitches[0].links.length, 0);
  assert.deepEqual(report.summary.clocks, ['log-relative:a', 'log-relative:b']);
});

test('different sessions are not correlated even with identical UTC timestamps', () => {
  const utc = '2026-10-17T00:00:00Z';
  const n = normalizeStutterInputs([input(jsonl([{ utc, text: frame(0).text }]), 'a'), input(jsonl([{ utc, text: '[zwc] slow install 12.0 ms: compile 10' }]), 'b')]);
  assert.equal(correlateStutter(n).hitches[0].links.length, 0);
});

test('latest stale frameTime field is not repeatedly stamped at snapshot time', () => {
  const text = frame(0).text;
  const report = analyze([{ utc: '2026-10-17T00:00:00Z', timing: [], frameTime: text }, { utc: '2026-10-17T00:00:05Z', timing: [], frameTime: text }]);
  assert.equal(report.summary.frameReportWindows, 0); assert.equal(report.summary.unplacedDistinct, 1);
  assert.equal(report.summary.unplacedOccurrences, 2);
});

test('same-clock nearby aggregates link, distant activity and nonmatching clocks do not', () => {
  const report = analyze([frame(10000), { timeMs: 9900, clock: 'capture', text: '[zwc] slow install 12.0 ms: compile 10' },
    { timeMs: 50000, clock: 'capture', text: '[zwc] slow install 13.0 ms: compile 11' },
    { timeMs: 9900, clock: 'other-worker', text: '[zwc] slow install 14.0 ms: compile 12' }]);
  assert.equal(report.hitches[0].links.length, 1); assert.equal(report.hitches[0].links[0].metrics.installMs, 12);
});

test('phase bounds exclude menu maxima and keep statistics explicitly about report windows', () => {
  const report = analyze([{ utc: '2026-10-17T00:00:00Z', text: frame(0, 21233).text }, { utc: '2026-10-17T00:01:00Z', text: frame(0, 155).text }],
    { fromUTC: '2026-10-17T00:00:30Z', toUTC: '2026-10-17T00:01:30Z' });
  assert.equal(report.summary.windowMaxWorkMs.worst, 155); assert.equal(report.summary.frameReportWindows, 1);
  assert.equal(report.summary.reportedFramesInHitchWindows, 10);
  assert.equal('fps' in report.summary, false);
});

test('UTC phase bounds exclude unmapped pauses from phase counts and distinguish global cadence gaps', () => {
  const rows = [{ utc: '2026-10-17T00:00:00Z', timing: [] }, { utc: '2026-10-17T00:02:00Z', timing: [{ utc: '2026-10-17T00:02:00Z', text: frame(0).text }] },
    { utc: '2026-10-17T00:02:05Z', timing: [] }, { observedUTC: '2026-10-17T00:02:00Z', line: gc }];
  const report = analyze(rows, { fromUTC: '2026-10-17T00:01:59Z', toUTC: '2026-10-17T00:02:10Z' });
  assert.equal(report.summary.eventCounts['gc-pause'], undefined); assert.equal(report.unmappedEvents.length, 1);
  assert.equal(report.coverage[0].maxSnapshotGapMs, 120000); assert.equal(report.coverage[0].phaseMaxSnapshotGapMs, 5000);
  assert.equal(report.coverageWarnings.some(w => w.includes('phase gap')), false);
});

test('geometry cadence gaps omit stale context rather than declaring a matched scene', () => {
  const rows = [{ utc: '2026-10-17T00:00:00Z', timing: [], terrain: '[MC-STAGE] terrain: clientChunks=329 visible=672 visRenderable=542' },
    { utc: '2026-10-17T00:02:00Z', timing: [{ utc: '2026-10-17T00:01:00Z', text: frame(0).text }] }];
  const report = analyze(rows);
  assert.equal(report.coverage[0].maxSnapshotGapMs, 120000); assert.deepEqual(report.hitches[0].context, {});
  assert(report.coverageWarnings.some(w => w.includes('120000 ms phase gap')));
});

test('recognized worldgen counters are observations, not measured generation CPU time', () => {
  const report = analyze([frame(10000), { timeMs: 9900, clock: 'capture', text: '[MC-STAGE] chunkpipe:tick=240 loadedChunks=952 pendingTasks=0 readyChunks=54 tracked=329 trackedReady=54' }]);
  const event = report.events.find(e => e.kind === 'worldgen-observation');
  assert.equal(event.spanMs, 0); assert.equal(event.metrics.readyChunks, 54); assert.equal(event.metrics.loadedChunks, 952);
});

test('bounded relationship output discloses truncation', () => {
  const rows = [frame(10000), ...Array.from({ length: 40 }, (_, i) => ({ timeMs: 9900 + i, clock: 'capture', text: `[zwc] slow install ${i+1}.0 ms: compile` }))];
  const report = analyze(rows);
  assert.equal(report.hitches[0].links.length, 32); assert.equal(report.hitches[0].truncated, true); assert.equal(report.summary.truncatedHitchLinks, 1);
});

test('invalid clocks, bounds, JSON and resource excess fail explicitly', () => {
  assert.throws(() => normalizeStutterInputs([input('{bad')]), /Invalid JSON/);
  assert.throws(() => normalizeStutterInputs([input('x'.repeat(1024*1024+1))]), /line exceeds/);
  assert.throws(() => normalizeStutterInputs(Array.from({ length: 17 }, () => input(''))), /at most16/);
  assert.throws(() => analyze([frame(1000)], { thresholdMs: NaN }), /thresholdMs/);
  assert.throws(() => analyze([frame(1000)], { fromUTC: 'yesterday' }), /phase bounds/);
  assert.throws(() => analyze([frame(1000)], { anchors: [{ clock: 'uptime', to: 'utc', offsetMs: 0, uncertaintyMs: 1, evidence: '' }] }), /evidence/);
  assert.throws(() => analyze([frame(1000)], { anchors: [{ clock: 'uptime', to: 'utc', offsetMs: 0, uncertaintyMs: 60001, evidence: 'too uncertain' }] }), /uncertainty/);
});

test('CLI report binds file hash, preserves inputs and refuses output overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcweb-stutter-'));
  try {
    const source = join(dir, 'capture.jsonl'), target = join(dir, 'report.json'), data = jsonl([frame(10000)]);
    await writeFile(source, data);
    await stutterTimelineMain(['--input', 'run='+source, '--out', target]);
    const report = JSON.parse(await readFile(target, 'utf8'));
    assert.match(report.provenance[0].sha256, /^[a-f0-9]{64}$/); assert.equal(report.hitches.length, 1);
    assert.equal(await readFile(source, 'utf8'), data);
    await assert.rejects(stutterTimelineMain(['--input', 'run='+source, '--out', target]), /EEXIST/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
